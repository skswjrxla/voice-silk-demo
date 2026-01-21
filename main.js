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
  // Pixi v8 init (mobile friendly)
  // -------------------------
  let app;
  try {
    app = new PIXI.Application();
    await app.init({
      resizeTo: window,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      // ✅ 모바일 과부하 방지: DPR 과도하게 올리지 않음
      resolution: Math.min(1.25, window.devicePixelRatio || 1),
      powerPreference: "high-performance",
    });

    const canvas = app.renderer?.canvas || app.renderer?.view || null;
    if (!canvas) throw new Error("Renderer canvas/view not found");
    stage.appendChild(canvas);
  } catch (e) {
    showErr("PIXI 초기화 실패:\n" + (e.stack || e));
    return;
  }

  // WebGL2 여부 (GLSL3 / GLSL1 자동 선택)
  const gl = app.renderer?.gl;
  const isWebGL2 = (typeof WebGL2RenderingContext !== "undefined") && (gl instanceof WebGL2RenderingContext);

  // full screen sprite
  const screen = new PIXI.Sprite(PIXI.Texture.WHITE);
  screen.width = app.renderer.width;
  screen.height = app.renderer.height;
  app.stage.addChild(screen);

  // -------------------------
  // Audio (RMS) + threshold trigger (clear boundary)
  // -------------------------
  let audioCtx = null, analyser = null, stream = null, data = null;
  let started = false;
  let paused = false;

  const clamp = (x,a,b)=>Math.max(a,Math.min(b,x));
  const lerp  = (a,b,t)=>a+(b-a)*t;

  async function startMic(){
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    await audioCtx.resume();

    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation:true, noiseSuppression:true, autoGainControl:true }
    });

    const src = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.55;
    src.connect(analyser);

    data = new Uint8Array(analyser.fftSize);
  }

  function rms(){
    if(!analyser || !data) return 0;
    analyser.getByteTimeDomainData(data);
    let sum=0;
    for(let i=0;i<data.length;i++){
      const v=(data[i]-128)/128;
      sum += v*v;
    }
    return clamp(Math.sqrt(sum/data.length),0,1);
  }

  // ✅ 임계값 경계 명확 + 작은 소리 무시
  let smVol = 0;
  let noiseFloor = 0.002;   // 천천히 추정
  let armed = true;         // 히스테리시스(연속 트리거 방지)
  let cooldown = 0;

  // 트리거 파동(단발)
  let waveActive = 0;
  let waveX = -1;     // 0..1 진행
  let waveAmp = 0;    // 0..1
  const WAVE_SPEED = 0.95;   // 화면을 가로지르는 속도(초당)
  const WAVE_WIDTH = 0.12;   // 파동 폭(uv)

  function computeThreshold(){
    // noiseFloor 기준 + 충분히 큰 마진 => “수준 이상의 소리만”
    const dynamic = noiseFloor + 0.015;
    return Math.max(0.020, dynamic);  // 하한 0.02 (작은소리 무시)
  }

  function triggerWave(vol, thr){
    // vol이 thr보다 얼마나 큰지에 따라 amplitude 결정
    const over = clamp((vol - thr) / 0.08, 0, 1);
    waveAmp = 0.055 + 0.12 * over; // 시각적으로 충분히
    waveX = 0.0;
    waveActive = 1.0;
    cooldown = 0.20; // 200ms 쿨다운
  }

  // -------------------------
  // Fiber density (auto)
  // -------------------------
  function computeFibersCount(){
    const w = app.renderer.width;
    // 대략 10~14px 간격 느낌
    const n = Math.round(w / 12);
    return clamp(n, 70, 140);
  }

  // -------------------------
  // Shaders: procedural fibers + beads + wave intersection rainbow
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

  // --- Common fragment body as a template (GLSL1/3 wrapper differs)
  const FRAG_BODY = `
    precision highp float;

    // uniforms
    uniform float uTime;
    uniform float uFibers;
    uniform float uAspect;

    uniform float uWaveActive;
    uniform float uWaveX;
    uniform float uWaveAmp;
    uniform float uWaveW;
    uniform float uMidY;

    // small hash
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

    // slightly angular hump (tri-ish but soft)
    float angularHump(float u){
      float t = max(0.0, 1.0 - abs(u));       // triangle
      float s = t*t*(3.0 - 2.0*t);            // smoothstep-like
      return mix(t, s, 0.55);                 // 조금 각져있되 부드럽게
    }

    void shade(in vec2 uv, out vec3 outRGB, out float outA){
      // cell space for fibers
      float fibers = uFibers;
      float cell = uv.x * fibers;
      float fi = floor(cell);
      float fx = fract(cell) - 0.5; // -0.5..0.5

      float seed = hash11(fi * 17.13 + 3.7);

      // gentle sway (very subtle)
      float sway = sin(uTime*0.35 + fi*0.12 + seed*6.283) * 0.05;  // cell units
      float curve = sin(uv.y*6.0 + seed*6.283 + uTime*0.18) * 0.06;
      float xoff = (sway + curve) * (0.25 + 0.75*(1.0-uv.y)); // 상단은 덜, 하단은 조금 더

      float dx = abs(fx + xoff);

      // fiber thickness (cell units)
      float core = smoothstep(0.090, 0.0, dx);      // 얇은 실
      float halo = smoothstep(0.220, 0.090, dx);    // 주변 은은한 빛

      // base fiber color (icy glass)
      vec3 baseA = vec3(0.90, 0.97, 1.00);
      vec3 baseB = vec3(0.99, 0.92, 0.98);
      vec3 base = mix(baseA, baseB, seed*0.35);
      base *= 1.02;

      // beads: 3 per fiber
      float beadA = 0.0;
      vec3 beadRGB = vec3(0.0);
      for(int k=0;k<3;k++){
        float fk = float(k);
        float by = 0.18 + 0.64 * hash11(fi*9.73 + fk*33.1 + 1.7);
        // bead center slightly follows fiber offset
        float dy = (uv.y - by);
        float dxN = (fx + xoff) / fibers;     // normalize x
        float d = length(vec2(dxN, dy * 0.55)); // oval-ish
        float r = 0.010 + 0.004*hash11(fi*4.1 + fk*8.9); // radius
        float bead = smoothstep(r, r-0.006, d);
        if(bead > 0.0){
          float h = pow(clamp(1.0 - d/r, 0.0, 1.0), 3.5);
          float spec = pow(clamp(1.0 - d/r, 0.0, 1.0), 14.0);
          vec3 ice = vec3(0.95, 0.995, 1.0);
          vec3 tint = mix(vec3(1.0,0.92,0.98), vec3(0.88,0.98,1.0), hash11(fi+fk));
          beadRGB += (ice*(0.65*h) + vec3(1.0)*1.2*spec) * tint * bead;
          beadA = max(beadA, bead * (0.55 + 0.35*h));
        }
      }
      beadRGB = clamp(beadRGB, 0.0, 2.0);

      // ---- Wave intersection coloring (only where wave touches fibers)
      float waveBand = 0.0;
      float waveY = uMidY;

      if(uWaveActive > 0.5){
        float u = (uv.x - uWaveX) / uWaveW;
        float hump = angularHump(u);
        // single pulse shape (no oscillation)
        waveY = uMidY + (uWaveAmp * hump) * (sin(uv.x*3.1415)*0.15 + 0.85); // 아주 살짝 각/흐름만
        float dist = abs(uv.y - waveY);
        // band thickness slightly depends on amp (bigger sound => thicker band)
        float bw = 0.020 + 0.050 * uWaveAmp;
        waveBand = smoothstep(bw, bw-0.010, dist);
      }

      // only paint on fiber presence (core/halo)
      float fiberMask = clamp(core + 0.55*halo, 0.0, 1.0);
      float paint = waveBand * smoothstep(0.08, 0.26, fiberMask);

      // rainbow vertical gradient (top red -> bottom violet)
      float hue = mix(0.0, 0.75, uv.y);
      vec3 rainbow = hsv2rgb(vec3(hue, 1.0, 1.0));
      // jewel punch
      rainbow = pow(rainbow, vec3(0.58)) * 1.65;

      // mix base <-> rainbow only at intersection
      vec3 fiberRGB = base * (0.35*halo + 0.65*core);
      fiberRGB += vec3(1.0) * (0.35*halo); // glass glow

      // highlight spec along painted region
      float sparkle = paint * (0.18 + 0.82*pow(fiberMask, 1.6));
      vec3 painted = mix(fiberRGB, rainbow, paint);
      painted += vec3(1.0, 1.0, 1.0) * (0.9 * sparkle);

      // also tint beads if wave passes them (only local)
      float beadPaint = waveBand * beadA;
      vec3 beadFinal = mix(beadRGB, rainbow * 1.05 + vec3(1.0)*0.6, beadPaint);

      // final composite
      vec3 rgb = painted * fiberMask;
      rgb += beadFinal;
      rgb = clamp(rgb, 0.0, 3.0);

      float a = 0.0;
      // base fiber alpha (subtle but visible)
      a += (0.14*halo + 0.22*core);
      // beads
      a = max(a, beadA * 0.55);
      // wave makes it pop
      a += paint * 0.28;
      a = clamp(a, 0.0, 0.92);

      outRGB = rgb;
      outA = a;
    }
  `;

  const FRAG_GLSL1 = `
    varying vec2 vTextureCoord;
    ${FRAG_BODY}
    void main(){
      vec3 rgb; float a;
      shade(vTextureCoord, rgb, a);
      gl_FragColor = vec4(rgb, a);
    }
  `;

  const FRAG_GLSL3 = `#version 300 es
    precision highp float;
    in vec2 vTextureCoord;
    out vec4 FragColor;
    ${FRAG_BODY}
    void main(){
      vec3 rgb; float a;
      shade(vTextureCoord, rgb, a);
      FragColor = vec4(rgb, a);
    }
  `;

  // -------------------------
  // Build filter (robust for Pixi v8)
  // -------------------------
  let filter;
  try {
    const vertex = isWebGL2 ? VERT_GLSL3 : VERT_GLSL1;
    const fragment = isWebGL2 ? FRAG_GLSL3 : FRAG_GLSL1;

    const glProgram = (PIXI.GlProgram?.from)
      ? PIXI.GlProgram.from({ vertex, fragment })
      : new PIXI.GlProgram({ vertex, fragment });

    filter = new PIXI.Filter({
      glProgram,
      resources: {
        u: {
          uTime:       { value: 0,    type: "f32" },
          uFibers:     { value: computeFibersCount(), type: "f32" },
          uAspect:     { value: (app.renderer.width / Math.max(1, app.renderer.height)), type: "f32" },
          uWaveActive: { value: 0,    type: "f32" },
          uWaveX:      { value: -1,   type: "f32" },
          uWaveAmp:    { value: 0,    type: "f32" },
          uWaveW:      { value: WAVE_WIDTH, type: "f32" },
          uMidY:       { value: 0.54, type: "f32" },
        }
      }
    });

    screen.filters = [filter];
  } catch (e) {
    showErr("필터 생성/컴파일 실패:\n" + (e.stack || e));
    return;
  }

  function syncSize(){
    screen.width = app.renderer.width;
    screen.height = app.renderer.height;
    const U = filter.resources.u.uniforms;
    U.uFibers = computeFibersCount();
    U.uAspect = app.renderer.width / Math.max(1, app.renderer.height);
  }
  window.addEventListener("resize", syncSize, { passive:true });

  // -------------------------
  // Ticker
  // -------------------------
  let last = performance.now();

  app.ticker.add(() => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    // update time always (even before start) => base sway visible
    const U = filter.resources.u.uniforms;
    U.uTime += dt;

    if (!started) {
      if (pill) pill.textContent = `Idle (WebGL${isWebGL2 ? 2 : 1}) · Press Start`;
      // keep wave off
      U.uWaveActive = 0;
      return;
    }

    if (pill) pill.textContent = paused ? "Paused · tap to resume" : "Running · (loud voice triggers one wave)";
    if (paused) return;

    // cooldown
    cooldown = Math.max(0, cooldown - dt);

    // RMS
    const v = rms();
    smVol = lerp(smVol, v, 1 - Math.pow(0.001, dt));

    // noiseFloor: only update when below a small cap (quiet times)
    if (smVol < 0.010) {
      noiseFloor = lerp(noiseFloor, smVol, 0.02);
      noiseFloor = clamp(noiseFloor, 0.0005, 0.010);
    }

    const thr = computeThreshold();
    const low = Math.max(noiseFloor + 0.006, thr * 0.55); // re-arm threshold

    // hysteresis / arming
    if (smVol < low) armed = true;

    // trigger only when clearly loud
    if (armed && cooldown <= 0 && smVol > thr) {
      triggerWave(smVol, thr);
      armed = false;
    }

    // advance wave
    if (waveActive > 0.5) {
      waveX += dt * WAVE_SPEED;
      if (waveX > 1.20) {
        waveActive = 0.0;
        waveX = -1.0;
        waveAmp = 0.0;
      }
    }

    // push uniforms
    U.uWaveActive = waveActive;
    U.uWaveX = waveX;
    U.uWaveAmp = waveAmp;
    U.uWaveW = WAVE_WIDTH;
    U.uMidY = 0.54;
  });

  // -------------------------
  // Controls
  // -------------------------
  async function doStart(){
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

  // tap to pause/resume after started
  window.addEventListener("pointerdown", () => {
    if (!started) return;
    if (ui && ui.style.display !== "none") return;
    paused = !paused;
  }, { passive:true });

})();
