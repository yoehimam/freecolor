// Editing presets. Every value is a sane default that the UI sliders then
// offset; normalizeParams() is the single source of truth for ranges, so both
// the HTTP layer and the pixel pipeline clamp identically.

export const HSL_CHANNELS = [
  'red',
  'orange',
  'yellow',
  'green',
  'cyan',
  'blue',
  'purple',
  'magenta',
];

const DEFAULT_HSL = {};
for (const ch of HSL_CHANNELS) {
  DEFAULT_HSL[`hsl_${ch}_h`] = 0;
  DEFAULT_HSL[`hsl_${ch}_s`] = 0;
  DEFAULT_HSL[`hsl_${ch}_l`] = 0;
}

export const PRESETS = {
  // Signature Freedive look: royal cobalt-sapphire ocean water (Hue ~214°),
  // luminous golden-tan skin & amber turtle/reef tones, pearl-white sand/gear,
  // and 3D selective micro-contrast (velvet water + tack-sharp reef/subject).
  freedive: {
    label: 'Freedive Time',
    tagline: 'Biru kobalt, skintone & detail 3D',
    base: {
      redRestore: 46, veil: 42, attenuation: 34, clarity: 24, sharpen: 22, vibrance: 14, saturation: 2,
      waterLight: 12, waterTint: 22, skinTone: 32, refMatch: 0, neutral: 28, rolloff: 44,
      spotRemoval: 0,
      contrast: 8, exposure: 0, temperature: 3, tint: 0, shadows: 6, highlight: -15,
      whites: 0, blacks: 0, fade: 0, vignette: 3,
      ...DEFAULT_HSL,
    },
  },
  alami: {
    label: 'Bening',
    tagline: 'Air apa adanya',
    base: {
      redRestore: 40, veil: 40, attenuation: 30, clarity: 20, sharpen: 22, vibrance: 13, saturation: 2,
      waterLight: 16, waterTint: 11, skinTone: 22, refMatch: 0, neutral: 12, rolloff: 28,
      spotRemoval: 0,
      contrast: 5, exposure: 1, temperature: 4, tint: 0, shadows: 6, highlight: -6,
      whites: 0, blacks: 0, fade: 0, vignette: 0,
      ...DEFAULT_HSL,
    },
  },
  kreatif: {
    label: 'Segar',
    tagline: 'Air bening, warna wajar',
    base: {
      redRestore: 52, veil: 50, attenuation: 40, clarity: 30, sharpen: 28, vibrance: 20, saturation: 4,
      waterLight: 20, waterTint: 16, skinTone: 30, refMatch: 0, neutral: 14, rolloff: 32,
      spotRemoval: 0,
      contrast: 9, exposure: 2, temperature: 8, tint: 0, shadows: 7, highlight: -9,
      whites: 0, blacks: 0, fade: 0, vignette: 4,
      ...DEFAULT_HSL,
    },
  },
  super: {
    label: 'Menyala',
    tagline: 'Lebih tegas, tetap wajar',
    base: {
      redRestore: 62, veil: 58, attenuation: 48, clarity: 38, sharpen: 34, vibrance: 28, saturation: 8,
      waterLight: 26, waterTint: 20, skinTone: 34, refMatch: 0, neutral: 10, rolloff: 38,
      spotRemoval: 0,
      contrast: 14, exposure: 3, temperature: 11, tint: 0, shadows: 6, highlight: -12,
      whites: 0, blacks: 0, fade: 0, vignette: 6,
      ...DEFAULT_HSL,
    },
  },
  strobe: {
    label: 'Sorot',
    tagline: 'Pusat frame paling terang',
    base: {
      redRestore: 50, veil: 46, attenuation: 36, clarity: 34, sharpen: 30, vibrance: 18, saturation: 4,
      waterLight: 18, waterTint: 13, skinTone: 26, refMatch: 0, neutral: 13, rolloff: 30,
      spotRemoval: 0,
      contrast: 10, exposure: 1, temperature: 6, tint: 0, shadows: 8, highlight: -8,
      whites: 0, blacks: 0, fade: 0, vignette: 6,
      ...DEFAULT_HSL,
    },
  },
  // The jury standard: neutral sand and hardware, soft highlight shoulder, real
  // skin, blue water that is still blue. No split tone, no vignette, no
  // saturation push — the frame has to survive being looked at closely.
  lomba: {
    label: 'Lomba',
    tagline: 'Standar juri',
    base: {
      redRestore: 48, veil: 48, attenuation: 38, clarity: 26, sharpen: 26, vibrance: 16, saturation: 3,
      waterLight: 17, waterTint: 15, skinTone: 28, refMatch: 0, neutral: 26, rolloff: 48,
      spotRemoval: 0,
      contrast: 8, exposure: 1, temperature: 6, tint: 0, shadows: 6, highlight: -14,
      whites: 0, blacks: 0, fade: 0, vignette: 0,
      ...DEFAULT_HSL,
    },
  },
};

export const PRESET_IDS = ['freedive', 'kreatif', 'alami', 'super', 'strobe', 'lomba'];

export const OCEAN_LUTS = [
  { id: 'freedive', name: 'Solstice LUT', tag: 'Signature Freedive', desc: 'Safir laut dalam, skintone hangat & kontras 3D', icon: '🌊', color: '#00d4ff' },
  { id: 'alami', name: 'Tropical Azure', tag: 'Dangkal & Karang', desc: 'Air toska jernih, pasir putih cerah khas tropis', icon: '🏖️', color: '#38d6c4' },
  { id: 'kreatif', name: 'Deep Ocean', tag: 'Samudra 15m+', desc: 'Menembus kabut biru tebal & menonjolkan biota laut', icon: '🐋', color: '#3b82f6' },
  { id: 'super', name: 'Emerald Reef', tag: 'Air Hijau / Danau', desc: 'Koreksi dominasi hijau keruh & pulihkan spektrum merah', icon: '🌿', color: '#10b981' },
  { id: 'strobe', name: 'Coral Vivid', tag: 'Macro & Karang', desc: 'Warna karang menyala, polip tajam & biota hidup', icon: '🪸', color: '#f59e0b' },
  { id: 'lomba', name: 'Natural Master', tag: 'Standar Juri', desc: 'Koreksi seimbang & autentik tanpa oversaturasi', icon: '🏆', color: '#a78bfa' },
];

const HSL_RANGES = {};
for (const ch of HSL_CHANNELS) {
  HSL_RANGES[`hsl_${ch}_h`] = [-100, 100];
  HSL_RANGES[`hsl_${ch}_s`] = [-100, 100];
  HSL_RANGES[`hsl_${ch}_l`] = [-100, 100];
}

const RANGES = {
  redRestore: [0, 100],
  veil: [0, 100],
  attenuation: [0, 100],
  waterLight: [0, 100],
  waterTint: [0, 100],
  skinTone: [0, 100],
  refMatch: [0, 100],
  neutral: [0, 100],
  rolloff: [0, 100],
  spotRemoval: [0, 100],
  clarity: [-50, 100],
  sharpen: [0, 100],
  vibrance: [-50, 100],
  saturation: [-100, 100],
  contrast: [-60, 80],
  exposure: [-80, 80],
  temperature: [-60, 60],
  tint: [-50, 50],
  shadows: [-60, 80],
  highlight: [-80, 60],
  whites: [-50, 50],
  blacks: [-50, 50],
  fade: [0, 100],
  vignette: [-50, 80],
  ...HSL_RANGES,
};

export function presetList() {
  return PRESET_IDS.map((id) => ({ id, ...PRESETS[id] }));
}

function num(value, fallback, lo, hi) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

export function normalizeParams(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const preset = PRESET_IDS.includes(source.preset) ? source.preset : 'kreatif';
  const base = PRESETS[preset].base;
  const out = { preset };
  for (const [key, [lo, hi]] of Object.entries(RANGES)) {
    out[key] = Math.round(num(source[key], base[key], lo, hi) * 10) / 10;
  }
  return out;
}
