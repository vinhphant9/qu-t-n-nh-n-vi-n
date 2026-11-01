'use strict';

(() => {
  const STORAGE_KEY = 'order-code-scanner-session-v1';
  const DUPLICATE_FRAME_GUARD_MS = 2200;

  const $ = (id) => document.getElementById(id);
  const els = {
    scanView: $('scanView'),
    resultView: $('resultView'),
    reader: $('reader'),
    cameraPlaceholder: $('cameraPlaceholder'),
    cameraSelect: $('cameraSelect'),
    startCameraBtn: $('startCameraBtn'),
    stopCameraBtn: $('stopCameraBtn'),
    sessionStatus: $('sessionStatus'),
    feedback: $('feedback'),
    manualCode: $('manualCode'),
    addManualBtn: $('addManualBtn'),
    successCount: $('successCount'),
    duplicateCount: $('duplicateCount'),
    totalAttempts: $('totalAttempts'),
    listCount: $('listCount'),
    scanList: $('scanList'),
    finishBtn: $('finishBtn'),
    resetBtn: $('resetBtn'),
    resultSummary: $('resultSummary'),
    resultCount: $('resultCount'),
    resultText: $('resultText'),
    copyBtn: $('copyBtn'),
    copyFeedback: $('copyFeedback'),
    backBtn: $('backBtn'),
    newSessionBtn: $('newSessionBtn')
  };

  let scanner = null;
  let cameraRunning = false;
  let isCompleted = false;
  let codes = [];
  let seenCodes = new Set();
  let duplicateHits = 0;
  let totalHits = 0;
  let lastFrameCode = '';
  let lastFrameAt = 0;
  let audioContext = null;
  let cameras = [];

  const FORMAT_ENUM = window.Html5QrcodeSupportedFormats;
  const FORMATS = FORMAT_ENUM ? [
    FORMAT_ENUM.QR_CODE,
    FORMAT_ENUM.CODE_128,
    FORMAT_ENUM.CODE_39,
    FORMAT_ENUM.CODE_93,
    FORMAT_ENUM.CODABAR,
    FORMAT_ENUM.EAN_13,
    FORMAT_ENUM.EAN_8,
    FORMAT_ENUM.ITF,
    FORMAT_ENUM.UPC_A,
    FORMAT_ENUM.UPC_E,
    FORMAT_ENUM.DATA_MATRIX,
    FORMAT_ENUM.PDF_417,
    FORMAT_ENUM.AZTEC
  ].filter((format) => typeof format === 'number') : [];

  function loadSession() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!saved || !Array.isArray(saved.codes)) return;
      codes = [...new Set(saved.codes.filter((value) => typeof value === 'string' && value.trim()))];
      seenCodes = new Set(codes);
      duplicateHits = Number.isInteger(saved.duplicateHits) ? saved.duplicateHits : 0;
      totalHits = Number.isInteger(saved.totalHits) ? saved.totalHits : codes.length + duplicateHits;
    } catch (error) {
      console.warn('Không thể đọc dữ liệu phiên đã lưu:', error);
    }
    renderStatsAndList();
  }

  function saveSession() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        codes,
        duplicateHits,
        totalHits,
        savedAt: new Date().toISOString()
      }));
    } catch (error) {
      showFeedback('Không lưu được vào bộ nhớ trình duyệt. Hãy kiểm tra dung lượng hoặc quyền lưu trữ.', 'error');
      console.warn('Không thể lưu phiên:', error);
    }
  }

  function showFeedback(message, kind = 'neutral') {
    els.feedback.textContent = message;
    els.feedback.className = `feedback feedback-${kind}`;
  }

  function setSessionStatus(message, kind) {
    els.sessionStatus.textContent = message;
    els.sessionStatus.className = `status-pill status-${kind}`;
  }

  function renderStatsAndList() {
    els.successCount.textContent = String(codes.length);
    els.duplicateCount.textContent = String(duplicateHits);
    els.totalAttempts.textContent = String(totalHits);
    els.listCount.textContent = `${codes.length} mã`;
    els.finishBtn.disabled = codes.length === 0 || isCompleted;

    if (codes.length === 0) {
      els.scanList.className = 'scan-list empty-state';
      els.scanList.textContent = 'Chưa có mã nào.';
      return;
    }

    els.scanList.className = 'scan-list';
    const fragment = document.createDocumentFragment();
    codes.forEach((code, index) => {
      const row = document.createElement('div');
      row.className = 'scan-item';
      const number = document.createElement('span');
      number.className = 'scan-index';
      number.textContent = `${index + 1}.`;
      const value = document.createElement('span');
      value.className = 'scan-value';
      value.textContent = code;
      row.append(number, value);
      fragment.appendChild(row);
    });
    els.scanList.replaceChildren(fragment);
  }

  function prepareAudio() {
    // Khởi tạo âm thanh ngay trong thao tác bấm nút để trình duyệt cho phép phát tiếng báo sau đó.
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      audioContext = audioContext || new AudioContextClass();
      if (audioContext.state === 'suspended') void audioContext.resume();
    } catch (error) {
      console.debug('Âm thanh không khả dụng:', error);
    }
  }

  function playTone(kind) {
    try {
      prepareAudio();
      if (!audioContext) return;
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.type = 'sine';
      oscillator.frequency.value = kind === 'success' ? 880 : 230;
      gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.16, audioContext.currentTime + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + (kind === 'success' ? 0.16 : 0.32));
      oscillator.start();
      oscillator.stop(audioContext.currentTime + (kind === 'success' ? 0.17 : 0.33));
    } catch (error) {
      console.debug('Âm thanh không khả dụng:', error);
    }
    if ('vibrate' in navigator) navigator.vibrate(kind === 'success' ? 70 : [100, 55, 100]);
  }

  function receiveCode(rawValue, source = 'camera') {
    if (isCompleted) return;
    const code = String(rawValue ?? '').trim();
    if (!code) return;

    // Camera có thể đọc cùng một mã ở nhiều khung hình liên tiếp.
    // Bỏ qua các lần lặp tức thời để một mã đang nằm trước camera không bị báo trùng liên tục.
    const now = Date.now();
    if (source === 'camera' && code === lastFrameCode && now - lastFrameAt < DUPLICATE_FRAME_GUARD_MS) return;
    lastFrameCode = code;
    lastFrameAt = now;

    totalHits += 1;
    if (seenCodes.has(code)) {
      duplicateHits += 1;
      showFeedback(`⚠ MÃ ĐÃ TỒN TẠI: ${code}`, 'duplicate');
      playTone('duplicate');
    } else {
      seenCodes.add(code);
      codes.push(code);
      showFeedback(`✓ QUÉT THÀNH CÔNG: ${code}`, 'success');
      playTone('success');
    }

    saveSession();
    renderStatsAndList();
  }

  async function populateCameras() {
    if (!window.Html5Qrcode) throw new Error('Thư viện quét mã chưa tải xong. Kiểm tra kết nối Internet rồi tải lại trang.');
    cameras = await Html5Qrcode.getCameras();
    const previous = els.cameraSelect.value;
    els.cameraSelect.replaceChildren();
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'Camera mặc định';
    els.cameraSelect.appendChild(defaultOption);
    cameras.forEach((camera, index) => {
      const option = document.createElement('option');
      option.value = camera.id;
      option.textContent = camera.label || `Camera ${index + 1}`;
      els.cameraSelect.appendChild(option);
    });
    if (previous && cameras.some((camera) => camera.id === previous)) els.cameraSelect.value = previous;
    else {
      const rearCamera = cameras.find((camera) => /back|rear|environment|sau/i.test(camera.label || ''));
      if (rearCamera) els.cameraSelect.value = rearCamera.id;
    }
    if (cameras.length === 0) throw new Error('Không tìm thấy camera. Hãy cấp quyền camera cho trình duyệt.');
  }

  async function startCamera() {
    if (isCompleted || cameraRunning) return;
    els.startCameraBtn.disabled = true;
    showFeedback('Đang khởi động camera…', 'neutral');
    try {
      prepareAudio();
      if (!window.Html5Qrcode || !window.Html5QrcodeSupportedFormats) throw new Error('Thư viện quét mã chưa tải xong. Hãy kiểm tra Internet và tải lại trang.');
      if (!cameras.length) await populateCameras();
      if (!scanner) scanner = new Html5Qrcode('reader', { formatsToSupport: FORMATS, verbose: false });

      const selectedCamera = els.cameraSelect.value;
      const cameraConfig = selectedCamera
        ? { deviceId: { exact: selectedCamera } }
        : { facingMode: 'environment' };

      await scanner.start(
        cameraConfig,
        {
          fps: 12,
          qrbox: (viewfinderWidth, viewfinderHeight) => {
            const width = Math.floor(Math.min(viewfinderWidth * 0.88, 440));
            const height = Math.floor(Math.min(viewfinderHeight * 0.48, 210));
            return { width: Math.max(width, 180), height: Math.max(height, 120) };
          },
          aspectRatio: 1.333,
          disableFlip: false
        },
        (decodedText) => receiveCode(decodedText, 'camera'),
        () => { /* Bỏ qua lỗi đọc ở từng khung hình; đây là trạng thái bình thường. */ }
      );

      cameraRunning = true;
      els.cameraPlaceholder.hidden = true;
      els.startCameraBtn.disabled = true;
      els.stopCameraBtn.disabled = false;
      els.cameraSelect.disabled = true;
      setSessionStatus('Camera đang hoạt động', 'active');
      showFeedback('Đang quét. Mã mới sẽ được thêm vào danh sách.', 'neutral');
    } catch (error) {
      console.error(error);
      showFeedback(error.message || 'Không thể bật camera.', 'error');
      setSessionStatus('Camera chưa bật', 'ready');
      els.startCameraBtn.disabled = false;
    }
  }

  async function stopCamera() {
    if (!scanner || !cameraRunning) {
      cameraRunning = false;
      els.cameraPlaceholder.hidden = false;
      els.startCameraBtn.disabled = isCompleted;
      els.stopCameraBtn.disabled = true;
      els.cameraSelect.disabled = false;
      return;
    }
    try {
      await scanner.stop();
    } catch (error) {
      console.warn('Lỗi khi tắt camera:', error);
    }
    cameraRunning = false;
    els.cameraPlaceholder.hidden = false;
    els.startCameraBtn.disabled = isCompleted;
    els.stopCameraBtn.disabled = true;
    els.cameraSelect.disabled = false;
    setSessionStatus(isCompleted ? 'Đã hoàn thành' : 'Đã tắt camera', isCompleted ? 'stopped' : 'ready');
  }

  async function finishSession() {
    if (codes.length === 0 || isCompleted) return;
    isCompleted = true;
    await stopCamera();
    els.scanView.hidden = true;
    els.resultView.hidden = false;
    els.resultSummary.textContent = `Đã ghi nhận ${codes.length} mã hợp lệ và phát hiện ${duplicateHits} lượt quét trùng.`;
    els.resultCount.textContent = `${codes.length} mã`;
    els.resultText.value = codes.join('\n');
    els.copyFeedback.textContent = '';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function copyResults() {
    const text = codes.join('\n');
    if (!text) return;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        els.resultText.focus();
        els.resultText.select();
        const copied = document.execCommand('copy');
        if (!copied) throw new Error('Trình duyệt không cho phép sao chép tự động.');
      }
      els.copyFeedback.textContent = '✓ Đã copy danh sách mã. Bạn có thể dán vào Excel.';
    } catch (error) {
      els.resultText.focus();
      els.resultText.select();
      els.copyFeedback.textContent = 'Đã chọn toàn bộ danh sách. Nhấn Ctrl+C hoặc Chạm giữ → Sao chép.';
    }
  }

  function resetSession() {
    if (!window.confirm('Xóa toàn bộ mã và số liệu của phiên hiện tại? Thao tác này không thể hoàn tác.')) return;
    void stopCamera();
    codes = [];
    seenCodes = new Set();
    duplicateHits = 0;
    totalHits = 0;
    lastFrameCode = '';
    lastFrameAt = 0;
    isCompleted = false;
    localStorage.removeItem(STORAGE_KEY);
    els.scanView.hidden = false;
    els.resultView.hidden = true;
    els.startCameraBtn.disabled = false;
    els.cameraSelect.disabled = false;
    els.resultText.value = '';
    els.copyFeedback.textContent = '';
    setSessionStatus('Chưa bật camera', 'ready');
    showFeedback('Đã tạo phiên mới. Sẵn sàng quét mã.', 'neutral');
    renderStatsAndList();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function addManualCode() {
    const value = els.manualCode.value;
    if (!value.trim()) {
      showFeedback('Vui lòng nhập mã trước khi thêm.', 'error');
      els.manualCode.focus();
      return;
    }
    receiveCode(value, 'manual');
    els.manualCode.value = '';
    els.manualCode.focus();
  }

  els.startCameraBtn.addEventListener('click', startCamera);
  els.stopCameraBtn.addEventListener('click', stopCamera);
  els.finishBtn.addEventListener('click', finishSession);
  els.resetBtn.addEventListener('click', resetSession);
  els.addManualBtn.addEventListener('click', addManualCode);
  els.manualCode.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addManualCode();
    }
  });
  els.cameraSelect.addEventListener('change', () => {
    if (cameraRunning) showFeedback('Hãy tắt camera trước khi đổi camera.', 'error');
  });
  els.copyBtn.addEventListener('click', copyResults);
  els.backBtn.addEventListener('click', () => {
    els.resultView.hidden = true;
    els.scanView.hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  els.newSessionBtn.addEventListener('click', resetSession);

  loadSession();
  if (codes.length > 0) {
    showFeedback(`Đã khôi phục ${codes.length} mã từ phiên trước trên thiết bị này.`, 'neutral');
  }
})();
