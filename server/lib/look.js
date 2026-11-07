// Reference photos.
//
// The owner saves photos whose colour he likes. What we keep from each is not a
// copy of the picture but its *measurement*: the exact channel ratio of the
// water, how bright that water is, and how the frame sits tonally. Renders can
// then steer their own water toward that ratio.
//
// Water is matched strongly. Warm tissue (coral, skin, turtle shell) is only
// nudged gently toward the gallery's warm hue while keeping its own brightness
// and structure, so a face or an animal is never repainted into something else.
// If a reference has no usable open water, the built-in azure sample is
// used and the entry says so.

import sharp from 'sharp';
import { REF_WATER } from './pipeline.js';

const SAMPLE_SIZE = 320;

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function normalise(rgb) {
  const sum = rgb[0] + rgb[1] + rgb[2];
  if (!(sum > 1e-4)) return null;
  return [rgb[0] / sum, rgb[1] / sum, rgb[2] / sum];
}

/** Hue of a normalised colour, 0-360. */
export function hueOf(ratio) {
  const [r, g, b] = ratio;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  if (d < 1e-5) return null;
  let h;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return Math.round((h + 360) % 360);
}

export function hueLabel(hue) {
  if (hue == null) return 'tanpa warna';
  if (hue >= 190 && hue <= 215) return 'azure dalam';
  if (hue > 215 && hue <= 240) return 'biru laut';
  if (hue > 240) return 'biru nila';
  if (hue >= 175 && hue < 190) return 'sian';
  if (hue >= 150 && hue < 175) return 'hijau laut';
  if (hue >= 90 && hue < 150) return 'hijau';
  return 'hangat';
}

const FALLBACK_RATIO = normalise(REF_WATER) || [0.05, 0.3, 0.65];

/**
 * Measure a reference photo.
 * @param {Buffer} buffer normalised jpeg
 */
export async function analyzeReference(buffer) {
  const { data, info } = await sharp(buffer)
    .rotate()
    .resize({ width: SAMPLE_SIZE, height: SAMPLE_SIZE, fit: 'inside' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const n = info.width * info.height;
  let wr = 0;
  let wg = 0;
  let wb = 0;
  let wc = 0;
  let wl = 0;
  let cr = 0;
  let cg = 0;
  let cb = 0;
  let cc = 0;
  let sl = 0;
  let sl2 = 0;
  let sat = 0;

  for (let i = 0; i < n; i++) {
    const s = i * 3;
    const r = data[s] / 255;
    const g = data[s + 1] / 255;
    const b = data[s + 2] / 255;
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sl += l;
    sl2 += l * l;

    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    sat += mx > 0.01 ? (mx - mn) / mx : 0;

    // Open water: blue clearly ahead of red, not black, not blown out.
    if (b > r * 1.35 && b > g * 1.02 && l > 0.1 && l < 0.94) {
      wr += r;
      wg += g;
      wb += b;
      wl += l;
      wc++;
    }

    // Warm tissue (coral, fish, skin): recorded for the entry's description,
    // never used to repaint anyone else's coral.
    if (r > b * 1.18 && mx > 0.12 && l > 0.06 && l < 0.96) {
      cr += r;
      cg += g;
      cb += b;
      cc++;
    }
  }

  const meanL = sl / n;
  const stdL = Math.sqrt(Math.max(0, sl2 / n - meanL * meanL));
  const waterShare = wc / n;

  let water = null;
  if (wc > n * 0.04) {
    const ratio = normalise([wr / wc, wg / wc, wb / wc]);
    if (ratio) {
      const hue = hueOf(ratio);
      water = {
        ratio,
        hue,
        hueLabel: hueLabel(hue),
        luma: Math.round((wl / wc) * 1000) / 1000,
        share: Math.round(waterShare * 1000) / 10,
        source: 'foto',
      };
    }
  }

  if (!water) {
    const hue = hueOf(FALLBACK_RATIO);
    water = {
      ratio: FALLBACK_RATIO,
      hue,
      hueLabel: hueLabel(hue),
      luma: 0.45,
      share: 0,
      source: 'bawaan',
    };
  }

  const warm = cc > n * 0.01 ? normalise([cr / cc, cg / cc, cb / cc]) : null;

  return {
    water,
    warm: warm
      ? {
          ratio: warm,
          hue: hueOf(warm),
          share: Math.round((cc / n) * 1000) / 10,
        }
      : null,
    tone: {
      luma: Math.round(meanL * 1000) / 1000,
      contrast: Math.round(stdL * 1000) / 1000,
      sat: Math.round((sat / n) * 1000) / 1000,
    },
    analyzedAt: Date.now(),
  };
}

/** Compact shape sent to the UI. */
export function publicLook(look) {
  if (!look || !look.water) return null;
  return {
    water: look.water,
    warm: look.warm || null,
    tone: look.tone || null,
    count: look.count || undefined,
    swatch: look.water.ratio.map((v) => Math.round(v * 255)),
    warmSwatch: look.warm?.ratio ? look.warm.ratio.map((v) => Math.round(v * 255)) : null,
  };
}

function median(values) {
  const arr = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!arr.length) return null;
  const mid = arr.length >> 1;
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function medianRatio(ratios) {
  if (!ratios.length) return null;
  return normalise([median(ratios.map((r) => r[0])), median(ratios.map((r) => r[1])), median(ratios.map((r) => r[2]))]);
}

/**
 * Blend many reference measurements into one "gallery style".
 * Per-channel medians are used so one odd photo (a green-water shot in a
 * gallery of blue ones) cannot drag the whole style off course.
 * @param {Array<object>} looks
 */
export function blendLooks(looks) {
  const valid = (looks || []).filter((l) => l && l.water);
  if (!valid.length) return null;

  const realWater = valid.filter((l) => l.water.source === 'foto');
  const waterSet = realWater.length ? realWater : valid;
  const waterRatio = medianRatio(waterSet.map((l) => l.water.ratio)) || FALLBACK_RATIO;
  const waterHue = hueOf(waterRatio);

  const warmSet = valid.filter((l) => l.warm && Array.isArray(l.warm.ratio));
  const warmRatio = warmSet.length ? medianRatio(warmSet.map((l) => l.warm.ratio)) : null;

  const tones = valid.filter((l) => l.tone);
  const round3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);

  return {
    water: {
      ratio: waterRatio,
      hue: waterHue,
      hueLabel: hueLabel(waterHue),
      luma: round3(median(waterSet.map((l) => l.water.luma))) ?? 0.45,
      share: round3(median(waterSet.map((l) => l.water.share))) ?? 0,
      source: realWater.length ? 'galeri' : 'bawaan',
    },
    warm: warmRatio
      ? { ratio: warmRatio, hue: hueOf(warmRatio), share: round3(median(warmSet.map((l) => l.warm.share))) }
      : null,
    tone: tones.length
      ? {
          luma: round3(median(tones.map((l) => l.tone.luma))),
          contrast: round3(median(tones.map((l) => l.tone.contrast))),
          sat: round3(median(tones.map((l) => l.tone.sat))),
        }
      : null,
    count: valid.length,
    analyzedAt: Date.now(),
  };
}
