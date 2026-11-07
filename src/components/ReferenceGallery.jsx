import { useMemo, useRef, useState } from 'react';
import { api } from '../api.js';

function isImage(file) {
  if (!file) return false;
  if (String(file.type || '').toLowerCase().startsWith('image/')) return true;
  return /\.(heic|heif|avif|jpe?g|png|webp|bmp|gif|tiff?)$/i.test(String(file.name || ''));
}

function rgb(arr) {
  if (!Array.isArray(arr)) return 'transparent';
  // Ratios are normalised (sum = 1); scale so the brightest channel reads well.
  const mx = Math.max(...arr, 1);
  const k = 235 / mx;
  return `rgb(${Math.round(arr[0] * k)}, ${Math.round(arr[1] * k)}, ${Math.round(arr[2] * k)})`;
}

const FILTERS = [
  { id: 'all', label: 'Semua' },
  { id: 'on', label: 'Dipakai' },
  { id: 'off', label: 'Tidak dipakai' },
];

/**
 * Full-screen reference library. The owner drops in as many favourite photos
 * as he likes; every active photo feeds the blended "Gaya Galeri".
 */
export default function ReferenceGallery({ items, style, limit = 600, usingGallery, onUseGallery, onClose, onChanged }) {
  const [filter, setFilter] = useState('all');
  const [progress, setProgress] = useState(null); // { done, total, failed }
  const [drop, setDrop] = useState(false);
  const [view, setView] = useState(null);
  const [error, setError] = useState('');
  const inputRef = useRef(null);
  const depth = useRef(0);

  const activeCount = items.filter((r) => r.active).length;
  const shown = useMemo(
    () => items.filter((r) => (filter === 'on' ? r.active : filter === 'off' ? !r.active : true)),
    [items, filter]
  );

  async function uploadMany(fileList) {
    const files = Array.from(fileList || []).filter(isImage);
    if (!files.length) return;
    setError('');
    const state = { done: 0, total: files.length, failed: 0 };
    setProgress({ ...state });
    let latest = { items, style };
    // Two uploads at a time keeps the server responsive while still being quick.
    const queue = files.slice();
    const worker = async () => {
      while (queue.length) {
        const file = queue.shift();
        try {
          const res = await api.uploadReference(file, file.name);
          latest = {
            items: [res.item, ...latest.items.filter((r) => r.id !== res.item.id)],
            style: res.style ?? latest.style,
          };
          onChanged(latest);
        } catch (err) {
          state.failed += 1;
          setError(err.message);
        }
        state.done += 1;
        setProgress({ ...state });
      }
    };
    await Promise.all([worker(), worker()]);
    setTimeout(() => setProgress(null), 1800);
  }

  async function toggle(ref) {
    try {
      const res = await api.updateReference(ref.id, { active: !ref.active });
      onChanged({ items: items.map((r) => (r.id === ref.id ? res.item : r)), style: res.style });
    } catch (err) {
      setError(err.message);
    }
  }

  async function setAll(active) {
    try {
      const res = await api.bulkReferences(active);
      onChanged({ items: res.items, style: res.style });
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove(ref) {
    if (!window.confirm(`Hapus "${ref.name}" dari galeri referensi?`)) return;
    try {
      const res = await api.deleteReference(ref.id);
      onChanged({ items: items.filter((r) => r.id !== ref.id), style: res.style ?? null });
      if (view?.id === ref.id) setView(null);
    } catch (err) {
      setError(err.message);
    }
  }

  const sLook = style?.look;

  return (
    <div
      className="rg"
      onDragEnter={(e) => {
        e.preventDefault();
        depth.current += 1;
        setDrop(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setDrop(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        depth.current = 0;
        setDrop(false);
        uploadMany(e.dataTransfer?.files);
      }}
    >
      <header className="rg-top">
        <div>
          <h2>Galeri Referensi</h2>
          <p>
            {items.length} foto · {activeCount} dipakai sebagai acuan gaya · maks {limit}
          </p>
        </div>
        <div className="rg-top-actions">
          <button className="btn btn-solid" onClick={() => inputRef.current?.click()} disabled={Boolean(progress && progress.done < progress.total)}>
            + Unggah Referensi
          </button>
          <button className="modal-x" onClick={onClose} aria-label="Tutup galeri">
            ×
          </button>
        </div>
      </header>

      <section className="rg-style">
        <div className="rg-style-info">
          <h3>Gaya Galeri</h3>
          {sLook ? (
            <>
              <p>
                Gabungan (median) dari {sLook.count || activeCount} foto aktif. Dipakai otomatis ke setiap foto yang Anda olah.
              </p>
              <div className="rg-swatches">
                <span className="rg-sw">
                  <i style={{ background: rgb(sLook.water?.ratio) }} />
                  Air · {sLook.water?.hueLabel} {sLook.water?.hue != null ? `${sLook.water.hue}°` : ''}
                </span>
                {sLook.warm && (
                  <span className="rg-sw">
                    <i style={{ background: rgb(sLook.warm.ratio) }} />
                    Karang/Kulit · {sLook.warm.hue}°
                  </span>
                )}
                {sLook.tone && (
                  <span className="rg-sw plain">
                    Saturasi {Math.round(sLook.tone.sat * 100)} · Kontras {Math.round(sLook.tone.contrast * 100)}
                  </span>
                )}
              </div>
            </>
          ) : (
            <p>Belum ada foto aktif. Unggah foto-foto favorit Anda; gaya warnanya akan dipelajari otomatis.</p>
          )}
        </div>
        <div className="rg-style-actions">
          <button
            className={`btn ${usingGallery ? 'btn-solid' : ''}`}
            onClick={onUseGallery}
            disabled={!sLook}
            title="Pakai gaya galeri untuk foto yang sedang diedit"
          >
            {usingGallery ? '✓ Gaya Galeri Dipakai' : 'Pakai Gaya Galeri'}
          </button>
        </div>
      </section>

      <div className="rg-bar">
        <div className="seg seg-compact">
          {FILTERS.map((f) => (
            <button key={f.id} className={filter === f.id ? 'on' : ''} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        <div className="rg-bar-right">
          {progress && (
            <span className="rg-progress">
              Mengunggah {progress.done}/{progress.total}
              {progress.failed ? ` · ${progress.failed} gagal` : ''}
              <i style={{ width: `${(progress.done / progress.total) * 100}%` }} />
            </span>
          )}
          {items.length > 0 && (
            <>
              <button className="link-btn" onClick={() => setAll(true)}>Pakai semua</button>
              <button className="link-btn" onClick={() => setAll(false)}>Lepas semua</button>
            </>
          )}
        </div>
      </div>

      {error && (
        <p className="rg-error">
          {error} <button onClick={() => setError('')}>×</button>
        </p>
      )}

      {items.length === 0 ? (
        <div className={`rg-empty dropzone ${drop ? 'on' : ''}`} onClick={() => inputRef.current?.click()}>
          <h3>Tarik-lepas foto referensi di sini</h3>
          <p>Bisa banyak sekaligus · JPG, PNG, WEBP, HEIC</p>
          <span className="btn btn-solid">Pilih Foto</span>
        </div>
      ) : (
        <div className="rg-grid">
          {shown.map((r) => (
            <figure key={r.id} className={`rg-card ${r.active ? 'on' : 'off'}`}>
              <button className="rg-img" onClick={() => setView(r)} title="Lihat besar">
                <img src={r.thumbUrl} alt={r.name} loading="lazy" />
              </button>
              <figcaption>
                <span className="rg-name" title={r.name}>{r.name}</span>
                <span className="rg-meta">
                  <i style={{ background: rgb(r.look?.water?.ratio) }} />
                  {r.look?.water?.source === 'foto' ? r.look.water.hueLabel : 'tanpa air'}
                </span>
                <div className="rg-card-actions">
                  <label className="rg-toggle">
                    <input type="checkbox" checked={r.active} onChange={() => toggle(r)} />
                    <span>{r.active ? 'Dipakai' : 'Tidak'}</span>
                  </label>
                  <button className="rg-del" onClick={() => remove(r)} aria-label={`Hapus ${r.name}`}>
                    Hapus
                  </button>
                </div>
              </figcaption>
            </figure>
          ))}
          <button className="rg-add" onClick={() => inputRef.current?.click()}>
            <b>+</b>
            <span>Tambah</span>
          </button>
        </div>
      )}

      {drop && items.length > 0 && <div className="drop-veil">Lepas untuk menambah referensi</div>}

      {view && (
        <div className="rg-view" onClick={() => setView(null)}>
          <img src={view.viewUrl} alt={view.name} />
          <div className="rg-view-bar" onClick={(e) => e.stopPropagation()}>
            <b>{view.name}</b>
            <span>
              Air {view.look?.water?.hueLabel || '—'}
              {view.look?.tone ? ` · Saturasi ${Math.round(view.look.tone.sat * 100)} · Kontras ${Math.round(view.look.tone.contrast * 100)}` : ''}
            </span>
            <button className="btn btn-sm" onClick={() => setView(null)}>Tutup</button>
          </div>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/*,.heic,.heif,.avif"
        multiple
        hidden
        onChange={(e) => {
          uploadMany(e.target.files);
          e.target.value = '';
        }}
      />
    </div>
  );
}
