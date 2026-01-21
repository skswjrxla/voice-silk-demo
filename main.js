(() => {
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

  window.addEventListener("error", (e) => showErr("JS Error:\n" + (e.error?.stack || e.message || e)));
  window.addEventListener("unhandledrejection", (e) => showErr("Promise Error:\n" + (e.reason?.stack || e.reason)));

  if (!btnStart || !stage) {
    showErr("필수 DOM(#btnStart, #stage) 누락");
    return;
  }

  // -------------------------
  // State
  // -------------------------
  let app = null;
  let filter = null;
  let started = false;
  let paused = false;

  // audio
  let audioCtx = null;
  let analyser = null;
  let stream = null;
  let td = null;
  let smRms = 0;
  let noise = 0.02;
  let armed = true;
  let cooldown = 0;

  // wave (one-shot)
  let waveActive = 0;
  let waveX = 0;            // 0..1 (UV space)
  let waveStrength = 0;     // 0..1
  const WAVE_SPEED = 0.60;  // uv/sec
  const WAVE_WIDTH = 0.10;  // uv
  const WAVE_MIDY = 0.54;   // y center for coloring band
  const WAVE_YW = 0.18;     // y band width

  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const lerp = (a, b, t) => a + (b - a) * t;

  // -------------------------
  // Shaders (WebGL2/1 safe)
  // -------------------------
  const VERT_GLSL1 = `
    attribute vec2 aPosition;
    attribute vec2 aTextureCoord;
    uniform mat3 uProjectionMatrix;
    varying vec2 vTextureCoord;
    void main() {
      vTextureCoord = aTextureCoord;
      vec3 pos = uProjectionMatrix * vec3(aPosition, 1.0);
      gl_Position = vec4(pos.xy, 0.0, 1.0);
    }
  `;

  const FRAG_GLSL1 = `
    precision mediump float;
    varying vec2 vTextureCoord;
    uniform sampler2D uSampler;

    uniform vec2  uResolution;
    uniform float uTime;
    uniform float uFiberCount;

    uniform float uWaveActive;
    uniform float uWaveX;
    uniform float uWaveWidth;
    uniform float uWaveStrength;
    uniform float uMidY;
    uniform float uWaveYWidth;

    // HSV->RGB
    vec3 hsv2rgb(vec3 c){
      vec4 K = vec4(1., 2./3., 1./3., 3.);
      vec3 p = abs(fract(c.xxx + K.xyz)*6. - K.www);
      return c.z * mix(K.xxx, clamp(p - K.xxx, 0., 1.), c.y);
    }

    float gauss(float x, float s){
      return exp(-(x*x)/(2.0*s*s));
    }

    // per-fiber x + gentle hang sway (no violent wobble)
    float fiberCenter(float i, float y, float t){
      // deterministic jitter per fiber (no textures)
      float seed = fract(sin(i*127.1)*43758.5453);
      float base = (i + 0.5) / uFiberCount;
      float j = (seed - 0.5) * (0.35 / uFiberCount); // tiny x jitter

      float hang = pow(clamp(y, 0.0, 1.0), 1.8);     // pinned top, freer bottom
      float w1 = sin(t*0.35 + i*9.7);
      float w2 = sin(t*0.21 + i*4.3 + 1.7);
      float sway = (w1*0.60 + w2*0.40) * 0.0030 * hang; // VERY small amplitude

      return base + j + sway;
    }

    // returns fiber mask (core+halo)
    float fiberMaskAt(float i, vec2 uv, float t){
      float cx = fiberCenter(i, uv.y, t);
      float d = abs(uv.x - cx);

      // thickness tuned to avoid striping / overdraw
      float core = gauss(d, 0.0023);
      float halo = gauss(d, 0.0065) * 0.55;

      return clamp(core + halo, 0.0, 1.0);
    }

    void main(){
      vec2 uv = vTextureCoord;

      // nearest fiber index (and neighbors to avoid gaps when swaying)
      float fx = uv.x * uFiberCount;
      float i0 = floor(fx);
      float m0 = fiberMaskAt(i0, uv, uTime);
      float m1 = fiberMaskAt(i0 - 1.0, uv, uTime);
      float m2 = fiberMaskAt(i0 + 1.0, uv, uTime);
      float fiberMask = max(m0, max(m1, m2));

      // calm color (ice)
      vec3 rgbCalm = vec3(0.92, 0.98, 1.00);

      // rainbow by Y: top red -> bottom violet (NOT random)
      float hue = mix(0.0, 0.75, clamp(uv.y, 0.0, 1.0));
      vec3 rgbWave = hsv2rgb(vec3(hue, 1.0, 1.0));
      rgbWave = pow(rgbWave, vec3(0.62));   // soften
      rgbWave *= 1.20;

      // wave band (one-shot): only when active
      float band = 0.0;
      if (uWaveActive > 0.5) {
        float dx = abs(uv.x - uWaveX);
        band = 1.0 - smoothstep(uWaveWidth, uWaveWidth*1.55, dx);
        // slightly "angular but soft hump"
        band = pow(clamp(band, 0.0, 1.0), 0.80);
      }

      // restrict coloring to a Y band near midY (only partial segments get colored)
      float dy = abs(uv.y - uMidY);
      float nearWaveY = 1.0 - smoothstep(uWaveYWidth, uWaveYWidth*1.35, dy);

      // IMPORTANT: mixWave depends on band * nearWaveY * fiberMask * waveStrength
      float mixWave = uWaveActive * band * nearWaveY * fiberMask * clamp(uWaveStrength, 0.0, 1.0);

      vec3 rgb = mix(rgbCalm, rgbWave, mixWave);

      // alpha: calm fibers always visible, wave makes them slightly stronger
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
    uniform sampler2D uSampler;
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
      vec4 K = vec4(1., 2./3., 1./3., 3.);
      vec3 p = abs(fract(c.xxx + K.xyz)*6. - K.www);
      return c.z * mix(K.xxx, clamp(p - K.xxx, 0., 1.), c.y);
    }

    float gauss(float x, float s){
      return exp(-(x*x)/(2.0*s*s));
    }

    float fiberCenter(float i, float y, float t){
      float seed = fract(sin(i*127.1)*43758.5453);
      float base = (i + 0.5) / uFiberCount;
      float j = (seed - 0.5) * (0.35 / uFiberCount);

      float hang = pow(clamp(y, 0.0, 1.0), 1.8);
      float w1 = sin(t*0.35 + i*9.7);
      float w2 = sin(t*0.21 + i*4.3 + 1.7);
      float sway = (w1*0.60 + w2*0.40) * 0.0030 * hang;

      return base + j + sway;
    }

    float fiberMaskAt(float i, vec2 uv, float t){
      float cx = fiberCenter(i, uv.y, t);
      float d = abs(uv.x - cx);
      float core = gauss(d, 0.0023);
      float halo = gauss(d, 0.0065) * 0.55;
      return clamp(core + halo, 0.0, 1.0);
    }

    void main(){
      vec2 uv = vTextureCoord;

      float fx = uv.x * uFiberCount;
      float i0 = floor(fx);
      float m0 = fiberMaskAt(i0, uv, uTime);
      float m1 = fiberMaskAt(i0 - 1.0, uv, uTime);
      float m2 = fiberMaskAt(i0 + 1.0, uv, uTime);
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

      // 핵심: gate 같은 값에 의존하지 않고, band * nearWaveY * fiberMask 에만 의존
      float mixWave = uWaveActive * band * nearWaveY * fiberMask * clamp(uWaveStrength, 0.0, 1.0);

      vec3 rgb = mix(rgbCalm, rgbWave, mixWave);

      float aCalm = fiberMask * 0.12;
      float aWave = fiberMask * (0.22 * band * nearWaveY * clamp(uWaveStrength, 0.0, 1.0));
      float a = clamp(aCalm + aWave, 0.0, 0.55);

      FragColor = vec4(rgb, a);
    }
  `;

  // -------------------------
  // Pixi init (ONLY after Start)
  // -------------------------
  async function initPixi() {
    if (!window.PIXI) throw new Error("PIXI 로드 실패(pixi.min.js 확인)");

    app = new PIXI.Application();
    await app.init({
      resizeTo: window,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(1.5, window.devicePixelRatio || 1),
      powerPreference: "high-performance",
    });

    const canvas = app.renderer?.canvas || app.renderer?.view;
    if (!canvas) throw new Error("Renderer canvas/view not found");
    stage.appendChild(canvas);

    const gl = app.renderer?.gl;
    const isWebGL2 = (typeof WebGL2RenderingContext !== "undefined") && (gl instanceof WebGL2RenderingContext);

    const screen = new PIXI.Sprite(PIXI.Texture.WHITE);
    screen.width = app.renderer.width;
    screen.height = app.renderer.height;
    app.stage.addChild(screen);

    const vertex = isWebGL2 ? VERT_GLSL3 : VERT_GLSL1;
    const fragment = isWebGL2 ? FRAG_GLSL3 : FRAG_GLSL1;

    const glProgram = (PIXI.GlProgram?.from)
      ? PIXI.GlProgram.from({ vertex, fragment })
      : new PIXI.GlProgram({ vertex, fragment });

    filter = new PIXI.Filter({
      glProgram,
      resources: {
        U: {
          uResolution:   { value: [app.renderer.width, app.renderer.height], type: "vec2<f32>" },
          uTime:         { value: 0, type: "f32" },
          uFiberCount:   { value: 100, type: "f32" },

          uWaveActive:   { value: 0, type: "f32" },
          uWaveX:        { value: 0, type: "f32" },
          uWaveWidth:    { value: WAVE_WIDTH, type: "f32" },
          uWaveStrength: { value: 0, type: "f32" },
          uMidY:         { value: WAVE_MIDY, type: "f32" },
          uWaveYWidth:   { value: WAVE_YW, type: "f32" },
        }
      }
    });

    screen.filters = [filter];

    // resize 대응
    window.addEventListener("resize", () => {
      if (!app || !filter) return;
      screen.width = app.renderer.width;
      screen.height = app.renderer.height;
      const U = filter.resources.U.uniforms;
      U.uResolution = [app.renderer.width, app.renderer.height];
      // fiber count: 70~140 range based on width
      const n = Math.round(clamp(app.renderer.width / 10.0, 70, 140));
      U.uFiberCount = n;
    }, { passive: true });

    // initial uniforms
    const U = filter.resources.U.uniforms;
    U.uResolution = [app.renderer.width, app.renderer.height];
    U.uFiberCount = Math.round(clamp(app.renderer.width / 10.0, 70, 140));
    U.uWaveWidth = WAVE_WIDTH;
    U.uMidY = WAVE_MIDY;
    U.uWaveYWidth = WAVE_YW;

    // ticker
    let last = performance.now();
    app.ticker.add(() => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      if (!started || paused) return;

      // update wave
      if (waveActive) {
        waveX += WAVE_SPEED * dt;
        if (waveX > 1.2) waveActive = 0;
      }

      // cooldown
      cooldown = Math.max(0, cooldown - dt);

      // uniforms
      const UU = filter.resources.U.uniforms;
      UU.uTime = now * 0.001;
      UU.uWaveActive = waveActive ? 1 : 0;
      UU.uWaveX = waveX;
      UU.uWaveStrength = waveStrength;
    });
  }

  // -------------------------
  // Audio (trigger one-shot wave)
  // -------------------------
  async function initAudio() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("getUserMedia 미지원 브라우저");
    }
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    await audioCtx.resume();

    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false, // 잡음에 덜 민감하게
      }
    });

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
    return clamp(Math.sqrt(s / td.length), 0, 1);
  }

  function triggerWave(strength01) {
    waveActive = 1;
    waveX = 0.0;
    waveStrength = clamp(strength01, 0, 1);
  }

  // update audio every animation frame (lightweight)
  function audioLoop() {
    if (!started) return;
    if (!paused) {
      const r = readRms();
      // smooth rms
      smRms = lerp(smRms, r, 0.12);

      // noise floor tracking (fast down, slow up)
      if (smRms < noise) noise = lerp(noise, smRms, 0.20);
      else noise = lerp(noise, smRms, 0.02);

      const signal = Math.max(0, smRms - noise);

      // thresholds
      const TH_ON = 0.060; // 말소리/큰 소리 정도에서만
      const TH_OFF = 0.030;

      if (armed && cooldown <= 0 && signal > TH_ON) {
        const strength = clamp((signal - TH_ON) / 0.12, 0, 1);
        triggerWave(strength);
        armed = false;
        cooldown = 0.35; // 연속 발사 방지
      }
      if (!armed && signal < TH_OFF) {
        armed = true;
      }
    }
    requestAnimationFrame(audioLoop);
  }

  // -------------------------
  // Controls
  // -------------------------
  async function doStart() {
    if (started) return;

    try {
      // IMPORTANT: Start 전에는 절대 렌더링 안 함 -> 여기서 Pixi + Audio init
      await initPixi();
      await initAudio();

      started = true;
      paused = false;

      if (ui) ui.style.display = "none";
      if (errBox) errBox.style.display = "none";

      requestAnimationFrame(audioLoop);
    } catch (e) {
      showErr("시작 실패:\n" + (e?.stack || e));
      // 실패 시 리소스 정리 (다음 Start 재시도 가능)
      try { stream?.getTracks?.().forEach(t => t.stop()); } catch {}
      try { audioCtx?.close?.(); } catch {}
      stream = null; audioCtx = null; analyser = null; td = null;
      started = false;
    }
  }

  btnStart.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    doStart();
  });

  // tap to pause/resume
  window.addEventListener("pointerdown", () => {
    if (!started) return;
    if (ui && ui.style.display !== "none") return;
    paused = !paused;
  }, { passive: true });

})();
