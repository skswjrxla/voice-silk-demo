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
  // 1. Pixi 초기화 (v8 대응)
  // -------------------------
  if (!window.PIXI) {
    showErr("PIXI 로드 실패");
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
    showErr("PIXI Init Error: " + e.message);
    return;
  }

  const screen = new PIXI.Sprite(PIXI.Texture.EMPTY);
  screen.width = app.renderer.width;
  screen.height = app.renderer.height;
  app.stage.addChild(screen);

  // -------------------------
  // 2. 데이터 텍스처 (Canvas 방식 - 호환성 해결)
  // -------------------------
  // 오류가 났던 fromBuffer 대신, 1xN 캔버스를 만들어 텍스처로 씁니다.
  const HISTORY_SIZE = 256; 
  const dataCanvas = document.createElement("canvas");
  dataCanvas.width = HISTORY_SIZE;
  dataCanvas.height = 1;
  const dataCtx = dataCanvas.getContext("2d", { willReadFrequently: true });
  
  // 픽셀 데이터 직접 조작을 위한 이미지 데이터
  const imgData = dataCtx.createImageData(HISTORY_SIZE, 1);
  const px = imgData.data; // [r, g, b, a, r, g, b, a, ...]

  // 초기화 (투명)
  for(let i=0; i<px.length; i++) px[i] = 0;
  dataCtx.putImageData(imgData, 0, 0);

  // 캔버스로부터 텍스처 생성
  const ampTexture = PIXI.Texture.from(dataCanvas);

  // -------------------------
  // 3. 오디오 설정
  // -------------------------
  let audioCtx, analyser, dataArray;
  let started = false;
  let paused = false;
  
  // 파동 데이터를 저장할 JS 배열 (값: 0 ~ 255)
  const historyData = new Uint8Array(HISTORY_SIZE);

  async function startMic() {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    await audioCtx.resume();
    
    const stream = await navigator.mediaDevices.getUserMedia({ 
      audio: { 
        echoCancellation: false, // 생생한 파동을 위해 false
        autoGainControl: false, 
        noiseSuppression: true 
      } 
    });
    
    const src = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024; 
    analyser.smoothingTimeConstant = 0.3; // 반응 속도
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
  // 4. 셰이더 (가로형 실크 파동)
  // -------------------------
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

  const fragment = `
    precision highp float;
    in vec2 vTextureCoord;

    uniform sampler2D uAmpTexture; // 소리 데이터 (1 x 256)
    uniform float uTime;

    // 랜덤 노이즈
    float hash(float p) {
      p = fract(p * .1031);
      p *= p + 33.33;
      p *= p + p;
      return fract(p);
    }

    void main() {
      vec2 uv = vTextureCoord;
      
      // [수정됨] 바코드가 아닌 '가로선'을 그리기 위해 로직 변경
      
      // 1. 소리 데이터 읽기 (uv.x 위치에 해당하는 과거 시점의 볼륨)
      // uv.x가 0(왼쪽)이면 최신 데이터, 1(오른쪽)이면 과거 데이터 -> 파동이 오른쪽으로 진행
      float amp = texture2D(uAmpTexture, vec2(uv.x, 0.5)).r; // Red 채널 값 (0~1)
      
      // 노이즈 게이트 (작은 소리 무시 -> 직선 유지)
      if (amp < 0.05) amp = 0.0;
      
      // 2. 파동 변위 (Y축으로 흔들림)
      // 사인파 Carrier에 소리 크기(Envelope)를 곱함
      float wave = amp * 0.45 * sin(uv.x * 25.0 - uTime * 3.0);
      
      // 화면 중앙
      float centerY = 0.5;

      // 3. 가로 실크 가닥 그리기
      vec3 finalColor = vec3(0.0);
      float alphaSum = 0.0;
      
      // 5가닥의 가로 실을 겹쳐서 그림
      for(float i = 0.0; i < 5.0; i++) {
          // 가닥마다 미세하게 Y 위치 다르게 (실 뭉치)
          float strandOffset = (hash(i * 12.3) - 0.5) * 0.04 * (1.0 + amp * 3.0);
          
          // 현재 픽셀(uv.y)이 이 실 가닥(centerY + wave + offset)과 얼마나 가까운지
          // [중요] uv.x가 아니라 uv.y와의 거리를 계산해야 가로선이 됨
          float targetY = centerY + wave + strandOffset;
          float dist = abs(uv.y - targetY);
          
          // 두께 및 글로우
          // 거리가 가까울수록 밝음
          float glow = 0.0006 / max(dist, 0.0001);
          glow = pow(glow, 1.3); // 선명하게
          
          // 색상: 무지개 (시간과 x위치에 따라 변함)
          float hue = fract(uTime * 0.05 + uv.x * 0.3 + i * 0.1);
          vec3 color = 0.5 + 0.5 * cos(6.28318 * (hue + vec3(0.0, 0.33, 0.67)));
          
          // 앞쪽(왼쪽)은 밝고 뒤로 갈수록 사라지게 (Trailing effect)
          float fade = smoothstep(1.0, 0.2, uv.x); 
          
          finalColor += color * glow * fade;
          alphaSum += glow;
      }

      // 소리가 없으면 amp=0, wave=0 이 되어 일자 직선이 됨.
      
      // 과다 노출 방지 및 투명도 처리
      gl_FragColor = vec4(finalColor, clamp(alphaSum * 0.8, 0.0, 1.0));
    }
  `;

  let filter;
  try {
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
    showErr("Filter Error: " + e.message);
  }

  // 리사이즈
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
      pill.textContent = "Paused";
      return;
    }
    pill.textContent = "Listening...";

    // 1) 볼륨 측정 (Lerp로 부드럽게)
    let targetVol = getVolume();
    currentVol += (targetVol - currentVol) * 0.25;

    // 2) 데이터 시프트 (오른쪽으로 밀기)
    // [0, 1, 2] -> [?, 0, 1]
    historyData.copyWithin(1, 0);

    // 3) 최신 데이터 넣기 (왼쪽 끝)
    // 시각화를 위해 값 증폭 (x 3.5)
    let val = Math.min(255, currentVol * 255 * 3.5);
    // 아주 작은 값은 0 처리 (직선 유지)
    if (val < 5) val = 0;
    
    historyData[0] = val;

    // 4) 캔버스/텍스처 업데이트
    // 배열 데이터를 이미지 데이터(R채널)로 복사
    for(let i=0; i<HISTORY_SIZE; i++){
        // R 채널에 값 넣기 (px 구조: R, G, B, A)
        px[i*4 + 0] = historyData[i]; 
        px[i*4 + 1] = 0;
        px[i*4 + 2] = 0;
        px[i*4 + 3] = 255; // Alpha 100%
    }
    dataCtx.putImageData(imgData, 0, 0);
    
    // v8 방식: 소스 업데이트 알림
    ampTexture.source.update();

    // 5) 시간 전송
    if (filter) {
      filter.resources.uniforms.uniforms.uTime += ticker.deltaTime * 0.01;
    }
  });

  // -------------------------
  // UI
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
      showErr("마이크 권한 오류: " + e.message);
      status("권한 없음");
    }
  }

  btnStart.onclick = async () => { await doStart(); };
  window.addEventListener('pointerdown', () => {
    if(started) paused = !paused;
  });

})();
