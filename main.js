(() => {
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

  // -------------------------
  // Canvas overlay (transparent)
  // -------------------------
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
  canvas.style.position = "fixed";
  canvas.style.inset = "0";
  canvas.style.zIndex = "2";
  canvas.style.pointerEvents = "none";
  stage.appendChild(canvas);

  let W = 0, H = 0, DPR = 1;

  function resize() {
    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = Math.floor(window.innerWidth);
    H = Math.floor(window.innerHeight);
    canvas.width = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    // 컬럼 수: 촘촘하지만 성능 고려 (모바일도 고려)
    COLS = Math.max(240, Math.min(900, Math.floor(W * 1.2)));
    ampF = new Float32Array(COLS);
    seeds = new Float32Array(COLS);
    for (let i = 0; i < COLS; i++) seeds[i] = fract(Math.sin((i + 1) * 43758.5453) * 143758.5453);

    // 무지개(상단 빨강 → 하단 보라) 절대 그라데이션
    grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0.00, "rgba(255,  40,  40, 1.00)"); // red
    grad.addColorStop(0.16, "rgba(255, 140,  40, 1.00)"); // orange
    grad.addColorStop(0.33, "rgba(255, 240,  80, 1.00)"); // yellow
    grad.addColorStop(0.50, "rgba( 60, 255, 160, 1.00)"); // green-cyan
    grad.addColorStop(0.66, "rgba( 60, 170, 255, 1.00)"); // blue
    grad.addColorStop(0.82, "rgba(120,  80, 255, 1.00)"); // indigo
    grad.addColorStop(1.00, "rgba(170,  60, 255, 1.00)"); // violet
  }
  window.addEventListener("resize", resize, { passive: true });

  // -------------------------
  // Audio
  // -------------------------
  let audioCtx = null, analyser = null, stream = null, data = null;
  let started = false;
  let paused = false;
  let smVol = 0;

  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const lerp = (a, b, t) => a + (b - a) * t;

  async function startMic() {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    await audioCtx.resume();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    const src = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.55;
    src.connect(analyser);
    data = new Uint8Array(analyser.fftSize);
  }

  function rms() {
    if (!analyser || !data) return 0;
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    return clamp(Math.sqrt(sum / data.length), 0, 1);
  }

  // -------------------------
  // "밀어서 전달" 파동 버퍼
  // -------------------------
  let COLS = 600;
  let ampF = new Float32Array(COLS);
  let seeds = new Float32Array(COLS);
  let grad = null;

  // 튜닝(원하면 여기만 만지면 됨)
  const PUSH  = 0.93;    // 클수록 "밀림" 강함
  const DECAY = 0.986;   // 클수록 잔상 길음
  const RATE  = 220;     // 클수록 전달 빠름

  function propagateAmp(inputAmp01, steps) {
    for (let s = 0; s < steps; s++) {
      for (let i = COLS - 1; i >= 1; i--) {
        ampF[i] = ampF[i] * DECAY + ampF[i - 1] * PUSH;
        if (ampF[i] > 1) ampF[i] = 1;
        if (ampF[i] < 0) ampF[i] = 0;
      }
      ampF[0] = inputAmp01;
    }
  }

  // 무음=거의 안 보임 / 조금만 소리나도 예민하게
  function mapVolToAmp01(v) {
    const SILENT = 0.0022;  // 거의 무음 컷
    const KNEE   = 0.0042;  // 반응 시작

    if (v <= SILENT) return 0.0;

    let x = (v - KNEE) / (1 - KNEE);
    x = clamp(x, 0, 1);

    const gain  = 20.0;
    const gamma = 0.15; // 더 예민

    const y = Math.pow(clamp(x * gain, 0, 1), gamma);
    return clamp(y, 0, 1);
  }

  function fract(x) { return x - Math.floor(x); }

  // -------------------------
  // Render (silk fibers)
  // -------------------------
  function render(dt) {
    ctx.clearRect(0, 0, W, H);

    // 완전 무음이면 "거의 안 보이게" (원하면 0.0으로 바꾸면 완전 숨김)
    // 여기서는 아주 미세하게만 남김:
    const globalFloor = 0.000; // 완전 숨기려면 0.0 유지

    // 중앙선
    const midY = Math.floor(H * 0.54);

    // 컬럼 간격
    const dx = W / (COLS - 1);

    // 라인/섬유 레이어: 기본 + 하이라이트 2패스 (보석 느낌)
    // 1) 본체
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = grad;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // 가늘고 촘촘한 섬유: 성능 위해 lineWidth는 1~1.2 선에서
    ctx.lineWidth = 1.0;
    ctx.globalAlpha = 0.95;

    // 2) 하이라이트 (screen)
    // (두 번째 패스에서 적용)

    // 섬유 개수(컬럼당)
    const STRANDS = 3; // 2~4 (성능/미감)
    const maxBendPx = 10; // 미세 곡률(요동 X)

    // 본체 패스
    for (let i = 0; i < COLS; i++) {
      const a = Math.max(globalFloor, ampF[i]);
      if (a <= 0.0005) continue;

      const x0 = i * dx;

      // 진폭(픽셀): 크게
      const A = a * (H * 0.34); // 0.34가 진폭 크기. 더 키우려면 0.40까지.

      // 곡률은 "정적" + 아주 미세(흐름/요동 없음)
      const sd = seeds[i];
      const bend = (sd - 0.5) * maxBendPx;

      // 컬럼마다 알파를 조금 바꿔서 실크 질감
      const alphaCol = 0.65 + 0.35 * (0.5 + 0.5 * Math.sin((i * 0.12) + sd * 6.28));
      ctx.globalAlpha = 0.78 * alphaCol;

      for (let k = 0; k < STRANDS; k++) {
        const kk = k - (STRANDS - 1) * 0.5;
        const off = kk * 1.8; // 머리카락처럼 가늘게

        // 세로선이지만, 살짝 휘게(3점 polyline)
        const y1 = midY - A;
        const y2 = midY + A;

        // 3점으로 미세 곡률
        const xm = x0 + off + bend;
        const ym = midY;

        ctx.beginPath();
        ctx.moveTo(x0 + off, y1);
        ctx.quadraticCurveTo(xm, ym, x0 + off, y2);
        ctx.stroke();
      }
    }

    // 하이라이트 패스 (보석 같은 "쨍함")
    ctx.globalCompositeOperation = "screen";
    ctx.lineWidth = 0.85;
    ctx.shadowBlur = 10;
    ctx.shadowColor = "rgba(255,255,255,0.70)";

    for (let i = 0; i < COLS; i++) {
      const a = ampF[i];
      if (a <= 0.003) continue;

      const x0 = i * dx;
      const A = a * (H * 0.34);

      const sd = seeds[i];
      const bend = (sd - 0.5) * 8;

      // 큰 진폭일수록 하이라이트 더 강하게
      const hl = clamp((a - 0.02) * 8.0, 0, 1);
      if (hl <= 0) continue;

      ctx.globalAlpha = 0.10 + 0.45 * hl;
      ctx.strokeStyle = "rgba(255,255,255,0.95)";

      // 중앙 근처 가는 하이라이트 1가닥
      ctx.beginPath();
      const y1 = midY - A;
      const y2 = midY + A;
      ctx.moveTo(x0, y1);
      ctx.quadraticCurveTo(x0 + bend, midY, x0, y2);
      ctx.stroke();
    }

    // 상태 텍스트
    if (pill) {
      pill.textContent = paused ? "Paused · tap to resume" : "Running · tap to pause";
    }
  }

  // -------------------------
  // Loop
  // -------------------------
  let last = performance.now();

  function tick() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    if (!started) {
      if (pill) pill.textContent = "Press Start";
      requestAnimationFrame(tick);
      return;
    }

    if (!paused) {
      const v = rms();
      smVol = lerp(smVol, v, 1 - Math.pow(0.001, dt));

      const steps = Math.max(1, Math.floor(dt * RATE));
      const amp01 = mapVolToAmp01(smVol);

      propagateAmp(amp01, steps);
    }

    render(dt);
    requestAnimationFrame(tick);
  }

  // -------------------------
  // Controls
  // -------------------------
  async function doStart() {
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

  if (btnStart) {
    btnStart.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await doStart();
    };
  }

  // 화면 터치(클릭)로 Pause/Resume
  window.addEventListener("pointerdown", () => {
    if (!started) return;
    if (ui && ui.style.display !== "none") return;
    paused = !paused;
  }, { passive: true });

  // init
  resize();
  status("대기 중");
  requestAnimationFrame(tick);
})();
