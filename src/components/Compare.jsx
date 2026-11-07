import { useEffect, useRef, useState } from 'react';

export default function Compare({
  before,
  after,
  beforeLabel = 'ASLI',
  afterLabel = 'HASIL',
  initial = 50,
  viewMode = 'split',
  className = '',
  children,
}) {
  const [pos, setPos] = useState(initial);
  const wrap = useRef(null);
  const isDragging = useRef(false);

  // If after is not ready yet, keep displaying before so there is zero black/empty flicker
  const effectiveAfter = after || before;
  const effectivePos = viewMode === 'after' ? 0 : viewMode === 'before' ? 100 : pos;

  const updatePosFromClientX = (clientX) => {
    if (viewMode !== 'split') return;
    const el = wrap.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (!rect.width) return;
    const nextPct = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
    setPos(nextPct);
  };

  const onPointerDownKnob = (e) => {
    if (viewMode !== 'split') return;
    e.stopPropagation();
    isDragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e) => {
    if (!isDragging.current) return;
    e.preventDefault();
    updatePosFromClientX(e.clientX);
  };

  const onPointerUp = (e) => {
    if (isDragging.current) {
      isDragging.current = false;
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    }
  };

  const onContainerClick = (e) => {
    // Single tap to position the divider
    if (viewMode !== 'split' || isDragging.current) return;
    updatePosFromClientX(e.clientX);
  };

  return (
    <div
      ref={wrap}
      className={`cmp ${viewMode !== 'split' ? 'cmp-single' : ''} ${className}`}
      onClick={onContainerClick}
      role="group"
      aria-label="Perbandingan foto asli dan hasil"
    >
      {/* Before Image (Base Layer) */}
      {before ? (
        <img className="cmp-img" src={before} alt={beforeLabel} draggable="false" />
      ) : (
        <div className="cmp-img cmp-ph" />
      )}

      {/* After Image (Clipped Overlay Layer) */}
      {effectiveAfter && (
        <div className="cmp-layer" style={{ clipPath: `inset(0 0 0 ${effectivePos}%)` }}>
          <img className="cmp-img" src={effectiveAfter} alt={afterLabel} draggable="false" />
        </div>
      )}

      {/* Floating Labels */}
      {viewMode !== 'after' && <span className="cmp-tag cmp-tag-l">{beforeLabel}</span>}
      {effectiveAfter && viewMode !== 'before' && <span className="cmp-tag cmp-tag-r">{afterLabel}</span>}

      {/* Split Divider & Touchable Knob */}
      {viewMode === 'split' && (
        <div
          className="cmp-divider"
          style={{ left: `${pos}%` }}
          onPointerDown={onPointerDownKnob}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div
            className="cmp-knob"
            role="slider"
            tabIndex={0}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(pos)}
            aria-label="Geser garis pembanding sebelum dan sesudah"
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft') {
                e.preventDefault();
                setPos((p) => Math.max(0, p - 5));
              } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                setPos((p) => Math.min(100, p + 5));
              }
            }}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path d="M8 6 3 12l5 6M16 6l5 6-5 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        </div>
      )}

      {children}
    </div>
  );
}
