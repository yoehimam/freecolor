// Specialist 3: Subject Chrominance & Pigment Restorer (Anti Red-to-Yellow Safeguard)
// Restores authentic biological pigments (Melanin in human skin, Astaxanthin in turtle shells,
// and Zooxanthellae in coral reefs) with strict gamut protection preventing warm hues from shifting into yellow.

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function luma(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Reference chromaticity tone ratios [R, G, B] relative to luminance
const TONE_REF_HUMAN = [1.06, 0.96, 0.80];
const TONE_REF_FAUNA = [1.04, 0.99, 0.86];
const TONE_REF_CORAL = [1.38, 0.72, 0.54]; // Deep rich coral-red & terracotta

export function restoreSubjectChrominance({
  R,
  G,
  B,
  w,
  h,
  sR0,
  sG0,
  sB0,
  srcL,
  masks,
  skinToneParam = 0,
  redRestoreParam = 0,
  isGreenWater = false,
  isTealWater = false,
  isFreedive = true,
}) {
  const n = w * h;
  const skinAmt = skinToneParam / 100;
  const redAmt = redRestoreParam / 100;
  if (skinAmt <= 0.01 && redAmt <= 0.01) return { subjectModifiedPixels: 0 };

  const { human: maskHuman, fauna: maskFauna, coral: maskCoral } = masks;
  let subjectModifiedPixels = 0;
  const maxSrcL = isFreedive ? 0.76 : 0.65;

  for (let i = 0; i < n; i++) {
    if (srcL[i] > maxSrcL) continue;

    const wHuman = maskHuman[i];
    const wFauna = maskFauna[i];
    const wCoral = maskCoral[i];
    const subWeight = Math.max(wHuman, wFauna, wCoral);
    if (subWeight <= 0.04) continue;

    const r0 = R[i];
    const g0 = G[i];
    const b0 = B[i];
    const mx = Math.max(r0, g0, b0);
    if (mx < 0.05) continue;
    const mn = Math.min(r0, g0, b0);
    const sat = (mx - mn) / mx;
    if (sat <= 0.015 || sat >= 0.78) continue;

    const l = luma(r0, g0, b0);
    if (l < 0.04 || l > 0.96) continue;

    // Check for neutral white / silver objects to avoid artificial warm staining
    const rawGB = sG0[i] / Math.max(sB0[i], 0.03);
    const rawRG = sR0[i] / Math.max(sG0[i], 0.03);
    if (!isGreenWater && ((rawGB <= 1.005 && srcL[i] > 0.24) || (srcL[i] > 0.50 && rawGB <= 1.06))) continue;
    if (isTealWater && rawRG < 0.35 && srcL[i] < 0.28) continue;

    // Interpolate target tone profile based on semantic sub-masks
    const wSum = Math.max(1e-4, wHuman + wFauna + wCoral);
    const nH = wHuman / wSum;
    const nF = wFauna / wSum;
    const nC = wCoral / wSum;

    const isGoldenSkin = isTealWater && rawGB > 0.998 && rawRG > 0.36 && nH > 0.5;
    const humanR = isGoldenSkin ? 1.35 : TONE_REF_HUMAN[0];
    const humanG = isGoldenSkin ? 0.93 : TONE_REF_HUMAN[1];
    const humanB = isGoldenSkin ? 0.63 : TONE_REF_HUMAN[2];

    const refR = humanR * nH + TONE_REF_FAUNA[0] * nF + TONE_REF_CORAL[0] * nC;
    const refG = humanG * nH + TONE_REF_FAUNA[1] * nF + TONE_REF_CORAL[1] * nC;
    const refB = humanB * nH + TONE_REF_FAUNA[2] * nF + TONE_REF_CORAL[2] * nC;

    const targetR = Math.min(0.92, l * refR + 0.015);
    const targetG = Math.min(0.90, l * refG + 0.008);
    const targetB = Math.max(0.03, l * refB);

    const pull = (skinAmt * 0.75 + redAmt * 0.25) * subWeight * (isGoldenSkin ? 0.65 : isFreedive ? 0.38 : 0.28);
    let nr = r0 + (targetR - r0) * pull;
    let ng = g0 + (targetG - g0) * pull * 0.68;
    let nb = b0 + (targetB - b0) * pull * 0.68;

    // =========================================================================
    // CRITICAL: ANTI RED-TO-YELLOW GAMUT PROTECTION (Preserves Authentic Reds/Oranges)
    // =========================================================================
    const isRedOrange = (r0 > g0 * 1.12 && r0 > b0 * 1.25) || (sR0[i] > sG0[i] * 1.04);
    if (isRedOrange) {
      // In underwater optics, true red and terracotta orange must NOT have green exceeding 62% of red.
      // Exceeding 62% shifts the hue angle from 10°-30° (red/orange) to 45°-55° (mustard yellow).
      const maxOrangeG = nr * 0.62;
      if (ng > maxOrangeG) ng = maxOrangeG;
      const maxOrangeB = ng * 0.75;
      if (nb > maxOrangeB) nb = maxOrangeB;
    } else {
      // Anti-pink harmonic balance for skin tones without pushing terracotta into yellow-olive
      const goldenG = isGoldenSkin ? 0.52 * nr + 0.36 * nb : 0.72 * nr + 0.28 * nb;
      const align = Math.min(0.55, (0.25 + skinAmt * 0.45) * subWeight) * (isGoldenSkin ? 0.45 : 1.0);
      ng = ng * (1 - align) + goldenG * align;
      if (nr > ng && nb > ng * 0.95) {
        nb = ng * 0.95;
      }
    }

    R[i] = clamp01(nr);
    G[i] = clamp01(ng);
    B[i] = clamp01(nb);
    subjectModifiedPixels++;
  }

  return {
    subjectModifiedPixels,
  };
}
