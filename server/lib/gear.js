// Camera / gear profiles.
//
// Each profile describes how a camera writes an underwater frame *before* our
// physics runs: flat log curves, a cool cast, crushed highlights, a slightly
// green blue. The profile is a bias on the auto-tune (and on whatever the
// sliders currently hold, when the user switches mid-session) — the pixel
// pipeline itself never changes, so no gear can be used to fake detail.
//
// Bias numbers are intentionally small: they nudge tone, not colour identity.
// Keys match presets.js RANGES; anything else is ignored by normalizeParams().

import { normalizeParams } from './presets.js';

export const GEARS = {
  umum: {
    id: 'umum',
    label: 'Umum',
    tagline: 'Tidak diubah',
    note: 'Bawaan kamera apa pun. Pakai ini kalau rekamannya sudah normal.',
    bias: {},
  },
  osmo: {
    id: 'osmo',
    label: 'DJI Osmo',
    tagline: 'D-Log M datar, agak sejuk',
    note: 'D-Log M menyimpan kontras rendah dan biru yang sejuk: diberi ketebalan, saturasi, dan sedikit kehangatan lebih dulu.',
    bias: {
      temperature: 12,
      contrast: 16,
      saturation: 6,
      vibrance: 10,
      waterTint: 4,
      skinTone: 4,
      shadows: 4,
      highlight: -8,
      rolloff: 8,
    },
  },
  gopro: {
    id: 'gopro',
    label: 'GoPro',
    tagline: 'Protune datar, hijau-biru',
    note: 'Protune datar cenderung hijau dan rendah kontras: hijau ditekan lewat kehangatan, kontras dan saturasi diangkat, sorot diredam.',
    bias: {
      temperature: 16,
      contrast: 14,
      saturation: 8,
      vibrance: 8,
      skinTone: 2,
      shadows: 6,
      highlight: -10,
      neutral: 6,
      rolloff: 10,
    },
  },
  mirrorless: {
    id: 'mirrorless',
    label: 'Mirrorless',
    tagline: 'Warna sudah matang',
    note: 'Kamera mirrorless dengan lampu selam sudah punya warna dan rentang bagus: cukup sentuhan kecil supaya tidak over-edit.',
    bias: {
      temperature: 4,
      contrast: 5,
      saturation: 2,
      vibrance: 4,
      skinTone: 3,
      highlight: -4,
      rolloff: 5,
    },
  },
};

export const GEAR_IDS = Object.keys(GEARS);

export function gearProfile(id) {
  return GEARS[id] || GEARS.umum;
}

export function gearList() {
  return GEAR_IDS.map((id) => {
    const g = GEARS[id];
    return { id, label: g.label, tagline: g.tagline, note: g.note, bias: g.bias };
  });
}

/**
 * Gear bias on top of a full parameter set. Normalising first means a sparse
 * input still gets the preset defaults before the bias is added, so a GoPro
 * frame keeps its preset character instead of collapsing to plain bias values.
 */
export function applyGear(raw = {}, gearId = 'umum') {
  const gear = gearProfile(gearId);
  const base = normalizeParams(raw);
  const out = { ...base };
  for (const [key, value] of Object.entries(gear.bias)) {
    const cur = Number(base[key]);
    out[key] = (Number.isFinite(cur) ? cur : 0) + value;
  }
  return normalizeParams(out);
}
