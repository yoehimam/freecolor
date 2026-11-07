// Specialist 2: Semantic Masking & Object Segmentation (SUIM & Lightroom AI Masking Logic)
// Evaluates intrinsic optical signatures, texture frequencies, and chrominance ratios
// to separate underwater scenes into 4 discrete semantic zones:
//   1. Human Diver & Skintone (HD)
//   2. Marine Fauna / Vertebrates (FV - Turtles, Fish, Rays)
//   3. Coral Reef & Invertebrates (RI)
//   4. Background Water Column (BW)

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function analyzeSemanticMasks({
  w,
  h,
  sR0,
  sG0,
  sB0,
  srcL,
  texFine,
  isGreenWater,
  isTealWater,
  subjectMask,
  isFreedive = true,
}) {
  const n = w * h;
  const maskHuman = new Float32Array(n);
  const maskFauna = new Float32Array(n);
  const maskCoral = new Float32Array(n);
  const maskWater = new Float32Array(n);

  let humanPixels = 0;
  let faunaPixels = 0;
  let coralPixels = 0;
  let waterPixels = 0;

  for (let i = 0; i < n; i++) {
    const l = srcL[i];
    const sub = subjectMask[i];
    const tf = texFine[i];
    const r0 = sR0[i];
    const g0 = sG0[i];
    const b0 = sB0[i];

    // Water probability: inversely proportional to subject presence & texture
    const wWaterVal = clamp01((1 - sub * 1.35) * (1 - tf * 1.5));
    maskWater[i] = wWaterVal;
    if (wWaterVal > 0.5) waterPixels++;

    if (sub <= 0.04 || l < 0.05 || l > 0.94) continue;

    const rawGB = g0 / Math.max(b0, 0.03);
    const rawRG = r0 / Math.max(g0, 0.03);

    // Human Skin signature: smooth organic epidermis (tf < 0.35), warm lead or lit diver skin
    const isGoldenSkin = isTealWater && rawGB > 0.998 && rawRG > 0.36 && tf < 0.35 && l > 0.14 && l < 0.65;
    const wHumanVal = clamp01(1 - tf * 2.2) * (isGreenWater ? 0.85 : isGoldenSkin ? 0.95 : 0.45) * sub;

    // Coral Reef signature: high-frequency rough benthic structures (tf > 0.38)
    const wCoralVal = clamp01((tf - 0.38) / 0.35) * (1 - wHumanVal * 0.6) * sub;

    // Marine Fauna signature: moderate texture, smooth curvature (turtles, fish body)
    const wFaunaVal = Math.max(0, sub - wHumanVal - wCoralVal);

    maskHuman[i] = wHumanVal;
    maskCoral[i] = wCoralVal;
    maskFauna[i] = wFaunaVal;

    if (wHumanVal >= wFaunaVal && wHumanVal >= wCoralVal && wHumanVal > 0.1) {
      humanPixels++;
    } else if (wCoralVal >= wFaunaVal && wCoralVal > 0.1) {
      coralPixels++;
    } else if (wFaunaVal > 0.1) {
      faunaPixels++;
    }
  }

  const denom = Math.max(1, n);
  return {
    masks: {
      human: maskHuman,
      fauna: maskFauna,
      coral: maskCoral,
      water: maskWater,
    },
    counts: {
      humanPixels,
      faunaPixels,
      coralPixels,
      waterPixels,
      humanPct: Math.round((humanPixels / denom) * 1000) / 10,
      faunaPct: Math.round((faunaPixels / denom) * 1000) / 10,
      coralPct: Math.round((coralPixels / denom) * 1000) / 10,
      waterPct: Math.round((waterPixels / denom) * 1000) / 10,
    },
  };
}
