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
  const step = n > 1_500_000 ? 3 : 1;
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

/**
 * Separable box blur with clamped edges. Small radii are used for
 * transmission-map smoothing and unsharp masking.
 */
export function boxBlur(src, w, h, radius) {
  if (radius < 1) return Float32Array.from(src);
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const win = radius * 2 + 1;

  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += src[row + clamp(k, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / win;
      sum -= src[row + clamp(x - radius, 0, w - 1)];
      sum += src[row + clamp(x + radius + 1, 0, w - 1)];
    }
  }

  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += tmp[clamp(k, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / win;
      sum -= tmp[clamp(y - radius, 0, h - 1) * w + x];
      sum += tmp[clamp(y + radius + 1, 0, h - 1) * w + x];
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
