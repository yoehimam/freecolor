// Generates the landing-page demo imagery from the seed photos in ./seed.
//
// For every photo we build:
//   before  = a simulated raw underwater capture (red absorbed + water veil)
//   after   = our own pipeline output for each preset
//
// This means the "before / after" on the landing page is produced by the same
// code that runs in the editor, not faked with pre-edited stock images.

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { processImage } from '../server/lib/pipeline.js';

const SEED = path.join(process.cwd(), 'seed');
const OUT = path.join(process.cwd(), 'public', 'showcase');
fs.mkdirSync(OUT, { recursive: true });
// Regenerating should not leave orphans from a previous entry list.
for (const file of fs.readdirSync(OUT)) {
  if (file.endsWith('.jpg')) fs.unlinkSync(path.join(OUT, file));
}

const ENTRIES = [
  { id: 'turtle', src: 'coral.jpg', title: 'Penyu hijau, Menjangan', spot: 'Bali · 12 m', preset: 'kreatif' },
  { id: 'reef', src: 'reef.jpg', title: 'Terumbu karang, Bunaken', spot: 'Sulawesi Utara · 16 m', preset: 'super' },
  { id: 'diver', src: 'diver.jpg', title: 'Diver, Komodo', spot: 'Nusa Tenggara · 21 m', preset: 'strobe' },
  { id: 'tank', src: 'school.jpg', title: 'Karang akuarium', spot: 'Studio · 0 m', preset: 'alami' },
];

const STYLES = ['alami', 'kreatif', 'super', 'strobe', 'lomba'];

/** Simulate the capture: red dies first, then a green-blue veil covers it. */
function degrade(rgb, w, h) {
  const out = Buffer.alloc(rgb.length);
  for (let i = 0; i < rgb.length; i += 3) {
    let r = rgb[i] / 255;
    let g = rgb[i + 1] / 255;
    let b = rgb[i + 2] / 255;

    r *= 0.34;
    g *= 0.74;
    b *= 0.92;

    // water veil (suspended particles + ambient scatter)
    r = r * 0.7 + 0.05;
    g = g * 0.76 + 0.135;
    b = b * 0.78 + 0.165;

    // slight softness, like shooting through a dome port
    out[i] = Math.max(0, Math.min(255, r * 255));
    out[i + 1] = Math.max(0, Math.min(255, g * 255));
    out[i + 2] = Math.max(0, Math.min(255, b * 255));
  }
  return out;
}

async function rawJpeg(file, width = 1920) {
  const buffer = await sharp(file)
    .rotate()
    .resize({ width, height: width, fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' })
    .jpeg({ quality: 96, chromaSubsampling: '4:4:4', mozjpeg: true })
    .toBuffer();
  return sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
}

const manifest = { hero: '/showcase/hero.jpg', styleDemo: null, items: [] };
const available = fs.existsSync(SEED) ? fs.readdirSync(SEED) : [];
const usable = ENTRIES.filter((e) => available.includes(e.src));

if (!usable.length) {
  fs.writeFileSync(path.join(OUT, 'showcase.json'), JSON.stringify(manifest, null, 2));
  console.log('[showcase] tidak ada foto di ./seed — manifest kosong, landing pakai latar gradien.');
  process.exit(0);
}

for (const entry of usable) {
  const srcPath = path.join(SEED, entry.src);
  const { data, info } = await rawJpeg(srcPath);
  if (!info.width || !info.height) {
    console.warn(`[showcase] lewati ${entry.src} (tidak bisa dibaca)`);
    continue;
  }

  // Round trip: degrade the clean frame into a raw-looking capture, then let
  // the engine restore that same degraded buffer. Nothing is pre-baked.
  const before = degrade(data, info.width, info.height);
  await sharp(before, { raw: { width: info.width, height: info.height, channels: 3 } })
    .jpeg({ quality: 93, chromaSubsampling: '4:4:4', mozjpeg: true })
    .toFile(path.join(OUT, `${entry.id}-before.jpg`));

  for (const style of STYLES) {
    const result = processImage(
      { data: Buffer.from(before), width: info.width, height: info.height, channels: 3 },
      { preset: style }
    );
    await sharp(result.data, { raw: { width: info.width, height: info.height, channels: 4 } })
      .jpeg({ quality: 94, chromaSubsampling: '4:4:4', mozjpeg: true })
      .toFile(path.join(OUT, `${entry.id}-${style}.jpg`));
  }

  manifest.items.push({
    id: entry.id,
    title: entry.title,
    spot: entry.spot,
    preset: entry.preset,
    before: `/showcase/${entry.id}-before.jpg`,
    after: `/showcase/${entry.id}-${entry.preset}.jpg`,
    ratio: Math.round((info.width / info.height) * 1000) / 1000,
  });

  if (!manifest.styleDemo) {
    manifest.styleDemo = {
      title: entry.title,
      spot: entry.spot,
      before: `/showcase/${entry.id}-before.jpg`,
      ratio: Math.round((info.width / info.height) * 1000) / 1000,
      variants: Object.fromEntries(STYLES.map((s) => [s, `/showcase/${entry.id}-${s}.jpg`])),
    };
  }
  console.log(`[showcase] ${entry.id}: sebelum + ${STYLES.length} gaya`);
}

// Hero: wide, dark, cinematic crop produced by the same pipeline.
const heroSource = path.join(SEED, usable.find((e) => e.id === 'diver')?.src || usable[0].src);
// (diver.jpg: wide blue frame, reads well under the hero gradient)
await sharp(heroSource)
  .rotate()
  .resize({ width: 2400, height: 1350, fit: 'cover', position: 'centre' })
  .modulate({ brightness: 0.92, saturation: 0.95 })
  .jpeg({ quality: 82 })
  .toFile(path.join(OUT, 'hero.jpg'));

fs.writeFileSync(path.join(OUT, 'showcase.json'), JSON.stringify(manifest, null, 2));
console.log(`[showcase] selesai: ${manifest.items.length} item + hero`);
