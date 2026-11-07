// What the app learns from every frame the owner keeps.
//
// There is no training here: each accepted render (saved to the archive or
// marked "pas") is one sample of "this is what looked right for this gear and
// this camera". Samples are folded into running averages, and those averages
// bias the starting point of the *next* photo — per gear profile first, the
// whole collection second. Averages need a few samples before they are allowed
// to move anything, so one unusual edit cannot wreck the defaults.
//
// Everything stays in data/db.json next to the rest of the store.

import { normalizeParams } from './presets.js';

const MIN_WEIGHT_SAMPLES = 6;

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function bucket(store, key) {
  if (!store[key]) store[key] = { n: 0, params: {} };
  return store[key];
}

export function ensureLearning(db) {
  if (!db.learning || typeof db.learning !== 'object') {
    db.learning = { samples: 0, all: { n: 0, params: {} }, byGear: {}, updatedAt: 0 };
  }
  const l = db.learning;
  if (!l.all) l.all = { n: 0, params: {} };
  if (!l.byGear || typeof l.byGear !== 'object') l.byGear = {};
  if (!Number.isFinite(l.samples)) l.samples = 0;
  return l;
}

/** Fold one accepted parameter set into the running averages. */
export function recordFeedback(db, { params, gear = 'umum', source = 'render' } = {}) {
  const p = normalizeParams(params);
  const learning = ensureLearning(db);
  const targets = [bucket(learning, 'all'), null];

  const gearBucket = bucket(learning.byGear, gear || 'umum');
  targets[1] = gearBucket;

  for (const target of targets) {
    target.n += 1;
    for (const [key, value] of Object.entries(p)) {
      if (key === 'preset') {
        target.params.preset = value;
        continue;
      }
      const prev = Number(target.params[key]);
      target.params[key] = Number.isFinite(prev)
        ? prev + (Number(value) - prev) / target.n
        : Number(value);
    }
  }

  learning.samples += 1;
  learning.updatedAt = Date.now();
  learning.lastSource = String(source || 'render').slice(0, 24);
  return learningSummary(db);
}

/**
 * Blend of the learned averages, as a prior for a new photo. `weight` stays 0
 * until a few samples exist, then grows toward 0.36 — enough to be felt, not
 * enough to override what this particular photo needs.
 */
export function learnedPrior(db, { gear = 'umum' } = {}) {
  const learning = ensureLearning(db);
  const gearBucket = learning.byGear[gear] || learning.byGear.umum || null;
  const allBucket = learning.all;

  let weight = 0;
  const params = {};

  const accumulate = (bucketData, cap) => {
    if (!bucketData || bucketData.n < 2) return;
    const w = clamp((bucketData.n - MIN_WEIGHT_SAMPLES + 4) / (bucketData.n + 18), 0, 1) * cap;
    if (w <= 0) return;
    for (const [key, value] of Object.entries(bucketData.params)) {
      if (key === 'preset') continue;
      const num = Number(value);
      if (!Number.isFinite(num)) continue;
      params[key] = (params[key] || 0) + num * w;
    }
    weight += w;
  };

  accumulate(gearBucket, 0.22);
  accumulate(allBucket, 0.14);

  if (weight <= 0) return { params: null, weight: 0, samples: learning.samples };

  const out = {};
  for (const [key, value] of Object.entries(params)) out[key] = value / weight;

  return { params: out, weight: clamp(weight, 0, 0.36), samples: learning.samples };
}

/** Pull a parameter set toward the learned prior. Presets are left alone. */
export function blendPrior(params, prior) {
  const base = normalizeParams(params);
  if (!prior || !prior.params || prior.weight <= 0) return base;

  const out = { ...base };
  for (const [key, value] of Object.entries(prior.params)) {
    if (key === 'preset') continue;
    const cur = Number(base[key]);
    if (!Number.isFinite(cur)) continue;
    out[key] = cur + (Number(value) - cur) * prior.weight;
  }
  return normalizeParams(out);
}

export function learningSummary(db) {
  const learning = ensureLearning(db);
  const gears = Object.entries(learning.byGear)
    .filter(([, b]) => b && b.n > 0)
    .map(([id, b]) => ({ id, samples: b.n }))
    .sort((a, b) => b.samples - a.samples);

  return {
    samples: learning.samples,
    gears,
    updatedAt: learning.updatedAt || null,
    ready: Boolean(learning.all && learning.all.n >= MIN_WEIGHT_SAMPLES - 2),
  };
}
