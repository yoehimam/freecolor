// FreeColor - Grading stage (Ocean Edit style, fully transparent & deterministic).
// Runs AFTER the underwater restoration pipeline on the RGBA buffer:
//   1. White balance gains (eyedropper / manual)
//   2. Linear gradient exposure (top / bottom)
//   3. Master + per-channel RGB curves (shadow / mid / highlight points)
//   4. Split toning (shadow & highlight tint)
// None of these touch AI. Everything is local math.

export const CURVE_CHANNELS = [
  { id: 'm', label: 'Utama', color: '#0b4a6f' },
  { id: 'r', label: 'Merah', color: '#e5484d' },
  { id: 'g', label: 'Hijau', color: '#2ca56b' },
  { id: 'b', label: 'Biru', color: '#1d78e6' },
];

export const GRADE_DEFAULTS = {
  wbR: 1,
  wbG: 1,
  wbB: 1,
  gradTop: 0,
  gradBottom: 0,
  splitShadowHue: 215,
  splitShadowAmt: 0,
  splitHighHue: 42,
  splitHighAmt: 0,
};
for (const c of CURVE_CHANNELS) {
  GRADE_DEFAULTS[`cv_${c.id}_s`] = 0;
  GRADE_DEFAULTS[`cv_${c.id}_m`] = 0;
  GRADE_DEFAULTS[`cv_${c.id}_h`] = 0;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== undefined && v !== '' ? Number(v) : d);

const XS = [0, 0.25, 0.5, 0.75, 1];

/** Monotone cubic (Fritsch-Carlson) through 5 control points -> 256-entry LUT. */
export function buildCurveLut(s = 0, m = 0, h = 0) {
  const ys = [0, 0.25 + s * 0.003, 0.5 + m * 0.003, 0.75 + h * 0.003, 1].map(clamp01);
  for (let i = 1; i < ys.length; i++) ys[i] = Math.max(ys[i], ys[i - 1]);

  const n = XS.length;
  const dx = [];
  const sl = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(XS[i + 1] - XS[i]);
    sl.push((ys[i + 1] - ys[i]) / dx[i]);
  }
  const t = new Array(n);
  t[0] = sl[0];
  t[n - 1] = sl[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = sl[i - 1] * sl[i] <= 0 ? 0 : (sl[i - 1] + sl[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (sl[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
    } else {
      const a = t[i] / sl[i];
      const b = t[i + 1] / sl[i];
      const hyp = Math.hypot(a, b);
      if (hyp > 3) {
        const k = 3 / hyp;
        t[i] = k * a * sl[i];
        t[i + 1] = k * b * sl[i];
      }
    }
  }

  const lut = new Float32Array(256);
  for (let k = 0; k < 256; k++) {
    const x = k / 255;
    let seg = 0;
    while (seg < n - 2 && x > XS[seg + 1]) seg++;
    const hh = dx[seg];
    const u = (x - XS[seg]) / hh;
    const u2 = u * u;
    const u3 = u2 * u;
    const y =
      (2 * u3 - 3 * u2 + 1) * ys[seg] +
      (u3 - 2 * u2 + u) * hh * t[seg] +
      (-2 * u3 + 3 * u2) * ys[seg + 1] +
      (u3 - u2) * hh * t[seg + 1];
    lut[k] = clamp01(y);
  }
  return lut;
}

/** Sample points of a curve (for drawing in the UI). */
export function curvePath(s, m, h, size = 100, steps = 40) {
  const lut = buildCurveLut(s, m, h);
  let d = '';
  for (let i = 0; i <= steps; i++) {
    const x = i / steps;
    const y = lut[Math.round(x * 255)];
    d += `${i === 0 ? 'M' : 'L'}${(x * size).toFixed(2)} ${((1 - y) * size).toFixed(2)} `;
  }
  return d;
}

function hueToRgb(hDeg) {
  const h = (((hDeg % 360) + 360) % 360) / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  if (h < 1) return [1, x, 0];
  if (h < 2) return [x, 1, 0];
  if (h < 3) return [0, 1, x];
  if (h < 4) return [0, x, 1];
  if (h < 5) return [x, 0, 1];
  return [1, 0, x];
}

export function hasGrade(p = {}) {
  for (const k of Object.keys(GRADE_DEFAULTS)) {
    if (k === 'splitShadowHue' || k === 'splitHighHue') continue;
    if (Math.abs(num(p[k], GRADE_DEFAULTS[k]) - GRADE_DEFAULTS[k]) > 1e-3) return true;
  }
  return false;
}

/** Mutates an RGBA Uint8 buffer in place. */
export function applyGrade(data, w, h, p = {}) {
  if (!hasGrade(p)) return data;
  const g = (k) => num(p[k], GRADE_DEFAULTS[k]);

  const wbR = g('wbR');
  const wbG = g('wbG');
  const wbB = g('wbB');
  const gradTop = g('gradTop') / 50;
  const gradBottom = g('gradBottom') / 50;

  const luts = {};
  let anyCurve = false;
  for (const c of CURVE_CHANNELS) {
    const s = g(`cv_${c.id}_s`);
    const m = g(`cv_${c.id}_m`);
    const hi = g(`cv_${c.id}_h`);
    if (s || m || hi) anyCurve = true;
    luts[c.id] = s || m || hi ? buildCurveLut(s, m, hi) : null;
  }
  const lutM = luts.m;
  const lutR = luts.r;
  const lutG = luts.g;
  const lutB = luts.b;

  const shAmt = g('splitShadowAmt') / 100;
  const hiAmt = g('splitHighAmt') / 100;
  const shRgb = hueToRgb(g('splitShadowHue'));
  const hiRgb = hueToRgb(g('splitHighHue'));
  const shLum = 0.2126 * shRgb[0] + 0.7152 * shRgb[1] + 0.0722 * shRgb[2];
  const hiLum = 0.2126 * hiRgb[0] + 0.7152 * hiRgb[1] + 0.0722 * hiRgb[2];

  const useWb = wbR !== 1 || wbG !== 1 || wbB !== 1;
  const useGrad = gradTop !== 0 || gradBottom !== 0;
  const useSplit = shAmt > 0 || hiAmt > 0;

  const smooth = (t) => {
    const c = clamp01(t);
    return c * c * (3 - 2 * c);
  };
  const hm1 = Math.max(1, h - 1);

  for (let y = 0; y < h; y++) {
    let gradMul = 1;
    if (useGrad) {
      const yn = y / hm1;
      const wt = smooth(1 - yn / 0.55);
      const wb = smooth((yn - 0.45) / 0.55);
      gradMul = Math.pow(2, gradTop * wt + gradBottom * wb);
    }
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      const o = row + x * 4;
      let r = data[o] / 255;
      let gg = data[o + 1] / 255;
      let b = data[o + 2] / 255;

      if (useWb) {
        r *= wbR;
        gg *= wbG;
        b *= wbB;
      }
      if (useGrad) {
        r *= gradMul;
        gg *= gradMul;
        b *= gradMul;
      }
      if (anyCurve) {
        let ri = Math.round(clamp01(r) * 255);
        let gi = Math.round(clamp01(gg) * 255);
        let bi = Math.round(clamp01(b) * 255);
        if (lutM) {
          ri = Math.round(lutM[ri] * 255);
          gi = Math.round(lutM[gi] * 255);
          bi = Math.round(lutM[bi] * 255);
        }
        r = lutR ? lutR[ri] : ri / 255;
        gg = lutG ? lutG[gi] : gi / 255;
        b = lutB ? lutB[bi] : bi / 255;
      }
      if (useSplit) {
        const l = clamp01(0.2126 * r + 0.7152 * gg + 0.0722 * b);
        const ws = (1 - l) * (1 - l) * shAmt * 0.35;
        const wh = l * l * hiAmt * 0.35;
        r += (shRgb[0] - shLum) * ws + (hiRgb[0] - hiLum) * wh;
        gg += (shRgb[1] - shLum) * ws + (hiRgb[1] - hiLum) * wh;
        b += (shRgb[2] - shLum) * ws + (hiRgb[2] - hiLum) * wh;
      }

      data[o] = clamp01(r) * 255 + 0.5;
      data[o + 1] = clamp01(gg) * 255 + 0.5;
      data[o + 2] = clamp01(b) * 255 + 0.5;
    }
  }
  return data;
}

/**
 * Given the colour that is currently displayed at the picked point (0-255),
 * return new white-balance gains that make that point neutral.
 */
export function wbFromPick(rgb, current = {}) {
  const [r, g, b] = rgb.map((v) => Math.max(8, v));
  const mean = (r + g + b) / 3;
  const clampGain = (v) => Math.min(2.6, Math.max(0.4, v));
  return {
    wbR: clampGain(num(current.wbR, 1) * (mean / r)),
    wbG: clampGain(num(current.wbG, 1) * (mean / g)),
    wbB: clampGain(num(current.wbB, 1) * (mean / b)),
  };
}
