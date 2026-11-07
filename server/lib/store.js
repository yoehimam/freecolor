// Deliberately dependency-free persistence:
//   data/db.json      (users, sessions, asset metadata, gallery, quotas)
//   data/uploads/*    (normalised originals + view + thumb)
//   data/renders/*    (cached pipeline output, content-addressed by params)
//
// Writes are debounced and go through an asynchronous temp file + atomic rename
// queue so concurrent requests never block the event loop or corrupt the db.

import fs from 'node:fs';
import path from 'node:path';

export const ROOT = process.cwd();

export const DIRS = {
  data: path.join(ROOT, 'data'),
  uploads: path.join(ROOT, 'data', 'uploads'),
  renders: path.join(ROOT, 'data', 'renders'),
  refs: path.join(ROOT, 'data', 'refs'),
};

for (const dir of Object.values(DIRS)) fs.mkdirSync(dir, { recursive: true });

const DB_PATH = path.join(DIRS.data, 'db.json');

const empty = () => ({
  users: [],
  sessions: [],
  assets: [],
  gallery: [],
  references: [],
  learning: { samples: 0, all: { n: 0, params: {} }, byGear: {}, updatedAt: 0 },
  guests: {},
  quota: {},
});

function readInitial() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    return { ...empty(), ...parsed };
  } catch {
    return empty();
  }
}

export const db = readInitial();

let flushTimer = null;
let writing = false;
let dirty = false;

async function flushAsync() {
  if (writing) {
    dirty = true;
    return;
  }
  writing = true;
  dirty = false;
  const tmp = `${DB_PATH}.${process.pid}.tmp`;
  try {
    const payload = JSON.stringify(db);
    await fs.promises.writeFile(tmp, payload, 'utf8');
    await fs.promises.rename(tmp, DB_PATH);
  } catch (err) {
    console.error('[store] gagal menyimpan db:', err.message);
  } finally {
    writing = false;
    if (dirty) {
      flushAsync();
    }
  }
}

export function save() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushAsync();
  }, 120);
}

export function flushSyncNow() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    const tmp = `${DB_PATH}.sync.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db), 'utf8');
    fs.renameSync(tmp, DB_PATH);
  } catch (err) {
    console.error('[store] gagal flush akhir db:', err.message);
  }
}

/** Drop renders/asset rows that nobody has touched in a while (non-blocking). */
export async function prune(maxAgeDays = 14) {
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  const galleryAssetIds = new Set(db.gallery.map((g) => g.assetId));
  const keep = [];

  for (const asset of db.assets) {
    if (asset.createdAt < cutoff && !galleryAssetIds.has(asset.id)) {
      for (const suffix of ['', '-view', '-thumb']) {
        await fs.promises.unlink(path.join(DIRS.uploads, `${asset.id}${suffix}.jpg`)).catch(() => {});
      }
      continue;
    }
    keep.push(asset);
  }
  db.assets = keep;

  const liveAssets = new Set(db.assets.map((a) => a.id));
  const renderFiles = await fs.promises.readdir(DIRS.renders).catch(() => []);

  for (const file of renderFiles) {
    // UUID has 5 segments separated by '-'; the last segment is the 12-char render hash
    const lastDash = file.lastIndexOf('-');
    const assetId = lastDash > 0 ? file.slice(0, lastDash) : file.split('-')[0];
    const full = path.join(DIRS.renders, file);
    try {
      const { mtimeMs } = await fs.promises.stat(full);
      if (!liveAssets.has(assetId) || mtimeMs < cutoff) {
        await fs.promises.unlink(full).catch(() => {});
      }
    } catch {
      /* ignore */
    }
  }

  db.sessions = db.sessions.filter((s) => s.expiresAt > Date.now());
  save();
}
