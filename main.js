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
  // Pixi Initial Setup
  // -------------------------
  if (!window.PIXI) {
    showErr("PIXI 로드 실패: pixi.min.js가 로딩되지 않았습니다.");
    return;
  }

  let app;
  try {
    app = new PIXI.Application();
    await app.init({
      resizeTo: window,
      backgroundAlpha: 0, // 배경 투명 (CSS 배경이 보이도록)
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

  // 전체 화면 필터 적용을 위한 투명 Sprite
  const screen = new PIXI.Sprite(PIXI.Texture.EMPTY);
  screen.width = app.renderer.width;
  screen.height = app.renderer.height;
  app.stage.addChild(screen);

  // -------------------------
  // Audio Setup (Ring Buffer Logic)
  // -------------------------
  let audioCtx, analyser, dataArray;
  let started = false;
  let paused = false;

  // 히스토리 버퍼 설정 (파동이 지나가는 길)
  // 해상도를 높여 부드러운 곡선 표현
  const HISTORY_SIZE = 512; 
  const historyData = new Uint8Array(HISTORY_SIZE); 
  let historyHead = 0; // 현재 기록할 위치 (Circular Buffer Head)

  async function startMic() {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    await audioCtx.resume();
    
    const stream = await navigator.mediaDevices.getUserMedia({ 
      audio: { 
        echoCancellation: true, 
        autoGainControl: false, // 파동의 다이내믹함을 위해 끔
        noiseSuppression: true 
      } 
    });
    
    const src = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.1; // 반응 속도 빠르게
    src.connect(analyser);
    
    dataArray = new Uint8Array(analyser.fftSize);
  }

  function getVolume() {
    if (!analyser) return 0;
    analyser.getByteTimeDomainData(dataArray);
    
    let sum = 0;
    // RMS 계산
    for (let i = 0; i < dataArray.length; i++) {
      const v = (dataArray[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / dataArray.length); // 0.0 ~ 1.0
  }

  // -------------------------
  // Data Texture for Shader
  // -------------------------
  // JS 배열(historyData)을 텍스처로 업로드하여 쉐이더에서 읽음
  const ampTexture = PIXI.Texture.fromBuffer(historyData, HISTORY_SIZE, 1, {
    format: 'red', // 1채널(Red)만 사용
    type: 'unsigned_byte',
    scaleMode: 'linear', // 부드러운 보간
  });

  // -------------------------
  // Silk Shader
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
      
      // 화면 좌표 그대로 전달 (변형 없음)
      vTextureCoord = aPosition * (uOutputFrame.zw / uOutputTexture.xy);
    }
  `;

  const fragment = `
    precision highp float;
    in vec2 vTextureCoord;

    uniform sampler2D uAmpTexture; // 오디오 데이터 (히스토리)
    uniform float uHead;           // 현재 데이터의 시작점 (0.0 ~ 1.0)
    uniform float uTime;
    uniform vec2 uRes;

    // 랜덤/노이즈 함수 (고정된 패턴용)
    float hash(float p) {
      p = fract(p * .1031);
      p *= p + 33.33;
      p *= p + p;
      return fract(p);
    }

    float noise(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }

    // 색상 변환 함수
    vec3 hsv2rgb(vec3 c) {
      vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
      vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
      return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
    }

    void main() {
      vec2 uv = vTextureCoord;

      // 1. 파동 데이터 읽기 (핵심 로직)
      // 화면의 오른쪽(uv.x=1)이 과거, 왼쪽(uv.x=0)이 현재가 되도록 계산
      // 혹은 왼쪽에서 발생해서 오른쪽으로 진행하려면:
      // uv.x가 0일 때 uHead(현재), uv.x가 커질수록 과거 데이터를 읽어야 함.
      
      // Ring Buffer 조회 로직:
      // (Head - uv.x)를 통해 현재 시점(Head)에서 uv.x만큼 과거로 거슬러 올라감
      // fract()로 0.0~1.0 순환 처리
      float dataPos = fract(uHead - uv.x);
      
      // 텍스처에서 진폭 값 읽기
      float amp = texture2D(uAmpTexture, vec2(dataPos, 0.5)).r;
      
      // 노이즈 제거 (매우 작은 값 무시)
      float cleanAmp = smoothstep(0.01, 0.2, amp) * amp;

      // 2. 실크 섬유 표현
      // 화면은 가만히 있고(uv.x, uv.y 고정), 
      // y좌표가 파동(amp)에 의해 '밀리는' 효과
      
      // 파동의 중심선 (화면 중앙)
      float centerY = 0.5;
      
      // 변위(Displacement): 소리 크기에 따라 Y축으로 밀림
      // cleanAmp 값에 따라 위아래로 진동 (사인파 변조 추가)
      float wave = (cleanAmp * 0.4) * sin(uv.x * 10.0 - uTime * 2.0); 
      
      // 하지만 사용자는 "파동 형태"를 원하므로, amp 자체가 변위가 되어야 함.
      // amp는 0~1 양수이므로, -1~1로 변환하여 위아래 흔들림 표현 필요
      // 여기서는 오디오 데이터 자체가 파형(Time Domain)이 아니라 RMS(Volume)이므로,
      // 인위적인 사인파(Carrier)에 볼륨(Envelope)을 곱해줍니다.
      
      float carrier = sin(uv.x * 20.0 + uTime * 5.0); // 빠르게 진동하는 기본 파동
      float displacement = carrier * cleanAmp * 0.4;  // 볼륨만큼 진폭 커짐

      // 현재 픽셀의 Y위치와 파동 중심과의 거리
      float dist = abs(uv.y - (centerY + displacement));

      // 3. 섬유 질감 그리기 (Strands)
      // 가로로 촘촘한 선들을 그림.
      // 선의 위치는 displacement에 의해 같이 움직임.
      
      float strands = 0.0;
      
      // 3개의 레이어로 깊이감 표현
      for(float i=1.0; i<=3.0; i++){
          // 각 레이어마다 미세하게 다른 주파수의 노이즈 (섬유 결)
          // uv.y에 displacement를 더하지 않고, 거리(dist) 기반으로 패턴 생성
          // 이렇게 해야 "섬유 자체가 움직이는" 느낌이 남
          
          float grain = noise(vec2(uv.y * 800.0 * i, i)); // 세로로 매우 촘촘한 노이즈
          
          // 파동 중심부에 가까울수록 섬유가 밝게 빛남
          float thickness = 0.002 + (cleanAmp * 0.02); // 소리가 크면 실이 두꺼워짐(빛 번짐)
          float glow = 0.001 / abs(dist - (grain * 0.02)); // 글로우 효과
          
          strands += glow * (0.8 / i);
      }

      // 4. 무지개 색상
      // 파동의 진행 방향(uv.x)과 진폭(cleanAmp)에 따라 색상 변화
      float hue = fract(uTime * 0.1 + uv.x * 0.5 + cleanAmp);
      vec3 color = hsv2rgb(vec3(hue, 0.7, 1.0));

      // 5. 최종 합성
      // 섬유 강도(strands)에 색상을 곱함
      vec3 finalColor = color * strands * 2.0;
      
      // 배경은 투명하게 처리 (알파 블렌딩)
      float alpha = smoothstep(0.0, 1.0, strands);
      
      gl_FragColor = vec4(finalColor, alpha);
    }
  `;

  let filter;
  try {
    filter = new PIXI.Filter({
      glProgram: new PIXI.GlProgram({ vertex, fragment }),
      resources: {
        uAmpTexture: ampTexture.source,
        uniforms: {
          uHead: { value: 0.0, type: 'f32' },
          uTime: { value: 0.0, type: 'f32' },
          uRes:  { value: [app.renderer.width, app.renderer.height], type: 'vec2<f32>' }
        }
      }
    });
    screen.filters = [filter];
  } catch (e) {
    showErr("필터 생성 오류: " + e.message);
  }

  // 리사이즈 처리
  window.addEventListener('resize', () => {
    screen.width = app.renderer.width;
    screen.height = app.renderer.height;
    if(filter) filter.resources.uniforms.uniforms.uRes = [app.renderer.width, app.renderer.height];
  });

  // -------------------------
  // Main Loop
  // -------------------------
  let volume = 0;

  app.ticker.add((ticker) => {
    if (!started) {
      pill.textContent = "Start 버튼을 눌러주세요";
      return;
    }

    if (paused) {
      pill.textContent = "일시정지됨";
      return;
    } else {
      pill.textContent = "듣는 중... (화면 터치로 일시정지)";
    }

    // 1. 오디오 볼륨 얻기
    let targetVol = getVolume();
    // 부드러운 움직임을 위해 보간 (Lerp)
    volume += (targetVol - volume) * 0.2;

    // 2. 히스토리 버퍼 업데이트 (Ring Buffer)
    // 현재 volume 값을 0~255로 변환하여 저장
    // historyHead 위치에 저장하고 Head를 이동시킴 -> 파동이 옆으로 가는 효과
    historyData[historyHead] = Math.min(255, volume * 800); // 감도 조절 (작은 소리도 잘 보이게 증폭)
    
    // 텍스처 업데이트
    ampTexture.source.update();

    // Head 이동 (왼쪽 -> 오른쪽 순환)
    // 셰이더에서는 이 Head를 기준으로 과거 데이터를 읽어옴
    historyHead = (historyHead + 1) % HISTORY_SIZE;

    // 3. 셰이더 유니폼 업데이트
    if (filter) {
      const uniforms = filter.resources.uniforms.uniforms;
      uniforms.uHead = historyHead / HISTORY_SIZE; // 0.0 ~ 1.0 정규화
      uniforms.uTime += ticker.deltaTime * 0.01;
    }
  });

  // -------------------------
  // UI Interactions
  // -------------------------
  async function doStart() {
    if (started) return;
    status("마이크 연결 중...");
    try {
      await startMic();
      started = true;
      ui.style.display = 'none';
    } catch (e) {
      showErr("마이크 권한 오류: " + e.message);
      status("권한 거부됨");
    }
  }

  btnStart.onclick = async () => {
    await doStart();
  };

  window.addEventListener('pointerdown', () => {
    if (started) paused = !paused;
  });

})();
