import { useEffect, useRef, useState } from 'react';

const Arrow = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
    <path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const Cam = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <rect x="2.5" y="6.5" width="19" height="13" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <circle cx="12" cy="13" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <path d="M8 6.5 9.4 4h5.2L16 6.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
  </svg>
);

const Wave = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <path d="M2 14c2.6-2 5.2-2 7.8 0s5.2 2 7.8 0 4.4-2 4.4-2M2 19c2.6-2 5.2-2 7.8 0s5.2 2 7.8 0 4.4-2 4.4-2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

const Frame = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <path d="M3 8V4.5A1.5 1.5 0 0 1 4.5 3H8M16 3h3.5A1.5 1.5 0 0 1 21 4.5V8M21 16v3.5a1.5 1.5 0 0 1-1.5 1.5H16M8 21H4.5A1.5 1.5 0 0 1 3 19.5V16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

export default function Compare({
  before,
  after,
  beforeLabel = 'ASLI',
  afterLabel = 'HASIL',
  initial = 52,
  ratio,
  viewMode = 'split',
  className = '',
  children,
}) {
  const [pos, setPos] = useState(initial);
  const wrap = useRef(null);
  const dragging = useRef(false);

  const effectivePos = viewMode === 'after' ? 0 : viewMode === 'before' ? 100 : pos;

  const setFromClientX = (clientX) => {
    if (viewMode !== 'split') return;
    const el = wrap.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (!rect.width) return;
    setPos(Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100)));
  };

  useEffect(() => {
    const onMove = (e) => {
      if (dragging.current) setFromClientX(e.clientX);
    };
    const onUp = () => {
      dragging.current = false;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [viewMode]);

  const onDown = (e) => {
    if (viewMode !== 'split') return;
    dragging.current = true;
    setFromClientX(e.clientX);
  };

  return (
    <div
      ref={wrap}
      className={`cmp ${viewMode !== 'split' ? 'cmp-single' : ''} ${className}`}
      style={ratio ? { aspectRatio: String(ratio) } : undefined}
      onPointerDown={onDown}
      role="group"
      aria-label="Perbandingan asli dan hasil"
    >
      {before ? (
        <img className="cmp-img" src={before} alt={beforeLabel} draggable="false" />
      ) : (
        <div className="cmp-img cmp-ph" />
      )}

      {after && (
        <div className="cmp-layer" style={{ clipPath: `inset(0 0 0 ${effectivePos}%)` }}>
          <img className="cmp-img" src={after} alt={afterLabel} draggable="false" />
        </div>
      )}

      {viewMode !== 'after' && <span className="cmp-tag cmp-tag-l">{beforeLabel}</span>}
      {after && viewMode !== 'before' && <span className="cmp-tag cmp-tag-r">{afterLabel}</span>}

      {viewMode === 'split' && (
        <div className="cmp-divider" style={{ left: `${pos}%` }}>
          <div
            className="cmp-knob"
            role="slider"
            tabIndex={0}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(pos)}
            aria-label="Geser garis pembanding"
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft') {
                e.preventDefault();
                setPos((p) => Math.max(0, p - 4));
              } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                setPos((p) => Math.min(100, p + 4));
              }
            }}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M9 6 4 12l5 6M15 6l5 6-5 6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        </div>
      )}

      {children}
    </div>
  );
}

export { Arrow, Cam, Wave, Frame };
