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

  status("main.js 로드됨");

  if (!window.PIXI) {
    showErr("PIXI 로드 실패: pixi.min.js가 로딩되지 않았습니다(CDN 차단/네트워크).");
    status("PIXI 로드 실패");
    return;
  }

  // -------------------------
  // Pixi v8 safe init
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

    if (!app.renderer) {
      showErr("Renderer 생성 실패: WebGL/WebGPU 초기화가 안 됐습니다.");
      status("Renderer 실패");
      return;
    }

    const canvas = app.renderer?.canvas || app.renderer?.view || null;
    if (!canvas) {
      showErr("Renderer canvas/view를 찾지 못했습니다.");
      status("Canvas 없음");
      return;
    }
    stage.appendChild(canvas);
  } catch (e) {
    showErr("PIXI 초기화 실패:\n" + (e.stack || e));
    status("PIXI 실패");
    return;
  }

  // -------------------------
  // Fullscreen sprite (filter target)
  // -------------------------
  const screen = new PIXI.Sprite(PIXI.Texture.WHITE);
  screen.width = app.renderer.width;
  screen.height = app.renderer.height;
  app.stage.addChild(screen);

  // -------------------------
  // Audio RMS
  // -------------------------
  let audioCtx = null, analyser = null, stream = null, data = null;
  let started = false;
  let paused = false;
  let smVol = 0;

  const clamp = (x,a,b) => Math.max(a, Math.min(b, x));
  const lerp = (a,b,t) => a + (b-a)*t;

  async function startMic(){
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    await audioCtx.resume();

    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation:true, noiseSuppression:true, autoGainControl:true }
    });

    const src = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.62;
    src.connect(analyser);

    data = new Uint8Array(analyser.fftSize);
  }

  function rms(){
    if(!analyser || !data) return 0;
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for(let i=0;i<data.length;i++){
      const v = (data[i]-128)/128;
      sum += v*v;
    }
    return clamp(Math.sqrt(sum/data.length), 0, 1);
  }

  // -------------------------
  // Amp texture (1px canvas -> texture)
  // -------------------------
  const COLS = 1024;

  const ampCanvas = document.createElement("canvas");
  ampCanvas.width = COLS;
  ampCanvas.height = 1;
  const ampCtx = ampCanvas.getContext("2d");

  const img = ampCtx.createImageData(COLS, 1);
  const px = img.data;
  for(let i=0;i<COLS;i++){
    px[i*4+0]=0; px[i*4+1]=0; px[i*4+2]=0; px[i*4+3]=255;
  }
  ampCtx.putImageData(img, 0, 0);

  const ampTex = PIXI.Texture.from(ampCanvas);

  function flushAmpTexture(){
    ampCtx.putImageData(img, 0, 0);
    ampTex.source.update();
  }

  // -------------------------
  // ✅ "선이 선을 밀어서 전달" 전파 버퍼 (평행이동 느낌 제거)
  // -------------------------
  const ampF = new Float32Array(COLS); // 0..1
  let PUSH  = 0.92;   // 0.88~0.96 (클수록 '밀림' 강함)
  let DECAY = 0.985;  // 0.97~0.995 (클수록 잔상 길음)
  let RATE  = 180;    // 초당 전파 스텝 (클수록 전달 빠름)

  function propagateAmp(inputAmp01, steps){
    for(let s=0; s<steps; s++){
      for(let i=COLS-1; i>=1; i--){
        ampF[i] = ampF[i] * DECAY + ampF[i-1] * PUSH;
        if (ampF[i] > 1) ampF[i] = 1;
        if (ampF[i] < 0) ampF[i] = 0;
      }
      ampF[0] = inputAmp01;
    }
  }

  // ✅ 무음일 땐 거의 안 보이고, 조금만 말해도 아주 예민하게
  function mapVolToAmp01(vRaw){
    const SILENT = 0.002;
    const KNEE   = 0.004;

    const minAmp = 0.000;  // 거의 무음이면 거의 안 보이게
    const maxAmp = 0.78;   // 진폭 크게

    if (vRaw <= SILENT) return minAmp;

    const x = clamp((vRaw - KNEE) / (1 - KNEE), 0, 1);

    const gain  = 18.0;  // 매우 예민
    const gamma = 0.18;  // 작은 소리도 빠르게 상승

    const y = Math.pow(clamp(x * gain, 0, 1), gamma);
    return minAmp + y * (maxAmp - minAmp);
  }

  // -------------------------
  // Silk shader filter
  // -------------------------
  const vertex = `
    in vec2 aPosition;
    out vec2 vTextureCoord;

    uniform vec4 uInputSize;
    uniform vec4 uOutputFrame;
    uniform vec4 uOutputTexture;

    vec4 filterVertexPosition( void )
    {
        vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
        position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
        position.y = position.y * (2.0*uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
        return vec4(position, 0.0, 1.0);
    }

    vec2 filterTextureCoord( void )
    {
        return aPosition * (uOutputFrame.zw * uInputSize.zw);
    }

    void main(void)
    {
        gl_Position = filterVertexPosition();
        vTextureCoord = filterTextureCoord();
    }
  `;

  const fragment = `
    precision highp float;

    in vec2 vTextureCoord;

    uniform sampler2D uTexture;
    uniform sampler2D uAmpTex;

    uniform vec2  uRes;
    uniform float uTime;
    uniform float uCols;
    uniform float uHeadOffset;
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

      // absolute rainbow: top red -> bottom violet
      float hue = mix(0.0, 0.75, uv.y);

      float cols = uCols;
      float fx = uv.x * cols;
      float col = floor(fx);
      float inCol = fract(fx);

      // ✅ 샘플링은 화면 x에 고정 (평행이동 느낌 제거)
      float s = (col + 0.5) / cols;
      float amp = texture2D(uAmpTex, vec2(s, 0.5)).r; // 0..1

      // ✅ 진폭을 화면에서 더 크게, 밴드는 더 두껍게(밝은 배경에서도 확실히)
      float A = max(amp * 1.35, 0.0015);

      float mid = uMidY;
      float dy = abs(uv.y - mid);

      float band = smoothstep(A, A - 0.012, dy);              // 두께
      float silentGate = smoothstep(0.002, 0.008, amp);        // 작은 소리에도 켜짐

      // ✅ 실(섬유) 결은 화면에 고정 + 시간 요동 없음
      float seed = hash11(col + 7.13);
      float bendBase = (seed - 0.5) * 0.020;
      float bendWave = sin((uv.y * 18.0) + seed * 6.283) * 0.010;
      float bendTime = 0.0; // 절대 요동/흐름 금지
      float bend = (bendBase + bendWave + bendTime) * (0.25 + 1.2*A);

      float x = (inCol - 0.5) + bend;

      // 섬유: 가닥 수↑, 코어 얇게, 하이라이트 날카롭게
      float core = 0.0;
      float halo = 0.0;
      float spec = 0.0;

      for(int k=0;k<6;k++){
        float fk = float(k);

        float off = (hash11(col*3.1 + fk*12.7) - 0.5) * 0.12;

        float wCore = 0.032;
        float wHalo = 0.095;

        float d = x - off;

        float c = gauss(d, wCore);
        float h = gauss(d, wHalo);

        float s1 = pow(clamp(1.0 - abs(d)/0.06, 0.0, 1.0), 18.0);

        // 정적 실 결 (시간 X)
        float streak = 0.62 + 0.38*sin(uv.y*76.0 + seed*9.0 + fk*4.0);
        s1 *= mix(0.95, 1.35, streak);

        core += c;
        halo += h;
        spec += s1;
      }

      core = clamp(core, 0.0, 1.0);
      halo = clamp(halo, 0.0, 1.0);
      spec = clamp(spec, 0.0, 1.0);

      // ✅ 더 선명/진하게 (배경과 확실히 분리)
      vec3 base = hsv2rgb(vec3(hue, 1.0, 1.0));
      base = pow(base, vec3(0.60));
      base *= 1.35;

      vec3 ice  = vec3(0.90, 0.98, 1.00);
      vec3 pink = vec3(1.00, 0.86, 0.98);

      float alpha = band * (0.45 + 0.85 * silentGate);

      vec3 colRGB = base * (0.72*core + 0.32*halo);
      colRGB += ice  * (1.15 * spec);
      colRGB += pink * (0.10 * halo);

      float edge = smoothstep(0.62, 0.10, abs(inCol - 0.5));
      colRGB *= (0.86 + 0.14*edge);

      colRGB = clamp(colRGB, 0.0, 1.35);

      float a = alpha * clamp(0.75*core + 0.45*halo + 0.85*spec, 0.0, 1.0);
      a *= band;

      gl_FragColor = vec4(colRGB, a);
    }
  `;

  let filter;
  try {
    const glProgram = (PIXI.GlProgram?.from)
      ? PIXI.GlProgram.from({ vertex, fragment })
      : new PIXI.GlProgram({ vertex, fragment });

    const makeFilter = (ampResource) => new PIXI.Filter({
      glProgram,
      resources: {
        uAmpTex: ampResource,
        silkUniforms: {
          uRes:       { value: [app.renderer.width, app.renderer.height], type: "vec2<f32>" },
          uTime:      { value: 0.0, type: "f32" },
          uCols:      { value: COLS, type: "f32" },
          uHeadOffset:{ value: 0.0, type: "f32" },
          uMidY:      { value: 0.54, type: "f32" },
        }
      }
    });

    try { filter = makeFilter(ampTex); }
    catch { filter = makeFilter(ampTex.source); }

    screen.filters = [filter];
  } catch (e) {
    showErr("필터 생성 실패:\n" + (e.stack || e));
    status("필터 실패");
    return;
  }

  function onResize(){
    screen.width = app.renderer.width;
    screen.height = app.renderer.height;
    const U = filter.resources.silkUniforms.uniforms;
    U.uRes = [app.renderer.width, app.renderer.height];
  }
  window.addEventListener("resize", onResize, { passive:true });

  // -------------------------
  // Ticker
  // -------------------------
  let last = performance.now();

  app.ticker.add(() => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last)/1000);
    last = now;

    if(!started){
      pill.textContent = "Press Start";
      return;
    }
    pill.textContent = paused ? "Paused · tap to resume" : "Running · tap to pause";
    if(paused) return;

    const v = rms();
    smVol = lerp(smVol, v, 1 - Math.pow(0.001, dt));

    const U = filter.resources.silkUniforms.uniforms;
    U.uTime = 0.0;       // 시간 기반 움직임 완전 차단
    U.uHeadOffset = 0.0; // 이동 샘플링 안 씀

    // 전파 스텝 수(프레임 시간 기반)
    const steps = Math.max(1, Math.floor(dt * RATE));
    const amp01 = mapVolToAmp01(smVol);

    // "밀어서 전달"
    propagateAmp(amp01, steps);

    // ampF -> texture
    for(let i=0;i<COLS;i++){
      const vv = Math.round(clamp(ampF[i], 0, 1) * 255);
      px[i*4 + 0] = vv;
      px[i*4 + 3] = 255;
    }

    flushAmpTexture();
  });

  // -------------------------
  // Controls
  // -------------------------
  async function doStart(){
    if(started) return;
    status("마이크 시작 중…");
    try {
      await startMic();
      started = true;
      paused = false;
      ui.style.display = "none";
      status("실행 중");
    } catch (e) {
      showErr("마이크 실패:\n" + (e.stack || e));
      status("마이크 실패: HTTPS/권한 확인");
    }
  }

  btnStart.onclick = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    status("Start 클릭됨");
    await doStart();
  };

  window.addEventListener("pointerdown", () => {
    if(!started) return;
    if(ui.style.display !== "none") return;
    paused = !paused;
  }, { passive:true });

})();
