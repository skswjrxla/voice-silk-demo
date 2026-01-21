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
    showErr("PIXI 로드 실패");
    return;
  }

  let app;
  try {
    app = new PIXI.Application();
    await app.init({
      resizeTo: window,
      backgroundAlpha: 0,
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

  // 필터를 적용할 전체화면 컨테이너
  const screen = new PIXI.Sprite(PIXI.Texture.EMPTY);
  screen.width = app.renderer.width;
  screen.height = app.renderer.height;
  app.stage.addChild(screen);

  // -------------------------
  // 2. 오디오 설정
  // -------------------------
  let audioCtx, analyser, dataArray;
  let started = false;
  let paused = false;

  // 히스토리 배열 (파동의 길)
  // 256개 포인트면 충분히 부드럽습니다.
  const HISTORY_SIZE = 256; 
  const historyData = new Uint8Array(HISTORY_SIZE); 

  async function startMic() {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    await audioCtx.resume();
    
    // 에코 캔슬러 등을 끄거나 조절하여 "생소리"에 가깝게 받음
    const stream = await navigator.mediaDevices.getUserMedia({ 
      audio: { 
        echoCancellation: false, 
        autoGainControl: false, 
        noiseSuppression: true 
      } 
    });
    
    const src = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024; 
    analyser.smoothingTimeConstant = 0.5; // 너무 튀지 않게 부드럽게
    src.connect(analyser);
    
    dataArray = new Uint8Array(analyser.fftSize);
  }

  function getVolume() {
    if (!analyser) return 0;
    analyser.getByteTimeDomainData(dataArray);
    
    // RMS(평균 음량) 계산
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const v = (dataArray[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / dataArray.length);
  }

  // -------------------------
  // 3. 텍스처 설정
  // -------------------------
  // JS 배열을 텍스처로 업로드 (Red 채널만 사용)
  const ampTexture = PIXI.Texture.fromBuffer(historyData, HISTORY_SIZE, 1, {
    format: 'red',
    type: 'unsigned_byte',
    scaleMode: 'linear', // 부드러운 곡선을 위해 선형 보간
  });

  // -------------------------
  // 4. 셰이더 (Silk Wave)
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

    uniform sampler2D uAmpTexture;
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
      
      // [핵심] uv.x (화면 가로 위치 0~1)를 그대로 텍스처 좌표로 사용
      // JS에서 데이터를 오른쪽으로 밀어내므로,
      // uv.x = 0 (왼쪽) 은 최신 데이터
      // uv.x = 1 (오른쪽) 은 과거 데이터가 됨 -> 파동이 오른쪽으로 흐름
      float amp = texture2D(uAmpTexture, vec2(uv.x, 0.5)).r;
      
      // 소리가 작을 때 노이즈 제거 (완벽한 직선 만들기)
      if (amp < 0.02) amp = 0.0; 

      // 파동의 중심 Y좌표 (화면 중간)
      float centerY = 0.5;
      
      // 변위 계산 (Displacement)
      // amp(소리 크기)가 클수록 sin파의 폭이 커짐
      // sin 주파수를 uv.x에 비례하게 하여 물결 모양 생성
      float wave = amp * 0.4 * sin(uv.x * 20.0 - uTime * 5.0);
      
      // 여러 가닥의 실 그리기
      vec3 finalColor = vec3(0.0);
      float alphaSum = 0.0;

      // 5개의 실 가닥을 겹쳐서 그림
      for(float i = 0.0; i < 5.0; i++) {
          // 각 실마다 미세한 Y값 오프셋 (실 뭉치 느낌)
          float stringOffset = (hash(i) - 0.5) * 0.05 * (1.0 + amp * 5.0);
          
          // 현재 픽셀이 이 실 가닥 위에 있는지 확인
          // (내 Y위치) - (파동 중심 + 파동 변화량 + 실 가닥 오프셋)
          float dist = abs(uv.y - (centerY + wave + stringOffset));
          
          // 실의 두께 및 빛 번짐 (Glow)
          // 거리가 가까울수록 밝게 (1.0 / dist)
          float intensity = 0.0008 / max(dist, 0.0001);
          
          // 거리에 따라 급격히 어두워지게 해서 얇은 선 유지
          intensity = pow(intensity, 1.5);
          
          // 색상: 파동의 앞부분(왼쪽)일수록 밝게, 뒤로 갈수록 은은하게
          float fade = 1.0 - uv.x * 0.6; 
          
          // 무지개 톤 + 흰색 코어
          vec3 strandColor = 0.5 + 0.5 * cos(uTime + uv.x * 4.0 + vec3(0,2,4));
          
          finalColor += strandColor * intensity * fade;
          alphaSum += intensity;
      }
      
      // 소리가 없으면(amp=0) wave도 0이 되어 직선이 됨.
      
      gl_FragColor = vec4(finalColor, min(alphaSum, 1.0));
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
    showErr("Shader Error: " + e.message);
  }

  // 화면 리사이즈 대응
  window.addEventListener('resize', () => {
    screen.width = app.renderer.width;
    screen.height = app.renderer.height;
  });

  // -------------------------
  // 5. 메인 루프 (데이터 밀어내기)
  // -------------------------
  let currentVol = 0;

  app.ticker.add((ticker) => {
    if (!started) {
      pill.textContent = "Start 버튼을 눌러주세요";
      return;
    }
    if (paused) {
      pill.textContent = "일시정지";
      return;
    } else {
      pill.textContent = "Listening...";
    }

    // 1) 볼륨 측정 및 부드러운 변화 (Lerp)
    let targetVol = getVolume();
    currentVol += (targetVol - currentVol) * 0.2; // 0.2 감도로 따라감

    // 2) [핵심] 배열 데이터 오른쪽으로 밀기 (Shift Right)
    // 배열의 0번부터 (끝-1)번까지를 -> 1번부터 끝까지로 복사
    // 즉, [0, 1, 2] -> [?, 0, 1] 로 이동
    historyData.copyWithin(1, 0);

    // 3) 0번 인덱스(왼쪽 끝)에 최신 볼륨 데이터 넣기
    // 소리를 시각적으로 증폭 (x4.0)
    let val = Math.min(255, currentVol * 255 * 4.0);
    
    // 노이즈 게이트: 너무 작은 소리는 0으로 (직선 유지)
    if (val < 5) val = 0;
    
    historyData[0] = val;

    // 4) 텍스처 업데이트
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
      showErr("마이크 권한 오류: " + e.message);
      status("권한 없음");
    }
  }

  btnStart.onclick = async () => { await doStart(); };
  window.addEventListener('pointerdown', () => {
    if(started) paused = !paused;
  });

})();
