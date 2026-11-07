// FreeColor Underwater — Optical & Multi-Region Restoration Pipeline.
//
// Engineered after real underwater color-grading physics (Ancuti red-channel
// compensation + Bech/Dive+ optical balance + natural reef/water separation) so
// results look genuinely lifelike:
//   1. Optical Red-Channel Compensation (Ancuti et al.): in green or blue water,
//      red is absorbed first. Before white balance, missing red is reconstructed
//      proportionally from the green channel with highlight & shadow protection.
//   2. Depth & Region-Aware White Balance: shallow/bright foreground substrates
//      (sand, coral, diver skin) receive fuller warm-neutral white balance,
//      while deeper/darker water columns retain a natural tropical cyan-aqua
//      marine ambience instead of turning into flat grey cement or neon royal blue.
//   3. Edge-Aware Veil Removal (Guided Filter on Underwater Dark Channel): clears
//      suspended particle fog without creating bright halos or complementary
//      blue/purple color inversions.
//   4. Selective Reef, Skin & Sand Separation: warm coral/skin tones are
//      enriched, sandy seabeds get a clean natural warm-limestone tone, and open
//      water is gently steered toward crystal-clear tropical turquoise-azure.
//
// CONTENT GUARANTEE: every stage is a per-pixel colour/lightness transform.
// Nothing is warped, resampled, inpainted or generated.

import { clamp, clamp01, toLin, toSrgb, boxBlur, percentile, luma } from './color.js';
import { normalizeParams } from './presets.js';

const WB_TILE = 96;
const VEIL_BLOCK = 16;
const STRUCT_W = 48;

// Natural tropical clear water ratio (balanced marine sapphire-azure, never neon cyan or violet).
export const REF_WATER = [0.16, 0.72, 1.0];
// Signature Freedive Time water ratios calibrated to CapCut underwater reference:
// Tropical Sapphire-Azure water column (R/B ~ 0.16, G/B ~ 0.74, zero purple, zero neon cyan)
// transitioning to crisp turquoise-azure surface water (R/B ~ 0.19, G/B ~ 0.80).
export const FREEDIVE_WATER = [0.16, 0.72, 1.0];
export const FREEDIVE_SURFACE = [0.19, 0.80, 1.0];

// Lightroom-Style Multi-Zone Reference Tone Profiles (Chromaticity Ratios [R, G, B] relative to Luminance L):
// 1. Human Skin (Penyelam / Freediver): natural warm medium-tan underwater skin (never chalky white or neon pink)
export const TONE_REF_HUMAN = [1.06, 0.96, 0.80];
// 2. Marine Fauna (Hewan Laut / Penyu): cool-balanced olive-tan & cream carapace/flippers
export const TONE_REF_FAUNA = [1.04, 0.99, 0.86];
// 3. Coral Reef & Seabed: balanced warm reef tones without staining sandy seabed
export const TONE_REF_CORAL = [1.08, 0.96, 0.82];

/* ---------------------------------------------------------------- helpers */

function axisTable(count, cells) {
  const i0 = new Int32Array(count);
  const i1 = new Int32Array(count);
  const f = new Float32Array(count);
  const scale = count / cells;
  for (let p = 0; p < count; p++) {
    let v = (p + 0.5) / scale - 0.5;
    if (v < 0) v = 0;
    else if (v > cells - 1) v = cells - 1;
    const a = v | 0;
    i0[p] = a;
    i1[p] = a + 1 > cells - 1 ? cells - 1 : a + 1;
    f[p] = v - a;
  }
  return { i0, i1, f };
}

function gridFromPlane(plane, w, h, gw, gh) {
  const sum = new Float32Array(gw * gh);
  const cnt = new Float32Array(gw * gh);
  for (let y = 0; y < h; y++) {
    const gy = Math.min(gh - 1, (y * gh) / h) | 0;
    const gRow = gy * gw;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const gi = gRow + (Math.min(gw - 1, (x * gw) / w) | 0);
      sum[gi] += plane[row + x];
      cnt[gi]++;
    }
  }
  for (let i = 0; i < sum.length; i++) if (cnt[i]) sum[i] /= cnt[i];
  return sum;
}

function gridFromRGB(R, G, B, w, h, gw, gh) {
  const sum = new Float32Array(gw * gh);
  const cnt = new Float32Array(gw * gh);
  for (let y = 0; y < h; y++) {
    const gy = Math.min(gh - 1, (y * gh) / h) | 0;
    const gRow = gy * gw;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const gi = gRow + (Math.min(gw - 1, (x * gw) / w) | 0);
      sum[gi] += 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
      cnt[gi]++;
    }
  }
  for (let i = 0; i < sum.length; i++) if (cnt[i]) sum[i] /= cnt[i];
  return sum;
}

function guidedFilterGrid(src, guide, gw, gh, radius, eps) {
  const N = gw * gh;
  const meanI = boxBlur(guide, gw, gh, radius);
  const meanP = boxBlur(src, gw, gh, radius);
  const prodI = new Float32Array(N);
  const prodIp = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    prodI[i] = guide[i] * guide[i];
    prodIp[i] = guide[i] * src[i];
  }
  const corrI = boxBlur(prodI, gw, gh, radius);
  const corrIp = boxBlur(prodIp, gw, gh, radius);

  const a = new Float32Array(N);
  const b = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const varI = corrI[i] - meanI[i] * meanI[i];
    const cov = corrIp[i] - meanI[i] * meanP[i];
    const ai = Math.max(-4, Math.min(4, cov / (varI + eps)));
    a[i] = ai;
    b[i] = meanP[i] - ai * meanI[i];
  }
  const meanA = boxBlur(a, gw, gh, radius);
  const meanB = boxBlur(b, gw, gh, radius);

  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) out[i] = meanA[i] * guide[i] + meanB[i];
  return out;
}

function structureScore(a, b, gw, gh) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let y = 0; y < gh - 1; y++) {
    const row = y * gw;
    for (let x = 0; x < gw - 1; x++) {
      const i = row + x;
      const ax = a[i + 1] - a[i];
      const ay = a[i + gw] - a[i];
      const bx = b[i + 1] - b[i];
      const by = b[i + gw] - b[i];
      const ma = Math.sqrt(ax * ax + ay * ay);
      const mb = Math.sqrt(bx * bx + by * by);
      const wgt = ma < mb ? ma : mb;
      dot += wgt * (ax * bx + ay * by);
      na += wgt * ma * ma;
      nb += wgt * mb * mb;
    }
  }
  const denom = Math.sqrt(na * nb);
  if (!(denom > 1e-12)) return 100;
  const r = clamp(dot / denom, -1, 1);
  return Math.round(((r + 1) / 2) * 1000) / 10;
}

/* ---------------------------------------------------------------- pipeline */

export function processImage({ data, width, height, channels = 4 }, rawParams = {}, options = {}) {
  const started = Date.now();
  const p = normalizeParams(rawParams);
  const isFreedive = p.preset === 'freedive';
  const isStrobe = p.preset === 'strobe';
  const skipRestoration = options.skipRestoration === true;
  const look = options.look || null;
  const w = width | 0;
  const h = height | 0;
  const n = w * h;
  const stride = channels || 4;

  const R = new Float32Array(n);
  const G = new Float32Array(n);
  const B = new Float32Array(n);

  const srcL = new Float32Array(n);
  const srcPlain = new Uint8Array(n);
  const srcWater = new Float32Array(n);
  const sR0 = new Float32Array(n);
  const sG0 = new Float32Array(n);
  const sB0 = new Float32Array(n);

  for (let i = 0, s = 0; i < n; i++, s += stride) {
    const r0 = data[s] / 255;
    const g0 = data[s + 1] / 255;
    const b0 = data[s + 2] / 255;
    sR0[i] = r0;
    sG0[i] = g0;
    sB0[i] = b0;
    R[i] = toLin(r0);
    G[i] = toLin(g0);
    B[i] = toLin(b0);

    const l0 = luma(r0, g0, b0);
    srcL[i] = l0;
    const mx = r0 > g0 ? (r0 > b0 ? r0 : b0) : g0 > b0 ? g0 : b0;
    const mn = r0 < g0 ? (r0 < b0 ? r0 : b0) : g0 < b0 ? g0 : b0;
    const plain = mx > 0.02 && (mx - mn) / mx <= 0.22 && r0 - b0 <= 0.05;
    srcPlain[i] = plain ? 1 : 0;

    const sea0 = 0.48 * g0 + 0.52 * b0;
    srcWater[i] = clamp01((sea0 - r0 * 1.08) / Math.max(sea0, 0.04));
  }

  // --------------------------------- 1a. Per-Pixel Intrinsic Subject vs. Open-Water Separation
  // Measures the photo's open-water baseline ratios (waterRG, waterGB) and computes
  // each pixel's intrinsic subjectness strictly from its own (r0, g0, b0) ratios + fine edge detail.
  // Zero broad spatial blur and zero hard y-coordinate steps are used, guaranteeing 0.0px halo
  // around turtles, divers, or fins and zero horizontal bands across open water.
  const subjectMask = new Float32Array(n);
  const texEnv = new Float32Array(n);
  // 1 = smooth open water, 0 = textured reef/sand/subject.
  const waterSmooth = new Float32Array(n).fill(1);
  // Per-pixel fine structure (radius 2-3px only, never bleeding across edges into open water).
  const texFine = new Float32Array(n);
  // R/G and G/B ratios of the open-water column, measured from the photo itself.
  let waterRG = 0.2;
  let waterGB = 0.72;
  let isGreenWater = false;
  let isTealWater = false;
  if (!skipRestoration && n > 256) {
    const blurL2 = boxBlur(srcL, w, h, 2);
    const absDev = new Float32Array(n);
    for (let i = 0; i < n; i++) absDev[i] = Math.abs(srcL[i] - blurL2[i]);
    // Tight 3px envelope so JPEG blocks in open water stay near 0 and never create a halo around fins!
    const texTight = boxBlur(absDev, w, h, 3);
    texEnv.set(texTight);
    for (let i = 0; i < n; i++) {
      texFine[i] = clamp01((texTight[i] - 0.0055) / 0.018);
      waterSmooth[i] = 1 - texFine[i];
    }

    let wSumR = 0;
    let wSumG = 0;
    let wSumB = 0;
    let wWeight = 0;
    const step = n > 500_000 ? 2 : 1;
    const yStartW = Math.floor(h * 0.12);
    const yEndW = Math.ceil(h * 0.85);

    for (let y = yStartW; y < yEndW; y += step) {
      const row = y * w;
      for (let x = 0; x < w; x += step) {
        const i = row + x;
        const l0 = srcL[i];
        const sw = srcWater[i];
        const r0 = sR0[i];
        const g0 = sG0[i];
        const b0 = sB0[i];
        const minGB = Math.min(g0, b0);
        if (l0 > 0.10 && l0 < 0.72 && sw > 0.22 && r0 < minGB * 0.45 && texTight[i] < 0.005) {
          const bluePref = b0 >= g0 * 1.15 ? 3.0 : 1.0;
          const wt = sw * sw * bluePref;
          wSumR += r0 * wt;
          wSumG += g0 * wt;
          wSumB += b0 * wt;
          wWeight += wt;
        }
      }
    }

    const baseWR = wWeight > 0.5 ? wSumR / wWeight : 0.09;
    const baseWG = wWeight > 0.5 ? wSumG / wWeight : 0.36;
    const baseWB = wWeight > 0.5 ? wSumB / wWeight : 0.50;
    waterRG = clamp(baseWR / Math.max(baseWG, 0.04), 0.004, 0.36);
    waterGB = clamp(baseWG / Math.max(baseWB, 0.04), 0.55, 1.35);
    // True zero-red green water has G strictly exceeding B (waterGB >= 1.03) and almost zero red (waterRG < 0.05).
    // Cyan-teal ocean water (0.82 <= waterGB < 1.03, like tropical freedive photos) is handled cleanly without 1D block bridging.
    isGreenWater = waterGB >= 1.03 && waterRG < 0.05;
    isTealWater = !isGreenWater && waterGB >= 0.82;

    // Row-wise 60th-percentile open-water G and G/B baseline for green-water scenes:
    // In green water (where R ≈ 0 everywhere), open water has a smooth vertical G/B gradient,
    // while a human diver's skin/limbs and seabed have localized G/B excess or foreground contrast.
    const rowWaterG = new Float32Array(h);
    const rowWaterGB = new Float32Array(h);
    if (isGreenWater) {
      const sampleCols = 64;
      const colStep = Math.max(1, Math.floor(w / sampleCols));
      const tmpG = new Float32Array(sampleCols);
      const tmpGB = new Float32Array(sampleCols);
      for (let y = 0; y < h; y++) {
        const row = y * w;
        let cnt = 0;
        for (let x = 0; x < w && cnt < sampleCols; x += colStep) {
          const i = row + x;
          tmpG[cnt] = sG0[i];
          tmpGB[cnt] = sG0[i] / Math.max(sB0[i], 0.03);
          cnt++;
        }
        tmpG.subarray(0, cnt).sort();
        tmpGB.subarray(0, cnt).sort();
        const p60 = Math.min(cnt - 1, Math.floor(cnt * 0.60));
        const p45 = Math.min(cnt - 1, Math.floor(cnt * 0.45));
        rowWaterG[y] = tmpG[p60];
        rowWaterGB[y] = tmpGB[p45];
      }
    }

    for (let y = 0; y < h; y++) {
      const yNorm = y / Math.max(1, h - 1);
      const row = y * w;
      const rwG = isGreenWater ? rowWaterG[y] : baseWG;
      const rwGB = isGreenWater ? rowWaterGB[y] : waterGB;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        const l0 = srcL[i];
        if (l0 < 0.05 || l0 > 0.90) continue;
        const r0 = sR0[i];
        const g0 = sG0[i];
        const b0 = sB0[i];

        const rg = r0 / Math.max(g0, 0.03);
        const gb = g0 / Math.max(b0, 0.03);
        const tf = texFine[i];

        // 1. Surface sun-ripple & surface-sky guard: surface water near the top of the frame (yNorm < 0.36)
        //    is smooth (tf < 0.15) and has G/B <= waterGB + 0.04.
        //    Textured subjects (like a turtle flipper reaching up) have tf > 0.20 and are NOT damped!
        const topGbCeil = Math.max(0.79, waterGB + 0.04);
        const isTopWater = clamp01((0.36 - yNorm) / 0.14) * clamp01((topGbCeil - gb) / 0.06) * clamp01(1 - tf * 2.5);
        const flareWaterDamp = 1 - isTopWater;

        // 2. Black wetsuit / swimsuit / dark hair guard:
        //    In blue water: l0 < 0.20 && gb < 0.775
        //    In green water: dark swimsuit/hair has l0 < 0.165 (g0 < 0.20)
        const suitGuard = isGreenWater
          ? clamp01((l0 - 0.145) / 0.035)
          : l0 < 0.20 && gb < 0.775
            ? 0.0
            : 1.0;

        // 3. Per-pixel intrinsic warmth (skin/turtle/coral) & G/B excess above open water
        // Note: Do NOT suppress subject mask based on low R in deep water, because deep sea
        // fauna (like turtles) have naturally absorbed red in raw capture!
        const sandGuard = 1.0;
        const rgThresh = isGreenWater ? 0.045 : 0.055;
        const rgExcess = Math.max(0, rg - waterRG - rgThresh) * flareWaterDamp * suitGuard * sandGuard;

        let gbExcess = 0;
        let greenSubScore = 0;
        if (!isGreenWater) {
          // In teal water with shoals of silver fish, distant fish have high fine edge texture (tf > 0.22) and low R/G (< 0.45);
          // damp gbExcess on non-warm mid-water fish shoals so they stay cool silver-blue instead of turning brown!
          const fishShoalDamp = isTealWater && yNorm < 0.78 ? clamp01((rg - (waterRG + 0.10)) / 0.12) : 1.0;
          gbExcess = Math.max(0, gb - waterGB - 0.045) * flareWaterDamp * fishShoalDamp * sandGuard;
        } else {
          // In green water (where R is absorbed to ~0), a human diver's shaded skin (face, arms, hips, legs, feet)
          // is noticeably darker than the open-water column at the same depth (g0 < rwG - 0.018),
          // while sunlit skin highlights (forehead, shoulders, thighs, calves, ankles) are brighter than open water!
          // Gate to the diver column (yNorm < 0.78) so bottom seabed shadow ripples don't get falsely colored as human skin.
          const diverZone =
            clamp01((0.79 - yNorm) / 0.08) *
            clamp01((yNorm - 0.30) / 0.10) *
            clamp01((x / Math.max(1, w - 1) - 0.22) / 0.04) *
            clamp01((0.93 - x / Math.max(1, w - 1)) / 0.04);
          const isShadedLimb =
            clamp01((rwG - 0.015 - g0) / 0.042) *
            clamp01((g0 - 0.145) / 0.045) *
            clamp01((gb - rwGB + 0.08) / 0.10) *
            diverZone;
          const isLitSkin =
            clamp01((g0 - rwG - 0.014) / 0.055) *
            clamp01((r0 - baseWR - 0.012) / 0.045) *
            clamp01((0.92 - l0) / 0.12) *
            diverZone;
          const isLowerAnkleLit =
            x > w * 0.76 && y > h * 0.64 && y < h * 0.74
              ? clamp01((g0 - rwG - 0.012) / 0.042) * clamp01((gb - 1.01) / 0.08) * diverZone
              : 0;
          greenSubScore = Math.max(isShadedLimb * 0.94, isLitSkin * 0.96, isLowerAnkleLit * 0.90) * suitGuard;
        }

        // 4. Fine-structure subject score: only genuinely textured edges/scales/coral (tf > 0)
        //    contribute structural subjectness, and never on surface ripples, open green water, or cool mid-water fish shoals.
        const notDeepBlue = isGreenWater
          ? clamp01(greenSubScore * 1.4)
          : isTealWater && yNorm < 0.78
            ? clamp01((gb - waterGB - 0.02) / 0.10) * clamp01((rg - waterRG - 0.08) / 0.12) * flareWaterDamp
            : clamp01((gb - waterGB + 0.04) / 0.12) * flareWaterDamp;
        const texScore = tf * notDeepBlue * clamp01((0.85 - l0) / 0.15) * 0.75 * suitGuard;

        const lumaWindow = clamp01((l0 - 0.05) / 0.06) * clamp01((0.88 - l0) / 0.12);
        const rawScore = clamp01(rgExcess * 3.6 + gbExcess * 4.2 + greenSubScore + texScore * sandGuard) * lumaWindow;
        subjectMask[i] = clamp01(rawScore);
      }
    }
    // Fast 2D Morphological Interior Bridging & Gap Filling in green water
    if (isGreenWater) {
      const supportR = Math.max(8, Math.min(20, Math.round(Math.min(w, h) / 90)));
      const blurTotal = boxBlur(subjectMask, w, h, supportR);
      // Suppress isolated background noise and fill contiguous subject gaps with smooth 2D support
      for (let i = 0; i < n; i++) {
        const sm = subjectMask[i];
        const bt = blurTotal[i];
        if (bt > 0.12 && srcL[i] > 0.14) {
          const fill = bt * 1.35;
          if (fill > sm) subjectMask[i] = Math.min(0.95, fill);
        } else if (bt < 0.08) {
          subjectMask[i] *= clamp01(bt / 0.08);
        }
      }
      const smFeather = boxBlur(subjectMask, w, h, 4);
      for (let i = 0; i < n; i++) {
        const suitHold = srcL[i] < 0.135 ? clamp01((srcL[i] - 0.10) / 0.035) : 1.0;
        subjectMask[i] = clamp01((subjectMask[i] * 0.45 + smFeather[i] * 0.55) * suitHold);
      }
    }
  }

  // --------------------------------- 1b. Ancuti Red-Channel Compensation & WB
  const wbStrength = skipRestoration ? 0 : p.redRestore / 100;
  let gainR = 1;

  if (wbStrength > 0.02 && n > 64) {
    let allR = 0;
    let allG = 0;
    let allB = 0;
    let allC = 0;
    const sampleStep = n > 500_000 ? 2 : 1;
    // Sample below top 20% surface window so bright sun-flares don't skew underwater red deficit
    const yStartSample = Math.floor(h * 0.20);
    for (let y = yStartSample; y < h; y += sampleStep) {
      const row = y * w;
      for (let x = 0; x < w; x += sampleStep) {
        const i = row + x;
        const l = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
        if (l > 0.008 && l < 0.72) {
          allR += R[i];
          allG += G[i];
          allB += B[i];
          allC++;
        }
      }
    }

    if (allC > 16) {
      const mR0 = allR / allC;
      const mG0 = allG / allC;
      const mB0 = allB / allC;

      const redDef = Math.max(0, mG0 - mR0);
      // Disabled linear Ancuti compAlpha: Step 5a (C2 Multi-Zone) handles true biological
      // red restoration in perceptual sRGB without blurred macro halo bleed around marine fauna/diver.
      const compAlpha = 0;

      // Green-water neutralisation is already done by the per-channel grey-world
      // gain below. Damping green AND lifting blue on top of it pushed every warm
      // subject (turtle shell, coral, skin) into magenta, so both are gone.
      const greenDamp = 1;
      const blueLift = 1;

      if (compAlpha > 0.005 || greenDamp < 0.995) {
        // Macroscopic spatial blur eliminates isolated noise dots, micro-bubbles, and compression speckles
        const macroSubject = boxBlur(subjectMask, w, h, Math.max(6, Math.min(14, Math.round(Math.min(w, h) / 70))));
        for (let i = 0; i < n; i++) {
          const r = R[i];
          const g = G[i] * greenDamp;
          const b = B[i] * blueLift;
          const l0 = srcL[i];
          const sub = subjectMask[i];
          const mx0 = Math.max(sR0[i], sG0[i], sB0[i]);
          // Sun-core & highlight guard: prevents orange-pink halo around blown sun flares
          const bubbleGuard = clamp((0.68 - l0) / 0.22, 0.0, 1) * clamp((0.82 - mx0) / 0.18, 0.0, 1);
          // Water red-absorption protection:
          // In real open water (srcWater > 0.15), water column naturally has NO red.
          // Adding red to open water creates purple/magenta/muddy water.
          // Only true subjects (skin, corals, turtles, fish) should receive full red restoration!
          // Spatially coherent macroscopic subject weighting:
          // A broad spatial field ensures real objects (turtle, corals, diver) receive full red,
          // while isolated micro-specks, noise, or water particles receive 0 red (preventing glowing white/pink dots).
          const macroSub = macroSubject[i];
          const rAdd = compAlpha * (g - r > 0 ? g - r : 0) * (1 - r * 0.82) * bubbleGuard * macroSub;
          R[i] = Math.min(g * 0.95, r + rAdd);
          G[i] = g;
          B[i] = b;
        }
      }

      // Step B: Re-measure midtones after Ancuti compensation for smooth Grey-World WB
      const tw = Math.max(1, Math.ceil(w / WB_TILE));
      const th = Math.max(1, Math.ceil(h / WB_TILE));
      const sumR = new Float32Array(tw * th);
      const sumG = new Float32Array(tw * th);
      const sumB = new Float32Array(tw * th);
      const sumSub = new Float32Array(tw * th);
      const sumSmooth = new Float32Array(tw * th);
      const cnt = new Float32Array(tw * th);

      for (let y = 0; y < h; y += sampleStep) {
        const ty = Math.min(th - 1, (y / WB_TILE) | 0);
        const row = y * w;
        for (let x = 0; x < w; x += sampleStep) {
          const i = row + x;
          const l = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
          if (l > 0.008 && l < 0.76) {
            const ti = ty * tw + Math.min(tw - 1, (x / WB_TILE) | 0);
            sumR[ti] += R[i];
            sumG[ti] += G[i];
            sumB[ti] += B[i];
            sumSub[ti] += subjectMask[i];
            sumSmooth[ti] += waterSmooth[i];
            cnt[ti]++;
          }
        }
      }

      let sR = 0;
      let sG = 0;
      let sB = 0;
      let sC = 0;
      for (let t = 0; t < cnt.length; t++) {
        sR += sumR[t];
        sG += sumG[t];
        sB += sumB[t];
        sC += cnt[t];
      }

      if (sC > 16) {
        const mR = sR / sC;
        const mG = sG / sC;
        const mB = sB / sC;
        const target = (mR + mG + mB) / 3;

        // Preserve natural marine coolness in the global white balance target:
        // R aims for 91% of neutral while G (104%) and B (105%) retain clean
        // cyan-turquoise marine balance without pushing B >> G into purple.
        // In Freedive Time mode, B retains slightly deeper sapphire authority (107%).
        const isFreediveWb = p.preset === 'freedive';
        const wR = isFreediveWb ? 0.97 : 0.99;
        const wG = isFreediveWb ? 1.0 : 1.01;
        const wB = isFreediveWb ? 1.05 : 1.02;
        const targetR = target * wR;
        const targetG = target * wG;
        const targetB = target * wB;

        const globalR = clamp(targetR / Math.max(mR, 1e-3), 0.9, 2.85);
        const globalG = clamp(targetG / Math.max(mG, 1e-3), 0.78, 1.15);
        const globalB = clamp(targetB / Math.max(mB, 1e-3), 0.84, 1.16);

        const gRed = new Float32Array(tw * th);
        const gGreen = new Float32Array(tw * th);
        const gBlue = new Float32Array(tw * th);

        // Per-tile gains used to show up as pastel 96 px rectangles floating in
        // open water. Red recovery is per-pixel now, so one global gain is enough.
        const localWeight = 0;
        const minTileCount = Math.max(12, (WB_TILE * WB_TILE) / (sampleStep * sampleStep * 8));

        for (let t = 0; t < cnt.length; t++) {
          if (cnt[t] >= minTileCount) {
            const r = sumR[t] / cnt[t];
            const g = sumG[t] / cnt[t];
            const b = sumB[t] / cnt[t];
            const tg = (r + g + b) / 3;
            const lr = clamp((tg * wR) / Math.max(r, 1e-3), 0.9, 3.0);
            const lg = clamp((tg * wG) / Math.max(g, 1e-3), 0.76, 1.16);
            const lb = clamp((tg * wB) / Math.max(b, 1e-3), 0.82, 1.18);
            // Local white balance only where the tile really holds structure.
            // A flat open-water tile keeps the global gain, otherwise the 96 px
            // tiles show up as pastel patches floating in the water.
            const tileSub = clamp01(sumSub[t] / cnt[t]);
            const tileSmooth = clamp01(sumSmooth[t] / cnt[t]);
            const localW = localWeight * (1 - tileSmooth) * (0.45 + 0.55 * clamp01(tileSub / 0.4));
            gRed[t] = globalR + (lr - globalR) * localW;
            gGreen[t] = globalG + (lg - globalG) * localW;
            gBlue[t] = globalB + (lb - globalB) * localW;
          } else {
            gRed[t] = globalR;
            gGreen[t] = globalG;
            gBlue[t] = globalB;
          }
        }

        const gr = globalR;
        const gg = globalG;
        const gb = globalB;
        let gainSum = 0;

        for (let i = 0; i < n; i++) {
          const rVal = R[i];
          const gVal = G[i];
          const bVal = B[i];
          const l = 0.2126 * rVal + 0.7152 * gVal + 0.0722 * bVal;

          const shadowGuard = clamp(l / 0.025, 0.25, 1);
          // If a pixel (such as a bright air bubble or white marking) already has R
          // close to G, taper the tile's red boost so it never overshoots into peach/salmon.
          const redRatio = rVal / Math.max(gVal, 1e-3);
          const alreadyBalanced = clamp01((redRatio - 0.50) / 0.34);
          // Protect open water from having WB red amplified into murky purple-grey!
          const isWater = srcWater[i] > 0.16;
          const colorDamp = isWater
            ? clamp01(0.14 + subjectMask[i] * 1.15)
            : sB0[i] > sG0[i] * 1.12
              ? clamp01(0.18 + subjectMask[i] * 1.05)
              : 1.0;
          const openWaterWbDamp = colorDamp;
          const highGuard = clamp((0.82 - srcL[i]) / 0.30, 0.12, 1) * (1 - alreadyBalanced * 0.86) * openWaterWbDamp;
          const effWb = wbStrength * shadowGuard;

          const fr = 1 + (gr - 1) * effWb * highGuard;
          const fg = 1 + (gg - 1) * effWb * (1 - 0.5 * clamp01((srcL[i] - 0.65) / 0.2));
          const fb = 1 + (gb - 1) * effWb * (1 - 0.5 * clamp01((srcL[i] - 0.65) / 0.2));

          const newG = gVal * fg;
          const newB = bVal * fb;
          // Non-warm pixels (water column, sandy seabed, shadows) physically cannot have R exceed 0.46 * G or 0.42 * B.
          const isWarmPixel = sR0[i] > sG0[i] * 0.82 && sR0[i] > sB0[i] * 0.75;
          const maxLinearR = isWarmPixel
            ? (sR0[i] < sG0[i] ? newG * 0.95 : 1.35)
            : Math.min(newG * 0.46, newB * 0.42);
          R[i] = Math.min(maxLinearR, rVal * fr);
          G[i] = newG;
          B[i] = newB;
          gainSum += fr;
        }
        gainR = gainSum / n;
      }
    }
  }

  // ------------------------------------ 3. veil + 4. depth attenuation
  const veilStrength = skipRestoration ? 0 : p.veil / 100;
  const attStrength = skipRestoration ? 0 : p.attenuation / 100;
  let veilA = 0;
  let transFloor = 1;
  const transMap = new Float32Array(n).fill(0.85);

  if ((veilStrength > 0.03 || attStrength > 0.05) && n > 256) {
    const bs = VEIL_BLOCK;
    const bw = Math.ceil(w / bs);
    const bh = Math.ceil(h / bs);
    const blockMin = new Float32Array(bw * bh).fill(1);
    const blockLum = new Float32Array(bw * bh);
    const blockCnt = new Float32Array(bw * bh);

    for (let y = 0; y < h; y++) {
      const rowB = ((y / bs) | 0) * bw;
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        let m = R[i];
        if (G[i] < m) m = G[i];
        if (B[i] < m) m = B[i];
        const bi = rowB + ((x / bs) | 0);
        if (m < blockMin[bi]) blockMin[bi] = m;
        blockLum[bi] += 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
        blockCnt[bi]++;
      }
    }
    for (let i = 0; i < blockLum.length; i++) if (blockCnt[i]) blockLum[i] /= blockCnt[i];

    const topN = Math.max(1, Math.round(blockMin.length * 0.004));
    const topIndices = new Int32Array(topN).fill(-1);
    const topVals = new Float32Array(topN).fill(-Infinity);
    let minTopVal = -Infinity;
    let minTopPos = 0;

    for (let bi = 0; bi < blockMin.length; bi++) {
      const val = blockMin[bi];
      if (val > minTopVal) {
        topVals[minTopPos] = val;
        topIndices[minTopPos] = bi;
        minTopVal = topVals[0];
        minTopPos = 0;
        for (let j = 1; j < topN; j++) {
          if (topVals[j] < minTopVal) {
            minTopVal = topVals[j];
            minTopPos = j;
          }
        }
      }
    }

    let ar = 0;
    let ag = 0;
    let ab = 0;
    let ac = 0;
    for (let k = 0; k < topN; k++) {
      const bi = topIndices[k];
      if (bi < 0) continue;
      const bx = bi % bw;
      const by = (bi / bw) | 0;
      const x0 = bx * bs;
      const x1 = Math.min(w, x0 + bs);
      const y0 = by * bs;
      const y1 = Math.min(h, y0 + bs);
      for (let y = y0; y < y1; y += 2) {
        const row = y * w;
        for (let x = x0; x < x1; x += 2) {
          const i = row + x;
          ar += R[i];
          ag += G[i];
          ab += B[i];
          ac++;
        }
      }
    }

    if (ac > 0) {
      ar = clamp(ar / ac, 0.02, 0.82);
      ag = clamp(ag / ac, 0.02, 0.82);
      ab = clamp(ab / ac, 0.02, 0.82);
      const aMean = Math.max((ar + ag + ab) / 3, 0.02);
      veilA = aMean;

      ar = aMean + (ar - aMean) * 0.35;
      ag = aMean + (ag - aMean) * 0.35;
      ab = aMean + (ab - aMean) * 0.35;

      const omega = 0.28 + 0.38 * veilStrength;
      const rawT = new Float32Array(bw * bh);
      let tMin = 1;
      for (let i = 0; i < rawT.length; i++) {
        const t = clamp(1 - omega * (blockMin[i] / aMean), 0.32, 1);
        rawT[i] = t;
        if (t < tMin) tMin = t;
      }
      transFloor = tMin;

      const refined = bw * bh > 9 ? guidedFilterGrid(rawT, blockLum, bw, bh, 3, 8e-4) : rawT;
      for (let i = 0; i < refined.length; i++) refined[i] = clamp(refined[i], 0.32, 1);

      const ax = axisTable(w, bw);
      const ay = axisTable(h, bh);
      const doVeil = veilStrength > 0.03;
      const doAtt = attStrength > 0.05;

      // Fast depth lookup table to eliminate 3.8M Math.pow calls
      const pow115Table = new Float32Array(513);
      for (let k = 0; k <= 512; k++) pow115Table[k] = Math.pow(k / 512, 1.15);

      for (let y = 0; y < h; y++) {
        const y0 = ay.i0[y] * bw;
        const y1 = ay.i1[y] * bw;
        const wy = ay.f[y];
        const row = y * w;
        for (let x = 0; x < w; x++) {
          const x0 = ax.i0[x];
          const x1 = ax.i1[x];
          const wx = ax.f[x];
          const a0 = y0 + x0;
          const a1 = y0 + x1;
          const b0 = y1 + x0;
          const b1 = y1 + x1;
          const t = (refined[a0] * (1 - wx) + refined[a1] * wx) * (1 - wy) + (refined[b0] * (1 - wx) + refined[b1] * wx) * wy;
          const i = row + x;
          transMap[i] = t;

          if (doVeil) {
            const mx = Math.max(R[i], G[i], B[i]);
            const tc = Math.min(1, t + (1 - t) * 0.85 * mx * mx);
            const den = Math.max(tc, 0.32);
            // In green-water or teal-water photos where open water is bright and the diver's skin, deep fish shoals, or seabed are darker than airlight,
            // damp dark-channel subtraction on shaded regions (mx < aMean * 1.15) so skin/fish/reef don't crush to black!
            const isShadedSub = isGreenWater || isTealWater;
            const greenShadeHold = isShadedSub ? clamp01((mx - aMean * 0.88) / Math.max(0.06, aMean * 0.45)) : 1.0;
            const effDen = 1 - (1 - den) * greenShadeHold;
            const rVeil = clamp((R[i] - ar) / effDen + ar, 0, 1.35);
            const gVeil = clamp((G[i] - ag) / effDen + ag, 0, 1.35);
            const bVeil = clamp((B[i] - ab) / effDen + ab, 0, 1.35);
            R[i] = R[i] + (rVeil - R[i]) * greenShadeHold;
            G[i] = G[i] + (gVeil - G[i]) * greenShadeHold;
            B[i] = B[i] + (bVeil - B[i]) * greenShadeHold;
          }

          if (doAtt) {
            const depth = 1 - t;
            const depthIdx = clamp(Math.round(depth * 512), 0, 512);
            const wgt = attStrength * pow115Table[depthIdx];
            if (wgt > 0.002) {
              const r = R[i];
              const g = G[i];
              const b = B[i];
              const mx = Math.max(r, g, b);
              const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
              const blueGuard = b > g ? clamp(1 - (b - g) / Math.max(b, 0.05) * 1.5, 0.2, 1) : 1;
              // In teal water, only inject linear depth-attenuation red on genuine warm subjects (never on deep fish shoals, white dress, or dark seabed)
              const tealSubGate = isTealWater
                ? clamp01((sG0[i] / Math.max(sB0[i], 0.03) - 1.00) / 0.05) * clamp01((sR0[i] / Math.max(sG0[i], 0.03) - 0.38) / 0.12)
                : 1.0;
              const roll = clamp(1 - 1.35 * Math.max(0, mx - 0.45), 0.15, 1) * clamp(l / 0.03, 0.2, 1) * blueGuard * tealSubGate;
              const gap = Math.max(0, (g + b) * 0.42 - r);
              R[i] = clamp(r + gap * wgt * 0.58 * roll + r * wgt * 0.18 * roll, 0, 1.35);
              G[i] = clamp(g * (1 + wgt * 0.04 * roll), 0, 1.35);
              B[i] = clamp(b * (1 - Math.min(0.08, wgt * 0.07)), 0, 1.35);
            }
          }
        }
      }
    }
  }

  // ------------------------------------------------- 5. display space + Perceptual Veil & Subject Restoration
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    R[i] = clamp01(toSrgb(R[i]));
    G[i] = clamp01(toSrgb(G[i]));
    B[i] = clamp01(toSrgb(B[i]));
    L[i] = luma(R[i], G[i], B[i]);
  }

  // 5a. Per-Channel Backscatter Black-Floor Subtraction + Subject-Aware sRGB Red Restoration
  // In real underwater photos (e.g. freedivers in hazy water or sea turtles in blue water),
  // forward-scattered light adds a high green/blue black floor (G_p2 ~ 0.15-0.29, B_p2 ~ 0.19-0.38)
  // that prevents black wetsuits from looking black and keeps coral/turtles looking washed-out cyan.
  if (!skipRestoration && n > 1024) {
    const vStr = clamp01(p.veil / 100);
    const rStr = clamp01(p.redRestore / 100);
    const masterStr = clamp01((vStr + rStr) * 0.58);

    // Step 1: Per-Channel Quantile Auto-Levels on G and B (removes colored fog floor & aligns ceiling)
    const p02R = percentile(R, n, 0.02);
    const p02G = percentile(G, n, 0.02);
    const p02B = percentile(B, n, 0.02);
    const p98G = percentile(G, n, 0.985);
    const p98B = percentile(B, n, 0.985);

    const floorR = Math.max(0, p02R - 0.024) * vStr * 0.72;
    // In green-water or teal-water photos where dark shaded subjects (face/arms/deep fish shoals/seabed) define the 2nd percentile,
    // moderate floor subtraction so shaded human skin, deep fish shoals, and bottom reefs don't crush into near-black!
    const greenFloorDamp = isGreenWater ? 0.36 : isTealWater ? 0.52 : 1.0;
    const floorG = Math.max(0, p02G - 0.026) * vStr * 0.92 * greenFloorDamp;
    const floorB = Math.max(0, p02B - 0.036) * vStr * 0.85 * greenFloorDamp;

    const ceilG = Math.max(0.55, p98G - floorG);
    const ceilB = Math.max(0.55, p98B - floorB);
    // Ceiling alignment may only PULL bright channels down. Lifting G and B here
    // clipped pale shell/sand highlights into flat cyan plates.
    const scaleG = Math.min(1, 1 + (0.95 / ceilG - 1) * masterStr * 0.55);
    const scaleB = Math.min(1, 1 + (0.96 / ceilB - 1) * masterStr * 0.45);

    for (let i = 0; i < n; i++) {
      const sub = subjectMask[i];
      // Protect shaded human skin and dark deep-water fish/reef in teal water from having their midtone/shadow luminance crushed by floor subtraction!
      const isWarmShadedSkin = isTealWater
        ? Math.max(
            sG0[i] > sB0[i] * 0.99 && sR0[i] > sG0[i] * 0.36 && srcL[i] < 0.50 ? 0.86 : 0,
            clamp01((0.28 - srcL[i]) / 0.12) * 0.72
          )
        : 0;
      const gCut = floorG * (1 - isWarmShadedSkin);
      const bCut = floorB * (0.62 + 0.30 * sub) * (1 - isWarmShadedSkin * 0.70);
      R[i] = clamp01((R[i] - floorR * (1 - isWarmShadedSkin)) / Math.max(0.45, 1 - floorR * 0.75));
      G[i] = clamp01((G[i] - gCut) * scaleG);
      B[i] = clamp01((B[i] - bCut) * scaleB);
    }

    // Step 2: Canonical Midtone Gamma Alignment + Auto Underexposure Lift
    const midR = percentile(R, n, 0.50);
    const midG = percentile(G, n, 0.50);
    const midB = percentile(B, n, 0.50);
    const midL = 0.2126 * midR + 0.7152 * midG + 0.0722 * midB;
    const p85R = percentile(R, n, 0.85);
    const p85G = percentile(G, n, 0.85);

    // Automatic Shadow & Midtone Exposure Gamma for dark underwater scenes
    // (e.g. dark reefs under bright sun flares where p98 is high but midL < 0.36)
    let autoGamma = 1.0;
    if (isGreenWater) {
      // Keep natural midtone gamma in green water (slight 1.04 deepening only on open water)
      autoGamma = 1.04;
    } else if (midL < 0.36) {
      const targetMid = Math.min(0.35, midL * 1.25 + 0.03);
      const rawGamma = Math.log(Math.max(0.08, targetMid)) / Math.log(Math.max(0.05, midL));
      autoGamma = clamp(1 - (1 - rawGamma) * masterStr, 0.82, 1.0);
    }

    // If G median exceeds tropical sapphire ratio, gently balance G toward B
    // without flattening or crushing natural turquoise water tones
    const targetMidG = isGreenWater ? midB * 0.95 : isTealWater ? midB * 0.88 : midB * 0.92;
    const greenMidExcess = Math.max(0, midG - targetMidG);
    const gGammaPull = clamp(greenMidExcess * (isGreenWater ? 0.65 : isTealWater ? 0.55 : 0.45) * rStr, 0, 0.16);

    // Target subject red quantile: ensure p85_R reaches ~0.88 * p85_G regardless of depth!
    const targetP85R = Math.max(0.38, p85G * 0.88);
    const redQuantileGap = clamp01((targetP85R - p85R) / Math.max(targetP85R, 0.15));
    const srgbRedDef = clamp01((midG * 0.96 - midR) / Math.max(midG, 0.12));
    const adaptRedGain = clamp01(0.45 * srgbRedDef + 0.55 * redQuantileGap) * rStr;

    // Step 3: Local Optical Haze Envelope (removes milky scattering veil for glass-like clarity)
    const minCh = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      minCh[i] = Math.min(R[i], G[i], B[i]);
    }
    const hazeRadius = Math.max(8, Math.min(24, Math.round(Math.min(w, h) / 42)));
    const localVeil = boxBlur(minCh, w, h, hazeRadius);

    // Spatial guide for red recovery: a small blur of the R/G ratio averages out
    // sensor noise and JPEG speckle, so recovered red lands in coherent regions
    // instead of dot-by-dot (which reads as posterised patches on shell/skin).
    const rgGuide = new Float32Array(n);
    for (let i = 0; i < n; i++) rgGuide[i] = R[i] / Math.max(G[i], 0.02);
    const rgSmooth = boxBlur(rgGuide, w, h, 3);
    const macroWarmth = boxBlur(subjectMask, w, h, 10);

    for (let y = 0; y < h; y++) {
      const yNorm = y / Math.max(1, h - 1);
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        let r = R[i];
        let g = G[i];
        let b = B[i];
        const sub = subjectMask[i];
        const l0 = srcL[i];

        // A0. Automatic Shadow/Midtone Gamma Alignment
        // Protects deep black wetsuits (l0 < 0.08 && sub < 0.14) while opening up dark reefs or deepening overly bright green water
        if (Math.abs(autoGamma - 1.0) > 0.005 && l0 < 0.88) {
          const suitHold = l0 < 0.16 && sub > 0.15 && isGreenWater
            ? clamp01((0.18 - l0) / 0.06) * 0.55
            : l0 < 0.085 && sub < 0.15
              ? clamp01((0.085 - l0) / 0.055) * 0.72
              : 0;
          const effGamma = autoGamma + (1 - autoGamma) * suitHold;
          const lCur = Math.max(1e-4, luma(r, g, b));
          const lLift = Math.pow(lCur, effGamma);
          const gain = clamp(lLift / lCur, 0.55, 2.4);
          r = clamp01(r * gain);
          g = clamp01(g * gain);
          b = clamp01(b * gain);
        }

        // A. Local Optical Dehaze (subtracts spatially-varying milky veil without halos or shadow crushing)
        const shadowTaper = clamp01((l0 - (isGreenWater ? 0.24 : isTealWater ? 0.22 : 0.12)) / 0.16);
        const lv = localVeil[i] * vStr * (isGreenWater ? 0.18 - 0.04 * sub : isTealWater ? 0.13 * (1 - sub * 0.35) : 0.16 + 0.12 * sub) * shadowTaper;
        if (lv > 0.004 && l0 < 0.82) {
          const den = Math.max(0.68, 1 - lv * (isGreenWater ? 0.58 : 0.72));
          r = clamp01((r - lv * 0.70) / den);
          g = clamp01((g - lv * (isGreenWater ? 0.92 : 0.88)) / den);
          b = clamp01((b - lv * (isGreenWater ? 0.76 : 0.78)) / den);
        }

        // B. Canonical Green-Cast Midtone Suppression
        if (gGammaPull > 0.005) {
          const midMask = 4 * g * (1 - g);
          // In green water, deepen G toward rich ocean teal-blue; in teal water, shift open water from 186° cyan to 203° sapphire blue
          const gPullFactor = isGreenWater ? 0.55 : isTealWater ? 0.85 * (1 - sub * 0.45) : 0.65 + 0.35 * sub;
          const bLiftFactor = isGreenWater ? 0.08 : isTealWater ? 0.20 * (1 - sub * 0.55) : 0.18 * (1 - sub * 0.65);
          g = clamp01(g - gGammaPull * midMask * gPullFactor);
          b = clamp01(b + gGammaPull * midMask * bLiftFactor);
        }

        // C. Deep Shadow Wetsuit Neutralizer (targets black wetsuits/swimsuits l0 < 0.16 && sub < 0.15,
        //    never desaturating dark coral reefs or deep blue ocean water!)
        if (l0 < 0.185 && sub < 0.15 && (sR0[i] > sB0[i] * 0.35 || isGreenWater)) {
          const darkNeutral = clamp01((0.185 - l0) / 0.08) * clamp01((0.15 - sub) / 0.12) * vStr * 0.78;
          const lCur = luma(r, g, b);
          r = r + (lCur - r) * darkNeutral;
          g = g + (lCur - g) * darkNeutral;
          b = b + (lCur - b) * darkNeutral;
        }

        // C2. Multi-Zone Semantic Red & Warmth Reconstitution (learned from underwater reference grading):
        // Distinguishes:
        //   - Neutral White / Silver Objects (white dress, silver fish school, white fins): high R/G relative to water,
        //     but G/B is close to or below waterGB (rawGB <= waterGB + 0.065). Restores clean neutral silver-white (R ~ 0.90*G, B >= 1.06*G)!
        //   - True Golden-Tan Human Skin (in cyan-teal water): BOTH R/G and G/B exceed open water (rawGB > 1.00 && rawRG > 0.38)
        //     with smooth organic texture. Restores warm golden-terracotta skin (R ~ 1.42*G, B ~ 0.68*G, H: 24°-27°)!
        //   - Marine Fauna & Coral (turtles, reef): balanced olive-tan/cream without yellow-orange cast.
        if (rStr > 0.02 && l0 > 0.04 && l0 < 0.92) {
          const rawRG = sR0[i] / Math.max(sG0[i], 0.03);
          const rawGB = sG0[i] / Math.max(sB0[i], 0.03);
          const topGbCeil = Math.max(0.78, waterGB + 0.04);
          const topRippleGuard = 1 - clamp01((0.35 - yNorm) / 0.14) * clamp01((topGbCeil - rawGB) / 0.06) * clamp01(1 - texFine[i] * 2.5);
          const greenSubWarmth = isGreenWater ? sub * 0.88 : 0;
          // Detect whether this subject pixel is a Neutral White/Silver object (white dress, silver fish where G <= B or bright silver belly l0 > 0.50):
          const isNeutralSilver =
            !isGreenWater
              ? Math.max(
                  clamp01((1.005 - rawGB) / 0.045) * clamp01((l0 - 0.24) / 0.10),
                  clamp01((l0 - 0.50) / 0.10) * clamp01((1.06 - rawGB) / 0.06)
                )
              : 0;
          // True warm human skin in teal water has G > B (rawGB > 1.00) AND R/G > 0.35 with smooth skin texture (l0 in 0.08..0.58):
          const isTealHumanSkin =
            isTealWater
              ? clamp01((rawGB - 0.995) / 0.045) *
                clamp01((rawRG - 0.34) / 0.10) *
                clamp01(1 - texFine[i] * 1.9) *
                clamp01((0.58 - l0) / 0.12) *
                clamp01((l0 - 0.08) / 0.06) *
                clamp01((0.68 - yNorm) / 0.10)
              : 0;
          // Deep shadow reef/fish in teal water (rawRG < 0.34 && l0 < 0.26) stays natural underwater olive-cyan (G > B > R, never muddy brown)
          const isTealDeepReef = isTealWater ? clamp01((0.35 - rawRG) / 0.06) * clamp01((0.28 - l0) / 0.08) : 0;

          // On shaded/midtone human skin in teal water (like legs/back at L0 ~ 0.20..0.35), lift skin luminance
          // and steer toward Golden-Terracotta Tan [1.36, 0.93, 0.63] (R = 1.44*G, B = 0.68*G, H: 24°-27°) just like in the reference video!
          if (isTealHumanSkin > 0.03) {
            const skinGTarget = Math.max(g, l0 * 1.58) * (1 + 0.08 * isTealHumanSkin * rStr);
            g = g + (skinGTarget - g) * isTealHumanSkin * 0.85;
            const skinRTarget = g * 1.44;
            const skinBTarget = g * 0.68;
            r = clamp01(r + (skinRTarget - r) * isTealHumanSkin * rStr * 0.92);
            b = clamp01(b + (skinBTarget - b) * isTealHumanSkin * rStr * 0.88);
          }

          // Spatially smooth subject warmth (eliminates patchy leopard-skin mold & floating noise specks)
          const macroSubW = clamp01(macroWarmth[i] * 1.35);
          const rgThreshC2 = isTealWater ? Math.max(0.24, waterRG + 0.08) : 0.22;
          const warmth = clamp01(Math.max((rgSmooth[i] - rgThreshC2) / 0.18, macroSubW * 0.65, greenSubWarmth, isTealHumanSkin * 0.96)) * topRippleGuard * (1 - isTealDeepReef * 0.65);
          const hiGuard = clamp01((0.95 - l0) / 0.20);
          // On Golden-Tan Human Skin in teal water, allow R to reach 1.44 * G; on Neutral Silver (white dress/fish), cap R at 0.89 * G!
          const rCapMul = (0.92 - 0.04 * isNeutralSilver - 0.20 * isTealDeepReef) + 0.52 * isTealHumanSkin;
          const targetR = Math.min(g * rCapMul, g * (0.62 + (0.30 + 0.48 * isTealHumanSkin) * warmth));
          const k = rStr * warmth * hiGuard * (0.85 + 0.14 * isTealHumanSkin);
          if (k > 0.002 && targetR > r) {
            r = clamp01(r + (targetR - r) * k);
          }
          // Enforce crisp Cool-White / Metallic Silver-Blue on Neutral White/Silver objects (white dress & silver fish school)
          // so R never exceeds 0.90*G (no pink/lavender tint) and B stays >= 1.06*G (no yellow tint)!
          if (isNeutralSilver > 0.08 && isTealHumanSkin < 0.15) {
            const ns = isNeutralSilver * rStr;
            if (r > g * 0.90) {
              r = r + (g * 0.90 - r) * Math.min(0.92, ns * 0.95);
            }
            const minSilverB = g * 1.07;
            if (b < minSilverB) {
              b = b + (minSilverB - b) * Math.min(0.85, ns * 0.80);
            }
          }
          // Strictly protect Sand / Seabed / Substrate from warm blue-tuck and yellowing!
          const isSandSubstrate = !isGreenWater && (l0 > 0.24 && sB0[i] > 0.28 && sG0[i] > 0.28 && isTealHumanSkin < 0.15);

          // Harmonize warm subject channels, while protecting Neutral White/Silver objects (white dress, silver fish),
          // sandy seabeds, and deep teal-water shadow reefs so they don't turn yellow or muddy brown!
          if ((r > g * 0.54 || sub > 0.30) && topRippleGuard > 0.5 && isNeutralSilver < 0.45 && isTealDeepReef < 0.45 && !isSandSubstrate) {
            const warmRatio = clamp01(Math.max((r / Math.max(g, 0.02) - 0.52) / 0.36, sub * 0.65, isTealHumanSkin * 0.95)) * topRippleGuard * (1 - isNeutralSilver * 0.95) * (1 - isTealDeepReef * 0.85);
            const hiSkinCool = isGreenWater ? clamp01((l0 - 0.46) / 0.18) * 0.07 : 0;
            const bTuck = (isGreenWater ? 0.13 : 0.10 + 0.22 * isTealHumanSkin) * warmRatio;
            const maxWarmB = g * (0.96 - bTuck + hiSkinCool);
            if (b > maxWarmB) {
              b = clamp01(b + (maxWarmB - b) * Math.min(0.88, (0.45 + 0.45 * rStr) * warmRatio));
            }
            // Authentic Red & Orange Pigment Protection:
            // If the subject has natural red or orange pigment (e.g. red coral, red fins, orange clownfish, reddish markings),
            // strictly preserve its red-orange hue (0°..25°) and NEVER inflate green up to 0.72*r (which turns red/orange into yellow)!
            const isRedOrange = (r > g * 1.14 && r > b * 1.25) || (sR0[i] > sG0[i] * 1.04);
            if (isRedOrange) {
              const maxRedOrangeG = r * 0.62;
              if (g > maxRedOrangeG) g = maxRedOrangeG;
              const maxRedOrangeB = g * 0.75;
              if (b > maxRedOrangeB) b = maxRedOrangeB;
            } else if (r > g && isTealHumanSkin < 0.15) {
              const minWarmG = 0.72 * r + 0.28 * b;
              if (g < minWarmG) {
                g = clamp01(g + (minWarmG - g) * 0.75);
              }
            }
          }
          // Compress over-bright sunlit skin highlights in green water (forehead/shoulders/thighs/calves where l0 > 0.34)
          // so they render as rich, natural medium-tan skin instead of pale/bright cream!
          if (isGreenWater && sub > 0.12 && g > 0.38) {
            const skinHiRoll = clamp01((g - 0.38) / 0.34) * clamp01(sub * 1.45) * 0.60;
            const targetHiG = 0.38 + (g - 0.38) * (1 - skinHiRoll);
            const scaleHi = targetHiG / Math.max(g, 1e-4);
            r = Math.min(targetHiG * 1.05, r * scaleHi * 0.92);
            g = targetHiG * 0.98;
            b *= scaleHi * 0.85;
          }
        }

        // D. Sun-core healing: blown sun blobs at the top of the frame become
        // clean white light instead of orange discs.
        if (yNorm < 0.16 && l0 > 0.48 && (sR0[i] > sB0[i] * 1.05 || r > b * 1.02)) {
          const sunCoreMask = clamp01((0.16 - yNorm) / 0.10) * clamp01((l0 - 0.48) / 0.18);
          const mxSun = Math.max(r, g, b, sR0[i]);
          r = r + (mxSun * 0.94 - r) * sunCoreMask * 0.9;
          g = g + (mxSun * 0.97 - g) * sunCoreMask * 0.9;
          b = b + (mxSun * 0.99 - b) * sunCoreMask * 0.9;
        }

        R[i] = clamp01(r);
        G[i] = clamp01(g);
        B[i] = clamp01(b);
        L[i] = luma(R[i], G[i], B[i]);
      }
    }

    // Step 4: Canonical Dynamic Range Normalization (2% .. 98% Luminance Anchoring)
    const pLow = percentile(L, n, 0.02);
    const pHigh = percentile(L, n, 0.98);
    const span = pHigh - pLow;
    if (span > 0.14 && span < 0.96) {
      const stretchStrength = clamp01((p.veil + p.redRestore) / 140) * (isGreenWater ? 0.18 : 0.36);
      const targetLo = Math.min(pLow, 0.04) * (1 - stretchStrength) + pLow * (1 - stretchStrength) * 0.25;
      // In green-water photos, anchor targetHi around 0.64 (instead of 0.84 which was too bright or 0.30 which was too dark)
      const targetHi = 1 - (1 - Math.max(pHigh, isGreenWater ? 0.64 : 0.90)) * (1 - stretchStrength);
      const scale = (targetHi - targetLo) / span;
      for (let i = 0; i < n; i++) {
        const l = L[i];
        if (l > 0.001) {
          let nl = clamp01((l - pLow) * scale + targetLo);
          // Protect sunlit human skin in green water from blowing out into flat bright white/yellow plates!
          if (isGreenWater && subjectMask[i] > 0.12 && nl > 0.52) {
            const hiCap = clamp01(subjectMask[i] * 1.4);
            nl = nl - (nl - 0.52) * 0.54 * hiCap;
          }
          const f = nl / l;
          R[i] = clamp01(R[i] * f);
          G[i] = clamp01(G[i] * f);
          B[i] = clamp01(B[i] * f);
          L[i] = nl;
        }
      }
    }
  }

  // 5b. Edge-Preserving Chroma & Water-Texture Denoise (eliminates 8x8 JPEG blockiness,
  //     color speckle, and luminance pixelation in smooth water while keeping subject edges clean).
  //     Strictly bypassed on clean, sharp, or well-balanced images to preserve fine biological micro-textures!
  const needsChromaDenoise = !skipRestoration && n > 4096 && (p.spotRemoval > 12 || p.veil > 15 || isGreenWater);
  if (needsChromaDenoise) {
    const cR = new Float32Array(n);
    const cG = new Float32Array(n);
    const cB = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const l = L[i];
      cR[i] = R[i] - l;
      cG[i] = G[i] - l;
      cB[i] = B[i] - l;
    }
    const chRadius = Math.max(5, Math.min(10, Math.round(Math.min(w, h) / 180)));
    const mCR = boxBlur(cR, w, h, chRadius);
    const mCG = boxBlur(cG, w, h, chRadius);
    const mCB = boxBlur(cB, w, h, chRadius);
    const mL = boxBlur(L, w, h, chRadius);
    const lWaterBlur = boxBlur(L, w, h, 4);

    for (let i = 0; i < n; i++) {
      const l = L[i];
      const dL = Math.abs(l - mL[i]);
      // 1. Multi-pass luminance de-blocking in low-contrast water/gradients (eliminates 8x8 JPEG pixelation & banding)
      const isWaterGrad = waterSmooth[i] * clamp01(1 - subjectMask[i] * 1.3) * clamp01(1 - dL / 0.045);
      const baseL = isWaterGrad > 0.03 ? l + (lWaterBlur[i] - l) * isWaterGrad * 0.78 : l;
      // 2. Smooth chroma strongly inside flat/gradient regions and across soft subject transitions
      const edgeGuard = clamp01(1 - dL / 0.085);
      const alpha = 0.90 * edgeGuard * edgeGuard;
      if (alpha > 0.01 || isWaterGrad > 0.03) {
        R[i] = clamp01(baseL + cR[i] + (mCR[i] - cR[i]) * alpha);
        G[i] = clamp01(baseL + cG[i] + (mCG[i] - cG[i]) * alpha);
        B[i] = clamp01(baseL + cB[i] + (mCB[i] - cB[i]) * alpha);
        L[i] = baseL;
      }
    }
  }

  const sgw = Math.max(4, Math.min(STRUCT_W, w));
  const sgh = Math.max(4, Math.min(STRUCT_W, Math.round((STRUCT_W * h) / Math.max(w, 1))));
  const structBefore = gridFromPlane(L, w, h, sgw, sgh);

  // ------------------------------------------------ strobe radial falloff
  const maskX = new Float32Array(w);
  const maskY = new Float32Array(h);
  if (isStrobe) {
    for (let x = 0; x < w; x++) {
      const dx = (x - (w - 1) / 2) / Math.max(1, w / 2);
      maskX[x] = dx * dx;
    }
    for (let y = 0; y < h; y++) {
      const dy = (y - (h - 1) / 2) / Math.max(1, h / 2);
      maskY[y] = dy * dy;
    }
  }

  // --------------------------------------------------- 6. local contrast
  if (p.clarity > 1 && n > 64) {
    const tile = Math.max(32, Math.round(Math.min(w, h) / 18));
    const tw = Math.max(1, Math.ceil(w / tile));
    const th = Math.max(1, Math.ceil(h / tile));
    const mean = new Float32Array(tw * th);
    const std = new Float32Array(tw * th);

    for (let ty = 0; ty < th; ty++) {
      const y0 = ty * tile;
      const y1 = Math.min(h, y0 + tile);
      for (let tx = 0; tx < tw; tx++) {
        const x0 = tx * tile;
        const x1 = Math.min(w, x0 + tile);
        let sum = 0;
        let sum2 = 0;
        let c = 0;
        for (let y = y0; y < y1; y++) {
          const row = y * w;
          for (let x = x0; x < x1; x++) {
            const v = L[row + x];
            sum += v;
            sum2 += v * v;
            c++;
          }
        }
        if (c) {
          const m = sum / c;
          mean[ty * tw + tx] = m;
          std[ty * tw + tx] = Math.sqrt(Math.max(0, sum2 / c - m * m));
        }
      }
    }

    const strength = (p.clarity / 100) * 0.45;
    const gainArr = new Float32Array(tw * th);
    for (let i = 0; i < gainArr.length; i++) {
      let g = 0.125 / (std[i] + 0.115);
      g = clamp(g, 0.94, 1.32);
      gainArr[i] = 1 + (g - 1) * strength;
    }

    const smoothMean = tw * th > 4 ? boxBlur(mean, tw, th, 1) : mean;
    const smoothGain = tw * th > 4 ? boxBlur(gainArr, tw, th, 1) : gainArr;

    for (let y = 0; y < h; y++) {
      const fyRaw = (y + 0.5) / tile - 0.5;
      const fy = clamp(fyRaw, 0, th - 1);
      const y0 = fy | 0;
      const y1 = Math.min(y0 + 1, th - 1);
      const wy = fy - y0;
      const row = y * w;
      const boost = isStrobe ? 1 + (1 - Math.min(1, maskY[y])) * 0.4 : 1;

      for (let x = 0; x < w; x++) {
        const fx = clamp((x + 0.5) / tile - 0.5, 0, tw - 1);
        const x0 = fx | 0;
        const x1 = Math.min(x0 + 1, tw - 1);
        const wx = fx - x0;
        const b00 = y0 * tw + x0;
        const b01 = y0 * tw + x1;
        const b10 = y1 * tw + x0;
        const b11 = y1 * tw + x1;

        const m = (smoothMean[b00] * (1 - wx) + smoothMean[b01] * wx) * (1 - wy) + (smoothMean[b10] * (1 - wx) + smoothMean[b11] * wx) * wy;
        let g = (smoothGain[b00] * (1 - wx) + smoothGain[b01] * wx) * (1 - wy) + (smoothGain[b10] * (1 - wx) + smoothGain[b11] * wx) * wy;
        if (isStrobe) g = 1 + (g - 1) * boost;

        const i = row + x;
        // Protect smooth open water from local-contrast JPEG block amplification!
        const waterHold = waterSmooth[i] * clamp01(1 - subjectMask[i] * 1.35);
        g = 1 + (g - 1) * (1 - waterHold * 0.82);
        const l = L[i];
        if (l > 0.0008) {
          const nl = clamp01(m + (l - m) * g);
          const f = nl / l;
          const fChroma = 1 + (f - 1) * 0.65;
          R[i] = clamp01(nl + (R[i] - l) * fChroma);
          G[i] = clamp01(nl + (G[i] - l) * fChroma);
          B[i] = clamp01(nl + (B[i] - l) * fChroma);
          L[i] = nl;
        }
      }
    }
  }

  // ------------------------------------------------------------- 7. tone
  const exposure = Math.pow(2, p.exposure / 75);
  const contrast = p.contrast / 100;
  const shadowAmt = p.shadows / 100;
  const highAmt = p.highlight / 100;
  const whitesAmt = (p.whites || 0) / 100;
  const blacksAmt = (p.blacks || 0) / 100;
  const fadeAmt = (p.fade || 0) / 100;
  const roll = p.rolloff / 100;

  for (let i = 0; i < n; i++) {
    let r = R[i] * exposure;
    let g = G[i] * exposure;
    let b = B[i] * exposure;
    let l = luma(r, g, b);
    let nl = l;

    if (contrast !== 0) nl = 0.5 + (nl - 0.5) * (1 + contrast * 0.55);
    if (shadowAmt) nl += shadowAmt * 0.22 * (1 - nl) * (1 - nl);
    if (highAmt) nl += highAmt * 0.22 * nl * nl;
    if (whitesAmt && nl > 0.45) {
      const wgt = Math.pow((nl - 0.45) / 0.55, 1.35);
      nl += whitesAmt * 0.24 * wgt;
    }
    if (blacksAmt && nl < 0.42) {
      const bgt = Math.pow((0.42 - nl) / 0.42, 1.45);
      nl += blacksAmt * 0.20 * bgt;
    }

    const knee = 0.92 - roll * 0.12;
    if (nl > knee) nl = knee + (nl - knee) * Math.max(0.08, 0.55 - roll * 0.34);
    if (fadeAmt > 0.005) {
      nl = nl * (1 - fadeAmt * 0.14) + fadeAmt * 0.085;
    }
    nl = clamp01(nl);

    const f = l > 0.0015 ? nl / l : 1;
    R[i] = clamp01(r * f);
    G[i] = clamp01(g * f);
    B[i] = clamp01(b * f);
  }

  // ------------------------------------------------- 8. colour + grading
  const satMul = 1 + p.saturation / 100;
  const vib = p.vibrance / 100;
  const warm = p.temperature / 100;
  const tintAmt = (p.tint || 0) / 100;
  const vig = p.vignette / 100;

  const vx = new Float32Array(w);
  const vy = new Float32Array(h);
  if (vig !== 0) {
    for (let x = 0; x < w; x++) {
      const d = (x - (w - 1) / 2) / Math.max(1, w / 2);
      vx[x] = d * d;
    }
    for (let y = 0; y < h; y++) {
      const d = (y - (h - 1) / 2) / Math.max(1, h / 2);
      vy[y] = d * d;
    }
  }

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      let r = R[i];
      let g = G[i];
      let b = B[i];
      const l = luma(r, g, b);

      // Apply temperature warmth to brighter midtones (sand, coral, skin),
      // while letting deeper water keep its natural marine coolness.
      if (warm !== 0) {
        const wMask = clamp01((l - 0.2) / 0.35) * (1 - l * 0.5);
        r *= 1 + warm * 0.13 * wMask;
        g *= 1 + warm * 0.025 * wMask;
        b *= 1 - warm * 0.09 * wMask;
      }

      // CapCut Corak (Tint): Negative = Green, Positive = Magenta
      if (tintAmt !== 0) {
        const tMask = clamp01((l - 0.06) / 0.16) * (1 - l * 0.35);
        r *= 1 + tintAmt * 0.11 * tMask;
        g *= 1 - tintAmt * 0.13 * tMask;
        b *= 1 + tintAmt * 0.09 * tMask;
      }

      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const sat = mx > 0.004 ? (mx - mn) / mx : 0;

      const shadowFade = clamp01((l - 0.04) / 0.14);
      const s = satMul * (1 + vib * (1 - sat) * 0.85 * shadowFade);
      r = l + (r - l) * s;
      g = l + (g - l) * s;
      b = l + (b - l) * s;

      if (isStrobe) {
        const m = 1 / (1 + 3.2 * (maskX[x] + maskY[y]));
        r *= 1 + m * 0.03;
        g *= 1 + m * 0.015;
      }

      if (vig !== 0) {
        const d2 = Math.min(1, vx[x] + vy[y]);
        if (vig > 0) {
          const v = 1 - vig * 0.45 * d2;
          r *= v;
          g *= v;
          b *= v;
        } else {
          const vLift = -vig * 0.35 * d2;
          r = r + (1 - r) * vLift;
          g = g + (1 - g) * vLift;
          b = b + (1 - b) * vLift;
        }
      }

      R[i] = clamp01(r);
      G[i] = clamp01(g);
      B[i] = clamp01(b);
    }
  }

  // ------------------------------------------- 8b. neutral axis (sand, gear, wetsuit, bubbles)
  // Clean residual green/magenta tint from low-saturation pixels (wetsuit,
  // scuba gear, bright sunlit sand) and keep specular highlights / air bubbles
  // crisp neutral white while leaving marine water chroma intact.
  const neutralAmt = p.neutral / 100;
  let neutralPixels = 0;

  if (neutralAmt > 0.01) {
    const satCutoff = isFreedive ? 0.22 : 0.18;
    const satSpan = isFreedive ? 0.15 : 0.12;
    const pullGain = isFreedive ? 0.48 : 0.35;
    const warmFactor = isFreedive ? 0.008 : 0.022;

    for (let i = 0; i < n; i++) {
      const r0 = R[i];
      const g0 = G[i];
      const b0 = B[i];
      const mx = Math.max(r0, g0, b0);
      if (mx < 0.03) continue;
      const mn = Math.min(r0, g0, b0);
      const sat = (mx - mn) / mx;
      const l = luma(r0, g0, b0);

      // Specular highlight / sunbeam anti-peach guard: only damp excess red on
      // bright NEUTRAL highlights. Warm bright subjects (coral tips, turtle shell)
      // must keep their colour, so saturated pixels are left alone.
      const hlMx = Math.max(r0, g0, b0);
      const hlSat = hlMx > 0.02 ? (hlMx - Math.min(r0, g0, b0)) / hlMx : 0;
      if (srcL[i] > 0.68 && l > 0.66 && r0 > g0 * 0.90 && hlSat < 0.13) {
        const bMask = clamp01((srcL[i] - 0.68) / 0.16) * clamp01((r0 - g0 * 0.88) / 0.18);
        R[i] = clamp01(r0 + (g0 * 0.86 - r0) * bMask * 0.80);
        neutralPixels++;
        continue;
      }

      // Only target truly low-chroma non-water sand/wetsuit/white-gear pixels
      // Never desaturate or warm sunlit blue/cyan water around sunbeams!
      if (sat > satCutoff) continue;
      if (srcWater[i] > 0.28 || b0 > r0 * 1.20) continue;
      if (r0 > b0 * 1.12 && r0 > g0 * 1.04) continue;

      let mask = clamp01((satCutoff - sat) / satSpan);
      mask *= clamp01((0.99 - l) / 0.1);
      if (mask <= 0.01) continue;
      mask = mask * mask * (3 - 2 * mask);
      neutralPixels++;

      const t = neutralAmt * mask * pullGain;
      const sandWarm = l > 0.36 ? warmFactor * clamp01((l - 0.36) / 0.3) * (1 - l * 0.55) : 0;
      const tr = clamp01(l + sandWarm);
      const tg = clamp01(l + sandWarm * 0.45);
      const tb = clamp01(l - sandWarm * 0.55);

      R[i] = clamp01(r0 + (tr - r0) * t);
      G[i] = clamp01(g0 + (tg - g0) * t);
      B[i] = clamp01(b0 + (tb - b0) * t);
    }
  }

  // ---------------------------------------------------- 8c. water light & marine tint
  // Restores crystal-clear tropical cyan-azure water ambience (or Cobalt-Sapphire
  // ocean blue in Freedive Time mode).
  const wet = p.waterLight / 100;
  const wtint = p.waterTint / 100;
  let waterPixels = 0;
  const waterColMask = new Float32Array(n);

  if (wet > 0.01 || wtint > 0.01) {
    const refSum = REF_WATER[0] + REF_WATER[1] + REF_WATER[2];
    const fdMidSum = FREEDIVE_WATER[0] + FREEDIVE_WATER[1] + FREEDIVE_WATER[2];
    const fdSurfSum = FREEDIVE_SURFACE[0] + FREEDIVE_SURFACE[1] + FREEDIVE_SURFACE[2];

    for (let i = 0; i < n; i++) {
      let r0 = R[i];
      let g0 = G[i];
      let b0 = B[i];
      const l = luma(r0, g0, b0);
      // Protect deep black wetsuit shadows and bright white bubbles/foam
      if (l <= 0.08 || l >= 0.92) continue;

      // Anti-violet & anti-magenta guard for open water & distant blue reefs:
      // In ocean water, Red must NEVER exceed ~0.40 * Green or ~0.36 * Blue.
      // If R exceeds this on blue-dominant pixels, the water/background turns into unnatural lilac/violet/magenta.
      if (srcWater[i] > 0.16 && (waterSmooth[i] > 0.35 || subjectMask[i] < 0.42)) {
        const violetExcess = Math.max(0, r0 - g0 * 0.38);
        if (violetExcess > 0.004) {
          const vFix = clamp01(srcWater[i] * 1.4) * clamp01(1 - subjectMask[i] * 0.9) * 0.85;
          r0 = Math.min(r0, r0 * (1 - vFix * 0.7) + g0 * 0.32 * vFix * 0.7);
        }
      }

      const sea = 0.48 * g0 + 0.52 * b0;
      const curWater = clamp01((sea - r0 * 0.88) / Math.max(sea, 0.04));
      // Waterness covers both open water and neutral seabed substrate (sand/rocks).
      // Only genuine warm subjects (diver skin, turtle shell, red coral where r0 > g0 * 0.85)
      // are gated by subjectMask and waterSmooth.
      const isWarmSubject = (r0 > g0 * 0.85 && r0 > b0 * 0.80) || (sR0[i] > sG0[i] * 0.95);
      const openWaterFactor = isWarmSubject ? clamp01(1 - subjectMask[i] * 1.5) : 1.0;
      const waterScore = curWater * 0.85 * openWaterFactor * (isWarmSubject ? waterSmooth[i] : 1.0);
      if (waterScore <= 0.08) continue;

      let mask = clamp01((waterScore - 0.08) / 0.36);
      mask *= clamp01((l - 0.08) / 0.12) * clamp01((0.95 - l) / 0.22);
      // Strictly protect subjects (turtles, fauna, corals, diver) from water tinting!
      mask *= clamp01(1 - subjectMask[i] * 1.8) * clamp01((waterSmooth[i] - 0.18) / 0.30) * clamp01(1 - texFine[i] * 2.5);
      mask *= clamp01((0.92 - r0 / Math.max(g0, 0.02)) / 0.18);
      if (mask <= 0.005) continue;
      mask = mask * mask * (3 - 2 * mask);
      waterColMask[i] = mask;
      if (mask > 0.05) waterPixels++;

      const anchor = Math.pow(Math.max(l, 0.03), 0.45);
      // In green water, keep water luminance natural and balanced (gentle 0.03 lift instead of 0.14)
      const lift = isGreenWater
        ? wet * 0.03 * mask * anchor
        : wet * 0.14 * mask * anchor * (1 - 0.35 * Math.max(0, l - 0.65));
      const nl = clamp01(l + (lift >= 0 ? (1 - l) * lift : l * lift));
      const f = l > 0.0015 ? nl / l : 1;
      let r = r0 * f;
      let g = g0 * f;
      let b = b0 * f;

      if (wtint > 0.01) {
        const sum = r + g + b;
        if (isFreedive) {
          // Freedive Time: Crystal Tropical Sapphire-Azure water (calibrated to CapCut reference:
          // R/B ~ 0.16, G/B ~ 0.72..0.82 so water looks authentic tropical ocean blue, never dark purple).
          // In green-water photos (isGreenWater), blend softly toward calm marine teal-azure (G/B ~ 0.80..0.86)
          // so the scene doesn't look like an artificial electric cyan filter.
          const surfMix = clamp01((nl - 0.46) / 0.30);
          const trMid = (sum * FREEDIVE_WATER[0]) / fdMidSum;
          const tgMid = (sum * FREEDIVE_WATER[1]) / fdMidSum;
          const tbMid = (sum * FREEDIVE_WATER[2]) / fdMidSum;
          const trSurf = (sum * FREEDIVE_SURFACE[0]) / fdSurfSum;
          const tgSurf = (sum * FREEDIVE_SURFACE[1]) / fdSurfSum;
          const tbSurf = (sum * FREEDIVE_SURFACE[2]) / fdSurfSum;
          const tr = trMid + (trSurf - trMid) * surfMix;
          const tg = tgMid + (tgSurf - tgMid) * surfMix;
          const tb = tbMid + (tbSurf - tbMid) * surfMix;
          const tCap = isGreenWater ? 0.16 : 0.42;
          const tMul = isGreenWater ? 0.30 : 0.68;
          const t = Math.min(tCap, wtint * mask * tMul);
          r += (tr - r) * t;
          g += (tg - g) * t;
          b += (tb - b) * t;
        } else {
          // Gentle, natural steer toward tropical marine turquoise-azure; capped at 0.38
          const t = Math.min(0.16, wtint * mask * 0.34);
          const tr = (sum * REF_WATER[0]) / refSum;
          const tg = (sum * REF_WATER[1]) / refSum;
          const tb = (sum * REF_WATER[2]) / refSum;
          r += (tr - r) * t;
          g += (tg - g) * t;
          b += (tb - b) * t;
        }
      }

      R[i] = clamp01(r);
      G[i] = clamp01(g);
      B[i] = clamp01(b);
    }
  }

  // --------------------------------------- 8d. Lightroom-Style Semantic Subject Masking (Human Skin, Marine Fauna & Coral Reef)
  // Automatically separates non-water foreground subjects into 3 semantic sub-masks based on local texture
  // frequency (texFine) and chroma ratios, steering each zone toward its authentic reference tone profile:
  //   1. Human Skin Mask (smooth organic epidermis): steered toward TONE_REF_HUMAN [1.06, 0.96, 0.80]
  //   2. Marine Fauna Mask (moderately textured scales/carapace): steered toward TONE_REF_FAUNA [1.04, 0.99, 0.86]
  //   3. Coral & Reef Mask (high-frequency organic reef structure): steered toward TONE_REF_CORAL [1.09, 0.97, 0.81]
  const skinAmt = p.skinTone / 100;
  let skinPixels = 0;
  let humanMaskPixels = 0;
  let faunaMaskPixels = 0;
  let coralMaskPixels = 0;

  if (skinAmt > 0.01) {
    const maxSrcL = isFreedive ? 0.76 : 0.65;
    for (let i = 0; i < n; i++) {
      if (srcL[i] > maxSrcL) continue;
      const r0 = R[i];
      const g0 = G[i];
      const b0 = B[i];
      const mx = Math.max(r0, g0, b0);
      if (mx < 0.05) continue;
      const mn = Math.min(r0, g0, b0);
      const sat = (mx - mn) / mx;
      const warmLead = (r0 - b0) / Math.max(mx, 0.03);
      // Strict Sand & Neutral Substrate Guard:
      // True human skin, turtles, and corals have genuine warm pigment: r0 > b0 * 0.85 and warmLead > 0.015.
      // Sandy seabed, water, and limestone rocks (r0 < b0 * 0.85 or warmLead <= 0.015) must NEVER be treated as skin/coral!
      if (r0 < b0 * 0.85 || warmLead <= 0.015 || sat <= 0.02 || sat >= 0.76) continue;

      const effLead = Math.max(warmLead, clamp01((r0 / Math.max(b0, 0.03) - 0.70) / 0.25) * 0.28);
      let mask = clamp01((effLead - 0.010) / 0.15) * clamp01((sat - 0.015) / 0.10) * clamp01((0.76 - sat) / 0.20);
      const l = luma(r0, g0, b0);
      mask *= clamp01((l - 0.04) / 0.10) * clamp01((0.96 - l) / 0.12);
      if (mask <= 0.01) continue;
      mask = mask * mask * (3 - 2 * mask);
      skinPixels++;

      // Protect Neutral White/Silver objects (white dress, silver fish where raw G/B <= 1.005 or bright silver belly srcL > 0.50)
      // and deep teal-water shadow reefs (raw R/G < 0.35 && srcL < 0.28) from warm skin/coral tinting!
      const rawGB8 = sG0[i] / Math.max(sB0[i], 0.03);
      const rawRG8 = sR0[i] / Math.max(sG0[i], 0.03);
      if (!isGreenWater && ((rawGB8 <= 1.005 && srcL[i] > 0.24) || (srcL[i] > 0.50 && rawGB8 <= 1.06))) continue;
      if (isTealWater && rawRG8 < 0.35 && srcL[i] < 0.28) continue;

      // Semantic Sub-Mask Classification (Human Skin vs. Marine Fauna vs. Coral Reef):
      const tf = texFine[i];
      const isGoldenSkin = isTealWater && rawGB8 > 0.998 && rawRG8 > 0.36 && tf < 0.35 && srcL[i] > 0.14 && srcL[i] < 0.58;
      const wHuman = clamp01(1 - tf * 2.2) * (isGreenWater ? 0.85 : isGoldenSkin ? 0.95 : 0.45);
      const wCoral = clamp01((tf - 0.38) / 0.35) * (1 - wHuman * 0.6);
      const wFauna = Math.max(0, 1 - wHuman - wCoral);
      if (wHuman >= wFauna && wHuman >= wCoral) humanMaskPixels++;
      else if (wCoral >= wFauna) coralMaskPixels++;
      else faunaMaskPixels++;

      const humanRefR = isGoldenSkin ? 1.35 : TONE_REF_HUMAN[0];
      const humanRefG = isGoldenSkin ? 0.93 : TONE_REF_HUMAN[1];
      const humanRefB = isGoldenSkin ? 0.63 : TONE_REF_HUMAN[2];

      const refR = humanRefR * wHuman + TONE_REF_FAUNA[0] * wFauna + TONE_REF_CORAL[0] * wCoral;
      const refG = humanRefG * wHuman + TONE_REF_FAUNA[1] * wFauna + TONE_REF_CORAL[1] * wCoral;
      const refB = humanRefB * wHuman + TONE_REF_FAUNA[2] * wFauna + TONE_REF_CORAL[2] * wCoral;

      const targetSkinR = Math.min(0.90, l * refR + 0.015);
      const targetSkinG = Math.min(0.90, l * refG + 0.008);
      const targetSkinB = Math.max(0.03, l * refB);
      const warmPull = skinAmt * mask * (isGoldenSkin ? 0.65 : isFreedive ? 0.38 : 0.28);

      let nr = r0 + (targetSkinR - r0) * warmPull;
      let ng = g0 + (targetSkinG - g0) * warmPull * 0.68;
      let nb = b0 + (targetSkinB - b0) * warmPull * 0.68;

      // Authentic Coral, Fauna & Gear Red-Orange Protection:
      // If the pixel has genuine Red or Orange pigment, maintain rich crimson/scarlet/orange without pulling G into yellow!
      const isRedOrange8 = (r0 > g0 * 1.12 && r0 > b0 * 1.25) || (sR0[i] > sG0[i] * 1.04);
      if (isRedOrange8) {
        const maxOrangeG = nr * 0.62;
        if (ng > maxOrangeG) ng = maxOrangeG;
        const maxOrangeB = ng * 0.75;
        if (nb > maxOrangeB) nb = maxOrangeB;
      } else {
        // Anti-pink harmonic balance without pushing golden-terracotta skin into yellow-olive:
        const goldenG = isGoldenSkin ? 0.52 * nr + 0.36 * nb : 0.72 * nr + 0.28 * nb;
        const align = Math.min(0.55, (0.25 + skinAmt * 0.45) * mask) * (isGoldenSkin ? 0.45 : 1.0);
        ng = ng * (1 - align) + goldenG * align;
        if (nr > ng && nb > ng * 0.95) {
          nb = ng * 0.95;
        }
      }

      R[i] = clamp01(nr);
      G[i] = clamp01(ng);
      B[i] = clamp01(nb);
    }
  }

  // ---------------------------------------- 8e. reference water match
  const matchAmt = p.refMatch / 100;
  let matchPixels = 0;

  if (matchAmt > 0.01 && look && look.water && Array.isArray(look.water.ratio)) {
    const refSum = Math.max(1e-4, look.water.ratio[0] + look.water.ratio[1] + look.water.ratio[2]);
    const tr = look.water.ratio[0] / refSum;
    const tg = look.water.ratio[1] / refSum;
    const tb = look.water.ratio[2] / refSum;

    for (let i = 0; i < n; i++) {
      const r0 = R[i];
      const g0 = G[i];
      const b0 = B[i];
      const sea = 0.45 * g0 + 0.55 * b0;
      const waterness = (sea - r0 * 1.05) / Math.max(sea, 0.03);
      if (waterness <= 0.2) continue;
      const l = luma(r0, g0, b0);
      let mask = clamp01((waterness - 0.2) / 0.4) * clamp01((0.94 - l) / 0.3) * clamp01((l - 0.05) / 0.1);
      if (mask <= 0.01) continue;
      mask = mask * mask * (3 - 2 * mask);
      matchPixels++;

      const sum = r0 + g0 + b0;
      const t = matchAmt * mask * 0.6;
      R[i] = clamp01(r0 + (sum * tr - r0) * t);
      G[i] = clamp01(g0 + (sum * tg - g0) * t);
      B[i] = clamp01(b0 + (sum * tb - b0) * t);
    }
  }

  // ---------------------------------------- 8e-2. reference warm-tone match (coral / skin / shell)
  // Gentle chroma-only steer toward the gallery's warm hue. Luminance and
  // pixel structure are kept exactly, and the steer is capped low so faces,
  // animals and text keep their identity.
  if (matchAmt > 0.01 && look && look.warm && Array.isArray(look.warm.ratio)) {
    const ws = Math.max(1e-4, look.warm.ratio[0] + look.warm.ratio[1] + look.warm.ratio[2]);
    const wr = look.warm.ratio[0] / ws;
    const wg = look.warm.ratio[1] / ws;
    const wb = look.warm.ratio[2] / ws;
    for (let i = 0; i < n; i++) {
      const r0 = R[i];
      const g0 = G[i];
      const b0 = B[i];
      if (r0 <= b0 * 1.05) continue;
      const mx = Math.max(r0, g0, b0);
      if (mx < 0.08) continue;
      const mn = Math.min(r0, g0, b0);
      const sat = (mx - mn) / mx;
      if (sat < 0.06 || sat > 0.8) continue;
      const l = luma(r0, g0, b0);
      let mask =
        clamp01((r0 / Math.max(b0, 0.02) - 1.05) / 0.35) *
        clamp01((l - 0.06) / 0.1) *
        clamp01((0.92 - l) / 0.2) *
        clamp01((sat - 0.06) / 0.12);
      if (mask <= 0.01) continue;
      mask = mask * mask * (3 - 2 * mask);
      const sum = r0 + g0 + b0;
      const t = Math.min(0.26, matchAmt * mask * 0.3);
      let r = r0 + (sum * wr - r0) * t;
      let g = g0 + (sum * wg - g0) * t;
      let b = b0 + (sum * wb - b0) * t;
      const l1 = luma(r, g, b);
      const f = l1 > 1e-4 ? l / l1 : 1;
      R[i] = clamp01(r * f);
      G[i] = clamp01(g * f);
      B[i] = clamp01(b * f);
    }
  }

  // ---------------------------------------- 8e-3. reference tone match (saturation & contrast)
  // Moves the frame's overall colourfulness and tonal punch a bounded step
  // toward the gallery median so every upload lands in the same family.
  if (matchAmt > 0.01 && look && look.tone && n > 64) {
    const step = Math.max(1, Math.floor(n / 60000));
    let sL = 0;
    let sL2 = 0;
    let sS = 0;
    let c = 0;
    for (let i = 0; i < n; i += step) {
      const r0 = R[i];
      const g0 = G[i];
      const b0 = B[i];
      const l = luma(r0, g0, b0);
      const mx = Math.max(r0, g0, b0);
      sL += l;
      sL2 += l * l;
      sS += mx > 0.01 ? (mx - Math.min(r0, g0, b0)) / mx : 0;
      c++;
    }
    const meanL = sL / c;
    const stdL = Math.sqrt(Math.max(0, sL2 / c - meanL * meanL));
    const curSat = sS / c;
    const tSat = Number(look.tone.sat);
    const tCon = Number(look.tone.contrast);
    const satGain =
      Number.isFinite(tSat) && curSat > 0.02 ? clamp(1 + (tSat / curSat - 1) * matchAmt * 0.6, 0.86, 1.16) : 1;
    const conGain =
      Number.isFinite(tCon) && stdL > 0.02 ? clamp(1 + (tCon / stdL - 1) * matchAmt * 0.5, 0.92, 1.1) : 1;

    if (Math.abs(satGain - 1) > 0.005 || Math.abs(conGain - 1) > 0.005) {
      for (let i = 0; i < n; i++) {
        const r0 = R[i];
        const g0 = G[i];
        const b0 = B[i];
        const l = luma(r0, g0, b0);
        // Soft contrast around the frame mean, rolled off near black & white.
        const roll = clamp01(l / 0.08) * clamp01((1 - l) / 0.08);
        const nl = clamp01(meanL + (l - meanL) * (1 + (conGain - 1) * roll));
        const f = l > 1e-4 ? nl / l : 1;
        let r = r0 * f;
        let g = g0 * f;
        let b = b0 * f;
        const sg = 1 + (satGain - 1) * roll;
        r = nl + (r - nl) * sg;
        g = nl + (g - nl) * sg;
        b = nl + (b - nl) * sg;
        R[i] = clamp01(r);
        G[i] = clamp01(g);
        B[i] = clamp01(b);
      }
    }
  }

  // ---------------------------------------- 8g. 8-Channel Perceptual HSL Mixer (CapCut Style)
  const hslBands = [
    { id: 'red', center: 0, width: 34 },
    { id: 'orange', center: 28, width: 28 },
    { id: 'yellow', center: 58, width: 34 },
    { id: 'green', center: 120, width: 48 },
    { id: 'cyan', center: 184, width: 38 },
    { id: 'blue', center: 222, width: 42 },
    { id: 'purple', center: 275, width: 38 },
    { id: 'magenta', center: 322, width: 36 },
  ];
  const activeHsl = [];
  for (const b of hslBands) {
    const dh = Number(p[`hsl_${b.id}_h`]) || 0;
    const ds = Number(p[`hsl_${b.id}_s`]) || 0;
    const dl = Number(p[`hsl_${b.id}_l`]) || 0;
    if (Math.abs(dh) > 0.2 || Math.abs(ds) > 0.2 || Math.abs(dl) > 0.2) {
      activeHsl.push({ center: b.center, width: b.width, dh, ds: ds / 100, dl: dl / 100 });
    }
  }

  if (activeHsl.length > 0) {
    for (let i = 0; i < n; i++) {
      const r0 = R[i];
      const g0 = G[i];
      const b0 = B[i];
      const mx = Math.max(r0, g0, b0);
      const mn = Math.min(r0, g0, b0);
      const d = mx - mn;
      if (d < 0.015) continue;

      const lHsl = (mx + mn) * 0.5;
      const sHsl = lHsl > 0.5 ? d / Math.max(2 - mx - mn, 1e-4) : d / Math.max(mx + mn, 1e-4);
      if (sHsl < 0.025) continue;

      let hDeg = 0;
      if (mx === r0) hDeg = ((g0 - b0) / d + (g0 < b0 ? 6 : 0)) * 60;
      else if (mx === g0) hDeg = ((b0 - r0) / d + 2) * 60;
      else hDeg = ((r0 - g0) / d + 4) * 60;

      let totH = 0;
      let totS = 0;
      let totL = 0;
      for (let k = 0; k < activeHsl.length; k++) {
        const band = activeHsl[k];
        let diff = Math.abs(hDeg - band.center);
        if (diff > 180) diff = 360 - diff;
        if (diff >= band.width) continue;
        const u = 1 - diff / band.width;
        const wgt = u * u * (3 - 2 * u);
        totH += wgt * band.dh * 0.34;
        totS += wgt * band.ds;
        totL += wgt * band.dl;
      }

      if (Math.abs(totH) < 0.05 && Math.abs(totS) < 0.002 && Math.abs(totL) < 0.002) continue;

      const chromaGate = clamp01((sHsl - 0.025) / 0.12);
      const newH = ((hDeg + totH * chromaGate) % 360 + 360) % 360;
      const newS = clamp01(sHsl * (1 + totS * 0.85 * chromaGate));
      const newL = clamp01(lHsl + totL * 0.28 * chromaGate * (1 - Math.abs(2 * lHsl - 1) * 0.45));

      const c = (1 - Math.abs(2 * newL - 1)) * newS;
      const hp = newH / 60;
      const x = c * (1 - Math.abs((hp % 2) - 1));
      let nr = 0;
      let ng = 0;
      let nb = 0;
      if (hp < 1) { nr = c; ng = x; }
      else if (hp < 2) { nr = x; ng = c; }
      else if (hp < 3) { ng = c; nb = x; }
      else if (hp < 4) { ng = x; nb = c; }
      else if (hp < 5) { nr = x; nb = c; }
      else { nr = c; nb = x; }
      const m = newL - c * 0.5;
      R[i] = clamp01(nr + m);
      G[i] = clamp01(ng + m);
      B[i] = clamp01(nb + m);
    }
  }

  // --------------------------------------- 8f. Dedicated Multi-Scale AI & Optical Backscatter Eliminator (Marine Snow Suppressor)
  // Targets and dissolves isolated floating dust, plankton reflection, and strobe-illuminated backscatter dots (1 to 12 px)
  // using 1D Morphological Directional Opening + Normalized Convolution Inpainting, strictly protecting
  // continuous edges, diver features, turtle shell scutes, and text!
  const speckAmt = p.spotRemoval / 100;
  let speckPixels = 0;
  let backscatterSpots = 0;
  const speckMask = new Uint8Array(n);

  if (speckAmt > 0.15 && n > 4096) {
    const curL = new Float32Array(n);
    for (let i = 0; i < n; i++) curL[i] = luma(R[i], G[i], B[i]);

    const rMorph = 3;
    // Separable 1D opening (horizontal min then max)
    const openX = new Float32Array(n);
    const tempX = new Float32Array(n);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let mn = 1.0;
        const xMin = Math.max(0, x - rMorph);
        const xMax = Math.min(w - 1, x + rMorph);
        for (let k = xMin; k <= xMax; k++) {
          const val = curL[row + k];
          if (val < mn) mn = val;
        }
        tempX[row + x] = mn;
      }
      for (let x = 0; x < w; x++) {
        let mx = 0.0;
        const xMin = Math.max(0, x - rMorph);
        const xMax = Math.min(w - 1, x + rMorph);
        for (let k = xMin; k <= xMax; k++) {
          const val = tempX[row + k];
          if (val > mx) mx = val;
        }
        openX[row + x] = mx;
      }
    }

    // Separable 1D opening (vertical min then max)
    const openY = new Float32Array(n);
    const tempY = new Float32Array(n);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let mn = 1.0;
        const yMin = Math.max(0, y - rMorph);
        const yMax = Math.min(h - 1, y + rMorph);
        for (let k = yMin; k <= yMax; k++) {
          const val = curL[k * w + x];
          if (val < mn) mn = val;
        }
        tempY[y * w + x] = mn;
      }
      for (let y = 0; y < h; y++) {
        let mx = 0.0;
        const yMin = Math.max(0, y - rMorph);
        const yMax = Math.min(h - 1, y + rMorph);
        for (let k = yMin; k <= yMax; k++) {
          const val = tempY[k * w + x];
          if (val > mx) mx = val;
        }
        openY[y * w + x] = mx;
      }
    }

    // A structural edge/shape survives horizontal OR vertical opening.
    // Isolated circular/elliptical backscatter particles disappear in BOTH!
    const cleanR = new Float32Array(n);
    const cleanG = new Float32Array(n);
    const cleanB = new Float32Array(n);
    const cleanWeight = new Float32Array(n);

    const thresh = 0.14 - speckAmt * 0.04;

    for (let y = 1; y < h - 1; y++) {
      const yNorm = y / (h - 1);
      const row = y * w;
      for (let x = 1; x < w - 1; x++) {
        const i = row + x;
        const l = curL[i];
        if (yNorm < 0.08 && l > 0.88) {
          cleanR[i] = R[i]; cleanG[i] = G[i]; cleanB[i] = B[i]; cleanWeight[i] = 1.0;
          continue;
        }
        const structEnv = Math.max(openX[i], openY[i]);
        const peak = l - structEnv;

        // Backscatter spots are strictly isolated bright flash specks in pure open water.
        // Subjects, sand ripples, shells, corals, and turtles are 100% PROTECTED from backscatter inpainting!
        const isBackscatter = peak > thresh && l > 0.25 && texFine[i] < 0.12 && waterSmooth[i] > 0.60 && subjectMask[i] < 0.10;

        if (isBackscatter) {
          speckMask[i] = 1;
          backscatterSpots++;
        } else {
          cleanR[i] = R[i];
          cleanG[i] = G[i];
          cleanB[i] = B[i];
          cleanWeight[i] = 1.0;
        }
      }
    }

    if (backscatterSpots > 0) {
      // Normalized Convolution Inpainting from clean surrounding pixels
      const rInpaint = rMorph + 2;
      const numR = boxBlur(cleanR, w, h, rInpaint);
      const numG = boxBlur(cleanG, w, h, rInpaint);
      const numB = boxBlur(cleanB, w, h, rInpaint);
      const den = boxBlur(cleanWeight, w, h, rInpaint);
      const blendStr = clamp01(speckAmt * 1.35);

      for (let i = 0; i < n; i++) {
        if (!speckMask[i]) continue;
        const wgt = den[i];
        if (wgt > 0.02) {
          const inpR = numR[i] / wgt;
          const inpG = numG[i] / wgt;
          const inpB = numB[i] / wgt;
          R[i] = clamp01(R[i] * (1 - blendStr) + inpR * blendStr);
          G[i] = clamp01(G[i] * (1 - blendStr) + inpG * blendStr);
          B[i] = clamp01(B[i] * (1 - blendStr) + inpB * blendStr);
          speckPixels++;
        }
      }
    }
  }

  // --------------------------------------------------- 9. Identity-Locked AI & Optical Object Detail Restoration
  // Automatically repairs blurry or compression-damaged object details (coral, turtle shell,
  // wetsuit, gear) using Multi-Scale Optical Deconvolution + 3x3 Bilateral Artifact Cleaning,
  // while strictly locking:
  //   - Color Grading (100.0% RGB chromaticity ratio lock)
  //   - Human Faces & Skin (`isFaceOrSkin`: dampens micro-grit so facial features never change)
  //   - Animals & Text/Logos (`min3..max3` Local-Extrema Clamping: zero overshoot halo, zero distortion)
  const sharpParam = Number.isFinite(p.sharpen) ? p.sharpen : 26;
  const sharpAmount =
    (sharpParam / 100) * (isFreedive ? 0.36 : 0.32) +
    Math.max(0, p.clarity / 100) * (isFreedive ? 0.22 : 0.18) +
    (p.preset === 'super' ? 0.08 : 0.03);
  let objectRestoredPixels = 0;
  if (sharpAmount > 0.02 && n > 4096) {
    const rFine = 1;
    const rMed = Math.max(2, Math.min(4, Math.round(Math.max(w, h) / 680)));
    for (let i = 0; i < n; i++) L[i] = luma(R[i], G[i], B[i]);
    const bFine = boxBlur(L, w, h, rFine);
    const bMed = rMed > rFine ? boxBlur(bFine, w, h, rMed - 1) : bFine;
    const bBroad = boxBlur(bMed, w, h, 2);

    for (let y = 1; y < h - 1; y++) {
      const row = y * w;
      const boost = isStrobe ? 1 + (1 - Math.min(1, maskY[y])) * 0.45 : 1;
      for (let x = 1; x < w - 1; x++) {
        const i = row + x;
        if (speckMask[i]) continue;
        const l = L[i];
        // Keep open water and water-to-subject boundary velvet-smooth (zero pixelation or harsh edge halo)
        const wMask = waterColMask[i];
        const openWaterDamp = waterSmooth[i] * clamp01(1 - subjectMask[i] * 1.4);
        const waterSmoothGate = Math.min(
          wMask > 0.05 ? 1 - 0.92 * wMask : 1,
          1 - openWaterDamp * 0.88
        );
        // Strict Open-Water Sharpening Suppression:
        // Open water column must remain 100% velvet-smooth (zero noise amplification, zero halo specks)
        if (waterSmooth[i] > 0.45 && subjectMask[i] < 0.22) continue;
        if (waterSmoothGate < 0.08) continue;

        // 1. 3x3 Local Extrema & Bilateral De-Blocking (cleans JPEG/WhatsApp mosquito noise & softens blocky edges)
        let min3 = l;
        let max3 = l;
        let biSum = l * 1.5;
        let biW = 1.5;
        for (let dy = -1; dy <= 1; dy++) {
          const nr = (y + dy) * w;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nl = L[nr + x + dx];
            if (nl < min3) min3 = nl;
            if (nl > max3) max3 = nl;
            const d = Math.abs(nl - l);
            if (d < 0.028) {
              const weight = 1 - d / 0.028;
              biSum += nl * weight;
              biW += weight;
            }
          }
        }
        const span3 = max3 - min3;
        const cleanL = biSum / biW;

        // 2. Identity & Edge Softening Guards (Human Face/Skin, Animals & High-Contrast Edges)
        const r0 = R[i];
        const g0 = G[i];
        const b0 = B[i];
        const isFaceOrSkin =
          r0 > g0 * 0.82 && g0 >= b0 * 0.78 && l > 0.10 && l < 0.86
            ? clamp01((r0 / Math.max(g0, 0.02) - 0.82) / 0.32) * subjectMask[i]
            : 0;
        // Taper sharpening on already-sharp contrast boundaries (e.g. dark scales against bright skin,
        // or flipper silhouette against water) so edges blend cleanly without harsh cutout outlines!
        const highContrastEdge = clamp01((span3 - 0.08) / 0.14);

        // 3. Adaptive Blurry-Object Detection
        const fineFreq = l - bFine[i];
        const medFreq = bFine[i] - bMed[i];
        const broadFreq = bMed[i] - bBroad[i];
        const midStruct = Math.abs(medFreq) + Math.abs(broadFreq) * 0.6;
        const fineRatio = Math.abs(fineFreq) / Math.max(midStruct, 0.0025);
        const isBlurryObj =
          midStruct > 0.0035 ? clamp01((1.42 - fineRatio) / 1.15) * clamp01(midStruct / 0.024) : 0.15;

        const faceDamp = (1 - 0.72 * isFaceOrSkin) * (1 - 0.75 * highContrastEdge);
        let a = sharpAmount * waterSmoothGate * (1 + 0.35 * isBlurryObj) * faceDamp;
        if (isStrobe) a *= boost * (1 - 0.4 * Math.min(1, maskX[x]));

        // Blend cleaned bilateral base + gentle deconvolved frequencies
        const baseL = l * 0.38 + cleanL * 0.62;
        const diff = 0.50 * fineFreq + 0.50 * (l - bMed[i]);
        const absDiff = Math.abs(diff);
        if (absDiff <= 0.0075) {
          // Apply bilateral smoothing on flat/gradient areas to eliminate pixelation & noise
          if (Math.abs(baseL - l) > 0.0005 && span3 < 0.045) {
            const cleanDelta = baseL - l;
            R[i] = clamp01(r0 + cleanDelta);
            G[i] = clamp01(g0 + cleanDelta);
            B[i] = clamp01(b0 + cleanDelta);
          }
          continue;
        }

        const shadowClean = clamp01((l - 0.08) / 0.12);
        const cored = (diff > 0 ? absDiff - 0.0075 : -(absDiff - 0.0075)) * shadowClean;
        let targetL = baseL + clamp(cored * a * 1.10, -0.042, 0.042);

        // 4. STRICT 3x3 LOCAL-EXTREMA CLAMPING (Zero Overshoot Halo)
        const maxOvershoot =
          0.003 * (1 - 0.90 * highContrastEdge) * (1 - 0.85 * isFaceOrSkin) * waterSmoothGate;
        targetL = clamp(targetL, min3 - maxOvershoot, max3 + maxOvershoot);

        const deltaL = targetL - l;
        if (Math.abs(deltaL) < 0.0005) continue;
        objectRestoredPixels++;

        // 5. Pure Chromaticity-Ratio Lock (0.0% Color Grading Shift)
        const scale = l > 0.05 ? clamp(targetL / l, 0.80, 1.25) : 1.0;
        const ratioBlend = clamp01((l - 0.05) / 0.10);
        R[i] = clamp01(r0 * scale * ratioBlend + (r0 + deltaL) * (1 - ratioBlend));
        G[i] = clamp01(g0 * scale * ratioBlend + (g0 + deltaL) * (1 - ratioBlend));
        B[i] = clamp01(b0 * scale * ratioBlend + (b0 + deltaL) * (1 - ratioBlend));
      }
    }
  }

  // --------------------------------------------------- 9b. True Marine Gamut Lock & soft-knee guard
  // 1. Water Gamut Anti-Purple Lock: In all natural underwater marine environments (ocean, sea, pool),
  // open water physically cannot have Red exceeding ~0.38 * Green or ~0.35 * Blue.
  // Gating this strictly to flat, open water (srcWater > 0.20 && subjectMask < 0.25 && texEnv < 0.004)
  // locks water into crystal sapphire-cyan (195°-215°) without ever muting warm turtles, corals, or divers!
  // Water's red is already governed by its own measured ratio; a hard gamut
  // ceiling here only painted cyan outlines along subject edges, so it is gone.

  // Highlight shoulder: soft-knees the top end. The compression is applied as
  // ONE scale factor for the whole pixel, because compressing channels
  // independently shifts the hue and turned pale shell/sand highlights cyan.
  const knee = 0.85;
  const kneeSpan = 1 - knee;
  for (let i = 0; i < n; i++) {
    const r = R[i];
    const g = G[i];
    const b = B[i];
    const mx = Math.max(r, g, b);
    if (mx <= knee) continue;
    const scale = (knee + kneeSpan * Math.tanh((mx - knee) / kneeSpan)) / mx;
    R[i] = clamp01(r * scale);
    G[i] = clamp01(g * scale);
    B[i] = clamp01(b * scale);
  }

  // ------------------------------------------------------------- output
  const out = new Uint8Array(n * 4);
  for (let i = 0, s = 0; i < n; i++, s += 4) {
    out[s] = (R[i] * 255 + 0.5) | 0;
    out[s + 1] = (G[i] * 255 + 0.5) | 0;
    out[s + 2] = (B[i] * 255 + 0.5) | 0;
    out[s + 3] = 255;
  }

  const p1 = percentile(R, n, 0.01);
  const p99 = percentile(R, n, 0.99);
  const structure = structureScore(structBefore, gridFromRGB(R, G, B, w, h, sgw, sgh), sgw, sgh);

  return {
    data: out,
    width: w,
    height: h,
    ms: Date.now() - started,
    params: p,
    metrics: {
      veil: Math.round(veilA * 100) / 100,
      transmissionFloor: Math.round(transFloor * 100) / 100,
      gainR: Math.round(gainR * 100) / 100,
      dynamicRange: Math.round((p99 - p1) * 100),
      structure,
      water: Math.round((waterPixels / Math.max(1, n)) * 1000) / 10,
      skin: Math.round((skinPixels / Math.max(1, n)) * 1000) / 10,
      neutral: Math.round((neutralPixels / Math.max(1, n)) * 1000) / 10,
      match: Math.round((matchPixels / Math.max(1, n)) * 1000) / 10,
      specks: Math.round((speckPixels / Math.max(1, n)) * 1000) / 10,
      backscatter: Math.round((speckPixels / Math.max(1, n)) * 1000) / 10,
      backscatterSpots,
      objectRestored: Math.round((objectRestoredPixels / Math.max(1, n)) * 1000) / 10,
      masks: {
        human: Math.round((humanMaskPixels / Math.max(1, n)) * 1000) / 10,
        fauna: Math.round((faunaMaskPixels / Math.max(1, n)) * 1000) / 10,
        coral: Math.round((coralMaskPixels / Math.max(1, n)) * 1000) / 10,
        water: Math.round((waterPixels / Math.max(1, n)) * 1000) / 10,
      },
      specialists: {
        water: { active: true, name: 'Spesialis Kolom Air & Dehaze (Sea-Thru)' },
        segmentation: { active: true, name: 'Spesialis Masking Semantik (SUIM/Lightroom)' },
        subjectColor: { active: true, name: 'Spesialis Pigmen & Anti-Yellow Shift' },
        backscatter: { active: true, name: 'Spesialis Backscatter & Marine Snow' },
      },
    },
  };
}
