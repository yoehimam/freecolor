// FreeColor - optional AI assistant (Google Gemini), completely separate from
// Auto Grading. Auto Grading is local math and never needs a key. This module
// only runs when the user explicitly opens the AI menu, stores a key and asks.
// The key lives only in this device's localStorage and is sent only to Google.

const KEY = 'fc_ai_key';
const MODEL = 'fc_ai_model';

export const AI_MODELS = [
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (cepat, disarankan)' },
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite (paling hemat)' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (paling teliti)' },
];

export const aiSettings = {
  getKey: () => localStorage.getItem(KEY) || '',
  setKey: (v) => (v ? localStorage.setItem(KEY, v.trim()) : localStorage.removeItem(KEY)),
  getModel: () => localStorage.getItem(MODEL) || AI_MODELS[0].id,
  setModel: (v) => localStorage.setItem(MODEL, v),
};

const PROMPT = `Kamu adalah juri & editor foto bawah air. Analisa foto ini dan jawab HANYA JSON valid berbahasa Indonesia dengan bentuk:
{"scene":"jenis perairan & kondisi (mis. air toska dangkal, biru dalam, hijau keruh)","subject":"subjek utama","problems":["masalah warna/cahaya yang terlihat"],"tips":["saran grading konkret: slider/look yang perlu diubah dan arahnya"],"caption":"satu kalimat keterangan foto"}
Maksimal 4 item pada problems dan 5 pada tips. Jangan menyarankan mengubah identitas subjek.`;

function friendly(status, body) {
  const msg = body?.error?.message || '';
  if (status === 400 && /API key/i.test(msg)) return 'API key tidak valid. Periksa kembali key Anda.';
  if (status === 403) return 'API key ditolak / belum diizinkan untuk Gemini API.';
  if (status === 429) return 'Kuota API key habis atau terlalu sering dipakai (429). Coba lagi nanti.';
  return msg || `Permintaan gagal (${status}).`;
}

async function call(apiKey, model, parts, json = true) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: json ? { responseMimeType: 'application/json', temperature: 0.3 } : { temperature: 0.2, maxOutputTokens: 16 },
    }),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok) throw new Error(friendly(res.status, body));
  return body?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
}

export async function testKey(apiKey, model) {
  if (!apiKey) throw new Error('Isi API key terlebih dahulu.');
  await call(apiKey, model, [{ text: 'Balas satu kata: OK' }], false);
  return true;
}

export async function analyzePhoto({ apiKey, model, imageDataUrl }) {
  if (!apiKey) throw new Error('API key belum diisi. Buka menu AI lalu simpan key Anda.');
  const data = String(imageDataUrl).split(',')[1];
  const text = await call(apiKey, model, [
    { text: PROMPT },
    { inline_data: { mime_type: 'image/jpeg', data } },
  ]);
  try {
    return JSON.parse(text);
  } catch {
    return { scene: '', subject: '', problems: [], tips: [text.trim()], caption: '' };
  }
}
