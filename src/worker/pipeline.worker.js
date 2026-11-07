import { processImage, prepareSourceCache } from '../engine/pipeline.js';
import { applyGrade } from '../engine/grade.js';

let currentAssetId = null;
let cachedSource = null;
let cachedRawSource = null;
let cachedWidth = 0;
let cachedHeight = 0;

self.onmessage = function (e) {
  const { id, type, assetId, buffer, width, height, params, options } = e.data;

  if (type === 'initSource') {
    currentAssetId = assetId;
    cachedWidth = width;
    cachedHeight = height;
    cachedRawSource = new Uint8Array(buffer);
    cachedSource = prepareSourceCache({ data: cachedRawSource, width, height, channels: 4 });
    self.postMessage({ id, type: 'initSourceDone', assetId });
    return;
  }

  if (type === 'render') {
    const t0 = performance.now();
    let pixelCopy;
    let w = width || cachedWidth;
    let h = height || cachedHeight;

    if (buffer) {
      const src = new Uint8Array(buffer);
      pixelCopy = new Uint8Array(src);
    } else if (cachedRawSource) {
      pixelCopy = new Uint8Array(cachedRawSource.length);
      pixelCopy.set(cachedRawSource);
    } else {
      self.postMessage({ id, type: 'renderError', error: 'No source image initialized' });
      return;
    }

    const res = processImage(
      { data: pixelCopy, width: w, height: h, channels: 4 },
      params,
      { sourceCache: cachedSource, ...(options || {}) }
    );
    applyGrade(res.data, w, h, params);
    const ms = Math.round(performance.now() - t0);

    self.postMessage(
      {
        id,
        type: 'renderDone',
        buffer: res.data.buffer,
        width: w,
        height: h,
        ms,
        metrics: res.metrics,
      },
      [res.data.buffer]
    );
  }
};
