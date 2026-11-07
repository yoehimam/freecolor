// Client for the Python spectral service (service/main.py).
//
// The service owns the model chain (ONNX WaterNet / Hugging Face / numpy
// spectral) and returns an already colour-restored JPEG plus headers telling us
// which provider actually ran. The Node pipeline then only applies tone and
// grading on top, so both engines share the same look controls.

const DEFAULT_URL = 'http://127.0.0.1:8799';

export function spectralUrl() {
  return (process.env.SPECTRAL_URL || DEFAULT_URL).trim().replace(/\/+$/, '');
}

function authHeaders() {
  const token = (process.env.SPECTRAL_TOKEN || '').trim();
  return token ? { 'X-Spectral-Token': token } : {};
}

export async function spectralHealth(timeoutMs = 2500) {
  const res = await fetch(`${spectralUrl()}/health`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * @param {Buffer} buffer   JPEG of the photo at the target edge
 * @param {object} options  { strength, provider, timeoutMs }
 */
export async function spectralEnhance(buffer, options = {}) {
  const { strength = 0.75, provider = '', timeoutMs = 45_000 } = options;

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'image/jpeg' }), 'photo.jpg');
  form.append('strength', String(Math.max(0.05, Math.min(1, strength))));
  if (provider) form.append('provider', provider);

  const res = await fetch(`${spectralUrl()}/enhance`, {
    method: 'POST',
    body: form,
    headers: authHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Spectral ${res.status}: ${detail.slice(0, 180) || res.statusText}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    provider: res.headers.get('x-provider') || 'spectral',
    model: res.headers.get('x-model') || '',
    ms: Number(res.headers.get('x-ms')) || 0,
  };
}

let cached = { at: 0, data: null };

/** Cached health probe so the UI can show engine availability on every render. */
export async function spectralStatus(ttlMs = 15_000) {
  if (cached.data && Date.now() - cached.at < ttlMs) return cached.data;

  let data;
  try {
    const health = await spectralHealth();
    data = { ok: Boolean(health.ok), url: spectralUrl(), ...health };
  } catch (err) {
    data = {
      ok: false,
      url: spectralUrl(),
      error: err?.name === 'TimeoutError' ? 'timeout 2.5s' : String(err?.message || err),
    };
  }
  cached = { at: Date.now(), data };
  return data;
}
