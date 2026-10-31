import {
  decodeAudioFile,
  normalizeStem,
  encodeWav,
  encodeMp3,
  formatBytes,
  formatDuration,
  formatEta,
  sanitizeBaseName,
  MAX_DURATION,
} from './audio.js';
import {
  HAS_WEBGPU,
  loadModelBuffer,
  createProcessor,
  separate,
  buildTwoStems,
} from './separator.js';

const $ = (id) => document.getElementById(id);

const els = {
  uploadPanel: $('uploadPanel'),
  processPanel: $('processPanel'),
  resultsPanel: $('resultsPanel'),
  dropzone: $('dropzone'),
  fileInput: $('fileInput'),
  fileCard: $('fileCard'),
  waveform: $('waveform'),
  fileName: $('fileName'),
  fileDetails: $('fileDetails'),
  sourceAudio: $('sourceAudio'),
  clearFileBtn: $('clearFileBtn'),
  formatSelect: $('formatSelect'),
  resultFormatSelect: $('resultFormatSelect'),
  separateBtn: $('separateBtn'),
  uploadError: $('uploadError'),
  modelNote: $('modelNote'),
  processTitle: $('processTitle'),
  processSubtitle: $('processSubtitle'),
  stageList: $('stageList'),
  modelStageText: $('modelStageText'),
  separateStageText: $('separateStageText'),
  encodeStageText: $('encodeStageText'),
  progressLabel: $('progressLabel'),
  progressPercent: $('progressPercent'),
  progressBar: $('progressBar'),
  progressDetail: $('progressDetail'),
  etaText: $('etaText'),
  engineChip: $('engineChip'),
  coiChip: $('coiChip'),
  log: $('log'),
  errorBox: $('errorBox'),
  errorTitle: $('errorTitle'),
  errorMessage: $('errorMessage'),
  errorHint: $('errorHint'),
  retryBtn: $('retryBtn'),
  errorResetBtn: $('errorResetBtn'),
  resultsSubtitle: $('resultsSubtitle'),
  vocalsAudio: $('vocalsAudio'),
  instrumentalAudio: $('instrumentalAudio'),
  vocalsDownload: $('vocalsDownload'),
  instrumentalDownload: $('instrumentalDownload'),
  vocalsSize: $('vocalsSize'),
  instrumentalSize: $('instrumentalSize'),
  downloadBothBtn: $('downloadBothBtn'),
  resetBtn: $('resetBtn'),
  newFileBtn: $('newFileBtn'),
};

const state = {
  file: null,
  audio: null,
  sourceUrl: null,
  resultUrls: [],
  vocals: null,
  instrumental: null,
  encodedFormat: null,
  format: 'mp3',
  processor: null,
  engine: null,
  modelBuffer: null,
  busy: false,
  baseName: 'cancion',
  startedAt: 0,
  modelCached: false,
};

let resizeTimer = null;
let logLines = [];

/* ----------------------------- UI helpers ----------------------------- */

function addLog(phase, message) {
  const time = new Date().toLocaleTimeString('es-MX', { hour12: false });
  const line = `[${time}] ${phase ? `[${phase}] ` : ''}${message}`;
  logLines.push(line);
  if (logLines.length > 120) logLines = logLines.slice(-120);
  els.log.textContent = logLines.join('\n');
  els.log.scrollTop = els.log.scrollHeight;
}

function setStage(name, status, text) {
  const el = els.stageList.querySelector(`[data-stage="${name}"]`);
  if (!el) return;
  el.classList.remove('active', 'done', 'error');
  if (status) el.classList.add(status);
  const small = el.querySelector('small');
  if (text && small) small.textContent = text;
}

function resetStages() {
  for (const name of ['model', 'separate', 'encode']) setStage(name, '', 'En espera');
  setStage('model', 'active', 'Preparando…');
  setProgress(0, 'Preparando…', '—', '');
}

function setProgress(percent, label, detail = '', eta = '') {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  els.progressBar.style.width = `${pct}%`;
  els.progressPercent.textContent = `${pct} %`;
  if (label) els.progressLabel.textContent = label;
  els.progressDetail.textContent = detail || '—';
  els.etaText.textContent = eta || '';
}

function showError(title, message, hint = '') {
  els.uploadPanel.hidden = true;
  els.resultsPanel.hidden = true;
  els.processPanel.hidden = false;
  els.errorBox.hidden = false;
  els.errorTitle.textContent = title;
  els.errorMessage.textContent = message;
  els.errorHint.textContent = hint;
  els.processTitle.textContent = 'No se pudo completar';
  els.processSubtitle.textContent = 'Puedes volver a intentarlo sin perder el archivo.';
  setProgress(0, 'Proceso detenido', '—', '');
  els.retryBtn.hidden = !state.audio;
  addLog('error', message);
}

function hideError() {
  els.errorBox.hidden = true;
  els.retryBtn.hidden = true;
}

function setBusy(busy) {
  state.busy = busy;
  els.separateBtn.disabled = busy || !state.audio;
  els.formatSelect.disabled = busy;
  els.resultFormatSelect.disabled = busy;
  els.clearFileBtn.disabled = busy;
  document.body.setAttribute('aria-busy', String(busy));
}

function showUploadError(message) {
  els.uploadError.textContent = message;
  els.uploadError.hidden = !message;
}

function updateModelNote(cached) {
  state.modelCached = cached;
  els.modelNote.innerHTML = cached
    ? '<span aria-hidden="true">✓</span> Modelo de IA listo en la caché del navegador.'
    : '<span aria-hidden="true">ⓘ</span> La primera vez se descarga el modelo de IA (180 MB). Luego queda en caché y no vuelve a bajarse.';
}

/* ----------------------------- waveform ----------------------------- */

function drawWaveform() {
  const canvas = els.waveform;
  const buffer = state.audio?.audioBuffer;
  if (!buffer) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);

  const data = buffer.getChannelData(0);
  const mid = rect.height / 2;
  const bars = Math.max(80, Math.floor(rect.width / 2.6));
  const step = Math.max(1, Math.floor(data.length / bars));
  const gap = 1;
  const barWidth = Math.max(1, rect.width / bars - gap);

  const gradient = ctx.createLinearGradient(0, 0, rect.width, 0);
  gradient.addColorStop(0, 'rgba(184,255,61,.8)');
  gradient.addColorStop(0.45, 'rgba(57,255,136,.95)');
  gradient.addColorStop(1, 'rgba(77,255,195,.8)');
  ctx.fillStyle = gradient;

  for (let b = 0; b < bars; b++) {
    const start = b * step;
    const end = Math.min(start + step, data.length);
    let peak = 0;
    for (let i = start; i < end; i += 2) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
    }
    const h = Math.max(1.2, Math.min(mid - 2, peak * mid * 1.8));
    const x = b * (barWidth + gap);
    ctx.globalAlpha = 0.9;
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath();
      ctx.roundRect(x, mid - h, barWidth, h * 2, barWidth / 2);
      ctx.fill();
    } else {
      ctx.fillRect(x, mid - h, barWidth, h * 2);
    }
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = 'rgba(255,255,255,.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, mid + .5);
  ctx.lineTo(rect.width, mid + .5);
  ctx.stroke();
}

window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(drawWaveform, 160);
});

/* ----------------------------- file handling ----------------------------- */

function revokeSourceUrl() {
  if (state.sourceUrl) {
    URL.revokeObjectURL(state.sourceUrl);
    state.sourceUrl = null;
  }
}

function revokeResultUrls() {
  for (const url of state.resultUrls) URL.revokeObjectURL(url);
  state.resultUrls = [];
}

function resetFileUI() {
  els.sourceAudio.pause();
  els.sourceAudio.removeAttribute('src');
  els.sourceAudio.load();
  els.fileCard.hidden = true;
  els.dropzone.hidden = false;
  els.dropzone.classList.remove('loading');
  els.uploadError.hidden = true;
  els.separateBtn.disabled = true;
  els.fileInput.value = '';
  els.fileName.textContent = '—';
  els.fileDetails.textContent = '—';
}

function resetAll() {
  if (state.busy) return;
  revokeSourceUrl();
  revokeResultUrls();
  resetFileUI();
  state.file = null;
  state.audio = null;
  state.vocals = null;
  state.instrumental = null;
  state.encodedFormat = null;
  state.baseName = 'cancion';
  if (!state.processor) state.modelBuffer = null;
  hideError();
  els.resultsPanel.hidden = true;
  els.processPanel.hidden = true;
  els.uploadPanel.hidden = false;
  els.formatSelect.disabled = false;
  els.resultsSubtitle.textContent = 'Escúchalas y descárgalas por separado.';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function handleFile(file) {
  if (!file || state.busy) return;
  resetAll();
  hideError();
  els.uploadError.hidden = true;
  showUploadError('');

  if (!(file.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(file.name))) {
    showUploadError('Ese archivo no parece audio. Usa MP3, WAV o M4A.');
    els.fileInput.value = '';
    return;
  }
  if (file.size > 80 * 1024 * 1024) {
    showUploadError(`El archivo pesa ${formatBytes(file.size)}. El límite es 80 MB.`);
    els.fileInput.value = '';
    return;
  }

  els.dropzone.classList.add('loading');
  els.fileName.textContent = file.name;
  els.fileDetails.textContent = `${formatBytes(file.size)} · leyendo audio…`;

  try {
    const audio = await decodeAudioFile(file);
    if (audio.duration > MAX_DURATION) throw new Error('La canción supera el límite de 8 minutos.');

    revokeSourceUrl();
    state.file = file;
    state.audio = audio;
    state.baseName = sanitizeBaseName(file.name);
    state.vocals = null;
    state.instrumental = null;
    state.encodedFormat = null;

    revokeResultUrls();
    els.resultsPanel.hidden = true;
    els.processPanel.hidden = true;

    state.sourceUrl = URL.createObjectURL(file);
    els.sourceAudio.src = state.sourceUrl;
    els.fileName.textContent = file.name;
    els.fileDetails.textContent = `${formatDuration(audio.duration)} · ${formatBytes(file.size)} · 44.1 kHz estéreo`;
    els.dropzone.hidden = true;
    els.fileCard.hidden = false;
    els.uploadError.hidden = true;
    els.separateBtn.disabled = false;
    els.dropzone.classList.remove('loading');
    els.uploadPanel.hidden = false;
    requestAnimationFrame(drawWaveform);

    addLog('file', `${file.name} · ${formatDuration(audio.duration)} · ${formatBytes(file.size)} · ${audio.sampleRate} Hz`);
  } catch (err) {
    console.error(err);
    els.dropzone.classList.remove('loading');
    els.dropzone.hidden = false;
    els.fileCard.hidden = true;
    els.fileInput.value = '';
    showUploadError(err.message || 'No se pudo leer el audio.');
    addLog('error', err.message || String(err));
  }
}

/* ----------------------------- encoding ----------------------------- */

async function encodeStem(stem, format, onProgress) {
  if (format === 'wav') {
    onProgress(0.15);
    const blob = encodeWav(stem.left, stem.right);
    onProgress(1);
    return { blob, format: 'wav', ext: 'wav', mime: 'audio/wav' };
  }
  try {
    const blob = await encodeMp3(stem.left, stem.right, 320, onProgress);
    return { blob, format: 'mp3', ext: 'mp3', mime: 'audio/mpeg' };
  } catch (err) {
    addLog('encode', `MP3 no disponible (${err.message}). Usando WAV.`);
    const blob = encodeWav(stem.left, stem.right);
    return { blob, format: 'wav', ext: 'wav', mime: 'audio/wav' };
  }
}

async function buildResultFiles() {
  const format = state.format;
  setBusy(true);
  els.resultsSubtitle.textContent = `Creando archivos ${format.toUpperCase()}…`;
  els.resultsPanel.setAttribute('aria-busy', 'true');
  setStage('encode', 'active', 'Codificando pistas…');

  try {
    let vocals = await encodeStem(state.vocals, format, (p) => {
      setProgress(10 + p * 40, 'Codificando la voz…', `${Math.round(p * 100)} %`, '');
    });
    let instrumental = await encodeStem(state.instrumental, format, (p) => {
      setProgress(50 + p * 45, 'Codificando el instrumental…', `${Math.round(p * 100)} %`, '');
    });

    // Si un codificador falla, entrega ambas pistas en el mismo formato.
    if (vocals.format !== instrumental.format) {
      addLog('encode', 'Formatos distintos; recodificando ambas pistas a WAV.');
      const vWav = encodeWav(state.vocals.left, state.vocals.right);
      const iWav = encodeWav(state.instrumental.left, state.instrumental.right);
      vocals = { blob: vWav, format: 'wav', ext: 'wav', mime: 'audio/wav' };
      instrumental = { blob: iWav, format: 'wav', ext: 'wav', mime: 'audio/wav' };
    }
    const finalFormat = vocals.format;
    if (finalFormat !== format) {
      state.format = 'wav';
      els.formatSelect.value = 'wav';
      els.resultFormatSelect.value = 'wav';
    }

    revokeResultUrls();
    const vocalsUrl = URL.createObjectURL(vocals.blob);
    const instrumentalUrl = URL.createObjectURL(instrumental.blob);
    state.resultUrls = [vocalsUrl, instrumentalUrl];
    state.encodedFormat = finalFormat;

    els.vocalsAudio.src = vocalsUrl;
    els.instrumentalAudio.src = instrumentalUrl;
    els.vocalsDownload.href = vocalsUrl;
    els.instrumentalDownload.href = instrumentalUrl;
    els.vocalsDownload.download = `${state.baseName}_voz.${vocals.ext}`;
    els.instrumentalDownload.download = `${state.baseName}_instrumental.${instrumental.ext}`;
    els.vocalsSize.textContent = `${formatBytes(vocals.blob.size)} · ${vocals.ext.toUpperCase()}`;
    els.instrumentalSize.textContent = `${formatBytes(instrumental.blob.size)} · ${instrumental.ext.toUpperCase()}`;
    els.resultsSubtitle.textContent = `Voz e instrumental · ${finalFormat.toUpperCase()} · ${formatDuration(state.audio.duration)}`;

    setProgress(100, 'Archivos listos', `${formatBytes(vocals.blob.size)} + ${formatBytes(instrumental.blob.size)}`, '');
    setStage('encode', 'done', 'Listo');
    els.resultsPanel.hidden = false;
    els.processPanel.hidden = true;
    els.resultsPanel.removeAttribute('aria-busy');
    window.setTimeout(() => els.resultsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
    addLog('encode', `Listo: voz ${formatBytes(vocals.blob.size)}, instrumental ${formatBytes(instrumental.blob.size)} (${finalFormat}).`);
  } finally {
    setBusy(false);
    els.resultsPanel.removeAttribute('aria-busy');
  }
}

/* ----------------------------- main flow ----------------------------- */

async function startSeparation() {
  if (state.busy || !state.audio) return;
  if (!window.crossOriginIsolated) {
    addLog('env', 'crossOriginIsolated = false. Se usará 1 hilo de WASM; la separación puede ser más lenta.');
  }

  hideError();
  setBusy(true);
  els.uploadPanel.hidden = true;
  els.resultsPanel.hidden = true;
  els.processPanel.hidden = false;
  els.processTitle.textContent = 'Separando tu canción';
  els.processSubtitle.textContent = state.file?.name || '';
  resetStages();
  addLog('start', 'Comenzando separación.');

  try {
    let modelBuffer = state.modelBuffer;
    if (!modelBuffer) {
      setStage('model', 'active', 'Descargando modelo…');
      setProgress(0, 'Descargando modelo de IA', '0 %', '');
      const t0 = performance.now();
      modelBuffer = await loadModelBuffer(
        (fraction, loaded, total, fromCache) => {
          const pct = Math.round(fraction * 100);
          const loadedMb = (loaded / 1_000_000).toFixed(1);
          const totalMb = (total / 1_000_000).toFixed(0);
          const elapsed = (performance.now() - t0) / 1000;
          const eta = fraction > 0.01 ? (elapsed / fraction) * (1 - fraction) : 0;
          setProgress(
            pct,
            fromCache ? 'Cargando modelo desde la caché' : 'Descargando modelo de IA',
            fromCache ? 'Modelo en caché' : `${loadedMb} / ${totalMb} MB`,
            fromCache ? '' : formatEta(eta)
          );
        },
        addLog
      );
      state.modelBuffer = modelBuffer;
      setStage('model', 'done', 'Modelo descargado');
      updateModelNote(false);
    } else {
      setStage('model', 'done', 'Modelo en memoria');
      setProgress(100, 'Modelo listo', 'En memoria', '');
    }

    if (!state.processor) {
      setStage('separate', 'active', 'Iniciando motor de IA…');
      setProgress(100, 'Cargando modelo en el motor de IA', 'Puede tardar unos segundos', '');
      const created = await createProcessor(modelBuffer, { onLog: addLog });
      state.processor = created.processor;
      state.engine = created.engine;
      state.modelBuffer = null; // libera 180 MB; la sesión y la caché siguen disponibles
      els.engineChip.textContent = created.engine === 'WebGPU' ? 'WebGPU activo' : 'CPU · WASM';
      els.engineChip.className = 'engine-chip ok';
    } else {
      setStage('separate', 'active', 'Motor listo');
      els.engineChip.textContent = state.engine === 'WebGPU' ? 'WebGPU activo' : 'CPU · WASM';
      els.engineChip.className = 'engine-chip ok';
    }

    setStage('model', 'done', 'Listo');
    setStage('separate', 'active', 'Separando pistas…');
    setProgress(0, 'Separando voz, batería, bajo y resto', 'Preparando segmentos…', '');

    const { result, originalLength } = await separate(
      state.processor,
      state.audio.left,
      state.audio.right,
      (info) => {
        const pct = Math.round((info.progress || 0) * 100);
        setProgress(
          pct,
          'Separando voz, batería, bajo y resto',
          `Segmento ${info.currentSegment || 0} de ${info.totalSegments || '—'}`,
          formatEta(info.eta)
        );
      }
    );

    setStage('separate', 'done', 'Pistas separadas');
    setStage('encode', 'active', 'Preparando archivos…');
    setProgress(0, 'Preparando las dos pistas', 'Normalizando…', '');

    const two = buildTwoStems(result, originalLength);
    const vocals = normalizeStem(two.vocals.left, two.vocals.right, 0.891);
    const instrumental = normalizeStem(two.instrumental.left, two.instrumental.right, 0.891);
    state.vocals = { left: vocals.left, right: vocals.right };
    state.instrumental = { left: instrumental.left, right: instrumental.right };

    // Permite que el navegador libere los stems intermedios.
    result.drums = result.bass = result.other = result.vocals = null;

    addLog('stems', `Voz normalizada (${(20 * Math.log10(vocals.peak || 1)).toFixed(1)} dB peak original).`);
    addLog('stems', `Instrumental normalizado (${(20 * Math.log10(instrumental.peak || 1)).toFixed(1)} dB peak original).`);

    await buildResultFiles();
  } catch (err) {
    console.error(err);
    const msg = err?.message || String(err);
    let hint = 'Revisa la consola y vuelve a intentarlo.';
    if (/fetch|network|conexión|modelo/i.test(msg)) hint = 'El modelo se descarga desde Hugging Face. Comprueba tu conexión, VPN o bloqueador de red.';
    if (/memory|alloc|out of/i.test(msg)) hint = 'Puede faltar memoria. Cierra otras pestañas o prueba con una canción más corta en un ordenador.';
    if (/webgpu|adapter/i.test(msg)) hint = 'Actualiza Chrome/Edge o prueba en otro navegador compatible. La app intentará usar CPU como respaldo.';
    showError('No se pudo separar el audio', msg, hint);
    setStage('separate', 'error', 'Error');
    state.processor = null;
  } finally {
    setBusy(false);
  }
}

/* ----------------------------- events ----------------------------- */

els.dropzone.addEventListener('click', () => {
  if (!state.busy) els.fileInput.click();
});
els.dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    if (!state.busy) els.fileInput.click();
  }
});
els.fileInput.addEventListener('change', () => {
  const file = els.fileInput.files?.[0];
  if (file) handleFile(file);
});

['dragenter', 'dragover'].forEach((type) => {
  els.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    event.stopPropagation();
    els.dropzone.classList.add('dragover');
  });
});
['dragleave', 'drop'].forEach((type) => {
  els.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    event.stopPropagation();
    els.dropzone.classList.remove('dragover');
  });
});
els.dropzone.addEventListener('drop', (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (file) handleFile(file);
});

els.clearFileBtn.addEventListener('click', resetAll);
els.separateBtn.addEventListener('click', startSeparation);
els.retryBtn.addEventListener('click', async () => {
  hideError();
  if (state.vocals && state.instrumental && !state.busy) {
    try {
      await buildResultFiles();
    } catch (err) {
      showError('No se pudo recodificar', err.message, 'Prueba con el otro formato.');
    }
  } else {
    startSeparation();
  }
});
els.resetBtn.addEventListener('click', resetAll);
els.errorResetBtn.addEventListener('click', resetAll);
els.newFileBtn.addEventListener('click', resetAll);

els.downloadBothBtn.addEventListener('click', () => {
  els.vocalsDownload.click();
  setTimeout(() => els.instrumentalDownload.click(), 350);
});

async function onFormatChange(value) {
  state.format = value;
  els.formatSelect.value = value;
  els.resultFormatSelect.value = value;
  if (state.vocals && state.instrumental && !state.busy) {
    try {
      await buildResultFiles();
    } catch (err) {
      showError('No se pudo recodificar', err.message, 'Prueba con el otro formato.');
    }
  }
}
els.formatSelect.addEventListener('change', () => onFormatChange(els.formatSelect.value));
els.resultFormatSelect.addEventListener('change', () => onFormatChange(els.resultFormatSelect.value));

/* ----------------------------- boot ----------------------------- */

function boot() {
  const coi = window.crossOriginIsolated;
  els.coiChip.textContent = coi ? 'SharedArrayBuffer activo' : '1 hilo · modo compatibilidad';
  els.coiChip.className = `engine-chip ${coi ? 'ok' : 'warn'}`;
  els.engineChip.textContent = HAS_WEBGPU ? 'WebGPU disponible' : 'CPU · WASM';
  els.engineChip.className = `engine-chip ${HAS_WEBGPU ? 'ok' : 'warn'}`;

  addLog('env', `crossOriginIsolated=${coi}; WebGPU=${HAS_WEBGPU}; hilos=${navigator.hardwareConcurrency || '?'}`);
  if (!coi) addLog('env', 'Sin aislamiento de origen: el service worker puede estar registrándose. Si persiste, la app usará un solo hilo.');
  if (!HAS_WEBGPU) addLog('env', 'WebGPU no disponible. Se usará WASM; la separación será más lenta.');

  if (!window.lamejs?.Mp3Encoder) {
    const mp3Option = els.formatSelect.querySelector('option[value="mp3"]');
    if (mp3Option) mp3Option.disabled = true;
    state.format = 'wav';
    els.formatSelect.value = 'wav';
    els.resultFormatSelect.value = 'wav';
    addLog('env', 'Codificador MP3 no disponible; se usará WAV.');
  }

  // Comprueba si hay caché del modelo para informar al usuario.
  if ('caches' in window) {
    caches.open('separa-voz-htdemucs-v1')
      .then((cache) => cache.match('https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx', { ignoreVary: true }))
      .then((hit) => { if (hit) updateModelNote(true); })
      .catch(() => {});
  }

  // Test hook (útil para automatización; no expone nada sensible).
  window.__separaVoz = {
    state,
    startSeparation,
    resetAll,
    getStatus: () => ({
      busy: state.busy,
      hasFile: !!state.file,
      hasResults: !!state.vocals,
      engine: state.engine,
      coi: window.crossOriginIsolated,
      webgpu: HAS_WEBGPU,
      error: els.errorBox.hidden ? null : els.errorMessage.textContent,
    }),
  };
}

boot();
