import { offlineEngine, isNativeApp } from './offlineEngine.js';

let useOffline = isNativeApp();

async function request(url, options = {}) {
  const { signal, ...rest } = options;
  const res = await fetch(url, { credentials: 'same-origin', signal, ...rest });
  const type = res.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await res.json() : await res.text();

  if (!res.ok) {
    const err = new Error((body && body.error) || `Gagal (${res.status})`);
    err.status = res.status;
    err.needsAuth = Boolean(body && body.needsAuth);
    throw err;
  }
  return body;
}

const asJson = (options = {}) => ({
  ...options,
  headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
});

export const api = {
  isOffline: () => useOffline,
  setOffline: (v) => { useOffline = Boolean(v); },

  async health() {
    if (useOffline) return offlineEngine.getHealth();
    try {
      const res = await request('/api/health');
      return res;
    } catch {
      useOffline = true;
      return offlineEngine.getHealth();
    }
  },

  async me() {
    if (useOffline) {
      return { user: { id: 'offline-diver', name: 'Penyelam (HP Offline)', email: 'offline@freecolor.id', plan: 'pro' }, demoMode: true };
    }
    try {
      return await request('/api/auth/me');
    } catch {
      useOffline = true;
      return { user: { id: 'offline-diver', name: 'Penyelam (HP Offline)', email: 'offline@freecolor.id', plan: 'pro' }, demoMode: true };
    }
  },

  async upload(file, gear = 'umum') {
    if (useOffline || isNativeApp()) {
      return offlineEngine.uploadPhoto(file, gear);
    }
    try {
      const form = new FormData();
      form.append('photo', file);
      form.append('gear', gear);
      return await request('/api/upload', { method: 'POST', body: form });
    } catch (err) {
      // If network fails (offline), fall back to mobile offline engine
      if (err.message?.includes('Failed to fetch') || err.message?.includes('NetworkError') || !navigator.onLine) {
        useOffline = true;
        return offlineEngine.uploadPhoto(file, gear);
      }
      throw err;
    }
  },

  async render(assetId, params, edge = 1600, engine = 'lokal', gear = 'umum', refId = null, signal = undefined) {
    if (useOffline || isNativeApp() || (typeof assetId === 'string' && assetId.startsWith('local-'))) {
      return offlineEngine.renderPhoto(assetId, params, edge);
    }
    try {
      return await request(
        '/api/render',
        asJson({ method: 'POST', body: JSON.stringify({ assetId, params, edge, engine, gear, refId }), signal })
      );
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      if (err.message?.includes('Failed to fetch') || err.message?.includes('NetworkError') || !navigator.onLine) {
        useOffline = true;
        return offlineEngine.renderPhoto(assetId, params, edge);
      }
      throw err;
    }
  },

  references: async () => {
    if (useOffline) return [];
    try {
      return await request('/api/references');
    } catch {
      return [];
    }
  },

  removeAsset(assetId) {
    if (useOffline || isNativeApp() || (typeof assetId === 'string' && assetId.startsWith('local-'))) {
      offlineEngine.removeAsset(assetId);
    }
  },

  uploadReference(file, name = '') {
    const form = new FormData();
    form.append('photo', file);
    if (name) form.append('name', name);
    return request('/api/references', { method: 'POST', body: form });
  },

  deleteReference: (id) => request(`/api/references/${id}`, { method: 'DELETE' }),

  updateReference: (id, patch) =>
    request(`/api/references/${id}`, asJson({ method: 'PATCH', body: JSON.stringify(patch) })),

  bulkReferences: (active) =>
    request('/api/references/bulk', asJson({ method: 'POST', body: JSON.stringify({ active }) })),

  feedback: (payload) =>
    request('/api/feedback', asJson({ method: 'POST', body: JSON.stringify(payload) })),

  engineStatus: async () => {
    if (useOffline) {
      return { offline: true, engine: 'Offline Mobile Engine', active: true };
    }
    try {
      return await request('/api/engine/status');
    } catch {
      return { offline: true, engine: 'Offline Mobile Engine', active: true };
    }
  },

  analyze(assetId, refId = null) {
    if (useOffline || (typeof assetId === 'string' && assetId.startsWith('local-'))) {
      return Promise.resolve({
        fromCache: true,
        reasoning: 'Mode offline: Analisis spektrum lokal & restorasi otomatis di HP aktif.',
      });
    }
    return request('/api/analyze', asJson({ method: 'POST', body: JSON.stringify({ assetId, refId }) }));
  },

  generateMagic(assetId, refId = null, prompt = '') {
    return request('/api/magic', asJson({ method: 'POST', body: JSON.stringify({ assetId, refId, prompt }) }));
  },

  saveGallery(payload) {
    return request('/api/gallery', asJson({ method: 'POST', body: JSON.stringify(payload) }));
  },
  gallery: () => request('/api/gallery'),
  deleteGallery: (id) => request(`/api/gallery/${id}`, { method: 'DELETE' }),

  login: (email, password) =>
    request('/api/auth/login', asJson({ method: 'POST', body: JSON.stringify({ email, password }) })),
  register: (name, email, password) =>
    request('/api/auth/register', asJson({ method: 'POST', body: JSON.stringify({ name, email, password }) })),
  logout: () => request('/api/auth/logout', asJson({ method: 'POST', body: '{}' })),
};
