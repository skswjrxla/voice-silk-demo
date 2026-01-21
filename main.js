(() => {
  'use strict';

  // --- DOM from user's index.html ---
  const stage = document.getElementById('stage');
  const btnStart = document.getElementById('btnStart');
  const ui = document.getElementById('ui');
  const statusEl = document.getElementById('status');
  const errEl = document.getElementById('err');

  const setStatus = (t) => { if (statusEl) statusEl.textContent = t; };
  const showErr = (e) => {
    const msg = (e && (e.stack || e.message)) ? (e.stack || e.message) : String(e);
    console.error(e);
    if (errEl) {
      errEl.textContent = msg;
    }
  };

  window.addEventListener('error', (e) => showErr(e.error || e.message || e));
  window.addEventListener('unhandledrejection', (e) => showErr(e.reason || e));

  if (!stage || !btnStart) {
    showErr('Missing #stage or #btnStart in index.html');
    return;
  }
  if (!window.PIXI) {
    showErr('PIXI not found. Check pixi.js script tag in index.html');
    return;
  }

  // --- Config (safe for mobile) ---
  const DPR_MAX = 1.45;
  const fiberCountFromWidth = (w) => Math.max(70, Math.min(140, Math.round(w / 10)));
  const WAVE_SPEED = 0.75;     // uv/sec
  const WAVE_WIDTH = 0.11;     // uv
  const WAVE_MIDY  = 0.54;     // y center for paint band
  const WAVE_YW    = 0.18;     // y band width

  // --- State ---
  let app = null;
  let sprite = null;
  let filter = null;

  let started = false;
  let paused = false;

  // one-shot wave
  let waveActive = 0;
  let waveX = 0.0;
  let waveStrength = 0.0; // 0..1

  // audio
  let audioCtx = null;
  let analyser = null;
  let stream = null;
  let td = null;
  let smRms = 0.0;
  let noise = 0.02;
  let armed = true;
  let cooldownMs = 0;

  // --- GLSL (Pixi filter pipeline: MUST match sprite geometry attributes) ---
  // Keep vertex shaders compatible with Pixi's default quad geometry (aPosition + aTextureCoord).
  const VERT_GLSL1 = `
    precision mediump float;
    attribute vec2 aPosition;
    attribute vec2 aTextureCoord;
    uniform mat3 uProjectionMatrix;
    varying vec2 vTextureCoord;
    void main(){
      vTextureCoord = aTextureCoord;
      vec3 pos = uProjectionMatrix * vec3(aPosition, 1.0);
      gl_Position = vec4(pos.xy, 0.0, 1.0);
    }
  `;

  const FRAG_GLSL1 = `
    precision mediump float;
    varying vec2 vTextureCoord;

    uniform vec2  uResolution;
    uniform float uTime;
    uniform float uFiberCount;

    uniform float uWaveActive;
    uniform float uWaveX;
    uniform float uWaveWidth;
    uniform float uWaveStrength;
    uniform float uMidY;
    uniform float uWaveYWidth;

    // HSV->RGB (top red -> bottom violet)
    vec3 hsv2rgb(vec3 c){
      vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
      vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
      return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
    }

    float gauss(float x, float s){
      return exp(-(x*x) / (2.0*s*s));
    }

    float hash11(float p){
      p = fract(p * 0.1031);
      p *= p + 33.33;
      p *= p + p;
      return fract(p);
    }

    float fiberCenter(float i, float y, float t, float fc){
      float seed = hash11(i + 1.7);
      float base = (i + 0.5) / fc;
      float j = (seed - 0.5) * (0.35 / fc);

      // pinned top, freer bottom; very small amplitude
      float hang = pow(clamp(y, 0.0, 1.0), 1.8);
      float w1 = sin(t*0.35 + i*9.7);
      float w2 = sin(t*0.21 + i*4.3 + 1.7);
      float sway = (w1*0.60 + w2*0.40) * 0.0030 * hang;

      return base + j + sway;
    }

    float fiberMaskAt(float i, vec2 uv, float t, float fc){
      float cx = fiberCenter(i, uv.y, t, fc);
      float d = abs(uv.x - cx);
      float core = gauss(d, 0.0023);
      float halo = gauss(d, 0.0065) * 0.55;
      return clamp(core + halo, 0.0, 1.0);
    }

    void main(){
      vec2 uv = vTextureCoord;
      float fc = max(10.0, uFiberCount);

      // max of nearest fibers to avoid gaps when swaying
      float fx = uv.x * fc;
      float i0 = floor(fx);
      float m0 = fiberMaskAt(i0, uv, uTime, fc);
      float m1 = fiberMaskAt(i0 - 1.0, uv, uTime, fc);
      float m2 = fiberMaskAt(i0 + 1.0, uv, uTime, fc);
      float fiberMask = max(m0, max(m1, m2));

      // calm (ice)
      vec3 rgbCalm = vec3(0.92, 0.98, 1.00);

      // rainbow by y (NOT random)
      float hue = mix(0.0, 0.75, clamp(uv.y, 0.0, 1.0));
      vec3 rgbWave = hsv2rgb(vec3(hue, 1.0, 1.0));
      rgbWave = pow(rgbWave, vec3(0.62));
      rgbWave *= 1.20;

      // band in X only when wave active
      float band = 0.0;
      if (uWaveActive > 0.5) {
        float dx = abs(uv.x - uWaveX);
        band = 1.0 - smoothstep(uWaveWidth, uWaveWidth*1.55, dx);
        band = pow(clamp(band, 0.0, 1.0), 0.80);
      }

      // restrict paint to a y band (partial segment only)
      float dy = abs(uv.y - uMidY);
      float nearWaveY = 1.0 - smoothstep(uWaveYWidth, uWaveYWidth*1.35, dy);

      // KEY: no gate; only waveActive * band * nearWaveY * fiberMask
      float mixWave = uWaveActive * band * nearWaveY * fiberMask * clamp(uWaveStrength, 0.0, 1.0);

      vec3 rgb = mix(rgbCalm, rgbWave, mixWave);

      // alpha: fibers always visible, wave adds a bit
      float aCalm = fiberMask * 0.12;
      float aWave = fiberMask * (0.22 * band * nearWaveY * clamp(uWaveStrength, 0.0, 1.0));
      float a = clamp(aCalm + aWave, 0.0, 0.55);

      gl_FragColor = vec4(rgb, a);
    }
  `;

  const VERT_GLSL3 = `#version 300 es
    precision mediump float;
    in vec2 aPosition;
    in vec2 aTextureCoord;
    uniform mat3 uProjectionMatrix;
    out vec2 vTextureCoord;
    void main(){
      vTextureCoord = aTextureCoord;
      vec3 pos = uProjectionMatrix * vec3(aPosition, 1.0);
      gl_Position = vec4(pos.xy, 0.0, 1.0);
    }
  `;

  const FRAG_GLSL3 = `#version 300 es
    precision mediump float;
    in vec2 vTextureCoord;
    out vec4 FragColor;

    uniform vec2  uResolution;
    uniform float uTime;
    uniform float uFiberCount;

    uniform float uWaveActive;
    uniform float uWaveX;
    uniform float uWaveWidth;
    uniform float uWaveStrength;
    uniform float uMidY;
    uniform float uWaveYWidth;

    vec3 hsv2rgb(vec3 c){
      vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
      vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
      return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
    }

    float gauss(float x, float s){
      return exp(-(x*x) / (2.0*s*s));
    }

    float hash11(float p){
      p = fract(p * 0.1031);
      p *= p + 33.33;
      p *= p + p;
      return fract(p);
    }

    float fiberCenter(float i, float y, float t, float fc){
      float seed = hash11(i + 1.7);
      float base = (i + 0.5) / fc;
      float j = (seed - 0.5) * (0.35 / fc);

      float hang = pow(clamp(y, 0.0, 1.0), 1.8);
      float w1 = sin(t*0.35 + i*9.7);
      float w2 = sin(t*0.21 + i*4.3 + 1.7);
      float sway = (w1*0.60 + w2*0.40) * 0.0030 * hang;

      return base + j + sway;
    }

    float fiberMaskAt(float i, vec2 uv, float t, float fc){
      float cx = fiberCenter(i, uv.y, t, fc);
      float d = abs(uv.x - cx);
      float core = gauss(d, 0.0023);
      float halo = gauss(d, 0.0065) * 0.55;
      return clamp(core + halo, 0.0, 1.0);
    }

    void main(){
      vec2 uv = vTextureCoord;
      float fc = max(10.0, uFiberCount);

      float fx = uv.x * fc;
      float i0 = floor(fx);
      float m0 = fiberMaskAt(i0, uv, uTime, fc);
      float m1 = fiberMaskAt(i0 - 1.0, uv, uTime, fc);
      float m2 = fiberMaskAt(i0 + 1.0, uv, uTime, fc);
      float fiberMask = max(m0, max(m1, m2));

      vec3 rgbCalm = vec3(0.92, 0.98, 1.00);

      float hue = mix(0.0, 0.75, clamp(uv.y, 0.0, 1.0));
      vec3 rgbWave = hsv2rgb(vec3(hue, 1.0, 1.0));
      rgbWave = pow(rgbWave, vec3(0.62));
      rgbWave *= 1.20;

      float band = 0.0;
      if (uWaveActive > 0.5) {
        float dx = abs(uv.x - uWaveX);
        band = 1.0 - smoothstep(uWaveWidth, uWaveWidth*1.55, dx);
        band = pow(clamp(band, 0.0, 1.0), 0.80);
      }

      float dy = abs(uv.y - uMidY);
      float nearWaveY = 1.0 - smoothstep(uWaveYWidth, uWaveYWidth*1.35, dy);

      float mixWave = uWaveActive * band * nearWaveY * fiberMask * clamp(uWaveStrength, 0.0, 1.0);
      vec3 rgb = mix(rgbCalm, rgbWave, mixWave);

      float aCalm = fiberMask * 0.12;
      float aWave = fiberMask * (0.22 * band * nearWaveY * clamp(uWaveStrength, 0.0, 1.0));
      float a = clamp(aCalm + aWave, 0.0, 0.55);

      FragColor = vec4(rgb, a);
    }
  `;

  // --- Pixi init: ONLY after Start (so background shows before Start) ---
  async function initPixi() {
    app = new PIXI.Application();
    await app.init({
      resizeTo: window,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(DPR_MAX, window.devicePixelRatio || 1),
      powerPreference: 'high-performance',
    });

    const canvas = app.renderer?.canvas || app.renderer?.view;
    if (!canvas) throw new Error('Renderer canvas not found');
    stage.appendChild(canvas);

    // Fullscreen sprite ensures geometry has aTextureCoord (fixes "missing aTextureCoord" error)
    sprite = new PIXI.Sprite(PIXI.Texture.WHITE);
    sprite.width = app.renderer.width;
    sprite.height = app.renderer.height;
    app.stage.addChild(sprite);

    const gl = app.renderer?.gl;
    const isWebGL2 = (typeof WebGL2RenderingContext !== 'undefined') && (gl instanceof WebGL2RenderingContext);

    const vertex = isWebGL2 ? VERT_GLSL3 : VERT_GLSL1;
    const fragment = isWebGL2 ? FRAG_GLSL3 : FRAG_GLSL1;

    // Create program in a v8-safe way
    const glProgram = (PIXI.GlProgram && PIXI.GlProgram.from)
      ? PIXI.GlProgram.from({ vertex, fragment })
      : new PIXI.GlProgram({ vertex, fragment });

    filter = new PIXI.Filter({
      glProgram,
      resources: {
        u: {
          uResolution:   { value: [app.renderer.width, app.renderer.height], type: 'vec2<f32>' },
          uTime:         { value: 0, type: 'f32' },
          uFiberCount:   { value: fiberCountFromWidth(app.renderer.width), type: 'f32' },

          uWaveActive:   { value: 0, type: 'f32' },
          uWaveX:        { value: 0, type: 'f32' },
          uWaveWidth:    { value: WAVE_WIDTH, type: 'f32' },
          uWaveStrength: { value: 0, type: 'f32' },
          uMidY:         { value: WAVE_MIDY, type: 'f32' },
          uWaveYWidth:   { value: WAVE_YW, type: 'f32' },
        }
      }
    });

    sprite.filters = [filter];

    // Resize handling
    window.addEventListener('resize', () => {
      if (!app || !sprite || !filter) return;
      sprite.width = app.renderer.width;
      sprite.height = app.renderer.height;
      const U = filter.resources.u.uniforms;
      U.uResolution = [app.renderer.width, app.renderer.height];
      U.uFiberCount = fiberCountFromWidth(app.renderer.width);
    }, { passive: true });

    // Ticker updates
    let last = performance.now();
    app.ticker.add(() => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      const U = filter.resources.u.uniforms;
      U.uTime = now * 0.001;

      if (!started || paused) return;

      if (waveActive) {
        waveX += WAVE_SPEED * dt;
        if (waveX > 1.2) waveActive = 0;
      }
      U.uWaveActive = waveActive ? 1 : 0;
      U.uWaveX = waveX;
      U.uWaveStrength = waveStrength;
    });
  }

  // --- Audio ---
  async function initAudio() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('getUserMedia not available');
    }

    // NOTE: file:// often blocks mic. Use https or localhost.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
      }
    });

    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    await audioCtx.resume();

    const src = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.55;
    src.connect(analyser);

    td = new Uint8Array(analyser.fftSize);
  }

  function readRms() {
    if (!analyser || !td) return 0;
    analyser.getByteTimeDomainData(td);
    let s = 0;
    for (let i = 0; i < td.length; i++) {
      const v = (td[i] - 128) / 128;
      s += v * v;
    }
    return Math.sqrt(s / td.length);
  }

  function triggerWave(strength01) {
    waveActive = 1;
    waveX = 0.0;
    waveStrength = clamp(strength01, 0, 1);
  }

  function audioLoop(tMs) {
    if (!started) return;

    if (!paused) {
      const r = readRms();
      smRms = smRms + (r - smRms) * 0.12;

      // noise floor tracking
      if (smRms < noise) noise = noise + (smRms - noise) * 0.20;
      else noise = noise + (smRms - noise) * 0.02;

      const signal = Math.max(0, smRms - noise);

      // Clear threshold (anti-noise)
      const TH_ON = 0.060;
      const TH_OFF = 0.030;

      // cooldown to prevent spam
      if (cooldownMs > 0) cooldownMs -= 16;

      if (armed && cooldownMs <= 0 && signal > TH_ON && !waveActive) {
        const strength = clamp((signal - TH_ON) / 0.12, 0, 1);
        triggerWave(strength);
        armed = false;
        cooldownMs = 600;
      }
      if (!armed && signal < TH_OFF) armed = true;
    }

    requestAnimationFrame(audioLoop);
  }

  // --- Start / Pause ---
  async function start() {
    if (started) return;

    try {
      setStatus('권한 요청중...');
      await initPixi();
      await initAudio();

      started = true;
      paused = false;

      // Hide UI panel after start
      if (ui) ui.style.display = 'none';
      setStatus('실행중');

      requestAnimationFrame(audioLoop);
    } catch (e) {
      setStatus('시작 실패');
      showErr(e);
      // cleanup
      try { stream?.getTracks?.().forEach(t => t.stop()); } catch {}
      try { audioCtx?.close?.(); } catch {}
      stream = null; audioCtx = null; analyser = null; td = null;
      started = false;
    }
  }

  btnStart.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    start();
  });

  // tap to toggle pause/resume (after start)
  window.addEventListener('pointerdown', (e) => {
    if (!started) return;
    if (e.target === btnStart) return;
    paused = !paused;
    if (audioCtx && audioCtx.state !== 'running' && !paused) {
      audioCtx.resume().catch(() => {});
    }
  }, { passive: true });

})();