import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import heicDecode from 'heic-decode';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { loadEnv } from './lib/env.js';
loadEnv();

import { processImage } from './lib/pipeline.js';
import { measure, autoParams, describe } from './lib/measure.js';
import { presetList, normalizeParams } from './lib/presets.js';
import { aiAnalyze, aiEnabled, aiModel, aiProvider, aiBaseUrl, aiCheck, generateMagicImage } from './lib/ai.js';
import { spectralEnhance, spectralStatus, spectralUrl } from './lib/spectral.js';
import { GEARS, gearList, applyGear } from './lib/gear.js';
import { analyzeReference, publicLook, blendLooks } from './lib/look.js';
import { recordFeedback, learnedPrior, blendPrior, learningSummary } from './lib/learning.js';
import { db, save, flushSyncNow, DIRS, prune, ROOT } from './lib/store.js';
import {
  hashPassword,
  checkPassword,
  parseCookies,
  validEmail,
  SESSION_COOKIE,
  GUEST_COOKIE,
  SESSION_TTL,
} from './lib/auth.js';

const PORT = Number(process.env.PORT) || 8787;
const DEMO_MODE = process.env.DEMO_MODE !== '0';
const GUEST_LIMIT = 8;
const USER_DAILY_LIMIT = 400;
const MAX_UPLOAD_MB = 25;
const MAX_IMAGE_PIXELS = 64_000_000; // 64 MP decompression bomb guard
const MAX_CACHE_ENTRIES = 500;
const MAX_GALLERY_PER_USER = 200;

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', 1);
}
app.use(express.json({ limit: '256kb' }));

/* ------------------------------------------------------------------ utils */

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function clampInt(value, lo, hi, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

function safeName(name) {
  return String(name || 'foto.jpg').replace(/[^\w.\- ]+/g, '').slice(0, 90) || 'foto.jpg';
}

function setBoundedMap(map, key, val, max = MAX_CACHE_ENTRIES) {
  if (map.has(key)) map.delete(key);
  map.set(key, val);
  if (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

function createSharp(input, opts = {}) {
  return sharp(input, { limitInputPixels: MAX_IMAGE_PIXELS, ...opts });
}

function isAllowedImageUpload(file) {
  if (!file) return false;
  const mime = String(file.mimetype || '').toLowerCase();
  if (mime.startsWith('image/')) return true;
  const name = String(file.originalname || '').toLowerCase();
  return /\.(heic|heif|avif|jpe?g|png|webp|bmp|gif|tiff?)$/i.test(name);
}

function isHeicMagic(buf, filename = '') {
  if (Buffer.isBuffer(buf) && buf.length >= 16) {
    const box = buf.subarray(4, 8).toString('ascii');
    if (box === 'ftyp') {
      const brands = buf.subarray(8, Math.min(buf.length, 36)).toString('ascii').toLowerCase();
      if (/(heic|heix|hevc|heim|heis|hevm|hevs|mif1|msf1)/.test(brands)) {
        return true;
      }
    }
  }
  return /\.(heic|heif)$/i.test(String(filename || ''));
}

async function openInputImage(buffer, filename = '') {
  const meta = await createSharp(buffer).metadata().catch(() => null);
  const needsHeicFallback =
    (meta?.format === 'heif' && meta?.compression !== 'av1') ||
    (!meta?.width && isHeicMagic(buffer, filename));

  if (!needsHeicFallback && meta?.width && meta?.height) {
    if (meta.width * meta.height > MAX_IMAGE_PIXELS) {
      throw new HttpError(413, 'Resolusi gambar terlalu besar (maksimal 64 MP).');
    }
    return {
      width: meta.width,
      height: meta.height,
      toSharp: () => createSharp(buffer).rotate(),
    };
  }

  if (needsHeicFallback || isHeicMagic(buffer, filename)) {
    if (meta?.width && meta?.height && meta.width * meta.height > MAX_IMAGE_PIXELS) {
      throw new HttpError(413, 'Resolusi gambar terlalu besar (maksimal 64 MP).');
    }
    try {
      const decoded = await heicDecode({ buffer });
      if (!decoded?.width || !decoded?.height || !decoded?.data) {
        throw new Error('Invalid HEIC decode output');
      }
      if (decoded.width * decoded.height > MAX_IMAGE_PIXELS) {
        throw new HttpError(413, 'Resolusi gambar terlalu besar (maksimal 64 MP).');
      }
      const rawBuf = Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength);
      const rawOpts = { raw: { width: decoded.width, height: decoded.height, channels: 4 } };
      return {
        width: decoded.width,
        height: decoded.height,
        toSharp: () => createSharp(rawBuf, rawOpts),
      };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(422, 'File HEIC/HEIF tidak bisa dibaca atau rusak.');
    }
  }

  throw new HttpError(422, 'File gambar tidak bisa dibaca.');
}

/* ---------------------------------------------------------- rate limiting */

const buckets = new Map();
const MAX_BUCKETS = 10_000;

function rateLimit(req, name, max, windowMs) {
  if (DEMO_MODE) return true;
  const key = `${req.ip || 'local'}:${name}`;
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now > bucket.reset) {
    bucket = { count: 0, reset: now + windowMs };
    if (buckets.size >= MAX_BUCKETS && !buckets.has(key)) {
      const oldestKey = buckets.keys().next().value;
      if (oldestKey !== undefined) buckets.delete(oldestKey);
    }
    buckets.set(key, bucket);
  }
  bucket.count++;
  return bucket.count <= max;
}

/* ------------------------------------------------------- sessions / guest */

app.use((req, res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  if (token) {
    const session = db.sessions.find((s) => s.token === token && s.expiresAt > Date.now());
    if (session) {
      const user = db.users.find((u) => u.id === session.userId);
      if (user) req.user = user;
    }
  }

  let guest = cookies[GUEST_COOKIE];
  if (!guest || !/^[a-f0-9]{32}$/.test(guest)) {
    guest = crypto.randomBytes(16).toString('hex');
    res.cookie(GUEST_COOKIE, guest, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 365,
      secure: process.env.COOKIE_SECURE === '1',
    });
  }
  req.guestId = guest;

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// Same-origin & Fetch-Metadata guard for state-changing requests.
const allowedHosts = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function isHostAllowed(targetUrl, selfHost) {
  const host = new URL(targetUrl).hostname;
  return (
    host === selfHost ||
    allowedHosts.includes(host) ||
    host === 'localhost' ||
    host === '127.0.0.1'
  );
}

app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();

  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'same-site' && fetchSite !== 'none') {
    return res.status(403).json({ error: 'Cross-site request ditolak.' });
  }

  const self = String(req.headers.host || '').split(':')[0];
  const sourceUrl = req.headers.origin || req.headers.referer;
  if (sourceUrl) {
    try {
      if (!isHostAllowed(sourceUrl, self)) {
        return res.status(403).json({ error: 'Origin tidak diizinkan.' });
      }
    } catch {
      return res.status(403).json({ error: 'Origin tidak valid.' });
    }
  }
  next();
});

/* --------------------------------------------------------------- storage */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (isAllowedImageUpload(file)) return cb(null, true);
    cb(new HttpError(415, 'Hanya file gambar (JPG, PNG, WEBP, HEIC/HEIF) yang didukung.'));
  },
});

const staticMediaOpts = {
  maxAge: '2h',
  dotfiles: 'ignore',
  setHeaders: (res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  },
};

app.use('/media/uploads', express.static(DIRS.uploads, staticMediaOpts));
app.use('/media/renders', express.static(DIRS.renders, staticMediaOpts));
app.use('/media/refs', express.static(DIRS.refs, staticMediaOpts));

/* ------------------------------------------------------------- quota/gate */

function consumeQuota(req) {
  if (DEMO_MODE) {
    return {
      ok: true,
      demo: true,
      account: true,
      used: 0,
      limit: 999999,
      remaining: 999999,
    };
  }

  if (req.user) {
    const day = new Date().toISOString().slice(0, 10);
    const record = db.quota[req.user.id] || (db.quota[req.user.id] = { day, count: 0 });
    if (record.day !== day) {
      record.day = day;
      record.count = 0;
    }
    if (record.count >= USER_DAILY_LIMIT) {
      return { ok: false, status: 429, message: 'Jatah harian habis. Besok lanjut lagi ya.' };
    }
    record.count++;
    save();
    return {
      ok: true,
      account: true,
      used: record.count,
      limit: USER_DAILY_LIMIT,
      remaining: USER_DAILY_LIMIT - record.count,
    };
  }

  // Enforce a secondary per-IP guest limit to prevent cookie-clearing quota bypass
  const ipKey = `ip:${req.ip || 'local'}`;
  const ipGuest = db.guests[ipKey] || (db.guests[ipKey] = { count: 0, createdAt: Date.now() });
  const guest = db.guests[req.guestId] || (db.guests[req.guestId] = { count: 0, createdAt: Date.now() });

  if (guest.count >= GUEST_LIMIT || ipGuest.count >= GUEST_LIMIT * 3) {
    return {
      ok: false,
      status: 402,
      message: 'Jatah coba sudah habis. Bikin akun (gratis) untuk lanjut mengolah.',
      needsAuth: true,
    };
  }
  guest.count++;
  ipGuest.count++;
  save();
  return {
    ok: true,
    account: false,
    used: guest.count,
    limit: GUEST_LIMIT,
    remaining: GUEST_LIMIT - guest.count,
  };
}

function publicAsset(asset) {
  return {
    id: asset.id,
    name: asset.name,
    width: asset.width,
    height: asset.height,
    gear: asset.gear || 'umum',
    stats: asset.stats,
    auto: asset.auto,
    createdAt: asset.createdAt,
    beforeUrl: `/media/uploads/${asset.id}-view.jpg`,
    thumbUrl: `/media/uploads/${asset.id}-thumb.jpg`,
  };
}

function findAsset(id, req) {
  if (!id || typeof id !== 'string') throw new HttpError(400, 'assetId wajib diisi.');
  const asset = db.assets.find((a) => a.id === id);
  if (!asset) throw new HttpError(404, 'Foto tidak ditemukan. Coba unggah ulang.');
  if (asset.userId && asset.userId !== req.user?.id) throw new HttpError(403, 'Foto ini milik akun lain.');
  if (!asset.userId && asset.guestId && asset.guestId !== req.guestId && !req.user && !DEMO_MODE) {
    throw new HttpError(403, 'Sesi tidak cocok. Muat ulang halaman lalu coba lagi.');
  }
  return asset;
}

function parseParamsQuery(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(String(raw));
  } catch {
    return {};
  }
}

const renderDims = new Map();
const renderMeta = new Map();
const inFlightRenders = new Map();

// In-memory LRU cache of base resized raw bitmaps to make slider adjustments instantaneous (0-1ms clone vs 350ms decode)
const sourceBitmapCache = new Map();
const MAX_SOURCE_BITMAPS = 8;

function getCachedSourceBitmap(assetId, edge) {
  const key = `${assetId}:${edge}`;
  const hit = sourceBitmapCache.get(key);
  if (!hit) return null;
  return {
    data: Buffer.from(hit.data),
    info: { ...hit.info },
  };
}

function setCachedSourceBitmap(assetId, edge, bitmap) {
  const key = `${assetId}:${edge}`;
  if (sourceBitmapCache.size >= MAX_SOURCE_BITMAPS) {
    const oldest = sourceBitmapCache.keys().next().value;
    if (oldest) sourceBitmapCache.delete(oldest);
  }
  sourceBitmapCache.set(key, {
    data: Buffer.from(bitmap.data),
    info: { ...bitmap.info },
  });
}

// Bump when an engine algorithm changes so cached renders are not reused.
const SPECTRAL_REV = 'spectral-v9';
const PIPELINE_REV = 'pipe-v35-fast-preview';

/**
 * Produces the raw bitmap a render starts from.
 * "lokal"  -> sharp decode, the JS pipeline does the physics.
 * "spektral" -> the Python service restores colour first, then the JS pipeline
 *               only applies tone/grading (skipRestoration). If the service is
 *               down we degrade gracefully to the local engine.
 */
async function buildBitmap(source, edge, params, engine) {
  if (engine === 'spektral') {
    try {
      const prepared = await createSharp(source)
        .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' })
        .jpeg({ quality: 96, chromaSubsampling: '4:4:4', mozjpeg: true })
        .toBuffer();

      const enhanced = await spectralEnhance(prepared, {
        strength: 0.35 + 0.35 * (params.redRestore / 100),
      });

      const bitmap = await createSharp(enhanced.buffer)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      return {
        bitmap,
        skipRestoration: true,
        provider: enhanced.provider,
        model: enhanced.model,
        spectralMs: enhanced.ms,
      };
    } catch (err) {
      console.warn('[spectral] fallback ke pipeline lokal:', err.message);
    }
  }

  const bitmap = await createSharp(source)
    .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    bitmap,
    skipRestoration: false,
    provider: engine === 'spektral' ? 'lokal-fallback' : 'lokal',
    model: null,
    spectralMs: 0,
  };
}

async function pruneAssetRenders(assetId, keepCount = 36) {
  try {
    const allFiles = await fs.promises.readdir(DIRS.renders);
    const prefix = `${assetId}-`;
    const matching = allFiles.filter((f) => f.startsWith(prefix));
    if (matching.length <= keepCount) return;

    const withStats = await Promise.all(
      matching.map(async (f) => {
        try {
          const st = await fs.promises.stat(path.join(DIRS.renders, f));
          return { f, t: st.mtimeMs };
        } catch {
          return null;
        }
      })
    );
    const valid = withStats.filter(Boolean).sort((a, b) => b.t - a.t);
    for (const stale of valid.slice(keepCount)) {
      await fs.promises.unlink(path.join(DIRS.renders, stale.f)).catch(() => {});
      renderDims.delete(stale.f);
      renderMeta.delete(stale.f);
    }
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------- API */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    demoMode: DEMO_MODE,
    ai: aiEnabled(),
    aiProvider: aiProvider(),
    model: aiEnabled() ? aiModel() : null,
    presets: presetList(),
    gears: gearList(),
    learning: learningSummary(db),
    limits: { maxUploadMb: MAX_UPLOAD_MB, guest: DEMO_MODE ? 999999 : GUEST_LIMIT, daily: USER_DAILY_LIMIT },
    uptime: Math.round(process.uptime()),
  });
});

// Cek koneksi penyedia AI: key valid? base URL benar? model tersedia?
app.get(
  '/api/ai/check',
  asyncRoute(async (req, res) => {
    if (!rateLimit(req, 'ai-check', 10, 60_000)) throw new HttpError(429, 'Terlalu sering. Tunggu sebentar.');
    const result = await aiCheck();
    res.json({
      ok: result.ok,
      enabled: aiEnabled(),
      model: result.model,
      modelListed: result.modelListed ?? null,
      ms: result.ms,
      ...(result.error ? { error: result.error } : {}),
    });
  })
);

// Status engine spektrum (service Python FastAPI).
app.get(
  '/api/engine/status',
  asyncRoute(async (req, res) => {
    const status = await spectralStatus();
    res.json({
      ok: status.ok,
      active: status.active || null,
      providers: status.providers || [],
      ...(status.error ? { error: status.error } : {}),
    });
  })
);

app.post(
  '/api/upload',
  (req, res, next) => {
    if (!rateLimit(req, 'upload', 30, 60_000)) {
      return res.status(429).json({ error: 'Kebanyakan sekaligus. Tarik napas dulu, lalu coba lagi.' });
    }
    next();
  },
  upload.single('photo'),
  asyncRoute(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'File foto wajib dikirim.');

    const inputImg = await openInputImage(req.file.buffer, req.file.originalname);

    const quota = consumeQuota(req);
    if (!quota.ok) {
      return res.status(quota.status).json({ error: quota.message, needsAuth: quota.needsAuth });
    }

    const id = crypto.randomUUID();
    const { data: original, info: origInfo } = await inputImg
      .toSharp()
      .resize({ width: 4800, height: 4800, fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' })
      .jpeg({ quality: 97, chromaSubsampling: '4:4:4', mozjpeg: true })
      .toBuffer({ resolveWithObject: true });

    const origPath = path.join(DIRS.uploads, `${id}.jpg`);
    const viewPath = path.join(DIRS.uploads, `${id}-view.jpg`);
    const thumbPath = path.join(DIRS.uploads, `${id}-thumb.jpg`);

    // Process and write all sizes in memory/parallel without redundant disk reads
    const [, viewResult] = await Promise.all([
      fs.promises.writeFile(origPath, original),
      createSharp(original)
        .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' })
        .jpeg({ quality: 94, chromaSubsampling: '4:4:4', mozjpeg: true })
        .toBuffer(),
      createSharp(original)
        .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' })
        .jpeg({ quality: 86, chromaSubsampling: '4:4:4' })
        .toFile(thumbPath),
    ]);

    const [, { data, info }] = await Promise.all([
      fs.promises.writeFile(viewPath, viewResult),
      createSharp(viewResult).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    ]);

    const stats = measure(data, info.width, info.height, 4);

    // Gear profile first (flat log curves, cool casts), then whatever the app
    // has learned from frames the owner actually kept. Both only move the
    // starting point of the sliders; the physics is identical for every camera.
    const gearId = GEARS[req.body?.gear] ? req.body.gear : 'umum';
    const rawAuto = applyGear(autoParams(stats), gearId);
    const isPreservePhoto = rawAuto.preset === 'alami' || rawAuto.preset === 'strobe' || stats.cast === 'turkis' || stats.meanR > 0.14;
    const auto = isPreservePhoto ? rawAuto : blendPrior(rawAuto, learnedPrior(db, { gear: gearId }));

    const asset = {
      id,
      userId: req.user?.id || null,
      guestId: req.user ? null : req.guestId,
      name: safeName(req.file.originalname),
      width: origInfo.width || info.width,
      height: origInfo.height || info.height,
      gear: gearId,
      stats,
      auto,
      createdAt: Date.now(),
    };

    db.assets.push(asset);
    // Keep the store bounded during long sessions and clean up evicted files.
    if (db.assets.length > 400) {
      const removed = db.assets.splice(0, db.assets.length - 400);
      const galleryAssetIds = new Set(db.gallery.map((g) => g.assetId));
      for (const old of removed) {
        if (!galleryAssetIds.has(old.id)) {
          for (const suffix of ['', '-view', '-thumb']) {
            fs.promises.unlink(path.join(DIRS.uploads, `${old.id}${suffix}.jpg`)).catch(() => {});
          }
        }
      }
    }
    save();

    res.json({
      asset: publicAsset(asset),
      quota,
      condition: describe(stats),
      aiEnabled: aiEnabled(),
    });
  })
);

app.post(
  '/api/render',
  (req, res, next) => {
    if (!rateLimit(req, 'render', 180, 60_000)) {
      return res.status(429).json({ error: 'Keburu cepat. Beri jeda sedikit.' });
    }
    next();
  },
  asyncRoute(async (req, res) => {
    const { assetId } = req.body || {};
    const asset = findAsset(assetId, req);

    const engine = req.body?.engine === 'spektral' ? 'spektral' : 'lokal';
    const params = normalizeParams(req.body?.params || asset.auto);
    const edge = clampInt(req.body?.edge, 800, 3600, 2400);
    const gearId = GEARS[req.body?.gear] ? req.body.gear : asset.gear && GEARS[asset.gear] ? asset.gear : 'umum';
    const reference = findReference(req.body?.refId, req);
    const look = reference?.look || null;
    const lookKey = look?.water?.ratio
      ? [
          ...look.water.ratio,
          ...(look.warm?.ratio || []),
          look.tone?.contrast ?? 0,
          look.tone?.sat ?? 0,
        ]
          .map((v) => Number(v).toFixed(3))
          .join(',')
      : '';
    const key = crypto
      .createHash('sha1')
      .update(
        `${edge}|${engine}|${PIPELINE_REV}|${engine === 'spektral' ? SPECTRAL_REV : ''}|${gearId}|${lookKey}|${JSON.stringify(params)}`
      )
      .digest('hex')
      .slice(0, 12);
    const file = `${asset.id}-${key}.jpg`;
    const outPath = path.join(DIRS.renders, file);

    let ms = 0;
    const exists = await fs.promises
      .access(outPath)
      .then(() => true)
      .catch(() => false);

    if (!exists) {
      let renderJob = inFlightRenders.get(file);
      if (!renderJob) {
        renderJob = (async () => {
          let built;
          if (engine === 'spektral') {
            const source = await fs.promises.readFile(path.join(DIRS.uploads, `${asset.id}.jpg`));
            built = await buildBitmap(source, edge, params, engine);
          } else {
            let bitmap = getCachedSourceBitmap(asset.id, edge);
            if (!bitmap) {
              const viewPath = path.join(DIRS.uploads, `${asset.id}-view.jpg`);
              const masterPath = path.join(DIRS.uploads, `${asset.id}.jpg`);
              const srcFile = (edge <= 2400 && fs.existsSync(viewPath)) ? viewPath : masterPath;
              const source = await fs.promises.readFile(srcFile);
              const decoded = await createSharp(source)
                .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' })
                .ensureAlpha()
                .raw()
                .toBuffer({ resolveWithObject: true });
              setCachedSourceBitmap(asset.id, edge, decoded);
              bitmap = decoded;
            }
            built = {
              bitmap,
              skipRestoration: false,
              provider: 'lokal',
              model: null,
              spectralMs: 0,
            };
          }
          const { data, info } = built.bitmap;

          const result = processImage({ data, width: info.width, height: info.height, channels: 4 }, params, {
            skipRestoration: built.skipRestoration,
            look,
          });
          await createSharp(result.data, { raw: { width: info.width, height: info.height, channels: 4 } })
            .jpeg({ quality: 95, chromaSubsampling: '4:4:4', mozjpeg: true })
            .toFile(outPath);

          setBoundedMap(renderDims, file, { width: info.width, height: info.height });
          setBoundedMap(renderMeta, file, {
            engine,
            provider: built.provider,
            model: built.model,
            spectralMs: built.spectralMs,
            metrics: result.metrics,
          });

          // Asynchronously prune old render variants without blocking the response
          pruneAssetRenders(asset.id, 36);
          return result.ms;
        })();
        inFlightRenders.set(file, renderJob);
      }

      try {
        ms = await renderJob;
      } finally {
        inFlightRenders.delete(file);
      }
    }

    let dims = renderDims.get(file);
    if (!dims) {
      // Server restarted after this variant was cached: read the real size once.
      const meta = await createSharp(outPath).metadata().catch(() => null);
      dims = meta?.width ? { width: meta.width, height: meta.height } : { width: asset.width, height: asset.height };
      if (meta?.width) setBoundedMap(renderDims, file, dims);
    }
    const meta = renderMeta.get(file) || {
      engine,
      provider: engine === 'spektral' ? 'spektral-cache' : 'lokal',
      model: null,
      spectralMs: 0,
      metrics: null,
    };

    res.json({
      url: `/media/renders/${file}?v=${key}`,
      width: dims.width,
      height: dims.height,
      ms,
      cached: ms === 0,
      engine: meta.engine || engine,
      provider: meta.provider,
      spectralModel: meta.model,
      spectralMs: meta.spectralMs,
      metrics: meta.metrics || null,
      params,
      gear: gearId,
      reference: reference ? { id: reference.id, name: reference.name, water: publicLook(reference.look)?.water || null } : null,
      condition: describe(asset.stats),
    });
  })
);

app.post(
  '/api/analyze',
  asyncRoute(async (req, res) => {
    const asset = findAsset(req.body?.assetId, req);

    // Strict Quota Protection: If asset was already analyzed by AI, reuse persistent analysis immediately (0 tokens spent!)
    if (asset.ai && !req.body?.force) {
      res.json({
        mode: 'ai',
        fromCache: true,
        scene: asset.ai.scene,
        water_tint: asset.ai.water_tint || 'biru',
        depthM: asset.ai.depthM,
        backscatter: asset.ai.backscatter,
        subject: asset.ai.subject,
        notes: asset.ai.notes,
        model: asset.ai.model,
        params: asset.ai.params || normalizeParams(asset.auto),
        auto: normalizeParams(asset.auto),
        condition: describe(asset.stats),
        aiEnabled: true,
      });
      return;
    }

    if (!rateLimit(req, `analyze:${req.user?.id || req.guestId}`, 20, 60_000)) {
      throw new HttpError(429, 'Analisa AI terlalu sering. Tunggu satu menit.');
    }

    if (!aiEnabled()) {
      res.json({
        mode: 'heuristic',
        reason: 'no-key',
        notes: 'Setelan otomatis dipakai karena kunci AI belum dipasang di .env.',
        params: normalizeParams(asset.auto),
        auto: normalizeParams(asset.auto),
        condition: describe(asset.stats),
        aiEnabled: false,
      });
      return;
    }

    const source = await fs.promises.readFile(path.join(DIRS.uploads, `${asset.id}.jpg`));

    let refSource = null;
    const ref = findReference(req.body?.refId, req);
    if (ref && ref.id !== 'gallery') {
      refSource = await fs.promises.readFile(path.join(DIRS.refs, `${ref.id}-view.jpg`)).catch(() => null);
    } else {
      const activeRefs = ownedReferences(req).filter((r) => r.active !== false);
      if (activeRefs.length) {
        refSource = await fs.promises.readFile(path.join(DIRS.refs, `${activeRefs[0].id}-view.jpg`)).catch(() => null);
      }
    }

    const result = await aiAnalyze(source, asset.stats, asset.auto, refSource);

    if (result.mode === 'ai') {
      asset.ai = {
        scene: result.scene,
        subject: result.subject,
        depthM: result.depthM,
        backscatter: result.backscatter,
        notes: result.notes,
        model: result.model,
        params: result.params || normalizeParams(asset.auto),
        at: Date.now(),
      };
      save();
    }

    res.json({
      ...result,
      auto: normalizeParams(asset.auto),
      condition: describe(asset.stats),
      aiEnabled: true,
    });
  })
);

app.post(
  '/api/magic',
  asyncRoute(async (req, res) => {
    const asset = findAsset(req.body?.assetId, req);
    if (!aiEnabled()) throw new HttpError(400, 'AI belum aktif.');
    if (!rateLimit(req, `magic:${req.user?.id || req.guestId}`, 15, 60_000)) {
      throw new HttpError(429, 'Terlalu banyak permintaan AI Magic. Tunggu sebentar.');
    }

    const source = await fs.promises.readFile(path.join(DIRS.uploads, `${asset.id}.jpg`));

    let refSource = null;
    const ref = findReference(req.body?.refId, req);
    if (ref && ref.id !== 'gallery') {
      refSource = await fs.promises.readFile(path.join(DIRS.refs, `${ref.id}-view.jpg`)).catch(() => null);
    } else {
      const activeRefs = ownedReferences(req).filter((r) => r.active !== false);
      if (activeRefs.length) {
        refSource = await fs.promises.readFile(path.join(DIRS.refs, `${activeRefs[0].id}-view.jpg`)).catch(() => null);
      }
    }

    const { buffer, prompt, model } = await generateMagicImage(source, refSource, req.body?.prompt || '');
    const magicId = `magic-${crypto.randomUUID().slice(0, 8)}.jpg`;
    const outPath = path.join(DIRS.renders, magicId);
    await fs.promises.writeFile(outPath, buffer);

    res.json({
      url: `/media/renders/${magicId}`,
      prompt,
      model,
      name: asset.name,
    });
  })
);

app.get(
  '/api/export/:assetId',
  asyncRoute(async (req, res) => {
    const asset = findAsset(req.params.assetId, req);
    if (!rateLimit(req, 'export', 40, 60_000)) throw new HttpError(429, 'Terlalu banyak unduhan.');

    const params = normalizeParams(parseParamsQuery(req.query.params));
    const edge = clampInt(req.query.edge, 1000, 4800, 4200);
    const format = req.query.fmt === 'webp' ? 'webp' : 'jpeg';
    const engine = req.query.engine === 'spektral' ? 'spektral' : 'lokal';
    const reference = findReference(req.query.ref, req);
    const look = reference?.look || null;

    const source = await fs.promises.readFile(path.join(DIRS.uploads, `${asset.id}.jpg`));
    const built = await buildBitmap(source, edge, params, engine);
    const { data, info } = built.bitmap;

    const result = processImage({ data, width: info.width, height: info.height, channels: 4 }, params, {
      skipRestoration: built.skipRestoration,
      look,
    });
    let image = sharp(result.data, {
      raw: { width: info.width, height: info.height, channels: 4 },
      limitInputPixels: MAX_IMAGE_PIXELS,
    });

    // 4K UHD Super-Resolution Upscale (Lanczos3 + Edge-Adaptive Micro-Detail Reconstruction)
    const min4kEdge = 3840;
    const maxSide = Math.max(info.width, info.height);
    if (maxSide < min4kEdge) {
      image = image
        .resize({
          width: min4kEdge,
          height: min4kEdge,
          fit: 'inside',
          withoutEnlargement: false,
          kernel: 'lanczos3',
        })
        .sharpen({ sigma: 0.85, m1: 0.65, m2: 1.5, x1: 2.0, y2: 10.0, y3: 18.0 });
    } else {
      image = image.sharpen({ sigma: 0.65, m1: 0.5, m2: 1.2, x1: 2.0, y2: 8.0, y3: 15.0 });
    }

    image = image.withMetadata({ density: 300 });

    const buffer =
      format === 'webp'
        ? await image.webp({ quality: 99, smartSubsample: false, nearLossless: true }).toBuffer()
        : await image.jpeg({ quality: 99, chromaSubsampling: '4:4:4', mozjpeg: false }).toBuffer();

    const stamp = new Date().toISOString().slice(0, 10);
    const ext = format === 'webp' ? 'webp' : 'jpg';
    res.setHeader('Content-Type', format === 'webp' ? 'image/webp' : 'image/jpeg');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="freecolor-${asset.id.slice(0, 8)}-${params.preset}-${stamp}.${ext}"`
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Render-Ms', String(result.ms));
    res.end(buffer);
  })
);

/* ------------------------------------------------------------ references */

// The reference gallery is the owner's personal library of photos whose colour
// he likes. Every *active* reference is measured and the measurements are
// blended (median) into one "gallery style" that renders can follow.
const REF_LIMIT = 600;
const GALLERY_REF = 'gallery';

function ownedReferences(req) {
  // Demo mode is a single-owner studio: the gallery must survive cookie resets.
  if (DEMO_MODE && !req.user) return db.references.filter((r) => !r.userId);
  return db.references.filter((r) =>
    req.user ? r.userId === req.user.id : !r.userId && r.guestId === req.guestId
  );
}

function findReference(id, req) {
  if (!id || typeof id !== 'string') return null;
  if (id === GALLERY_REF) return galleryReference(req);
  const ref = db.references.find((r) => r.id === id);
  if (!ref) return null;
  if (ref.userId && ref.userId !== req.user?.id) return null;
  if (!DEMO_MODE && !ref.userId && ref.guestId && ref.guestId !== req.guestId && !req.user) return null;
  return ref;
}

const galleryStyleCache = new Map();

function galleryReference(req) {
  const active = ownedReferences(req).filter((r) => r.active !== false && r.look);
  if (!active.length) return null;
  const sig = active
    .map((r) => r.id)
    .sort()
    .join(',');
  let look = galleryStyleCache.get(sig);
  if (!look) {
    look = blendLooks(active.map((r) => r.look));
    if (galleryStyleCache.size > 32) galleryStyleCache.clear();
    galleryStyleCache.set(sig, look);
  }
  return { id: GALLERY_REF, name: `Gaya Galeri (${active.length} foto)`, look };
}

function publicReference(ref) {
  return {
    id: ref.id,
    name: ref.name,
    createdAt: ref.createdAt,
    active: ref.active !== false,
    thumbUrl: `/media/refs/${ref.id}-thumb.jpg`,
    viewUrl: `/media/refs/${ref.id}-view.jpg`,
    look: publicLook(ref.look),
  };
}

function galleryStylePayload(req) {
  const g = galleryReference(req);
  return g ? { id: GALLERY_REF, name: g.name, look: publicLook(g.look) } : null;
}

app.get('/api/references', (req, res) => {
  const items = ownedReferences(req)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(publicReference);
  res.json({ items, style: galleryStylePayload(req), learning: learningSummary(db), limit: REF_LIMIT });
});

app.post(
  '/api/references',
  (req, res, next) => {
    if (!rateLimit(req, 'ref-upload', 300, 60_000)) {
      return res.status(429).json({ error: 'Terlalu banyak rujukan sekaligus. Beri jeda.' });
    }
    next();
  },
  upload.single('photo'),
  asyncRoute(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'Foto rujukan wajib dikirim.');
    if (ownedReferences(req).length >= REF_LIMIT) {
      throw new HttpError(400, `Galeri referensi penuh (${REF_LIMIT} foto). Hapus beberapa dulu.`);
    }
    const inputImg = await openInputImage(req.file.buffer, req.file.originalname);

    const id = crypto.randomUUID();
    const viewPath = path.join(DIRS.refs, `${id}-view.jpg`);
    const thumbPath = path.join(DIRS.refs, `${id}-thumb.jpg`);

    const { data: viewBuffer, info } = await inputImg
      .toSharp()
      .resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
      .toBuffer({ resolveWithObject: true });

    const [, , look] = await Promise.all([
      fs.promises.writeFile(viewPath, viewBuffer),
      createSharp(viewBuffer)
        .resize({ width: 480, height: 480, fit: 'inside' })
        .jpeg({ quality: 82 })
        .toFile(thumbPath),
      analyzeReference(viewBuffer),
    ]);

    const ref = {
      id,
      userId: req.user?.id || null,
      guestId: req.user ? null : req.guestId,
      name: safeName(req.body?.name || req.file.originalname || 'rujukan.jpg'),
      width: info.width,
      height: info.height,
      look,
      active: true,
      createdAt: Date.now(),
    };
    db.references.push(ref);
    save();

    res.json({ item: publicReference(ref), style: galleryStylePayload(req), learning: learningSummary(db) });
  })
);

app.post(
  '/api/references/bulk',
  asyncRoute(async (req, res) => {
    const active = req.body?.active;
    if (typeof active !== 'boolean') throw new HttpError(400, 'Parameter active wajib boolean.');
    for (const ref of ownedReferences(req)) ref.active = active;
    save();
    const items = ownedReferences(req)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(publicReference);
    res.json({ items, style: galleryStylePayload(req) });
  })
);

app.patch(
  '/api/references/:id',
  asyncRoute(async (req, res) => {
    const ref = findReference(req.params.id, req);
    if (!ref || ref.id === GALLERY_REF) throw new HttpError(404, 'Rujukan tidak ditemukan.');
    if (typeof req.body?.active === 'boolean') ref.active = req.body.active;
    if (typeof req.body?.name === 'string' && req.body.name.trim()) ref.name = safeName(req.body.name);
    save();
    res.json({ item: publicReference(ref), style: galleryStylePayload(req) });
  })
);

app.delete(
  '/api/references/:id',
  asyncRoute(async (req, res) => {
    const ref = findReference(req.params.id, req);
    if (!ref || ref.id === GALLERY_REF) throw new HttpError(404, 'Rujukan tidak ditemukan.');
    for (const suffix of ['-view', '-thumb']) {
      await fs.promises.unlink(path.join(DIRS.refs, `${ref.id}${suffix}.jpg`)).catch(() => {});
    }
    db.references = db.references.filter((r) => r.id !== ref.id);
    save();
    res.json({ ok: true, style: galleryStylePayload(req) });
  })
);

// One accepted frame = one sample. The averages then bias the starting point of
// the next photo, per gear first and across the whole collection second.
app.post(
  '/api/feedback',
  asyncRoute(async (req, res) => {
    if (!rateLimit(req, 'feedback', 60, 60_000)) throw new HttpError(429, 'Terlalu banyak catatan. Beri jeda.');
    const params = normalizeParams(req.body?.params || {});
    const gear = GEARS[req.body?.gear] ? req.body.gear : 'umum';
    const learning = recordFeedback(db, { params, gear, source: req.body?.source || 'render' });
    save();
    res.json({ ok: true, learning });
  })
);

/* ------------------------------------------------------------------ auth */

app.post(
  '/api/auth/register',
  asyncRoute(async (req, res) => {
    if (!rateLimit(req, 'register', 10, 60_000)) throw new HttpError(429, 'Terlalu banyak percobaan.');
    const { email, password, name } = req.body || {};

    if (!validEmail(email)) throw new HttpError(400, 'Email tidak valid.');
    const passStr = String(password || '');
    if (passStr.length < 8 || passStr.length > 128) {
      throw new HttpError(400, 'Password harus antara 8 hingga 128 karakter.');
    }
    const cleanName = String(name || '').trim().slice(0, 50) || String(email).split('@')[0];
    if (db.users.some((u) => u.email.toLowerCase() === String(email).toLowerCase().trim())) {
      throw new HttpError(409, 'Email sudah terdaftar. Coba masuk.');
    }
    if (db.users.length > 5000) throw new HttpError(429, 'Pendaftaran sedang penuh.');

    const hashedPass = await hashPassword(passStr);
    const user = {
      id: crypto.randomUUID(),
      email: String(email).toLowerCase().trim(),
      name: cleanName,
      pass: hashedPass,
      plan: 'free',
      createdAt: Date.now(),
    };
    db.users.push(user);
    save();
    startSession(res, user.id);
    res.json({ user: { id: user.id, email: user.email, name: user.name, plan: user.plan } });
  })
);

app.post(
  '/api/auth/login',
  asyncRoute(async (req, res) => {
    if (!rateLimit(req, 'login', 15, 60_000)) throw new HttpError(429, 'Terlalu banyak percobaan masuk.');
    const { email, password } = req.body || {};
    const passStr = String(password || '').slice(0, 128);
    const user = db.users.find((u) => u.email === String(email || '').toLowerCase().trim());
    const valid = await checkPassword(passStr, user?.pass);
    if (!user || !valid) {
      throw new HttpError(401, 'Email atau password salah.');
    }
    startSession(res, user.id);
    res.json({ user: { id: user.id, email: user.email, name: user.name, plan: user.plan } });
  })
);

app.post('/api/auth/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  if (token) {
    db.sessions = db.sessions.filter((s) => s.token !== token);
    save();
  }
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const guest = db.guests[req.guestId];
  res.json({
    user: req.user ? { id: req.user.id, email: req.user.email, name: req.user.name, plan: req.user.plan } : null,
    guest: { used: guest?.count || 0, limit: DEMO_MODE ? 999999 : GUEST_LIMIT },
    demoMode: DEMO_MODE,
    aiEnabled: aiEnabled(),
  });
});

function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions = db.sessions.filter((s) => s.expiresAt > Date.now());
  db.sessions.push({ token, userId, expiresAt: Date.now() + SESSION_TTL });
  if (db.sessions.length > 3000) db.sessions = db.sessions.slice(-3000);
  save();
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_TTL,
    secure: process.env.COOKIE_SECURE === '1',
  });
}

/* --------------------------------------------------------------- gallery */

function galleryOwnerId(req) {
  if (req.user?.id) return req.user.id;
  if (DEMO_MODE) return `guest:${req.guestId || 'demo'}`;
  return null;
}

app.get(
  '/api/gallery',
  asyncRoute(async (req, res) => {
    const ownerId = galleryOwnerId(req);
    if (!ownerId) throw new HttpError(401, 'Masuk dulu untuk membuka arsip.');
    const items = db.gallery
      .filter((g) => g.userId === ownerId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 60)
      .map((g) => ({ ...g, userId: undefined }));
    res.json({ items });
  })
);

app.post(
  '/api/gallery',
  asyncRoute(async (req, res) => {
    const ownerId = galleryOwnerId(req);
    if (!ownerId) throw new HttpError(401, 'Bikin akun (gratis) untuk menyimpan ke arsip.', { needsAuth: true });
    if (!rateLimit(req, 'gallery-save', 60, 60_000)) throw new HttpError(429, 'Terlalu banyak simpan.');

    const asset = findAsset(req.body?.assetId, req);
    const params = normalizeParams(req.body?.params || asset.auto);
    const cleanUrl = String(req.body?.url || '').split('?')[0];
    const validRenderPattern = new RegExp(`^/media/renders/${asset.id}-[a-f0-9]{12}\\.jpg$`);
    if (!validRenderPattern.test(cleanUrl)) {
      throw new HttpError(400, 'URL hasil tidak valid untuk foto ini.');
    }

    const renderFile = path.basename(cleanUrl);
    const exists = await fs.promises
      .access(path.join(DIRS.renders, renderFile))
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      throw new HttpError(404, 'File hasil render belum tersedia.');
    }

    const userItems = db.gallery.filter((g) => g.userId === ownerId);
    if (userItems.length >= MAX_GALLERY_PER_USER) {
      const oldest = userItems.sort((a, b) => a.createdAt - b.createdAt)[0];
      if (oldest) {
        db.gallery = db.gallery.filter((g) => g.id !== oldest.id);
      }
    }

    const item = {
      id: crypto.randomUUID(),
      userId: ownerId,
      assetId: asset.id,
      name: asset.name,
      preset: params.preset,
      params,
      url: cleanUrl,
      beforeUrl: `/media/uploads/${asset.id}-view.jpg`,
      createdAt: Date.now(),
    };
    db.gallery.push(item);
    save();
    res.json({ item: { ...item, userId: undefined } });
  })
);

app.delete(
  '/api/gallery/:id',
  asyncRoute(async (req, res) => {
    const ownerId = galleryOwnerId(req);
    if (!ownerId) throw new HttpError(401, 'Masuk dulu.');
    const before = db.gallery.length;
    db.gallery = db.gallery.filter((g) => !(g.id === req.params.id && g.userId === ownerId));
    if (db.gallery.length === before) throw new HttpError(404, 'Item tidak ditemukan.');
    save();
    res.json({ ok: true });
  })
);

/* ------------------------------------------------------- static + errors */

const publicDir = path.join(ROOT, 'public');
if (fs.existsSync(publicDir)) app.use(express.static(publicDir, { maxAge: '1h' }));

const distDir = path.join(ROOT, 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir, { maxAge: '1h', index: false }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/media')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint tidak ditemukan.' }));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `Ukuran foto maksimal ${MAX_UPLOAD_MB} MB.`
        : `Upload gagal: ${err.message}`;
    return res.status(400).json({ error: message });
  }
  const status = err.status || 500;
  if (status >= 500) console.error('[api]', err);
  res.status(status).json({
    error: status >= 500 ? 'Terjadi kesalahan internal pada server.' : err.message || 'Permintaan tidak dapat diproses.',
    ...(err.needsAuth ? { needsAuth: true } : {}),
  });
});

prune().catch((err) => console.error('[prune]', err.message));

setInterval(() => {
  const now = Date.now();
  const weekAgo = now - 86_400_000 * 7;
  for (const [id, guest] of Object.entries(db.guests)) {
    if (guest.createdAt && guest.createdAt < weekAgo) delete db.guests[id];
  }
  const today = new Date().toISOString().slice(0, 10);
  for (const [id, q] of Object.entries(db.quota)) {
    if (q.day !== today) delete db.quota[id];
  }
  for (const [key, b] of buckets.entries()) {
    if (now > b.reset) buckets.delete(key);
  }
  prune().catch(() => {});
}, 1000 * 60 * 30).unref();

const server = app.listen(PORT, () => {
  console.log(`[freecolor] web + API di http://localhost:${PORT} (${DEMO_MODE ? 'MODE DEMO: tanpa registrasi & kuota bebas' : 'MODE PRODUKSI'})`);
  console.log(`[freecolor] AI (${aiProvider()}): ${aiEnabled() ? `aktif (${aiModel()})` : 'nonaktif (0 token) — pakai sensor optik lokal'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    flushSyncNow();
    server.close(() => process.exit(0));
  });
}
