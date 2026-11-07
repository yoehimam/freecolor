# FreeColor Underwater

Editor foto bawah air (seperti edive.id) dengan frontend + backend. Bukan mockup:
mesin pemulihan warna benar-benar dihitung di server, dan opsional memakai
OpenAI vision untuk auto-tune.

## Jalankan

```bash
npm install
cp .env.example .env      # isi OPENAI_API_KEY kalau mau analisa AI
npm run showcase          # membuat contoh sebelum/sesudah dari folder seed/
npm run dev               # web :5173 + API :8787
```

Produksi:

```bash
npm run build
npm start                 # http://localhost:8787 (API + web + /media)
```

## Isi

- `server/lib/pipeline.js` — inti pengolahan gambar, semuanya deterministik.
- `server/lib/measure.js` — statistik foto + auto-tune heuristik.
- `server/lib/ai.js` — analisa OpenAI vision yang dibatasi ke parameter aman.
- `server/index.js` — API upload/render/analyze/export, auth, galeri, kuota.
- `src/` — React 19 + Vite, landing page dan editor.
- `scripts/prepare-showcase.mjs` — membangun demo before/after dari `seed/`.

## Pipeline

Urutannya mengikuti cara air merusak foto, dan setiap tahap koreksi bekerja
per area — bukan satu filter warna untuk seluruh frame:

1. Linearisasi sRGB (agar gain warna bekerja fisik).
2. **White balance lokal** — grey-world pada midtone per tile 64 px, lalu gain
   diinterpolasi per piksel. Cast hijau di satu sudut dan biru di sudut lain
   adalah dua masalah berbeda, jadi satu gain global tidak pernah menyelesaikan
   keduanya. Gain merah sampai 5×.
3. **Veil removal edge-aware** — underwater dark channel prior
   `J = (I − A) / t + A`, dengan transmission map yang dihaluskan memakai
   guided filter (dipandu luminansi), sehingga koreksi berhenti di tepi objek
   dan tidak menimbulkan halo putih di sekeliling ikan/karang.
4. **Kompensasi serapan per piksel** — `1 − t` adalah panjang jalur air, jadi
   defisit merah dipulihkan sesuai jarak: subjek dekat hampir tidak disentuh,
   air jauh mendapat pemulihan kuat, dengan rolloff di highlight supaya pasir
   putih dan sirip yang kena strobe tidak jadi merah muda.
5. Kembali ke display space.
6. Kontras lokal per tile dengan bobot radial untuk preset Strobe.
7. Tone: exposure, S-curve, shadow lift, highlight rolloff.
8. Warna: vibrance, saturasi, suhu, split toning, vignette, strobe falloff.
9. **Air cerah** (`waterLight`, `waterTint`) — masker warna air (hijau/biru di atas
   merah, pudar mendekati putih). Pengangkatannya berbobot luminansi, jadi air gelap
   naik jadi biru cerah sementara detail gelap milik subjek (bintik kulit, mata ikan,
   celah karang) nyaris tidak bergerak — tidak ada tambalan atau halo. Rona air
   diarahkan ke `REF_WATER` di `pipeline.js`, rasio kanal dari foto rujukan azure
   (hue ±208°) pada jumlah kanal tetap, jadi kecerahan tidak ikut bergeser.
10. **Kulit & karang** (`skinTone`) — pita warna hangat (kulit penyelam, jaringan
    karang, sisik ikan) mendapat kembali kroma dan detail mikro; luminansi tidak
    diubah sehingga bentuk dan bayangan tetap.
11. Unsharp mask berbobot strobe.

### Objek tidak diubah

Semua tahap di atas hanya transformasi warna/kecerahan **per piksel**: tidak ada
warping, resampling geometri, inpainting, maupun isi yang di-generate. Piksel
input `(x, y)` selalu menjadi piksel output `(x, y)`, jadi bentuk, jumlah dan
posisi objek mustahil berubah; yang berubah hanya warna, kontras dan detail
yang memang sudah terekam.

Setiap render mengembalikan `metrics.structure` (0–100): korelasi struktur
luminansi hasil terhadap aslinya. Nilainya ~100 untuk foto yang strukturnya utuh,
sehingga klaim ini bisa diperiksa, bukan sekadar dijanjikan. Angka itu tampil di
editor sebagai "objek 9x%" dan di kartu Mesin.

Hasil render di-cache dengan hash parameter, jadi menggeser slider bolak-balik
tidak menghitung ulang.

### Istilah antarmuka

ID parameter tidak berubah (dipakai API, preset, dan cache); yang tampil di layar
memakai kosakata sendiri:

| Panel | Istilah | ID parameter |
| --- | --- | --- |
| Bacaan | Isi merah | `redRestore` |
| | Saring air | `veil` |
| | Tebus jarak | `attenuation` |
| | Rincian | `clarity` |
| | Getar warna | `vibrance` |
| | Pekat warna | `saturation` |
| | Ketebalan | `contrast` |
| | Cahaya | `exposure` |
| | Kehangatan | `temperature` |
| | Benderang air | `waterLight` |
| | Rona air | `waterTint` |
| | Kulit & karang | `skinTone` |
| | Kilau | `highlight` |
| | Bayang | `shadows` |
| | Tepi gelap | `vignette` |

Karakter (preset): `alami` = Bening, `kreatif` = Segar, `super` = Menyala,
`strobe` = Sorot. Panel editor: Bacaan, Pengolah, Karakter, Setelan, Unduhan,
Arsip. Mesin: "Bawaan" = pipeline Node, "Spektra" = service Python.

## API

| Endpoint | Keterangan |
| --- | --- |
| `POST /api/upload` | multipart `photo` → asset + statistik + auto params |
| `POST /api/render` | `{ assetId, params, edge }` → preview 1600px + `metrics.structure` |
| `POST /api/analyze` | analisa AI (fallback heuristik bila tanpa key) |
| `GET /api/export/:assetId` | unduh hasil sampai 4200px (jpg/webp) |
| `GET/POST /api/gallery` | galeri per akun |
| `POST /api/auth/register|login|logout` | sesi cookie httpOnly, password scrypt |

Kuota: tamu 8 kali proses, akun 400/hari.

## Catatan

- Foto contoh di `seed/` berasal dari Unsplash (lisensi Unsplash) hanya untuk
  demo; `public/showcase/` hasil generate dan tidak ikut di-commit.
- Tanpa `OPENAI_API_KEY` aplikasi tetap jalan penuh dengan auto-tune heuristik.

## Engine spektral (Python FastAPI)

Pipeline JavaScript tetap default. Untuk hasil lebih kuat ada microservice
Python terpisah yang menjalankan model restorasi warna khusus underwater; Node
lalu hanya menambahkan tone dan grading di atasnya.

`npm run service` memakai `scripts/service.mjs` (spawn python venv) karena path
bergaris miring gagal di cmd.exe.

```bash
npm run service    # http://127.0.0.1:8799
npm run dev        # Vite + API
npm run dev:all    # ketiganya sekaligus
```

### Rantai provider (`service/providers.py`)

1. `onnx` — bobot open source (WaterNet, FUnIE-GAN, UIE, ...) di `service/models/*.onnx`
   atau `ONNX_MODEL_PATH`. Butuh `onnxruntime`.
2. `huggingface` — HF Inference API image-to-image; set `HF_TOKEN` + `HF_MODEL_ID`.
3. `spectral` — restorasi numpy bawaan (UDCP + red-channel prior + contrast lokal
   + vibrance + unsharp). Selalu tersedia.

Provider pilihan gagal → otomatis turun ke `spectral`. Service mati → backend Node
otomatis kembali ke pipeline lokal, jadi editor tidak pernah macet.

### Endpoint

- `GET /health` → `{ ok, active, providers[] }`
- `POST /enhance` (multipart `file`, `strength`, `provider`) → JPEG dengan header
  `X-Provider`, `X-Model`, `X-Ms`

Sisi Node:

- `GET /api/engine/status` → status service (cache 15 detik)
- `POST /api/render` menerima `engine: "lokal" | "spektral"`
- `GET /api/export/:id?engine=spektral` untuk unduhan 4K

Env: `SPECTRAL_URL`, `SPECTRAL_TOKEN` (opsional), `HF_TOKEN`, `HF_MODEL_ID`,
`ONNX_MODEL_PATH`.

Di Python 3.15 pakai wheel biner, karena `uvicorn[standard]`/PyYAML tidak punya
wheel cp315:

```bash
service/.venv/Scripts/python.exe -m pip install -r service/requirements.txt --only-binary :all:
```

## Rujukan warna, standar lomba, profil perangkat

Tiga lapisan tambahan, semuanya tetap per-piksel (tidak ada bagian foto yang
diganti, ditambah, atau digambar ulang):

1. **Rujukan** (`server/lib/look.js`, `data/refs/`). Foto rujukan disimpan, lalu
   diukur: rasio kanal air, hue, kecerahan air, dan nada frame. Saat rujukan
   dipakai, hanya *air* yang digeser ke rasio warna itu (jumlah kanal dijaga,
   jadi kecerahan air tidak berubah). Karang, kulit, dan ikan tidak pernah
   diwarnai mengikuti rujukan. Slider **Ikut rujukan** (`refMatch`) mengatur
   takarannya. Maksimal 24 rujukan per pemilik.
2. **Standar lomba** (preset `lomba`). Titik netral diambil dari standar
   penjurian bawah air: pasir/aluminium/busa harus netral, sorot tidak pecah,
   kulit tetap wajar, air tetap biru. Dua parameter baru melayaninya —
   **Netral pasir** (`neutral`, hanya menyentuh piksel bersaturasi rendah) dan
   **Redam sorot** (`rolloff`, menggeser lutut highlight ke bawah).
3. **Profil perangkat** (`server/lib/gear.js`): `umum`, `osmo` (DJI Osmo,
   D-Log M datar & sejuk), `gopro` (Protune datar, hijau-biru), `mirrorless`
   (warna sudah matang). Profil hanya menggeser *titik awal* setelan — mesin
   pengolahnya identik, jadi tidak ada kamera yang "dibaguskan" secara palsu.

### Belajar dari foto yang kamu setujui

`POST /api/feedback` menyimpan satu sampel setiap kali kamu menekan **Pas** atau
**Simpan ke arsip**. Sampel diubah jadi rata-rata berjalan per perangkat dan
rata-rata keseluruhan; rata-rata itu dipakai sebagai titik awal foto berikutnya
(bobot 0 sampai 0,36 setelah cukup sampel). Tidak ada model yang dilatih dan
tidak ada foto yang dikirim ke luar server.

### AI diberi waktu

Analisa vision memakai `AI_TIMEOUT_MS` (default **180000** ms), satu percobaan
ulang per jalur, dan editor menampilkan durasi tunggu berjalan. Kalau penyedia
benar-benar diam sepanjang batas itu, editor kembali ke auto-tune heuristik dan
mengatakannya di panel Bacaan.

### Endpoint baru

- `GET /api/references` → daftar rujukan + ringkasan pembelajaran
- `POST /api/references` (multipart `photo`, `name`) → ukur & simpan rujukan
- `DELETE /api/references/:id`
- `POST /api/feedback` `{ params, gear, refId?, source? }`
- `POST /api/render` menerima `gear` dan `refId`
- `GET /api/export/:id?...&gear=osmo&ref=<id>`
- `GET /api/health` kini juga mengirim `gears[]` dan `learning`

### Air menyesuaikan, bukan diseragamkan

Pipeline membaca rona airnya sendiri sebelum menyentuhnya: kalau airnya hijau/keruh,
warna air didorong penuh ke biru rujukan (azure); kalau airnya sudah biru, hanya
digeser halus agar tidak terlihat digrading. Objek tidak pernah diwarnai ulang.

Preset bawaan kini konservatif (natural): tanpa split tone, saturasi 2-12, kontras
3-14, `waterLight` 22-44. Analisa AI juga dibatasi nilai wajarnya
(`NATURAL_LIMITS` di `server/lib/ai.js`), jadi model tidak bisa membuat hasil menjadi
over-edit walau meminta angka ekstrem. Hasil ukur pada uji air hijau sintetis:
hue air 183-184° (hijau) menjadi 197-208° (biru), dengan struktur tetap 99,8-100%.
