import { useCallback, useEffect, useRef, useState } from 'react';
import Compare from './Compare.jsx';
import { api } from '../api.js';

function isSupportedImageFile(file) {
  if (!file) return false;
  const mime = String(file.type || '').toLowerCase();
  if (mime.startsWith('image/')) return true;
  const name = String(file.name || '').toLowerCase();
  return /\.(heic|heif|avif|jpe?g|png|webp|bmp|gif|tiff?)$/i.test(name);
}

const SLIDER_GROUPS = [
  {
    id: 'warna',
    title: 'Warna (Color)',
    subtitle: 'Temp, Corak, Saturasi & Pemulihan Bawah Air',
    items: [
      { key: 'temperature', label: 'Temp', min: -50, max: 50, bipolar: true, hint: 'Suhu warna: Dingin (Biru) ↔ Hangat (Kuning/Emas)' },
      { key: 'tint', label: 'Corak (Tint)', min: -50, max: 50, bipolar: true, hint: 'Keseimbangan warna: Hijau (−) ↔ Magenta (+)' },
      { key: 'saturation', label: 'Saturasi', min: -50, max: 50, bipolar: true, hint: 'Kepekatan seluruh spektrum warna' },
      { key: 'vibrance', label: 'Vibrance', min: -50, max: 60, bipolar: true, hint: 'Mengangkat warna lembut tanpa membuat skintone berlebihan' },
      { key: 'redRestore', label: 'Pulihkan Merah', min: 0, max: 100, unit: '%', hint: 'Mengembalikan spektrum warna merah bawah air (karang & skintone)' },
    ],
  },
  {
    id: 'cahaya',
    title: 'Kecerahan (Light)',
    subtitle: 'Kecerahan, Kontras, Sorotan, Bayangan, Iluminasi & Hitam',
    items: [
      { key: 'exposure', label: 'Kecerahan', min: -50, max: 50, bipolar: true, hint: 'Mengatur terang-gelap keseluruhan foto' },
      { key: 'contrast', label: 'Kontras', min: -50, max: 50, bipolar: true, hint: 'Ketegasan rentang gelap dan terang' },
      { key: 'highlight', label: 'Sorotan (Highlight)', min: -50, max: 50, bipolar: true, hint: 'Mengatur detail area terang & sinar matahari permukaan air' },
      { key: 'shadows', label: 'Bayangan (Shadow)', min: -50, max: 50, bipolar: true, hint: 'Membuka detail area gelap pada karang & wetsuit' },
      { key: 'whites', label: 'Iluminasi (Whites)', min: -50, max: 50, bipolar: true, hint: 'Mengatur titik putih terang pada pasir & riak air' },
      { key: 'blacks', label: 'Hitam (Blacks)', min: -50, max: 50, bipolar: true, hint: 'Mengatur kepekatan titik hitam terdalam' },
    ],
  },
  {
    id: 'efek',
    title: 'Efek & Detail',
    subtitle: 'Pertajam, Kejelasan, Kejernihan Air, Pudarkan & Vinyet',
    items: [
      { key: 'sharpen', label: 'Pertajam (Sharpen)', min: 0, max: 100, hint: 'Menajamkan detail objek kabur (Wajah, Hewan & Teks tetap aman)' },
      { key: 'clarity', label: 'Kejelasan (Clarity)', min: -30, max: 80, bipolar: true, hint: 'Meningkatkan struktur dan dimensi 3D objek' },
      { key: 'veil', label: 'Kejernihan Air (Dehaze)', min: 0, max: 100, unit: '%', hint: 'Mengangkat kabut partikel keruh di kolom air laut' },
      { key: 'spotRemoval', label: 'Hapus Backscatter (Marine Snow)', min: 0, max: 100, unit: '%', hint: 'Menghilangkan bintik partikel melayang (marine snow & pantulan blitz) tanpa merusak detail objek' },
      { key: 'fade', label: 'Pudarkan (Fade)', min: 0, max: 100, hint: 'Efek matte film lembut pada bayangan gelap' },
      { key: 'vignette', label: 'Vinyet (Vignette)', min: -50, max: 80, bipolar: true, hint: 'Menerangkan (−) atau menggelapkan (+) tepi sudut foto' },
    ],
  },
];

const RESTORATION_KEYS = [
  'redRestore',
  'veil',
  'attenuation',
  'spotRemoval',
  'waterLight',
  'waterTint',
  'skinTone',
  'neutral',
  'clarity',
  'sharpen',
  'vibrance',
  'saturation',
  'contrast',
  'exposure',
  'temperature',
  'tint',
  'shadows',
  'highlight',
  'whites',
  'blacks',
];

export default function Editor({ user, demoMode = true, onAuth, onHome, onLogout }) {
  const [assets, setAssets] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [params, setParams] = useState(null);
  const [baseParams, setBaseParams] = useState(null);
  const [intensity, setIntensity] = useState(100);
  const [activeTab, setActiveTab] = useState('quick'); // 'quick' | 'tune'
  const [openGroups, setOpenGroups] = useState({ warna: true, cahaya: true, efek: true });
  const [viewMode, setViewMode] = useState('split'); // 'split' | 'after' | 'before'
  const [holdBefore, setHoldBefore] = useState(false);

  const [afterUrl, setAfterUrl] = useState(null);
  const [renderMs, setRenderMs] = useState(null);
  const [engine] = useState('lokal');
  const [spectral, setSpectral] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [rendering, setRendering] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [drop, setDrop] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [ai, setAi] = useState(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [format, setFormat] = useState('jpeg');
  const [gear] = useState('umum');
  const [aiWait, setAiWait] = useState(0);
  const [full, setFull] = useState(false);

  // High-Tech 0-100% Processing Progress State
  const [progress, setProgress] = useState({ active: false, percent: 0, stage: '' });

  const inputRef = useRef(null);
  const stageRef = useRef(null);
  const seq = useRef(0);
  const dragDepth = useRef(0);

  const active = assets.find((a) => a.id === activeId) || null;

  useEffect(() => {
    api
      .health()
      .then((h) => {
        setAiEnabled(Boolean(h.ai));
      })
      .catch(() => {});
    api
      .engineStatus()
      .then(setSpectral)
      .catch(() => setSpectral({ ok: false, error: 'service spektrum tidak merespons' }));
  }, []);

  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) setFull(false);
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  useEffect(() => {
    const onKeyDown = (e) => {
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (e.key === 'Escape') {
        setFull(false);
        return;
      }
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        toggleFullscreen();
      }
      if (e.code === 'Space' && !e.repeat && active) {
        e.preventDefault();
        setHoldBefore(true);
      }
    };
    const onKeyUp = (e) => {
      if (e.code === 'Space') {
        setHoldBefore(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [full, active]);

  useEffect(() => {
    if (!aiBusy) {
      setAiWait(0);
      return undefined;
    }
    const started = Date.now();
    const timer = setInterval(() => setAiWait(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [aiBusy]);

  useEffect(() => {
    if (!notice) return undefined;
    const t = setTimeout(() => setNotice(''), 3200);
    return () => clearTimeout(t);
  }, [notice]);

  // Dynamic 0-100% Progress Processor
  useEffect(() => {
    let timer = null;
    const isBusy = rendering || uploading || aiBusy;
    if (isBusy) {
      setProgress((prev) => ({
        active: true,
        percent: prev.active ? Math.max(prev.percent, 20) : 12,
        stage: uploading
          ? 'Mengunggah & Membaca Spektrum Optik…'
          : aiBusy
            ? 'AI Menganalisis Kedalaman & Lapisan Air…'
            : 'Menganalisis Kedalaman Kolom Air & Pasir…',
      }));

      const startTime = Date.now();
      timer = setInterval(() => {
        const elapsed = Date.now() - startTime;
        setProgress((prev) => {
          if (!prev.active) return prev;
          let nextPct = prev.percent;
          let stage = prev.stage;
          if (elapsed < 240) {
            nextPct = Math.min(45, prev.percent + 8);
            stage = 'Memisahkan Lapisan Air Laut, Pasir & Subjek…';
          } else if (elapsed < 550) {
            nextPct = Math.min(78, prev.percent + 5);
            stage = 'Memulihkan Pigmen Alami & Mengeliminasi Backscatter…';
          } else if (elapsed < 950) {
            nextPct = Math.min(94, prev.percent + 2);
            stage = 'Penyempurnaan Rekonstruksi Detail…';
          } else {
            nextPct = Math.min(98, prev.percent + 1);
            stage = 'Menyelesaikan Tampilan…';
          }
          return { active: true, percent: nextPct, stage };
        });
      }, 50);
    } else {
      // Reached completion
      setProgress((prev) => {
        if (!prev.active) return prev;
        return { active: true, percent: 100, stage: 'Restorasi Selesai!' };
      });
      const hideTimer = setTimeout(() => {
        setProgress({ active: false, percent: 0, stage: '' });
      }, 320);
      return () => clearTimeout(hideTimer);
    }

    return () => {
      if (timer) clearInterval(timer);
    };
  }, [rendering, uploading, aiBusy]);

  const uploadFiles = useCallback(async (fileList) => {
    const rawList = Array.from(fileList || []);
    const files = rawList.filter(isSupportedImageFile).slice(0, 8);
    if (!files.length) {
      if (rawList.length) {
        setError('Format file belum didukung. Gunakan JPG, PNG, WEBP, atau HEIC/HEIF.');
      }
      return;
    }

    setUploading(true);
    setError('');
    try {
      let firstId = null;
      for (const file of files) {
        const res = await api.upload(file, gear);
        setAssets((prev) => [...prev, { ...res.asset, condition: res.condition }]);
        if (!firstId) firstId = res.asset.id;
      }
      if (firstId) setActiveId(firstId);
    } catch (err) {
      setError(err.message);
      if (err.needsAuth && onAuth) onAuth();
    } finally {
      setUploading(false);
    }
  }, [onAuth, gear]);

  useEffect(() => {
    const onPaste = (e) => {
      const files = Array.from(e.clipboardData?.files || []);
      if (files.length) uploadFiles(files);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [uploadFiles]);

  // A new photo resets the working parameters to its auto-tune.
  useEffect(() => {
    if (!active) {
      setParams(null);
      setBaseParams(null);
      setAfterUrl(null);
      return;
    }
    const initial = { ...active.auto, preset: active.auto?.preset || 'alami', refMatch: 0 };
    setParams(initial);
    setBaseParams(initial);
    setIntensity(100);
    setAfterUrl(null);
    setAi(null);
    setMetrics(null);
  }, [activeId]);

  // Debounced server render.
  useEffect(() => {
    if (!activeId || !params) return undefined;
    const ticket = ++seq.current;
    const controller = new AbortController();
    setRendering(true);

    const timer = setTimeout(async () => {
      try {
        const previewEdge = 1600;
        const res = await api.render(activeId, params, previewEdge, engine, gear, null, controller.signal);
        if (ticket !== seq.current) return;
        setAfterUrl(res.url);
        setRenderMs(res.ms);
        setMetrics(res.metrics || null);
        setError('');
      } catch (err) {
        if (err?.name === 'AbortError') return;
        if (ticket === seq.current) setError(err.message);
      } finally {
        if (ticket === seq.current) setRendering(false);
      }
    }, 200);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [activeId, params, engine, gear]);

  async function runAI() {
    if (!active) return;
    setAiBusy(true);
    setAi(null);
    setError('');
    try {
      const res = await api.analyze(active.id, null);
      setAi(res);
      if (res.params) {
        const merged = { ...(params || {}), ...res.params, refMatch: 0 };
        setParams(merged);
        setBaseParams(merged);
        setIntensity(100);
        setNotice(
          res.fromCache
            ? 'Kalibrasi AI diterapkan (tersimpan di memori — 0 token terpakai).'
            : 'Kalibrasi Gemini AI diterapkan secara otomatis.'
        );
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setAiBusy(false);
    }
  }

  function applyIntensityScale(pct, refBase = baseParams) {
    setIntensity(pct);
    if (!refBase) return;
    const factor = pct / 100;
    setParams((prev) => {
      if (!prev) return prev;
      const next = { ...prev };
      for (const k of RESTORATION_KEYS) {
        if (refBase[k] !== undefined) {
          next[k] = Math.round(refBase[k] * factor);
        }
      }
      return next;
    });
  }

  function resetParams() {
    if (!active) return;
    const initial = { ...active.auto, preset: active.auto?.preset || 'alami', refMatch: 0 };
    setParams(initial);
    setBaseParams(initial);
    setIntensity(100);
    setAi(null);
    setNotice('Kembali ke setelan restorasi otomatis awal.');
  }

  function updateSingleSlider(key, val) {
    setParams((prev) => ({ ...prev, [key]: val }));
    setBaseParams((prev) => (prev ? { ...prev, [key]: val } : prev));
  }

  function resetSingleSlider(key) {
    const fallback = active?.auto?.[key] ?? 0;
    updateSingleSlider(key, fallback);
  }

  function toggleGroup(id) {
    setOpenGroups((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  async function toggleFullscreen() {
    const next = !full;
    setFull(next);
    const el = stageRef.current;
    if (!el) return;
    try {
      if (next) await el.requestFullscreen?.();
      else if (document.fullscreenElement) await document.exitFullscreen();
    } catch {
      /* overlay fallback */
    }
  }

  const exportUrl = active && params
    ? `/api/export/${active.id}?edge=2048&fmt=${format}&engine=${engine}&gear=umum&params=${encodeURIComponent(JSON.stringify(params))}`
    : undefined;

  async function handleDownload(e) {
    if (!active || !params) return;
    if (active.id?.startsWith('local-') || api.isOffline?.()) {
      e.preventDefault();
      try {
        setNotice('Menyimpan ke Galeri HP (Full HD)...');
        const { offlineEngine } = await import('../offlineEngine.js');
        const res = await offlineEngine.exportHighRes(active.id, params, format === 'webp' ? 'image/webp' : 'image/jpeg');

        if (res.gallerySaved) {
          setNotice('Foto berhasil tersimpan di Galeri HP (Album: FreeColor)!');
        } else {
          // Web browser download fallback
          const a = document.createElement('a');
          a.href = res.url;
          a.download = res.filename;
          document.body.appendChild(a);
          a.click();
          setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(res.url);
          }, 2000);
          setNotice('Foto berhasil disimpan!');
        }
      } catch (err) {
        setError('Gagal menyimpan: ' + err.message);
      }
    }
  }

  const effectiveViewMode = holdBefore ? 'before' : viewMode;

  // Compute live RGB balance percentages for visual spectrum meter
  const rawR = Math.round((active?.stats?.meanR ?? 0.22) * 100);
  const rawG = Math.round((active?.stats?.meanG ?? 0.55) * 100);
  const rawB = Math.round((active?.stats?.meanB ?? 0.52) * 100);
  const estGainR = metrics?.gainR || 1.25;
  const balR = Math.min(100, Math.round(rawR * estGainR * (intensity / 100) + rawR * (1 - intensity / 100)));

  return (
    <div
      className="ed"
      onDragEnter={(e) => {
        e.preventDefault();
        dragDepth.current += 1;
        setDrop(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDrop(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDrop(false);
        uploadFiles(e.dataTransfer?.files);
      }}
    >
      <header className="ed-top">
        <button
          className="ed-back"
          onClick={demoMode ? undefined : onHome}
          aria-label="FreeColor Studio"
          style={demoMode ? { cursor: 'default' } : undefined}
        >
          {!demoMode && <span>←</span>} <b>FREECOLOR</b> <em className="ed-studio-tag">STUDIO</em>
        </button>

        <div className="ed-actions">
          {metrics && (
            <span className="ed-telemetry" title="Keutuhan struktur piksel & waktu proses">
              <b>Struktur {metrics.structure}%</b>
              {metrics.gainR ? ` · Merah ×${metrics.gainR}` : ''}
              {renderMs != null ? ` · ${renderMs}ms` : ''}
            </span>
          )}
        </div>
      </header>

      {!assets.length ? (
        <section className="ed-empty">
          <div className={`dropzone ${drop ? 'on' : ''}`} onClick={() => inputRef.current?.click()}>
            <div className="dz-icon" aria-hidden="true">
              <svg viewBox="0 0 48 48" width="42" height="42">
                <path d="M24 32V12m0 0-7 7m7-7 7 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M8 30v6a4 4 0 0 0 4 4h24a4 4 0 0 0 4-4v-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </div>
            <h1>{uploading ? 'Memproses Foto…' : 'Buka Foto Bawah Air'}</h1>
            <p>
              Pilih foto langsung dari Galeri HP atau Kamera.
              <br />
              JPG, PNG, WEBP, HEIC · Pemrosesan 100% Offline Langsung di HP.
            </p>
            <span className="btn btn-solid" style={{ padding: '14px 28px', fontSize: '15px' }}>
              {uploading ? 'Sedang Memproses…' : '📸 Pilih dari Galeri HP'}
            </span>
            <small style={{ marginTop: '8px', color: '#00d4ff' }}>
              Restorasi spektrum warna otomatis · Hasil jernih alami
            </small>
          </div>
          {error && <p className="ed-error">{error}</p>}
        </section>
      ) : (
        <div className="ed-body">
          <section className="ed-stage">
            <div className="stage-bar">
              <div className="stage-file">
                <b>{active?.name}</b>
                <span>
                  {active?.width}×{active?.height} · Gaya Freedive Time
                </span>
              </div>

              <div className="stage-tools">
                <div className="view-pills" role="group" aria-label="Mode tampilan kanvas">
                  <button
                    className={viewMode === 'split' && !holdBefore ? 'on' : ''}
                    onClick={() => setViewMode('split')}
                    title="Mode belah sebelum & sesudah"
                  >
                    Belah
                  </button>
                  <button
                    className={viewMode === 'after' && !holdBefore ? 'on' : ''}
                    onClick={() => setViewMode('after')}
                    title="Tampilkan hasil penuh"
                  >
                    Hasil
                  </button>
                  <button
                    className={holdBefore || viewMode === 'before' ? 'on' : ''}
                    onMouseDown={() => setHoldBefore(true)}
                    onMouseUp={() => setHoldBefore(false)}
                    onMouseLeave={() => setHoldBefore(false)}
                    onTouchStart={() => setHoldBefore(true)}
                    onTouchEnd={() => setHoldBefore(false)}
                    onClick={() => setViewMode((v) => (v === 'before' ? 'split' : 'before'))}
                    title="Tahan tombol ini atau tekan Spasi untuk melihat foto asli"
                  >
                    Asli
                  </button>
                </div>

                <button
                  className="ghost-btn"
                  onClick={toggleFullscreen}
                  title="Layar penuh (F)"
                >
                  {full ? 'Keluar penuh' : 'Layar penuh'}
                </button>
                <button className="btn-solid" style={{ padding: '6px 14px', fontSize: '11px', borderRadius: '8px' }} onClick={() => inputRef.current?.click()}>+ Foto</button>
              </div>
            </div>

            <div
              ref={stageRef}
              className={`stage-frame ${full ? 'is-full' : ''}`}
              onDoubleClick={toggleFullscreen}
              style={{ position: 'relative' }}
            >
              {active && (
                <Compare
                  before={active.beforeUrl}
                  after={afterUrl || undefined}
                  ratio={undefined}
                  initial={50}
                  viewMode={effectiveViewMode}
                  beforeLabel="ASLI"
                  afterLabel="HASIL"
                />
              )}
              {full && (
                <button className="stage-exit" onClick={toggleFullscreen} aria-label="Keluar layar penuh">
                  Tutup ×
                </button>
              )}

              {/* High-Tech 0-100% Processing Progress Overlay */}
              {progress.active && (
                <div className="processing-progress-overlay">
                  <div className="processing-progress-card">
                    <div className="processing-header">
                      <span className="processing-spinner" />
                      <div className="processing-info">
                        <h4>Memproses Restorasi Bawah Air</h4>
                        <p>{progress.stage}</p>
                      </div>
                      <span className="processing-number">{progress.percent}%</span>
                    </div>
                    <div className="processing-bar-track">
                      <div
                        className="processing-bar-fill"
                        style={{ width: `${progress.percent}%` }}
                      />
                    </div>
                    <div className="processing-badges">
                      <span className={`p-badge ${progress.percent >= 25 ? 'done' : ''}`}>🌊 Kolom Air</span>
                      <span className={`p-badge ${progress.percent >= 50 ? 'done' : ''}`}>🏖️ Pasir & Subjek</span>
                      <span className={`p-badge ${progress.percent >= 75 ? 'done' : ''}`}>🎨 Pigmen</span>
                      <span className={`p-badge ${progress.percent >= 90 ? 'done' : ''}`}>🛡️ Backscatter</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="filmstrip">
              {assets.map((a) => (
                <button
                  key={a.id}
                  className={`strip-item ${a.id === activeId ? 'on' : ''}`}
                  onClick={() => setActiveId(a.id)}
                  title={a.name}
                >
                  <img src={a.thumbUrl} alt={a.name} />
                </button>
              ))}
              <button className="strip-add" onClick={() => inputRef.current?.click()} aria-label="Tambah foto">
                +
              </button>
            </div>
          </section>

          <aside className="ed-rail">
            {/* 1. Compact Optical Diagnostics & RGB Spectrum Header */}
            <div className="inspector-diag">
              <div className="diag-row">
                <div className="diag-title">
                  <span>ANALISA SPEKTRUM</span>
                  <span className={`badge ${aiEnabled ? 'ok' : ''}`}>
                    {aiEnabled ? 'AI Aktif' : 'Sensor Optik'}
                  </span>
                </div>
                {active?.condition && (
                  <div className="diag">
                    <span className="chip"><b>Air</b>{active.condition.cast}</span>
                    <span className="chip"><b>Defisit R</b>−{active.condition.redLoss}%</span>
                    <span className="chip"><b>Kabut</b>{active.condition.haze}</span>
                    <span className="chip"><b>Detail</b>{active.condition.detail}</span>
                    {active.condition.objectRepair && (
                      <span className="chip"><b>Objek</b>{active.condition.objectRepair}</span>
                    )}
                    <span className="chip" title="Masking Semantik Otomatis gaya Lightroom (Kulit Manusia, Hewan Laut, Karang & Kolom Air)">
                      <b>Masking AI</b>{active.condition.semanticMask || (active.condition.cast === 'hijau' ? 'Kulit Manusia + Air Laut' : 'Hewan Laut + Karang + Air')}
                    </span>
                    {active.condition.identityLock && (
                      <span className="chip"><b>Kunci AI</b>{active.condition.identityLock}</span>
                    )}
                  </div>
                )}
                <div className="rgb-bars" title="Keseimbangan spektrum kanal Merah, Hijau, dan Biru">
                  <div className="rgb-row">
                    <span>R</span>
                    <div className="rgb-track">
                      <i className="rgb-fill r" style={{ width: `${Math.min(100, Math.max(8, balR * 1.3))}%` }} />
                    </div>
                    <small>{balR}%</small>
                  </div>
                  <div className="rgb-row">
                    <span>G</span>
                    <div className="rgb-track">
                      <i className="rgb-fill g" style={{ width: `${Math.min(100, Math.max(8, rawG * 1.25))}%` }} />
                    </div>
                    <small>{rawG}%</small>
                  </div>
                  <div className="rgb-row">
                    <span>B</span>
                    <div className="rgb-track">
                      <i className="rgb-fill b" style={{ width: `${Math.min(100, Math.max(8, rawB * 1.25))}%` }} />
                    </div>
                    <small>{rawB}%</small>
                  </div>
                </div>
              </div>
            </div>

            {/* 2. Simplified 2-Tab Navigation */}
            <nav className="inspector-tabs" aria-label="Kategori pengaturan">
              <button
                className={activeTab === 'quick' ? 'on' : ''}
                onClick={() => setActiveTab('quick')}
              >
                Filter & AI
              </button>
              <button
                className={activeTab === 'tune' ? 'on' : ''}
                onClick={() => setActiveTab('tune')}
              >
                Sesuaikan
              </button>
            </nav>

            {/* 3. Tab Content */}
            <div className="inspector-scroll">
              {activeTab === 'quick' && (
                <>
                  {/* Master Intensity & AI Auto Button */}
                  <div className="rail-card highlight-card">
                    <div className="rail-head">
                      <h3>Kekuatan Filter & AI</h3>
                      <button className="link-btn" onClick={resetParams}>Reset Otomatis</button>
                    </div>

                    <div className="slider master-slider">
                      <div className="slider-top">
                        <label htmlFor="sl-master">Intensitas Pemulihan</label>
                        <output>{intensity}%</output>
                      </div>
                      <input
                        id="sl-master"
                        type="range"
                        min={0}
                        max={140}
                        step={1}
                        value={intensity}
                        onDoubleClick={() => applyIntensityScale(100)}
                        onChange={(e) => applyIntensityScale(Number(e.target.value))}
                      />
                      <div className="master-ticks">
                        <span>Asli (0%)</span>
                        <span>Normal (100%)</span>
                        <span>Kuat (140%)</span>
                      </div>
                    </div>

                    <div className="quick-actions" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <button className="btn btn-solid btn-block ai-auto-hero-btn" onClick={runAI} disabled={aiBusy || !active}>
                        {aiBusy
                          ? `Gemini Menganalisa Foto… ${aiWait ? `${aiWait}s` : ''}`.trim()
                          : '✦ Auto-Kalibrasi AI (Restorasi Asli)'}
                      </button>

                      <button
                        type="button"
                        className={`btn btn-block ${(params?.spotRemoval || 0) >= 65 ? 'btn-primary' : 'btn-ghost'}`}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: 8,
                          padding: '9px 14px',
                          fontWeight: 600,
                          fontSize: '0.85rem',
                          borderRadius: 8,
                          border: (params?.spotRemoval || 0) >= 65 ? '1px solid #00d4ff' : '1px solid rgba(255, 255, 255, 0.15)',
                          background: (params?.spotRemoval || 0) >= 65 ? 'rgba(0, 212, 255, 0.16)' : 'rgba(255, 255, 255, 0.03)',
                          color: (params?.spotRemoval || 0) >= 65 ? '#00d4ff' : 'var(--text-soft)',
                          cursor: 'pointer',
                          transition: 'all 0.15s ease',
                        }}
                        onClick={() => {
                          const isHigh = (params?.spotRemoval || 0) >= 65;
                          updateSingleSlider('spotRemoval', isHigh ? 30 : 85);
                        }}
                        title="Inpainting optik untuk melenyapkan bintik partikel melayang (marine snow) dan pantulan blitz"
                      >
                        <span>{(params?.spotRemoval || 0) >= 65 ? '🛡️ Mode Hapus Backscatter: AKTIF' : '🛡️ Mode Hapus Backscatter (Marine Snow)'}</span>
                        {metrics?.backscatterSpots > 0 && (
                          <span style={{ fontSize: '0.74rem', background: 'rgba(0,0,0,0.4)', padding: '2px 7px', borderRadius: 4, color: '#38d6c4' }}>
                            {metrics.backscatterSpots} bintik terhapus
                          </span>
                        )}
                      </button>

                      <div className="identity-lock-note">
                        <span className="lock-icon">🔒</span>
                        <span><b>Identity-Lock:</b> 100% foto asli terjaga. Wajah, alat & objek tidak akan diubah/ditukar.</span>
                      </div>

                      {/* 4 AI Specialists Status */}
                      <div className="identity-lock-note" style={{ marginTop: 2, borderColor: 'rgba(0, 212, 255, 0.35)', background: 'rgba(0, 212, 255, 0.05)' }}>
                        <span className="lock-icon">⚡</span>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
                          <span style={{ color: '#00d4ff', fontWeight: 700, fontSize: '0.80rem', letterSpacing: '0.5px' }}>
                            4 AI SPESIALIS AKTIF DALAM PIPELINE:
                          </span>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 2 }}>
                            <span className="chip" style={{ fontSize: '0.74rem', background: 'rgba(0, 212, 255, 0.12)', borderColor: '#00d4ff', color: '#e0f7ff' }}>
                              🌊 <b>Air</b> Sea-Thru
                            </span>
                            <span className="chip" style={{ fontSize: '0.74rem', background: 'rgba(56, 214, 196, 0.12)', borderColor: '#38d6c4', color: '#e0fbf7' }}>
                              🎯 <b>Masking</b> SUIM
                            </span>
                            <span className="chip" style={{ fontSize: '0.74rem', background: 'rgba(255, 149, 0, 0.12)', borderColor: '#ff9500', color: '#fff3e0' }}>
                              🎨 <b>Objek</b> Pigmen Asli
                            </span>
                            <span className="chip" style={{ fontSize: '0.74rem', background: 'rgba(52, 199, 89, 0.12)', borderColor: '#34c759', color: '#e8f9ed' }}>
                              🛡️ <b>Backscatter</b> Inpainting
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="identity-lock-note" style={{ marginTop: 2, borderColor: 'rgba(56, 214, 196, 0.28)' }}>
                        <span className="lock-icon">🎯</span>
                        <span>
                          <b>AI Semantic Masking (Gaya Lightroom):</b> Deteksi & pisahkan tone referensi otomatis —{' '}
                          <b>Manusia</b>{metrics?.masks?.human != null ? ` (${metrics.masks.human}%)` : ''} ·{' '}
                          <b>Hewan Laut</b>{metrics?.masks?.fauna != null ? ` (${metrics.masks.fauna}%)` : ''} ·{' '}
                          <b>Karang</b>{metrics?.masks?.coral != null ? ` (${metrics.masks.coral}%)` : ''} ·{' '}
                          <b>Air Laut</b>{metrics?.masks?.water != null ? ` (${metrics.masks.water}%)` : ''}
                          {metrics?.backscatterSpots > 0 ? ` · Backscatter (${metrics.backscatterSpots} bintik)` : ''}.
                        </span>
                      </div>
                    </div>

                    {ai && ai.mode === 'ai' && (
                      <div className="ai-result-box">
                        <div className="diag">
                          <span className="chip"><b>Perairan</b>{ai.scene}</span>
                          {ai.depthM != null && <span className="chip"><b>Kedalaman</b>±{ai.depthM}m</span>}
                          <span className="chip"><b>Partikel</b>{ai.backscatter}</span>
                          {ai.subject && <span className="chip"><b>Subjek</b>{ai.subject}</span>}
                        </div>
                        <p className="ai-note">{ai.notes}</p>
                      </div>
                    )}
                    {ai && ai.mode !== 'ai' && (
                      <div className="ai-result-box" style={{ borderColor: 'rgba(255, 176, 32, 0.4)' }}>
                        <p className="ai-note" style={{ color: 'var(--text-soft)' }}>
                          {ai.mode === 'error'
                            ? ai.error && (ai.error.includes('429') || ai.error.includes('quota') || ai.error.includes('exceeded'))
                              ? '✦ Kuota AI cloud sedang padat (429). Kalibrasi otomatis dialihkan ke Analisa Optik Spektral lokal.'
                              : `Info AI: ${ai.error}`
                            : ai.notes}
                        </p>
                      </div>
                    )}
                  </div>
                </>
              )}

              {activeTab === 'tune' && params && (
                <div className="tune-groups">
                  <div className="tune-bar">
                    <span>Klik 2× pada slider untuk reset ke awal</span>
                    <button className="link-btn" onClick={resetParams}>Reset Semua</button>
                  </div>

                  {SLIDER_GROUPS.map((group) => {
                    const isOpen = openGroups[group.id] !== false;
                    return (
                      <div key={group.id} className={`acc-card ${isOpen ? 'open' : ''}`}>
                        <button
                          type="button"
                          className="acc-head"
                          onClick={() => toggleGroup(group.id)}
                          aria-expanded={isOpen}
                        >
                          <div>
                            <h3>{group.title}</h3>
                            <span>{group.subtitle}</span>
                          </div>
                          <i className="acc-chevron">{isOpen ? '−' : '+'}</i>
                        </button>

                        {isOpen && (
                          <div className="acc-body">
                            {group.items.map((s) => {
                              const val = Math.round(params[s.key] ?? 0);
                              return (
                                <div className="slider" key={s.key} title={s.hint}>
                                  <div className="slider-top">
                                    <label htmlFor={`sl-${s.key}`}>{s.label}</label>
                                    <output>
                                      {s.bipolar && val > 0 ? `+${val}` : val}
                                      {s.unit || ''}
                                    </output>
                                  </div>
                                  <input
                                    id={`sl-${s.key}`}
                                    type="range"
                                    min={s.min}
                                    max={s.max}
                                    step={1}
                                    value={params[s.key] ?? 0}
                                    onDoubleClick={() => resetSingleSlider(s.key)}
                                    onChange={(e) => updateSingleSlider(s.key, Number(e.target.value))}
                                  />
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* 4. Streamlined Export Footer */}
            <div className="inspector-footer">
              <div className="footer-top">
                <div className="seg seg-compact">
                  <button className={format === 'jpeg' ? 'on' : ''} onClick={() => setFormat('jpeg')}>JPG</button>
                  <button className={format === 'webp' ? 'on' : ''} onClick={() => setFormat('webp')}>WEBP</button>
                </div>
              </div>
              <a className="btn btn-solid btn-block footer-dl-btn" href={exportUrl || '#'} onClick={handleDownload} download>
                Simpan ke Galeri HP (Full HD)
              </a>
            </div>
          </aside>
        </div>
      )}

      {error && assets.length > 0 && (
        <div className="toast err" role="alert">
          {error}
          <button onClick={() => setError('')}>×</button>
        </div>
      )}
      {notice && <div className="toast">{notice}</div>}
      {drop && <div className="drop-veil">Lepas untuk mengunggah</div>}

      <input
        ref={inputRef}
        type="file"
        accept="image/*,.heic,.heif,.avif"
        multiple
        hidden
        onChange={(e) => {
          uploadFiles(e.target.files);
          e.target.value = '';
        }}
      />
    </div>
  );
}
