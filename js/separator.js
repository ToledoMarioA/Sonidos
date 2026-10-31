/**
 * HTDemucs via ONNX Runtime Web.
 * Model: https://huggingface.co/timcsy/demucs-web-onnx
 */
import * as ort from '../vendor/ort/ort.webgpu.bundle.min.mjs';
import { DemucsProcessor, CONSTANTS } from '../vendor/demucs-web/index.js';

export { ort, CONSTANTS };

export const DEFAULT_MODEL_URL =
  'https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx';
export const MODEL_BYTES = 180_534_758;
const MODEL_CACHE = 'separa-voz-htdemucs-v1';

export const HAS_WEBGPU = typeof navigator !== 'undefined' && !!navigator.gpu;

// Configure ONNX Runtime before any session is created.
ort.env.logLevel = 'error';
ort.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;
ort.env.wasm.numThreads = (typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated)
  ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 4))
  : 1;
ort.env.wasm.proxy = false;
if (ort.env.webgpu) {
  try { ort.env.webgpu.powerPreference = 'high-performance'; } catch {}
}

export function getModelUrl() {
  try {
    const q = new URLSearchParams(window.location.search).get('model');
    if (q && /^https?:\/\//i.test(q)) return q;
  } catch {}
  return DEFAULT_MODEL_URL;
}

function safeCacheMatch(cache, url) {
  return cache.match(url, { ignoreVary: true }).catch(() => undefined);
}

/**
 * Download the model with progress and keep it in Cache Storage when possible.
 * onProgress(fraction, loadedBytes, totalBytes, fromCache)
 */
export async function loadModelBuffer(onProgress = () => {}, onLog = () => {}) {
  const url = getModelUrl();

  if ('caches' in window) {
    try {
      const cache = await caches.open(MODEL_CACHE);
      const cached = await safeCacheMatch(cache, url);
      if (cached) {
        onLog('model', 'Modelo encontrado en caché. Evitando descarga.');
        const buf = await cached.arrayBuffer();
        if (buf.byteLength > 1_000_000) {
          onProgress(1, buf.byteLength, buf.byteLength, true);
          return buf;
        }
      }
    } catch (err) {
      onLog('model', `Caché no disponible: ${err.message}`);
    }
  }

  onLog('model', `Descargando modelo (${(MODEL_BYTES / 1_000_000).toFixed(0)} MB)…`);
  let response;
  try {
    response = await fetch(url, { mode: 'cors', credentials: 'omit' });
  } catch (err) {
    throw new Error('No se pudo descargar el modelo de IA. Revisa tu conexión o el bloqueo de red.');
  }
  if (!response.ok) {
    throw new Error(`El servidor del modelo respondió ${response.status}. Inténtalo más tarde.`);
  }

  const total = Number(response.headers.get('Content-Length')) || MODEL_BYTES;
  if (!response.body) {
    const buf = await response.arrayBuffer();
    onProgress(1, buf.byteLength, total, false);
    return buf;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  let lastTick = performance.now();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(Math.min(1, loaded / total), loaded, total, false);
    if (performance.now() - lastTick > 60) {
      await new Promise((r) => setTimeout(r, 0));
      lastTick = performance.now();
    }
  }

  if (loaded < 1_000_000) {
    throw new Error('La descarga del modelo quedó incompleta. Inténtalo de nuevo.');
  }
  onLog('model', `Descarga completa: ${(loaded / 1_000_000).toFixed(1)} MB.`);

  const blob = new Blob(chunks, { type: 'application/octet-stream' });
  chunks.length = 0;

  if ('caches' in window) {
    try {
      const cache = await caches.open(MODEL_CACHE);
      await cache.put(url, new Response(blob, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(blob.size),
        },
      }));
      onLog('model', 'Modelo guardado en caché para la próxima vez.');
    } catch (err) {
      onLog('model', `No se pudo guardar en caché: ${err.message}`);
    }
  }

  return await blob.arrayBuffer();
}

/**
 * Create an inference session, trying WebGPU first when available.
 * Returns { processor, engine }.
 */
export async function createProcessor(modelBuffer, { onLog = () => {}, onProgress = () => {} } = {}) {
  const attempts = HAS_WEBGPU
    ? [{ providers: ['webgpu', 'wasm'], engine: 'WebGPU' }, { providers: ['wasm'], engine: 'WASM' }]
    : [{ providers: ['wasm'], engine: 'WASM' }];

  let lastError = null;
  for (const attempt of attempts) {
    const processor = new DemucsProcessor({
      ort,
      sessionOptions: {
        executionProviders: attempt.providers,
        graphOptimizationLevel: 'basic',
      },
      onLog,
      onProgress,
    });
    try {
      onLog('engine', `Iniciando sesión con ${attempt.providers.join(' → ')}…`);
      await processor.loadModel(modelBuffer);
      onLog('engine', `Modelo cargado con ${attempt.engine}.`);
      return { processor, engine: attempt.engine };
    } catch (err) {
      lastError = err;
      onLog('engine', `No se pudo iniciar ${attempt.engine}: ${err.message}`);
    }
  }
  throw new Error(`No se pudo iniciar el motor de IA. ${lastError ? lastError.message : ''}`);
}

/**
 * Separate a song into drums, bass, other and vocals.
 * Returns the four stems and the number of samples.
 */
export async function separate(processor, left, right, onProgress = () => {}) {
  const originalLength = left.length;
  const paddedLength = Math.max(originalLength, CONSTANTS.TRAINING_SAMPLES);
  let inL = left;
  let inR = right;
  if (paddedLength !== originalLength) {
    inL = new Float32Array(paddedLength);
    inR = new Float32Array(paddedLength);
    inL.set(left);
    inR.set(right);
  }

  const started = performance.now();
  const previous = processor.onProgress;
  processor.onProgress = (info) => {
    const elapsed = (performance.now() - started) / 1000;
    const fraction = Math.max(0.001, Math.min(1, info.progress || 0));
    const eta = elapsed / fraction * (1 - fraction);
    onProgress({ ...info, elapsed, eta });
  };
  let result;
  try {
    result = await processor.separate(inL, inR);
  } finally {
    processor.onProgress = previous;
  }

  return { result, originalLength };
}

/** Combine drums + bass + other into the instrumental and trim to the original length. */
export function buildTwoStems(result, originalLength) {
  const n = originalLength;
  const vocals = {
    left: result.vocals.left.slice(0, n),
    right: result.vocals.right.slice(0, n),
  };
  const instrumental = {
    left: new Float32Array(n),
    right: new Float32Array(n),
  };
  for (let i = 0; i < n; i++) {
    instrumental.left[i] = result.drums.left[i] + result.bass.left[i] + result.other.left[i];
    instrumental.right[i] = result.drums.right[i] + result.bass.right[i] + result.other.right[i];
  }
  return { vocals, instrumental };
}
