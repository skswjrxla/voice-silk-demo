(() => {
  const stage = document.getElementById("stage");
  const ui = document.getElementById("ui");
  const btnStart = document.getElementById("btnStart");
  const statusEl = document.getElementById("status");
  const pill = document.getElementById("pill");

  const status = (t) => statusEl.textContent = t;

  // -------------------------
  // Pixi App (transparent)
  // -------------------------
  const app = new PIXI.Application({
    resizeTo: window,
    backgroundAlpha: 0,
    antialias: true,
    powerPreference: "high-performance",
    autoDensity: true,
    resolution: Math.min(1.5, window.devicePixelRatio || 1),
  });
  stage.appendChild(app.canvas);

  // Fullscreen white sprite as filter target
  const screen = new PIXI.Sprite(PIXI.Texture.WHITE);
  screen.anchor.set(0);
  screen.width = app.renderer.width;
  screen.height = app.renderer.height;
  app.stage.addChild(screen);

  // -------------------------
  // Audio RMS
  // -------------------------
  let audioCtx = null, analyser = null, stream = null, data = null;
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
    analyser.smoothingTimeConstant = 0.62; // 예민하게
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
  // Ring-buffer amplitude texture (1D)
  // -------------------------
  const COLS = 1024;            // columns across width
  const ampRGBA = new Uint8Array(COLS * 4);
  for(let i=0;i<COLS;i++){
    ampRGBA[i*4+0] = 0;   // R: amp
    ampRGBA[i*4+1] = 0;
    ampRGBA[i*4+2] = 0;
    ampRGBA[i*4+3] = 255; // A
  }

  const ampTex = PIXI.Texture.fromBuffer(ampRGBA, COLS, 1, {
    scaleMode: PIXI.SCALE_MODES.NEAREST,
  });

  let headOffset = 0;           // which amp index is currently at screen col 0
  let scrollPx = 0;             // accumulated pixels for stepping
  const speedPx = 520;          // wave move speed px/sec (screen space)

  // Mapping: "무음일 때 매우 작게", "조금만 커져도 급격히 반응"
  function mapVolToAmp01(vRaw){
    // vRaw: RMS 0..1 (대개 0.00~0.10 영역에서 놀음)

    // 완전 무음 근처에서도 "아주 작게"
    const SILENT = 0.010;
    const minAmp = 0.010; // 화면 높이 대비 최소 진폭(= 매우 작게)

    // 조금만 소리 나도 확 반응 시작
    const KNEE = 0.016;

    if(vRaw <= SILENT) return minAmp;

    // knee 이후를 강하게 확장
    const x = clamp((vRaw - KNEE) / (1 - KNEE), 0, 1);

    // 민감도 핵심(조절 포인트)
    const gain = 11.0;       // 더 예민: 9~14
    const gamma = 0.20;      // 더 예민: 0.18~0.30 (낮을수록 민감)

    const y = Math.pow(clamp(x * gain, 0, 1), gamma);

    // 큰 소리에서 너무 과하면 0.38~0.42로 낮추기
    const maxAmp = 0.38;

    return minAmp + y * (maxAmp - minAmp);
  }

  function writeAmpAtHead(amp01){
    const v = Math.round(clamp(amp01,0,1) * 255);
    const i = headOffset % COLS;
    ampRGBA[i*4+0] = v;
    ampRGBA[i*4+1] = 0;
    ampRGBA[i*4+2] = 0;
    ampRGBA[i*4+3] = 255;
  }

  // -------------------------
  // “Hair / Silk” shader as Pixi Filter
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

  // Fragment: procedural silky strands + anisotropic highlight (vertical tangent)
  const fragment = `
    precision highp float;

    in vec2 vTextureCoord;

    uniform sampler2D uTexture;   // Pixi input (unused)
    uniform sampler2D uAmpTex;    // 1D amp ring texture

    uniform vec2  uRes;
    uniform float uTime;
    uniform float uCols;
    uniform float uHeadOffset;
    uniform float uMidY;

    // hash
    float hash11(float p){
      p = fract(p * 0.1031);
      p *= p + 33.33;
      p *= p + p;
      return fract(p);
    }

    vec3 hsv2rgb(vec3 c){
      // c.x: hue 0..1
      vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
      vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
      return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
    }

    float gauss(float x, float s){
      return exp(-(x*x)/(2.0*s*s));
    }

    void main(){
      vec2 uv = vTextureCoord; // 0..1
      // absolute rainbow: top red -> bottom violet (270deg)
      float hue = mix(0.0, 0.75, uv.y);

      // column id across screen
      float cols = uCols;
      float fx = uv.x * cols;
      float col = floor(fx);
      float inCol = fract(fx); // 0..1 within column step

      // ring index mapping: screen col0 corresponds to headOffset
      float idx = mod(col + uHeadOffset, cols);

      // sample amp (0..1) from 1D texture
      float s = (idx + 0.5) / cols;
      float amp = texture2D(uAmpTex, vec2(s, 0.5)).r; // 0..1
      // amp is stored in 0..1 already? (we store 0..255 -> sampler returns 0..1)
      // Convert to normalized amp in UV space (relative to screen height)
      float A = amp * 0.45; // scale in shader; tune if needed

      // very small at silence still visible, but tiny
      float minA = 0.0025;
      A = max(A, minA);

      // vertical bounds around mid
      float mid = uMidY;
      float dy = abs(uv.y - mid);

      // if outside amplitude band, alpha 0
      float band = smoothstep(A, A - 0.004, dy); // inside=1, outside=0

      // if nearly nothing, fade away (keeps "very small" but still subtle)
      float silentGate = smoothstep(0.012, 0.020, amp);

      // ---- slight hair flow / curvature (static-ish + tiny optical drift)
      float seed = hash11(idx + 7.13);
      float bendBase = (seed - 0.5) * 0.020;
      float bendWave = sin((uv.y * 20.0) + seed * 6.283) * 0.018;
      float bendTime = sin(uTime * 0.35 + seed * 9.0) * 0.006; // optical, subtle
      float bend = (bendBase + bendWave + bendTime) * (0.25 + 1.2*A);

      // shift "inCol" center by bend => gentle curve
      float x = (inCol - 0.5) + bend;

      // ---- multiple micro-strands per column (hair bundle)
      float core = 0.0;
      float halo = 0.0;
      float spec = 0.0;

      // 3 strands in a column
      for(int k=0;k<3;k++){
        float fk = float(k);
        float off = (hash11(idx*3.1 + fk*12.7) - 0.5) * 0.18; // within column
        float wCore = 0.050; // thin core
        float wHalo = 0.120; // soft glow
        float d = x - off;

        float c = gauss(d, wCore);
        float h = gauss(d, wHalo);

        // anisotropic highlight: very tight around center, boosted
        float s1 = pow(clamp(1.0 - abs(d)/0.07, 0.0, 1.0), 12.0);
        // add “silk spec streak” that varies along y (gives hair feel)
        float streak = 0.55 + 0.45*sin(uv.y*70.0 + seed*9.0 + fk*4.0);
        s1 *= mix(0.85, 1.25, streak);

        core += c;
        halo += h;
        spec += s1;
      }

      // normalize
      core = clamp(core, 0.0, 1.0);
      halo = clamp(halo, 0.0, 1.0);
      spec = clamp(spec, 0.0, 1.0);

      // ---- color: jewel rainbow + ice highlights + slight chromatic edge
      vec3 base = hsv2rgb(vec3(hue, 0.95, 1.0));
      // boost “gem” contrast
      base = pow(base, vec3(0.78)); // punchier

      // ice-white highlight and tiny chroma aberration
      vec3 ice = vec3(0.90, 0.98, 1.00);
      vec3 pink = vec3(1.00, 0.86, 0.98);

      // intensity
      float alpha = band * (0.14 + 0.86 * silentGate);

      // compose: core is sharper, halo is softer
      vec3 colRGB = base * (0.55*core + 0.35*halo);

      // spec is “screen-ish”
      colRGB += ice * (0.95 * spec);
      colRGB += pink * (0.12 * halo);

      // extra “silk depth”: darken edges slightly
      float edge = smoothstep(0.60, 0.15, abs(inCol - 0.5));
      colRGB *= (0.90 + 0.10*edge);

      // final alpha: thin hair + glow
      float a = alpha * clamp(0.55*core + 0.45*halo + 0.65*spec, 0.0, 1.0);

      // clamp outside band
      a *= band;

      // output premultiplied-ish look: keep strong color
      gl_FragColor = vec4(colRGB, a);
    }
  `;

  const filter = new PIXI.Filter({
    glProgram: new PIXI.GlProgram({ vertex, fragment }),
    resources: {
      uAmpTex: ampTex.source,
      silkUniforms: {
        uRes:       { value: [app.renderer.width, app.renderer.height], type: 'vec2<f32>' },
        uTime:      { value: 0.0, type: 'f32' },
        uCols:      { value: COLS, type: 'f32' },
        uHeadOffset:{ value: 0.0, type: 'f32' },
        uMidY:      { value: 0.54, type: 'f32' },
      }
    }
  });

  // Blend: add a bit of luminous feel
  screen.filters = [filter];

  // -------------------------
  // Resize handling
  // -------------------------
  function onResize(){
    screen.width = app.renderer.width;
    screen.height = app.renderer.height;
    filter.resources.silkUniforms.uniforms.uRes[0] = app.renderer.width;
    filter.resources.silkUniforms.uniforms.uRes[1] = app.renderer.height;
  }
  window.addEventListener("resize", onResize, { passive:true });

  // -------------------------
  // Control: start / tap pause-resume
  // -------------------------
  let started = false;
  let paused = false;

  // update loop
  let last = performance.now();

  app.ticker.add(() => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    // UI pill
    if(!started){
      pill.textContent = "Press Start";
    } else {
      pill.textContent = paused ? "Paused · tap to resume" : "Running · tap to pause";
    }

    if(!started) return;

    // sample audio even if paused (so resume is instant), but don't advance wave if paused
    const v = rms();
    smVol = lerp(smVol, v, 1 - Math.pow(0.001, dt));

    // time uniform (optical subtle)
    const U = filter.resources.silkUniforms.uniforms;
    U.uTime += paused ? 0.0 : (dt);

    if(paused) return;

    // advance ring by pixel speed -> column steps
    const stepPx = app.renderer.width / COLS;
    scrollPx += speedPx * dt;

    // how many new columns entered
    const steps = Math.floor(scrollPx / stepPx);
    if(steps > 0){
      scrollPx -= steps * stepPx;

      // compute current amp
      const amp01 = mapVolToAmp01(smVol);

      // write multiple steps (if frame lag)
      for(let k=0;k<steps;k++){
        headOffset = (headOffset + 1) % COLS;
        writeAmpAtHead(amp01);
      }

      ampTex.source.update();
      U.uHeadOffset = headOffset;
    }
  });

  async function doStart(){
    if(started) return;
    status("마이크 시작 중…");
    try{
      await startMic();
      started = true;
      paused = false;
      ui.style.display = "none";
      status("실행 중");
    }catch(e){
      console.error(e);
      status("마이크 실패: HTTPS/권한 확인");
    }
  }

  btnStart.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    doStart();
  });

  // Tap anywhere toggles pause/resume AFTER start (UI가 닫힌 뒤)
  window.addEventListener("pointerdown", (e) => {
    if(!started) return;
    if(ui.style.display !== "none") return; // start overlay visible -> ignore
    paused = !paused;
  }, { passive:true });

})();
