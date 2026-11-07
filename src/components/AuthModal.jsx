import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

export default function AuthModal({ open, mode = 'register', onClose, onDone }) {
  const [tab, setTab] = useState(mode);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const firstField = useRef(null);

  useEffect(() => {
    if (open) {
      setTab(mode);
      setError('');
      setTimeout(() => firstField.current?.focus(), 40);
    }
  }, [open, mode]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const data =
        tab === 'register'
          ? await api.register(name, email, password)
          : await api.login(email, password);
      onDone(data.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Masuk atau daftar">
      <button className="modal-backdrop" aria-label="Tutup" onClick={onClose} />
      <div className="modal-card">
        <button className="modal-x" onClick={onClose} aria-label="Tutup">×</button>

        <p className="eyebrow">AKUN FREECOLOR</p>
        <h2 className="modal-title">{tab === 'register' ? 'Bikin akun, gratis.' : 'Masuk lagi.'}</h2>
        <p className="modal-sub">
          {tab === 'register'
            ? 'Arsip foto, riwayat olahan, dan unduhan 4K tanpa batas coba.'
            : 'Lanjut olah foto dan buka arsipmu.'}
        </p>

        <div className="modal-tabs">
          <button className={tab === 'register' ? 'on' : ''} onClick={() => { setTab('register'); setError(''); }}>Daftar</button>
          <button className={tab === 'login' ? 'on' : ''} onClick={() => { setTab('login'); setError(''); }}>Masuk</button>
        </div>

        <form onSubmit={submit} className="modal-form">
          {tab === 'register' && (
            <label>
              Nama panggilan
              <input
                ref={firstField}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Mau dipanggil apa?"
                autoComplete="name"
                maxLength={50}
              />
            </label>
          )}
          <label>
            Email
            <input
              ref={tab === 'login' ? firstField : undefined}
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="kamu@email.com"
              autoComplete="email"
            />
          </label>            <label>
              Kata sandi
              <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Minimal 8 karakter"
              autoComplete={tab === 'register' ? 'new-password' : 'current-password'}
            />
          </label>

          {error && <p className="form-error">{error}</p>}

          <button className="btn btn-solid btn-block" type="submit" disabled={busy}>
            {busy ? 'Sebentar…' : tab === 'register' ? 'Buat akun & mulai' : 'Masuk'}
          </button>
        </form>

        <p className="modal-foot">
          Dengan lanjut, kamu setuju Syarat Layanan dan Privasi FreeColor.
        </p>
      </div>
    </div>
  );
}
