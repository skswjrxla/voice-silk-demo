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
  // 1. Pixi 초기화
  // -------------------------
  if (!window.PIXI) {
    showErr("PIXI 로드 실패: 인터넷 연결 또는 CDN 확인 필요");
    return;
  }

  let app;
  try {
    app = new PIXI.Application();
    await app.init({
      resizeTo: window,
      backgroundAlpha: 0, // 배경 투명 (CSS 배경 보임)
      antialias: true,
      autoDensity: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      powerPreference: "high-performance",
    });
    stage.appendChild(app.canvas);
  } catch (e) {
    showErr("PIXI 초기화 에러: " + e.message);
    return;
  }

  // 전체 화면 필터용 컨테이너
  const screen = new PIXI.Sprite(PIXI.Texture.EMPTY);
  screen.width = app.renderer.width;
  screen.height = app.renderer.height;
  app.stage.addChild(screen);

  // -------------------------
  // 2. 데이터 텍스처 (Canvas 방식 - 에러 원천 차단)
  // -------------------------
  // 파동의 과거 기록을 저장할 배열 크기
  const HISTORY_SIZE = 256; 
  
  // 데이터 조작용 1픽셀 높이 캔버스
  const dataCanvas = document.createElement("canvas");
  dataCanvas.width = HISTORY_SIZE;
  dataCanvas.height = 1;
  const dataCtx = dataCanvas.getContext("2d", { willReadFrequently: true });
  const imgData = dataCtx.createImageData(HISTORY_SIZE, 1);
  const px = imgData.data;

  // 캔버스를 텍스처로 변환 (v8 호환)
  const ampTexture = PIXI.Texture.from(dataCanvas);
  
  // 텍스처 필터링 설정 (부드러운 파동을 위해 Linear)
  ampTexture.source.scaleMode = 'linear';

  // -------------------------
  // 3. 오디오 설정
  // -------------------------
  let audioCtx, analyser, dataArray;
  let started = false;
  let paused = false;
  
  // 실제 파동 데이터를 담을 배열
  const historyData = new Uint8Array(HISTORY_SIZE);

  async function startMic() {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    await audioCtx.resume();
    
    const stream = await navigator.mediaDevices.getUserMedia({ 
      audio: { 
        echoCancellation: false, // 생동감 있는 파동
        autoGainControl: false, 
        noiseSuppression: true 
      } 
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
    
    // RMS 계산
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const v = (dataArray[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / dataArray.length);
  }

  // -------------------------
  // 4. 셰이더 (WebGL 2 호환)
  // -------------------------
  
  // Vertex Shader: 기본 설정
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

  // Fragment Shader: WebGL 2 문법 적용 (gl_FragColor 제거, texture 사용)
  const fragment = `
    precision highp float;
    
    in vec2 vTextureCoord;
    out vec4 finalColor; // WebGL 2 출력 변수

    uniform sampler2D uAmpTexture;
    uniform float uTime;

    // 랜덤 함수
    float hash(float p) {
      p = fract(p * .1031);
      p *= p + 33.33;
      p *= p + p;
      return fract(p);
    }

    void main() {
      vec2 uv = vTextureCoord;
      
      // 1. 텍스처에서 파동 높이 읽기
      // uv.x: 0(왼쪽, 최신) ~ 1(오른쪽, 과거)
      // texture2D 대신 texture 사용 (WebGL 2)
      float amp = texture(uAmpTexture, vec2(uv.x, 0.5)).r;
      
      // 작은 노이즈 제거 (완벽한 직선 유지)
      if(amp < 0.02) amp = 0.0;

      // 2. 파동의 모양 만들기 (Displacement)
      // 왼쪽에서 오른쪽으로 진행하는 사인파 + 볼륨(amp) 적용
      float wave = amp * 0.4 * sin(uv.x * 20.0 - uTime * 5.0);
      
      // 화면 중앙 기준
      float centerY = 0.5;
      
      // 3. 실크 가닥 그리기
      vec3 col = vec3(0.0);
      float alphaSum = 0.0;
      
      // 5가닥의 실을 겹쳐서 표현
      for(float i=0.0; i<5.0; i++){
          // 실마다 위치 미세 조정 (자연스러움)
          float offset = (hash(i * 12.34) - 0.5) * 0.05 * (1.0 + amp * 3.0);
          
          // 현재 픽셀(uv.y)과 실의 위치 거리 계산
          float targetY = centerY + wave + offset;
          float dist = abs(uv.y - targetY);
          
          // 빛나는 효과 (거리가 가까울수록 밝게)
          float glow = 0.0008 / max(dist, 0.0001);
          glow = pow(glow, 1.3); 
          
          // 색상: 무지개 톤으로 순환
          float hue = fract(uTime * 0.1 + uv.x * 0.3 + i * 0.1);
          vec3 strandColor = 0.5 + 0.5 * cos(6.28 * (hue + vec3(0.0, 0.33, 0.67)));
          
          // 오른쪽으로 갈수록 흐려지게 (꼬리 효과)
          float fade = smoothstep(1.0, 0.1, uv.x);
          
          col += strandColor * glow * fade;
          alphaSum += glow;
      }
      
      // 결과 출력
      finalColor = vec4(col, clamp(alphaSum, 0.0, 1.0));
    }
  `;

  let filter;
  try {
    // WebGL 2 셰이더 프로그램 생성
    filter = new PIXI.Filter({
      glProgram: new PIXI.GlProgram({ vertex, fragment }),
      resources: {
        uAmpTexture: ampTexture.source,
        uniforms: {
          uTime: { value: 0.0, type: 'f32' }
        }
      }
    });
    screen.filters = [filter];
  } catch (e) {
    showErr("필터 생성 실패: " + e.message);
  }

  window.addEventListener('resize', () => {
    screen.width = app.renderer.width;
    screen.height = app.renderer.height;
  });

  // -------------------------
  // 5. 애니메이션 루프
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
    currentVol += (targetVol - currentVol) * 0.25; // 부드럽게

    // 2) 데이터 이동 (오른쪽으로 밀기)
    // 배열의 내용을 한 칸씩 뒤로 미룸: [0, 1, 2] -> [?, 0, 1]
    historyData.copyWithin(1, 0);

    // 3) 맨 앞(0번)에 최신 볼륨 기록
    // 시각적 증폭 (x 3.0)
    let val = Math.min(255, currentVol * 255 * 3.0);
    if(val < 5) val = 0; // 노이즈 게이트
    historyData[0] = val;

    // 4) 캔버스에 데이터 그리기 (Red 채널에 저장)
    for(let i=0; i<HISTORY_SIZE; i++){
        const offset = i * 4;
        px[offset] = historyData[i];     // R
        px[offset + 1] = 0;              // G
        px[offset + 2] = 0;              // B
        px[offset + 3] = 255;            // A
    }
    dataCtx.putImageData(imgData, 0, 0);
    
    // 텍스처 업데이트 알림 (필수)
    ampTexture.source.update();

    // 5) 시간값 전송
    if (filter) {
      filter.resources.uniforms.uniforms.uTime += ticker.deltaTime * 0.01;
    }
  });

  // -------------------------
  // UI 핸들링
  // -------------------------
  async function doStart() {
    if (started) return;
    status("마이크 연결 중...");
    try {
      await startMic();
      started = true;
      ui.style.display = 'none';
      status("Running");
    } catch (e) {
      showErr("마이크 권한 거부됨: " + e.message);
      status("권한 없음");
    }
  }

  btnStart.onclick = async () => { await doStart(); };
  window.addEventListener('pointerdown', () => {
    if(started) paused = !paused;
  });

})();
