(async () => {
  const ui = document.getElementById("ui");
  const btnStart = document.getElementById("btnStart");
  const statusEl = document.getElementById("status");
  const pill = document.getElementById("pill");
  const errBox = document.getElementById("err");
  const stage = document.getElementById("stage");

  const status = (t) => { if (statusEl) statusEl.textContent = t; };
  const showErr = (msg) => {
    console.error(msg);
    if (!errBox) return;
    errBox.style.display = "block";
    errBox.textContent = String(msg);
  };

  window.addEventListener("error", (e) => showErr("JS Error:\n" + (e.error?.stack || e.message || e)));
  window.addEventListener("unhandledrejection", (e) => showErr("Promise Error:\n" + (e.reason?.stack || e.reason)));

  if (!window.PIXI) {
    showErr("PIXI 로드 실패: pixi.min.js CDN이 로딩되지 않았습니다.");
    return;
  }

  // -------------------------
  // Pixi v8 init
  // -------------------------
  let app;
  try {
    app = new PIXI.Application();
    await app.init({
      resizeTo: window,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(1.5, window.devicePixelRatio || 1),
      powerPreference: "high-performance",
    });

    const canvas = app.renderer?.canvas || app.renderer?.view || null;
    if (!canvas) throw new Error("Renderer canvas/view not found");
    stage.appendChild(canvas);
  } catch (e) {
    showErr("PIXI 초기화 실패:\n" + (e.stack || e));
    return;
  }

  // WebGL2 체크 (GLSL3 / GLSL1 자동 선택)
  const gl = app.renderer?.gl;
  const isWebGL2 = (typeof WebGL2RenderingContext !== "undefined") && (gl instanceof WebGL2RenderingContext);

  // full screen target sprite
  const screen = new PIXI.Sprite(PIXI.Texture.WHITE);
  screen.width = app.renderer.width;
  screen.height = app.renderer.height;
  app.stage.addChild(screen);

  // -------------------------
  // Audio
  // -------------------------
  let audioCtx = null, analyser = null, stream = null, data = null;
  let started = false;
  let paused = false;
  let smVol = 0;

  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const lerp = (a, b, t) => a + (b - a) * t;

  async function startMic() {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    await audioCtx.resume();

    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
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
    return clamp(Math.sqrt(sum / data.length), 0, 1);
  }

  // -------------------------
  // Amp texture (1px canvas -> texture)
  // -------------------------
  // ✅ 렉 줄이기: 1024 -> 640
  const COLS = 640;

  const ampCanvas = document.createElement("canvas");
  ampCanvas.width = COLS;
  ampCanvas.height = 1;
  const ampCtx = ampCanvas.getContext("2d");

  const img = ampCtx.createImageData(COLS, 1);
  const px = img.data;
  for (let i = 0; i < COLS; i++) {
    px[i * 4 + 0] = 0;
    px[i * 4 + 1] = 0;
    px[i * 4 + 2] = 0;
    px[i * 4 + 3] = 255;
  }
  ampCtx.putImageData(img, 0, 0);

  const ampTex = PIXI.Texture.from(ampCanvas);
  function flushAmpTexture() {
    ampCtx.putImageData(img, 0, 0);
    ampTex.source.update();
  }

  // -------------------------
  // ✅ "밀어서 전달" 전파 버퍼
  // -------------------------
  const ampF = new Float32Array(COLS);

  const PUSH = 0.93;    // 밀림
  const DECAY = 0.986;  // 잔상
  const RATE = 220;     // 전달 속도
  const AMP_SCALE = 1.85;

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

  // ✅ 무음이면 0, 조금만 소리나도 매우 예민
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

  // -------------------------
  // Shaders (GLSL1 / GLSL3)
  // - 무음: 얌전한 가로선 1개만
  // - 파동: A가 임계 이상일 때만 등장
  // - 루프 4개로 성능 개선
  // -------------------------
  const VERT_GLSL1 = `
    attribute vec2 aPosition;
    varying vec2 vTextureCoord;

    uniform vec4 uInputSize;
    uniform vec4 uOutputFrame;
    uniform vec4 uOutputTexture;

    vec4 filterVertexPosition(void){
      vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
      position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
      position.y = position.y * (2.0*uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
      return vec4(position, 0.0, 1.0);
    }

    vec2 filterTextureCoord(void){
      return aPosition * (uOutputFrame.zw * uInputSize.zw);
    }

    void main(void){
      gl_Position = filterVertexPosition();
      vTextureCoord = filterTextureCoord();
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

    float gauss(float x, float s){
      return exp(-(x*x)/(2.0*s*s));
    }

    void main(){
      vec2 uv = vTextureCoord;

      // 상단 red(0.0) -> 하단 violet(0.75)
      float hue = mix(0.0, 0.75, uv.y);

      float cols = uCols;
      float fx = uv.x * cols;
      float col = floor(fx);
      float inCol = fract(fx);

      // x 고정 샘플링
      float s = (col + 0.5) / cols;
      float amp = texture2D(uAmpTex, vec2(s, 0.5)).r;

      float mid = uMidY;
      float dy = abs(uv.y - mid);

      // ✅ 무음이면 밴드 0
      float A = amp * ${AMP_SCALE.toFixed(2)};
      float band = 0.0;
      if (A > 0.0012) band = smoothstep(A, A - 0.014, dy);

      // ✅ 얌전한 가로선
      float calm = smoothstep(0.006, 0.0, dy);

      // ✅ 게이트(잡음 억제)
      float gate = smoothstep(0.006, 0.020, amp);

      float seed = hash11(col + 7.13);
      float bendBase = (seed - 0.5) * 0.020;
      float bendWave = sin((uv.y * 18.0) + seed * 6.283) * 0.010;
      float bend = (bendBase + bendWave) * (0.25 + 1.2*A);

      float x = (inCol - 0.5) + bend;

      float core = 0.0;
      float halo = 0.0;
      float spec = 0.0;

      // ✅ 6 -> 4 (성능)
      for(int k=0;k<4;k++){
        float fk = float(k);
        float off = (hash11(col*3.1 + fk*12.7) - 0.5) * 0.12;
        float d = x - off;

        core += gauss(d, 0.030);
        halo += gauss(d, 0.090);

        float s1 = pow(clamp(1.0 - abs(d)/0.06, 0.0, 1.0), 18.0);
        float streak = 0.62 + 0.38*sin(uv.y*76.0 + seed*9.0 + fk*4.0);
        spec += s1 * mix(0.95, 1.35, streak);
      }

      core = clamp(core, 0.0, 1.0);
      halo = clamp(halo, 0.0, 1.0);
      spec = clamp(spec, 0.0, 1.0);

      // 보석처럼 쨍하게
      vec3 base = hsv2rgb(vec3(hue, 1.0, 1.0));
      base = pow(base, vec3(0.58));
      base *= 1.55;

      vec3 ice  = vec3(0.92, 0.99, 1.00);
      vec3 pink = vec3(1.00, 0.86, 0.98);

      float alphaWave = band * (0.18 + 0.92*gate);
      float alphaCalm = calm * 0.10;
      float alpha = max(alphaCalm, alphaWave);

      vec3 rgbWave = base * (0.76*core + 0.30*halo);
      rgbWave += ice  * (1.35 * spec);
      rgbWave += pink * (0.10 * halo);
      rgbWave = clamp(rgbWave, 0.0, 1.6);

      vec3 rgbCalm = vec3(0.92, 0.98, 1.00);

      // amp 작으면 calm, 커지면 wave
      float mixWave = gate;
      vec3 rgb = mix(rgbCalm, rgbWave, mixWave);

      float a = alpha * clamp(0.80*core + 0.55*halo + 0.95*spec, 0.0, 1.0);
      a = max(a, alphaCalm * 0.35);

      gl_FragColor = vec4(rgb, a);
    }
  `;

  const VERT_GLSL3 = `#version 300 es
    precision highp float;

    in vec2 aPosition;
    out vec2 vTextureCoord;

    uniform vec4 uInputSize;
    uniform vec4 uOutputFrame;
    uniform vec4 uOutputTexture;

    vec4 filterVertexPosition(void){
      vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
      position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
      position.y = position.y * (2.0*uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
      return vec4(position, 0.0, 1.0);
    }

    vec2 filterTextureCoord(void){
      return aPosition * (uOutputFrame.zw * uInputSize.zw);
    }

    void main(void){
      gl_Position = filterVertexPosition();
      vTextureCoord = filterTextureCoord();
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

    float gauss(float x, float s){
      return exp(-(x*x)/(2.0*s*s));
    }

    void main(){
      vec2 uv = vTextureCoord;

      float hue = mix(0.0, 0.75, uv.y);

      float cols = uCols;
      float fx = uv.x * cols;
      float col = floor(fx);
      float inCol = fract(fx);

      float s = (col + 0.5) / cols;
      float amp = texture(uAmpTex, vec2(s, 0.5)).r;

      float mid = uMidY;
      float dy = abs(uv.y - mid);

      float A = amp * ${AMP_SCALE.toFixed(2)};
      float band = 0.0;
      if (A > 0.0012) band = smoothstep(A, A - 0.014, dy);

      float calm = smoothstep(0.006, 0.0, dy);
      float gate = smoothstep(0.006, 0.020, amp);

      float seed = hash11(col + 7.13);
      float bendBase = (seed - 0.5) * 0.020;
      float bendWave = sin((uv.y * 18.0) + seed * 6.283) * 0.010;
      float bend = (bendBase + bendWave) * (0.25 + 1.2*A);

      float x = (inCol - 0.5) + bend;

      float core = 0.0;
      float halo = 0.0;
      float spec = 0.0;

      for(int k=0;k<4;k++){
        float fk = float(k);
        float off = (hash11(col*3.1 + fk*12.7) - 0.5) * 0.12;
        float d = x - off;

        core += gauss(d, 0.030);
        halo += gauss(d, 0.090);

        float s1 = pow(clamp(1.0 - abs(d)/0.06, 0.0, 1.0), 18.0);
        float streak = 0.62 + 0.38*sin(uv.y*76.0 + seed*9.0 + fk*4.0);
        spec += s1 * mix(0.95, 1.35, streak);
      }

      core = clamp(core, 0.0, 1.0);
      halo = clamp(halo, 0.0, 1.0);
      spec = clamp(spec, 0.0, 1.0);

      vec3 base = hsv2rgb(vec3(hue, 1.0, 1.0));
      base = pow(base, vec3(0.58));
      base *= 1.55;

      vec3 ice  = vec3(0.92, 0.99, 1.00);
      vec3 pink = vec3(1.00, 0.86, 0.98);

      float alphaWave = band * (0.18 + 0.92*gate);
      float alphaCalm = calm * 0.10;
      float alpha = max(alphaCalm, alphaWave);

      vec3 rgbWave = base * (0.76*core + 0.30*halo);
      rgbWave += ice  * (1.35 * spec);
      rgbWave += pink * (0.10 * halo);
      rgbWave = clamp(rgbWave, 0.0, 1.6);

      vec3 rgbCalm = vec3(0.92, 0.98, 1.00);

      float mixWave = gate;
      vec3 rgb = mix(rgbCalm, rgbWave, mixWave);

      float a = alpha * clamp(0.80*core + 0.55*halo + 0.95*spec, 0.0, 1.0);
      a = max(a, alphaCalm * 0.35);

      FragColor = vec4(rgb, a);
    }
  `;

  // -------------------------
  // Build filter
  // -------------------------
  let filter;
  try {
    const vertex = isWebGL2 ? VERT_GLSL3 : VERT_GLSL1;
    const fragment = isWebGL2 ? FRAG_GLSL3 : FRAG_GLSL1;

    const glProgram = (PIXI.GlProgram?.from)
      ? PIXI.GlProgram.from({ vertex, fragment })
      : new PIXI.GlProgram({ vertex, fragment });

    const makeFilter = (ampResource) => new PIXI.Filter({
      glProgram,
      resources: {
        uAmpTex: ampResource,
        silkUniforms: {
          uCols: { value: COLS, type: "f32" },
          uMidY: { value: 0.54, type: "f32" },
        }
      }
    });

    try { filter = makeFilter(ampTex); }
    catch { filter = makeFilter(ampTex.source); }

    screen.filters = [filter];
  } catch (e) {
    showErr("필터 생성/컴파일 실패:\n" + (e.stack || e));
    return;
  }

  window.addEventListener("resize", () => {
    screen.width = app.renderer.width;
    screen.height = app.renderer.height;
  }, { passive: true });

  // -------------------------
  // Ticker
  // -------------------------
  let last = performance.now();

  app.ticker.add(() => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    if (!started) {
      if (pill) pill.textContent = `Press Start (WebGL${isWebGL2 ? 2 : 1})`;
      return;
    }
    if (pill) pill.textContent = paused ? "Paused · tap to resume" : "Running · tap to pause";
    if (paused) return;

    const v = rms();
    smVol = lerp(smVol, v, 1 - Math.pow(0.001, dt));

    const steps = Math.max(1, Math.floor(dt * RATE));
    let amp01 = mapVolToAmp01(smVol);

    // ✅ 잡음 컷(무음인데 미세 반응 방지)
    if (amp01 < 0.02) amp01 = 0.0;

    propagateAmp(amp01, steps);

    // ampF -> texture (R 채널에 0~255)
    for (let i = 0; i < COLS; i++) {
      const vv = Math.round(clamp(ampF[i], 0, 1) * 255);
      px[i * 4 + 0] = vv;
      px[i * 4 + 3] = 255;
    }
    flushAmpTexture();

    // uniforms (DO NOT overwrite uniform descriptors; only update the .value if needed)
    const U = filter?.resources?.silkUniforms?.uniforms;
    if (U && U.uCols && typeof U.uCols === "object" && "value" in U.uCols) {
      U.uCols.value = COLS;
    }
  });

  // -------------------------
  // Controls
  // -------------------------
  async function doStart() {
    if (started) return;
    status("마이크 시작 중…");
    try {
      await startMic();
      started = true;
      paused = false;
      if (ui) ui.style.display = "none";
      status("실행 중");
    } catch (e) {
      showErr("마이크 실패:\n" + (e.stack || e));
      status("마이크 실패: HTTPS/권한 확인");
    }
  }

  btnStart.onclick = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await doStart();
  };

  window.addEventListener("pointerdown", () => {
    if (!started) return;
    if (ui && ui.style.display !== "none") return;
    paused = !paused;
  }, { passive: true });

})();
