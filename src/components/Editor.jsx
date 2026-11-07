import { useCallback, useEffect, useRef, useState } from 'react';
import Compare from './Compare.jsx';
import { api } from '../api.js';
import { PRESETS, OCEAN_LUTS } from '../engine/presets.js';

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
    subtitle: 'Suhu, Corak, Saturasi & Vibrance',
    items: [
      { key: 'temperature', label: 'Suhu Warna (Temp)', min: -50, max: 50, bipolar: true, hint: 'Dingin (Biru) ↔ Hangat (Kuning)' },
      { key: 'tint', label: 'Corak (Tint)', min: -50, max: 50, bipolar: true, hint: 'Hijau (−) ↔ Magenta (+)' },
      { key: 'saturation', label: 'Saturasi', min: -50, max: 50, bipolar: true, hint: 'Kepekatan warna' },
      { key: 'vibrance', label: 'Vibrance', min: -50, max: 60, bipolar: true, hint: 'Mengangkat warna lembut tanpa merusak kulit' },
    ],
  },
  {
    id: 'cahaya',
    title: 'Cahaya & Kontras',
    subtitle: 'Kecerahan, Sorotan, Bayangan & Kontras',
    items: [
      { key: 'exposure', label: 'Kecerahan (Exposure)', min: -50, max: 50, bipolar: true, hint: 'Mengatur terang-gelap keseluruhan foto' },
      { key: 'contrast', label: 'Kontras', min: -50, max: 50, bipolar: true, hint: 'Ketegasan gelap dan terang' },
      { key: 'highlight', label: 'Sorotan (Highlight)', min: -50, max: 50, bipolar: true, hint: 'Detail area terang & pantulan sinar matahari' },
      { key: 'shadows', label: 'Bayangan (Shadow)', min: -50, max: 50, bipolar: true, hint: 'Detail area gelap pada karang & wetsuit' },
      { key: 'whites', label: 'Iluminasi (Whites)', min: -50, max: 50, bipolar: true, hint: 'Titik putih terang pada pasir & riak air' },
      { key: 'blacks', label: 'Hitam (Blacks)', min: -50, max: 50, bipolar: true, hint: 'Kepekatan bayangan terdalam' },
    ],
  },
  {
    id: 'efek',
    title: 'Detail & Ketajaman',
    subtitle: 'Pertajam, Kejelasan & Vinyet',
    items: [
      { key: 'sharpen', label: 'Pertajam (Sharpen)', min: 0, max: 100, hint: 'Menajamkan detail objek bawah air' },
      { key: 'clarity', label: 'Kejelasan (Clarity)', min: -30, max: 80, bipolar: true, hint: 'Dimensi 3D dan struktur objek' },
      { key: 'fade', label: 'Pudarkan (Fade)', min: 0, max: 100, hint: 'Sentuhan film matte lembut' },
      { key: 'vignette', label: 'Vinyet (Vignette)', min: -50, max: 80, bipolar: true, hint: 'Menerangkan (−) atau menggelapkan (+) tepi sudut' },
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
  const [activeTab, setActiveTab] = useState('luts'); // 'luts' | 'ai' | 'tune' | 'export'
  const [tuneFilter, setTuneFilter] = useState('all'); // 'all' | 'warna' | 'cahaya' | 'efek'
  const [viewMode, setViewMode] = useState('split'); // 'split' | 'after' | 'before'
  const [holdBefore, setHoldBefore] = useState(false);

  const [afterUrl, setAfterUrl] = useState(null);
  const [renderMs, setRenderMs] = useState(null);
  const [engine] = useState('lokal');
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

  // High-Tech 0-100% Progress State (hanya untuk upload awal / explicit AI analysis)
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
    const t = setTimeout(() => setNotice(''), 3000);
    return () => clearTimeout(t);
  }, [notice]);

  // Dynamic Progress Indicator - HANYA untuk Upload & Explicit AI run
  useEffect(() => {
    let timer = null;
    const isHeavy = uploading || aiBusy;
    if (isHeavy) {
      setProgress({
        active: true,
        percent: 15,
        stage: uploading
          ? 'Membaca Spektrum Optik & Kedalaman Kolom Air…'
          : 'AI Menganalisis Kedalaman & Pigmen Warna…',
      });

      const startTime = Date.now();
      timer = setInterval(() => {
        const elapsed = Date.now() - startTime;
        setProgress((prev) => {
          if (!prev.active) return prev;
          let nextPct = prev.percent;
          let stage = prev.stage;
          if (elapsed < 350) {
            nextPct = Math.min(48, prev.percent + 6);
            stage = uploading
              ? 'Memisahkan Kolom Air Laut, Karang & Subjek…'
              : 'Memetakan Lapisan Air Laut, Pasir & Subjek…';
          } else if (elapsed < 850) {
            nextPct = Math.min(78, prev.percent + 4);
            stage = 'Menghitung Kalibrasi Pigmen & Restorasi Alami…';
          } else if (elapsed < 1600) {
            nextPct = Math.min(94, prev.percent + 2);
            stage = 'Memvalidasi Rekonstruksi Struktur Foto…';
          }
          return { active: true, percent: nextPct, stage };
        });
      }, 60);
    } else {
      setProgress((prev) => {
        if (!prev.active) return prev;
        return { active: true, percent: 100, stage: 'Restorasi Selesai!' };
      });
      const hideTimer = setTimeout(() => {
        setProgress({ active: false, percent: 0, stage: '' });
      }, 300);
      return () => clearTimeout(hideTimer);
    }

    return () => {
      if (timer) clearInterval(timer);
    };
  }, [uploading, aiBusy]);

  const uploadFiles = useCallback(async (fileList) => {
    const rawList = Array.from(fileList || []);
    const files = rawList.filter(isSupportedImageFile).slice(0, 8);
    if (!files.length) {
      if (rawList.length) {
        setError('Format file belum didukung. Gunakan JPG, PNG, WEBP, atau HEIC.');
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

  useEffect(() => {
    if (!active) {
      setParams(null);
      setBaseParams(null);
      setAfterUrl(null);
      return;
    }
    const initial = { ...active.auto, preset: active.auto?.preset || 'freedive', refMatch: 0 };
    setParams(initial);
    setBaseParams(initial);
    setIntensity(100);
    setAfterUrl(null);
    setAi(null);
    setMetrics(null);
  }, [activeId]);

  // Debounced render
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
    }, 180);

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
        setNotice('✦ AI Auto White Balance berhasil diterapkan!');
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

  function applyLut(lutId) {
    if (!active) return;
    const base = PRESETS[lutId]?.base || PRESETS.freedive.base;
    const next = { ...base, preset: lutId, refMatch: 0 };
    setBaseParams(next);
    const factor = intensity / 100;
    const scaled = { ...next };
    for (const k of RESTORATION_KEYS) {
      if (next[k] !== undefined) {
        scaled[k] = Math.round(next[k] * factor);
      }
    }
    setParams(scaled);
    const lutMeta = OCEAN_LUTS.find((l) => l.id === lutId);
    setNotice(`LUT ${lutMeta ? lutMeta.name : lutId} diterapkan.`);
  }

  function resetParams() {
    if (!active) return;
    const initial = { ...active.auto, preset: active.auto?.preset || 'freedive', refMatch: 0 };
    setParams(initial);
    setBaseParams(initial);
    setIntensity(100);
    setAi(null);
    setNotice('Kembali ke setelan otomatis awal.');
  }

  const removeAsset = useCallback((idToRemove) => {
    api.removeAsset(idToRemove);
    setAssets((prev) => {
      const remaining = prev.filter((a) => a.id !== idToRemove);
      if (activeId === idToRemove) {
        const nextActive = remaining.length > 0 ? remaining[0].id : null;
        setActiveId(nextActive);
      }
      return remaining;
    });
  }, [activeId]);

  function updateSingleSlider(key, val) {
    setParams((prev) => ({ ...prev, [key]: val }));
    setBaseParams((prev) => (prev ? { ...prev, [key]: val } : prev));
  }

  function resetSingleSlider(key) {
    const fallback = active?.auto?.[key] ?? 0;
    updateSingleSlider(key, fallback);
  }

  async function toggleFullscreen() {
    const next = !full;
    setFull(next);
    const el = stageRef.current;
    if (!el) return;
    try {
      if (next) await el.requestFullscreen?.();
      else if (document.fullscreenElement) await document.exitFullscreen();
    } catch {}
  }

  async function handleDownload(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (!active || !params) return;
    if (active.id?.startsWith('local-') || api.isOffline?.()) {
      try {
        setNotice('Menyimpan ke Galeri HP (Full HD)...');
        const { offlineEngine } = await import('../offlineEngine.js');
        const res = await offlineEngine.exportHighRes(active.id, params, format === 'webp' ? 'image/webp' : 'image/jpeg');

        if (res.gallerySaved) {
          setNotice('Foto berhasil tersimpan di Galeri HP (Album: FreeColor)!');
        } else {
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

  // Compute live RGB balance percentages
  const rawR = Math.round((active?.stats?.meanR ?? 0.22) * 100);
  const rawG = Math.round((active?.stats?.meanG ?? 0.55) * 100);
  const rawB = Math.round((active?.stats?.meanB ?? 0.52) * 100);
  const estGainR = metrics?.gainR || 1.25;
  const balR = Math.min(100, Math.round(rawR * estGainR * (intensity / 100) + rawR * (1 - intensity / 100)));

  return (
    <div
      className="ocean-app"
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
      {/* 1. Header Bar: Ocean Edit Brand + Mode Demo */}
      <header className="ocean-top-bar">
        <div className="ocean-brand">
          <span className="ocean-brand-icon">🌊</span>
          <div className="ocean-brand-text">
            <b>OCEAN EDIT</b>
            <span className="ocean-demo-tag">DEMO MODE · OFFLINE</span>
          </div>
        </div>

        <div className="ocean-top-actions">
          {active && (
            <div className="ocean-view-selector" role="group" aria-label="Mode tampilan">
              <button
                type="button"
                className={viewMode === 'split' && !holdBefore ? 'on' : ''}
                onClick={() => setViewMode('split')}
                title="Mode Belah (Split)"
              >
                Belah
              </button>
              <button
                type="button"
                className={viewMode === 'after' && !holdBefore ? 'on' : ''}
                onClick={() => setViewMode('after')}
                title="Tampilan Hasil Penuh"
              >
                Hasil
              </button>
              <button
                type="button"
                className={holdBefore || viewMode === 'before' ? 'on' : ''}
                onMouseDown={() => setHoldBefore(true)}
                onMouseUp={() => setHoldBefore(false)}
                onMouseLeave={() => setHoldBefore(false)}
                onTouchStart={() => setHoldBefore(true)}
                onTouchEnd={() => setHoldBefore(false)}
                onClick={() => setViewMode((v) => (v === 'before' ? 'split' : 'before'))}
                title="Tahan untuk melihat foto asli"
              >
                Asli
              </button>
            </div>
          )}

          <button
            type="button"
            className="ocean-icon-btn"
            onClick={toggleFullscreen}
            title="Layar Penuh (F)"
          >
            {full ? '⤓' : '⛶'}
          </button>

          <button
            type="button"
            className="ocean-add-btn"
            onClick={() => inputRef.current?.click()}
          >
            + Foto
          </button>
        </div>
      </header>

      {/* 2. Body View: Empty / Upload or Active Editor */}
      {!assets.length ? (
        <section className="ocean-empty-view">
          <div className={`ocean-upload-card ${drop ? 'drag-on' : ''}`} onClick={() => inputRef.current?.click()}>
            <div className="ocean-upload-icon" aria-hidden="true">
              <svg viewBox="0 0 48 48" width="52" height="52">
                <path d="M24 32V12m0 0-7 7m7-7 7 7" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M8 30v6a4 4 0 0 0 4 4h24a4 4 0 0 0 4-4v-6" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
              </svg>
            </div>
            <h1>{uploading ? 'Membaca Spektrum Optik…' : 'OCEAN EDIT STUDIO'}</h1>
            <p className="ocean-empty-desc">
              Grading warna bawah air profesional untuk Scuba & Freediving.
              <br />
              <b>100% In-Device Offline Engine</b> · Cepat & Ringan di HP Anda.
            </p>
            <button type="button" className="ocean-btn-hero">
              {uploading ? 'Sedang Memproses Foto…' : '📸 Buka Foto Bawah Air'}
            </button>
            <div className="ocean-feature-tags">
              <span>🌊 Solstice & Underwater LUTs</span>
              <span>✦ AI Auto White Balance</span>
              <span>⚡ Full HD Resolusi Tinggi</span>
              <span>💾 Simpan Langsung ke Galeri</span>
            </div>
          </div>
          {error && <p className="ed-error">{error}</p>}
        </section>
      ) : (
        <div className="ocean-editor-layout">
          {/* Main Visual Stage / Viewport */}
          <section className="ocean-viewport">
            <div
              ref={stageRef}
              className={`ocean-stage-frame ${full ? 'is-full' : ''}`}
              onDoubleClick={toggleFullscreen}
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

              {/* Discreet live loading indicator during manual grading */}
              {rendering && !progress.active && (
                <div className="ocean-mini-badge" title="Memperbarui tampilan...">
                  <span className="ocean-spin" />
                  <span>Memperbarui…</span>
                </div>
              )}

              {/* High-Tech 0-100% Progress Modal Overlay */}
              {progress.active && (
                <div className="processing-progress-overlay">
                  <div className="processing-progress-card">
                    <div className="processing-header">
                      <span className="processing-spinner" />
                      <div className="processing-info">
                        <h4>Ocean Edit · Rekonstruksi Spektrum</h4>
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
                      <span className={`p-badge ${progress.percent >= 25 ? 'done' : ''}`}>🌊 Air Laut</span>
                      <span className={`p-badge ${progress.percent >= 50 ? 'done' : ''}`}>🏖️ Subjek</span>
                      <span className={`p-badge ${progress.percent >= 75 ? 'done' : ''}`}>🎨 Pigmen</span>
                      <span className={`p-badge ${progress.percent >= 90 ? 'done' : ''}`}>🛡️ Dehaze</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Thumbnail Filmstrip with Close Button */}
            <div className="ocean-filmstrip">
              {assets.map((a) => (
                <div
                  key={a.id}
                  className={`ocean-strip-thumb ${a.id === activeId ? 'active' : ''}`}
                  onClick={() => setActiveId(a.id)}
                  title={a.name}
                  role="button"
                  tabIndex={0}
                >
                  <img src={a.thumbUrl} alt={a.name} />
                  <button
                    type="button"
                    className="strip-remove"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeAsset(a.id);
                    }}
                    title={`Hapus ${a.name}`}
                    aria-label={`Hapus ${a.name}`}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="ocean-strip-add"
                onClick={() => inputRef.current?.click()}
                title="Tambah Foto"
              >
                +
              </button>
            </div>
          </section>

          {/* Ocean Edit Control Deck */}
          <aside className="ocean-deck">
            {/* 4 Bottom Navigation Tabs */}
            <nav className="ocean-deck-tabs" aria-label="Navigasi Fitur Ocean Edit">
              <button
                type="button"
                className={`ocean-tab ${activeTab === 'luts' ? 'active' : ''}`}
                onClick={() => setActiveTab('luts')}
              >
                <span className="tab-icon">🎨</span>
                <span className="tab-title">LUTs</span>
              </button>
              <button
                type="button"
                className={`ocean-tab ${activeTab === 'ai' ? 'active' : ''}`}
                onClick={() => setActiveTab('ai')}
              >
                <span className="tab-icon">✦</span>
                <span className="tab-title">AI Balance</span>
              </button>
              <button
                type="button"
                className={`ocean-tab ${activeTab === 'tune' ? 'active' : ''}`}
                onClick={() => setActiveTab('tune')}
              >
                <span className="tab-icon">🎚️</span>
                <span className="tab-title">Sesuaikan</span>
              </button>
              <button
                type="button"
                className={`ocean-tab ${activeTab === 'export' ? 'active' : ''}`}
                onClick={() => setActiveTab('export')}
              >
                <span className="tab-icon">💾</span>
                <span className="tab-title">Simpan</span>
              </button>
            </nav>

            {/* Tab Panes */}
            <div className="ocean-deck-content">
              {/* TAB 1: UNDERWATER LUTS */}
              {activeTab === 'luts' && (
                <div className="ocean-tab-pane">
                  {/* Master Intensity */}
                  <div className="ocean-card">
                    <div className="slider-top">
                      <label htmlFor="sl-lut-intensity">Kekuatan LUT ({intensity}%)</label>
                      <button type="button" className="link-btn" onClick={resetParams}>Reset</button>
                    </div>
                    <input
                      id="sl-lut-intensity"
                      type="range"
                      min={0}
                      max={150}
                      step={1}
                      value={intensity}
                      onDoubleClick={() => applyIntensityScale(100)}
                      onChange={(e) => applyIntensityScale(Number(e.target.value))}
                    />
                    <div className="master-ticks">
                      <span>0% (Asli)</span>
                      <span>100% (Standar)</span>
                      <span>150% (Kuat)</span>
                    </div>
                  </div>

                  <div className="ocean-section-header">
                    <span>UNDERWATER LOOK-UP TABLES (LUTs)</span>
                    <small>Dikalibrasi untuk GoPro, DJI & Mirrorless</small>
                  </div>

                  <div className="ocean-lut-list">
                    {OCEAN_LUTS.map((lut) => {
                      const isSel = (params?.preset || 'freedive') === lut.id;
                      return (
                        <button
                          key={lut.id}
                          type="button"
                          className={`ocean-lut-card ${isSel ? 'active' : ''}`}
                          onClick={() => applyLut(lut.id)}
                        >
                          <div className="ocean-lut-badge" style={{ borderColor: lut.color, background: `${lut.color}18` }}>
                            <span>{lut.icon}</span>
                          </div>
                          <div className="ocean-lut-info">
                            <div className="ocean-lut-row">
                              <span className="ocean-lut-name">{lut.name}</span>
                              {isSel && <span className="ocean-lut-active-tag">AKTIF</span>}
                            </div>
                            <span className="ocean-lut-tag">{lut.tag}</span>
                            <p className="ocean-lut-desc">{lut.desc}</p>
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  {/* Diagnostic Spectrum */}
                  {active?.condition && (
                    <div className="ocean-spec-card">
                      <div className="ocean-spec-head">
                        <span>SENSOR OPTIK SPEKTRUM AIR</span>
                        <span className="ocean-tag-cyan">Cast {active.condition.cast}</span>
                      </div>
                      <div className="diag">
                        <span className="chip"><b>Defisit Merah</b>−{active.condition.redLoss}%</span>
                        <span className="chip"><b>Partikel Haze</b>{active.condition.haze}</span>
                        <span className="chip"><b>Kerapatan 3D</b>{active.condition.detail}</span>
                      </div>
                      <div className="rgb-bars" style={{ marginTop: 8 }}>
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
                  )}
                </div>
              )}

              {/* TAB 2: AI BALANCE & OPTICAL RECOVERY */}
              {activeTab === 'ai' && (
                <div className="ocean-tab-pane">
                  {/* Hero Auto Button */}
                  <div className="ocean-ai-card">
                    <button
                      type="button"
                      className="ocean-ai-hero-btn"
                      onClick={runAI}
                      disabled={aiBusy || !active}
                    >
                      <span className="ai-spark">✦</span>
                      <div className="ai-btn-text">
                        <b>{aiBusy ? `AI Menganalisis Spektrum… ${aiWait ? `${aiWait}s` : ''}` : 'AI Auto White Balance'}</b>
                        <small>{aiBusy ? 'Menghitung kedalaman & red restoration…' : 'Satu sentuhan: otomatis pulihkan spektrum merah & eliminasi kabut air'}</small>
                      </div>
                    </button>

                    {ai && (
                      <div className="ai-result-box" style={{ marginTop: 10 }}>
                        <div className="diag">
                          {ai.scene && <span className="chip"><b>Tipe Air</b>{ai.scene}</span>}
                          {ai.depthM != null && <span className="chip"><b>Kedalaman</b>±{ai.depthM}m</span>}
                          {ai.backscatter && <span className="chip"><b>Partikel</b>{ai.backscatter}</span>}
                        </div>
                        {ai.notes && <p className="ai-note">{ai.notes}</p>}
                      </div>
                    )}
                  </div>

                  <div className="ocean-section-header">
                    <span>KONTROL SPEKTRUM AIR (PHYSICS ENGINE)</span>
                  </div>

                  <div className="ocean-slider-group">
                    {/* 1. Pulihkan Spektrum Merah */}
                    <div className="slider">
                      <div className="slider-top">
                        <label htmlFor="sl-redRestore">Pulihkan Merah (Red Recovery)</label>
                        <output>{Math.round(params?.redRestore || 0)}%</output>
                      </div>
                      <input
                        id="sl-redRestore"
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={params?.redRestore || 0}
                        onDoubleClick={() => resetSingleSlider('redRestore')}
                        onChange={(e) => updateSingleSlider('redRestore', Number(e.target.value))}
                      />
                    </div>

                    {/* 2. Kejernihan Air / Dehaze */}
                    <div className="slider">
                      <div className="slider-top">
                        <label htmlFor="sl-veil">Kejernihan Air (Dehaze)</label>
                        <output>{Math.round(params?.veil || 0)}%</output>
                      </div>
                      <input
                        id="sl-veil"
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={params?.veil || 0}
                        onDoubleClick={() => resetSingleSlider('veil')}
                        onChange={(e) => updateSingleSlider('veil', Number(e.target.value))}
                      />
                    </div>

                    {/* 3. Reduksi Fog Kedalaman */}
                    <div className="slider">
                      <div className="slider-top">
                        <label htmlFor="sl-attenuation">Keseimbangan Kedalaman</label>
                        <output>{Math.round(params?.attenuation || 0)}%</output>
                      </div>
                      <input
                        id="sl-attenuation"
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={params?.attenuation || 0}
                        onDoubleClick={() => resetSingleSlider('attenuation')}
                        onChange={(e) => updateSingleSlider('attenuation', Number(e.target.value))}
                      />
                    </div>

                    {/* 4. Marine Snow / Backscatter Inpainting */}
                    <div className="slider">
                      <div className="slider-top">
                        <label htmlFor="sl-spotRemoval">Hapus Backscatter (Marine Snow)</label>
                        <output>{Math.round(params?.spotRemoval || 0)}%</output>
                      </div>
                      <input
                        id="sl-spotRemoval"
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={params?.spotRemoval || 0}
                        onDoubleClick={() => resetSingleSlider('spotRemoval')}
                        onChange={(e) => updateSingleSlider('spotRemoval', Number(e.target.value))}
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 3: SESUAIKAN (MANUAL GRADING) */}
              {activeTab === 'tune' && params && (
                <div className="ocean-tab-pane">
                  <div className="ocean-tune-filters">
                    {[
                      { id: 'all', label: 'Semua' },
                      { id: 'warna', label: 'Warna' },
                      { id: 'cahaya', label: 'Cahaya' },
                      { id: 'efek', label: 'Detail' },
                    ].map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        className={`ocean-filter-pill ${tuneFilter === f.id ? 'on' : ''}`}
                        onClick={() => setTuneFilter(f.id)}
                      >
                        {f.label}
                      </button>
                    ))}
                    <button type="button" className="link-btn" style={{ marginLeft: 'auto' }} onClick={resetParams}>
                      Reset
                    </button>
                  </div>

                  <div className="ocean-tune-stack">
                    {SLIDER_GROUPS
                      .filter((g) => tuneFilter === 'all' || tuneFilter === g.id)
                      .map((group) => (
                        <div key={group.id} className="ocean-group-card">
                          <h4 className="ocean-group-title">{group.title}</h4>
                          <div className="ocean-slider-group">
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
                        </div>
                      ))}
                  </div>
                </div>
              )}

              {/* TAB 4: SIMPAN / EKSPOR */}
              {activeTab === 'export' && (
                <div className="ocean-tab-pane">
                  <div className="ocean-export-box">
                    <h3>Ekspor Galeri Foto</h3>
                    <p>Format Full HD yang tajam dan otomatis disesuaikan agar kompatibel dengan seluruh HP Android.</p>

                    <div className="ocean-format-selector">
                      <button
                        type="button"
                        className={`format-option ${format === 'jpeg' ? 'active' : ''}`}
                        onClick={() => setFormat('jpeg')}
                      >
                        <b>JPG / JPEG</b>
                        <small>Standar Galeri Universal</small>
                      </button>
                      <button
                        type="button"
                        className={`format-option ${format === 'webp' ? 'active' : ''}`}
                        onClick={() => setFormat('webp')}
                      >
                        <b>WEBP</b>
                        <small>Modern & Hemat Ukuran</small>
                      </button>
                    </div>

                    <div className="ocean-spec-table">
                      <div className="spec-item">
                        <span>Resolusi</span>
                        <b>Full HD (1920px)</b>
                      </div>
                      <div className="spec-item">
                        <span>Ukuran Maksimal</span>
                        <b>&le; 2.0 MB</b>
                      </div>
                      <div className="spec-item">
                        <span>Target Penyimpanan</span>
                        <b>Galeri HP (Album: FreeColor)</b>
                      </div>
                      <div className="spec-item">
                        <span>Kecepatan Simpan</span>
                        <b>Instan (Direct MediaStore)</b>
                      </div>
                    </div>

                    <button
                      type="button"
                      className="ocean-save-primary-btn"
                      onClick={handleDownload}
                    >
                      📸 Simpan ke Galeri HP (Full HD)
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Quick Sticky Save Action Bar when in LUTs, AI, or Tune tab */}
            {activeTab !== 'export' && active && (
              <div className="ocean-deck-bottom-bar">
                <button
                  type="button"
                  className="ocean-quick-save-btn"
                  onClick={handleDownload}
                >
                  📸 Simpan ke Galeri (Full HD)
                </button>
              </div>
            )}
          </aside>
        </div>
      )}

      {/* Toast Notifications & Alerts */}
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
