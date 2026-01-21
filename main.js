(async () => {
  // -------------------------
  // DOM
  // -------------------------
  const ui = document.getElementById("ui");
  const btnStart = document.getElementById("btnStart");
  const errBox = document.getElementById("err");
  const stage = document.getElementById("stage");

  const showErr = (msg) => {
    console.error(msg);
    if (!errBox) return;
    errBox.style.display = "block";
    errBox.textContent = String(msg);
  };

  // -------------------------
  // Guards
  // -------------------------
  if (!stage) {
    showErr("Missing #stage element in index.html");
    return;
  }
  if (!btnStart) {
    showErr("Missing #btnStart button in index.html");
    return;
  }

  // -------------------------
  // State
  // -------------------------
  let audioCtx = null, analyser = null, stream = null, data = null;
  let started = false;
  let paused = false;

  // -------------------------
  // Audio (RMS)
  // -------------------------
  async function startMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("getUserMedia not available. Use HTTPS or localhost.");
    }

    // Create context on user gesture only
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    await audioCtx.resume();

    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false, // reduce "always on" floor on some devices
      },
    });

    const src = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.55;
    src.connect(analyser);
    data = new Uint8Array(analyser.fftSize);
  }

  function rms() {
    if (!analyser || !data) return 0;
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / data.length); // ~0..1
  }

  // -------------------------
  // Utils
  // -------------------------
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const lerp = (a, b, t) => a + (b - a) * t;

  // -------------------------
  // Pixi + Shader
  // -------------------------
  const COLS = 640;             // propagation resolution
  const RATE = 220;             // propagation speed (columns/sec)
  const AMP_SCALE = 1.85;       // shader amplitude scale
  const PUSH = 0.93;            // propagation push
  const DECAY = 0.986;          // propagation decay

  // Offscreen 1px canvas -> texture (R channel only)
  const ampCanvas = document.createElement("canvas");
  ampCanvas.width = COLS;
  ampCanvas.height = 1;
  const ampCtx = ampCanvas.getContext("2d", { willReadFrequently: true });
  const img = ampCtx.createImageData(COLS, 1);
  const px = img.data;
  for (let i = 0; i < COLS; i++) {
    px[i * 4 + 0] = 0;
    px[i * 4 + 1] = 0;
    px[i * 4 + 2] = 0;
    px[i * 4 + 3] = 255;
  }
  ampCtx.putImageData(img, 0, 0);

  const ampF = new Float32Array(COLS);

  function flushAmpTexture(ampTex) {
    ampCtx.putImageData(img, 0, 0);
    // Pixi v8: texture source update
    try {
      ampTex.source.update();
    } catch (e) {
      // fallback for older pixi builds
      try { ampTex.baseTexture.update(); } catch (_) {}
    }
  }

  function propagateAmp(inputAmp01, steps) {
    for (let s = 0; s < steps; s++) {
      for (let i = COLS - 1; i >= 1; i--) {
        ampF[i] = ampF[i] * DECAY + ampF[i - 1] * PUSH;
        if (ampF[i] > 1) ampF[i] = 1;
        if (ampF[i] < 0) ampF[i] = 0;
      }
      ampF[0] = inputAmp01;
    }
  }

  // Map raw RMS to 0..1 with a hard silent gate
  function mapVolToAmp01(vRaw) {
    const SILENT = 0.0022;
    const KNEE = 0.0042;
    if (vRaw <= SILENT) return 0.0;

    let x = (vRaw - KNEE) / (1 - KNEE);
    x = clamp(x, 0, 1);

    const gain = 22.0;
    const gamma = 0.14;

    const y = Math.pow(clamp(x * gain, 0, 1), gamma);
    return clamp(y, 0, 1);
  }

  // FRAG GLSL1 (WebGL1)
  const VERT_GLSL1 = `
    precision highp float;
    attribute vec2 aVertexPosition;
    attribute vec2 aTextureCoord;
    uniform mat3 projectionMatrix;
    varying vec2 vTextureCoord;
    void main(){
      vTextureCoord = aTextureCoord;
      vec3 pos = projectionMatrix * vec3(aVertexPosition, 1.0);
      gl_Position = vec4(pos.xy, 0.0, 1.0);
    }
  `;

  const FRAG_GLSL1 = `
    precision highp float;
    varying vec2 vTextureCoord;

    uniform sampler2D uAmpTex;
    uniform float uCols;
    uniform float uMidY;

    float hash11(float p){
      p = fract(p * 0.1031);
      p *= p + 33.33;
      p *= p + p;
      return fract(p);
    }

    vec3 hsv2rgb(vec3 c){
      vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
      vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
      return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
    }

    void main(){
      vec2 uv = vTextureCoord;

      // y: top red(0) -> bottom violet(0.75)
      float hue = mix(0.0, 0.75, uv.y);

      float cols = max(uCols, 1.0);
      float fx = uv.x * cols;
      float col = floor(fx);

      float s = (col + 0.5) / cols;
      float amp = texture2D(uAmpTex, vec2(s, 0.5)).r;

      float mid = uMidY;
      float dy = abs(uv.y - mid);

      float A = amp * ${AMP_SCALE.toFixed(2)};
      // band should be stable: 1 near wave ridge, 0 away.
      float band = 0.0;
      if (A > 0.0012) band = 1.0 - smoothstep(A, A + 0.014, dy);

      // thread profile
      float seed = hash11(col + 19.1);
      float phase = seed * 6.28318;
      float sway = 0.0012 * sin(phase + uv.y * 7.0 + 0.8);
      float x0 = (col + 0.5) / cols + sway;

      float dx = abs(uv.x - x0);
      float core = smoothstep(0.0018, 0.0, dx);
      float halo = smoothstep(0.008, 0.0, dx);

      // Calm color
      vec3 rgbCalm = vec3(0.92, 0.98, 1.00);

      // Wave rainbow
      vec3 rgbWave = hsv2rgb(vec3(hue, 0.95, 1.15));
      rgbWave = clamp(rgbWave, 0.0, 1.4);

      float gate = smoothstep(0.006, 0.020, amp);

      // ✅ 핵심: gate만 쓰지 말고 band(파동 위치) + fiberMask(실 부분)로 제한
      float fiberMask = clamp(0.95*core + 0.65*halo, 0.0, 1.0);
      float mixWave = gate * band * fiberMask;

      vec3 rgb = mix(rgbCalm, rgbWave, mixWave);

      // Alpha: only show threads, never full-screen wash
      float alpha = clamp(0.88*core + 0.55*halo, 0.0, 1.0);
      gl_FragColor = vec4(rgb, alpha);
    }
  `;

  // FRAG GLSL3 (WebGL2)
  const VERT_GLSL3 = `#version 300 es
    precision highp float;
    in vec2 aVertexPosition;
    in vec2 aTextureCoord;
    uniform mat3 projectionMatrix;
    out vec2 vTextureCoord;
    void main(){
      vTextureCoord = aTextureCoord;
      vec3 pos = projectionMatrix * vec3(aVertexPosition, 1.0);
      gl_Position = vec4(pos.xy, 0.0, 1.0);
    }
  `;

  const FRAG_GLSL3 = `#version 300 es
    precision highp float;

    in vec2 vTextureCoord;
    uniform sampler2D uAmpTex;
    uniform float uCols;
    uniform float uMidY;

    out vec4 FragColor;

    float hash11(float p){
      p = fract(p * 0.1031);
      p *= p + 33.33;
      p *= p + p;
      return fract(p);
    }

    vec3 hsv2rgb(vec3 c){
      vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
      vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
      return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
    }

    void main(){
      vec2 uv = vTextureCoord;

      // y: top red(0) -> bottom violet(0.75)
      float hue = mix(0.0, 0.75, uv.y);

      float cols = max(uCols, 1.0);
      float fx = uv.x * cols;
      float col = floor(fx);

      float s = (col + 0.5) / cols;
      float amp = texture(uAmpTex, vec2(s, 0.5)).r;

      float mid = uMidY;
      float dy = abs(uv.y - mid);

      float A = amp * ${AMP_SCALE.toFixed(2)};

      // ✅ band: 안정적인 edge 순서 (edge0 < edge1)
      // band = 1 near ridge, 0 away
      float band = 0.0;
      if (A > 0.0012) band = 1.0 - smoothstep(A, A + 0.014, dy);

      // thread profile
      float seed = hash11(col + 19.1);
      float phase = seed * 6.28318;
      float sway = 0.0012 * sin(phase + uv.y * 7.0 + 0.8);
      float x0 = (col + 0.5) / cols + sway;

      float dx = abs(uv.x - x0);
      float core = smoothstep(0.0018, 0.0, dx);
      float halo = smoothstep(0.008, 0.0, dx);

      vec3 rgbCalm = vec3(0.92, 0.98, 1.00);
      vec3 rgbWave = hsv2rgb(vec3(hue, 0.95, 1.15));
      rgbWave = clamp(rgbWave, 0.0, 1.4);

      float gate = smoothstep(0.006, 0.020, amp);

      // ✅ 핵심: 평소엔 calm 유지, 파동 band 부분만 무지개
      float fiberMask = clamp(0.95*core + 0.65*halo, 0.0, 1.0);
      float mixWave = gate * band * fiberMask;

      vec3 rgb = mix(rgbCalm, rgbWave, mixWave);

      float alpha = clamp(0.88*core + 0.55*halo, 0.0, 1.0);
      FragColor = vec4(rgb, alpha);
    }
  `;

  let app = null;
  let isWebGL2 = false;
  let filter = null;
  let ampTex = null;

  async function initPixi() {
    if (app) return;

    if (!window.PIXI) {
      throw new Error("PixiJS not loaded. Check the <script> tag in index.html");
    }

    app = new PIXI.Application();
    await app.init({
      resizeTo: window,
      backgroundAlpha: 0, // transparent canvas
      antialias: true,
      autoDensity: true,
      resolution: Math.min(1.5, window.devicePixelRatio || 1),
      powerPreference: "high-performance",
    });

    stage.appendChild(app.canvas);

    isWebGL2 = !!(app.renderer && app.renderer.gl && (app.renderer.gl instanceof WebGL2RenderingContext));

    // Amp texture
    ampTex = PIXI.Texture.from(ampCanvas);

    const vertex = isWebGL2 ? VERT_GLSL3 : VERT_GLSL1;
    const fragment = isWebGL2 ? FRAG_GLSL3 : FRAG_GLSL1;

    const glProgram = isWebGL2
      ? new PIXI.GlProgram({ vertex, fragment })
      : new PIXI.Program({ vertex, fragment });

    // ✅ IMPORTANT:
    // Provide uniforms as direct resources (NOT a uniform group),
    // so both WebGL1/2 get correct uCols/uMidY bindings.
    filter = new PIXI.Filter({
      glProgram,
      resources: {
        uAmpTex: ampTex,
        uCols: { value: COLS, type: "f32" },
        uMidY: { value: 0.54, type: "f32" },
      },
    });

    const screen = new PIXI.Sprite(PIXI.Texture.WHITE);
    screen.anchor.set(0);
    screen.position.set(0);
    screen.width = app.renderer.width;
    screen.height = app.renderer.height;
    screen.filters = [filter];
    app.stage.addChild(screen);

    window.addEventListener("resize", () => {
      if (!app) return;
      screen.width = app.renderer.width;
      screen.height = app.renderer.height;
    }, { passive: true });

    // Pause/Resume on tap
    window.addEventListener("pointerdown", (e) => {
      if (!started) return;
      // ignore clicking the Start button area while UI visible
      if (ui && ui.contains(e.target)) return;
      paused = !paused;
    }, { passive: true });

    // ticker: update propagation only when started & not paused
    let last = performance.now();
    let smVol = 0;

    app.ticker.add(() => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      if (!started || paused) return;

      const v = rms();
      smVol = lerp(smVol, v, 1 - Math.pow(0.001, dt));

      const steps = Math.max(1, Math.floor(dt * RATE));
      let amp01 = mapVolToAmp01(smVol);

      // hard cut to prevent tiny noise from opening gate
      if (amp01 < 0.02) amp01 = 0.0;

      propagateAmp(amp01, steps);

      // ampF -> texture (R channel 0..255)
      for (let i = 0; i < COLS; i++) {
        const vv = Math.round(clamp(ampF[i], 0, 1) * 255);
        px[i * 4 + 0] = vv;
      }
      flushAmpTexture(ampTex);
    });
  }

  // -------------------------
  // Start button
  // -------------------------
  async function doStart() {
    if (started) return;

    // Clear any previous error
    if (errBox) errBox.textContent = "";

    try {
      await startMic();
      await initPixi();
      started = true;

      // hide UI overlay
      if (ui) ui.style.display = "none";
    } catch (e) {
      showErr(e?.message || e);
      // keep UI visible for retry
    }
  }

  btnStart.addEventListener("click", (e) => {
    e.preventDefault();
    doStart();
  }, { passive: false });

})();
