// Nikolaj Bech & DeepSeaLabs Underwater Color Restoration Engine
// Reference:
// - https://github.com/nikolajbech/underwater-image-color-correction (Paralenz Color Filter Matrix)
// - https://github.com/deepsealabs/underwater (Ancuti Opponent Red Compensation with Diversity Trust)

import { clamp01, clamp } from './color.js';

/**
 * Rotates hue in the YIQ / color space to project absorbed red spectrum
 * from surviving green & blue channels.
 */
export function hueShiftRed(r, g, b, h) {
  const U = Math.cos((h * Math.PI) / 180);
  const W = Math.sin((h * Math.PI) / 180);

  const rOut = (0.299 + 0.701 * U + 0.168 * W) * r;
  const gOut = (0.587 - 0.587 * U + 0.330 * W) * g;
  const bOut = (0.114 - 0.114 * U - 0.497 * W) * b;

  return { r: rOut, g: gOut, b: bOut };
}

/**
 * Finds the optimal dynamic range interval under histogram thresholding.
 */
function normalizingInterval(normArray) {
  let high = 255;
  let low = 0;
  let maxDist = 0;

  for (let i = 1; i < normArray.length; i++) {
    const dist = normArray[i] - normArray[i - 1];
    if (dist > maxDist) {
      maxDist = dist;
      high = normArray[i];
      low = normArray[i - 1];
    }
  }

  return { low, high };
}

/**
 * Computes Nikolaj Bech color filter matrix directly from image pixel data.
 * Runs in ~2-5ms even on mobile CPUs.
 */
export function computeNikolajMatrix(pixels, width, height, stride = 4) {
  const numOfPixels = width * height;
  const thresholdRatio = 2000;
  const minAvgRed = 60;
  const maxHueShift = 120;
  const blueMagicValue = 1.2;

  // Use sampling on large images for ultra-fast calculation
  const sampleStep = Math.max(1, Math.floor(numOfPixels / 150_000));
  let count = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;

  for (let i = 0; i < numOfPixels; i += sampleStep) {
    const s = i * stride;
    sumR += pixels[s];
    sumG += pixels[s + 1];
    sumB += pixels[s + 2];
    count++;
  }

  const avg = {
    r: sumR / count,
    g: sumG / count,
    b: sumB / count,
  };

  // Calculate hue shift needed to reach minimum viable red energy
  let hueShift = 0;
  let newAvgRed = avg.r;
  while (newAvgRed < minAvgRed) {
    const shifted = hueShiftRed(avg.r, avg.g, avg.b, hueShift);
    newAvgRed = shifted.r + shifted.g + shifted.b;
    hueShift++;
    if (hueShift > maxHueShift) {
      newAvgRed = 60;
      break;
    }
  }

  const histR = new Int32Array(256);
  const histG = new Int32Array(256);
  const histB = new Int32Array(256);

  for (let i = 0; i < numOfPixels; i += sampleStep) {
    const s = i * stride;
    const r = pixels[s];
    const g = pixels[s + 1];
    const b = pixels[s + 2];

    const shifted = hueShiftRed(r, g, b, hueShift);
    const sRed = Math.min(255, Math.max(0, Math.round(shifted.r + shifted.g + shifted.b)));

    histR[sRed]++;
    histG[g]++;
    histB[b]++;
  }

  const thresholdLevel = count / thresholdRatio;
  const normR = [0];
  const normG = [0];
  const normB = [0];

  for (let i = 0; i < 256; i++) {
    if (histR[i] - thresholdLevel < 2) normR.push(i);
    if (histG[i] - thresholdLevel < 2) normG.push(i);
    if (histB[i] - thresholdLevel < 2) normB.push(i);
  }

  normR.push(255);
  normG.push(255);
  normB.push(255);

  const adjR = normalizingInterval(normR);
  const adjG = normalizingInterval(normG);
  const adjB = normalizingInterval(normB);

  const shifted1 = hueShiftRed(1, 1, 1, hueShift);
  const redSpan = Math.max(1, adjR.high - adjR.low);
  const greenSpan = Math.max(1, adjG.high - adjG.low);
  const blueSpan = Math.max(1, adjB.high - adjB.low);

  const redGain = 256 / redSpan;
  const greenGain = 256 / greenSpan;
  const blueGain = 256 / blueSpan;

  const redOffset = (-adjR.low / 256) * redGain;
  const greenOffset = (-adjG.low / 256) * greenGain;
  const blueOffset = (-adjB.low / 256) * blueGain;

  const adjstRed = shifted1.r * redGain;
  const adjstRedGreen = shifted1.g * redGain;
  const adjstRedBlue = shifted1.b * redGain * blueMagicValue;

  return {
    adjstRed,
    adjstRedGreen,
    adjstRedBlue,
    redOffset,
    greenGain,
    greenOffset,
    blueGain,
    blueOffset,
    hueShift,
    meanR: avg.r / 255,
    meanG: avg.g / 255,
    meanB: avg.b / 255,
  };
}

/**
 * DeepSeaLabs scene diversity trust metric:
 * Calculates whether a scene is a monochromatic water column or contains diverse subject matter (reef, fish, turtle).
 */
export function calculateDiversityTrust(pixels, width, height, stride = 4) {
  const n = width * height;
  const step = Math.max(1, Math.floor(n / 50_000));
  let coloredCount = 0;
  let sumCos = 0;
  let sumSin = 0;

  for (let i = 0; i < n; i += step) {
    const s = i * stride;
    const r = pixels[s] / 255;
    const g = pixels[s + 1] / 255;
    const b = pixels[s + 2] / 255;

    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const d = mx - mn;
    if (mx < 0.05 || d / mx < 0.12) continue; // skip neutral/gray pixels

    let h = 0;
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 * Math.PI) / 180;

    sumCos += Math.cos(h);
    sumSin += Math.sin(h);
    coloredCount++;
  }

  if (coloredCount < 16) return 0.5;
  const rBar = Math.sqrt(sumCos * sumCos + sumSin * sumSin) / coloredCount;
  // Circular variance = 1 - rBar. Higher = rich color diversity (coral/fish/diver); Lower = monochromatic water.
  const circVar = 1 - rBar;
  return clamp(circVar * 1.5, 0.45, 1.0);
}

/**
 * Apply combined Nikolaj Bech + DeepSeaLabs color correction.
 * Can operate directly on R, G, B Float32Arrays [0..1] with blend factor [0..1].
 */
export function applyNikolajDeepSeaCorrection(R, G, B, n, matrix, blend = 1.0, diversityTrust = 1.0) {
  if (blend <= 0.001 || !matrix) return;

  const {
    adjstRed,
    adjstRedGreen,
    adjstRedBlue,
    redOffset,
    greenGain,
    greenOffset,
    blueGain,
    blueOffset,
    meanR,
    meanG,
  } = matrix;

  const effAlpha = blend * diversityTrust;
  const meanGap = Math.max(0, meanG - meanR);

  for (let i = 0; i < n; i++) {
    const r0 = R[i];
    const g0 = G[i];
    const b0 = B[i];

    // 1. Nikolaj Bech matrix projection:
    // Transforms RGB through the calibrated color filter matrix
    const nikR = clamp01(r0 * adjstRed + g0 * adjstRedGreen + b0 * adjstRedBlue + redOffset);
    const nikG = clamp01(g0 * greenGain + greenOffset);
    const nikB = clamp01(b0 * blueGain + blueOffset);

    // 2. DeepSeaLabs Opponent Red Compensation (protects already-red subjects):
    const dslR = clamp01(r0 + effAlpha * meanGap * (1.0 - r0) * g0);

    // 3. Harmonize: Blend the Nikolaj matrix red restoration with DeepSeaLabs opponent safeguard
    const finalR = r0 * (1 - blend) + (nikR * 0.70 + dslR * 0.30) * blend;
    const finalG = g0 * (1 - blend) + nikG * blend;
    const finalB = b0 * (1 - blend) + nikB * blend;

    R[i] = clamp01(finalR);
    G[i] = clamp01(finalG);
    B[i] = clamp01(finalB);
  }
}
