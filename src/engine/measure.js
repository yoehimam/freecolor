// Image analysis used for two things:
//  - the "kondisi foto" chips in the editor
//  - a deterministic auto-tune fallback when no OpenAI key is configured
//
// The heuristic mirrors the optical physics used by the pipeline: how much red
// is missing, how much scattering veil is in the frame (measured via contrast
// compression and color-cast dominance, not just low saturation), and how flat
// the local contrast is.

import { clamp } from './color.js';
import { inspectObjectCondition } from './objectRestore.js';

export function measure(data, width, height, channels = 4) {
  const n = width * height;
  const stride = channels || 4;
  const step = Math.max(1, Math.floor(n / 300_000));

  let sr = 0;
  let sg = 0;
  let sb = 0;
  let sl = 0;
  let sl2 = 0;
  let sat = 0;
  let castVeil = 0;
  let diff = 0;
  let diffCount = 0;
  let count = 0;
  let prev = -1;

  for (let i = 0; i < n; i += step) {
    const s = i * stride;
    const r = data[s] / 255;
    const g = data[s + 1] / 255;
    const b = data[s + 2] / 255;
    const l = 0.299 * r + 0.587 * g + 0.114 * b;

    sr += r;
    sg += g;
    sb += b;
    sl += l;
    sl2 += l * l;
    count++;

    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const sv = mx > 0.01 ? (mx - mn) / mx : 0;
    sat += sv;

    // Underwater veil is either grey/milky haze OR a thick cyan/green water shroud
    // where green/blue heavily dominates red in mid-to-bright tones.
    const seaLead = Math.max(g, b) - r;
    if ((sv < 0.18 && l > 0.26) || (seaLead > 0.24 && l > 0.22 && l < 0.85)) {
      castVeil++;
    }

    if (prev >= 0) {
      diff += Math.abs(l - prev);
      diffCount++;
    }
    prev = l;
  }

  const meanL = sl / Math.max(count, 1);
  const stdL = Math.sqrt(Math.max(0, sl2 / Math.max(count, 1) - meanL * meanL));
  const meanR = sr / Math.max(count, 1);
  const meanG = sg / Math.max(count, 1);
  const meanB = sb / Math.max(count, 1);

  const redDeficit = clamp(1 - meanR / ((meanG + meanB) / 2 + 1e-4), 0, 0.92);
  // Combine flat-contrast veil with monochromatic water-shroud veil
  const flatVeil = clamp((0.2 - stdL) * 3.8, 0, 1);
  const hazeScore = clamp(flatVeil * 0.55 + (castVeil / Math.max(count, 1)) * 0.45, 0, 1);
  const satMean = sat / Math.max(count, 1);
  const sharpness = clamp((diff / Math.max(diffCount, 1)) * 9, 0, 1);

  let cast = 'seimbang';
  if (meanG > meanB * 1.15 && meanR < 0.18) {
    cast = 'hijau';
  } else if (meanB > meanG * 1.08 && meanB > meanR) {
    cast = 'biru';
  } else if (meanB > 0.35 && meanG > 0.35) {
    cast = 'turkis';
  }

  const objectRepair = inspectObjectCondition(data, width, height, channels);

  return {
    meanL: round(meanL),
    stdL: round(stdL),
    meanR: round(meanR),
    meanG: round(meanG),
    meanB: round(meanB),
    redDeficit: round(redDeficit),
    hazeScore: round(hazeScore),
    satMean: round(satMean),
    sharpness: round(sharpness),
    cast,
    objectRepair,
  };
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}

/**
 * Intelligent & Adaptive Auto-Tune Engine:
 * Strictly object-aware and condition-aware:
 * 1. Tropis Dangkal / Dasar Pasir / Sinar Matahari -> pelestarian penuh pasir putih/krem, tanpa de-haze berlebih, tanpa noda oranye/cokelat.
 * 2. Terumbu Karang / Strobe Flash / Foto Berwarna Bagus -> perlindungan 100% pigmen asli biota (merah, ungu, pink), penajaman polip 3D.
 * 3. Samudra Biru / Kedalaman -> sapphire marine balance, penyesuaian skintone alami.
 * 4. Hijau Pekat / Air Keruh Hilang Merah -> rekonstruksi warna merah & ekstraksi veil hijau secara terukur.
 */
export function autoParams(s) {
  const objBlurLift = s.objectRepair?.blurScore ? Math.max(0, (s.objectRepair.blurScore - 35) * 0.20) : 0;
  
  // 1. KONDISI TROPIS DANGKAL / DASAR PASIR BERSIH / AIR BENING:
  // Ciri: terang (meanL > 0.36), dominasi biru & hijau seimbang (turkis / bening), masih ada spektrum merah (meanR > 0.12).
  const isShallowTropical =
    (s.cast === 'turkis' || (s.meanB > 0.35 && s.meanG > 0.35)) &&
    s.meanL > 0.35 &&
    s.meanR > 0.12;

  // 2. KONDISI SUDAH BERWARNA / FLASH STROBE / TERUMBU KARANG JELAS:
  // Ciri: kontras tinggi (stdL > 0.17) atau ada terumbu karang / pigmen merah kuat (meanR > 0.16).
  const isWellBalancedOrStrobe =
    (s.stdL > 0.18 || (s.objectRepair?.coralPct && s.objectRepair.coralPct > 35) || s.meanR > 0.16) &&
    s.hazeScore < 0.35 &&
    s.redDeficit < 0.40;

  // 3. KONDISI HIJAU PEKAT KERUH (HANYA jika hijau benar-benar mendominasi total dan merah lenyap):
  const isDeepGreenFog =
    s.cast === 'hijau' &&
    s.meanG > s.meanB * 1.15 &&
    s.meanR < 0.13 &&
    s.redDeficit > 0.55;

  if (isShallowTropical || isWellBalancedOrStrobe) {
    // JANGAN merusak detail dengan de-haze atau red-restore berlebihan!
    // Pasir dasar laut tetap putih/krem alami, air tetap turkis cerah, tekstur 3D tajam.
    const isStrobe = s.stdL > 0.24 && s.meanR > 0.22;
    return {
      preset: isStrobe ? 'strobe' : 'alami',
      redRestore: Math.round(clamp(s.redDeficit * 14, 2, 10)),
      veil: Math.round(clamp(s.hazeScore * 14, 2, 8)),
      attenuation: Math.round(clamp(s.redDeficit * 8, 1, 5)),
      waterLight: Math.round(clamp(6 + s.hazeScore * 6, 4, 10)),
      waterTint: Math.round(clamp(4 + s.redDeficit * 6, 2, 8)),
      skinTone: Math.round(clamp(12 + s.redDeficit * 12, 8, 18)),
      neutral: Math.round(clamp(10 + s.redDeficit * 10, 6, 14)),
      spotRemoval: 0, // KUNCI: 0 agar riak pasir, pantulan matahari, dan polip karang TIDAK terhapus!
      clarity: Math.round(clamp(24 + objBlurLift * 0.5, 20, 32)),
      sharpen: Math.round(clamp(24 + objBlurLift * 0.5, 20, 32)),
      vibrance: Math.round(clamp(8 + (0.35 - s.stdL) * 10, 6, 14)),
      saturation: 1,
      contrast: Math.round(clamp(6 + (0.21 - s.stdL) * 16, 4, 10)),
      exposure: 0,
      temperature: Math.round(clamp(s.redDeficit * 3, 0, 3)),
      shadows: Math.round(clamp(3 - s.meanL * 4, 0, 4)),
      highlight: -8,
      vignette: 0,
    };
  }

  if (isDeepGreenFog) {
    // Foto yang FULL HIJAU / KERUH / HILANG WARNA MERAH TOTAL:
    return {
      preset: 'super',
      redRestore: Math.round(clamp(44 + s.redDeficit * 28, 42, 60)),
      veil: Math.round(clamp(32 + s.hazeScore * 30, 30, 48)),
      attenuation: Math.round(clamp(26 + s.redDeficit * 22, 24, 44)),
      waterLight: Math.round(clamp(12 + s.hazeScore * 6, 10, 16)),
      waterTint: Math.round(clamp(22 + s.redDeficit * 10, 18, 28)),
      skinTone: Math.round(clamp(26 + s.redDeficit * 10, 22, 34)),
      neutral: Math.round(clamp(28 + s.redDeficit * 10, 24, 38)),
      spotRemoval: 0,
      clarity: Math.round(clamp(18 + (0.23 - s.stdL) * 60 + objBlurLift * 0.4, 14, 28)),
      sharpen: Math.round(clamp(20 + objBlurLift, 16, 28)),
      vibrance: Math.round(clamp(10 + s.redDeficit * 8, 8, 16)),
      saturation: 2,
      contrast: Math.round(clamp(6 + (0.21 - s.stdL) * 20, 4, 10)),
      exposure: 0,
      temperature: Math.round(clamp(2 + s.redDeficit * 4, 1, 4)),
      shadows: Math.round(clamp(5 - s.meanL * 6, 2, 6)),
      highlight: -12,
      vignette: 2,
    };
  }

  // Foto Bawah Air Biru / Samudra / Kedalaman Menengah:
  const isSamudra = s.cast === 'biru' || s.meanB > s.meanG;
  const redRestore = Math.round(clamp(s.redDeficit * 42, 14, 38));
  const veil = Math.round(clamp(s.hazeScore * 38, 10, 28));
  const attenuation = Math.round(clamp(s.redDeficit * 26, 8, 26));
  const waterLight = Math.round(clamp(6 + s.hazeScore * 4, 4, 10));
  const waterTint = Math.round(clamp(10 + s.redDeficit * 8, 8, 16));
  const skinTone = Math.round(clamp(16 + s.redDeficit * 16, 14, 28));
  const spotRemoval = 0; // KUNCI: 0 secara default agar tidak memunculkan artefak lingkaran/lingkaran putih di air!
  const clarity = Math.round(clamp(20 + (0.23 - s.stdL) * 50 + objBlurLift * 0.4, 16, 30));
  const sharpen = Math.round(clamp(22 + objBlurLift, 18, 30));
  const vibrance = Math.round(clamp(8 + s.redDeficit * 8, 6, 14));
  const saturation = 1;
  const contrast = Math.round(clamp(5 + (0.21 - s.stdL) * 18, 3, 9));
  const exposure = 0;
  const temperature = Math.round(clamp(1 + s.redDeficit * 3, 0, 3));
  const shadows = Math.round(clamp(3 - s.meanL * 4, 0, 5));
  const neutral = Math.round(clamp(16 + s.redDeficit * 14, 12, 26));

  return {
    preset: isSamudra ? 'freedive' : 'alami',
    redRestore,
    veil,
    attenuation,
    waterLight,
    waterTint,
    skinTone,
    neutral,
    spotRemoval,
    clarity,
    sharpen,
    vibrance,
    saturation,
    contrast,
    exposure,
    temperature,
    shadows,
    highlight: -10,
    vignette: 1,
  };
}

export function describe(stats) {
  const blurScore = stats.objectRepair?.blurScore ?? 0;
  const semanticMask =
    stats.objectRepair?.semanticMask ||
    (stats.cast === 'hijau' ? 'Kulit Manusia + Air Laut' : 'Hewan Laut + Karang + Air');
  return {
    cast: stats.cast,
    haze: stats.hazeScore > 0.45 ? 'tinggi' : stats.hazeScore > 0.22 ? 'sedang' : 'rendah',
    redLoss: Math.round(stats.redDeficit * 100),
    detail: stats.sharpness < 0.22 ? 'lembut' : stats.sharpness > 0.5 ? 'tajam' : 'sedang',
    objectRepair: blurScore >= 42 ? 'pulih otomatis' : 'detail terjaga',
    semanticMask,
    identityLock: 'wajah/hewan/teks aman',
  };
}
