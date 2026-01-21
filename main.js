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

  // -------------------------
  // 1. PixiJS v8 초기화
  // -------------------------
  if (!window.PIXI) {
    showErr("PIXI 로드 실패: pixi.min.js가 필요합니다.");
    return;
  }

  let app;
  try {
    app = new PIXI.Application();
    await app.init({
      resizeTo: window,
      backgroundAlpha: 0, // 배경 투명
      antialias: true,
      autoDensity: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      powerPreference: "high-performance",
    });
    stage.appendChild(app.canvas);
  } catch (e) {
    showErr("PIXI 초기화 실패: " + e.message);
    return;
  }

  // 필터 적용 대상 (전체 화면)
  const screen = new PIXI.Sprite(PIXI.Texture.EMPTY);
  screen.width = app.renderer.width;
  screen.height = app.renderer.height;
  app.stage.addChild(screen);

  // -------------------------
  // 2. 데이터 텍스처 (Canvas 방식)
  // -------------------------
  const HISTORY_SIZE = 256; 
  const dataCanvas = document.createElement("canvas");
  dataCanvas.width = HISTORY_SIZE;
  dataCanvas.height = 1;
  const dataCtx = dataCanvas.getContext("2d", { willReadFrequently: true });
  
  // 픽셀 데이터 접근용
  const imgData = dataCtx.createImageData(HISTORY_SIZE, 1);
  const px = imgData.data;

  // 텍스처 생성
  const ampTexture = PIXI.Texture.from(dataCanvas);
  ampTexture.source.scaleMode = 'linear'; // 부드러운 보간

  // -------------------------
  // 3. 오디오 분석기 설정
  // -------------------------
  let audioCtx, analyser, dataArray;
  let started = false;
  let paused = false;
  const historyData = new Uint8Array(HISTORY_SIZE); // 0~255 값 저장

  async function startMic() {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    await audioCtx.resume();
    
    // 에코 캔슬러 해제 (생생한 파동)
    const stream = await navigator.mediaDevices.getUserMedia({ 
      audio: { echoCancellation: false, autoGainControl: false, noiseSuppression: true } 
    });
    
    const src = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024; 
    analyser.smoothingTimeConstant = 0.3;
    src.connect(analyser);
    
    dataArray = new Uint8Array(analyser.fftSize);
  }

  function getVolume() {
    if (!analyser) return 0;
    analyser.getByteTimeDomainData(dataArray);
    
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const v = (dataArray[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / dataArray.length);
  }

  // -------------------------
  // 4. 셰이더 (WebGL 2 문법 준수)
  // -------------------------
  
  // [Vertex Shader] Pixi v8 표준
  const vertex = `
    in vec2 aPosition;
    out vec2 vTextureCoord;

    uniform vec4 uOutputFrame;
    uniform vec4 uOutputTexture;

    void main() {
      vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
      position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
      position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
      gl_Position = vec4(position, 0.0, 1.0);
      vTextureCoord = aPosition * (uOutputFrame.zw / uOutputTexture.xy);
    }
  `;

  // [Fragment Shader] WebGL 2 문법 (gl_FragColor 삭제, out vec4 사용)
  const fragment = `
    precision highp float;
    
    in vec2 vTextureCoord;
    out vec4 finalColor; // [중요] 출력 변수 명시적 선언

    uniform sampler2D uAmpTexture;
    uniform float uTime;

    float hash(float p) {
      p = fract(p * .1031);
      p *= p + 33.33;
      p *= p + p;
      return fract(p);
    }

    void main() {
      vec2 uv = vTextureCoord;
      
      // 1. 데이터 읽기 (texture2D -> texture)
      // uv.x: 0(왼쪽/최신) -> 1(오른쪽/과거)
      float amp = texture(uAmpTexture, vec2(uv.x, 0.5)).r;
      
      // 노이즈 게이트
      if(amp < 0.03) amp = 0.0;

      // 2. 파동 변위
      float wave = amp * 0.5 * sin(uv.x * 25.0 - uTime * 4.0);
      float centerY = 0.5;
      
      vec3 col = vec3(0.0);
      float alphaSum = 0.0;
      
      // 3. 실크 가닥 그리기
      for(float i=0.0; i<5.0; i++){
          // 실 위치 오프셋
          float offset = (hash(i * 12.34) - 0.5) * 0.05 * (1.0 + amp * 3.0);
          
          float targetY = centerY + wave + offset;
          float dist = abs(uv.y - targetY);
          
          // 빛나는 효과
          float glow = 0.0008 / max(dist, 0.0001);
          glow = pow(glow, 1.3);
          
          // 색상 (무지개 순환)
          float hue = fract(uTime * 0.1 + uv.x * 0.3 + i * 0.1);
          vec3 strandColor = 0.5 + 0.5 * cos(6.28 * (hue + vec3(0.0, 0.33, 0.67)));
          
          // [수정됨] 오른쪽 흐림(fade) 제거 -> 끝까지 선명하게
          col += strandColor * glow;
          alphaSum += glow;
      }
      
      finalColor = vec4(col, clamp(alphaSum, 0.0, 1.0));
    }
  `;

  let filter;
  try {
    // [중요] v8 Filter 생성 방식 준수
    const glProgram = new PIXI.GlProgram({
      vertex,
      fragment,
      name: 'silk-wave-shader'
    });

    filter = new PIXI.Filter({
      glProgram,
      resources: {
        uAmpTexture: ampTexture.source,
        uniforms: {
          uTime: { value: 0.0, type: 'f32' }
        }
      }
    });

    screen.filters = [filter];
  } catch (e) {
    showErr("Filter 생성 에러: " + e.message);
  }

  window.addEventListener('resize', () => {
    screen.width = app.renderer.width;
    screen.height = app.renderer.height;
  });

  // -------------------------
  // 5. 루프 & 로직
  // -------------------------
  let currentVol = 0;

  app.ticker.add((ticker) => {
    if (!started) {
      pill.textContent = "Start 버튼을 눌러주세요";
      return;
    }
    if (paused) {
      pill.textContent = "일시정지됨";
      return;
    }
    pill.textContent = "Listening...";

    // 1) 볼륨 측정
    let targetVol = getVolume();
    currentVol += (targetVol - currentVol) * 0.25;

    // 2) 데이터 시프트 (오른쪽으로 밀기)
    historyData.copyWithin(1, 0);

    // 3) 최신 데이터 입력 (증폭 x3.0)
    let val = Math.min(255, currentVol * 255 * 3.0);
    if(val < 5) val = 0;
    historyData[0] = val;

    // 4) 캔버스 업데이트 (Red 채널)
    for(let i=0; i<HISTORY_SIZE; i++){
        const offset = i * 4;
        px[offset] = historyData[i];   // R
        px[offset+1] = 0;
        px[offset+2] = 0;
        px[offset+3] = 255;            // A
    }
    dataCtx.putImageData(imgData, 0, 0);
    
    // 텍스처 업데이트 알림
    ampTexture.source.update();

    // 5) 시간 유니폼
    if (filter) {
      filter.resources.uniforms.uniforms.uTime += ticker.deltaTime * 0.01;
    }
  });

  // -------------------------
  // 6. UI
  // -------------------------
  async function doStart() {
    if (started) return;
    status("마이크 켜는 중...");
    try {
      await startMic();
      started = true;
      ui.style.display = 'none';
      status("Running");
    } catch (e) {
      showErr("권한 에러: " + e.message);
    }
  }

  btnStart.onclick = async () => { await doStart(); };
  window.addEventListener('pointerdown', () => {
    if(started) paused = !paused;
  });

})();
