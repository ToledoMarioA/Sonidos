/**
 * Audio helpers: decode, resample, normalize, WAV/MP3 encode.
 * All processing happens in the browser.
 */

export const TARGET_SR = 44100;
export const MAX_DURATION = 8 * 60; // seconds
export const MAX_FILE_BYTES = 80 * 1024 * 1024;

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 45) return `~${Math.ceil(seconds)} s restantes`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `~${m} min ${s ? `${s} s` : ''} restantes`.replace('  ', ' ');
}

export function sanitizeBaseName(name) {
  const base = name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '-').trim();
  return (base || 'cancion').slice(0, 90);
}

/**
 * Decode any browser-supported audio file to 44.1 kHz stereo Float32 arrays.
 * Returns { left, right, sampleRate, length, duration, audioBuffer }.
 */
export async function decodeAudioFile(file) {
  if (!file) throw new Error('No hay archivo.');
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`El archivo pesa ${formatBytes(file.size)}. El límite es ${formatBytes(MAX_FILE_BYTES)}.`);
  }

  const arrayBuffer = await file.arrayBuffer();
  let buffer;
  try {
    // decodeAudioData on an OfflineAudioContext at 44.1 kHz resamples on decode.
    const ctx = new OfflineAudioContext(2, 1, TARGET_SR);
    buffer = await ctx.decodeAudioData(arrayBuffer);
  } catch (err) {
    throw new Error('No se pudo decodificar el audio. Prueba con un MP3, WAV o M4A válido.');
  }

  if (!buffer || !buffer.length) throw new Error('El archivo no contiene audio reconocible.');
  if (buffer.duration > MAX_DURATION + 0.5) {
    throw new Error(`La canción dura ${formatDuration(buffer.duration)}. El límite es ${formatDuration(MAX_DURATION)}.`);
  }

  // Some browsers may ignore the requested context rate; guarantee 44.1 kHz.
  if (Math.abs(buffer.sampleRate - TARGET_SR) > 1) {
    const length = Math.ceil(buffer.duration * TARGET_SR);
    const offline = new OfflineAudioContext(2, length, TARGET_SR);
    const source = offline.createBufferSource();
    source.buffer = buffer;
    source.connect(offline.destination);
    source.start(0);
    buffer = await offline.startRendering();
  }

  const length = buffer.length;
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  const srcL = buffer.getChannelData(0);
  const srcR = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : srcL;
  left.set(srcL.subarray(0, length));
  right.set(srcR.subarray(0, length));

  return {
    left,
    right,
    sampleRate: buffer.sampleRate,
    length,
    duration: buffer.duration,
    audioBuffer: buffer,
  };
}

/** Peak-normalize a stereo stem to a target linear peak (default −1 dBFS). */
export function normalizeStem(left, right, targetPeak = 0.891) {
  let peak = 0;
  for (let i = 0; i < left.length; i++) {
    const a = Math.abs(left[i]);
    const b = Math.abs(right[i]);
    if (a > peak) peak = a;
    if (b > peak) peak = b;
  }
  if (peak < 1e-7) return { left, right, gain: 1, peak: 0 };
  const gain = targetPeak / peak;
  const outL = new Float32Array(left.length);
  const outR = new Float32Array(right.length);
  for (let i = 0; i < left.length; i++) {
    outL[i] = Math.max(-1, Math.min(1, left[i] * gain));
    outR[i] = Math.max(-1, Math.min(1, right[i] * gain));
  }
  return { left: outL, right: outR, gain, peak };
}

/** Sum multiple stereo stems into new buffers. */
export function sumStems(stems) {
  const length = stems[0].left.length;
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  for (const stem of stems) {
    const l = stem.left;
    const r = stem.right;
    for (let i = 0; i < length; i++) {
      left[i] += l[i];
      right[i] += r[i];
    }
  }
  return { left, right };
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/** Encode stereo Float32 as 16-bit PCM WAV. */
export function encodeWav(left, right, sampleRate = TARGET_SR) {
  const frames = left.length;
  const dataBytes = frames * 2 * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2 * 2, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < frames; i++) {
    let l = left[i];
    let r = right[i];
    l = l < -1 ? -1 : l > 1 ? 1 : l;
    r = r < -1 ? -1 : r > 1 ? 1 : r;
    view.setInt16(offset, l < 0 ? l * 0x8000 : l * 0x7fff, true);
    view.setInt16(offset + 2, r < 0 ? r * 0x8000 : r * 0x7fff, true);
    offset += 4;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function floatChunkToInt16(input, start, end) {
  const out = new Int16Array(end - start);
  for (let i = start; i < end; i++) {
    let s = input[i];
    s = s < -1 ? -1 : s > 1 ? 1 : s;
    out[i - start] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/**
 * Encode stereo Float32 as MP3 using lamejs (loaded globally).
 * Yields periodically so the UI stays responsive.
 */
export async function encodeMp3(left, right, bitrate = 320, onProgress = () => {}) {
  const lame = window.lamejs;
  if (!lame || !lame.Mp3Encoder) {
    throw new Error('El codificador MP3 no está disponible. Elige WAV.');
  }
  const encoder = new lame.Mp3Encoder(2, TARGET_SR, bitrate);
  const block = 1152;
  const total = left.length;
  const chunks = [];
  let lastYield = performance.now();

  for (let i = 0; i < total; i += block) {
    const end = Math.min(i + block, total);
    const l = floatChunkToInt16(left, i, end);
    const r = floatChunkToInt16(right, i, end);
    const encoded = encoder.encodeBuffer(l, r);
    if (encoded.length) chunks.push(new Uint8Array(encoded));
    if (performance.now() - lastYield > 40) {
      onProgress(end / total);
      await new Promise((resolve) => setTimeout(resolve, 0));
      lastYield = performance.now();
    }
  }
  const tail = encoder.flush();
  if (tail.length) chunks.push(new Uint8Array(tail));
  onProgress(1);
  return new Blob(chunks, { type: 'audio/mpeg' });
}

/** Convert a Blob to a downloadable object URL and revoke it later. */
export function makeUrl(blob) {
  return URL.createObjectURL(blob);
}
