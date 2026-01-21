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
  // ✅ Pixi v8 안전 초기화
  // -------------------------
  let app;
  try {
    app = new PIXI.Application();

    if (typeof app.init === "function") {
      await app.init({
        resizeTo: window,
        backgroundAlpha: 0,
        antialias: true,
        autoDensity: true,
        resolution: Math.min(1.5, window.devicePixelRatio || 1),
        powerPreference: "high-performance",
      });
    } else {
      // 혹시 구버전/다른 빌드가 섞였을 때 최소 동작 fallback
      // (v8에서는 init가 있어야 정상)
      showErr("PIXI.Application.init()가 없습니다. pixi 버전/빌드가 섞였을 가능성.");
      status("PIXI init 없음");
      return;
    }

    // ✅ 여기서 renderer가 없으면 이후 app.canvas 접근 시 바로 터짐
    if (!app.renderer) {
      showErr("Renderer 생성 실패: WebGL/WebGPU 초기화가 안 됐습니다(드라이버/브라우저 문제 가능).");
      status("Renderer 실패");
      return;
    }

    // ✅ 절대 app.canvas를 읽지 말고 renderer에서 캔버스를 꺼낸다 (핵심)
    const canvas =
      app.renderer?.canvas ||
      app.renderer?.view ||
      null;

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
  // Amp ring texture (1px canvas -> texture)
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

  let headOffset = 0;
  let scrollPx = 0;
  const speedPx = 520;

  function mapVolToAmp01(vRaw){
    const SILENT = 0.010;
    const KNEE   = 0.016;

    const minAmp = 0.010; // 무음일 때 “매우 작게”
    const maxAmp = 0.38;

    if (vRaw <= SILENT) return minAmp;

    const x = clamp((vRaw - KNEE) / (1 - KNEE), 0, 1);

    const gain  = 11.0;  // 더 예민: 13~15
    const gamma = 0.20;  // 더 예민: 0.16~0.22

    const y = Math.pow(clamp(x * gain, 0, 1), gamma);
    return minAmp + y * (maxAmp - minAmp);
  }

  function writeAmpAtHead(amp01){
    const v = Math.round(clamp(amp01,0,1)*255);
    const i = headOffset % COLS;
    px[i*4+0] = v;
    px[i*4+3] = 255;
  }

  function flushAmpTexture(){
    ampCtx.putImageData(img, 0, 0);
    ampTex.source.update();
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

      float hue = mix(0.0, 0.75, uv.y);

      float cols = uCols;
      float fx = uv.x * cols;
      float col = floor(fx);
      float inCol = fract(fx);

      float idx = mod(col + uHeadOffset, cols);
      float s = (idx + 0.5) / cols;

      float amp = texture2D(uAmpTex, vec2(s, 0.5)).r;
      float A = max(amp * 0.45, 0.0025);

      float mid = uMidY;
      float dy = abs(uv.y - mid);

      float band = smoothstep(A, A - 0.004, dy);
      float silentGate = smoothstep(0.012, 0.020, amp);

      float seed = hash11(idx + 7.13);
      float bendBase = (seed - 0.5) * 0.020;
      float bendWave = sin((uv.y * 20.0) + seed * 6.283) * 0.018;
      float bendTime = sin(uTime * 0.35 + seed * 9.0) * 0.006;
      float bend = (bendBase + bendWave + bendTime) * (0.25 + 1.2*A);

      float x = (inCol - 0.5) + bend;

      float core = 0.0;
      float halo = 0.0;
      float spec = 0.0;

      for(int k=0;k<3;k++){
        float fk = float(k);
        float off = (hash11(idx*3.1 + fk*12.7) - 0.5) * 0.18;

        float wCore = 0.050;
        float wHalo = 0.120;

        float d = x - off;

        float c = gauss(d, wCore);
        float h = gauss(d, wHalo);

        float s1 = pow(clamp(1.0 - abs(d)/0.07, 0.0, 1.0), 12.0);
        float streak = 0.55 + 0.45*sin(uv.y*70.0 + seed*9.0 + fk*4.0);
        s1 *= mix(0.85, 1.25, streak);

        core += c;
        halo += h;
        spec += s1;
      }

      core = clamp(core, 0.0, 1.0);
      halo = clamp(halo, 0.0, 1.0);
      spec = clamp(spec, 0.0, 1.0);

      vec3 base = hsv2rgb(vec3(hue, 0.95, 1.0));
      base = pow(base, vec3(0.78));

      vec3 ice = vec3(0.90, 0.98, 1.00);
      vec3 pink = vec3(1.00, 0.86, 0.98);

      float alpha = band * (0.14 + 0.86 * silentGate);

      vec3 colRGB = base * (0.55*core + 0.35*halo);
      colRGB += ice  * (0.95 * spec);
      colRGB += pink * (0.12 * halo);

      float edge = smoothstep(0.60, 0.15, abs(inCol - 0.5));
      colRGB *= (0.90 + 0.10*edge);

      float a = alpha * clamp(0.55*core + 0.45*halo + 0.65*spec, 0.0, 1.0);
      a *= band;

      gl_FragColor = vec4(colRGB, a);
    }
  `;

  let filter;
  try {
    const glProgram = (PIXI.GlProgram?.from)
      ? PIXI.GlProgram.from({ vertex, fragment })
      : new PIXI.GlProgram({ vertex, fragment });

    // uAmpTex 리소스는 빌드/버전 차이로 Texture vs TextureSource가 다르게 요구될 수 있어서 2단계 방어
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

    try {
      filter = makeFilter(ampTex);          // 1) Texture로 시도
    } catch {
      filter = makeFilter(ampTex.source);   // 2) 안 되면 Source로
    }

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

    const v = rms();
    smVol = lerp(smVol, v, 1 - Math.pow(0.001, dt));

    const U = filter.resources.silkUniforms.uniforms;
    if(!paused) U.uTime += dt;
    if(paused) return;

    const stepPx = app.renderer.width / COLS;
    scrollPx += speedPx * dt;

    const steps = Math.floor(scrollPx / stepPx);
    if(steps <= 0) return;

    scrollPx -= steps * stepPx;

    const amp01 = mapVolToAmp01(smVol);

    for(let k=0;k<steps;k++){
      headOffset = (headOffset + 1) % COLS;
      writeAmpAtHead(amp01);
    }

    flushAmpTexture();
    U.uHeadOffset = headOffset;
  });

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
