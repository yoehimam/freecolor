// FreeColor Offline Engine — In-Device / Mobile Underwater Processing Engine
// Runs 100% locally on Android (inside Capacitor WebView) without requiring a backend server.

import { measure, autoParams, describe } from './engine/measure.js';
import { processImage } from './engine/pipeline.js';
import { PRESETS } from './engine/presets.js';

// Cache for offline assets and bitmaps
const assetStore = new Map();
let idCounter = 1;

/**
 * Checks if the current environment is standalone offline (Capacitor Native APK or no server reachable).
 */
export function isNativeApp() {
  return typeof window !== 'undefined' && Boolean(window.Capacitor?.isNativePlatform());
}

/**
 * Resize image into canvas and extract ImageData
 */
async function scaleImageToImageData(img, maxEdge = 1600) {
  let w = img.naturalWidth || img.width;
  let h = img.naturalHeight || img.height;

  if (w > maxEdge || h > maxEdge) {
    if (w >= h) {
      h = Math.round((h * maxEdge) / w);
      w = maxEdge;
    } else {
      w = Math.round((w * maxEdge) / h);
      h = maxEdge;
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const imageData = ctx.getImageData(0, 0, w, h);
  return { canvas, ctx, imageData, width: w, height: h };
}

/**
 * Load HTMLImageElement from File or Blob
 */
function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ img, url });
    };
    img.onerror = reject;
    img.src = url;
  });
}

export const offlineEngine = {
  isAvailable: true,

  async uploadPhoto(file, gear = 'umum') {
    const { img, url: origUrl } = await loadImageFromFile(file);
    const origWidth = img.naturalWidth || img.width;
    const origHeight = img.naturalHeight || img.height;

    // Create 1600px view version for real-time editing
    const { imageData: viewImageData, width: viewW, height: viewH, canvas: viewCanvas } = await scaleImageToImageData(img, 1600);
    const viewUrl = viewCanvas.toDataURL('image/jpeg', 0.88);

    // Create 240px thumb
    const { canvas: thumbCanvas } = await scaleImageToImageData(img, 240);
    const thumbUrl = thumbCanvas.toDataURL('image/jpeg', 0.75);

    // Measure spectrum and underwater condition directly in-device
    const stats = measure(viewImageData.data, viewW, viewH, 4);
    const auto = autoParams(stats);
    const condition = describe(stats);

    const assetId = 'local-' + Date.now() + '-' + (++idCounter);
    const asset = {
      id: assetId,
      name: file.name || 'foto-underwater.jpg',
      width: origWidth,
      height: origHeight,
      gear,
      stats,
      auto,
      createdAt: Date.now(),
      viewUrl,
      beforeUrl: viewUrl,
      thumbUrl,
      origUrl,
    };

    assetStore.set(assetId, {
      asset,
      condition,
      origFile: file,
      viewImageData,
      origImg: img,
      lastRenderUrl: null,
    });

    return { asset, condition };
  },

  async renderPhoto(assetId, params, edge = 1600) {
    const record = assetStore.get(assetId);
    if (!record) {
      throw new Error('Foto tidak ditemukan di penyimpanan HP.');
    }

    const t0 = performance.now();
    let srcData = record.viewImageData;

    // Clone pixel buffer for non-destructive processing
    const pixelCopy = new Uint8Array(srcData.data);
    const res = processImage(
      { data: pixelCopy, width: srcData.width, height: srcData.height, channels: 4 },
      params
    );

    // Put rendered pixels into canvas
    const canvas = document.createElement('canvas');
    canvas.width = srcData.width;
    canvas.height = srcData.height;
    const ctx = canvas.getContext('2d');
    const outImgData = new ImageData(new Uint8ClampedArray(res.data.buffer), srcData.width, srcData.height);
    ctx.putImageData(outImgData, 0, 0);

    const renderUrl = canvas.toDataURL('image/jpeg', 0.92);
    if (record.lastRenderUrl && record.lastRenderUrl.startsWith('blob:')) {
      URL.revokeObjectURL(record.lastRenderUrl);
    }
    record.lastRenderUrl = renderUrl;

    const ms = Math.round(performance.now() - t0);
    return {
      url: renderUrl,
      width: srcData.width,
      height: srcData.height,
      ms,
      metrics: res.metrics,
      params,
    };
  },

  async exportHighRes(assetId, params, format = 'image/jpeg') {
    const record = assetStore.get(assetId);
    if (!record) throw new Error('Foto tidak ditemukan.');

    // Yield to event loop so mobile UI can render loading notice without freezing
    await new Promise((r) => setTimeout(r, 60));

    // Limit maximum edge to 2048px (Full HD/2K):
    // Prevents mobile RAM exhaustion/ANR freezes while preserving ultra-crisp detail
    const MAX_EDGE = 2048;
    const { imageData: fullData, width, height } = await scaleImageToImageData(record.origImg, MAX_EDGE);

    const pixelCopy = new Uint8Array(fullData.data);
    const res = processImage(
      { data: pixelCopy, width, height, channels: 4 },
      params
    );

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const outImgData = new ImageData(new Uint8ClampedArray(res.data.buffer), width, height);
    ctx.putImageData(outImgData, 0, 0);

    // Strictly enforce file size <= 2.0 MB (2 * 1024 * 1024 bytes)
    const MAX_BYTES = 2.0 * 1024 * 1024;
    let quality = 0.86;
    let blob = await new Promise((resolve) => canvas.toBlob(resolve, format, quality));

    // Adaptive compression if file exceeds 2MB
    let attempts = 0;
    while (blob && blob.size > MAX_BYTES && quality > 0.40 && attempts < 5) {
      attempts++;
      quality -= 0.12;
      blob = await new Promise((resolve) => canvas.toBlob(resolve, format, quality));
    }

    // Secondary fallback: downscale slightly if still over 2MB
    if (blob && blob.size > MAX_BYTES) {
      const scaleCanvas = document.createElement('canvas');
      const sW = Math.round(width * 0.80);
      const sH = Math.round(height * 0.80);
      scaleCanvas.width = sW;
      scaleCanvas.height = sH;
      const sCtx = scaleCanvas.getContext('2d');
      sCtx.drawImage(canvas, 0, 0, sW, sH);
      blob = await new Promise((resolve) => scaleCanvas.toBlob(resolve, format, 0.78));
    }

    const downloadUrl = URL.createObjectURL(blob);
    const ext = format === 'image/webp' ? '.webp' : '.jpg';
    let rawName = record.asset.name || 'underwater';
    rawName = rawName.replace(/\.[^/.]+$/, '');
    const filename = `freecolor-${rawName}${ext}`;

    return { blob, url: downloadUrl, filename, sizeBytes: blob ? blob.size : 0 };
  },

  getHealth() {
    return {
      ok: true,
      demoMode: true,
      ai: false,
      isOffline: true,
      presets: [
        { id: 'freedive', label: 'Freedive Time', tagline: 'Biru kobalt, skintone & detail 3D', base: PRESETS.freedive.base },
        { id: 'kreatif', label: 'Segar', tagline: 'Air bening, warna wajar', base: PRESETS.kreatif.base },
        { id: 'alami', label: 'Bening', tagline: 'Air apa adanya', base: PRESETS.alami.base },
        { id: 'super', label: 'Menyala', tagline: 'Lebih tegas, tetap wajar', base: PRESETS.super.base },
        { id: 'strobe', label: 'Sorot', tagline: 'Pusat frame paling terang', base: PRESETS.strobe.base },
        { id: 'lomba', label: 'Lomba', tagline: 'Standar juri', base: PRESETS.lomba.base },
      ],
      gears: [
        { id: 'umum', label: 'Umum', tagline: 'Tidak diubah', note: 'Bawaan kamera apa pun.' },
        { id: 'osmo', label: 'DJI Osmo', tagline: 'D-Log M datar', note: 'DJI Osmo Action.' },
        { id: 'gopro', label: 'GoPro', tagline: 'Protune datar', note: 'GoPro Hero.' },
        { id: 'mirrorless', label: 'Mirrorless', tagline: 'Warna sudah matang', note: 'Kamera mirrorless.' },
      ],
      limits: { maxUploadMb: 50, guest: 999999, daily: 9999 },
    };
  },
};
