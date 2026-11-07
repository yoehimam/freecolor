import { processImage, prepareSourceCache } from '../engine/pipeline.js';
import { applyGrade } from '../engine/grade.js';

let cachedSource = null;

self.onmessage = function (e) {
  const { id, type, buffer, width, height, params, options } = e.data;

  if (type === 'initSource') {
    const data = new Uint8Array(buffer);
    cachedSource = prepareSourceCache({ data, width, height, channels: 4 });
    self.postMessage({ id, type: 'initSourceDone' });
    return;
  }

  if (type === 'render') {
    const srcData = new Uint8Array(buffer);
    const pixelCopy = new Uint8Array(srcData);
    const t0 = performance.now();
    const res = processImage(
      { data: pixelCopy, width, height, channels: 4 },
      params,
      { sourceCache: cachedSource, ...(options || {}) }
    );
    applyGrade(res.data, width, height, params);
    const ms = Math.round(performance.now() - t0);

    self.postMessage(
      {
        id,
        type: 'renderDone',
        buffer: res.data.buffer,
        width,
        height,
        ms,
        metrics: res.metrics,
      },
      [res.data.buffer]
    );
  }
};
