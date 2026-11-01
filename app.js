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

  function getSupportedFormats() {
    const formats = window.Html5QrcodeSupportedFormats;
    if (!formats) throw new Error('Thư viện quét mã chưa sẵn sàng. Hãy tải lại trang.');
    // Bao gồm QR và các mã vạch thường gặp trên nhãn hàng/đơn vận chuyển.
    return [
      formats.QR_CODE,
      formats.CODE_128,
      formats.CODE_39,
      formats.CODE_93,
      formats.CODABAR,
      formats.EAN_13,
      formats.EAN_8,
      formats.ITF,
      formats.UPC_A,
      formats.UPC_E,
      formats.UPC_EAN_EXTENSION,
      formats.DATA_MATRIX,
      formats.PDF_417,
      formats.AZTEC
    ].filter((format) => typeof format === 'number');
  }

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
    cameras = await window.Html5Qrcode.getCameras();
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
    if (cameras.length === 0) throw new Error('Không tìm thấy camera. Hãy cấp quyền camera cho trình duyệt và kiểm tra camera có đang được ứng dụng khác sử dụng không.');

    // Ưu tiên camera sau trên điện thoại. Trên máy tính, chọn webcam đầu tiên;
    // không ép facingMode=environment vì webcam máy tính thường không có chế độ này.
    if (previous && cameras.some((camera) => camera.id === previous)) {
      els.cameraSelect.value = previous;
    } else {
      const rearCamera = cameras.find((camera) => /back|rear|environment|sau/i.test(camera.label || ''));
      els.cameraSelect.value = (rearCamera || cameras[0]).id;
    }
  }

  async function startCamera() {
    if (isCompleted || cameraRunning) return;
    els.startCameraBtn.disabled = true;
    showFeedback('Đang khởi động camera…', 'neutral');
    try {
      prepareAudio();
      // Chờ thư viện từ CDN tải xong; nếu CDN đầu lỗi, index.html tự thử CDN dự phòng.
      if (window.html5QrcodeLibraryReady) await window.html5QrcodeLibraryReady;
      if (!window.Html5Qrcode || !window.Html5QrcodeSupportedFormats) {
        throw new Error('Không tải được thư viện quét mã. Kiểm tra Internet rồi tải lại trang.');
      }
      if (!cameras.length) await populateCameras();
      if (!scanner) {
        scanner = new window.Html5Qrcode('reader', {
          formatsToSupport: getSupportedFormats(),
          verbose: false
        });
      }

      const selectedCamera = els.cameraSelect.value || cameras[0]?.id;
      if (!selectedCamera) throw new Error('Không tìm thấy camera. Hãy kiểm tra quyền camera của trình duyệt.');

      await scanner.start(
        { deviceId: { exact: selectedCamera } },
        {
          fps: 10,
          qrbox: (viewfinderWidth, viewfinderHeight) => {
            // Vùng quét rộng và cao hơn để nhận được cả QR vuông lẫn mã vạch dài.
            const width = Math.floor(Math.min(viewfinderWidth * 0.94, 560));
            const height = Math.floor(Math.min(viewfinderHeight * 0.72, 320));
            return {
              width: Math.max(100, Math.min(width, viewfinderWidth)),
              height: Math.max(100, Math.min(height, viewfinderHeight))
            };
          },
          disableFlip: false
        },
        (decodedText) => receiveCode(decodedText, 'camera'),
        () => { /* Không đọc được ở một khung hình là bình thường; tiếp tục thử khung tiếp theo. */ }
      );

      cameraRunning = true;
      els.cameraPlaceholder.hidden = true;
      els.startCameraBtn.disabled = true;
      els.stopCameraBtn.disabled = false;
      els.cameraSelect.disabled = true;
      setSessionStatus('Camera đang hoạt động', 'active');
      showFeedback('Camera đã bật. Đưa mã vào giữa khung, giữ thẳng và đủ sáng. App nhận QR, Code 128, EAN-13 và các mã phổ biến khác.', 'neutral');
    } catch (error) {
      console.error('Lỗi khởi động máy quét:', error);
      const message = error?.name === 'NotAllowedError'
        ? 'Trình duyệt chưa được cấp quyền camera. Nhấn biểu tượng khóa cạnh địa chỉ website → Camera → Cho phép, rồi tải lại trang.'
        : error?.name === 'NotFoundError'
          ? 'Thiết bị không tìm thấy camera. Hãy kiểm tra webcam/camera và thử lại.'
          : error?.name === 'NotReadableError'
            ? 'Camera đang được ứng dụng khác sử dụng. Hãy đóng ứng dụng Camera/Zoom/Teams rồi thử lại.'
            : error?.name === 'OverconstrainedError'
              ? 'Camera không hỗ trợ cấu hình đã chọn. Hãy chọn camera khác.'
              : (error.message || 'Không thể bật camera.');
      showFeedback(message, 'error');
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
