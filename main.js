(() => {
  "use strict";

  // -------------------------
  // UI Elements
  // -------------------------
  const canvas = document.getElementById("gl");
  const startBtn = document.getElementById("startBtn");
  const statusEl = document.getElementById("status");

  // -------------------------
  // State
  // -------------------------
  let gl = null;
  let isWebGL2 = false;

  let program = null;
  let attribPos = -1;

  let uTime = null;
  let uResolution = null;
  let uFiberCount = null;
  let uWaveActive = null;
  let uWaveX = null;
  let uWaveWidth = null;
  let uWaveY = null;
  let uWaveYBand = null;

  let rafId = 0;
  let lastT = 0;
  let timeSec = 0;

  let started = false;
  let paused = false;

  // Wave (one-shot)
  let waveActive = 0;
  let waveXVal = 0;
  const waveSpeed = 0.95;   // normalized x per second (0..1)
  const waveWidth = 0.12;   // normalized width
  const waveY = 0.52;       // fixed center band
  const waveYBand = 0.16;   // only part of fibers colored

  // Audio
  let audioCtx = null;
  let analyser = null;
  let micStream = null;
  let dataTime = null;

  // Threshold / hysteresis / cooldown
  let noiseEMA = 0.0;
  let armed = true;
  let cooldownUntil = 0;
  const COOLDOWN_MS = 700;

  // DPR limiting
  const DPR_MAX = 1.45;

  // -------------------------
  // Helpers
  // -------------------------
  function setStatus(txt) {
    statusEl.textContent = txt;
  }

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  function nowMs() {
    return performance.now();
  }

  function getDPR() {
    return Math.min(DPR_MAX, window.devicePixelRatio || 1);
  }

  function resize() {
    const dpr = getDPR();
    const w = Math.floor(window.innerWidth * dpr);
    const h = Math.floor(window.innerHeight * dpr);

    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      if (gl) gl.viewport(0, 0, w, h);
    }
  }

  function pickFiberCount() {
    // 화면 폭 기반 동적 조절: 70~140 권장
    const w = window.innerWidth;
    const count = Math.round(clamp(w / 8.0, 70, 140));
    return count;
  }

  // -------------------------
  // WebGL (Shaders)
  // -------------------------
  function compileShader(glCtx, type, src) {
    const sh = glCtx.createShader(type);
    glCtx.shaderSource(sh, src);
    glCtx.compileShader(sh);
    const ok = glCtx.getShaderParameter(sh, glCtx.COMPILE_STATUS);
    if (!ok) {
      const info = glCtx.getShaderInfoLog(sh) || "unknown shader error";
      glCtx.deleteShader(sh);
      throw new Error(info);
    }
    return sh;
  }

  function linkProgram(glCtx, vs, fs) {
    const p = glCtx.createProgram();
    glCtx.attachShader(p, vs);
    glCtx.attachShader(p, fs);
    glCtx.linkProgram(p);
    const ok = glCtx.getProgramParameter(p, glCtx.LINK_STATUS);
    if (!ok) {
      const info = glCtx.getProgramInfoLog(p) || "unknown program link error";
      glCtx.deleteProgram(p);
      throw new Error(info);
    }
    return p;
  }

  function initGL() {
    // Prefer WebGL2
    gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    });

    isWebGL2 = !!gl;

    if (!gl) {
      gl = canvas.getContext("webgl", {
        alpha: true,
        antialias: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
        powerPreference: "high-performance",
      });
      isWebGL2 = false;
    }

    if (!gl) throw new Error("WebGL not supported");

    // Fullscreen quad (2 triangles)
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        -1, -1,
         1, -1,
        -1,  1,
        -1,  1,
         1, -1,
         1,  1,
      ]),
      gl.STATIC_DRAW
    );

    const vsSrcWebGL2 = `#version 300 es
      precision highp float;
      in vec2 aPos;
      out vec2 vUV;
      void main(){
        vUV = aPos * 0.5 + 0.5;
        gl_Position = vec4(aPos, 0.0, 1.0);
      }
    `;

    const fsSrcWebGL2 = `#version 300 es
      precision highp float;

      in vec2 vUV;
      out vec4 outColor;

      uniform float uTime;
      uniform vec2  uResolution;
      uniform float uFiberCount;

      uniform float uWaveActive;
      uniform float uWaveX;
      uniform float uWaveWidth;
      uniform float uWaveY;
      uniform float uWaveYBand;

      // Hash
      float hash11(float p){
        p = fract(p * 0.1031);
        p *= p + 33.33;
        p *= p + p;
        return fract(p);
      }

      vec3 hsv2rgb(vec3 c){
        vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0/3.0, 1.0/3.0)) * 6.0 - 3.0);
        vec3 rgb = clamp(p - 1.0, 0.0, 1.0);
        return c.z * mix(vec3(1.0), rgb, c.y);
      }

      float softCircle(vec2 p, float r, float soft){
        float d = length(p);
        return smoothstep(r + soft, r, d);
      }

      void main(){
        vec2 uv = gl_FragCoord.xy / uResolution.xy;
        float aspect = uResolution.x / uResolution.y;

        // ---- Fiber grid ----
        float fc = max(10.0, uFiberCount);
        float gx = uv.x * fc;
        float id = floor(gx);
        float fx = fract(gx) - 0.5;

        float seed = hash11(id + 1.7);

        // Subtle sway only (no violent wave-like motion)
        float sway = sin(uTime * 0.55 + seed * 6.283 + uv.y * (2.2 + seed)) * 0.0022;
        float xLocal = fx + sway;

        // ---- Wave (one-shot) ----
        float waveBand = 0.0;
        float nearWaveY = 0.0;
        float waveDisp = 0.0;

        if (uWaveActive > 0.5) {
          float dx = abs(uv.x - uWaveX);
          float t = clamp(dx / max(1e-4, uWaveWidth), 0.0, 1.0);

          // "살짝 각진 부드러운 hump": tri + gauss mix
          float tri = max(0.0, 1.0 - t);
          float gauss = exp(-t * t * 3.2);
          waveBand = mix(gauss, tri, 0.35);
          waveBand = smoothstep(0.0, 1.0, waveBand);

          float dy = abs(uv.y - uWaveY);
          nearWaveY = smoothstep(uWaveYBand, 0.0, dy);

          // tiny lateral displacement around the wave band (subtle)
          waveDisp = (waveBand * nearWaveY) * (0.0045) * sin((uv.y * 8.0) + seed * 10.0);
        }

        xLocal += waveDisp;

        // Fiber thickness (core + halo)
        float coreW = 0.030; // in cell space
        float haloW = 0.090;

        float core = smoothstep(coreW, 0.0, abs(xLocal));
        float halo = smoothstep(haloW, coreW, abs(xLocal)) * 0.35;

        // Base fiber color (glass-silk)
        vec3 fiberBase = vec3(0.92, 0.96, 1.00) * 0.35;
        vec3 fiberHalo = vec3(0.65, 0.80, 1.00) * 0.10;

        vec3 col = vec3(0.0);
        float alpha = 0.0;

        col += fiberBase * core;
        col += fiberHalo * halo;
        alpha += (core * 0.55 + halo * 0.22);

        // ---- Beads: 2~3 glass beads per fiber ----
        // fixed small loop (safe for mobile)
        float beadA = 0.0;
        vec3 beadCol = vec3(0.0);

        for (int i = 0; i < 3; i++){
          float fi = float(i);
          float by = fract(hash11(seed * 11.0 + fi * 9.1) + fi * 0.27);
          // avoid extreme top/bottom clustering
          by = 0.08 + by * 0.84;

          // bead position in uv
          float cx = (id + 0.5) / fc + (sway + waveDisp) / fc; // keep aligned to the fiber
          vec2 p = vec2((uv.x - cx) * aspect, uv.y - by);

          float r = mix(0.010, 0.016, hash11(seed + fi * 3.3));
          float b = softCircle(p, r, 0.010);

          // subtle highlight
          vec2 hp = p - vec2(-0.006, 0.006);
          float h = softCircle(hp, r * 0.45, 0.010);

          if (b > 0.001) {
            vec3 glass = vec3(0.95, 0.98, 1.0) * 0.25;
            glass += vec3(1.0) * (h * 0.28);
            beadCol += glass * b;
            beadA += b * 0.55;
          }
        }

        col += beadCol;
        alpha = max(alpha, beadA);

        // ---- Rainbow paint only where wave overlaps fiber (partial segment only) ----
        if (uWaveActive > 0.5) {
          // "파동이 스치며 지나가는 부분"만: waveBand * nearWaveY * (fiber mask)
          float paintMask = waveBand * nearWaveY * (core + halo * 0.65);

          // top red -> bottom violet (hue 0.0..0.75)
          float hue = (1.0 - uv.y) * 0.75;
          vec3 rainbow = hsv2rgb(vec3(hue, 0.92, 1.0));

          // Additive-ish but controlled (avoid whole-screen wash)
          col = mix(col, rainbow, clamp(paintMask * 0.85, 0.0, 1.0));
          alpha = max(alpha, paintMask * 0.75);
        }

        // Keep transparent background
        outColor = vec4(col, clamp(alpha, 0.0, 1.0));
      }
    `;

    const vsSrcWebGL1 = `
      precision highp float;
      attribute vec2 aPos;
      varying vec2 vUV;
      void main(){
        vUV = aPos * 0.5 + 0.5;
        gl_Position = vec4(aPos, 0.0, 1.0);
      }
    `;

    const fsSrcWebGL1 = `
      precision highp float;

      varying vec2 vUV;

      uniform float uTime;
      uniform vec2  uResolution;
      uniform float uFiberCount;

      uniform float uWaveActive;
      uniform float uWaveX;
      uniform float uWaveWidth;
      uniform float uWaveY;
      uniform float uWaveYBand;

      float hash11(float p){
        p = fract(p * 0.1031);
        p *= p + 33.33;
        p *= p + p;
        return fract(p);
      }

      vec3 hsv2rgb(vec3 c){
        vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0/3.0, 1.0/3.0)) * 6.0 - 3.0);
        vec3 rgb = clamp(p - 1.0, 0.0, 1.0);
        return c.z * mix(vec3(1.0), rgb, c.y);
      }

      float softCircle(vec2 p, float r, float soft){
        float d = length(p);
        return smoothstep(r + soft, r, d);
      }

      void main(){
        vec2 uv = gl_FragCoord.xy / uResolution.xy;
        float aspect = uResolution.x / uResolution.y;

        float fc = max(10.0, uFiberCount);
        float gx = uv.x * fc;
        float id = floor(gx);
        float fx = fract(gx) - 0.5;

        float seed = hash11(id + 1.7);

        float sway = sin(uTime * 0.55 + seed * 6.283 + uv.y * (2.2 + seed)) * 0.0022;
        float xLocal = fx + sway;

        float waveBand = 0.0;
        float nearWaveY = 0.0;
        float waveDisp = 0.0;

        if (uWaveActive > 0.5) {
          float dx = abs(uv.x - uWaveX);
          float t = clamp(dx / max(1e-4, uWaveWidth), 0.0, 1.0);
          float tri = max(0.0, 1.0 - t);
          float gauss = exp(-t * t * 3.2);
          waveBand = mix(gauss, tri, 0.35);
          waveBand = smoothstep(0.0, 1.0, waveBand);

          float dy = abs(uv.y - uWaveY);
          nearWaveY = smoothstep(uWaveYBand, 0.0, dy);

          waveDisp = (waveBand * nearWaveY) * (0.0045) * sin((uv.y * 8.0) + seed * 10.0);
        }

        xLocal += waveDisp;

        float coreW = 0.030;
        float haloW = 0.090;

        float core = smoothstep(coreW, 0.0, abs(xLocal));
        float halo = smoothstep(haloW, coreW, abs(xLocal)) * 0.35;

        vec3 fiberBase = vec3(0.92, 0.96, 1.00) * 0.35;
        vec3 fiberHalo = vec3(0.65, 0.80, 1.00) * 0.10;

        vec3 col = vec3(0.0);
        float alpha = 0.0;

        col += fiberBase * core;
        col += fiberHalo * halo;
        alpha += (core * 0.55 + halo * 0.22);

        float beadA = 0.0;
        vec3 beadCol = vec3(0.0);

        for (int i = 0; i < 3; i++){
          float fi = float(i);
          float by = fract(hash11(seed * 11.0 + fi * 9.1) + fi * 0.27);
          by = 0.08 + by * 0.84;

          float cx = (id + 0.5) / fc + (sway + waveDisp) / fc;
          vec2 p = vec2((uv.x - cx) * aspect, uv.y - by);

          float r = mix(0.010, 0.016, hash11(seed + fi * 3.3));
          float b = softCircle(p, r, 0.010);

          vec2 hp = p - vec2(-0.006, 0.006);
          float h = softCircle(hp, r * 0.45, 0.010);

          if (b > 0.001) {
            vec3 glass = vec3(0.95, 0.98, 1.0) * 0.25;
            glass += vec3(1.0) * (h * 0.28);
            beadCol += glass * b;
            beadA += b * 0.55;
          }
        }

        col += beadCol;
        alpha = max(alpha, beadA);

        if (uWaveActive > 0.5) {
          float paintMask = waveBand * nearWaveY * (core + halo * 0.65);
          float hue = (1.0 - uv.y) * 0.75;
          vec3 rainbow = hsv2rgb(vec3(hue, 0.92, 1.0));
          col = mix(col, rainbow, clamp(paintMask * 0.85, 0.0, 1.0));
          alpha = max(alpha, paintMask * 0.75);
        }

        gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
      }
    `;

    try {
      const vs = compileShader(gl, gl.VERTEX_SHADER, isWebGL2 ? vsSrcWebGL2 : vsSrcWebGL1);
      const fs = compileShader(gl, gl.FRAGMENT_SHADER, isWebGL2 ? fsSrcWebGL2 : fsSrcWebGL1);
      program = linkProgram(gl, vs, fs);
    } catch (e) {
      console.error(e);
      setStatus("셰이더 컴파일 실패");
      throw e;
    }

    gl.useProgram(program);

    // Attributes
    attribPos = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(attribPos);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.vertexAttribPointer(attribPos, 2, gl.FLOAT, false, 0, 0);

    // Uniforms
    uTime = gl.getUniformLocation(program, "uTime");
    uResolution = gl.getUniformLocation(program, "uResolution");
    uFiberCount = gl.getUniformLocation(program, "uFiberCount");

    uWaveActive = gl.getUniformLocation(program, "uWaveActive");
    uWaveX = gl.getUniformLocation(program, "uWaveX");
    uWaveWidth = gl.getUniformLocation(program, "uWaveWidth");
    uWaveY = gl.getUniformLocation(program, "uWaveY");
    uWaveYBand = gl.getUniformLocation(program, "uWaveYBand");

    // Transparent canvas settings
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    resize();
  }

  // -------------------------
  // Audio init + level
  // -------------------------
  async function initAudio() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
      }
    });
    micStream = stream;

    audioCtx = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: "interactive"
    });

    // iOS: ensure resume is called by user gesture (Start button)
    await audioCtx.resume();

    const src = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.0;

    src.connect(analyser);

    dataTime = new Float32Array(analyser.fftSize);
  }

  function computeRMS() {
    if (!analyser || !dataTime) return 0;
    analyser.getFloatTimeDomainData(dataTime);

    let sum = 0;
    let peak = 0;

    for (let i = 0; i < dataTime.length; i++) {
      const v = dataTime[i];
      const a = Math.abs(v);
      sum += v * v;
      if (a > peak) peak = a;
    }

    const rms = Math.sqrt(sum / dataTime.length);
    // peak를 약간 섞어 “악!” 같은 순간에 더 민감
    return clamp(rms * 0.85 + peak * 0.15, 0, 1);
  }

  function currentThreshold(level) {
    // noiseEMA: 잡음 바닥 자동 추정(작은 소리에 반응 금지)
    // "명확한 경계"를 위해 최소 임계값도 둠(너무 낮게 내려가지 않게)
    const minTh = 0.045;
    const th = Math.max(minTh, noiseEMA * 4.6);
