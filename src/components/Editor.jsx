import { useCallback, useEffect, useRef, useState } from 'react';
import Compare from './Compare.jsx';
import { api } from '../api.js';
import { PRESETS, LOOKS } from '../engine/presets.js';
import { GRADE_DEFAULTS, CURVE_CHANNELS, curvePath, wbFromPick } from '../engine/grade.js';

/* ------------------------------------------------------------------ data */

const RESTORATION_KEYS = [
  'redRestore', 'veil', 'attenuation', 'spotRemoval', 'waterLight', 'waterTint', 'skinTone', 'neutral',
  'clarity', 'sharpen', 'vibrance', 'saturation', 'contrast', 'exposure', 'temperature', 'tint',
  'shadows', 'highlight', 'whites', 'blacks',
];

const TABS = [
  { id: 'look', label: 'Look' },
  { id: 'warna', label: 'Warna' },
  { id: 'cahaya', label: 'Cahaya' },
  { id: 'hsl', label: 'HSL' },
  { id: 'kurva', label: 'Kurva' },
  { id: 'detail', label: 'Detail' },
  { id: 'simpan', label: 'Simpan' },
];

const HSL_BANDS = [
  { id: 'red', label: 'Merah', color: '#e5484d' },
  { id: 'orange', label: 'Oranye', color: '#f08a24' },
  { id: 'yellow', label: 'Kuning', color: '#e5b800' },
  { id: 'green', label: 'Hijau', color: '#2ca56b' },
  { id: 'cyan', label: 'Cyan', color: '#16b3c4' },
  { id: 'blue', label: 'Biru', color: '#1d78e6' },
  { id: 'purple', label: 'Ungu', color: '#7a5af0' },
  { id: 'magenta', label: 'Magenta', color: '#d6409f' },
];

const S = (key, label, min, max, extra = {}) => ({ key, label, min, max, ...extra });

const WARNA = [
  S('temperature', 'Suhu (Temp)', -50, 50, { hint: 'Dingin (biru) ↔ hangat (kuning)' }),
  S('tint', 'Corak (Tint)', -50, 50, { hint: 'Hijau ↔ magenta' }),
  S('saturation', 'Saturasi', -50, 50),
  S('vibrance', 'Vibrance', -50, 60, { hint: 'Naikkan warna lembut tanpa merusak kulit' }),
];
const PULIH = [
  S('redRestore', 'Pulihkan Merah', 0, 100, { unit: '%', hint: 'Kembalikan spektrum merah yang hilang di dalam air' }),
  S('attenuation', 'Kompensasi Kedalaman', 0, 100, { unit: '%' }),
  S('waterTint', 'Warna Air', 0, 100, { unit: '%', hint: 'Arahkan air ke biru/toska alami' }),
  S('waterLight', 'Cahaya Air', 0, 100, { unit: '%' }),
  S('skinTone', 'Jaga Warna Kulit', 0, 100, { unit: '%' }),
  S('neutral', 'Netralkan Pasir & Alat', 0, 100, { unit: '%' }),
];
const CAHAYA = [
  S('exposure', 'Kecerahan', -50, 50),
  S('contrast', 'Kontras', -50, 50),
  S('highlight', 'Sorotan', -50, 50),
  S('shadows', 'Bayangan', -50, 50),
  S('whites', 'Putih', -50, 50),
  S('blacks', 'Hitam', -50, 50),
];
const GRADASI = [
  S('gradTop', 'Gradasi Atas (permukaan)', -50, 50, { hint: 'Redupkan / terangkan bagian atas foto' }),
  S('gradBottom', 'Gradasi Bawah (dasar)', -50, 50, { hint: 'Redupkan / terangkan bagian bawah foto' }),
];
const DETAIL = [
  S('sharpen', 'Pertajam', 0, 100),
  S('clarity', 'Kejelasan', -30, 80),
  S('veil', 'Kejernihan Air (Dehaze)', 0, 100, { unit: '%' }),
  S('spotRemoval', 'Hapus Backscatter', 0, 100, { unit: '%', hint: 'Bersihkan partikel melayang (marine snow)' }),
  S('fade', 'Pudar (Matte)', 0, 100),
  S('vignette', 'Vinyet', -50, 80),
];
const SPLIT = [
  S('splitShadowHue', 'Warna Bayangan', 0, 360, { hue: true }),
  S('splitShadowAmt', 'Kekuatan Bayangan', 0, 100),
  S('splitHighHue', 'Warna Sorotan', 0, 360, { hue: true }),
  S('splitHighAmt', 'Kekuatan Sorotan', 0, 100),
];

const hueGradient = 'linear-gradient(90deg,#f33,#ff3,#3f3,#3ff,#33f,#f3f,#f33)';

/* ------------------------------------------------------------ small parts */

function Slider({ item, value, onChange, onReset, onCommit }) {
  const { label, min, max, unit = '', hint, hue } = item;
  const pct = ((value - min) / (max - min)) * 100;
  const zero = min < 0 ? ((0 - min) / (max - min)) * 100 : 0;
  const l = hue ? 0 : Math.min(pct, zero);
  const r = hue ? 0 : Math.max(pct, zero);
  const shown = Math.round(value);
  return (
    <div className="sl" title={hint}>
      <div className="sl-top">
        <label onClick={onReset} title="Klik / ketuk untuk reset">{label}</label>
        <output onClick={onReset} title="Klik / ketuk untuk reset">{min < 0 && shown > 0 ? `+${shown}` : shown}{unit}</output>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        className={hue ? 'sl-hue' : ''}
        style={hue ? { background: hueGradient } : { '--l': `${l}%`, '--r': `${r}%` }}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={onCommit}
        onTouchEnd={onCommit}
        onKeyUp={onCommit}
        onDoubleClick={onReset}
        aria-label={label}
      />
    </div>
  );
}

function Icon({ name }) {
  const common = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
  switch (name) {
    case 'plus': return <svg {...common}><path d="M12 5v14M5 12h14" /></svg>;
    case 'sparkle': return <svg {...common}><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z" /></svg>;
    case 'save': return <svg {...common}><path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14" /></svg>;
    case 'pick': return <svg {...common}><path d="M14 4l6 6-3 3-6-6zM11 7L4 14v4h4l7-7" /></svg>;
    case 'close': return <svg {...common}><path d="M6 6l12 12M18 6L6 18" /></svg>;
    case 'wave': return <svg {...common}><path d="M2 9c2.5-2 5-2 7.5 0s5 2 7.5 0 3-1.5 5-1M2 15c2.5-2 5-2 7.5 0s5 2 7.5 0 3-1.5 5-1" /></svg>;
    case 'undo': return <svg {...common}><path d="M9 14L4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11" /></svg>;
    case 'redo': return <svg {...common}><path d="M15 14l5-5-5-5" /><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5v0A5.5 5.5 0 0 0 9.5 20H13" /></svg>;
    case 'rotate': return <svg {...common}><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.85.83 6.72 2.24L21 7" /><path d="M21 3v4h-4" /></svg>;
    case 'fullscreen': return <svg {...common}><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" /></svg>;
    default: return null;
  }
}

function isSupportedImageFile(file) {
  if (!file) return false;
  if (String(file.type || '').toLowerCase().startsWith('image/')) return true;
  return /\.(heic|heif|avif|jpe?g|png|webp|bmp|gif|tiff?)$/i.test(String(file.name || ''));
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/* ------------------------------------------------------------------ main */

export default function Editor() {
  const [assets, setAssets] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [params, setParams] = useState(null);
  const [baseParams, setBaseParams] = useState(null);
  const [intensity, setIntensity] = useState(100);
  const [tab, setTab] = useState('look');
  const [viewMode, setViewMode] = useState('split');
  const [holdBefore, setHoldBefore] = useState(false);
  const [afterUrl, setAfterUrl] = useState(null);
  const [renderMs, setRenderMs] = useState(null);
  const [rendering, setRendering] = useState(false);
  const [saving, setSaving] = useState(false);
  const [drop, setDrop] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [format, setFormat] = useState('jpeg');
  const [pickMode, setPickMode] = useState(false);
  const [hslBand, setHslBand] = useState('cyan');
  const [curveCh, setCurveCh] = useState('m');

  // Magic Vision AI scanner state
  const [aiPhase, setAiPhase] = useState('');

  // History stack for Undo / Redo
  const [history, setHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  const inputRef = useRef(null);
  const seq = useRef(0);
  const dragDepth = useRef(0);
  const prevPresetRef = useRef(null);

  const active = assets.find((a) => a.id === activeId) || null;
  const val = (key) => params?.[key] ?? GRADE_DEFAULTS[key] ?? 0;

  /* notices */
  useEffect(() => {
    if (!notice) return undefined;
    const t = setTimeout(() => setNotice(''), 1600);
    return () => clearTimeout(t);
  }, [notice]);

  /* hold space / long-press to compare */
  useEffect(() => {
    const down = (e) => {
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (e.code === 'Space' && !e.repeat && active) {
        e.preventDefault();
        setHoldBefore(true);
      }
      if (e.key === 'Escape') {
        setPickMode(false);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault();
        redo();
      }
    };
    const up = (e) => e.code === 'Space' && setHoldBefore(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [active, history, historyIndex]);

  /* upload with Magic Vision AI scanner */
  const uploadFiles = useCallback(async (fileList) => {
    const raw = Array.from(fileList || []);
    const files = raw.filter(isSupportedImageFile).slice(0, 12);
    if (!files.length) {
      if (raw.length) setError('Format belum didukung. Gunakan JPG, PNG, WEBP, atau HEIC.');
      return;
    }
    setError('');
    setAiPhase('Memindai foto & spektrum bawah air…');
    let firstId = null;
    let firstAsset = null;
    let failed = 0;
    for (let i = 0; i < files.length; i++) {
      try {
        const res = await api.upload(files[i]);
        setAssets((prev) => [...prev, { ...res.asset, condition: res.condition }]);
        if (!firstId) {
          firstId = res.asset.id;
          firstAsset = res.asset;
        }
      } catch {
        failed++;
      }
    }
    if (firstId && firstAsset) {
      setActiveId(firstId);
      setAiPhase('Mengidentifikasi subjek & warna air…');
      await new Promise((r) => setTimeout(r, 260));
      setAiPhase('Menyempurnakan restorasi optik & warna…');
      
      const initial = {
        ...GRADE_DEFAULTS,
        ...(firstAsset.auto || {}),
        preset: firstAsset.auto?.preset || 'freedive',
        refMatch: 0
      };
      setParams(initial);
      setBaseParams(initial);
      setIntensity(100);
      commitParams(initial);

      // Strictly await the render so loading HUD matches actual image readiness!
      try {
        const res = await api.render(firstId, initial);
        setAfterUrl(res.url);
        setRenderMs(res.ms);
      } catch (err) {
        if (!err || err.name === 'AbortError' || String(err.message || '').toLowerCase().includes('superseded')) return;
        console.warn('Initial render error on upload:', err);
      }
    }
    setAiPhase('');
    if (failed) setError(`${failed} foto gagal dibuka.`);
    else setNotice('✨ AI Auto Grading diterapkan!');
  }, []);

  useEffect(() => {
    const onPaste = (e) => {
      const files = Array.from(e.clipboardData?.files || []);
      if (files.length) uploadFiles(files);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [uploadFiles]);

  /* a new active photo starts from its own automatic grade */
  useEffect(() => {
    if (!active) {
      setParams(null);
      setBaseParams(null);
      setAfterUrl(null);
      setHistory([]);
      setHistoryIndex(-1);
      return;
    }
    const initial = { ...GRADE_DEFAULTS, ...active.auto, preset: active.auto?.preset || 'freedive', refMatch: 0 };
    setParams(initial);
    setBaseParams(initial);
    setIntensity(100);
    setAfterUrl(null);
    setPickMode(false);
    setHistory([initial]);
    setHistoryIndex(0);
  }, [activeId]);

  /* render: debounced for sliders, 0ms instant for Look presets, cancel-safe. Completely silent — zero busy spinners. */
  useEffect(() => {
    if (!activeId || !params) return undefined;
    const isPresetChange = prevPresetRef.current !== params.preset;
    prevPresetRef.current = params.preset;
    const delay = isPresetChange ? 0 : 75;

    const ticket = ++seq.current;
    setRendering(true);
    const timer = setTimeout(async () => {
      try {
        const res = await api.render(activeId, params);
        if (ticket !== seq.current) return;
        setAfterUrl(res.url);
        setRenderMs(res.ms);
        setError('');
      } catch (err) {
        if (!err || err.name === 'AbortError' || String(err.message || '').toLowerCase().includes('superseded')) return;
        if (ticket === seq.current) setError(err.message || 'Gagal memproses foto.');
      } finally {
        if (ticket === seq.current) setRendering(false);
      }
    }, delay);
    return () => clearTimeout(timer);
  }, [activeId, params]);

  /* ---- parameter helpers & undo/redo tracking ---- */
  const commitParams = useCallback((newParams = params) => {
    if (!newParams) return;
    setHistory((prev) => {
      const truncated = prev.slice(0, historyIndex + 1);
      if (truncated.length >= 35) truncated.shift();
      return [...truncated, { ...newParams }];
    });
    setHistoryIndex((prev) => Math.min(34, prev + 1));
  }, [params, historyIndex]);

  const undo = useCallback(() => {
    if (historyIndex > 0) {
      const nextIdx = historyIndex - 1;
      setHistoryIndex(nextIdx);
      const prev = history[nextIdx];
      setParams(prev);
      setBaseParams(prev);
    }
  }, [history, historyIndex]);

  const redo = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const nextIdx = historyIndex + 1;
      setHistoryIndex(nextIdx);
      const next = history[nextIdx];
      setParams(next);
      setBaseParams(next);
    }
  }, [history, historyIndex]);

  const setKey = (key, v) => {
    setParams((p) => ({ ...p, [key]: v }));
    setBaseParams((p) => (p ? { ...p, [key]: v } : p));
  };
  const resetKey = (key) => setKey(key, active?.auto?.[key] ?? GRADE_DEFAULTS[key] ?? 0);
  const setMany = (obj) => {
    setParams((p) => ({ ...p, ...obj }));
    setBaseParams((p) => (p ? { ...p, ...obj } : p));
  };

  function scaleIntensity(pct, ref = baseParams) {
    setIntensity(pct);
    if (!ref) return;
    const f = pct / 100;
    setParams((prev) => {
      if (!prev) return prev;
      const next = { ...prev };
      for (const k of RESTORATION_KEYS) if (ref[k] !== undefined) next[k] = Math.round(ref[k] * f);
      return next;
    });
  }

  /* Run Vision AI Grading with enchanting scanning HUD */
  const runAiGrading = useCallback(async (target = active) => {
    if (!target) return;
    const phases = [
      'Memindai spektrum cahaya & perairan…',
      'Mengukur defisit spektrum merah & kedalaman…',
      'Mengidentifikasi biota laut, karang & diver…',
      'Menyempurnakan restorasi optik & grading…'
    ];
    for (let i = 0; i < phases.length - 1; i++) {
      setAiPhase(phases[i]);
      await new Promise((r) => setTimeout(r, 220));
    }
    setAiPhase(phases[phases.length - 1]);

    const next = {
      ...GRADE_DEFAULTS,
      ...target.auto,
      preset: target.auto?.preset || 'freedive',
      refMatch: 0
    };
    setParams(next);
    setBaseParams(next);
    setIntensity(100);
    commitParams(next);

    // Strictly await actual render result before dismissing the scanning HUD!
    try {
      const res = await api.render(target.id, next);
      setAfterUrl(res.url);
      setRenderMs(res.ms);
    } catch (err) {
      if (!err || err.name === 'AbortError' || String(err.message || '').toLowerCase().includes('superseded')) return;
      console.warn('Render error during AI grading:', err);
    }

    setAiPhase('');
    setNotice('✨ AI Auto Grading selesai diterapkan!');
  }, [active, commitParams]);

  function applyLook(id) {
    if (!active) return;
    const next = { ...params, ...(PRESETS[id]?.base || {}), preset: id, refMatch: 0 };
    setBaseParams(next);
    const f = intensity / 100;
    const scaled = { ...next };
    for (const k of RESTORATION_KEYS) if (next[k] !== undefined) scaled[k] = Math.round(next[k] * f);
    setParams(scaled);
    commitParams(scaled);
  }

  function resetAll() {
    if (!active) return;
    const next = { ...GRADE_DEFAULTS, ...active.auto, preset: active.auto?.preset || 'freedive', refMatch: 0 };
    setParams(next);
    setBaseParams(next);
    setIntensity(100);
    commitParams(next);
    setNotice('Semua pengaturan dikembalikan.');
  }

  const removeAsset = useCallback((id) => {
    api.removeAsset(id);
    setAssets((prev) => {
      const rest = prev.filter((a) => a.id !== id);
      if (activeId === id) setActiveId(rest[0]?.id ?? null);
      return rest;
    });
  }, [activeId]);

  /* ---- rotate 90 degrees ---- */
  async function handleRotate() {
    if (!active) return;
    try {
      setNotice('Memutar foto 90°…');
      const res = await api.rotate(active.id, 90);
      setAssets((prev) => prev.map((a) => (a.id === active.id ? { ...res.asset, condition: res.condition } : a)));
      setAfterUrl(null);
      setNotice('Foto berhasil diputar.');
    } catch (err) {
      setError('Gagal memutar foto: ' + (err.message || err));
    }
  }

  /* ---- fullscreen toggle ---- */
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  };

  /* ---- white-balance eyedropper ---- */
  async function onPick(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    try {
      const img = await loadImage(afterUrl || active.beforeUrl);
      const nw = img.naturalWidth;
      const nh = img.naturalHeight;
      const scale = Math.min(rect.width / nw, rect.height / nh);
      const ox = (rect.width - nw * scale) / 2;
      const oy = (rect.height - nh * scale) / 2;
      const px = Math.round((e.clientX - rect.left - ox) / scale);
      const py = Math.round((e.clientY - rect.top - oy) / scale);
      if (px < 0 || py < 0 || px >= nw || py >= nh) {
        setNotice('Ketuk di dalam area gambar.');
        return;
      }
      const c = document.createElement('canvas');
      c.width = nw;
      c.height = nh;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const x0 = Math.max(0, px - 3);
      const y0 = Math.max(0, py - 3);
      const d = ctx.getImageData(x0, y0, Math.min(7, nw - x0), Math.min(7, nh - y0)).data;
      let r = 0, g = 0, b = 0;
      const cnt = d.length / 4;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
      const newWb = wbFromPick([r / cnt, g / cnt, b / cnt], params);
      const updated = { ...params, ...newWb };
      setMany(newWb);
      commitParams(updated);
      setPickMode(false);
      setNotice('Keseimbangan putih diatur dari titik yang dipilih.');
    } catch {
      setError('Tidak bisa membaca warna dari titik itu.');
    }
  }

  /* ---- save to gallery / download ---- */
  async function handleSave() {
    if (!active || !params || saving) return;
    setSaving(true);
    setNotice('Menyimpan Full HD…');
    try {
      const res = await api.exportHighRes(active.id, params, format === 'webp' ? 'image/webp' : 'image/jpeg');
      if (res.gallerySaved) {
        setNotice('Tersimpan di Galeri HP (album FreeColor).');
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
        setNotice(`Foto diunduh (${(res.sizeBytes / 1024 / 1024).toFixed(2)} MB).`);
      }
    } catch (err) {
      setError('Gagal menyimpan: ' + (err.message || err));
    } finally {
      setSaving(false);
    }
  }

  const mode = holdBefore ? 'before' : viewMode;
  const modified = active && params && Object.keys(GRADE_DEFAULTS).some((k) => k !== 'splitShadowHue' && k !== 'splitHighHue' && Math.abs((params[k] ?? GRADE_DEFAULTS[k]) - GRADE_DEFAULTS[k]) > 1e-3);

  /* ------------------------------------------------------------ panels */
  const renderSliders = (items) =>
    items.map((it) => (
      <Slider
        key={it.key}
        item={it}
        value={val(it.key)}
        onChange={(v) => setKey(it.key, v)}
        onReset={() => {
          resetKey(it.key);
          commitParams({ ...params, [it.key]: active?.auto?.[it.key] ?? GRADE_DEFAULTS[it.key] ?? 0 });
        }}
        onCommit={() => commitParams(params)}
      />
    ));

  const band = HSL_BANDS.find((b) => b.id === hslBand);
  const cvCh = CURVE_CHANNELS.find((c) => c.id === curveCh);
  const cv = (s) => val(`cv_${curveCh}_${s}`);

  return (
    <div
      className="app"
      onDragEnter={(e) => { e.preventDefault(); dragDepth.current += 1; setDrop(true); }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDrop(false); }}
      onDrop={(e) => { e.preventDefault(); dragDepth.current = 0; setDrop(false); uploadFiles(e.dataTransfer?.files); }}
    >
      {/* ------------------------------------------------ header */}
      <header className="bar">
        <div className="brand">
          <span className="brand-logo"><Icon name="wave" /></span>
          <b>FreeColor</b>
        </div>
        <div className="bar-actions">
          {active && (
            <>
              <div className="seg" role="group" aria-label="Mode tampilan">
                <button className={mode === 'split' ? 'on' : ''} onClick={() => setViewMode('split')}>Belah</button>
                <button className={mode === 'after' ? 'on' : ''} onClick={() => setViewMode('after')}>Hasil</button>
                <button
                  className={mode === 'before' ? 'on' : ''}
                  onPointerDown={() => setHoldBefore(true)}
                  onPointerUp={() => setHoldBefore(false)}
                  onPointerLeave={() => setHoldBefore(false)}
                  title="Tahan untuk melihat foto asli"
                >Asli</button>
              </div>

              <div className="history-group">
                <button
                  className="icon-btn"
                  onClick={undo}
                  disabled={historyIndex <= 0}
                  title="Urungkan (Undo)"
                  aria-label="Undo"
                >
                  <Icon name="undo" />
                </button>
                <button
                  className="icon-btn"
                  onClick={redo}
                  disabled={historyIndex >= history.length - 1}
                  title="Ulangi (Redo)"
                  aria-label="Redo"
                >
                  <Icon name="redo" />
                </button>
                <button
                  className="icon-btn"
                  onClick={handleRotate}
                  title="Putar 90°"
                  aria-label="Putar 90 derajat"
                >
                  <Icon name="rotate" />
                </button>
                <button
                  className="icon-btn hide-sm"
                  onClick={toggleFullscreen}
                  title="Layar Penuh"
                  aria-label="Layar penuh"
                >
                  <Icon name="fullscreen" />
                </button>
              </div>
            </>
          )}

          <button className="btn btn-soft" onClick={() => inputRef.current?.click()} title="Tambah foto">
            <Icon name="plus" /><span className="hide-sm">Foto</span>
          </button>
          {active && (
            <button className="btn btn-primary" onClick={handleSave} disabled={saving} title="Simpan Full HD">
              <Icon name="save" /><span>{saving ? 'Menyimpan…' : 'Simpan'}</span>
            </button>
          )}
        </div>
      </header>

      {/* ------------------------------------------------ empty */}
      {!assets.length ? (
        <main className="empty">
          <div className={`hero ${drop ? 'drag' : ''}`} onClick={() => inputRef.current?.click()}>
            <div className="hero-orb"><Icon name="wave" /></div>
            <h1>FreeColor</h1>
            <p>Editor foto bawah air dengan Vision AI cerdas. Pulihkan merah, jernihkan air, atur warna profesional langsung di perangkat tanpa perlu API key.</p>
            <button className="btn btn-primary btn-lg">Buka Foto</button>
            <ul className="hero-tags">
              <li>✨ Vision AI Auto Grading</li>
              <li>🌊 Look Bawah Air</li>
              <li>🎨 Kurva RGB & HSL</li>
              <li>📱 Full HD Langsung ke Galeri HP</li>
            </ul>
            {error && <p className="err-inline">{error}</p>}
          </div>
        </main>
      ) : (
        <main className="work">
          {/* ---------------------------------------------- stage */}
          <section className="stage-col">
            <div className="stage">
              {active && (
                <Compare
                  before={active.beforeUrl}
                  after={afterUrl || undefined}
                  initial={50}
                  viewMode={mode}
                  beforeLabel="ASLI"
                  afterLabel="HASIL"
                />
              )}
              {pickMode && (
                <div className="pick-layer" onClick={onPick} role="button" aria-label="Pilih titik netral">
                  <div className="pick-banner">
                    <span className="pick-hint">Ketuk area yang seharusnya putih / abu-abu (pasir, alat selam)</span>
                    <button
                      className="btn btn-soft btn-cancel-pick"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPickMode(false);
                      }}
                    >
                      Batal
                    </button>
                  </div>
                </div>
              )}
              {renderMs != null && !aiPhase && <div className="badge-ms">{renderMs} ms</div>}

              {/* Enchanting Magic Vision AI Scanner Overlay */}
              {aiPhase && (
                <div className="ai-magic-scanner" role="status" aria-live="polite">
                  <div className="ai-laser-beam" />
                  <div className="ai-sonar-ring" />
                  <div className="ai-hud-card">
                    <div className="ai-hud-header">
                      <span className="ai-sparkle-orb"><Icon name="sparkle" /></span>
                      <div>
                        <b>VISION AI IDENTIFIKASI</b>
                        <small>Analisa Spektrum Optik Bawah Air</small>
                      </div>
                    </div>
                    <p className="ai-hud-phase">{aiPhase}</p>
                    <div className="ai-hud-tags">
                      <span>Spektrum Merah</span>
                      <span>Kedalaman</span>
                      <span>Dehaze</span>
                      <span>Biota & Karang</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="strip">
              {assets.map((a) => (
                <div
                  key={a.id}
                  className={`thumb ${a.id === activeId ? 'on' : ''}`}
                  onClick={() => setActiveId(a.id)}
                  title={a.name}
                  role="button"
                  tabIndex={0}
                >
                  <img src={a.thumbUrl} alt={a.name} />
                  <button
                    className="thumb-x"
                    aria-label={`Hapus ${a.name}`}
                    title="Tutup / Hapus foto"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeAsset(a.id);
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button className="thumb-add" onClick={() => inputRef.current?.click()} aria-label="Tambah foto">+</button>
            </div>
          </section>

          {/* ---------------------------------------------- panel */}
          <aside className="panel">
            <nav className="tabs" aria-label="Menu pengeditan">
              {TABS.map((t) => (
                <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>{t.label}</button>
              ))}
            </nav>

            <div className="panel-body">
              {tab === 'look' && (
                <>
                  <div className="card card-ai-glow">
                    <button
                      className="btn btn-primary btn-block btn-lg"
                      onClick={() => runAiGrading()}
                      disabled={!active || Boolean(aiPhase)}
                    >
                      <Icon name="sparkle" /> {aiPhase ? 'AI Sedang Mengidentifikasi…' : 'AI Auto Grading'}
                    </button>
                    <p className="note">Vision AI menganalisa spektrum warna air & mengoreksi foto secara otomatis langsung di perangkat.</p>
                    <Slider
                      item={{ label: 'Kekuatan Look', min: 0, max: 150, unit: '%' }}
                      value={intensity}
                      onChange={(v) => scaleIntensity(v)}
                      onReset={() => scaleIntensity(100)}
                      onCommit={() => commitParams(params)}
                    />
                  </div>

                  <h3 className="h">Look Bawah Air</h3>
                  <div className="looks">
                    {LOOKS.map((l) => (
                      <button key={l.id} className={`look ${params?.preset === l.id ? 'on' : ''}`} onClick={() => applyLook(l.id)}>
                        <i style={{ background: l.color }} />
                        <span><b>{l.name}</b><small>{l.tag}</small></span>
                        <em>{l.desc}</em>
                      </button>
                    ))}
                  </div>

                  {active?.condition && (
                    <div className="card">
                      <div className="row-between">
                        <h3 className="h h-tight">Identifikasi Vision AI</h3>
                        <span className="badge-ai">✓ Akurasi Tinggi</span>
                      </div>
                      <div className="chips">
                        <span><b>Perairan</b>{active.condition.cast === 'turkis' ? 'Tropis Dangkal' : active.condition.cast === 'hijau' ? 'Air Hijau / Keruh' : 'Samudra Biru'}</span>
                        <span><b>Defisit Merah</b>−{active.condition.redLoss}%</span>
                        <span><b>Kejernihan Air</b>{active.condition.haze === 'tinggi' ? 'Kabut Tebal (Dehaze Aktif)' : 'Bening'}</span>
                        <span><b>Detail Optik</b>{active.condition.detail === 'lembut' ? 'Tekstur Dihaluskan' : '3D Tajam'}</span>
                      </div>
                    </div>
                  )}
                </>
              )}

              {tab === 'warna' && (
                <>
                  <div className="card">
                    <div className="row-between">
                      <h3 className="h h-tight">Keseimbangan Putih</h3>
                      {(val('wbR') !== 1 || val('wbG') !== 1 || val('wbB') !== 1) && (
                        <button className="link" onClick={() => {
                          const resetWb = { wbR: 1, wbG: 1, wbB: 1 };
                          setMany(resetWb);
                          commitParams({ ...params, ...resetWb });
                        }}>Reset</button>
                      )}
                    </div>
                    <button className={`btn btn-block ${pickMode ? 'btn-primary' : 'btn-soft'}`} onClick={() => setPickMode((v) => !v)}>
                      <Icon name="pick" /> {pickMode ? 'Ketuk foto untuk memilih titik netral…' : 'Pipet Titik Netral'}
                    </button>
                    <p className="note">Pilih pasir putih, alat selam, atau bagian abu-abu agar cast warna air hilang.</p>
                  </div>
                  <div className="group">{renderSliders(WARNA)}</div>
                  <h3 className="h">Pemulihan Bawah Air</h3>
                  <div className="group">{renderSliders(PULIH)}</div>
                </>
              )}

              {tab === 'cahaya' && (
                <>
                  <div className="group">{renderSliders(CAHAYA)}</div>
                  <h3 className="h">Gradasi Linear</h3>
                  <div className="group">{renderSliders(GRADASI)}</div>
                </>
              )}

              {tab === 'hsl' && (
                <>
                  <div className="swatches" role="tablist" aria-label="Pita warna">
                    {HSL_BANDS.map((b) => (
                      <button key={b.id} role="tab" aria-selected={hslBand === b.id} className={hslBand === b.id ? 'on' : ''} style={{ '--c': b.color }} onClick={() => setHslBand(b.id)} title={b.label}>
                        <i />
                        <span>{b.label}</span>
                      </button>
                    ))}
                  </div>
                  <div className="group">
                    <Slider item={S(`hsl_${hslBand}_h`, `Rona ${band.label}`, -100, 100)} value={val(`hsl_${hslBand}_h`)} onChange={(v) => setKey(`hsl_${hslBand}_h`, v)} onReset={() => setKey(`hsl_${hslBand}_h`, 0)} onCommit={() => commitParams(params)} />
                    <Slider item={S(`hsl_${hslBand}_s`, `Saturasi ${band.label}`, -100, 100)} value={val(`hsl_${hslBand}_s`)} onChange={(v) => setKey(`hsl_${hslBand}_s`, v)} onReset={() => setKey(`hsl_${hslBand}_s`, 0)} onCommit={() => commitParams(params)} />
                    <Slider item={S(`hsl_${hslBand}_l`, `Luminans ${band.label}`, -100, 100)} value={val(`hsl_${hslBand}_l`)} onChange={(v) => setKey(`hsl_${hslBand}_l`, v)} onReset={() => setKey(`hsl_${hslBand}_l`, 0)} onCommit={() => commitParams(params)} />
                  </div>
                  <button className="link" onClick={() => {
                    const resetHsl = Object.fromEntries(HSL_BANDS.flatMap((b) => ['h', 's', 'l'].map((c) => [`hsl_${b.id}_${c}`, 0])));
                    setMany(resetHsl);
                    commitParams({ ...params, ...resetHsl });
                  }}>Reset semua pita HSL</button>
                </>
              )}

              {tab === 'kurva' && (
                <>
                  <div className="swatches swatches-4">
                    {CURVE_CHANNELS.map((c) => (
                      <button key={c.id} className={curveCh === c.id ? 'on' : ''} style={{ '--c': c.color }} onClick={() => setCurveCh(c.id)}>
                        <i /><span>{c.label}</span>
                      </button>
                    ))}
                  </div>
                  <div className="curve-box">
                    <svg viewBox="-4 -4 108 108" className="curve" aria-label="Grafik kurva">
                      <rect x="0" y="0" width="100" height="100" fill="#f4f9fd" stroke="#d6e6f2" />
                      {[25, 50, 75].map((g) => (
                        <g key={g} stroke="#dbe9f4" strokeWidth="0.6">
                          <line x1={g} y1="0" x2={g} y2="100" />
                          <line x1="0" y1={g} x2="100" y2="0" />
                        </g>
                      ))}
                      <line x1="0" y1="100" x2="100" y2="0" stroke="#b9cfe0" strokeDasharray="3 3" strokeWidth="0.8" />
                      {CURVE_CHANNELS.filter((c) => c.id !== curveCh).map((c) => {
                        const s = val(`cv_${c.id}_s`), m = val(`cv_${c.id}_m`), h = val(`cv_${c.id}_h`);
                        return s || m || h ? <path key={c.id} d={curvePath(s, m, h)} fill="none" stroke={c.color} strokeOpacity="0.35" strokeWidth="1.2" /> : null;
                      })}
                      <path d={curvePath(cv('s'), cv('m'), cv('h'))} fill="none" stroke={cvCh.color} strokeWidth="2.2" strokeLinecap="round" />
                      {[[25, cv('s')], [50, cv('m')], [75, cv('h')]].map(([x, o]) => (
                        <circle key={x} cx={x} cy={100 - (x + o * 0.3)} r="2.8" fill="#fff" stroke={cvCh.color} strokeWidth="1.6" />
                      ))}
                    </svg>
                  </div>
                  <div className="group">
                    <Slider item={S('s', 'Bayangan', -50, 50)} value={cv('s')} onChange={(v) => setKey(`cv_${curveCh}_s`, v)} onReset={() => setKey(`cv_${curveCh}_s`, 0)} onCommit={() => commitParams(params)} />
                    <Slider item={S('m', 'Tengah', -50, 50)} value={cv('m')} onChange={(v) => setKey(`cv_${curveCh}_m`, v)} onReset={() => setKey(`cv_${curveCh}_m`, 0)} onCommit={() => commitParams(params)} />
                    <Slider item={S('h', 'Sorotan', -50, 50)} value={cv('h')} onChange={(v) => setKey(`cv_${curveCh}_h`, v)} onReset={() => setKey(`cv_${curveCh}_h`, 0)} onCommit={() => commitParams(params)} />
                  </div>
                  <button className="link" onClick={() => {
                    const resetCv = { [`cv_${curveCh}_s`]: 0, [`cv_${curveCh}_m`]: 0, [`cv_${curveCh}_h`]: 0 };
                    setMany(resetCv);
                    commitParams({ ...params, ...resetCv });
                  }}>Reset kurva {cvCh.label}</button>
                </>
              )}

              {tab === 'detail' && (
                <>
                  <div className="group">{renderSliders(DETAIL)}</div>
                  <h3 className="h">Split Toning</h3>
                  <div className="group">{renderSliders(SPLIT)}</div>
                </>
              )}

              {tab === 'simpan' && (
                <div className="card">
                  <h3 className="h h-tight">Simpan Foto</h3>
                  <div className="formats">
                    <button className={format === 'jpeg' ? 'on' : ''} onClick={() => setFormat('jpeg')}><b>JPG</b><small>Semua galeri</small></button>
                    <button className={format === 'webp' ? 'on' : ''} onClick={() => setFormat('webp')}><b>WEBP</b><small>Lebih kecil</small></button>
                  </div>
                  <dl className="specs">
                    <div><dt>Resolusi</dt><dd>Full HD (maks. 1920 px)</dd></div>
                    <div><dt>Ukuran file</dt><dd>≤ 2 MB</dd></div>
                    <div><dt>Tujuan</dt><dd>Galeri HP · album FreeColor</dd></div>
                  </dl>
                  <button className="btn btn-primary btn-block btn-lg" onClick={handleSave} disabled={saving || !active}>
                    <Icon name="save" /> {saving ? 'Menyimpan…' : 'Simpan Full HD'}
                  </button>
                </div>
              )}
            </div>

            <footer className="panel-foot">
              <button className="link" onClick={resetAll} disabled={!modified && intensity === 100}>Reset semua</button>
              <span>{modified ? 'Ada perubahan manual' : 'Sesuai AI Auto Grading'}</span>
            </footer>
          </aside>
        </main>
      )}

      {error && assets.length > 0 && (
        <div className="toast toast-err" role="alert">{error}<button onClick={() => setError('')} aria-label="Tutup">×</button></div>
      )}
      {notice && <div className="toast" role="status">{notice}</div>}
      {drop && <div className="drop-veil">Lepas untuk membuka foto</div>}

      <input
        ref={inputRef}
        type="file"
        accept="image/*,.heic,.heif,.avif"
        multiple
        hidden
        onChange={(e) => { uploadFiles(e.target.files); e.target.value = ''; }}
      />
    </div>
  );
}
