// Menjalankan service spektral memakai python di dalam venv proyek.
//
// `npm run service` dulu memanggil path dengan garis miring ("service/.venv/...")
// dan cmd.exe memotongnya di "/" sehingga gagal dengan "'service' is not
// recognized". Spawn lewat Node membuat perintahnya sama di Windows dan Unix.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const python =
  process.platform === 'win32'
    ? path.join(root, 'service', '.venv', 'Scripts', 'python.exe')
    : path.join(root, 'service', '.venv', 'bin', 'python');

if (!fs.existsSync(python)) {
  console.error(`[spectral] python venv tidak ditemukan: ${python}`);
  console.error('[spectral] buat dulu: python -m venv service/.venv lalu pip install -r service/requirements.txt');
  process.exit(1);
}

const child = spawn(python, [path.join(root, 'service', 'main.py')], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});

child.on('error', (err) => {
  console.error('[spectral] gagal menjalankan python:', err.message);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('exit', (code) => process.exit(code ?? 0));
