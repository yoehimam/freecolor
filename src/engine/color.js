// Color math helpers for the FreeColor pipeline.
// All heavy operations are done on Float32Array planes so we never touch
// per-pixel objects (keeps 12 MP photos fast enough for a web app).

const LUT_SIZE = 4096;

const SRGB_TO_LIN = new Float32Array(LUT_SIZE + 1);
const LIN_TO_SRGB = new Float32Array(LUT_SIZE + 1);

for (let i = 0; i <= LUT_SIZE; i++) {
  const v = i / LUT_SIZE;
  SRGB_TO_LIN[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  LIN_TO_SRGB[i] = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const mix = (a, b, t) => a + (b - a) * t;

/** sRGB (0..1) -> linear light */
export function toLin(v) {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return SRGB_TO_LIN[(v * LUT_SIZE) | 0];
}

/** linear light -> sRGB (0..1) */
export function toSrgb(v) {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return LIN_TO_SRGB[(v * LUT_SIZE) | 0];
}

const HIST_BINS = 1024;

/** Approximate percentile of a float plane in [0,1]. */
export function percentile(plane, n, p) {
  const hist = new Uint32Array(HIST_BINS);
  const step = n > 1_500_000 ? 4 : n > 250_000 ? 3 : 1;
  let count = 0;
  for (let i = 0; i < n; i += step) {
    let v = plane[i];
    if (v < 0) v = 0;
    else if (v > 1) v = 1;
    hist[(v * (HIST_BINS - 1)) | 0]++;
    count++;
  }
  if (!count) return 0;
  const target = clamp01(p) * count;
  let acc = 0;
  for (let b = 0; b < HIST_BINS; b++) {
    acc += hist[b];
    if (acc >= target) return b / (HIST_BINS - 1);
  }
  return 1;
}

let _blurTmp = new Float32Array(0);
let _blurColSum = new Float32Array(0);

/**
 * Separable box blur with clamped edges.
 * Uses 100% row-major traversal for both horizontal and vertical passes
 * to eliminate CPU cache misses and reuses internal scratch buffers to prevent GC pauses.
 */
export function boxBlur(src, w, h, radius) {
  if (radius < 1) return Float32Array.from(src);
  const n = w * h;
  if (_blurTmp.length < n) _blurTmp = new Float32Array(n);
  if (_blurColSum.length < w) _blurColSum = new Float32Array(w);
  const tmp = _blurTmp;
  const colSum = _blurColSum;
  const out = new Float32Array(n);
  const invWin = 1 / (radius * 2 + 1);

  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = src[row] * (radius + 1);
    for (let k = 1; k <= radius; k++) {
      sum += src[row + (k < w ? k : w - 1)];
    }
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum * invWin;
      const l = x - radius;
      const r = x + radius + 1;
      sum += src[row + (r < w ? r : w - 1)] - src[row + (l > 0 ? l : 0)];
    }
  }

  for (let x = 0; x < w; x++) {
    colSum[x] = tmp[x] * (radius + 1);
  }
  for (let k = 1; k <= radius; k++) {
    const rOff = (k < h ? k : h - 1) * w;
    for (let x = 0; x < w; x++) {
      colSum[x] += tmp[rOff + x];
    }
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const topOff = (y - radius > 0 ? y - radius : 0) * w;
    const botOff = (y + radius + 1 < h ? y + radius + 1 : h - 1) * w;
    for (let x = 0; x < w; x++) {
      out[row + x] = colSum[x] * invWin;
      colSum[x] += tmp[botOff + x] - tmp[topOff + x];
    }
  }
  return out;
}

/** Bilinear resample of a small grid up to full resolution. */
export function bilinearUpsample(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  const xScale = sw / dw;
  const yScale = sh / dh;
  const maxX = sw - 1;
  const maxY = sh - 1;

  for (let y = 0; y < dh; y++) {
    let sy = (y + 0.5) * yScale - 0.5;
    sy = clamp(sy, 0, maxY);
    const y0 = sy | 0;
    const y1 = Math.min(y0 + 1, maxY);
    const wy = sy - y0;
    const r0 = y0 * sw;
    const r1 = y1 * sw;

    for (let x = 0; x < dw; x++) {
      let sx = (x + 0.5) * xScale - 0.5;
      sx = clamp(sx, 0, maxX);
      const x0 = sx | 0;
      const x1 = Math.min(x0 + 1, maxX);
      const wx = sx - x0;
      const a = src[r0 + x0] * (1 - wx) + src[r0 + x1] * wx;
      const b = src[r1 + x0] * (1 - wx) + src[r1 + x1] * wx;
      out[y * dw + x] = a * (1 - wy) + b * wy;
    }
  }
  return out;
}

export const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
