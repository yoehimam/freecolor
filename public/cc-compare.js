/*! Nordrift Underwater Color Correction · before/after compare · © 2026 Nordrift / Jonas Jensen. All rights reserved. */
// Makes every .cmp element draggable anywhere on its surface (pointer), keeps the
// hidden range input for keyboard users, and plays a short idle sweep on elements
// with data-idle until the user touches them.
(() => {
'use strict';
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
document.querySelectorAll('.cmp').forEach(cmp => {
  const range = cmp.querySelector('.cmp-range');
  let touched = false;
  const set = v => { v = Math.max(0, Math.min(100, v)); cmp.style.setProperty('--pos', v + '%'); if (range) range.value = Math.round(v); };
  const fromEvent = e => { const r = cmp.getBoundingClientRect(); return (e.clientX - r.left) / r.width * 100; };
  let dragging = false;
  cmp.addEventListener('pointerdown', e => {
    if (e.button !== undefined && e.button !== 0) return;
    if (cmp.classList.contains('live')) return;
    dragging = true; touched = true; cmp.setPointerCapture(e.pointerId); set(fromEvent(e)); e.preventDefault();
  });
  cmp.addEventListener('pointermove', e => { if (dragging) set(fromEvent(e)); });
  const stop = e => { if (dragging) { dragging = false; try { cmp.releasePointerCapture(e.pointerId); } catch (_) { } } };
  cmp.addEventListener('pointerup', stop); cmp.addEventListener('pointercancel', stop);
  if (range) {
    range.addEventListener('input', () => { touched = true; cmp.style.setProperty('--pos', range.value + '%'); });
    range.addEventListener('focus', () => { touched = true; });
    range.setAttribute('tabindex', '0');
  }
  if (cmp.dataset.idle !== undefined && !reduce) {
    let t = 0; const base = parseFloat(getComputedStyle(cmp).getPropertyValue('--pos')) || 55;
    const idle = () => { if (touched) return; t += 0.012; set(base + Math.sin(t) * 18); if (t < 6.3) requestAnimationFrame(idle); else set(base); };
    const io = new IntersectionObserver(es => { if (es[0].isIntersecting) { io.disconnect(); requestAnimationFrame(idle); } }, { threshold: 0.4 });
    io.observe(cmp);
  }
});
// FAQ: the whole box toggles, not just the summary line.
document.querySelectorAll('.faq details').forEach(d => {
  d.addEventListener('click', e => { if (e.target.closest('summary') || e.target.closest('a')) return; d.open = !d.open; });
});
})();
