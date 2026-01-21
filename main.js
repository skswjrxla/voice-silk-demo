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
  // 1. Pixi 초기화 (v8 호환)
  // -------------------------
  if (!window.PIXI) {
    showErr("PIXI 로드 실패: pixi.min.js 확인 필요");
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
    showErr("PIXI 초기화 에러: " + e.message);
    return;
  }

  // 필터를 적용할 전체화면 컨테이너
  const screen = new PIXI.Sprite(PIXI.Texture.EMPTY);
  screen.width = app.renderer.width;
  screen.height = app.renderer.height;
  app.stage.addChild(screen);

  // -------------------------
  // 2. 데이터 텍스처 (Canvas 방식 - 에러 해결의 핵심)
  // -------------------------
  // fromBuffer 대신 캔버스를 중간 다리로 사용합니다.
  const HISTORY_SIZE = 256; 
  const dataCanvas = document.createElement("canvas");
  dataCanvas.width = HISTORY_SIZE;
  dataCanvas.height = 1;
  const dataCtx = dataCanvas.getContext("2d", { willReadFrequently: true });
  
  // 픽셀 데이터 직접 조작용 객체
  const imgData = dataCtx.createImageData(HISTORY_SIZE, 1);
  const px = imgData.data; // [r, g, b, a, ...]

  // 캔버스로부터 텍스처 생성 (v8 호환)
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
        echoCancellation: false, // 생생한 파동
        autoGainControl: false, 
        noiseSuppression: true 
      } 
    });
    
    const src = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024; 
    analyser.smoothingTimeConstant = 0.4;
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
  // 4. 셰이더 (Silk Wave - 가로 파동)
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

    uniform sampler2D uAmpTexture; // 소리 데이터
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
      
      // 1. 소리 데이터 읽기
      // uv.x (0~1)를 사용하여 텍스처에서 과거 데이터를 읽어옴
      // 왼쪽(0)이 최신, 오른쪽(1)이 과거 -> 파동이 오른쪽으로 흘러감
      float amp = texture2D(uAmpTexture, vec2(uv.x, 0.5)).r; 
      
      // 노이즈 게이트: 아주 작은 소리는 0으로 만들어 직선 유지
      if (amp < 0.03) amp = 0.0;
      
      // 2. 파동 변위 계산 (Y축 흔들림)
      // 소리 크기(amp)에 사인파(carrier)를 곱해서 떨림 표현
      float wave = amp * 0.5 * sin(uv.x * 30.0 - uTime * 4.0);
      
      // 화면 중앙
      float centerY = 0.5;

      // 3. 실크 가닥 그리기 (가로선)
      vec3 finalColor = vec3(0.0);
      float alphaSum = 0.0;
      
      // 5가닥의 실을 겹쳐 그림
      for(float i = 0.0; i < 5.0; i++) {
          // 각 실마다 위치를 살짝 다르게 (뭉치 효과)
          float offset = (hash(i * 9.13) - 0.5) * 0.03 * (1.0 + amp * 4.0);
          
          // 현재 픽셀(uv.y)과 실 위치(centerY + wave + offset)의 거리
          float targetY = centerY + wave + offset;
          float dist = abs(uv.y - targetY);
          
          // 두께 및 발광 (Glow)
          float intensity = 0.0007 / max(dist, 0.0001);
          intensity = pow(intensity, 1.4); // 선명하게
          
          // 색상 (무지개 톤)
          float hue = fract(uTime * 0.05 + uv.x * 0.2 + i * 0.15);
          vec3 color = 0.5 + 0.5 * cos(6.28 * (hue + vec3(0.0, 0.33, 0.67)));
          
          // 오른쪽으로 갈수록 자연스럽게 흐려짐
          float fade = smoothstep(1.0, 0.1, uv.x);
          
          finalColor += color * intensity * fade;
          alphaSum += intensity;
      }
      
      // 소리가 없으면 amp=0 -> wave=0 -> 직선 렌더링
      
      gl_FragColor = vec4(finalColor, clamp(alphaSum, 0.0, 1.0));
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
    showErr("Filter 생성 실패: " + e.message);
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
      pill.textContent = "일시정지됨";
      return;
    }
    pill.textContent = "Listening... (터치하여 일시정지)";

    // 1) 볼륨 측정 (Lerp로 부드럽게)
    let targetVol = getVolume();
    currentVol += (targetVol - currentVol) * 0.2;

    // 2) 데이터 배열 이동 (오른쪽으로 밀기: Shift)
    // [0, 1, 2] -> [?, 0, 1]
    historyData.copyWithin(1, 0);

    // 3) 맨 앞(0번)에 최신 볼륨 넣기
    // 시각적 증폭 (x 3.0)
    let val = Math.min(255, currentVol * 255 * 3.0);
    if (val < 5) val = 0; // 노이즈 제거
    
    historyData[0] = val;

    // 4) 캔버스에 데이터 그리기 (R 채널)
    for(let i=0; i<HISTORY_SIZE; i++){
        const offset = i * 4;
        px[offset + 0] = historyData[i]; // R: 데이터
        px[offset + 1] = 0;              // G
        px[offset + 2] = 0;              // B
        px[offset + 3] = 255;            // A
    }
    dataCtx.putImageData(imgData, 0, 0);
    
    // [중요] Pixi에게 텍스처가 변경되었음을 알림 (v8 필수)
    ampTexture.source.update();

    // 5) 시간 업데이트
    if (filter) {
      filter.resources.uniforms.uniforms.uTime += ticker.deltaTime * 0.01;
    }
  });

  // -------------------------
  // UI 핸들링
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
      showErr("마이크 권한 에러: " + e.message);
      status("권한 없음");
    }
  }

  btnStart.onclick = async () => { await doStart(); };
  window.addEventListener('pointerdown', () => {
    if(started) paused = !paused;
  });

})();
