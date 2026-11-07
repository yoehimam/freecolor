import { useCallback, useEffect, useState } from 'react';
import Landing from './components/Landing.jsx';
import Editor from './components/Editor.jsx';
import AuthModal from './components/AuthModal.jsx';
import { api } from './api.js';

export default function App() {
  const [route, setRoute] = useState(() => window.location.pathname);
  const [user, setUser] = useState(null);
  const [demoMode, setDemoMode] = useState(true);
  const [auth, setAuth] = useState({ open: false, mode: 'register' });
  const [lang, setLang] = useState(() => localStorage.getItem('fc_lang') || 'id');

  useEffect(() => {
    const onPop = () => setRoute(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    api
      .me()
      .then((d) => {
        setUser(d.user || null);
        if (typeof d.demoMode === 'boolean') setDemoMode(d.demoMode);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
    localStorage.setItem('fc_lang', lang);
  }, [lang]);

  const go = useCallback((path) => {
    window.history.pushState({}, '', path);
    setRoute(path);
    window.scrollTo({ top: 0 });
  }, []);

  const openAuth = (mode = 'register') => {
    if (demoMode) return;
    setAuth({ open: true, mode });
  };
  const closeAuth = () => setAuth((a) => ({ ...a, open: false }));

  const handleLogout = async () => {
    try {
      await api.logout();
    } catch {
      /* session might already be gone */
    }
    setUser(null);
    go('/');
  };

  // Selama Mode Demo aktif, lewati Landing Page dan langsung masuk ke Studio Editor
  // (tanpa menghapus komponen Landing agar bisa diaktifkan kembali saat rilis penuh).
  const isEditor = demoMode || route.startsWith('/app');

  return (
    <>
      {isEditor ? (
        <Editor
          user={user}
          demoMode={demoMode}
          onAuth={() => openAuth('register')}
          onHome={() => go('/')}
          onLogout={handleLogout}
          lang={lang}
        />
      ) : (
        <Landing
          lang={lang}
          setLang={setLang}
          user={user}
          demoMode={demoMode}
          onStart={() => go('/app')}
          onAuth={() => openAuth('login')}
        />
      )}

      {!demoMode && (
        <AuthModal open={auth.open} mode={auth.mode} onClose={closeAuth} onDone={(u) => { setUser(u); closeAuth(); go('/app'); }} />
      )}
    </>
  );
}
