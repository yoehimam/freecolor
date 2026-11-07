// Specialist 1: Water Column & Physical Attenuation Engine (Sea-Thru / Akkaynak-Treibitz Model)
// Evaluates water background light B_inf and wavelength-dependent attenuation coefficients
// to neutralize green/cyan water haze, recover transmission depth, and steer the water
// toward deep oceanic cobalt-blue (or the user-selected reference water profile).

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function luma(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function restoreWaterColumn({
  R,
  G,
  B,
  w,
  h,
  maskWater,
  waterLightParam = 0,
  waterTintParam = 0,
  refMatchParam = 0,
  targetWaterRatio = [0.16, 0.72, 1.0], // Freedive Cobalt Blue baseline
  look = null,
}) {
  const n = w * h;
  const wlAmt = waterLightParam / 100;
  const wtAmt = waterTintParam / 100;
  const matchAmt = refMatchParam / 100;

  // If a custom reference look is active, blend its water ratio
  let targetR = targetWaterRatio[0];
  let targetG = targetWaterRatio[1];
  let targetB = targetWaterRatio[2];

  if (matchAmt > 0.01 && look && look.water && Array.isArray(look.water.ratio)) {
    const sum = Math.max(1e-4, look.water.ratio[0] + look.water.ratio[1] + look.water.ratio[2]);
    const refR = look.water.ratio[0] / sum;
    const refG = look.water.ratio[1] / sum;
    const refB = look.water.ratio[2] / sum;
    targetR = targetR * (1 - matchAmt * 0.75) + refR * (matchAmt * 0.75);
    targetG = targetG * (1 - matchAmt * 0.75) + refG * (matchAmt * 0.75);
    targetB = targetB * (1 - matchAmt * 0.75) + refB * (matchAmt * 0.75);
  }

  const sumT = Math.max(1e-4, targetR + targetG + targetB);
  targetR /= sumT;
  targetG /= sumT;
  targetB /= sumT;

  let waterModifiedPixels = 0;

  for (let i = 0; i < n; i++) {
    const wm = maskWater[i];
    if (wm <= 0.05) continue;

    let r = R[i];
    let g = G[i];
    let b = B[i];

    const l = luma(r, g, b);
    if (l < 0.03 || l > 0.96) continue;

    const sum = Math.max(1e-4, r + g + b);

    // 1. Water Tint & Green Neutralization
    // Under natural oceanic conditions, water's Green channel should not exceed ~78% of Blue
    const maxOceanG = b * 0.78;
    if (g > maxOceanG && wtAmt >= 0) {
      const gExcess = g - maxOceanG;
      const tSuppress = clamp01(wm * (0.35 + wtAmt * 0.45));
      g -= gExcess * tSuppress;
    }

    // 2. Reference Target Alignment on Open Water
    if (matchAmt > 0.01 || wtAmt !== 0) {
      const steerStrength = clamp01(wm * Math.max(matchAmt * 0.55, Math.abs(wtAmt) * 0.35));
      r = r * (1 - steerStrength) + sum * targetR * steerStrength;
      g = g * (1 - steerStrength) + sum * targetG * steerStrength;
      b = b * (1 - steerStrength) + sum * targetB * steerStrength;
    }

    // 3. Water Luminance / Light Adjustment
    if (Math.abs(wlAmt) > 0.01) {
      const lScale = 1.0 + wlAmt * 0.35 * wm;
      r *= lScale;
      g *= lScale;
      b *= lScale;
    }

    R[i] = clamp01(r);
    G[i] = clamp01(g);
    B[i] = clamp01(b);
    waterModifiedPixels++;
  }

  return {
    waterModifiedPixels,
    targetWaterRatio: [targetR, targetG, targetB],
  };
}
