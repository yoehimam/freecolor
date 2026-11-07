import { useEffect, useState } from 'react';
import Compare, { Arrow, Cam, Wave, Frame } from './Compare.jsx';

const CONTENT = {
  id: {
    nav: { showcase: 'Bukti', compare: 'Asli vs Hasil', styles: 'Karakter', contact: 'Kontak' },
    cta: { start: 'Mulai olah foto', demo: 'Lihat asli vs hasil', signin: 'Masuk' },
    labels: { before: 'ASLI', after: 'HASIL' },
    hero: {
      eyebrow: 'EDITOR FOTO SELAM · JALAN DI BROWSER',
      lines: ['AIR KERUH', 'JADI', 'BENING'],
      features: ['KAMERA AKSI · GOPRO · DJI', 'KOMPAK · MIRRORLESS · FULL FRAME', 'HASIL 4K · TANPA PASANG APLIKASI'],
      note: '1.200+ penyelam sudah ikut',
    },
    showcase: {
      eyebrow: 'BUKTI',
      title: 'AIR KERUH, HASIL BENING.',
      sub: 'Semua contoh di sini diolah mesin yang sama dengan yang kamu pakai. Geser garisnya, lalu putuskan sendiri.',
    },
    styles: {
      eyebrow: 'KARAKTER',
      title: 'SATU FOTO, EMPAT KARAKTER.',
      sub: 'Bening, Segar, Menyala, Sorot, atau Lomba. Pilih satu, lalu geser garisnya sendiri.',
    },
    steps: {
      eyebrow: 'ALUR',
      title: 'TIGA LANGKAH SAJA.',
      items: [
        { n: '01', h: 'Masukkan', p: 'Tarik-lepas foto JPG, PNG, WEBP, atau HEIC. Paling besar 25 MB, langsung diolah di server.' },
        { n: '02', h: 'Dibaca mesin', p: 'Corak air, partikel, dan kedalaman dibaca dulu, lalu setelan pemulihan dipilih sendiri.' },
        { n: '03', h: 'Ambil hasil', p: 'Geser garis asli-hasil, rapikan lewat setelan, unduh sampai 4K atau simpan ke arsip.' },
      ],
    },
    quotes: {
      eyebrow: 'DARI LAPANGAN',
      title: 'MEREKA YANG MENYELAM.',
      rating: '5.0 · 3 ulasan',
      items: [
        { q: 'Rekaman tamu dari GoPro biasanya hijau semua. Sekarang bisa kami kirim hari itu juga.', n: 'Made Ari', r: 'Dive guide · Nusa Penida' },
        { q: 'Isi merahnya halus, karang tidak jadi neon. Itu yang bikin saya balik lagi.', n: 'Sinta Larasati', r: 'Fotografer makro · Lembeh' },
        { q: 'Empat puluh foto sekali masuk, dua malam ngolah langsung hilang.', n: 'Yosep Kurniawan', r: 'Liveaboard · Raja Ampat' },
      ],
    },
    finalCta: {
      eyebrow: 'LANGSUNG COBA · TANPA DAFTAR',
      title: 'BENINGKAN AIRNYA.',
      sub: 'Masukkan foto bawah air Anda sekarang dan lihat sendiri bedanya secara instan. Air bening, karang hidup.',
    },
    footer: { rights: 'Semua hak dilindungi.', terms: 'Syarat Layanan', privacy: 'Privasi' },
    emptyShowcase: 'Contoh belum dibuat. Jalankan `npm run showcase` untuk menyiapkan pasangan asli-hasil dari foto di folder seed.',
  },
  en: {
    nav: { showcase: 'Proof', compare: 'Original vs Result', styles: 'Characters', contact: 'Contact' },
    cta: { start: 'Edit your shots', demo: 'See original vs result', signin: 'Sign in' },
    labels: { before: 'ORIGINAL', after: 'RESULT' },
    hero: {
      eyebrow: 'UNDERWATER PHOTO EDITOR · RUNS IN YOUR BROWSER',
      lines: ['MURKY', 'TO', 'CLEAR'],
      features: ['ACTION CAM · GOPRO · DJI', 'COMPACT · MIRRORLESS · FULL FRAME', '4K OUT · NOTHING TO INSTALL'],
      note: '1,200+ divers on board',
    },
    showcase: {
      eyebrow: 'PROOF',
      title: 'MURKY WATER, CLEAR RESULT.',
      sub: 'Every sample here ran through the same engine you use. Drag the line and judge for yourself.',
    },
    styles: {
      eyebrow: 'CHARACTERS',
      title: 'ONE PHOTO, FOUR CHARACTERS.',
      sub: 'Clear, Fresh, Vivid or Spotlight. Pick one, then drag the line yourself.',
    },
    steps: {
      eyebrow: 'THE FLOW',
      title: 'THREE STEPS, PERIOD.',
      items: [
        { n: '01', h: 'Drop it in', p: 'Drag a JPG, PNG, WEBP or HEIC. Up to 25 MB, processed right on the server.' },
        { n: '02', h: 'Read by the engine', p: 'Water cast, particles and depth are read first, then the recovery settings pick themselves.' },
        { n: '03', h: 'Take the result', p: 'Drag the original-result line, fine-tune, download up to 4K or keep it in the archive.' },
      ],
    },
    quotes: {
      eyebrow: 'FROM THE FIELD',
      title: 'THE ONES WHO DIVE.',
      rating: '5.0 · 3 reviews',
      items: [
        { q: 'Guest footage from a GoPro is usually all green. Now it goes out the same day.', n: 'Made Ari', r: 'Dive guide · Nusa Penida' },
        { q: 'The red recovery is gentle, coral never turns neon. That is why I came back.', n: 'Sinta Larasati', r: 'Macro photographer · Lembeh' },
        { q: 'Forty photos in one pass, two nights of editing gone.', n: 'Yosep Kurniawan', r: 'Liveaboard · Raja Ampat' },
      ],
    },
    finalCta: {
      eyebrow: 'FIRST PHOTO ON US',
      title: 'CLEAR THE WATER.',
      sub: 'Create a FreeColor account, drop in your first photo, see the difference. Clear water, living coral.',
    },
    footer: { rights: 'All rights reserved.', terms: 'Terms of Service', privacy: 'Privacy' },
    emptyShowcase: 'No samples yet. Run `npm run showcase` to build original-result pairs from the seed folder.',
  },
};

const STYLES = [
  { id: 'alami', label: { id: 'Bening', en: 'Clear' }, note: { id: 'Air apa adanya', en: 'Straight from the water' } },
  { id: 'kreatif', label: { id: 'Segar', en: 'Fresh' }, note: { id: 'Air bening, warna wajar', en: 'Clear water, honest colour' } },
  { id: 'super', label: { id: 'Menyala', en: 'Vivid' }, note: { id: 'Lebih tegas, tetap wajar', en: 'Bolder, still natural' } },
  { id: 'strobe', label: { id: 'Sorot', en: 'Spotlight' }, note: { id: 'Pusat frame paling terang', en: 'Lit centre frame' } },
  { id: 'lomba', label: { id: 'Lomba', en: 'Contest' }, note: { id: 'Netral pasir, sorot diredam', en: 'Neutral sand, soft highlights' } },
];

function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 40 40" width="30" height="30" aria-hidden="true">
      <circle cx="20" cy="15" r="8" fill="none" stroke="currentColor" strokeWidth="2.4" />
      <circle cx="20" cy="15" r="2.4" fill="currentColor" />
      <path d="M4 26c5.3-4 10.6-4 16 0s10.7 4 16 0M4 33c5.3-4 10.6-4 16 0s10.7 4 16 0" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" opacity=".65" />
    </svg>
  );
}

function Stars() {
  return (
    <span className="stars" aria-label="5 dari 5">
      {[0, 1, 2, 3, 4].map((i) => (
        <svg key={i} viewBox="0 0 20 20" width="13" height="13" aria-hidden="true">
          <path d="M10 1.8l2.5 5.2 5.6.8-4.1 4 1 5.6-5-2.7-5 2.7 1-5.6-4.1-4 5.6-.8z" fill="currentColor" />
        </svg>
      ))}
    </span>
  );
}

export default function Landing({ lang, setLang, user, demoMode = true, onStart, onAuth }) {
  const c = CONTENT[lang] || CONTENT.id;
  const [data, setData] = useState({ hero: null, items: [], styleDemo: null });
  const [style, setStyle] = useState('kreatif');
  const [scrolled, setScrolled] = useState(false);
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch('/showcase/showcase.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d) setData({ hero: d.hero || null, items: d.items || [], styleDemo: d.styleDemo || null });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const demo = data.styleDemo;
  const demoAfter = demo?.variants?.[style] || demo?.variants?.kreatif;
  const feats = [<Cam key="c" />, <Frame key="f" />, <Wave key="w" />];

  return (
    <div className="site">
      <header className={`site-head ${scrolled || menu ? 'is-solid' : ''}`}>
        <a className="brand" href="/" onClick={(e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
          <BrandMark />
          <span className="brand-txt">
            FREECOLOR<em>UNDERWATER</em>
          </span>
        </a>

        <nav className={`head-nav ${menu ? 'open' : ''}`}>
          <a href="#showcase" onClick={() => setMenu(false)}>{c.nav.showcase}</a>
          <a href="#gaya" onClick={() => setMenu(false)}>{c.nav.styles}</a>
          <a href="#cara" onClick={() => setMenu(false)}>{lang === 'id' ? 'Alur' : 'The flow'}</a>
          <a href="#kontak" onClick={() => setMenu(false)}>{c.nav.contact}</a>
        </nav>

        <div className="head-actions">
          <div className="lang">
            <button className={lang === 'id' ? 'on' : ''} onClick={() => setLang('id')}>ID</button>
            <span>/</span>
            <button className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')}>EN</button>
          </div>
          {!demoMode && (
            user ? (
              <button className="btn btn-sm" onClick={onStart}>{user.name}</button>
            ) : (
              <button className="btn btn-sm head-login" onClick={onAuth}>{c.cta.signin}</button>
            )
          )}
          <button className="btn btn-solid btn-sm" onClick={onStart}>
            {c.cta.start}
            <Arrow />
          </button>
          <button
            className="menu-btn"
            aria-label="Menu"
            aria-expanded={menu}
            onClick={() => setMenu((m) => !m)}
          >
            <span /><span /><span />
          </button>
        </div>
      </header>

      <main>
        <section className={`hero ${data.hero ? 'has-photo' : ''}`}>
          <div className="hero-bg" style={data.hero ? { backgroundImage: `url(${data.hero})` } : undefined} />
          <div className="hero-caustic" />
          <div className="hero-inner">
            <p className="eyebrow">{c.hero.eyebrow}</p>
            <h1 className="hero-title">
              {c.hero.lines.map((line, i) => (
                <span key={i} style={{ animationDelay: `${0.08 * i + 0.1}s` }}>{line}</span>
              ))}
            </h1>

            <ul className="hero-feats">
              {c.hero.features.map((f, i) => (
                <li key={i}>
                  {feats[i]}
                  <span>{f}</span>
                </li>
              ))}
            </ul>

            <div className="hero-cta">
              <button className="btn btn-solid btn-lg" onClick={onStart}>
                {c.cta.start}
                <Arrow />
              </button>
              <a className="btn ghost btn-lg" href="#showcase">{c.cta.demo}</a>
            </div>

            <div className="hero-meta">
              <Stars />
              <span>{c.hero.note}</span>
            </div>
          </div>
          <div className="hero-scroll" aria-hidden="true">
            <span>{lang === 'id' ? 'gulir' : 'scroll'}</span>
            <i />
          </div>
        </section>

        <section id="showcase" className="section">
          <div className="wrap">
            <div className="sec-head">
              <p className="eyebrow">{c.showcase.eyebrow}</p>
              <h2 className="h2">{c.showcase.title}</h2>
              <p className="lede">{c.showcase.sub}</p>
            </div>

            {data.items.length ? (
              <div className="showcase-grid">
                {data.items.map((item) => (
                  <figure className="shot" key={item.id}>
                    <Compare
                      before={item.before}
                      after={item.after}
                      beforeLabel={c.labels.before}
                      afterLabel={c.labels.after}
                    />
                    <figcaption>
                      <strong>{item.title}</strong>
                      <span>{item.spot}</span>
                    </figcaption>
                  </figure>
                ))}
              </div>
            ) : (
              <p className="empty-note">{c.emptyShowcase}</p>
            )}
          </div>
        </section>

        <section id="gaya" className="section section-dark">
          <div className="wrap">
            <div className="sec-head">
              <p className="eyebrow">{c.styles.eyebrow}</p>
              <h2 className="h2 cyan">{c.styles.title}</h2>
              <p className="lede">{c.styles.sub}</p>
            </div>

            <div className="styles-bar" role="tablist" aria-label={c.styles.eyebrow}>
              {STYLES.map((s) => (
                <button
                  key={s.id}
                  role="tab"
                  aria-selected={style === s.id}
                  className={`style-tab ${style === s.id ? 'on' : ''}`}
                  onClick={() => setStyle(s.id)}
                >
                  <b>{s.label[lang] || s.label.id}</b>
                  <span>{s.note[lang] || s.note.id}</span>
                </button>
              ))}
            </div>

            <div className="style-stage">
              {demo && demoAfter ? (
                <Compare
                  before={demo.before}
                  after={demoAfter}
                  ratio={demo.ratio || 1.4}
                  initial={55}
                  beforeLabel={c.labels.before}
                  afterLabel={`${c.labels.after} · ${(STYLES.find((s) => s.id === style)?.label[lang] || '').toUpperCase()}`}
                />
              ) : (
                <div className="style-ph" />
              )}
              <div className="style-caption">
                <strong>{demo?.title || 'FreeColor Underwater'}</strong>
                <span>{demo?.spot || 'Indonesia'}</span>
              </div>
            </div>
          </div>
        </section>

        <section id="cara" className="section">
          <div className="wrap">
            <div className="sec-head">
              <p className="eyebrow">{c.steps.eyebrow}</p>
              <h2 className="h2">{c.steps.title}</h2>
            </div>
            <div className="steps">
              {c.steps.items.map((s) => (
                <article key={s.n} className="step">
                  <span className="step-n">{s.n}</span>
                  <h3>{s.h}</h3>
                  <p>{s.p}</p>
                </article>
              ))}
            </div>
            <div className="engine-note">
              <div>
                <b>{lang === 'id' ? 'Cara kerjanya' : 'How it works'}</b>
                <p>
                  {lang === 'id'
                    ? 'Isi merah dicari per petak, kabut disaring mengikuti tepi objek, jarak air ditebus per piksel, lalu air dicerahkan tanpa menyentuh subjek. Semua dihitung di server, hasilnya sama setiap kali.'
                    : 'Red is recovered tile by tile, haze is filtered along object edges, water distance is compensated per pixel, then the water is brightened without touching the subject. Computed server-side, same result every time.'}
                </p>
              </div>
              <ul>
                <li>{lang === 'id' ? 'Setel otomatis' : 'Automatic settings'}</li>
                <li>{lang === 'id' ? 'Baca foto dengan AI' : 'Read photos with AI'}</li>
                <li>{lang === 'id' ? 'Banyak foto & arsip' : 'Batch & archive'}</li>
              </ul>
            </div>
          </div>
        </section>

        <section className="section section-dark">
          <div className="wrap">
            <div className="quotes-head">
              <div>
                <p className="eyebrow">{c.quotes.eyebrow}</p>
                <h2 className="h2 cyan">{c.quotes.title}</h2>
              </div>
              <div className="rating">
                <Stars />
                <span>{c.quotes.rating}</span>
              </div>
            </div>
            <div className="quotes">
              {c.quotes.items.map((q) => (
                <blockquote className="quote" key={q.n}>
                  <Stars />
                  <p>“{q.q}”</p>
                  <footer>
                    <b>{q.n}</b>
                    <span>{q.r}</span>
                  </footer>
                </blockquote>
              ))}
            </div>
          </div>
        </section>

        <section id="kontak" className="section final">
          <div className="wrap final-inner">
            <p className="eyebrow">{c.finalCta.eyebrow}</p>
            <h2 className="h2 cyan">{c.finalCta.title}</h2>
            <p className="lede">{c.finalCta.sub}</p>
            <button className="btn btn-solid btn-lg" onClick={onStart}>
              {c.cta.start}
              <Arrow />
            </button>
          </div>
        </section>
      </main>

      <footer className="site-foot">
        <div className="wrap foot-inner">
          <div className="brand foot-brand">
            <BrandMark />
            <span className="brand-txt">
              FREECOLOR<em>UNDERWATER</em>
            </span>
          </div>
          <p className="foot-copy">
            © 2026 FreeColor Underwater. {c.footer.rights}
          </p>
          <div className="foot-links">
            <a href="#kontak">{c.footer.terms}</a>
            <a href="#kontak">{c.footer.privacy}</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
