/*! Nordrift Underwater Color Correction – app engine
 *  © 2026 Nordrift / Jonas Jensen. All rights reserved.
 *  Algorithm (red/blue compensation, gray-world white balance, percentile
 *  stretch and temporal median smoothing) ported 1:1 from Nordrift's Python
 *  reference to a WebGL2 shader, plus scene presets tuned on real footage.
 *  Decode/encode via WebCodecs, demux via mp4box.js, mux via mp4-muxer.
 *  Everything runs locally in the browser – nothing is uploaded. */
(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const DEV = ['localhost', '127.0.0.1'].includes(location.hostname);
const devClip = DEV ? new URLSearchParams(location.search).get('dev') : null;
// Dive-centre version ("tenant"): the same app on the centre's own address, with the centre's logo in the corner tag
// and the tag always on. tenants.json maps hostnames to {name, web, logo, scale}; on localhost and on a *.vercel.app preview ?tenant=<host> picks one.
const TENANT_HOST = ((DEV || /.vercel.app$/.test(location.hostname)) && new URLSearchParams(location.search).get('tenant')) || location.hostname;
let TENANT = null;
// The tag settings a centre saved in its dashboard (Vercel Blob, GET /api/branding) lie over tenants.json, so a change is live
// within a minute without a deploy. Asked only on a tenant's address; if the lookup fails or takes > 2.5 s, tenants.json alone is used.
const BRAND_KEYS = ['name', 'web', 'logo', 'size', 'corner', 'style', 'font', 'opacity', 'showName', 'showWeb', 'uppercase'];
const tenantReady = Promise.resolve(null);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmtMB = b => (b / 1e6).toLocaleString('en-US', { maximumFractionDigits: b < 1e8 ? 1 : 0 }) + ' MB';
const fmtTime = s => { s = Math.max(0, Math.round(s)); return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s` : `${Math.floor(s / 3600)} h ${Math.floor(s % 3600 / 60)} min`; };
const fmtFps = f => f.toFixed(2).replace(/\.?0+$/, '');
const resLabel = (w, h) => w >= 5000 ? '5.3K' : w >= 3800 ? '4K' : w >= 2600 ? '2.7K' : w >= 1900 ? '1080p' : w >= 1200 ? '720p' : `${h}p`;
const fmtClock = s => { s = Math.max(0, Math.round(s)); const m = Math.floor(s / 60), h = Math.floor(m / 60); return h ? `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`; };

// ---------- support ----------
// Tag an error with the pipeline step it happened in, so reports from devices we cannot test (iOS) are actionable.
function stepErr(step, e) { const m = (e && e.message) || String(e); if (/\[step: /.test(m)) return e; const x = new Error(`${m} [step: ${step}]`); x.name = (e && e.name) || 'Error'; x.step = step; return x; }
const SELFTEST = +(new URLSearchParams(location.search).get('selftest') || 0); // seconds per file, from the diagnostics page
const DEV_BADTS = DEV && new URLSearchParams(location.search).has('badts');
const DEV_LOWRATE = DEV && new URLSearchParams(location.search).has('lowrate');
const DEV_REORDER = DEV && new URLSearchParams(location.search).has('reorder');
const DEV_DECFAIL = DEV && new URLSearchParams(location.search).has('decfail'); // simulate a hardware decoder that fails on the first frames // simulate a B-frame encoder // simulate an encoder that undershoots
// Android tablets (Lenovo, Samsung Tab …) run Chrome in "desktop site" mode by default: a desktop Linux user agent, but still
// no folder picker and no reliable streamed download. Recognise them by touch + ARM Linux.
const ANDROID_DESKTOP_UA = !/Android/i.test(navigator.userAgent) && ((navigator.userAgentData && navigator.userAgentData.platform === 'Android') || (navigator.maxTouchPoints > 1 && /Linux (arm|aarch)/i.test(navigator.platform || '') && !/CrOS/.test(navigator.userAgent)));
const IS_ANDROID = /Android/i.test(navigator.userAgent) || ANDROID_DESKTOP_UA;
const ANDROID_ACCEPT = 'video/*,image/*'; // the picker's type filter on Android (desktop keeps the full list in app.html)
const IS_MOBILE = IS_ANDROID || /iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform));
// Phones/tablets: iOS saves through the share sheet ("Save Video"); Android's share sheet often has no "save to device",
// so Android downloads to the Downloads folder (visible in Files and Gallery).
const SAVE_LABEL = (typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.()) ? 'Simpan ke Galeri' : (IS_MOBILE ? 'Simpan' : 'Download');
const IS_IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform));
const support = {
  codecs: typeof VideoDecoder !== 'undefined' && typeof VideoEncoder !== 'undefined',
  fs: typeof showDirectoryPicker !== 'undefined',
  opfs: !!(navigator.storage && navigator.storage.getDirectory),
  gl: !!document.createElement('canvas').getContext('webgl2'),
};
// Where finished files go: 'fsa' = straight into a folder the user picks (desktop), 'opfs' / 'opfs-sync' = the browser's
// private storage, then "Save" (share sheet on phones, download on desktop). Phones get OPFS even if they have the folder picker.
const OUT_OVERRIDE = DEV ? new URLSearchParams(location.search).get('out') : null;
support.stream = 'serviceWorker' in navigator && typeof ReadableStream !== 'undefined' && location.protocol === 'https:' || (DEV && 'serviceWorker' in navigator);
// Desktop with folder access -> write into the chosen folder. Desktop WITHOUT it (Brave, Firefox, locked-down Chrome) -> stream each
// finished file straight into the browser's download (no storage quota). Phones -> browser storage + Save/Share.
let outMode = OUT_OVERRIDE || (support.opfs ? 'opfs' : 'memory');
if (!support.gl) {
  $('#unsupported').hidden = false; $('#app').hidden = true; return;
}
outMode = OUT_OVERRIDE || (support.opfs ? 'opfs' : 'memory');

// Count this browser once as a user (a flag only – no id, no cookie). Waits for the tenant lookup so the event carries the host.
tenantReady.then(() => { try { if (!localStorage.getItem('cc-counted')) { localStorage.setItem('cc-counted', '1'); ccStat('user'); } } catch (_) { } });

// remember the output size choice
try {
  let v = localStorage.getItem('cc-outsize');
  if (IS_MOBILE || IS_ANDROID) {
    if (!v || v === '0' || v === '3840' || isNaN(+v)) v = '1920';
  } else if (!v || isNaN(+v)) {
    v = '1920';
  }
  if ($('#outSize')) $('#outSize').value = v;
} catch (_) { }
try { const v = localStorage.getItem('cc-sidenote'); if (v !== null && $('#sideNote')) $('#sideNote').value = v; } catch (_) { }
if ($('#sideNote')) $('#sideNote').addEventListener('change', () => { try { localStorage.setItem('cc-sidenote', $('#sideNote').value); } catch (_) { } ccTrack('side_note', { v: $('#sideNote').value }); });
if ($('#outSize')) $('#outSize').addEventListener('change', () => { try { localStorage.setItem('cc-outsize', $('#outSize').value); } catch (_) { } ccTrack('out_size', { v: $('#outSize').value }); });

// ---------- self-test banner ----------
if (SELFTEST) { const n = document.createElement('div'); n.className = 'notice'; n.innerHTML = `<b>Test mode:</b> only the first ${SELFTEST} seconds of each video are processed. If something fails, the message in the list says which step – please send it to jonas@jjsap.com. <a href="/color-correction/app">Leave test mode</a>`; const st = $('#status'); if (st) st.after(n); }

// ---------- output mode UI ----------
(() => {
  const btn = $('#outDirBtn'), name = $('#outDirName'), drop = $('#drop');
  if (outMode !== 'fsa') {
    if (btn) btn.hidden = true;
    if (name) name.textContent = outMode === 'stream' ? 'This browser blocks folder access (Brave and Firefox do), so each finished video is downloaded straight to your Downloads folder as it completes.' : IS_ANDROID ? 'Phones and tablets cannot pick a folder. Each finished video gets a Download button – it goes to your Downloads folder (open it from Files or Gallery).' : IS_MOBILE ? 'Finished videos get a Save button in the list – save them to your photos or files.' : 'Finished videos get a Download button in the list (this browser has no folder access).';
  }
  if (IS_MOBILE && drop) { const b = drop.querySelector('b'); if (b) b.textContent = 'Tap to choose videos or photos'; const sm = drop.querySelector('small, span'); if (sm) sm.textContent = 'MP4 / MOV / JPG / HEIC · several at once · nothing is uploaded'; }
  // Android's system picker reacts to the type list: with the long desktop list (MIME types plus extensions) some phones
  // showed an empty "This device" view (Alan, GoPro 11). Phones get the short list – and a picker without any filter as
  // a way in that always works.
  if (IS_ANDROID && drop) {
    $('#fileInput').setAttribute('accept', ANDROID_ACCEPT); // (ui is built further down – this block runs first)
    const any = document.createElement('button'); any.type = 'button'; any.className = 'btn btn-ghost browse-any'; any.id = 'browseAny'; any.textContent = 'Browse all files'; any.title = 'Opens the file picker without a file-type filter';
    any.addEventListener('click', e => { e.stopPropagation(); const inp = $('#fileInput'); if (inp) { inp.setAttribute('accept', '*/*'); inp.click(); setTimeout(() => { if (inp.getAttribute('accept') === '*/*') inp.setAttribute('accept', ANDROID_ACCEPT); }, 4000); } ccTrack('browse_any', {}); });
    drop.after(any);
  }
  if (IS_IOS) ccTrack('ios_app_open', { codecs: support.codecs, opfs: support.opfs });
  if (ANDROID_DESKTOP_UA) ccTrack('android_desktop_ua', {});
})();

// ---------- scene presets (tuned on Red Sea GoPro footage) ----------
// alphaRed: red compensation strength; pct: low/high percentiles for the
// contrast stretch; capR: max red gain (keeps open water blue, not cyan).
// floorB: min blue gain (keeps pure open water from turning purple when gray-world fails).
// minSpan: minimum percentile span kept after the stretch (caps contrast gain on hazy footage);
// satCap: max increase of mean saturation vs. the source (0 = off).
const PRESETS = {
  deep:  { label: 'Laut Dalam',      strength: 0.5, blue: 0, window: 30, every: 3, alphaRed: 0.4,  pct: [0.01, 0.99],   capR: 1.25, floorB: 0.9, minSpan: 0.45, satCap: 0, sat: 1 },
  blue:  { label: 'Air Biru Terbuka',     strength: 0.9, blue: 0, window: 30, every: 3, alphaRed: 0.85, pct: [0.01, 0.99],   capR: 1.8,  floorB: 0,   minSpan: 0.45, satCap: 0, sat: 1 },
  reef:  { label: 'Terumbu Karang',           strength: 1.0, blue: 0, window: 15, every: 3, alphaRed: 1.0,  pct: [0.01, 0.99],   capR: 2.6,  floorB: 0,   minSpan: 0.45, satCap: 0, sat: 1 },
  macro: { label: 'Makro / Senter',       strength: 0.9, blue: 0, window: 8,  every: 2, alphaRed: 0.85, pct: [0.003, 0.997], capR: 2.2,  floorB: 0,   minSpan: 0.45, satCap: 0, sat: 1 },
  green: { label: 'Air Kehijauan',    strength: 1.0, blue: 1, window: 15, every: 3, alphaRed: 1.0,  pct: [0.01, 0.99],   capR: 2.6,  floorB: 0,   minSpan: 0.45, satCap: 0, sat: 1 },
  hazy:  { label: 'Dangkal / Keruh', strength: 0.7, blue: 0, window: 20, every: 3, alphaRed: 0.6,  pct: [0.01, 0.99],   capR: 1.6,  floorB: 0,   minSpan: 0.5,  satCap: 1.4 },
};
PRESETS.blue.waterKeep = 1.6; PRESETS.deep.waterKeep = 1.6;
if (DEV && new URLSearchParams(location.search).has('wk')) { const v = +new URLSearchParams(location.search).get('wk'); PRESETS.blue.waterKeep = PRESETS.deep.waterKeep = v; } // localhost tuning
// Hazy water that is clearly green (murky coastal water, lakes): the milky-water caps on contrast, saturation and red
// gain stay, but the colour work follows Green water – blue compensation, full red recovery, strength 0.85 instead of
// 0.7. Otherwise 30 % of the green original shows through and the water stays green, and a green ↔ hazy switch inside a
// clip is a visible jump. Strength stays under 1: the bit of original keeps murky water slightly teal instead of mauve.
// Added on top of the preset (and the user's adjustments), scaled by how far green leads blue in the water (measure()).
PRESETS.hazy.greenWater = { strength: 0.15, blue: 1, alphaRed: 0.4 };
if (DEV && new URLSearchParams(location.search).has('gw')) { const v = new URLSearchParams(location.search).get('gw'); if (v === '0') delete PRESETS.hazy.greenWater; else PRESETS.hazy.greenWater.strength = +v; } // localhost tuning: gw=0 old hazy, gw=<strength delta>
// Classify from raw channel means [r, g, b] (0..1).
// cur (scene tracking): the scene playing now. Its thresholds get a margin (hysteresis), so footage that hovers
// right at a border – e.g. green water whose contrast sits around the hazy limit – stays in one scene instead of
// flipping back and forth every few seconds.
const HYST = DEV && new URLSearchParams(location.search).has('hyst') ? +new URLSearchParams(location.search).get('hyst') : 1; // localhost tuning
function classify(m, span, cur) {
  const blueness = m[2] - m[0], h = cur ? HYST : 0;
  if (span !== undefined && span < 0.40 + (cur === 'hazy' ? 0.06 : -0.06) * h) return 'hazy'; // milky, low-contrast water (snorkelling, silt, plankton)
  if (blueness <= 0.12) return 'macro';         // subject fills the frame, little water in view
  if (m[1] > m[2] + 0.06 + (cur === 'green' ? -0.03 : 0.03) * h) return 'green'; // green clearly dominates blue
  if (blueness >= 0.55) return 'deep';          // almost nothing but water: gray-world would go purple
  if (blueness >= 0.30) return 'blue';          // open water / wide shots
  return 'reef';
}

// ---------- UI refs ----------
const ui = {
  drop: $('#drop'), fileInput: $('#fileInput'), queue: $('#queue'),
  pvBefore: $('#pvBefore'), glc: $('#glc'), cmp: $('#cmp'), cmpRange: $('#cmpRange'), pvEmpty: $('#pvEmpty'), pvInfo: $('#pvInfo'),
  scene: $('#scene'), sceneNote: $('#sceneNote'),
  strength: $('#strength'), strengthOut: $('#strengthOut'), greenish: $('#greenish'), smooth: $('#smoothing'),
  measureEvery: $('#measureEvery'), quality: $('#quality'), outSize: $('#outSize'), outCodec: $('#outCodec'), denoise: $('#denoise'), sideNote: $('#sideNote'),
  redRec: $('#redRec'), redRecOut: $('#redRecOut'), contrast: $('#contrast'), contrastOut: $('#contrastOut'), saturation: $('#saturation'), saturationOut: $('#saturationOut'), warmth: $('#warmth'), warmthOut: $('#warmthOut'),
  outDirBtn: $('#outDirBtn'), outDirName: $('#outDirName'), startBtn: $('#startBtn'), startTop: $('#startTop'), cancelBtn: $('#cancelBtn'),
  wmToggle: $('#wmToggle'), wmModal: $('#wmModal'), wmDonate: $('#wmDonate'), wmRemove: $('#wmRemove'), wmKeep: $('#wmKeep'),
  hwNote: $('#hwNote'), batch: $('#batch'), bEta: $('#bEta'), bEtaNote: $('#bEtaNote'), bRank: $('#bRank'), bRankIco: $('#bRankIco'), bRankName: $('#bRankName'), bRankNote: $('#bRankNote'), bTrack: $('#bTrack'), bAvg: $('#bAvg'), bLive: $('#bLive'), bSpeed: $('#bSpeed'), bFrames: $('#bFrames'), bVids: $('#bVids'), bElapsed: $('#bElapsed'),
  bar: $('#progressBar'), status: $('#status'), statusText: $('#statusText'), led: $('#status .led'),
};
const log = s => { if (DEV) console.log(s); };
function setStatus(text, kind = 'ok') {
  ui.statusText.textContent = text; ui.status.classList.toggle('err', kind === 'err');
  ui.led.className = 'led' + (kind === 'err' ? ' red' : kind === 'busy' ? ' amber pulse' : '');
}

// ---------- WebGL2: correction shader (port of core.py apply_params) ----------
const gl = ui.glc.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
const VS = `#version 300 es
in vec2 p; out vec2 v; void main(){ v = vec2(p.x*0.5+0.5, 0.5-p.y*0.5); gl_Position = vec4(p,0.,1.); }`;
const FS = `#version 300 es
precision highp float; uniform sampler2D t; uniform sampler2D wm; uniform vec3 uMean, uScale, uLow, uHigh; uniform float uBlue, uAlphaRed, uStrength, uRaw, uWmOn, uSatMul, uWarm, uDither, uSeed; uniform vec4 uWm;
in vec2 v; out vec4 o;
void main(){
  vec3 c = texture(t, v).rgb;
  if (uRaw > 0.5) { o = vec4(c, 1.0); return; }
  // ±1 LSB triangular dither on the 8-bit input, new pattern every frame: the stretch would otherwise turn the source's
  // steps into visible bands in smooth blue water (Robert, 10-bit Action 6 source decoded to 8-bit; denoise hides it less)
  float n1 = fract(sin(dot(gl_FragCoord.xy + uSeed, vec2(12.9898, 78.233))) * 43758.5453);
  float n2 = fract(sin(dot(gl_FragCoord.xy - uSeed, vec2(39.3468, 11.1351))) * 24634.6345);
  c = clamp(c + (n1 + n2 - 1.0) * uDither, 0.0, 1.0);
  float r = c.r + uAlphaRed * (uMean.g - uMean.r) * (1.0 - c.r) * c.g;   // compensate_red
  float b = c.b + uBlue * (uMean.g - uMean.b) * (1.0 - c.b) * c.g;       // compensate_blue
  vec3 wb = clamp(vec3(r, c.g, b) * uScale, 0.0, 1.0);                   // gray-world white balance
  vec3 st = clamp((wb - uLow) / max(uHigh - uLow, vec3(1e-6)), 0.0, 1.0); // percentile stretch
  float hl = smoothstep(0.70, 0.92, dot(c, vec3(0.299, 0.587, 0.114)));     // highlight guard: sunbeams and sparkle stay neutral, never red
  st.r = mix(st.r, min(st.r, max(st.g, st.b) + 0.04), hl);
  st = mix(vec3(dot(st, vec3(0.299, 0.587, 0.114))), st, uSatMul);           // saturation guard (hazy scenes)
  vec3 col = mix(c, st, uStrength);                                       // strength blend with original
  col = clamp(col * vec3(1.0 + 0.25 * uWarm, 1.0 + 0.04 * uWarm, 1.0 - 0.25 * uWarm), 0.0, 1.0); // warmth (output setting)
  if (uWmOn > 0.5 && v.x >= uWm.x && v.x <= uWm.x + uWm.z && v.y >= uWm.y && v.y <= uWm.y + uWm.w) {
    vec4 w = texture(wm, vec2((v.x - uWm.x) / uWm.z, (v.y - uWm.y) / uWm.w));  // dive.nordrift.dk watermark
    col = mix(col, w.rgb, w.a);
  }
  o = vec4(col, 1.0);
}`;
function mkProg(vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.bindAttribLocation(p, 0, 'p'); gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}
const prog = mkProg(VS, FS); gl.useProgram(prog);
const vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
const aloc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(aloc); gl.vertexAttribPointer(aloc, 2, gl.FLOAT, false, 0, 0);
const U = {}; for (const n of ['t', 'wm', 'uMean', 'uScale', 'uLow', 'uHigh', 'uBlue', 'uAlphaRed', 'uStrength', 'uRaw', 'uWmOn', 'uWm', 'uSatMul', 'uWarm', 'uDither', 'uSeed']) U[n] = gl.getUniformLocation(prog, n);
gl.uniform1i(U.t, 0); gl.uniform1i(U.wm, 1); gl.uniform1f(U.uWmOn, 0); gl.uniform1f(U.uSatMul, 1); gl.uniform4f(U.uWm, 2, 2, 0, 0);
const DITHER = DEV && new URLSearchParams(location.search).has('nodither') ? 0 : 1 / 255; gl.uniform1f(U.uDither, DITHER); let ditherSeed = 0;
const mkTex = () => { const x = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, x); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return x; };
gl.activeTexture(gl.TEXTURE1); const wmTex = mkTex();
gl.activeTexture(gl.TEXTURE0); const tex = mkTex();
// Watermark: "dive.nordrift.dk" rendered once per output size into a small texture and
// alpha-blended by the shader in the bottom-right corner of every frame.
const WM_URL = 'freecolors.app', WM_TAG = 'freeColors Underwater · Yoyo R Himam'; let WM_SCALE = 0.65, wmKey = '';
// Glassy badge: small mono tagline over the bold link, on a translucent rounded panel.
// The watermark artwork (Logo/Watermark.svg, rasterised 4× to img/watermark.png – a PNG because some browsers refuse
// SVGs with embedded images in WebGL). 420 px × WM_SCALE wide on a 1080p frame (0.65 since 2026-10-13: reviewers found it
// too big), scaled with the frame height (max ⅓ × WM_SCALE of the
// width for portrait video), 38 px from the corner at 1080p. Drawn once per output size into a canvas at exactly the
// target size (high-quality downscale, so the lettering stays crisp), then blended by the shader.
// On a dive centre's address the artwork is the centre's own tag (logo, name, website), drawn once by tenantBadge().
const wmImg = new Image();
const wmReady = tenantReady.then(t => t ? tenantBadge(t) : '/color-correction/img/watermark.png')
  .then(src => { wmImg.src = src; return wmImg.decode ? wmImg.decode() : new Promise(r => { wmImg.onload = r; }); })
  .catch(() => { }).then(() => { wmKey = ''; try { if (previewFrame && !running) showPreview(); } catch (_) { } });
// The centre's tag: rounded dark panel, the logo in a white-ringed circle, the name in bold capitals and the website
// underneath – drawn at high resolution, then downscaled per output size like the standard artwork.
async function tenantBadge(t) {
  // Options per centre (tenants.json / the dashboard): style dark|light|minimal|logo · showName · showWeb · uppercase ·
  // font modern|classic|mono|plain · opacity of the panel (0–1) · scale and corner (handled in setWatermark).
  const style = ['dark', 'light', 'minimal', 'logo'].includes(t.style) ? t.style : 'dark', light = style === 'light';
  const FONTS = { modern: ['700', '"Familjen Grotesk", "Helvetica Neue", Arial, sans-serif'], classic: ['400', '"Instrument Serif", Georgia, serif'], mono: ['500', '"JetBrains Mono", ui-monospace, Consolas, monospace'], plain: ['700', 'Arial, Helvetica, sans-serif'] };
  const [fw, ff] = FONTS[t.font] || FONTS.modern, serif = t.font === 'classic';
  const rawName = style === 'logo' || t.showName === false ? '' : String(t.name || ''), name = t.uppercase === false ? rawName : rawName.toUpperCase();
  const web = style !== 'logo' && t.showWeb !== false && t.web ? String(t.web) : '';
  const logo = new Image(); logo.src = t.logo || '';
  if (t.logo) await (logo.decode ? logo.decode() : new Promise((res, rej) => { logo.onload = res; logo.onerror = rej; })).catch(() => { });
  try { await Promise.all([document.fonts.load(`${fw} 60px ${ff}`), document.fonts.load(`500 37px ${ff}`)]); } catch (_) { }
  const u = 60, d = 1.9 * u, gap = .5 * u, ls = serif ? u * .01 : u * .04, padX = style === 'minimal' ? u * .15 : .5 * u, padY = style === 'minimal' ? u * .15 : .5 * u;
  const nameSize = serif ? u * 1.15 : u, webSize = name ? u * .62 : u * .8;
  const nameFont = `${fw} ${Math.round(nameSize)}px ${ff}`, webFont = `500 ${Math.round(webSize)}px ${ff}`;
  const wide = !!logo.naturalWidth && logo.naturalWidth / logo.naturalHeight > 1.4;          // a wordmark: drawn as it is, no circle
  const lw = wide ? Math.min(d * 3.4, d * .9 * logo.naturalWidth / logo.naturalHeight) : d, lh = wide ? lw * logo.naturalHeight / logo.naturalWidth : d;
  const c = document.createElement('canvas'); let ctx = c.getContext('2d');
  ctx.font = nameFont; const nameW = name ? [...name].reduce((w, ch) => w + ctx.measureText(ch).width, 0) + ls * (name.length - 1) : 0;
  ctx.font = webFont; const webW = web ? ctx.measureText(web).width : 0;
  const textH = (name ? u : 0) + (name && web ? u * .25 : 0) + (web ? webSize : 0), hasText = !!(name || web);
  const bh = Math.max(d, textH) + padY * 2, bw = hasText ? padX + lw + gap + Math.max(nameW, webW) + padX * 1.5 : (wide ? lw + padX * 2 : bh);
  c.width = Math.ceil(bw + 8); c.height = Math.ceil(bh + 8); ctx = c.getContext('2d');
  const x0 = 4, y0 = 4, op = Math.max(0, Math.min(1, t.opacity == null ? (light ? .9 : .84) : +t.opacity));
  if ((style === 'dark' || light) && op > 0) {                                        // the panel
    ctx.beginPath(); ctx.roundRect(x0, y0, bw, bh, bh / 2); ctx.fillStyle = light ? `rgba(255,255,255,${op})` : `rgba(6,20,38,${op})`; ctx.fill();
    ctx.strokeStyle = light ? `rgba(0,0,0,${0.10 * op})` : `rgba(255,255,255,${0.16 * op})`; ctx.lineWidth = Math.max(1, u * .05); ctx.stroke();
  }
  const faint = style === 'minimal' || style === 'logo' || op < .5;                   // text and logo need a shadow without a solid panel
  const cx = hasText ? x0 + padX + lw / 2 : x0 + bw / 2, cy = y0 + bh / 2;
  if (wide) {                                                                         // wordmark as it is, with a soft shadow
    if (faint) { ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = u * .35; }
    ctx.drawImage(logo, cx - lw / 2, cy - lh / 2, lw, lh); ctx.shadowBlur = 0;
  } else {                                                                            // emblem in a circle with a ring
    ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, d / 2, 0, Math.PI * 2); ctx.clip(); ctx.fillStyle = '#0E8FC7'; ctx.fillRect(cx - d / 2, cy - d / 2, d, d);
    if (logo.naturalWidth) ctx.drawImage(logo, cx - d / 2, cy - d / 2, d, d);
    else { ctx.fillStyle = '#fff'; ctx.font = `700 ${Math.round(d * .55)}px ${ff}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText((t.name || '?').trim()[0].toUpperCase(), cx, cy + d * .03); } // no logo yet: the initial
    ctx.restore();
    if (faint) { ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = u * .35; }
    ctx.beginPath(); ctx.arc(cx, cy, d / 2, 0, Math.PI * 2); ctx.strokeStyle = light ? '#0B1A2E' : '#fff'; ctx.lineWidth = u * .08; ctx.stroke(); ctx.shadowBlur = 0;
  }
  if (hasText) {                                                                      // the text
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; const tx = x0 + padX + lw + gap; let y = cy - textH / 2;
    if (!light) { ctx.shadowColor = faint ? 'rgba(0,0,0,.6)' : 'rgba(0,0,0,.35)'; ctx.shadowBlur = faint ? u * .4 : u * .25; ctx.shadowOffsetY = u * .04; }
    if (name) { ctx.font = nameFont; ctx.fillStyle = light ? '#0B1A2E' : '#fff'; let x = tx; for (const ch of name) { ctx.fillText(ch, x, y + u / 2); x += ctx.measureText(ch).width + ls; } y += u + (web ? u * .25 : 0); }
    if (web) { ctx.font = webFont; ctx.fillStyle = light ? '#0A6E8F' : '#8FE9F5'; ctx.fillText(web, tx, y + webSize / 2); }
  }
  return c.toDataURL('image/png');
}
function setWatermark(W, H) {
  const key = W + 'x' + H; if (wmKey === key) return; wmKey = key;
  if (wmImg.complete && wmImg.naturalWidth) {
    const tw = Math.round(Math.min(H * 420 * WM_SCALE / 1080, W * WM_SCALE / 3)), th = Math.round(tw * wmImg.naturalHeight / wmImg.naturalWidth), m = Math.round(H * 38 / 1080);
    const c = document.createElement('canvas'); c.width = tw; c.height = th;
    const ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(wmImg, 0, 0, tw, th);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, wmTex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c); gl.activeTexture(gl.TEXTURE0);
    const corner = (TENANT && TENANT.corner) || 'br';                           // a dive centre can pick the corner
    gl.uniform4f(U.uWm, corner.endsWith('l') ? m / W : 1 - (m + tw) / W, corner.startsWith('t') ? m / H : 1 - (m + th) / H, tw / W, th / H);
    return;
  }
  // fallback while the artwork is still loading (previews only – processing waits for it): the drawn badge
  const s = Math.max(12, H * 0.024 * WM_SCALE);            // base unit scales with frame height
  const urlFont = `600 ${Math.round(s * 1.25)}px "Familjen Grotesk", "Helvetica Neue", Arial, sans-serif`;
  const tagFont = `500 ${Math.round(s * 0.62)}px "JetBrains Mono", ui-monospace, Consolas, monospace`;
  const c = document.createElement('canvas'); let ctx = c.getContext('2d');
  ctx.font = urlFont; const urlW = ctx.measureText(WM_URL).width; ctx.font = tagFont;
  const tagW = [...WM_TAG].reduce((w, ch) => w + ctx.measureText(ch).width, 0) + s * 0.07 * (WM_TAG.length - 1); // exact width incl. letter-spacing
  const padX = s * 0.9, padY = s * 0.6, gap = s * 0.28, dot = s * 0.36;
  const innerW = Math.max(urlW, tagW + dot + s * 0.4), tagH = s * 0.7, urlH = s * 1.3;
  c.width = Math.ceil(innerW + padX * 2 + 4); c.height = Math.ceil(tagH + gap + urlH + padY * 2 + 4);
  ctx = c.getContext('2d'); const r = s * 0.7, x0 = 2, y0 = 2, bw = c.width - 4, bh = c.height - 4;
  // panel
  ctx.beginPath(); ctx.roundRect(x0, y0, bw, bh, r);
  ctx.fillStyle = 'rgba(6, 14, 26, 0.42)'; ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = Math.max(1, s * 0.05); ctx.stroke();
  // tagline with accent dot
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  const ty = y0 + padY + tagH / 2;
  ctx.fillStyle = '#7CF0DC'; ctx.beginPath(); ctx.arc(x0 + padX + dot / 2, ty, dot / 2, 0, Math.PI * 2); ctx.fill();
  ctx.font = tagFont; ctx.fillStyle = 'rgba(233,239,236,0.92)';
  const tagX = x0 + padX + dot + s * 0.4; let cx = tagX;
  for (const ch of WM_TAG) { ctx.fillText(ch, cx, ty); cx += ctx.measureText(ch).width + s * 0.07; } // letter-spacing
  // url
  ctx.font = urlFont; ctx.fillStyle = '#FFFFFF';
  ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = s * 0.3; ctx.shadowOffsetY = s * 0.05;
  ctx.fillText(WM_URL, x0 + padX, y0 + padY + tagH + gap + urlH / 2);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, wmTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
  gl.activeTexture(gl.TEXTURE0);
  const mx = 0.02, my = mx * W / H, w = c.width / W, h = c.height / H;
  gl.uniform4f(U.uWm, 1 - mx - w, 1 - my - h, w, h);
}
// Small framebuffer for measurement (equivalent of measure_params sample_scale).
const SW = 160, SH = 90;
const smallTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, smallTex);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, SW, SH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
const fbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, smallTex, 0);
gl.bindFramebuffer(gl.FRAMEBUFFER, null);
const smallPx = new Uint8Array(SW * SH * 4);
const N = SW * SH, fr = new Float32Array(N), fg = new Float32Array(N), fb = new Float32Array(N), rc = new Float32Array(N), bc = new Float32Array(N), tmp = new Float32Array(N);

function uploadFrame(src) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src); }
function pct(src, scale, p) {
  for (let i = 0; i < N; i++) tmp[i] = Math.min(1, src[i] * scale);
  const a = tmp.slice().sort(); const i = (N - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return a[lo] + (a[hi] - a[lo]) * (i - lo);
}
let lastRawLum = 0.5;
// Raw channel means of the current texture (for scene classification).
function rawMeans() {
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.viewport(0, 0, SW, SH);
  gl.uniform1f(U.uRaw, 1); gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.readPixels(0, 0, SW, SH, gl.RGBA, gl.UNSIGNED_BYTE, smallPx);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  let mr = 0, mg = 0, mb = 0;
  for (let i = 0; i < N; i++) { fr[i] = smallPx[i * 4] / 255; fg[i] = smallPx[i * 4 + 1] / 255; fb[i] = smallPx[i * 4 + 2] / 255; mr += fr[i]; mg += fg[i]; mb += fb[i]; }
  lastRawLum = (0.299 * mr + 0.587 * mg + 0.114 * mb) / N; // whole-frame brightness (the denoiser's Auto uses it)
  return [mr / N, mg / N, mb / N];
}
// 1st-99th percentile span of luma on the current texture: low = hazy, low-contrast scene.
function lumaSpan() {
  for (let i = 0; i < N; i++) tmp[i] = 0.299 * fr[i] + 0.587 * fg[i] + 0.114 * fb[i];
  const a = tmp.slice().sort(); return a[Math.round((N - 1) * 0.99)] - a[Math.round((N - 1) * 0.01)];
}
const classifyTexture = cur => { const m = rawMeans(); return classify(m, lumaSpan(), cur); };
// measure_params: means -> compensation -> gray-world scales (red capped) -> percentiles of WB'd channels
// Robust cast estimate: strongly saturated warm pixels (red fins, torches, orange gear) are not part of the water's
// colour cast, and in dark scenes (wreck interiors, caverns) bright saturated openings would otherwise dictate the
// red gain for the whole frame and turn dark rust deep red. Those pixels are left out of the measurement (not out
// of the image). Normal scenes keep the full-frame contrast stretch, so their look is unchanged.
const mk = new Uint8Array(N);
function buildMask() {
  for (let i = 0; i < N; i++) tmp[i] = 0.299 * fr[i] + 0.587 * fg[i] + 0.114 * fb[i];
  const med = tmp.slice().sort()[N >> 1], dark = med < 0.12; let n = 0;
  for (let i = 0; i < N; i++) {
    const r = fr[i], g = fg[i], b = fb[i], mx = Math.max(r, g, b), sat = mx > 0 ? (mx - Math.min(r, g, b)) / mx : 0;
    const warm = r > g && r > b && sat > 0.45;
    mk[i] = (tmp[i] > 0.03 && !warm && (!dark || sat < 0.6)) ? 1 : 0; n += mk[i];
  }
  if (n < N * 0.2) { mk.fill(1); n = N; } // degenerate frame: measure everything
  return { dark, n };
}
function pctM(src, scale, p, useMask) {
  let k = 0;
  for (let i = 0; i < N; i++) if (!useMask || mk[i]) tmp[k++] = Math.min(1, src[i] * scale);
  const a = tmp.slice(0, k).sort(); const i = (k - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return a[lo] + (a[hi] - a[lo]) * (i - lo);
}
function measure(s, read = true) {
  if (read) rawMeans(); const { dark, n } = buildMask();
  let mr = 0, mg = 0, mb = 0;
  for (let i = 0; i < N; i++) if (mk[i]) { mr += fr[i]; mg += fg[i]; mb += fb[i]; }
  mr /= n; mg /= n; mb /= n;
  // Green-water share for hazy scenes (greenWater): 0 while green leads blue by ≤ 0.08, 1 from 0.12 – clearly green water
  // only (Thibault's shark clip: 0.13–0.14). Teal shallows lead by 0.03–0.08 (UAE snorkelling) and keep the plain hazy
  // look: with red nearly gone there, extra red recovery turned the sand pink and made it flicker as the share wobbled.
  const gw = s.greenWater ? Math.min(1, Math.max(0, (mg - mb - 0.08) / 0.04)) : 0, c = colourFor(s, gw);
  let mrc = 0, mbc = 0;
  for (let i = 0; i < N; i++) { rc[i] = fr[i] + c.alphaRed * (mg - mr) * (1 - fr[i]) * fg[i]; bc[i] = fb[i] + c.blueAlpha * (mg - mb) * (1 - fb[i]) * fg[i]; if (mk[i]) { mrc += rc[i]; mbc += bc[i]; } }
  mrc /= n; mbc /= n;
  // Open water (waterKeep > 0): don't neutralise the water to grey – aim the white balance at a slightly blue target,
  // and stretch the channels more alike (below), otherwise water filling the frame turns lavender/violet.
  // How much is kept depends on how much of the frame IS open water: smooth (low texture), blue-dominated pixels.
  // A reef close-up gets the full correction; a diver in front of blue water keeps the water blue.
  let wk = 0;
  if (s.waterKeep) {
    let w = 0, t = 0;
    for (let y = 1; y < SH - 1; y++) for (let x = 1; x < SW - 1; x++) {
      const i = y * SW + x; if (!mk[i]) continue; t++;
      const l = fg[i] + fb[i], gx = Math.abs(fg[i + 1] + fb[i + 1] - fg[i - 1] - fb[i - 1]), gy = Math.abs(fg[i + SW] + fb[i + SW] - fg[i - SW] - fb[i - SW]);
      if (fb[i] - fr[i] > 0.15 && gx + gy < 0.05 * Math.max(l, 0.2)) w++;
    }
    const frac = t ? w / t : 0; wk = s.waterKeep * Math.min(1, Math.max(0, (frac - 0.08) / 0.27));
  }
  const gray = (mbc + mg + mrc) / 3, eps = 1e-6;
  const sr = Math.min(s.capR, gray * (1 - 0.12 * wk) / Math.max(mrc, eps)), sg = gray / Math.max(mg, eps), sb = Math.max(s.floorB || 0, gray * (1 + 0.12 * wk) / Math.max(mbc, eps));
  const [pl, ph] = s.pct;
  const low = [pctM(rc, sr, pl, dark), pctM(fg, sg, pl, dark), pctM(bc, sb, pl, dark)], high = [pctM(rc, sr, ph, dark), pctM(fg, sg, ph, dark), pctM(bc, sb, ph, dark)];
  if (wk > 0) { const lc = (low[0] + low[1] + low[2]) / 3, hc = (high[0] + high[1] + high[2]) / 3, k = Math.min(0.9, 0.6 * wk); for (let i = 0; i < 3; i++) { low[i] += (lc - low[i]) * k; high[i] += (hc - high[i]) * k; } }
  const minSpan = s.minSpan || 0;
  for (let i = 0; i < 3; i++) { if (high[i] - low[i] < minSpan) { const mid = (low[i] + high[i]) / 2; low[i] = Math.max(0, mid - minSpan / 2); high[i] = Math.min(1, low[i] + minSpan); } }
  let satMul = 1;
  if (s.satCap > 0) { // compare mean saturation of the source vs. the fully corrected sample
    const sat = (r, g, b) => { const mx = Math.max(r, g, b); return mx > 0 ? (mx - Math.min(r, g, b)) / mx : 0; };
    const st = (v, sc, i) => Math.min(1, Math.max(0, (Math.min(1, v * sc) - low[i]) / Math.max(high[i] - low[i], 1e-6)));
    let s0 = 0, s1 = 0;
    for (let i = 0; i < N; i++) { s0 += sat(fr[i], fg[i], fb[i]); s1 += sat(st(rc[i], sr, 0), st(fg[i], sg, 1), st(bc[i], sb, 2)); }
    if (s1 > 0 && s1 / s0 > s.satCap) satMul = s.satCap * s0 / s1;
  }
  // How much of the correction this footage needs. The presets were tuned on raw GoPro files, where sand, coral and skin
  // (the least blue third of the measured pixels) have a red/green of 0.2–0.6 and come out right at about 1.0. A camera
  // with good underwater white balance (DJI Osmo Action), a phone, or a clip shot with a red filter already has them at
  // 0.75–1.0, and the same preset pushed them to 1.2–1.5: orange sand, magenta coral, pink skin – while the water was fine.
  // So the corrected sample is checked, and when those pixels land above the target the blend with the source is lowered
  // until they sit at it (never below 35 % of the preset). Raw footage is unaffected – it needs the full preset to get there.
  // Not in dark scenes (wreck interiors, night): there the least blue pixels are rust and shadow, already reddish, and
  // holding the correction back only lost the lift – the robust measurement above handles those scenes.
  let need = 1;
  if (NEED_ON && !dark && camBalanced()) {
    const st = (v, sc, i) => Math.min(1, Math.max(0, (Math.min(1, v * sc) - low[i]) / Math.max(high[i] - low[i], 1e-6)));
    const lit = i => 0.299 * fr[i] + 0.587 * fg[i] + 0.114 * fb[i] > 0.12; // lit pixels only – shadows say nothing about the camera's colour
    let k = 0; for (let i = 0; i < N; i++) if (mk[i] && lit(i)) tmp[k++] = fb[i] - fr[i];
    const thr = k ? tmp.slice(0, k).sort()[Math.floor((k - 1) / 3)] : -1; k = 0; let j = 0;
    for (let i = 0; i < N; i++) if (mk[i] && lit(i) && fb[i] - fr[i] <= thr) {
      const o = [st(rc[i], sr, 0), st(fg[i], sg, 1), st(bc[i], sb, 2)], y = 0.299 * o[0] + 0.587 * o[1] + 0.114 * o[2], sm = satMul * (s.sat ?? 1);
      const orr = c.strength * (y + (o[0] - y) * sm) + (1 - c.strength) * fr[i], og = c.strength * (y + (o[1] - y) * sm) + (1 - c.strength) * fg[i];
      tmp[k++] = fr[i] / Math.max(fg[i], 1e-3); subTmp[j++] = orr / Math.max(og, 1e-3);
    }
    if (k > 50) {
      const a = tmp.slice(0, k).sort(), b = subTmp.slice(0, j).sort(), si = a[k >> 1], so = b[j >> 1];
      if (so > NEED_TARGET && so > si) need = Math.max(0.35, (NEED_TARGET - si) / (so - si));
    }
  }
  return { mean: [mr, mg, mb], scale: [sr, sg, sb], low, high, satMul, gw, need };
}
const subTmp = new Float32Array(N);
// Camera from the printable strings of a file's metadata (MP4 moov or EXIF). id 'dji' | 'gopro' | 'apple' | 'insta360' | null; name for the info line.
function cameraOf(bytes) {
  let txt = ''; for (let i = 0; i < bytes.length; i++) { const c = bytes[i]; txt += c >= 32 && c < 127 ? String.fromCharCode(c) : ' '; }
  let m;
  if ((m = txt.match(/DJI\s*(Osmo\s*Action\s*\d*(?:\s*Pro)?|Osmo\s*\w+|Action\s*\d+)/i))) return { id: 'dji', name: ('DJI ' + m[1]).replace(/Osmo\s*Action\s*(\d)/i, 'Osmo Action $1').replace(/\s+/g, ' ').trim() };
  if (/DJI/.test(txt) && /Osmo|Action|AC0\d\d/.test(txt)) return { id: 'dji', name: 'DJI Osmo Action' };
  if ((m = txt.match(/HERO\s*\d+[ -~]{0,12}?(?=\s{2}|GoPro|$)/))) return { id: 'gopro', name: ('GoPro ' + m[0]).replace(/\s+/g, ' ').trim() };
  if (/GoPro/.test(txt)) return { id: 'gopro', name: 'GoPro' };
  if ((m = txt.match(/iPhone\s*\d+[ -~]{0,12}?(?=\s{2}|back|front|$)/))) return { id: 'apple', name: m[0].replace(/\s+/g, ' ').trim() };
  if (/Insta360/i.test(txt)) return { id: 'insta360', name: 'Insta360' };
  return null;
}
// Cameras that balance their colours under water themselves – only these get the needed-amount check (BALANCED);
// raw-recording cameras (GoPro, Insta360) and files without a camera tag are corrected with the full preset, as always.
const BALANCED = { dji: true };
let curCamera = null; // camera of the file on screen (preview or processing)
const camBalanced = () => !!(curCamera && BALANCED[curCamera.id]) || (DEV && new URLSearchParams(location.search).get('need') === '1');
// Target red/green for the subjects after correction (1.05 = neutral, a touch warm); dev `need=0` switches the check off, `need=1` forces it on for any camera.
const NEED_TARGET = 1.05, NEED_ON = !(DEV && new URLSearchParams(location.search).get('need') === '0');
// Colour settings in effect: the scene's (incl. the user's adjustments) plus the green-water share gw (hazy scenes only).
function colourFor(s, gw) {
  const g = s.greenWater; if (!g || !gw) return s;
  return { alphaRed: Math.min(1.5, s.alphaRed + gw * g.alphaRed), blueAlpha: Math.min(1, s.blueAlpha + gw * g.blue), strength: Math.min(1, s.strength + gw * g.strength) };
}
// ---------- optional denoiser (step 3: Off / Auto / Light / Strong) ----------
// Runs on the source BEFORE the correction, because the correction's gains amplify sensor noise in dark water.
// Spatial: 5×5 edge-preserving (bilateral) filter on the source. Temporal: recursive blend with the previous
// denoised frame, but only where the two agree – where the picture moved (diver, fish, camera pan) the difference
// is large and the current frame wins, so nothing ghosts. History is kept in a float texture where the GPU allows it.
// Off = this pass is skipped entirely, so the output is bit-identical to before.
const FS_DN = `#version 300 es
precision highp float; uniform sampler2D t; uniform sampler2D h; uniform vec2 px; uniform float sr, kt, st, hasPrev;
in vec2 v; out vec4 o;
void main(){
  const vec3 L = vec3(0.299, 0.587, 0.114);
  vec3 c = texture(t, v).rgb; float lc = dot(c, L);
  float sig = sr * (0.45 + lc); vec3 acc = vec3(0.0); float ws = 0.0;
  for (int y = -2; y <= 2; y++) for (int x = -2; x <= 2; x++) {
    vec3 s = texture(t, v + vec2(float(x), float(y)) * px).rgb; float d = dot(s - c, L);
    float w = exp(-float(x * x + y * y) / 4.5 - d * d / (2.0 * sig * sig)); acc += s * w; ws += w;
  }
  vec3 sp = acc / ws;
  if (hasPrev > 0.5) {
    // motion check on a 3×3 neighbourhood (largest difference to the previous frame): an edge that moved even one
    // pixel counts as motion, so moving edges are never blended with where they were (no double contours)
    float md = 0.0;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) { vec2 o = vec2(float(x), float(y)) * px; md = max(md, abs(dot(texture(t, v + o).rgb - texture(h, v + o).rgb, L))); }
    vec3 pv = texture(h, v).rgb; float e = md / (st * (0.5 + lc)); sp = mix(sp, pv, kt * exp(-e * e));
  }
  o = vec4(sp, 1.0);
}`;
// The intermediate pass writes into a texture, so it must not flip Y like the on-screen pass does – otherwise the
// correction (which flips once more) would output the frame upside down.
const VS_FBO = `#version 300 es
in vec2 p; out vec2 v; void main(){ v = p * 0.5 + 0.5; gl_Position = vec4(p,0.,1.); }`;
const dnProg = mkProg(VS_FBO, FS_DN);
const UD = {}; for (const n of ['t', 'h', 'px', 'sr', 'kt', 'st', 'hasPrev']) UD[n] = gl.getUniformLocation(dnProg, n);
gl.useProgram(dnProg); gl.uniform1i(UD.t, 0); gl.uniform1i(UD.h, 2); gl.useProgram(prog);
const DN_LEVEL = { light: { sr: 0.03, kt: 0.5, st: 0.035 }, strong: { sr: 0.05, kt: 0.7, st: 0.05 } };
const dn = { w: 0, h: 0, tex: [], fbo: [], cur: 0, has: false, float: !!gl.getExtension('EXT_color_buffer_float') };
function dnEnsure(w, h) {
  if (dn.w === w && dn.h === h) return;
  for (const t of dn.tex) gl.deleteTexture(t); for (const f of dn.fbo) gl.deleteFramebuffer(f);
  dn.tex = []; dn.fbo = []; dn.w = w; dn.h = h; dn.has = false;
  for (let i = 0; i < 2; i++) {
    const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (dn.float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null); else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    if (dn.float && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) { dn.float = false; gl.bindFramebuffer(gl.FRAMEBUFFER, null); dn.w = 0; return dnEnsure(w, h); }
    dn.tex.push(t); dn.fbo.push(f);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.activeTexture(gl.TEXTURE0);
}
const dnReset = () => { dn.has = false; };
// Strength for this frame (null = off). Auto: only dark scenes, judged on the WHOLE frame's brightness (the colour
// measurement ignores near-black pixels on purpose, so a night shot with one torch beam would look bright to it).
// Measured: night dives 0.12–0.17, wreck interiors ~0.07, daylight from ~0.18 up. Full strength below 0.08.
// Auto also when the correction itself has to amplify a lot – a camera that clipped red to zero (Sony RX100 in blue water),
// overexposed low-contrast footage: the stretch gain reaches 3.2× and the camera's fine noise becomes visible grain in the
// water. Light strength from 2.9× up (measured: blue/reef clips 1.7–2.2×, hazy/green 2.5–2.8×, red-clipped Sony 3.2×).
const DN_AMP = DEV && new URLSearchParams(location.search).get('dnamp') ? new URLSearchParams(location.search).get('dnamp').split(',').map(Number) : [2.9, 3.2]; // localhost tuning
function dnAmount(s, p) {
  const m = s.denoise || 'off'; if (m === 'off') return null;
  if (m !== 'auto') return DN_LEVEL[m];
  const L = DN_LEVEL.light, S = DN_LEVEL.strong;
  const a = Math.min(1, Math.max(0, (0.18 - lastRawLum) / 0.10));
  if (a > 0) { const f = x => L[x] + (S[x] - L[x]) * a; return { sr: f('sr'), kt: f('kt'), st: f('st') }; }
  let amp = 0; for (let i = 0; i < 3; i++) amp = Math.max(amp, p.scale[i] / Math.max(1e-3, p.high[i] - p.low[i]));
  const b = Math.min(1, Math.max(0, (amp - DN_AMP[0]) / (DN_AMP[1] - DN_AMP[0])));
  return b > 0 ? { sr: L.sr * b, kt: L.kt * b, st: L.st * b } : null;
}
// temporal = false for still previews and photos (no previous frame to blend with)
function denoisePass(lv, temporal) {
  const W = ui.glc.width, H = ui.glc.height; dnEnsure(W, H);
  const out = dn.cur ^ 1, use = temporal && dn.has;
  gl.useProgram(dnProg); gl.bindFramebuffer(gl.FRAMEBUFFER, dn.fbo[out]); gl.viewport(0, 0, W, H);
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, use ? dn.tex[dn.cur] : null); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform2f(UD.px, 1 / W, 1 / H); gl.uniform1f(UD.sr, lv.sr); gl.uniform1f(UD.kt, lv.kt); gl.uniform1f(UD.st, lv.st); gl.uniform1f(UD.hasPrev, use ? 1 : 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.useProgram(prog); gl.bindTexture(gl.TEXTURE_2D, dn.tex[out]); // the correction now reads the denoised frame
  if (temporal) { dn.cur = out; dn.has = true; }
}
// Brightness follow: the correction parameters are smoothed over a couple of seconds, but the light in the frame is not –
// sun through clouds and the camera's auto-exposure make the picture breathe by ±10 %. A fixed contrast stretch
// multiplies that (measured: 13 % in the source became 28 % in the output). The black point now moves with the frame's
// brightness relative to a running reference (≈ the same couple of seconds the parameters are smoothed over) while the
// span stays the same, so a 10 % brighter frame comes out 10 % brighter – not 25 %.
// Exponent 1.5 rather than 1: the red/blue compensation terms grow less than linearly with brightness, measured 1.0 still
// left ×1.5 amplification, 1.5 brings it to ≈ ×1.2. k is eased per frame (the brightness is read every few frames).
const KEXP = DEV && new URLSearchParams(location.search).has('kexp') ? +new URLSearchParams(location.search).get('kexp') : 1.5; // localhost tuning
let lumRef = null, kLum = 1, needCur = null;
function render(p, s, temporal = false) {
  const lv = dnAmount(s, p); if (lv) denoisePass(lv, temporal); else if (temporal) dn.has = false;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, ui.glc.width, ui.glc.height);
  let k = 1, need = p.need ?? 1;
  if (temporal) {
    if (lumRef === null) { lumRef = lastRawLum; kLum = 1; }
    lumRef += (lastRawLum - lumRef) * 0.02;
    kLum += (Math.pow(Math.min(1.25, Math.max(0.8, lastRawLum / Math.max(1e-3, lumRef))), KEXP) - kLum) * 0.35; k = kLum;
    // The needed amount is a property of the footage more than of the moment, so it may only drift: ±0.002 per frame
    // (a full swing takes 10–15 s). Otherwise a diver filling the frame or a scene change moved it visibly within a second.
    if (needCur === null) needCur = need; needCur += Math.min(0.002, Math.max(-0.002, need - needCur)); need = needCur;
  }
  const low = p.low.map(v => v * k), high = p.high.map((v, i) => v + low[i] - p.low[i]), c = colourFor(s, p.gw || 0);
  gl.uniform3fv(U.uMean, p.mean); gl.uniform3fv(U.uScale, p.scale); gl.uniform3fv(U.uLow, low); gl.uniform3fv(U.uHigh, high);
  gl.uniform1f(U.uBlue, c.blueAlpha); gl.uniform1f(U.uAlphaRed, c.alphaRed); gl.uniform1f(U.uStrength, c.strength * need); gl.uniform1f(U.uSatMul, (p.satMul ?? 1) * (s.sat ?? 1)); gl.uniform1f(U.uWarm, s.warm || 0); gl.uniform1f(U.uRaw, 0); gl.uniform1f(U.uSeed, (ditherSeed = (ditherSeed + 1) % 97) * 0.731);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  if (lv) gl.bindTexture(gl.TEXTURE_2D, tex); // back to the source texture for the next upload/measurement
}
// ParamSmoother (median over sliding window of the 12 parameters, the saturation guard, the green-water share and the needed amount)
// Rate limit on top of the median: when a big subject fills the frame for a few seconds (a dolphin passing, a diver
// swimming by), the whole-frame colour measurement shifts and the water behind it used to turn violet/red for that
// moment. The correction may now move only so fast; real scene changes are still followed, just smoothly.
// Per second: channel means ±0.04, gains ±12 %, stretch limits ±0.04, saturation guard ±0.15.
// Only in open water (blue / deep): in wrecks, reefs and night dives the light itself changes fast (torches, swim-throughs)
// and the correction must follow it – measured: limiting there made a wreck clip wobble more, not less.
const SLEW = DEV && new URLSearchParams(location.search).has('noslew') ? null : { mean: 0.04, scale: 0.12, lim: 0.04, sat: 0.15 };
const SLEW_IN = (DEV && new URLSearchParams(location.search).get('slewin') || 'blue,deep').split(','); // localhost tuning
const slewStep = (scene, every, fps) => SLEW_IN.includes(scene) || SLEW_IN.includes('all') ? every / fps : 0;
class ParamSmoother {
  constructor(win, step = 0) { this.win = Math.max(1, win | 0); this.buf = []; this.col = new Float64Array(this.win); this.step = step; this.last = null; }
  update(p) {
    this.buf.push([...p.mean, ...p.scale, ...p.low, ...p.high, p.satMul ?? 1, p.gw || 0, p.need ?? 1]); if (this.buf.length > this.win) this.buf.shift();
    const n = this.buf.length, out = new Array(15);
    if (n === 1) for (let i = 0; i < 15; i++) out[i] = this.buf[0][i];
    else { const col = this.col.subarray(0, n); for (let i = 0; i < 15; i++) { for (let j = 0; j < n; j++) col[j] = this.buf[j][i]; col.sort(); out[i] = n % 2 ? col[(n - 1) >> 1] : (col[n / 2 - 1] + col[n / 2]) / 2; } }
    if (SLEW && this.step && this.last) {
      const L = this.last, t = this.step, lim = (i, d) => { out[i] = Math.min(L[i] + d, Math.max(L[i] - d, out[i])); };
      for (let i = 0; i < 3; i++) lim(i, SLEW.mean * t);
      for (let i = 3; i < 6; i++) lim(i, L[i] * SLEW.scale * t);
      for (let i = 6; i < 12; i++) lim(i, SLEW.lim * t);
      lim(12, SLEW.sat * t);
    }
    this.last = out;
    return { mean: out.slice(0, 3), scale: out.slice(3, 6), low: out.slice(6, 9), high: out.slice(9, 12), satMul: out[12], gw: out[13], need: out[14] };
  }
}

// ---------- continuous scene tracking (Auto) ----------
// Every measured frame is also classified. A new scene takes over only when it has won a clear majority of the
// classifications over the last HOLD seconds (so a fish passing the lens or a borderline frame does not flip it),
// and the change is cross-faded over FADE seconds: both scenes are measured during the fade and their correction
// parameters are blended, so there is never a visible jump.
const devQ = devClip ? new URLSearchParams(location.search) : null; // localhost tuning: hold=, fade=, share=
const SCENE_HOLD = +(devQ && devQ.get('hold')) || 3, SCENE_FADE = +(devQ && devQ.get('fade')) || 1.5, SCENE_SHARE = +(devQ && devQ.get('share')) || 0.7;
class SceneTracker {
  constructor(key, fps, every) { this.cur = key; this.votes = []; this.cap = Math.max(2, Math.round(SCENE_HOLD * fps / every)); }
  vote(key) { // returns the scene to switch to, or null
    this.votes.push(key); if (this.votes.length > this.cap) this.votes.shift();
    if (this.votes.length < this.cap) return null;
    const c = {}; let best = null; for (const k of this.votes) { c[k] = (c[k] || 0) + 1; if (!best || c[k] > c[best]) best = k; }
    if (best !== this.cur && c[best] >= SCENE_SHARE * this.cap) { this.cur = best; return best; }
    return null;
  }
}
const lerp = (a, b, t) => a + (b - a) * t, lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
function blendParams(a, b, t) { return { mean: lerp3(a.mean, b.mean, t), scale: lerp3(a.scale, b.scale, t), low: lerp3(a.low, b.low, t), high: lerp3(a.high, b.high, t), satMul: lerp(a.satMul ?? 1, b.satMul ?? 1, t), gw: lerp(a.gw || 0, b.gw || 0, t), need: lerp(a.need ?? 1, b.need ?? 1, t) }; }
// greenWater from whichever side has it (the blended gw fades it in or out), so leaving a green hazy scene doesn't jump
function blendSettings(a, b, t) { return { ...b, blueAlpha: lerp(a.blueAlpha, b.blueAlpha, t), alphaRed: lerp(a.alphaRed, b.alphaRed, t), strength: lerp(a.strength, b.strength, t), sat: lerp(a.sat ?? 1, b.sat ?? 1, t), greenWater: b.greenWater || a.greenWater }; }
function sceneSummary(keys) {
  const L = keys.map(k => PRESETS[k].label); if (L.length <= 1) return L[0] || '';
  return L.length === 2 ? `${L[0]} → ${L[1]}` : `${L[0]} + ${L.length - 1} scene changes`;
}

// ---------- Demuxer (mp4box.js, streaming; handles moov-at-end like GoPro) ----------
const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
const aacASC = (sr, ch) => { let i = AAC_RATES.indexOf(sr); if (i < 0) i = 3; return new Uint8Array([(2 << 3) | (i >> 1), ((i & 1) << 7) | (ch << 3)]); };
// ---------- codec support ----------
// Human-readable codec name from an MP4 codec string, e.g. "hev1.2.4.L120.B0" -> "HEVC 10-bit".
function codecName(c) {
  const id = (c || '').split('.')[0].toLowerCase(), prof = (c || '').split('.')[1];
  if (id === 'avc1' || id === 'avc3') return 'H.264';
  if (id === 'hev1' || id === 'hvc1') return 'HEVC' + (prof === '2' ? ' 10-bit' : prof === '0' ? ' (header without profile)' : '');
  if (id === 'dvh1' || id === 'dvhe') return 'Dolby Vision';
  if (id === 'av01') return 'AV1';
  if (id === 'vp09' || id === 'vp08') return 'VP9';
  return c || 'unknown';
}
const isWindows = /Windows/i.test(navigator.userAgent), isMac = /Mac OS/i.test(navigator.userAgent);
let hevcEncWarned = false; const audioDropWarned = new Set(), audioPcmSeen = new Set();
const swDecodeSeen = new Set(); // codec names already explained to the user
// Prefer the hardware decoder; fall back to software; otherwise throw a message a non-technical user understands.
// Some cameras (Insta360 Ace Pro, some action cams and phone apps) write an HEVC header with profile 0 / level 0,
// which gives the codec string "hvc1.0.0.L0". Browsers reject that string although the stream itself is ordinary HEVC.
// Rebuild a valid string from the bit depth in the header and the frame size; the decoder still reads the real
// parameters from the stream's own SPS (in the description).
function hevcFallbacks(codec, desc, w, h) {
  const m = /^(hvc1|hev1)\.(\d+)\.[0-9A-Fa-f]+\.([LH])(\d+)/.exec(codec || ''); if (!m) return [];
  const prof = +m[2], level = +m[4]; if (prof > 0 && level > 0) return [];
  const bits = desc && desc.length > 18 ? (desc[17] & 7) + 8 : 8, px = (w || 3840) * (h || 2160);
  const lvl = level > 0 ? level : px > 3840 * 2176 ? 183 : px > 2048 * 1152 ? 153 : 123;
  const profs = bits > 8 ? ['2.4', '1.6'] : ['1.6', '2.4'];
  const out = [];
  for (const tag of [m[1], m[1] === 'hvc1' ? 'hev1' : 'hvc1']) for (const pr of profs) out.push(`${tag}.${pr}.L${lvl}.B0`);
  return out;
}
async function resolveDecoderConfig(base, soft = false) {
  const name = codecName(base.codec);
  const devSim = devClip ? new URLSearchParams(location.search).get('sim') : null; // localhost only: sim=sw | sim=none
  const codecs = [base.codec, ...hevcFallbacks(base.codec, base.description, base.codedWidth, base.codedHeight)];
  for (const hw of devSim === 'sw' ? ['no-preference'] : devSim === 'none' ? [] : soft ? ['prefer-software', 'no-preference'] : ['prefer-hardware', 'no-preference']) {
    for (const codec of codecs) {
      const cfg = { ...base, codec, hardwareAcceleration: hw };
      try { const r = await VideoDecoder.isConfigSupported(cfg); if (r.supported) { if (hw !== 'prefer-hardware' && !soft) noteSoftwareDecode(name); if (codec !== base.codec) { log(`codec string ${base.codec} -> ${codec}`); ccTrack('codec_fix', { from: base.codec, to: codec }); } return cfg; } } catch (_) { }
    }
  }
  if (codecs.length > 1) { // header looked broken and no repaired string helped either – do not blame the computer
    ccTrack('decode_unsupported', { codec: base.codec, name, repaired: true });
    throw new Error(`This file's video header is unusual (${base.codec}: profile/level missing – common on Insta360 and some action cams) and this browser could not decode it even after repairing the codec string. Please send the file name and camera model to jonas@jjsap.com; meanwhile, re-exporting the clip in the camera's own app as H.264 or standard HEVC will work.`);
  }
  const why = /Dolby/.test(name) ? 'Chrome cannot decode Dolby Vision. On an iPhone, turn off "HDR video" in Settings → Camera → Record Video, or export the clip as HEVC/H.264 first.'
    : /HEVC/.test(name) && isWindows ? 'This computer cannot play HEVC in Chrome. Install the free "HEVC Video Extensions from Device Manufacturer" from the Microsoft Store, or update your graphics driver, then reload this page.'
    : /H\.264/.test(name) ? 'Video decoding seems to be disabled in this browser. Update your graphics driver, check chrome://gpu, or try the latest Chrome or Edge.'
    : `Your browser cannot decode this video format. Try the latest Chrome or Edge, or convert the file to H.264 first.`;
  ccTrack('decode_unsupported', { codec: base.codec, name });
  throw new Error(`${name} video (${base.codec}) is not supported here. ${why}`);
}
function showNotice(html) {
  if (ui.hwNote) { ui.hwNote.innerHTML = html; ui.hwNote.hidden = false; }
  const toast = $('#appToast'), toastText = $('#appToastText');
  if (toast && toastText) {
    toastText.innerHTML = html;
    toast.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.hidden = true; }, 7000);
  }
}
function noteSoftwareDecode(name) {
  if (swDecodeSeen.has(name)) return; swDecodeSeen.add(name); ccTrack('software_decode', { codec: name });
  const tips = [], all = [...swDecodeSeen].join(' '); name = all; // tips cover every format seen so far
  if (isWindows && /HEVC/.test(name)) tips.push('Install the free <b>HEVC Video Extensions from Device Manufacturer</b> from the Microsoft Store – it enables the hardware decoder in Chrome on most PCs.');
  tips.push('Update your graphics driver, and check that <code>chrome://gpu</code> lists "Video Decode: Hardware accelerated".');
  if (/10-bit/.test(name)) tips.push('10-bit recording needs a newer GPU to decode in hardware. Recording in 8-bit avoids that.');
  if (!isMac) tips.push('If this is a virtual machine or a remote desktop, hardware decoding is usually unavailable – processing still works, just slower.');
  const names = [...swDecodeSeen].join(' and ');
  ui.hwNote.innerHTML = `<b>No hardware decoder for ${names} on this computer.</b> The tool still processes these videos – it just decodes them in software, so expect roughly a quarter of the usual speed. To make it faster:<ul>${tips.map(t => `<li>${t}</li>`).join('')}</ul>`;
  ui.hwNote.hidden = false;
}

// QuickTime files (iPhone .MOV) keep the AAC configuration inside a 'wave' box of a version-1 sound description,
// which mp4box does not parse – so the audio used to be dropped. Read the esds straight from the file instead.
async function qtEsdsASC(file, entry) {
  if (!(entry && entry.start >= 0 && entry.size > 16 && entry.size < 1e5)) return null;
  const b = new Uint8Array(await file.slice(entry.start, entry.start + entry.size).arrayBuffer());
  for (let i = 0; i + 12 < b.length; i++) {
    if (b[i] !== 0x65 || b[i + 1] !== 0x73 || b[i + 2] !== 0x64 || b[i + 3] !== 0x73) continue; // 'esds'
    let p = i + 8; const len = () => { let n = 0, c; do { c = b[p++]; n = (n << 7) | (c & 0x7f); } while ((c & 0x80) && p < b.length); return n; };
    if (b[p++] !== 3) return null; len(); p += 2; const fl = b[p++]; if (fl & 0x80) p += 2; if (fl & 0x40) p += 1 + b[p]; if (fl & 0x20) p += 2;
    if (b[p++] !== 4) return null; len(); const objectType = b[p]; p += 13; if (objectType !== 0x40) return null; // 0x40 = AAC
    if (b[p++] !== 5) return null; const n = len(); return n ? b.slice(p, p + n) : null;
  }
  return null;
}
// Uncompressed PCM sound in MP4/MOV – Sony's XAVC S ('twos', every RX100 / A7 / ZV / FX), QuickTime 'sowt'/'in24'/'fl32',
// the v2 'lpcm' description and ISO 'ipcm'/'fpcm' – can't be copied into the output (the muxer only takes AAC), and mp4box
// would hand it over as one "sample" per PCM frame (48 000 objects per second). So the sample table is read here, the
// bytes are pulled straight from the file in ¼-second pieces and encoded to AAC with the browser's AudioEncoder.
const PCM_TYPES = { twos: { bytes: 2, be: true }, sowt: { bytes: 2, be: false }, in24: { bytes: 3, be: true }, in32: { bytes: 4, be: true }, fl32: { bytes: 4, be: true, float: true }, fl64: { bytes: 8, be: true, float: true }, 'raw ': { bytes: 1, be: false, unsigned: true } };
async function pcmLayout(file, entry, stbl) {
  const type = entry.type; if (!(entry && entry.start >= 0 && entry.size >= 36 && entry.size < 1e5)) return null;
  const b = new Uint8Array(await file.slice(entry.start, entry.start + entry.size).arrayBuffer()), dv = new DataView(b.buffer);
  // mp4box's hdr_size for a sample entry (16) covers the box header plus the 8 SampleEntry bytes; the sound fields follow.
  const E = entry.hdr_size || 16, find = tag => { for (let i = E; i + 8 <= b.length; i++) if (b[i] === tag.charCodeAt(0) && b[i + 1] === tag.charCodeAt(1) && b[i + 2] === tag.charCodeAt(2) && b[i + 3] === tag.charCodeAt(3)) return i + 4; return -1; };
  const ver = dv.getUint16(E); let p;
  if (type === 'lpcm' && ver === 2) { // QuickTime SoundDescriptionV2: rate as double, flags say float / endian / signed / interleaved
    if (b.length < E + 56) return null;
    const flags = dv.getUint32(E + 44), bits = dv.getUint32(E + 40);
    if (flags & 32 || !(flags & 8) || ![8, 16, 24, 32, 64].includes(bits)) return null; // non-interleaved / unpacked: not handled
    p = { type, channels: dv.getUint32(E + 32), rate: dv.getFloat64(E + 24), bytes: bits / 8, be: !!(flags & 2), float: !!(flags & 1), unsigned: !(flags & 4) && bits === 8 };
  } else if (type === 'ipcm' || type === 'fpcm') { // ISO/IEC 23003-5: 'pcmC' box = version/flags, format_flags (bit 0: little-endian), sample size
    const c = find('pcmC'); if (c < 0 || c + 6 > b.length) return null; const bits = b[c + 5];
    if (![16, 24, 32, 64].includes(bits)) return null;
    p = { type, channels: dv.getUint16(E + 8), rate: dv.getUint32(E + 16) / 65536, bytes: bits / 8, be: !(b[c + 4] & 1), float: type === 'fpcm' };
  } else if (PCM_TYPES[type]) {
    p = { ...PCM_TYPES[type], type, channels: dv.getUint16(E + 8), rate: dv.getUint32(E + 16) / 65536 };
    if (type === 'twos' && dv.getUint16(E + 10) === 8) { p.bytes = 1; p.unsigned = false; } // 8-bit 'twos' is signed bytes
    const e = find('enda'); if (e >= 0 && e + 2 <= b.length && dv.getUint16(e) === 1) p.be = false; // QuickTime: 'enda' (value right after the tag) = little-endian samples
  } else return null;
  if (!(p.channels >= 1 && p.channels <= 8 && p.rate >= 8000 && p.rate <= 192000)) return null;
  if (p.float && p.bytes !== 4 && p.bytes !== 8) return null;
  // sample table (already parsed by mp4box): chunk offsets, samples per chunk, sample sizes -> byte runs in file order
  const stco = stbl.stco || stbl.co64; if (!(stbl.stsc && stco && stbl.stsz)) return null;
  const offs = stco.chunk_offsets || [], fc = stbl.stsc.first_chunk || [], spcA = stbl.stsc.samples_per_chunk || [], css = stbl.stsz.sample_size || 0, sizes = stbl.stsz.sample_sizes || [];
  if (!offs.length || !fc.length) return null;
  const runs = []; let k = 0, si = 0, total = 0;
  for (let c = 0; c < offs.length; c++) {
    while (si + 1 < fc.length && fc[si + 1] <= c + 1) si++;
    const spc = spcA[si] || 0; let bytes = 0;
    if (css) bytes = spc * css; else for (let j = 0; j < spc && k + j < sizes.length; j++) bytes += sizes[k + j];
    k += spc; if (bytes > 0) { runs.push({ off: offs[c], bytes }); total += bytes; }
  }
  const bpf = p.bytes * p.channels; p.runs = runs; p.frames = Math.floor(total / bpf);
  return p;
}
// One piece of PCM -> the sample format AudioData understands (little-endian s16/s32/f32/u8; 24-bit and doubles become f32).
function pcmToAudio(p, u, n) {
  const ch = p.channels, cnt = n * ch;
  if (p.bytes === 1) return { fmt: 'u8', buf: p.unsigned ? u : u.map(v => (v + 128) & 255) };
  if (p.bytes === 2) { if (p.be) for (let i = 0; i + 1 < u.length; i += 2) { const t = u[i]; u[i] = u[i + 1]; u[i + 1] = t; } return { fmt: 's16', buf: u }; }
  if (p.bytes === 4 && !p.float) { if (p.be) for (let i = 0; i + 3 < u.length; i += 4) { let t = u[i]; u[i] = u[i + 3]; u[i + 3] = t; t = u[i + 1]; u[i + 1] = u[i + 2]; u[i + 2] = t; } return { fmt: 's32', buf: u }; }
  const f = new Float32Array(cnt), dv = new DataView(u.buffer, u.byteOffset, u.byteLength), le = !p.be;
  if (p.bytes === 3) { for (let i = 0, o = 0; i < cnt; i++, o += 3) { let v = le ? (u[o] | (u[o + 1] << 8) | (u[o + 2] << 16)) : ((u[o] << 16) | (u[o + 1] << 8) | u[o + 2]); if (v & 0x800000) v -= 0x1000000; f[i] = v / 8388608; } }
  else if (p.bytes === 4) for (let i = 0; i < cnt; i++) f[i] = dv.getFloat32(i * 4, le);
  else for (let i = 0; i < cnt; i++) f[i] = dv.getFloat64(i * 8, le);
  return { fmt: 'f32', buf: f };
}
class Demuxer {
  constructor(file, opts = {}) { this.file = file; this.soft = !!opts.soft; this.size = file.size; this.mp4 = MP4Box.createFile(); this.q = { video: [], audio: [] }; this.eof = false; this.pos = 0; this.CHUNK = 8 << 20; }
  async _read(pos, len) { const b = await this.file.slice(pos, Math.min(this.size, pos + len)).arrayBuffer(); b.fileStart = pos; return b; }
  async init() {
    if (this.size < 4096) throw new Error(`The file is empty (${this.size} bytes). If it lives in OneDrive, iCloud or Google Drive, open the folder and make it available offline first, then try again.`);
    const mp4 = this.mp4; let info = null, err = null;
    mp4.onReady = i => { info = i; }; mp4.onError = e => { err = e; };
    // While parsing boxes, appendBuffer() returns the next needed offset – this jumps over the mdat to a moov at the end.
    let pos = 0, guard = 0;
    while (!info && !err && pos < this.size && guard++ < 50000) {
      const b = await this._read(pos, this.CHUNK); const next = mp4.appendBuffer(b);
      pos = next > pos ? next : pos + b.byteLength;
    }
    if (!info) throw new Error('Could not read the file index (moov). The file may be incomplete – a cloud placeholder that is not downloaded yet, a recording that was cut off, or not an MP4/MOV at all.' + (err ? ' (' + err + ')' : ''));
    const v = info.videoTracks[0]; if (!v) throw new Error('The file contains no video track.');
    // Phones store portrait video as landscape pixels plus a rotation in the track header; keep it in the output.
    const mx = v.matrix || []; this.rotation = mx.length >= 2 ? ((Math.round(Math.atan2(mx[1], mx[0]) * 2 / Math.PI) * 90) % 360 + 360) % 360 : 0;
    this.info = info; this.video = v; this.audio = info.audioTracks[0] || null;
    // The recording's creation date (mvhd), kept in the output so photo apps sort the corrected video with the original.
    { const c = info.created instanceof Date ? info.created.getTime() : 0; this.created = c > Date.UTC(1995, 0, 1) && c < Date.now() + 864e5 ? c : 0; }
    // The camera, from the maker's strings in the moov (udta): DJI writes an encoder tag, GoPro its model in CAME/FIRM, Apple the model key.
    this.camera = null; try { const mv = mp4.moov; if (mv && mv.size > 0 && mv.size < 16 << 20) this.camera = cameraOf(new Uint8Array(await this._read(mv.start, mv.size))); } catch (_) { }
    // mp4box only lists sound tracks whose sample entry it knows (mp4a …); PCM ('twos', 'sowt', 'lpcm' …) ends up in
    // otherTracks – find it by the track's handler.
    if (!this.audio) for (const t of info.otherTracks || []) { const tr = mp4.getTrackById(t.id); if (tr && tr.mdia && tr.mdia.hdlr && tr.mdia.hdlr.handler === 'soun') { this.audio = t; break; } }
    log(`tracks: video ${v.codec}, audio ${this.audio ? this.audio.codec : 'none'}${info.otherTracks && info.otherTracks.length ? ', other ' + info.otherTracks.map(t => t.codec).join('/') : ''}`);
    // Edit lists (e.g. clips trimmed with ffmpeg -ss) hide the first part of a track.
    const editStart = (trak, ts) => { const e = trak.edts && trak.edts.elst && trak.edts.elst.entries; if (!e || !e.length) return 0; const f = e.find(x => x.media_time >= 0); return f ? f.media_time / ts : 0; };
    const trakV = mp4.getTrackById(v.id);
    this.videoEdit = editStart(trakV, v.timescale);
    this.audioEdit = this.audio ? editStart(mp4.getTrackById(this.audio.id), this.audio.timescale) : 0;
    const entry = trakV.mdia.minf.stbl.stsd.entries[0];
    const box = entry.hvcC || entry.avcC || entry.av1C || entry.vpcC; let description;
    if (box) { const DS = MP4Box.DataStream || window.DataStream; const ds = new DS(undefined, 0, DS.BIG_ENDIAN); box.write(ds); description = new Uint8Array(ds.buffer, 8); }
    this.width = v.video.width; this.height = v.video.height;
    this.duration = info.duration / info.timescale;
    const trackDur = v.duration / v.timescale; if (!(this.duration > 0) || Math.abs(this.duration - trackDur) > Math.max(2, trackDur * 0.5)) this.duration = trackDur;
    this.fps = v.nb_samples / (v.duration / v.timescale);
    this.bitrate = v.bitrate || (this.size * 8 / this.duration);
    this.videoConfig = await resolveDecoderConfig({ codec: v.codec, codedWidth: this.width, codedHeight: this.height, description, optimizeForLatency: false }, this.soft);
    this.hw = this.videoConfig.hardwareAcceleration === 'prefer-hardware';
    if (this.audio) {
      const a = this.audio, ae = mp4.getTrackById(a.id).mdia.minf.stbl.stsd.entries[0]; let asc = null;
      try { asc = ae.esds.esd.descs[0].descs[0].data; } catch (_) { /* fall back below */ }
      let acodec = a.codec;
      if (!asc && acodec === 'mp4a') { try { asc = await qtEsdsASC(this.file, ae); } catch (_) { } if (asc && asc.length) { acodec = 'mp4a.40.' + (asc[0] >> 3); log(`QuickTime audio config read from file: ${acodec}`); } }
      // 'mp4a' whose esds could not be parsed is still AAC in practice (AAC-LC assumed) – better than silence.
      if (acodec === 'mp4a' && !asc) { acodec = 'mp4a.40.2'; log('audio: mp4a without a readable esds, assuming AAC-LC'); }
      const isAAC = /^mp4a\.40/.test(acodec);
      if (isAAC) this.audioConfig = { codec: acodec, sampleRate: a.audio.sample_rate, numberOfChannels: a.audio.channel_count, description: asc && asc.length ? asc : aacASC(a.audio.sample_rate, a.audio.channel_count) };
      else {
        // Not AAC: uncompressed PCM is read from the file and encoded to AAC while processing (see pcmLayout); anything else is dropped.
        let pcm = null; if (typeof AudioEncoder !== 'undefined') { try { pcm = await pcmLayout(this.file, ae, mp4.getTrackById(a.id).mdia.minf.stbl); } catch (e) { log('pcm: ' + (e && e.message)); } }
        if (pcm && pcm.frames > 0) { this.pcm = pcm; this.audioConfig = { codec: 'mp4a.40.2', sampleRate: pcm.rate, numberOfChannels: pcm.channels, description: aacASC(pcm.rate, pcm.channels) }; log(`PCM sound: ${pcm.type} ${pcm.bytes * 8}-bit ${pcm.channels}ch ${pcm.rate} Hz, ${pcm.runs.length} chunks -> AAC`); }
        else { this.audioDropped = acodec || a.codec || 'unknown'; this.audio = null; } // only AAC can be copied into MP4 by the muxer
      }
    } else this.audioConfig = null;
    return this;
  }
  // t is media time (seconds). Order matters: options -> seek -> start, otherwise
  // start() extracts samples from already-buffered data and seek() re-extracts them.
  start(t = 0, withAudio = false) {
    const mp4 = this.mp4;
    this.q.video.length = 0; this.q.audio.length = 0; this.eof = false;
    mp4.onSamples = (id, u, samples) => { const k = id === this.video.id ? 'video' : 'audio'; for (const s of samples) this.q[k].push(s); };
    mp4.setExtractionOptions(this.video.id, null, { nbSamples: 40 });
    if (withAudio && this.audio && !this.pcm) mp4.setExtractionOptions(this.audio.id, null, { nbSamples: 200 });
    const sk = mp4.seek(t, true); this.pos = sk.offset;
    mp4.start();
  }
  // Sequential feed from the seek offset. appendBuffer()'s return value is only
  // trustworthy while parsing boxes (init); during extraction it points past
  // already-buffered regions (the moov at the end) and would skip the mdat.
  async _feed() {
    if (this.pos >= this.size) { if (!this.eof) { this.eof = true; this.mp4.flush(); } return; }
    const b = await this._read(this.pos, this.CHUNK); this.mp4.appendBuffer(b); this.pos += b.byteLength;
    if (this.pos >= this.size) { this.eof = true; this.mp4.flush(); }
  }
  async next(kind) { while (this.q[kind].length === 0 && !this.eof) await this._feed(); return this.q[kind].shift() || null; }
  release(s, kind) { try { this.mp4.releaseUsedSamples(kind === 'video' ? this.video.id : this.audio.id, s.number); } catch (_) { } }
  chunk(s) { let ts = Math.round(s.cts * 1e6 / s.timescale); if (DEV_BADTS && s.number % 50 === 25) ts -= 2 * Math.round(s.duration * 1e6 / s.timescale); /* dev: simulate a recorder with out-of-order timestamps */ return new EncodedVideoChunk({ type: s.is_sync ? 'key' : 'delta', timestamp: ts, duration: Math.round(s.duration * 1e6 / s.timescale), data: s.data }); }
  close() { try { this.mp4.stop(); } catch (_) { } }
  // Decode a single frame at presentation time t (seconds) for the preview.
  async frameAt(t) {
    t = Math.max(0, t) + this.videoEdit; // -> media time
    this.start(t, false);
    const target = t * 1e6;
    return new Promise(async (res, rej) => {
      let got = null, n = 0;
      const dec = new VideoDecoder({ output: f => { if (!got && f.timestamp >= target - 1) got = f; else f.close(); }, error: rej });
      try {
        dec.configure(this.videoConfig);
        let s;
        while ((s = await this.next('video'))) { dec.decode(this.chunk(s)); n++; if (s.cts / s.timescale > t + 0.6 || n > 400) break; while (dec.decodeQueueSize > 12) await sleep(2); }
        await dec.flush();
      } catch (e) { rej(e); return; } finally { try { dec.close(); } catch (_) { } }
      got ? res(got) : rej(new Error('Could not decode a preview frame from this file.'));
    });
  }
}

// ---------- encoder selection ----------
// H.264 first (plays everywhere) unless the user picked HEVC; above 4K only HEVC is possible.
// HEVC level from the frame size and rate (Robert, DJI Action 6 at 3840×3840: level 5.2 allows 8.9 M luma samples, that
// frame has 14.7 M, so it needs 6.0 – a fixed level made the browser refuse HEVC and fall back to H.264 at lower quality).
// Levels: [name, max luma samples per picture, max luma samples per second]. Above 35.6 M samples HEVC is not possible.
const HEVC_LEVELS = [['120', 2228224, 66846720], ['123', 2228224, 133693440], ['150', 8912896, 267386880], ['153', 8912896, 534773760], ['156', 8912896, 1069547520], ['180', 35651584, 1069547520], ['183', 35651584, 2139095040], ['186', 35651584, 4278190080]];
function hevcLevels(W, H, fps) {
  const px = W * H, rate = px * Math.max(1, fps);
  const i = HEVC_LEVELS.findIndex(([, p, r]) => px <= p && rate <= r);
  return i < 0 ? [] : HEVC_LEVELS.slice(Math.max(i, 3)).map(l => l[0]); // never below 5.1 (what every encoder offers), then up
}
// 'quantizer': no bitrate at all – a fixed quality (QP per frame) for hardware encoders that ignore the bitrate they are
// asked for (Robert: NVIDIA through Chrome on Windows delivered 34.6 Mbit/s whatever was requested, 10.7 for H.264).
async function pickEncoder(W, H, fps, bitrate, pref = 'avc', mode = 'variable', latency = 'quality') {
  W = Math.max(2, Math.floor(W / 2) * 2);
  H = Math.max(2, Math.floor(H / 2) * 2);
  const isMob = IS_MOBILE || IS_ANDROID;
  if (isMob) {
    fps = Math.min(fps, 30);
    bitrate = Math.min(bitrate, 12e6);
  }
  const qp = mode === 'quantizer';
  const avcCodecs = [
    'avc1.4d002a', // Main Level 4.2
    'avc1.42002a', // Baseline Level 4.2
    'avc1.64002a', // High Level 4.2
    'avc1.4d0028', // Main Level 4.0
    'avc1.420028', // Baseline Level 4.0
    'avc1.640028', // High Level 4.0
    'avc1.4d001f', // Main Level 3.1
    'avc1.42001f', // Baseline Level 3.1
    'avc1.42001e', // Baseline Level 3.0
    'avc1.640034', // High Level 5.2
    'avc1.640033', // High Level 5.1
  ];
  const avc = avcCodecs.map(codec => ({ codec, avc: { format: 'avc' }, mux: 'avc' }));
  const lv = hevcLevels(W, H, fps), tier = !qp && bitrate > 40e6 ? ['H', 'L'] : ['L'];
  const hevc = [];
  for (const t of tier) for (const l of lv) hevc.push(`hev1.1.6.${t}${l}.B0`);
  if (lv.length) hevc.push(`hvc1.1.6.L${lv[0]}.B0`);
  const cands = [...(pref === 'hevc' ? [] : avc), ...hevc.map(codec => ({ codec, hevc: { format: 'hevc' }, mux: 'hevc' })), ...(pref === 'hevc' ? avc : [])];

  const hwList = ['prefer-hardware', 'no-preference', 'prefer-software'];
  const latList = latency === 'realtime' ? ['realtime', undefined] : [latency, 'realtime', undefined];
  const bModeList = mode === 'variable' ? ['variable', undefined, 'constant'] : [mode, 'variable', undefined];

  for (const hw of hwList) {
    for (const c of cands) {
      for (const lat of latList) {
        for (const bMode of bModeList) {
          const cfg = {
            width: W,
            height: H,
            codec: c.codec,
            hardwareAcceleration: hw,
            alpha: 'discard',
            ...(qp ? {} : { bitrate: Math.round(bitrate) }),
            ...(bMode ? { bitrateMode: bMode } : {}),
            ...(fps ? { framerate: Math.round(fps * 100) / 100 } : {}),
            ...(lat ? { latencyMode: lat } : {}),
            ...(c.avc ? { avc: c.avc } : {}),
            ...(c.hevc ? { hevc: c.hevc } : {})
          };
          const label = (c.mux === 'avc' ? 'H.264' : 'HEVC') + (hw === 'prefer-hardware' ? '' : ' (software)');
          try {
            if ((await VideoEncoder.isConfigSupported(cfg)).supported) return { cfg, mux: c.mux, label };
          } catch (_) { }
          // If dictionary format is rejected by mobile WebCodecs, test without it
          if (c.avc || c.hevc) {
            const { avc: _a, hevc: _h, ...cleanCfg } = cfg;
            try {
              if ((await VideoEncoder.isConfigSupported(cleanCfg)).supported) return { cfg: cleanCfg, mux: c.mux, label };
            } catch (_) { }
          }
        }
      }
    }
  }
  if (!qp && bitrate > 8e6) {
    return pickEncoder(W, H, fps, 8e6, pref, 'variable', 'realtime');
  }
  if (!qp && bitrate > 4e6) {
    return pickEncoder(W, H, fps, 4e6, pref, 'variable', 'realtime');
  }
  throw new Error('Resolusi video melebihi batas hardware perangkat.');
}
// Fixed-quality value for the output-quality setting (QP 0–51, lower = better): Maximum 14, High 19, Standard 24, Small 28.
const qpFor = quality => Math.round(14 + (1 - Math.min(1, Math.max(0, quality))) * 19);

// ---------- photos ----------
// Photos go through the same measurement and shader as a single video frame. Output is always JPEG; the original
// EXIF (date, camera, GPS) is copied into it so galleries and Lightroom keep the order. HEIC (iPhone) is decoded
// natively where the browser can (Safari) and otherwise with libheif (heic-to, loaded only when a HEIC file appears).
const IMG_RE = /\.(jpe?g|png|webp|avif|heic|heif)$/i;
const isImageFile = f => IMG_RE.test(f.name) || /^image\//.test(f.type || '');
const isHeicFile = f => /\.(heic|heif)$/i.test(f.name) || /image\/hei[cf]/.test(f.type || '');
const isPhoto = it => !!(it && (it.photo || (it.info && it.info.photo)));
let heicLib = null;
function loadHeic() {
  return heicLib || (heicLib = new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = '/color-correction/vendor/heic-to.js';
    s.onload = () => window.HeicTo ? res(window.HeicTo) : rej(new Error('HEIC decoder missing'));
    s.onerror = () => { heicLib = null; rej(new Error('Could not load the HEIC decoder – check the connection and try again.')); };
    document.head.appendChild(s);
  }));
}
async function decodeImage(file) {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (e) { if (!isHeicFile(file)) throw new Error(`This image could not be read (${e.message || e.name || 'unknown format'}).`); }
  const HeicTo = await loadHeic(); // libheif applies the HEIF rotation itself
  try { return await HeicTo({ blob: file, type: 'bitmap' }); } catch (e) { throw new Error(`This HEIC photo could not be decoded (${e.message || e}).`); }
}
async function scaledBitmap(bmp, maxW) { if (bmp.width <= maxW) return bmp; return createImageBitmap(bmp, { resizeWidth: maxW, resizeHeight: Math.round(bmp.height * maxW / bmp.width), resizeQuality: 'high' }); }
// Largest size this device can render and encode in one piece (iOS canvases stop at ~16.7 MP).
function photoScale(w, h) {
  const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS), lim = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), vp[0], vp[1]);
  const area = IS_IOS ? 16e6 : IS_MOBILE ? 48e6 : 120e6;
  return Math.min(1, lim / w, lim / h, Math.sqrt(area / (w * h)));
}
// EXIF: read the TIFF block from a JPEG (APP1) or a HEIF ('Exif' item), set Orientation to 1 (the pixels are
// already upright) and drop the embedded thumbnail (it would show the uncorrected photo in some viewers).
async function readExifTiff(file) {
  const head = new Uint8Array(await file.slice(0, 1 << 20).arrayBuffer());
  if (head[0] === 0xFF && head[1] === 0xD8) {
    for (let i = 2; i + 10 < head.length && head[i] === 0xFF;) {
      const m = head[i + 1], len = (head[i + 2] << 8) | head[i + 3];
      if (m === 0xE1 && head[i + 4] === 0x45 && head[i + 5] === 0x78 && head[i + 6] === 0x69 && head[i + 7] === 0x66 && head[i + 8] === 0 && head[i + 9] === 0) return head.slice(i + 10, i + 2 + len);
      if (m === 0xDA) break; i += 2 + len;
    }
    return null;
  }
  return heifExif(file, head);
}
async function heifExif(file, b) {
  const dv = new DataView(b.buffer), u32 = o => dv.getUint32(o), u16 = o => dv.getUint16(o), t4 = o => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  const boxes = (s, e) => { const out = []; for (let o = s; o + 8 <= e;) { let sz = u32(o); const ty = t4(o + 4); let hs = 8; if (sz === 1) { sz = u32(o + 12); hs = 16; } else if (sz === 0) sz = e - o; if (sz < 8) break; out.push({ ty, o, hs, end: Math.min(e, o + sz) }); o += sz; } return out; };
  const meta = boxes(0, b.length).find(x => x.ty === 'meta'); if (!meta) return null;
  const kids = boxes(meta.o + meta.hs + 4, meta.end), iinf = kids.find(x => x.ty === 'iinf'), iloc = kids.find(x => x.ty === 'iloc'); if (!iinf || !iloc) return null;
  let p = iinf.o + iinf.hs; const iv = b[p]; p += 4; p += iv === 0 ? 2 : 4; let exifId = -1;
  for (const e of boxes(p, iinf.end)) { if (e.ty !== 'infe') continue; const v = b[e.o + e.hs], q = e.o + e.hs + 4; if (v < 2) continue; const id = v === 2 ? u16(q) : u32(q), ty = t4(q + (v === 2 ? 4 : 6)); if (ty === 'Exif') { exifId = id; break; } }
  if (exifId < 0) return null;
  p = iloc.o + iloc.hs; const lv = b[p]; p += 4; const os = b[p] >> 4, ls = b[p] & 15, bs = b[p + 1] >> 4, is = lv ? b[p + 1] & 15 : 0; p += 2;
  const rd = n => { let v = 0; for (let k = 0; k < n; k++) v = v * 256 + b[p + k]; p += n; return v; };
  const cnt = lv < 2 ? rd(2) : rd(4);
  for (let k = 0; k < cnt; k++) {
    const id = lv < 2 ? rd(2) : rd(4); const cm = lv ? rd(2) & 15 : 0; rd(2); const base = rd(bs); const ec = rd(2); let off = 0, len = 0;
    for (let x = 0; x < ec; x++) { if (lv && is) rd(is); const o = rd(os), l = rd(ls); if (x === 0) { off = o; len = l; } }
    if (id !== exifId) continue; if (cm !== 0 || !len) return null;
    const d = new Uint8Array(await file.slice(base + off, base + off + len).arrayBuffer());
    const t = d.slice(4 + new DataView(d.buffer).getUint32(0));
    return t[0] === 0x45 && t[1] === 0x78 ? t.slice(6) : t; // some writers keep the "Exif\0\0" prefix
  }
  return null;
}
function cleanTiff(t) {
  if (!t || t.length < 16) return null;
  const le = t[0] === 0x49; if (!(le || t[0] === 0x4D)) return null;
  const dv = new DataView(t.buffer, t.byteOffset, t.byteLength), u16 = o => dv.getUint16(o, le), u32 = o => dv.getUint32(o, le);
  const ifd = u32(4); if (ifd + 2 > t.length) return null; const n = u16(ifd); if (ifd + 6 + n * 12 > t.length) return null;
  for (let k = 0; k < n; k++) { const e = ifd + 2 + k * 12; if (u16(e) === 0x0112) dv.setUint16(e + 8, 1, le); }
  dv.setUint32(ifd + 2 + n * 12, 0, le);
  return t;
}
async function withExif(jpeg, tiff) {
  if (!tiff || tiff.length + 8 > 65533) return jpeg;
  const j = new Uint8Array(await jpeg.arrayBuffer()); let at = 2;
  if (j[2] === 0xFF && j[3] === 0xE0) at = 4 + ((j[4] << 8) | j[5]); // keep JFIF first
  const seg = new Uint8Array(10 + tiff.length), L = 8 + tiff.length;
  seg.set([0xFF, 0xE1, L >> 8, L & 255, 0x45, 0x78, 0x69, 0x66, 0, 0]); seg.set(tiff, 10);
  return new Blob([j.subarray(0, at), seg, j.subarray(at)], { type: 'image/jpeg' });
}
const JPEG_Q = { 1: 0.95, 0.75: 0.93, 0.45: 0.9, 0.25: 0.8 };
async function writePhoto(item, name, blob) {
  item.outName = name;
  item.outFile = new File([blob], name, { type: 'image/jpeg' });
  if (dirHandle) {
    try {
      const fh = await dirHandle.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(blob);
      await w.close();
      item.outHandle = fh;
    } catch (_) {}
  }
  return blob.size;
}
async function processPhoto(item, base, onProgress) {
  let bmp; try { bmp = await decodeImage(item.file); } catch (e) { throw stepErr('read photo', e); }
  let exif = null; try { exif = await readExifTiff(item.file); } catch (_) { }
  curCamera = exif ? cameraOf(exif.subarray(0, 4096)) : null;
  let W = bmp.width, H = bmp.height; item.downscaled = null;

  // Cap photo on mobile/Android to FHD (max 1920px) for instant processing and smooth saving
  const maxDim = (IS_MOBILE || IS_ANDROID) ? 1920 : 3840;
  const maxSide = Math.max(W, H);
  if (maxSide > maxDim) {
    const scale = maxDim / maxSide;
    const targetW = Math.max(2, Math.round(W * scale));
    const targetH = Math.max(2, Math.round(H * scale));
    const nb = await createImageBitmap(bmp, { resizeWidth: targetW, resizeHeight: targetH, resizeQuality: 'high' });
    bmp.close(); bmp = nb; W = nb.width; H = nb.height; item.downscaled = `${W}×${H} (FHD)`;
  } else {
    const sc = photoScale(W, H);
    if (sc < 1) {
      const nb = await createImageBitmap(bmp, { resizeWidth: Math.round(W * sc), resizeHeight: Math.round(H * sc), resizeQuality: 'high' });
      bmp.close(); bmp = nb; W = nb.width; H = nb.height; item.downscaled = `${W}×${H}`;
    }
  }
  ui.glc.width = W; ui.glc.height = H;
  if (gl.drawingBufferWidth < W || gl.drawingBufferHeight < H) {
    const f = Math.min(gl.drawingBufferWidth / W, gl.drawingBufferHeight / H);
    const nb = await createImageBitmap(bmp, { resizeWidth: Math.floor(W * f), resizeHeight: Math.floor(H * f), resizeQuality: 'high' });
    bmp.close(); bmp = nb; W = nb.width; H = nb.height; ui.glc.width = W; ui.glc.height = H; item.downscaled = `${W}×${H}`;
  }
  setWatermark(W, H); ui.cmp.style.aspectRatio = `${W} / ${H}`; ui.cmp.classList.add('live'); ui.pvEmpty.hidden = true;
  item.bTotal = 1; showInfo(item); onProgress(0, 1, null);
  const adj = adjFor(item); let s = adj.scene !== 'auto' ? withAdj(presetSettings(adj.scene), adj) : base, label = adj.scene !== 'auto' ? PRESETS[adj.scene].label : 'Auto', copy;
  try {
    uploadFrame(bmp);
    if (adj.scene === 'auto') { const key = classifyTexture(); s = withAdj(presetSettings(key), adj); label = PRESETS[key].label; item.detected = key; followItem(item, key); render(measure(s, false), s); }
    else render(measure(s), s);
    copy = document.createElement('canvas'); copy.width = W; copy.height = H; copy.getContext('2d').drawImage(ui.glc, 0, 0);
    item.thumb = snapshot(ui.glc);
  } catch (e) { throw stepErr('colour correction', e); } finally { bmp.close(); }
  let blob = await new Promise((res, rej) => copy.toBlob(b => b ? res(b) : rej(stepErr('encode JPEG', new Error('Gagal kompresi foto.'))), 'image/jpeg', JPEG_Q[base.quality] || 0.9));
  copy.width = copy.height = 0;
  try {
    exif = cleanTiff(exif);
    if (exif) blob = await withExif(blob, exif);
  } catch (_) { }
  let bytes; try { bytes = await writePhoto(item, outBase(item) + '_corrected.jpg', blob); } catch (e) { throw stepErr('save file', e); }
  onProgress(1, 1, label); ui.cmp.classList.remove('live');
  return { frames: 1, pixels: W * H, bytes, codec: 'JPEG' + (exif ? ' + EXIF' : '') + (item.downscaled ? ' ' + item.downscaled : ''), bitrate: 0, scene: label, photo: true };
}

// ---------- state & settings ----------
const items = []; let selected = -1, dirHandle = null, running = false, cancelled = false;
let previewFrame = null, previewItem = null, previewPromise = Promise.resolve();
let hidden = { alphaRed: PRESETS.reef.alphaRed, pct: PRESETS.reef.pct, capR: PRESETS.reef.capR, floorB: PRESETS.reef.floorB, minSpan: PRESETS.reef.minSpan, satCap: PRESETS.reef.satCap, waterKeep: 0 }; // parameters without UI controls
let applying = false;
// Fine-tune sliders (step 2) are macro knobs over the preset's hidden parameters:
//   Red recovery = alphaRed×100, red cap scaled with it; Contrast = clipped percentile×5000 (1 % → 50), contrast cap scaled inversely;
//   Saturation = multiplier on top of the hazy-water guard. Each preset sets them; touching one switches to Custom like the other controls.
const redPos = p => Math.round(p.alphaRed * 100), conPos = p => Math.round(p.pct[0] * 5000), satPos = p => Math.round((p.sat ?? 1) * 100);
function fineTune(base) {
  const r = +ui.redRec.value / 100, c = +ui.contrast.value, rp = base.alphaRed, cp = Math.round(base.pct[0] * 5000);
  const capR = rp > 0 ? 1 + (base.capR - 1) * (r / rp) : base.capR;
  const lo = c / 5000, minSpan = Math.min(0.9, Math.max(0.2, base.minSpan * Math.sqrt(Math.max(cp, 1) / Math.max(c, 5))));
  return { alphaRed: r, capR, pct: c === cp ? base.pct : [lo, 1 - lo], minSpan: c === cp ? base.minSpan : minSpan, sat: +ui.saturation.value / 100 };
}
// Smoothing is an output setting (step 3): Auto keeps each scene's own window, anything else applies to every video.
const smoothFor = w => ui.smooth.value === 'auto' ? w : +ui.smooth.value;
const settings = () => ({
  scene: ui.scene.value,
  strength: ui.strength.value / 100, blueAlpha: ui.greenish.checked ? 1 : 0,
  window: smoothFor(PRESETS[ui.scene.value] ? PRESETS[ui.scene.value].window : 15), measureEvery: +ui.measureEvery.value, quality: +ui.quality.value, outSize: +ui.outSize.value, outCodec: ui.outCodec.value, denoise: ui.denoise.value,
  floorB: hidden.floorB, satCap: hidden.satCap, waterKeep: hidden.waterKeep || 0, greenWater: hidden.greenWater || null, ...fineTune(hidden), warm: +ui.warmth.value / 100,
});
// Resolve the effective parameters for a preset key, keeping the user's quality choice.
const presetSettings = key => { const p = PRESETS[key]; return { ...settings(), scene: key, strength: p.strength, blueAlpha: p.blue, window: smoothFor(p.window), alphaRed: p.alphaRed, pct: p.pct, capR: p.capR, floorB: p.floorB, minSpan: p.minSpan, satCap: p.satCap, sat: p.sat ?? 1, waterKeep: p.waterKeep || 0, greenWater: p.greenWater || null }; };
function applyPreset(key, detected = false) {
  const p = PRESETS[key]; applying = true;
  ui.strength.value = Math.round(p.strength * 100); ui.greenish.checked = p.blue > 0;
  ui.redRec.value = redPos(p); ui.contrast.value = conPos(p); ui.saturation.value = satPos(p);
  hidden = { alphaRed: p.alphaRed, pct: p.pct, capR: p.capR, floorB: p.floorB, minSpan: p.minSpan, satCap: p.satCap, waterKeep: p.waterKeep || 0, greenWater: p.greenWater || null };
  syncOutputs();
  if (!detected) ui.scene.value = key;
  ui.scene.options[0].textContent = detected ? `Auto (recommended) – detected: ${p.label}` : 'Auto (recommended)';
  ui.sceneNote.textContent = (detected ? '' : 'Diterapkan ke semua file di antrean. ') + {
    hazy: 'Air dangkal berpasir atau keruh (snorkeling, partikel sedimen). Menahan kontras dan saturasi agar warna bawah air tetap alami dan jernih.',
    deep: 'Sebagian besar bingkai berupa air biru tua/terbuka. Memberikan pengangkatan lembut agar warna biru tidak berubah menjadi ungu.',
    blue: 'Kompensasi spektrum merah seimbang menjaga air terbuka tetap biru alami, bukan sian/toska. Cocok untuk sudut lebar (wide shot).',
    reef: 'Koreksi spektrum penuh dengan kontras seimbang. Pilihan utama untuk terumbu karang tropis dan bangkai kapal (wreck).',
    macro: 'Rentang dinamis optimal melindungi highlight dari sorotan senter / strobe; responsif mengikuti gerakan subjek dekat.',
    green: 'Kompensasi spektrum biru untuk danau, muara, atau perairan tropis kaya alga hijau.'
  }[key];
  applying = false;
}
// Steps 2 and 3 are collapsible; the closed header shows the current values so nothing is hidden by surprise.
function stepSummaries() {
  const s2 = $('#sum2'), s3 = $('#sum3'); if (!s2 || !s3) return;
  const sc = ui.scene.value, st = +ui.strength.value;
  const nAdj = items.filter(x => x.adj && adjActive(x.adj)).length, gAdj = adjActive(globalAdj);
  s2.textContent = (sc === 'auto' ? 'Otomatis – deteksi cerdas sesuai pemandangan' : PRESETS[sc] ? PRESETS[sc].label : 'Otomatis') + (gAdj ? ' · disesuaikan untuk semua' : nAdj ? ` · ${nAdj} file disesuaikan` : '');
  const size = { 3840: 'Hingga 4K', 0: 'Ukuran Asli', 1920: '1080p' }[ui.outSize.value] || '', q = { '1': 'Kualitas Maksimum', '0.75': 'Tinggi', '0.45': 'Standar', '0.25': 'Ukuran Kecil' }[ui.quality.value] || '';
  s3.textContent = `${size} · ${ui.outCodec.value === 'hevc' ? 'HEVC · ' : 'H.264 · '}${q} · ${ui.warmthOut.textContent}`;
}
for (const id of ['step2', 'step3']) {
  const d = $('#' + id); if (!d) continue;
  try { if (localStorage.getItem('cc-open-' + id) === '1') d.open = true; } catch (_) { }
  d.addEventListener('toggle', () => { try { localStorage.setItem('cc-open-' + id, d.open ? '1' : '0'); } catch (_) { } if (d.open) ccTrack('step_open', { step: id }); });
}
function syncOutputs() {
  setTimeout(stepSummaries, 0);
  ui.strengthOut.textContent = ui.strength.value + ' %'; ui.strength.style.setProperty('--fill', ui.strength.value + '%');
  ui.redRecOut.textContent = ui.redRec.value; ui.redRec.style.setProperty('--fill', (ui.redRec.value / 150 * 100) + '%');
  ui.contrastOut.textContent = ui.contrast.value; ui.contrast.style.setProperty('--fill', ui.contrast.value + '%');
  ui.saturationOut.textContent = ui.saturation.value + ' %'; ui.saturation.style.setProperty('--fill', ((ui.saturation.value - 50) / 100 * 100) + '%');
  const w = +ui.warmth.value; ui.warmthOut.textContent = w === 0 ? 'Neutral' : w > 0 ? `+${w} warmer` : `${-w} cooler`; ui.warmth.style.setProperty('--fill', ((w + 50) / 100 * 100) + '%');
}
// ---------- per-video adjustments ----------
// Manual changes are stored as DELTAS on top of Auto (+30 red recovery, −10 contrast …), so scene detection and the
// scene changes inside a video keep working. "This video" (default) stores them on the selected file; "All videos"
// stores one set for the whole queue (and clears per-file ones). Picking a fixed scene is part of the same set.
const EMPTY_ADJ = () => ({ scene: 'auto', d: { strength: 0, red: 0, contrast: 0, sat: 0 }, green: null });
let globalAdj = EMPTY_ADJ(), applyTo = 'this';
const adjFor = it => (it && it.adj) || globalAdj;
const adjActive = a => !!a && (a.scene !== 'auto' || a.green !== null || Object.values(a.d).some(v => v));
const baseKeyFor = (it, a) => a.scene !== 'auto' ? a.scene : (it && it.detected) || 'reef';
const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function withAdj(ps, a) { // apply a set of deltas to resolved preset settings (same maths as the sliders)
  if (!adjActive(a)) return ps;
  const r = clampN(ps.alphaRed + a.d.red / 100, 0, 1.5), capR = ps.alphaRed > 0 ? 1 + (ps.capR - 1) * (r / ps.alphaRed) : ps.capR;
  const cp = Math.round(ps.pct[0] * 5000), c = clampN(cp + a.d.contrast, 0, 100), lo = c / 5000;
  const minSpan = c === cp ? ps.minSpan : Math.min(0.9, Math.max(0.2, ps.minSpan * Math.sqrt(Math.max(cp, 1) / Math.max(c, 5))));
  return { ...ps, strength: clampN(ps.strength + a.d.strength / 100, 0, 1), blueAlpha: a.green === null ? ps.blueAlpha : (a.green ? 1 : 0), alphaRed: r, capR,
    pct: c === cp ? ps.pct : [lo, 1 - lo], minSpan, sat: clampN((ps.sat ?? 1) + a.d.sat / 100, 0.5, 1.5),
    greenWater: a.green === false && ps.greenWater ? { ...ps.greenWater, blue: 0 } : ps.greenWater }; // "greenish" unticked = no blue compensation, also in green hazy water
}
// put a preset plus a set of deltas into the controls (what the selected / running video actually uses)
function showAdjusted(key, a) {
  applyPreset(key, true); applying = true;
  ui.strength.value = clampN(+ui.strength.value + a.d.strength, 0, 100); ui.redRec.value = clampN(+ui.redRec.value + a.d.red, 0, 150);
  ui.contrast.value = clampN(+ui.contrast.value + a.d.contrast, 0, 100); ui.saturation.value = clampN(+ui.saturation.value + a.d.sat, 50, 150);
  if (a.green !== null) ui.greenish.checked = a.green;
  ui.scene.value = a.scene; syncOutputs(); applying = false; updateAdjUi();
}
// a slider / checkbox was moved by the user: store the difference to the preset as this video's (or everyone's) delta
function userTweak() {
  if (applying) return;
  const it = previewItem, a = applyTo === 'all' || !it ? globalAdj : (it.adj = it.adj || JSON.parse(JSON.stringify(globalAdj)));
  const p = PRESETS[baseKeyFor(it, a)];
  a.d.strength = +ui.strength.value - Math.round(p.strength * 100); a.d.red = +ui.redRec.value - redPos(p);
  a.d.contrast = +ui.contrast.value - conPos(p); a.d.sat = +ui.saturation.value - satPos(p);
  a.green = ui.greenish.checked === (p.blue > 0) ? null : ui.greenish.checked;
  if (applyTo === 'all') for (const x of items) delete x.adj;
  renderQueue(); updateAdjUi(); stepSummaries();
}
function updateAdjUi() {
  const n = $('#adjNote'), r = $('#adjReset'); if (!n) return;
  const it = previewItem, own = !!(it && it.adj), a = adjFor(it), on = adjActive(a);
  n.textContent = !on ? 'Your changes are added on top of Auto, so scene detection keeps working.'
    : applyTo === 'all' || !own ? 'Adjusted for all videos – on top of Auto, so scene detection keeps working.'
    : 'Adjusted for this video only – on top of Auto, so scene detection keeps working.';
  if (r) r.hidden = !on;
}

// ---------- queue UI ----------
// Remembers which files were corrected in this browser (name + size), so a file picked again shows "corrected before" –
// Birgit: with the gallery's numeric names it was hard to tell which clips were already done.
const DONE_KEY = 'cc-done'; let doneMap = {}; try { doneMap = JSON.parse(localStorage.getItem(DONE_KEY) || '{}') || {}; } catch (_) { }
const doneKeyOf = f => `${f.name}|${f.size}`, doneBefore = it => doneMap[doneKeyOf(it.file)] || 0;
function rememberDone(it) {
  try {
    doneMap[doneKeyOf(it.file)] = Date.now(); const ks = Object.keys(doneMap);
    if (ks.length > 500) for (const k of ks.sort((a, b) => doneMap[a] - doneMap[b]).slice(0, ks.length - 500)) delete doneMap[k];
    localStorage.setItem(DONE_KEY, JSON.stringify(doneMap));
  } catch (_) { }
}
function renderQueue() {
  ui.queue.innerHTML = '';
  items.forEach((it, i) => {
    const li = document.createElement('li'); li.className = 'qi ' + it.status + (i === selected ? ' sel' : '');
    const meta = it.info ? (it.info.photo ? `Photo · ${it.info.width}×${it.info.height} · ${fmtMB(it.file.size)}` : `${resLabel(it.info.width, it.info.height)} · ${fmtFps(it.info.fps)} fps · ${fmtClock(it.info.duration)} · ${fmtMB(it.file.size)}`) : (it.photo ? 'Photo · ' : '') + fmtMB(it.file.size);
    const st = { queued: 'Queued', running: 'Running', done: 'Done', error: 'Error', cancelled: 'Cancelled' }[it.status];
    const ad = adjFor(it), adjOn = adjActive(ad), scLabel = ad.scene !== 'auto' ? PRESETS[ad.scene].label : it.detected ? PRESETS[it.detected].label : null;
    const sceneTag = it.status === 'error' ? '' : scLabel ? `<span class="scene${adjOn ? ' manual' : ''}" title="${adjOn ? (it.adj ? 'Adjusted for this video' : 'Adjusted for all videos') : 'Auto-detected scene for this file'}">${scLabel}${adjOn ? ' · adjusted' : ''}</span>` : `<span class="scene" style="opacity:.5">detecting…</span>`;
    li.innerHTML = `<span class="led ${it.status === 'done' ? '' : it.status === 'error' ? 'red' : it.status === 'running' ? 'amber pulse' : ''}" style="${it.status === 'queued' ? 'opacity:.35' : ''}"></span><span><span class="name"></span><span class="meta"></span></span><span class="st"></span><button class="rm" aria-label="Remove">✕</button>`;
    li.querySelector('.name').textContent = it.file.name; li.querySelector('.meta').innerHTML = ''; li.querySelector('.meta').append(meta); li.querySelector('.meta').insertAdjacentHTML('beforeend', sceneTag); li.querySelector('.st').textContent = st;
    if (it.status === 'queued' && doneBefore(it)) li.querySelector('.meta').insertAdjacentHTML('beforeend', `<span class="scene again" title="This file was corrected in this browser before (same name and size)">corrected ${new Date(doneBefore(it)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>`);
    if (it.result && (it.status === 'error' || it.status === 'done')) { const r = document.createElement('span'); r.className = 'res ' + it.status; r.textContent = it.result; li.querySelector('.meta').after(r); }
    if (it.status === 'done' && it.streamed) { const sp = document.createElement('span'); sp.className = 'st'; sp.textContent = 'Downloaded'; li.querySelector('.st').replaceWith(sp); }
    if (it.status === 'done' && it.outFile) { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-glow save'; b.textContent = SAVE_LABEL; b.addEventListener('click', e => { e.stopPropagation(); saveOut(it); }); li.querySelector('.st').replaceWith(b); }
    li.querySelector('.name').title = it.result ? it.result : it.file.name;
    li.addEventListener('click', e => { if (e.target.classList.contains('rm')) return; select(i); });
    li.querySelector('.rm').addEventListener('click', () => { if (running && it.status === 'running') return; items.splice(i, 1); if (selected >= items.length) selected = items.length - 1; renderQueue(); if (selected >= 0) select(selected); else clearPreview(); });
    ui.queue.appendChild(li);
  });
}
// Edge on Android withdraws the page's access to picked files after a short while: the header could be read right
// after picking, but processing a minute later failed with "The requested file could not be read" (two reports, both
// EdgA, single and multiple files). There, every picked file is copied into the browser's own storage straight away,
// while access is still valid, and the app works on that copy. (localhost: ?copyin forces it for testing.)
const NEEDS_LOCAL_COPY = /EdgA\//.test(navigator.userAgent) || (DEV && new URLSearchParams(location.search).has('copyin'));
const INPUT_DIR = 'freecolor-cc-in';
let copying = Promise.resolve(); // Start waits for a running local copy
async function localCopy(f, i, n) {
  if (!support.opfs) return f;
  try {
    const est = navigator.storage.estimate ? await navigator.storage.estimate() : null;
    if (est && est.quota && est.quota - est.usage < f.size * 1.2 + 200e6) { ccTrack('copyin_skip', { mb: Math.round(f.size / 1e6) }); return f; }
    setStatus(`Preparing ${f.name} (${i}/${n}) – Edge on Android needs a local copy first …`, 'busy');
    const d = await (await navigator.storage.getDirectory()).getDirectoryHandle(INPUT_DIR, { create: true });
    const fh = await d.getFileHandle(Date.now().toString(36) + '-' + i + '-' + f.name.replace(/[^\w.-]/g, '_'), { create: true });
    if (fh.createWritable) { const w = await fh.createWritable(); await f.stream().pipeTo(w); }
    else if (f.size < 300e6) { const w = await fh.createWritable(); await w.write(await f.arrayBuffer()); await w.close(); }
    else return f;
    const c = await fh.getFile(); return new File([c], f.name, { type: f.type, lastModified: f.lastModified });
  } catch (e) { log('local copy failed: ' + e); if (e && e.name === 'NotReadableError') throw e; return f; }
}
if (NEEDS_LOCAL_COPY && support.opfs) (async () => { try { await (await navigator.storage.getDirectory()).removeEntry(INPUT_DIR, { recursive: true }); } catch (_) { } })(); // leftovers from earlier visits
async function addFiles(files) {
  let vids = [...files].filter(f => /\.(mp4|mov|m4v)$/i.test(f.name) || /video\//.test(f.type) || isImageFile(f));
  if (!vids.length) { setStatus('Format tidak didukung. Pilih video (MP4, MOV) atau foto (JPG, PNG, WEBP, HEIC).', 'err'); return; }
  if (NEEDS_LOCAL_COPY) {
    let release; copying = new Promise(r => { release = r; });
    const out = [], lost = [];
    for (let i = 0; i < vids.length; i++) { try { out.push(await localCopy(vids[i], i + 1, vids.length)); } catch (_) { lost.push(vids[i].name); } }
    if (lost.length) setStatus(`${lost.join(', ')}: ${readLostMsg()}`, 'err');
    ccTrack('copyin', { files: out.length, lost: lost.length });
    vids = out; release(); if (!vids.length) return;
  }
  const startAt = items.length;
  for (const f of vids) items.push({ file: f, status: 'queued', info: null, result: null, photo: isImageFile(f) && !/\.(mp4|mov|m4v)$/i.test(f.name) });
  renderQueue();
  if (selected < 0) select(startAt);
  for (let i = startAt; i < items.length; i++) { // read headers lazily for the list
    const it = items[i]; if (it.info) continue;
    if (it.photo) {
      try {
        const full = await decodeImage(it.file); it.info = { photo: true, width: full.width, height: full.height, heic: isHeicFile(it.file) };
        if (!it.detected && !running) { await previewPromise; if (!running) { const sm = await scaledBitmap(full, 640); if (!running) { uploadFrame(sm); it.detected = classifyTexture(); if (previewFrame) uploadFrame(previewFrame); } if (sm !== full) sm.close(); } }
        full.close();
      } catch (e) { it.info = null; it.status = 'error'; it.result = e && e.name === 'NotReadableError' ? readLostMsg() : e.message; }
      renderQueue(); continue;
    }
    try {
      const dm = await new Demuxer(it.file).init(); it.info = { width: dm.width, height: dm.height, fps: dm.fps, duration: dm.duration, codec: dm.video.codec, audio: !!dm.audio, hw: dm.hw, camera: dm.camera };
      if (!it.detected && !running) { // classify this video's scene from a frame at 10 % (same rule as during processing)
        await previewPromise;
        if (!running) { const f = await dm.frameAt(Math.min(dm.duration * 0.1, Math.max(0, dm.duration - 0.5))); if (!running) { uploadFrame(f); it.detected = classifyTexture(); if (previewFrame) uploadFrame(previewFrame); } f.close(); }
      }
      dm.close();
    } catch (e) { it.info = null; it.status = 'error'; it.result = e && e.name === 'NotReadableError' ? readLostMsg() : e.message; }
    renderQueue();
  }
}
function clearPreview() { if (previewFrame) { previewFrame.close(); previewFrame = null; } previewItem = null; ui.pvEmpty.hidden = false; ui.pvInfo.textContent = ''; }
async function select(i) {
  selected = i; renderQueue(); const it = items[i]; if (!it || running) return;
  if (previewItem === it && previewFrame) { showPreview(); return; }
  await previewPromise; if (running || selected !== i) return;
  let release; previewPromise = new Promise(r => { release = r; });
  setStatus(`Memuat pratinjau ${it.file.name} …`, 'busy');
  try {
    let f;
    if (it.photo) { const full = await decodeImage(it.file); it.info = it.info || { photo: true, width: full.width, height: full.height, heic: isHeicFile(it.file) }; f = await scaledBitmap(full, 1600); if (f !== full) full.close(); }
    else {
      const dm = await new Demuxer(it.file).init();
      it.info = { width: dm.width, height: dm.height, fps: dm.fps, duration: dm.duration, codec: dm.video.codec, audio: !!dm.audio, hw: dm.hw, camera: dm.camera };
      f = await dm.frameAt(Math.min(dm.duration * 0.1, Math.max(0, dm.duration - 0.5)));
      dm.close();
    }
    if (previewFrame) previewFrame.close(); previewFrame = f; previewItem = it;
    showPreview(true);
    setStatus(`Siap. ${countLabel(items)} dalam antrean.`);
  } catch (e) { it.status = 'error'; it.result = e && e.name === 'NotReadableError' ? readLostMsg() : e.message; setStatus(`Cannot open ${it.file.name}: ${e.message}`, 'err'); log(e.stack || e); }
  finally { release(); }
  renderQueue();
}
function showPreview(fresh = false) {
  if (!previewFrame) return;
  curCamera = (previewItem.info && previewItem.info.camera) || null;
  const W = previewFrame.displayWidth || previewFrame.width, H = previewFrame.displayHeight || previewFrame.height;
  const pw = Math.min(W, 1600), ph = Math.round(pw * H / W);
  ui.cmp.style.aspectRatio = `${W} / ${H}`; ui.cmp.classList.remove('live');
  ui.pvBefore.width = pw; ui.pvBefore.height = ph; ui.pvBefore.getContext('2d').drawImage(previewFrame, 0, 0, pw, ph);
  ui.glc.width = pw; ui.glc.height = ph; setWatermark(pw, ph);
  uploadFrame(previewFrame);
  if (fresh || !previewItem.detected) previewItem.detected = classifyTexture();
  showAdjusted(baseKeyFor(previewItem, adjFor(previewItem)), adjFor(previewItem)); uploadFrame(previewFrame);
  const s = settings(); render(measure(s), s);
  ui.pvEmpty.hidden = true;
  showInfo(previewItem, W, H);
}
// Info line under the preview. Called for the selected file AND for the file currently being processed,
// so length/resolution always describe what is on screen (it used to keep showing the last selected file).
function showInfo(it, W, H, outW, outH) {
  if (!it || !it.info) return;
  W = W || it.info.width; H = H || it.info.height; ui.pvInfo.innerHTML = '';
  if (it.info.photo) { const ps = [`${it.info.width}×${it.info.height} (${(it.info.width * it.info.height / 1e6).toFixed(1)} MP)`, `photo · ${it.info.heic ? 'HEIC' : (it.file.name.split('.').pop() || '').toUpperCase()}`, 'saved as JPEG with the original date, camera and GPS']; if (running) ps.unshift(it.file.name); for (const t of ps) { const sp = document.createElement('span'); sp.textContent = t; ui.pvInfo.appendChild(sp); } return; }
  const frames = it.bTotal ? ` · ${it.bTotal.toLocaleString('en-US')} frames` : '';
  const parts = [`${W}×${H} (${resLabel(W, H)})`, `${fmtFps(it.info.fps)} fps`, `length ${fmtClock(it.info.duration)}${frames}`, codecName(it.info.codec) + (it.info.audio ? ' + AAC' : ' · no audio'), it.info.hw === false ? 'software decode' : 'hardware decode'];
  if (it.info.camera) parts.push(it.info.camera.name + (BALANCED[it.info.camera.id] ? ' · lighter correction' : ''));
  if (outW && (outW !== W || outH !== H)) parts.push(`output ${outW}×${outH}`);
  if (running) parts.unshift(it.file.name);
  for (const t of parts) { const sp = document.createElement('span'); sp.textContent = t; ui.pvInfo.appendChild(sp); }
}
function rerenderPreview() { if (previewFrame && !running) { curCamera = (previewItem && previewItem.info && previewItem.info.camera) || null; uploadFrame(previewFrame); const s = settings(); render(measure(s), s); } }

// ---------- processing ----------
function waitDequeue(dec, enc) {
  return new Promise(res => { const h = () => { dec.removeEventListener('dequeue', h); enc.removeEventListener('dequeue', h); res(); }; dec.addEventListener('dequeue', h); enc.addEventListener('dequeue', h); setTimeout(h, 250); });
}
// Output name: <original>_corrected. Android's gallery picker hands the browser a bare number instead of the camera's
// file name (Birgit, Thibaut: "1000078060"), so those also get the recording time, which keeps the dive order when
// sorting by name: 1000078060_2026-03-21_05-41_corrected.mp4
function outBase(item) {
  const base = item.file.name.replace(/\.[^.]+$/, '');
  if (/^\d{6,}$/.test(base) && item.created) { const d = new Date(item.created), p = n => String(n).padStart(2, '0'); return `${base}_${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}_${p(d.getUTCHours())}-${p(d.getUTCMinutes())}`; }
  return base;
}
async function makeTarget(item) {
  const name = outBase(item) + '_corrected.mp4';
  item.outName = name;
  if (dirHandle) {
    try {
      const fh = await dirHandle.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      const ws = watchStream(w);
      const t = new Mp4Muxer.FileSystemWritableFileStreamTarget(w, { chunkSize: 8 * 1024 * 1024 });
      return {
        name,
        target: t,
        finish: async () => {
          await ws.finish(() => w.close());
          item.outHandle = fh;
          item.outFile = await fh.getFile();
          return item.outFile.size;
        },
        abort: async () => { try { await w.abort(); } catch (_) {} try { await dirHandle.removeEntry(name); } catch (_) {} }
      };
    } catch (_) {}
  }
  if (support.opfs) {
    try {
      return await makeOpfsTarget(item, name);
    } catch (e) {
      return makeMemoryTarget(item, name, e);
    }
  }
  return makeMemoryTarget(item, name, null);
}
function watchStream(w) {
  const st = { err: null };
  if (DEV && new URLSearchParams(location.search).has('failwrite') && w && w.abort) setTimeout(() => { const e = new DOMException('The quota has been exceeded.', 'QuotaExceededError'); st.err = e; try { w.abort(e); } catch (_) { } }, 1500);
  if (w && w.closed && w.closed.catch) w.closed.catch(e => { st.err = st.err || e; });
  st.explain = e => {
    const name = (e && e.name) || '', msg = (e && e.message) || String(e);
    if (/Quota/i.test(name) || /quota|space/i.test(msg)) return `Not enough free storage for the finished video. ${IS_MOBILE ? 'Free up space on the phone (or clear this site’s data) and try a shorter clip, or use a computer.' : (outMode === 'fsa' ? 'Free up disk space in the folder you chose and try again.' : 'Free up disk space (or browser storage) and try again.')}`;
    if (/NotAllowed|Security/i.test(name)) return 'The browser lost permission to write to the folder. Choose the folder again and restart the batch.';
    if (/NoModificationAllowed|InvalidState/i.test(name) || /locked|ERRORED/i.test(msg)) return 'The output file could not be written (it may be open in another program or the disk is full). Close other programs using the folder and try again.';
    return 'The output file could not be written: ' + msg;
  };
  st.finish = async (closeFn) => { if (st.err) throw new Error(st.explain(st.err)); try { await closeFn(); } catch (e) { throw new Error(st.explain(st.err || e)); } };
  return st;
}
async function checkOpfsSpace(item, quality) {
  try {
    if (!navigator.storage || !navigator.storage.estimate) return;
    const { quota, usage } = await navigator.storage.estimate(); if (!quota) return;
    const need = Math.round(item.file.size * Math.min(1, quality * 1.3) + 30e6);
    if (quota - usage < need) throw new Error(`Not enough free storage in the browser for this video (needs about ${fmtMB(need)}, ${fmtMB(Math.max(0, quota - usage))} free). ${IS_MOBILE ? 'Free up space on the phone, save and delete finished videos, or try a shorter clip.' : (support.fs ? 'Clear this site’s storage or use “Choose a folder” so files are written straight to disk.' : 'Clear this site’s storage, or process fewer / shorter clips per batch.')}`);
  } catch (e) { if (/Not enough free storage/.test(e.message)) throw e; }
}

// ---- OPFS output (phones, Safari): write into the browser's private storage, hand the file over with Save/Share ----
const OPFS_DIR = 'freecolor-cc-out';
async function opfsDir() { const root = await navigator.storage.getDirectory(); return root.getDirectoryHandle(OPFS_DIR, { create: true }); }
async function opfsClear() { try { const d = await opfsDir(); for await (const [n] of d.entries()) { try { await d.removeEntry(n); } catch (_) { } } } catch (_) { } }
const SYNC_WORKER_SRC = `
let h = null, dirName = '', fileName = '';
onmessage = async e => {
  const m = e.data;
  try {
    if (m.t === 'open') { const root = await navigator.storage.getDirectory(); const d = await root.getDirectoryHandle(m.dir, { create: true }); const fh = await d.getFileHandle(m.name, { create: true }); h = await fh.createSyncAccessHandle(); h.truncate(0); postMessage({ t: 'opened' }); }
    else if (m.t === 'write') { h.write(new Uint8Array(m.buf), { at: m.pos }); }
    else if (m.t === 'close') { h.flush(); const size = h.getSize(); h.close(); h = null; postMessage({ t: 'closed', size }); }
    else if (m.t === 'abort') { try { h && h.close(); } catch (_) { } h = null; postMessage({ t: 'aborted' }); }
  } catch (err) { postMessage({ t: 'error', message: String(err && err.message || err) }); }
};`;
// Sequential output: every byte goes to storage strictly in order. The muxer's few out-of-order writes (it patches
// the mdat size at the end) are kept in memory and laid over the stored file when it is handed out. Safari's OPFS
// writers did not apply positioned writes reliably, which produced iPhone files that Photos and iMovie refused.
function seqTarget(append) {
  let end = 0; const patches = [];
  const target = new Mp4Muxer.StreamTarget({ chunked: true, chunkSize: 8 * 1024 * 1024, onData: (data, position) => {
    if (position === end) { append(data.slice()); end += data.byteLength; }
    else if (position + data.byteLength <= end) patches.push({ position, data: data.slice() });
    else if (position < end) { const k = end - position; patches.push({ position, data: data.slice(0, k) }); append(data.slice(k)); end = position + data.byteLength; }
    else throw new Error('Internal error: gap in the output file.');
  } });
  const compose = file => {
    if (!patches.length) return file;
    const parts = []; let at = 0;
    for (const p of patches.slice().sort((a, b) => a.position - b.position)) { if (p.position < at) continue; parts.push(file.slice(at, p.position), p.data); at = p.position + p.data.byteLength; }
    parts.push(file.slice(at)); return new File(parts, file.name, { type: 'video/mp4' });
  };
  return { target, compose, size: () => end, patched: () => patches.length };
}
// Top-level MP4 boxes must add up to the file size; anything else means Apple's apps will refuse the file.
async function mp4Sane(f) {
  try {
    let o = 0, n = 0;
    while (o < f.size && n++ < 64) {
      const h = new DataView(await f.slice(o, o + 16).arrayBuffer()); let s = h.getUint32(0);
      if (s === 1) s = h.getUint32(8) * 4294967296 + h.getUint32(12); else if (s === 0) s = f.size - o;
      if (s < 8) return false; o += s;
    }
    return o === f.size;
  } catch (_) { return false; }
}
async function makeOpfsTarget(item, name) {
  const dir = await opfsDir();
  let fh = await dir.getFileHandle(name, { create: true });
  const useWritable = outMode === 'opfs' && typeof fh.createWritable === 'function' && !item.noWritable;
  if (useWritable) {
    let w; try { w = await fh.createWritable(); } catch (e) { log('createWritable failed: ' + e); item.noWritable = true; return makeOpfsTarget(item, name); }
    const ws = watchStream(w), wr = w.getWriter(); let werr = null;
    const st = seqTarget(buf => { wr.write(buf).catch(e => { werr = werr || e; }); });
    return { name, target: st.target,
      finish: async () => { try { await wr.close(); } catch (e) { werr = werr || e; } if (werr || ws.err) throw new Error(ws.explain(werr || ws.err)); const f = st.compose(await fh.getFile()); item.outFile = f; if (!(await mp4Sane(f))) { ccTrack('mp4_insane', { mode: 'writable', ios: IS_IOS, patched: st.patched() }); throw new Error('The finished file came out damaged in browser storage. Please send the file name and your phone model to jonas@jjsap.com.'); } return f.size; },
      abort: async () => { try { await wr.abort(); } catch (_) { } try { await dir.removeEntry(name); } catch (_) { } } };
  }
  // Safari before 26: no createWritable – write through a worker with a sync access handle
  const worker = new Worker(URL.createObjectURL(new Blob([SYNC_WORKER_SRC], { type: 'text/javascript' })));
  const wait = type => new Promise((res, rej) => { const on = e => { if (e.data.t === 'error') { worker.removeEventListener('message', on); rej(new Error(e.data.message)); } else if (e.data.t === type) { worker.removeEventListener('message', on); res(e.data); } }; worker.addEventListener('message', on); });
  let werr = null; worker.addEventListener('message', e => { if (e.data.t === 'error') werr = new Error(e.data.message); });
  worker.postMessage({ t: 'open', dir: OPFS_DIR, name });
  try { await wait('opened'); } catch (e) { worker.terminate(); log('sync access failed: ' + e); return makeMemoryTarget(item, name, e); }
  let wpos = 0;
  const st = seqTarget(data => { if (werr) throw werr; const buf = data.buffer, len = buf.byteLength; worker.postMessage({ t: 'write', buf, pos: wpos }, [buf]); wpos += len; }); // length read before the transfer detaches the buffer
  return { name, target: st.target,
    finish: async () => { if (werr) { worker.terminate(); throw new Error(watchStream(null).explain(werr)); } worker.postMessage({ t: 'close' }); let r; try { r = await wait('closed'); } catch (e) { worker.terminate(); throw new Error(watchStream(null).explain(e)); } worker.terminate(); const f = st.compose(await fh.getFile()); item.outFile = f; if (!(await mp4Sane(f))) { ccTrack('mp4_insane', { mode: 'sync', ios: IS_IOS, patched: st.patched() }); throw new Error('The finished file came out damaged in browser storage. Please send the file name and your phone model to jonas@jjsap.com.'); } return f.size || r.size; },
    abort: async () => { try { worker.postMessage({ t: 'abort' }); await wait('aborted'); } catch (_) { } worker.terminate(); try { await dir.removeEntry(name); } catch (_) { } } };
}
// ---- Stream-to-download output (desktop browsers without folder access, e.g. Brave): a service worker turns our
// chunks into a streaming download, so the file goes straight to the Downloads folder without any storage quota.
let swReg = null;
// The service worker (sw.js) keeps a copy of the app, so this page also opens without internet once it has been loaded
// online – liveaboards (Torsten). Registered on every visit; the download streamer uses the same registration.
const SW_URL = '/color-correction/sw.js' + (DEV && new URLSearchParams(location.search).has('offline') ? '?offline=1' : '');
const SW_SCOPE = location.pathname === '/' ? '/' : '/color-correction/';   // a dive centre's address serves the app at its root
if ('serviceWorker' in navigator && (location.protocol === 'https:' || DEV)) {
  navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE }).then(r => { swReg = swReg || r; }).catch(() => { });
  // freeColors Underwater bekerja 100% offline
}
async function streamWorker() {
  if (!swReg) { swReg = await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE }); }
  await navigator.serviceWorker.ready;
  const w = swReg.active || swReg.waiting || swReg.installing;
  if (w && w.state !== 'activated') await new Promise(res => { const on = () => { if (w.state === 'activated') { w.removeEventListener('statechange', on); res(); } }; w.addEventListener('statechange', on); });
  return swReg.active || w;
}
async function makeStreamTarget(item, name) {
  const sw = await streamWorker();
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const ch = new MessageChannel(); let bytes = 0, cancelled = false, opened = false;
  const ready = new Promise((res, rej) => { ch.port1.onmessage = ev => { const d = ev.data || {}; if (d.t === 'ready') res(); else if (d.t === 'open') opened = true; else if (d.t === 'cancel') cancelled = true; }; setTimeout(() => rej(new Error('The download could not be started. Reload the page and try again.')), 8000); });
  sw.postMessage({ t: 'init', id, name }, [ch.port2]); await ready;
  const frame = document.createElement('iframe'); frame.hidden = true; frame.src = `/color-correction/cc-dl/${id}`; document.body.appendChild(frame);
  const t = new Mp4Muxer.StreamTarget({ chunked: true, chunkSize: 4 * 1024 * 1024, onData: (data, position) => { if (cancelled) throw new Error('The download was cancelled by the browser.'); if (position !== bytes) throw new Error('Internal error: non-sequential write in stream mode.'); const buf = data.slice().buffer; bytes += buf.byteLength; ch.port1.postMessage({ t: 'chunk', buf }, [buf]); } });
  return { name, target: t,
    finish: async () => { ch.port1.postMessage({ t: 'end' }); setTimeout(() => frame.remove(), 15000); item.streamed = true; return bytes; },
    abort: async () => { try { ch.port1.postMessage({ t: 'abort' }); } catch (_) { } frame.remove(); } };
}

// Last resort on phones: keep the finished file in memory (fine for normal clips, refused for very large ones).
function makeMemoryTarget(item, name, cause) {
  const est = item.file.size * 0.9;
  if (est > 600e6) throw stepErr('open output file', new Error(`This browser could not write to its storage (${(cause && cause.message) || 'unknown reason'}) and the video is too large to keep in memory. Try a shorter clip, free up storage, or use a computer.`));
  const t = new Mp4Muxer.ArrayBufferTarget(); item.inMemory = true; ccTrack('mem_target', { mb: Math.round(item.file.size / 1e6) });
  return { name, target: t, finish: async () => { item.outFile = new File([t.buffer], name, { type: 'video/mp4' }); return t.buffer.byteLength; }, abort: async () => { } };
}

// Hand a finished file to the user: share sheet on phones (iOS: "Save Video"), download elsewhere.
async function saveOut(item) {
  let f = item.outFile || item.viewFile;
  if (!f && item.outHandle && typeof item.outHandle.getFile === 'function') {
    try { f = await item.outHandle.getFile(); } catch (_) {}
  }
  if (!f) {
    showNotice('<b>File belum siap.</b> Tunggu proses selesai.');
    return;
  }
  const filename = item.outName || f.name || ('freeColors_' + Date.now() + (item.photo ? '.jpg' : '.mp4'));

  // 1. Android Capacitor Native Platform:
  if (typeof window !== 'undefined' && window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()) {
    try {
      setStatus(`Menyimpan ${filename} ke galeri HP...`, 'busy');
      const { FreeColorGallery } = window.Capacitor.Plugins || {};
      if (FreeColorGallery) {
        const size = f.size || 0;
        // For files <= 10MB: direct base64
        if (size <= 10 * 1024 * 1024) {
          const reader = new FileReader();
          const base64Data = await new Promise((res, rej) => {
            reader.onload = () => res(reader.result);
            reader.onerror = rej;
            reader.readAsDataURL(f);
          });
          const res = await FreeColorGallery.saveImageToGallery({
            base64: base64Data,
            filename: filename
          });
          const album = res?.album || 'Galeri';
          showNotice(`<b>✓ Berhasil Disimpan!</b><br>${esc(filename)} tersimpan di album ${album}.`);
          setStatus(`Tersimpan di ${album}: ${filename}`);
          return;
        } else {
          // For larger files: chunked streaming (2MB slices)
          const chunkSize = 2 * 1024 * 1024;
          const totalChunks = Math.ceil(size / chunkSize);
          const sessionId = 'fc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
          for (let c = 0; c < totalChunks; c++) {
            const start = c * chunkSize;
            const end = Math.min(size, start + chunkSize);
            const sliceBlob = f.slice(start, end);
            const reader = new FileReader();
            const chunkBase64 = await new Promise((res, rej) => {
              reader.onload = () => res(reader.result.split(',')[1] || reader.result);
              reader.onerror = rej;
              reader.readAsDataURL(sliceBlob);
            });
            await FreeColorGallery.writeMediaChunk({
              sessionId,
              chunk: chunkBase64,
              filename,
              isFirst: c === 0,
              isLast: c === totalChunks - 1
            });
            setStatus(`Menyimpan video ke galeri (${Math.round((c + 1) / totalChunks * 100)}%)...`, 'busy');
          }
          showNotice(`<b>✓ Video Berhasil Disimpan!</b><br>${esc(filename)} tersimpan di album Movies/FreeColor.`);
          setStatus(`Video tersimpan di Galeri: ${filename}`);
          return;
        }
      }
    } catch (err) {
      console.warn('Native save failed, falling back to browser download:', err);
      showNotice(`<b>Peringatan:</b> Simpan galeri otomatis gagal (${esc(err.message)}), mencoba unduhan langsung.`);
    }
  }

  // 2. Share sheet on iOS Safari mobile:
  const isVideo = /\.(mp4|mov|m4v)$/i.test(filename);
  const file = new File([f], filename, { type: isVideo ? 'video/mp4' : 'image/jpeg' });
  if (IS_MOBILE && !IS_ANDROID && navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: file.name });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }

  // 3. Universal Web Browser Download (Desktop & Mobile Browser):
  const url = URL.createObjectURL(f);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  setStatus(`Tersimpan / Mengunduh: ${filename}`);
  showNotice(`<b>✓ Berhasil Disimpan!</b><br>${esc(filename)} tersimpan.`);
}
// Some hardware encoders (seen with AMD + Edge on Windows) do not honour high variable bitrates and deliver a fraction
// of what was asked for. The first 3 seconds are measured; if the encoder is far below target, the file is started
// again with a constant bitrate (which those encoders do follow) and a target they accept.
const LOWRATE = '__lowrate';
// Once an encoder has undershot, the rest of the session starts directly in constant bitrate (no wasted first try).
// Firefox's encoder can emit B-frames (frames out of presentation order), which the MP4 muxer refuses ("Timestamps
// must be monotonically increasing … [step: write video]"). 'realtime' latency asks for no reordering; Firefox gets it
// from the start, and any other browser that reorders gets it after the first such file.
const REORDER = '__reorder', IS_FIREFOX = /Firefox\//.test(navigator.userAgent);
let encRealtime = IS_FIREFOX;
let encCbrFirst = false, encQpFirst = false, encQpAdj = 0, encWeakWarned = false; // encQpAdj: learned QP correction for this encoder (session)
// Fixed quality never worse than 4 QP above the chosen quality (Maximum stays at QP 18 or better – a file that is a bit
// too big beats half the source quality, and a higher QP also smooths the dither away; Robert), never better than QP 8.
const qpClamp = (q, quality) => Math.min(qpFor(quality) + 4, Math.max(8, q));
// A .settings.txt next to the video (optional, folder mode): scene, sliders, output settings and encoder – so a grade can be
// repeated across a trip (Robert's request).
async function writeSettingsNote(item, base, r) {
  if (!ui.sideNote || ui.sideNote.value !== '1' || outMode !== 'fsa' || !(dirHandle || devClip) || r.photo) return;
  try {
    const adj = adjFor(item), lines = [`Underwater Color Correction – settings note`, `https://dive.nordrift.dk`, ``,
      `File: ${item.file.name}`, `Output: ${item.outName}`, `Date: ${new Date().toISOString()}`, ``,
      `Scene: ${r.scene}` + (item.sceneLog && item.sceneLog.length > 1 ? ` (changes: ${item.sceneLog.map(([t, k]) => t + 's ' + k).join(', ')})` : ''),
      `Adjustments: ${JSON.stringify(adj)}`, `Output settings: ${JSON.stringify({ quality: base.quality, outSize: base.outSize, outCodec: base.outCodec, denoise: base.denoise, warm: base.warm, window: base.window, measureEvery: base.measureEvery })}`,
      `Encoder: ${r.codec}`, `Encoder config: ${JSON.stringify(r.encCfg || {})}`, `Result: ${r.frames} frames, ${Math.round(r.bitrate / 1e6)} Mbit/s, ${r.bytes} bytes`, ``];
    const name = outBase(item) + '_corrected.settings.txt', text = lines.join('\n');
    if (devClip && !dirHandle) { await fetch('/out/' + name, { method: 'PUT', body: text }); return; } // localhost harness
    const fh = await dirHandle.getFileHandle(name, { create: true }); const w = await fh.createWritable(); await w.write(text); await w.close();
  } catch (e) { log('settings note failed: ' + e); }
}
async function processItem(item, base, onProgress) {
  if (isPhoto(item)) return processPhoto(item, base, onProgress);
  item.encFallback = encQpFirst ? { mode: 'quantizer', qp: qpClamp(qpFor(base.quality) + encQpAdj, base.quality) } : encCbrFirst ? { mode: 'constant', cap: 160e6 } : null;
  let r;
  try { r = await processItemOnce(item, base, onProgress); }
  catch (e) {
    // The 3-second bitrate check failed (the retry's own failure is handled below): variable -> constant bitrate -> fixed
    // quality (QP), if the encoder offers it; otherwise constant bitrate once more without the check, and a warning at the end.
    for (let step = 0; step < 2 && e && e.message === LOWRATE; step++) {
      ccTrack('enc_undershoot', { want: e.want, got: e.got, codec: e.codec, mode: item.encFallback ? item.encFallback.mode : 'variable' });
      if (!item.encFallback) { item.encFallback = { mode: 'constant', cap: 160e6 }; encCbrFirst = true; log(`encoder undershoot (${e.got} of ${e.want} Mbit/s) – retrying with constant bitrate`); }
      else {
        let q = null; try { q = await pickEncoder(e.w, e.h, e.fps, e.want * 1e6, base.outCodec, 'quantizer', encRealtime ? 'realtime' : 'quality'); } catch (_) { }
        if (q && q.cfg.bitrateMode === 'quantizer') { item.encFallback = { mode: 'quantizer', qp: qpClamp(qpFor(base.quality) + encQpAdj, base.quality) }; encQpFirst = true; log(`constant bitrate undershoot too (${e.got} of ${e.want} Mbit/s) – retrying with fixed quality, QP ${item.encFallback.qp}`); ccTrack('enc_quantizer', { qp: item.encFallback.qp, codec: e.codec }); }
        else { item.encFallback = { mode: 'constant', cap: 160e6, checked: true }; log(`constant bitrate undershoot too (${e.got} of ${e.want} Mbit/s) – no fixed-quality mode here, keeping constant bitrate`); }
      }
      try { r = await processItemOnce(item, base, onProgress); e = null; } catch (e2) { e = e2; r = null; }
    }
    if (!r && e && e.step === 'decode' && item.decHw && !item.swDecode) {
      // The hardware decoder accepted the configuration but failed on the stream (Android phones on some H.264 files:
      // B-frames, inband SPS/PPS, NVENC output – Alex Marshall, Chrome on Android). The browser's software decoder is
      // slower but takes almost anything, so the file gets one more go there.
      item.swDecode = true; log('hardware decode failed – retrying with software decoding: ' + e.message); ccTrack('decode_retry_sw', { codec: codecName(item.info && item.info.codec), msg: String(e.message || '').slice(0, 80) });
      showNotice(`<b>${esc(item.file.name)}: this device's hardware decoder gave up on the file, so it is decoded in software instead.</b> That is slower, but the result is the same.`);
      try { r = await processItemOnce(item, base, onProgress); } catch (e2) { e = e2; r = null; }
    }
    if (!r) {
      if (e && e.message === REORDER && !encRealtime) {
        encRealtime = true; log('encoder reorders frames – retrying with realtime latency'); ccTrack('enc_reorder', { firefox: IS_FIREFOX });
        return processItem(item, base, onProgress);
      }
      if (e && e.message === REORDER) throw new Error('This browser’s video encoder delivers frames out of order, which the MP4 file cannot store. Please use Chrome or Edge for now.');
      throw e;
    }
  }
  if (DEV && new URLSearchParams(location.search).has('weakenc') && item.encFallback) r.bitrate = r.target * 0.11; // simulate an AMD-like H.264 encoder
  // Some encoders stay low even in constant-bitrate mode (measured: AMD Radeon H.264 at 4K50 ≈ 10 Mbit/s whatever
  // is asked). Nothing more can be done with that encoder – say so, with the way out.
  await writeSettingsNote(item, base, r);
  if (item.encFallback && item.encFallback.mode !== 'quantizer' && r.target >= 15e6 && r.bitrate < r.target * 0.35 && !encWeakWarned) {
    encWeakWarned = true; const isH264 = !/HEVC/.test(r.codec), edge = /Edg\//.test(navigator.userAgent);
    let hevcOk = false; try { hevcOk = (await VideoEncoder.isConfigSupported({ codec: 'hev1.1.6.L153.B0', width: 3840, height: 2160, bitrate: 50e6, framerate: 30, hevc: { format: 'hevc' } })).supported; } catch (_) { }
    ccTrack('enc_weak', { want: Math.round(r.target / 1e6), got: Math.round(r.bitrate / 1e6), codec: r.codec, edge, hevcOk });
    showNotice(`<b>Your graphics card's ${isH264 ? 'H.264' : 'HEVC'} encoder only delivers about ${Math.round(r.bitrate / 1e6)} Mbit/s at this resolution (asked for ${Math.round(r.target / 1e6)}).</b> The files are fine, just more compressed than you chose. ` +
      (isH264 && hevcOk ? 'For full quality set <b>Video format</b> to <b>HEVC</b> in step 3 – your encoder handles high bitrates there.' : isH264 && edge ? 'For full quality open the app in <b>Chrome</b> and choose <b>Video format: HEVC</b> – Edge does not offer HEVC encoding to web pages.' : 'Choosing <b>Output size: 1080p</b> gives the encoder an easier job.'));
  }
  return r;
}
async function processItemOnce(item, base, onProgress) {
  const dm = await new Demuxer(item.file, { soft: !!item.swDecode }).init(); item.decHw = dm.hw;
  const W = dm.width, H = dm.height, fps = dm.fps; item.created = dm.created || 0; curCamera = dm.camera || null;
  if (dm.audioDropped && !audioDropWarned.has(dm.audioDropped)) {
    audioDropWarned.add(dm.audioDropped); ccTrack('audio_dropped', { codec: String(dm.audioDropped).slice(0, 20) });
    showNotice(`<b>The sound of ${esc(item.file.name)} is in a format the app can't copy yet (${esc(String(dm.audioDropped))}), so the corrected video is silent.</b> The picture is not affected. Please tell me your camera model at jonas@jjsap.com – I'm adding more sound formats.`);
  }
  const vEditUs = Math.round(dm.videoEdit * 1e6), aEditUs = Math.round(dm.audioEdit * 1e6);
  const total = SELFTEST ? Math.min(Math.round(SELFTEST * fps), Math.max(1, dm.video.nb_samples - Math.round(dm.videoEdit * fps))) : Math.max(1, dm.video.nb_samples - Math.round(dm.videoEdit * fps));
  // Variable bitrate above ~80 Mbit/s collapses on some hardware encoders (measured: 4K50 asked 90 -> 7 Mbit/s)
  // – so above 80 Mbit/s constant bitrate is used, which encoders do follow (measured: 90 and 104 Mbit/s delivered). Up to 160 Mbit/s.
  let bitrate = Math.min(160e6, Math.max(8e6, dm.bitrate * base.quality));
  // HEVC needs ~30 % fewer bits than H.264 for the same detail, so an H.264 source encoded to HEVC gets 70 % of the
  // bitrate: same quality, smaller file (Torsten: an H.264 file re-encoded to HEVC at Maximum came out the same size).
  // An HEVC source keeps its bitrate either way; if no HEVC encoder exists and H.264 is used after all, the cut is undone.
  const hevcSave = base.outCodec === 'hevc' && /^avc/i.test(dm.video.codec || '') ? 0.7 : 1; bitrate = Math.round(bitrate * hevcSave);
  // Variable bitrate first at every level (saves space on simple scenes); if the encoder collapses (seen above ~80 Mbit/s
  // at 4K50), the 3-second check restarts the file in constant bitrate and the session stays there.
  const encMode = item.encFallback ? item.encFallback.mode : 'variable', encQp = encMode === 'quantizer' ? item.encFallback.qp : 0;
  let oW = W, oH = H, enc;
  // Otomatis convert ke FHD (1080p) agar tidak membebani GPU HP
  let cap = +base.outSize;
  if (isNaN(cap) || cap === undefined) cap = 1920;
  if (IS_MOBILE || IS_ANDROID) {
    if (cap === 0 || cap > 1920) cap = 1920; // Wajib Full HD di Mobile/HP
  }
  const maxSide = Math.max(W, H);
  if (cap && maxSide > cap) {
    const scale = cap / maxSide;
    oW = Math.max(2, Math.floor((W * scale) / 2) * 2);
    oH = Math.max(2, Math.floor((H * scale) / 2) * 2);
    bitrate = Math.round(bitrate * (oW * oH) / (W * H));
    item.downscaled = `${oW}×${oH} (FHD)`;
    log(`convert ke FHD 1080p: ${oW}x${oH}`);
  }
  if (IS_MOBILE || IS_ANDROID) {
    bitrate = Math.min(bitrate, 12e6);
  }
  try { enc = await pickEncoder(oW, oH, fps, bitrate, base.outCodec, encMode, encRealtime ? 'realtime' : 'quality'); }
  catch (e) {
    let ok = false;
    for (const targetLong of [1920, 1280, 960, 854, 720, 640]) {
      const curLong = Math.max(oW, oH);
      if (curLong === targetLong) {
        try {
          enc = await pickEncoder(oW, oH, Math.min(fps, 30), 8e6, 'avc', 'variable', 'realtime');
          bitrate = 8e6;
          ok = true; break;
        } catch (_) {}
        continue;
      }
      if (curLong < targetLong) continue;
      const scale = targetLong / curLong;
      const tw = Math.max(2, Math.floor((oW * scale) / 2) * 2);
      const th = Math.max(2, Math.floor((oH * scale) / 2) * 2);
      const tb = Math.min(bitrate, 8e6);
      try {
        enc = await pickEncoder(tw, th, Math.min(fps, 30), tb, 'avc', 'variable', 'realtime');
        oW = tw; oH = th; bitrate = tb; item.downscaled = `${oW}×${oH}`;
        log(`encoder fallback: downscaled to ${oW}x${oH}`);
        ok = true; break;
      } catch (_) { }
    }
    if (!ok) {
      const scale = 720 / Math.max(oW, oH);
      const tw = Math.max(2, Math.floor((oW * scale) / 2) * 2);
      const th = Math.max(2, Math.floor((oH * scale) / 2) * 2);
      enc = await pickEncoder(tw, th, 30, 4e6, 'avc', 'variable', 'realtime');
      oW = tw; oH = th; bitrate = 4e6; item.downscaled = `${oW}×${oH}`;
    }
  }
  if (base.outCodec === 'hevc' && enc.mux !== 'hevc' && !hevcEncWarned) { hevcEncWarned = true; ccTrack('hevc_enc_missing', {}); showNotice('<b>This browser reports that it cannot encode HEVC on this computer, so the files are saved as H.264.</b> The quality setting still applies. Whether a browser offers HEVC <i>encoding</i> depends on the browser version as well as the graphics card – if you are on Edge, try Chrome (or the other way round). The <a href="/color-correction/diag" target="_blank">diagnostics page</a> shows exactly what your browser supports.'); }
  if (hevcSave < 1 && enc.mux !== 'hevc') { bitrate = Math.round(bitrate / hevcSave); if (enc.cfg.bitrateMode !== 'quantizer') enc.cfg.bitrate = bitrate; }
  // Fixed quality: the QP goes with every frame, so it can be corrected while the file runs (no restart). The encoder
  // output is measured in 3-second windows; while the rate is outside 0.7–1.5× the chosen quality the QP moves by at most
  // 3 steps (6 = half the bitrate) at a time, up to three times, and the session keeps the result for the next file.
  // (Robert: the first version restarted the file with one correction of +8 and overshot – 130 Mbit/s source, 63 out.)
  let qp = enc.cfg.bitrateMode === 'quantizer' ? encQp : 0; const qp0 = qp; let qpTunes = 0, winBytes = 0, winChunks = 0;
  const encOpts = key => qp ? { keyFrame: key, [enc.mux === 'avc' ? 'avc' : 'hevc']: { quantizer: qp } } : { keyFrame: key };
  log(`encoder: ${enc.label} ${enc.cfg.codec} ${oW}x${oH} ${enc.cfg.bitrateMode}${qp ? ' QP ' + qp : ' ' + Math.round(bitrate / 1e6) + ' Mbit/s'}${enc.cfg.framerate === undefined ? ' (no framerate hint)' : ''}`);
  if (outMode === 'opfs' || outMode === 'opfs-sync') await checkOpfsSpace(item, base.quality);
  let out; try { out = await makeTarget(item); } catch (e) { throw stepErr('open output file', e); }
  // Keep the recording date: the muxer stamps mvhd/tkhd/mdhd with Date.now() read once in its constructor (no option
  // for it), so lend it the source's date for that one synchronous call. Photos, Lightroom and Google Photos sort by it.
  const realNow = Date.now; if (dm.created) Date.now = () => dm.created;
  let muxer; try {
    muxer = new Mp4Muxer.Muxer({
      target: out.target,
      video: { codec: enc.mux, width: oW, height: oH, frameRate: Math.round(fps), rotation: dm.rotation || 0 },
      audio: dm.audioConfig ? { codec: 'aac', sampleRate: dm.audioConfig.sampleRate, numberOfChannels: dm.audioConfig.numberOfChannels } : undefined,
      fastStart: outMode === 'stream' ? 'fragmented' : false, firstTimestampBehavior: 'cross-track-offset',
    });
  } finally { Date.now = realNow; }
  let lastOutTs = -1, tsFixes = 0; const thumbAt = Math.max(0, Math.floor(total * 0.45)); item.thumb = null;
  let failure = null, n = 0, audioMeta = dm.audioConfig ? { decoderConfig: { codec: dm.audioConfig.codec, sampleRate: dm.audioConfig.sampleRate, numberOfChannels: dm.audioConfig.numberOfChannels, description: dm.audioConfig.description } } : null;
  let encBytes = 0; const checkAt = Math.round(fps * 3);
  const avcState = {}; // H.264 repair state (Annex B / missing avcC, seen on iPhone browsers)
  let lastChunkTs = -Infinity;
  const tuneQp = () => { // one window of encoder output in fixed-quality mode
    const got = DEV_LOWRATE ? bitrate * 3.5 / Math.pow(2, (qp - qp0) / 6) : winBytes * 8 / (winChunks / fps); winBytes = winChunks = 0;
    const ratio = got / bitrate; if (ratio > 0.7 && ratio < 1.5) { qpTunes = 3; return; } // close enough: keep it for the whole file
    const to = qpClamp(qp + Math.max(-3, Math.min(3, Math.round(6 * Math.log2(ratio)))), base.quality); qpTunes++;
    if (to === qp) { qpTunes = 3; return; }
    log(`fixed quality QP ${qp} gives ${Math.round(got / 1e6)} of ${Math.round(bitrate / 1e6)} Mbit/s – continuing with QP ${to}`); ccTrack('enc_qp_tune', { from: qp, to, got: Math.round(got / 1e6), want: Math.round(bitrate / 1e6) });
    qp = to; encQpAdj = qp - qpFor(base.quality);
  };
  const encoder = new VideoEncoder({ output: (chunk, meta) => { encBytes += chunk.byteLength; if (qp && qpTunes < 3 && total > checkAt * 2) { winBytes += chunk.byteLength; if (++winChunks >= checkAt) tuneQp(); } if (chunk.timestamp < lastChunkTs || (DEV_REORDER && !encRealtime && encBytes > 2e5)) { failure = failure || new Error(REORDER); return; } lastChunkTs = chunk.timestamp; try {
    if (enc.mux === 'avc' && window.ccAvc) {
      const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d);
      const f = ccAvc.fix(d, meta, avcState, enc.cfg.codec);
      if (f) { if (!avcState.reported) { avcState.reported = true; log(`H.264 stream repaired (annexB ${!!avcState.annexB}, avcC built ${!!avcState.built})`); ccTrack('avc_fix', { annexB: !!avcState.annexB, built: !!avcState.built, ios: IS_IOS }); } muxer.addVideoChunkRaw(f.data, chunk.type, chunk.timestamp, chunk.duration ?? 0, f.meta); return; }
    }
    muxer.addVideoChunk(chunk, meta); } catch (e) { failure = failure || stepErr('write video', e); } }, error: e => { failure = failure || stepErr('encode', e); } });
  try { encoder.configure(enc.cfg); } catch (e) { throw stepErr('configure encoder', e); }
  const adj = adjFor(item), auto = adj.scene === 'auto';
  let s = auto ? null : withAdj(presetSettings(adj.scene), adj); // auto: first scene from the first frame, then tracked continuously
  let smoother = s ? new ParamSmoother(s.window, slewStep(s.scene, s.measureEvery, fps)) : null, params = null, sceneLabel = s ? (PRESETS[s.scene] ? PRESETS[s.scene].label : 'Custom') : null;
  lumRef = null; needCur = null; // brightness-follow reference and the needed amount start fresh for each video
  let tracker = null, inc = null; const sceneKeys = []; item.sceneLog = []; dnReset();
  const keyInt = Math.max(1, Math.round(fps * 2));
  ui.glc.width = oW; ui.glc.height = oH; setWatermark(oW, oH); ui.cmp.style.aspectRatio = `${oW} / ${oH}`; ui.cmp.classList.add('live'); ui.pvEmpty.hidden = true;
  item.bTotal = item.bTotal || total; showInfo(item, W, H, oW, oH);
  const decoder = new VideoDecoder({
    output: frame => {
      if (frame.timestamp < vEditUs) { frame.close(); return; } // hidden by edit list
      if (DEV_DECFAIL && !item.swDecode && n === 2) failure = failure || stepErr('decode', new Error('Decoding error'));
      try {
        uploadFrame(frame);
        if (!s) { const key = classifyTexture(); s = withAdj(presetSettings(key), adj); smoother = new ParamSmoother(s.window, slewStep(key, s.measureEvery, fps)); sceneLabel = PRESETS[key].label; item.detected = key; sceneKeys.push(key); item.sceneLog.push([0, key]); tracker = new SceneTracker(key, fps, s.measureEvery); log(`auto scene: ${key}`); followItem(item, key); params = smoother.update(measure(s, false)); }
        else if (n % s.measureEvery === 0 || !params) {
          let read = true;
          if (tracker) {
            const key = classifyTexture(tracker.cur); read = false;
            const sw = !inc && tracker.vote(key);
            if (sw) { inc = { key: sw, s: withAdj(presetSettings(sw), adj), k: 0, n: Math.max(1, Math.round(SCENE_FADE * fps)) }; inc.sm = new ParamSmoother(inc.s.window, slewStep(sw, inc.s.measureEvery, fps)); sceneKeys.push(sw); item.sceneLog.push([+(n / fps).toFixed(1), sw]); sceneLabel = PRESETS[sw].label; log(`scene change at ${(n / fps).toFixed(1)} s: ${sw}`); followItem(item, sw); }
          }
          params = smoother.update(measure(s, read));
          if (inc) inc.p = inc.sm.update(measure(inc.s, false));
        }
        if (inc) {
          if (!inc.p) inc.p = inc.sm.update(measure(inc.s));
          const x = Math.min(1, ++inc.k / inc.n), t = x * x * (3 - 2 * x); // smoothstep
          render(blendParams(params, inc.p, t), blendSettings(s, inc.s, t), true);
          if (inc.k >= inc.n) { s = inc.s; smoother = inc.sm; params = inc.p; inc = null; }
        } else render(params, s, true);
        // Output timestamps must rise monotonically (the muxer refuses otherwise). Some recorders write
        // out-of-order or duplicate presentation times; keep the frame and nudge its time forward instead of failing.
        let ts = frame.timestamp - vEditUs; if (ts <= lastOutTs) { ts = lastOutTs + 1000; tsFixes++; } lastOutTs = ts;
        const outFrame = new VideoFrame(ui.glc, { timestamp: ts, duration: frame.duration ?? undefined });
        encoder.encode(outFrame, encOpts(n % keyInt === 0)); outFrame.close();
        if (n === thumbAt) item.thumb = snapshot(ui.glc);
        if (n === checkAt + Math.round(fps) && !qp && !(item.encFallback && item.encFallback.checked) && bitrate >= 15e6 && total > checkAt * 2) { // ~1 s later, so the encoder has caught up
          const got = DEV_LOWRATE ? 0 : encBytes * 8 / (checkAt / fps);
          if (got < bitrate * 0.35) { const x = new Error(LOWRATE); x.want = Math.round(bitrate / 1e6); x.got = Math.round(got / 1e6); x.codec = enc.label; x.w = oW; x.h = oH; x.fps = fps; failure = failure || x; }
        }
      } catch (e) { failure = failure || stepErr(n === 0 ? 'first frame (colour correction)' : 'colour correction', e); } finally { frame.close(); }
      n++; onProgress(n, total, sceneLabel);
      if (DEV && params && n % Math.round(fps * 2) === 1) log('params ' + JSON.stringify({ t: +(n / fps).toFixed(1), lum: +lastRawLum.toFixed(3), mean: params.mean.map(v => +v.toFixed(3)), scale: params.scale.map(v => +v.toFixed(2)), low: params.low.map(v => +v.toFixed(3)), high: params.high.map(v => +v.toFixed(3)), amp: params.scale.map((v, i) => +(v / Math.max(1e-3, params.high[i] - params.low[i])).toFixed(2)) }));
    },
    error: e => { failure = failure || stepErr('decode', e); },
  });
  try { decoder.configure(dm.videoConfig); } catch (e) { throw stepErr('configure decoder', e); }
  // PCM sound (Sony etc.): pulled from the file in ¼-second pieces a little ahead of the video, encoded to AAC, muxed as it comes.
  let aenc = null, pcmFeed = null;
  if (dm.pcm) {
    const p = dm.pcm, bpf = p.bytes * p.channels, PIECE = Math.round(p.rate / 4), skip = Math.round(dm.audioEdit * p.rate);
    const meta0 = { decoderConfig: { codec: 'mp4a.40.2', sampleRate: p.rate, numberOfChannels: p.channels, description: dm.audioConfig.description } };
    let ri = 0, roff = 0, frame = 0, gotMeta = false;
    aenc = new AudioEncoder({
      output: (c, m) => { try { const withDesc = m && m.decoderConfig && m.decoderConfig.description; muxer.addAudioChunk(c, withDesc ? m : (gotMeta ? undefined : meta0)); gotMeta = true; } catch (e) { failure = failure || stepErr('mux audio', e); } },
      error: e => { failure = failure || stepErr('encode audio', e); },
    });
    try { aenc.configure({ codec: 'mp4a.40.2', sampleRate: p.rate, numberOfChannels: p.channels, bitrate: Math.min(320000, 96000 * p.channels) }); } catch (e) { throw stepErr('configure audio encoder', e); }
    if (!audioPcmSeen.has(p.type)) { audioPcmSeen.add(p.type); ccTrack('audio_pcm', { type: p.type, bits: p.bytes * 8, ch: p.channels }); }
    const readFrames = async want => { // the next `want` frames as one buffer, across chunk boundaries
      const parts = []; let got = 0;
      while (got < want && ri < p.runs.length) {
        const r = p.runs[ri], avail = r.bytes - roff; let take = Math.min(avail, (want - got) * bpf); take -= take % bpf;
        if (take <= 0) { ri++; roff = 0; continue; }
        parts.push(new Uint8Array(await dm.file.slice(r.off + roff, r.off + roff + take).arrayBuffer())); got += take / bpf; roff += take;
        if (roff >= r.bytes) { ri++; roff = 0; }
      }
      if (!parts.length) return null; if (parts.length === 1) return parts[0];
      const buf = new Uint8Array(parts.reduce((n, x) => n + x.byteLength, 0)); let o = 0; for (const x of parts) { buf.set(x, o); o += x.byteLength; } return buf;
    };
    pcmFeed = async upto => {
      while (ri < p.runs.length && (frame - skip) / p.rate <= upto + 0.5 && !cancelled && !failure) {
        if (aenc.encodeQueueSize > 24) { await sleep(5); continue; }
        const buf = await readFrames(PIECE); if (!buf) break;
        let n = Math.floor(buf.byteLength / bpf), off = 0;
        if (frame + n <= skip) { frame += n; continue; }                              // hidden by the edit list
        if (frame < skip) { off = (skip - frame) * bpf; n -= skip - frame; frame = skip; }
        const d = pcmToAudio(p, buf.subarray(off, off + n * bpf), n);
        const ad = new AudioData({ format: d.fmt, sampleRate: p.rate, numberOfFrames: n, numberOfChannels: p.channels, timestamp: Math.round((frame - skip) / p.rate * 1e6), data: d.buf });
        try { aenc.encode(ad); } catch (e) { failure = failure || stepErr('encode audio', e); } finally { ad.close(); }
        frame += n;
      }
    };
  }
  const drainAudio = upto => {
    if (!dm.audio || dm.pcm) return;
    const q = dm.q.audio;
    while (q.length && q[0].cts / q[0].timescale <= upto) {
      const a = q.shift(); const ts = Math.round(a.cts * 1e6 / a.timescale) - aEditUs;
      if (a.number % 100 === 0) dm.release(a, 'audio');
      if (ts < 0) continue; // hidden by edit list
      muxer.addAudioChunkRaw(a.data, a.is_sync ? 'key' : 'delta', ts, Math.round(a.duration * 1e6 / a.timescale), audioMeta || undefined);
      audioMeta = null;
    }
  };
  try {
    dm.start(0, true);
    let smp;
    while ((smp = await dm.next('video'))) {
      if (cancelled) break;
      if (SELFTEST && smp.cts / smp.timescale - dm.videoEdit > SELFTEST) break;
      if (failure) throw failure;
      while (decoder.decodeQueueSize > 8 || encoder.encodeQueueSize > 8) { await waitDequeue(decoder, encoder); if (failure) throw failure; if (cancelled) break; }
      if (cancelled) break;
      decoder.decode(dm.chunk(smp));
      if (pcmFeed) await pcmFeed(smp.cts / smp.timescale); else drainAudio(smp.cts / smp.timescale + 0.5);
      if (smp.number % 60 === 0) dm.release(smp, 'video');
    }
    if (cancelled) throw new Error('__cancel');
    await decoder.flush(); await encoder.flush();
    if (failure) throw failure;
    if (pcmFeed) { await pcmFeed(dm.duration + dm.videoEdit); await aenc.flush(); if (failure) throw failure; } else drainAudio(Infinity);
    try { muxer.finalize(); } catch (e) { throw stepErr('finalize mp4', e); }
    let bytes; try { bytes = await out.finish(); } catch (e) { throw stepErr('save file', e); }
    if (tsFixes) { log(`timestamps nudged: ${tsFixes}`); ccTrack('ts_fix', { frames: tsFixes }); }
    if (sceneKeys.length > 1) ccTrack('scene_changes', { n: sceneKeys.length - 1, min: Math.round(n / fps / 6) / 10 });
    return { frames: n, pixels: n * oW * oH, target: bitrate, bytes, codec: enc.label + (item.downscaled ? ' ' + item.downscaled : '') + (qp ? ` (fixed quality, QP ${qp !== qp0 ? qp0 + '→' : ''}${qp})` : item.encFallback ? ' (constant bitrate)' : ''), encCfg: { codec: enc.cfg.codec, width: oW, height: oH, bitrateMode: enc.cfg.bitrateMode, bitrate: enc.cfg.bitrate, qp: qp || undefined, qpStart: qp && qp !== qp0 ? qp0 : undefined, framerate: enc.cfg.framerate, hardwareAcceleration: enc.cfg.hardwareAcceleration, latencyMode: enc.cfg.latencyMode }, bitrate: n ? encBytes * 8 / (n / fps) : bitrate, scene: auto ? sceneSummary(sceneKeys) : sceneLabel };
  } catch (e) {
    await out.abort(); if (e && e.message !== '__cancel' && e.message !== LOWRATE && e.message !== REORDER) ccTrack('fail', { step: e.step || 'unknown', mode: outMode, ios: IS_IOS, msg: String(e.message || e).slice(0, 120) }); throw e;
  } finally {
    try { decoder.close(); } catch (_) { } try { encoder.close(); } catch (_) { } try { aenc && aenc.close(); } catch (_) { } dm.close();
    ui.cmp.classList.remove('live');
  }
}

// ---- Batch ETA + speed class (gamification) ----
// Throughput is measured in pixels per second across the whole batch, so videos of
// different resolutions mix correctly; the ETA is remaining pixels / average rate.
const RANKS = [ // by speed relative to realtime (output fps / source fps)
  { min: 0,   ico: '🐌', name: 'Sea snail',   note: 'slow and steady – software decoding takes its time', noteHw: 'slow and steady – a big batch? Grab a coffee.' },
  { min: 0.3, ico: '🐢', name: 'Sea turtle',  note: 'cruising – a typical laptop pace' },
  { min: 0.7, ico: '🐟', name: 'Grouper',     note: 'close to realtime' },
  { min: 1.2, ico: '🐬', name: 'Dolphin',     note: 'faster than realtime' },
  { min: 2.5, ico: '🦈', name: 'Mako shark',  note: 'blazing – your GPU is earning its keep' },
];
const batch = { items: [], t0: 0, px: 0, frames: 0, srcSec: 0, rank: -1, segs: new Map(), ovh: 0, nEnded: 0, curStart: 0, curFirst: 0, curLast: 0, obs: [] };
function batchBegin(list) {
  batch.items = list; batch.t0 = performance.now(); batch.px = 0; batch.frames = 0; batch.srcSec = 0; batch.rank = -1; batch.segs.clear(); batch.ovh = 0; batch.nEnded = 0; batch.obs = [];
  ui.bTrack.innerHTML = '';
  for (const it of list) {
    it.bTotal = isPhoto(it) ? 1 : it.info ? Math.max(1, Math.round(it.info.duration * it.info.fps)) : 0; it.bDone = 0;
    const seg = document.createElement('div'); seg.className = 'seg'; seg.appendChild(document.createElement('i'));
    seg.dataset.w = Math.max(0.01, (isPhoto(it) ? 15 : it.bTotal) * (it.info ? it.info.width * it.info.height : 1e6) / 1e6); // a photo costs about as much as 15 video frames seg.title = it.file.name;
    ui.bTrack.appendChild(seg); batch.segs.set(it, seg);
  }
  layoutTrack();
  ui.bEta.textContent = '–'; ui.bEtaNote.textContent = 'measuring speed …'; ui.bRank.className = 'batch-rank';
  ui.bRankIco.textContent = '🫧'; ui.bRankName.textContent = 'Warming up'; ui.bRankNote.textContent = 'speed class appears after a few seconds';
  ui.bAvg.textContent = ui.bLive.textContent = ui.bSpeed.textContent = '–'; ui.bFrames.textContent = '0'; ui.bVids.textContent = `0/${list.length}`; ui.bElapsed.textContent = '0:00';
  ui.batch.hidden = false;
}
// Matrix layout: every video keeps a width proportional to its size (long clips stay visibly longer), but the
// track wraps into as many rows as needed so 200+ videos fit the panel; rows get thinner as they multiply.
const TRACK_MIN = 5, TRACK_GAP = 3;
function layoutTrack() {
  const segs = [...ui.bTrack.children]; if (!segs.length) return;
  const W = ui.bTrack.clientWidth || 600, n = segs.length, sumW = segs.reduce((a, e) => a + +e.dataset.w, 0);
  let rows = 1; // smallest row count where proportional widths (with a minimum) fit
  for (; rows < 40; rows++) { const avail = rows * W - n * TRACK_GAP, need = segs.reduce((a, e) => a + Math.max(TRACK_MIN, +e.dataset.w / sumW * avail), 0); if (need <= avail * 1.02) break; }
  const avail = rows * W - n * TRACK_GAP, h = rows <= 2 ? 12 : rows <= 5 ? 9 : rows <= 10 ? 7 : 5;
  ui.bTrack.classList.toggle('multi', rows > 1); ui.bTrack.style.setProperty('--seg-h', h + 'px');
  for (const e of segs) { const basis = Math.max(TRACK_MIN, +e.dataset.w / sumW * avail); e.style.flex = `${basis.toFixed(1)} 1 ${basis.toFixed(1)}px`; }
}
addEventListener('resize', () => { if (!ui.batch.hidden) layoutTrack(); });

function batchAdd(it, done) { const d = done - it.bDone; if (d <= 0) return; batch.px += d * (it.info ? it.info.width * it.info.height : 1e6); batch.frames += d; batch.srcSec += d / ((it.info && it.info.fps) || 30); it.bDone = done; }
function batchTick(cur, done, total, live) {
  const now = performance.now(), elapsed = (now - batch.t0) / 1000;
  if (total) cur.bTotal = total; // real frame count once the file is open
  const px = cur.info ? cur.info.width * cur.info.height : 1e6;
  batchAdd(cur, done);
  const seg = batch.segs.get(cur); if (seg) { seg.classList.add('run'); seg.firstChild.style.width = (cur.bTotal ? done / cur.bTotal * 100 : 0) + '%'; }
  if (!batch.curFirst) batch.curFirst = now; batch.curLast = now;
  const workSec = Math.max(0.5, elapsed - batch.ovh - (batch.curFirst - batch.curStart) / 1000);
  const rate = batch.px / workSec, avgFps = batch.frames / elapsed;
  let remaining = 0, remFiles = 0;
  for (const it of batch.items) {
    if (it === cur) remaining += Math.max(0, it.bTotal - done) * px;
    else if (it.status === 'queued') { remaining += it.bTotal * (it.info ? it.info.width * it.info.height : px); remFiles++; }
  }
  const avgOvh = batch.nEnded ? batch.ovh / batch.nEnded : 1.5;
  // Seconds per frame = a + b × pixels, fitted on finished files (+ the running one): small clips carry a fixed per-frame
  // cost, so a pure pixel rate measured on small clips badly overestimates big 4K files (and vice versa).
  const obs = batch.obs.slice(); if (done > 30 && batch.curFirst) obs.push({ px, frames: done, sec: (now - batch.curFirst) / 1000 });
  let a = 0, bpx = rate > 0 ? 1 / rate : 0;
  const tf = obs.reduce((t, o) => t + o.frames, 0);
  if (tf > 0) {
    const mx = obs.reduce((t, o) => t + o.px * o.frames, 0) / tf, my = obs.reduce((t, o) => t + o.sec, 0) / tf;
    const vxx = obs.reduce((t, o) => t + o.frames * (o.px - mx) ** 2, 0), vxy = obs.reduce((t, o) => t + o.frames * (o.px - mx) * (o.sec / o.frames - my), 0);
    // prior when only one frame size has been seen: the pixel-dependent share of the per-frame time is px/(px+3 MP)
    // (measured: ~7 % at 360p, ~73 % at 4K), the rest is a fixed cost per frame
    const prior = () => { const f0 = mx / (mx + 3e6); a = my * (1 - f0); bpx = my * f0 / mx; };
    if (vxx > 0 && Math.sqrt(vxx / tf) > mx * 0.25) { const b2 = vxy / vxx, a2 = my - b2 * mx; if (b2 > 0 && a2 >= 0) { a = a2; bpx = b2; } else prior(); }
    else prior();
  }
  let rem2 = 0; for (const it of batch.items) { const ipx = it.info ? it.info.width * it.info.height : px; if (it === cur) rem2 += Math.max(0, it.bTotal - done) * (a + bpx * ipx); else if (it.status === 'queued') rem2 += it.bTotal * (a + bpx * ipx); }
  ui.bAvg.textContent = avgFps.toFixed(1); ui.bLive.textContent = live.toFixed(1);
  ui.bFrames.textContent = batch.frames.toLocaleString('en-US'); ui.bElapsed.textContent = fmtClock(elapsed);
  ui.bVids.textContent = `${batch.items.filter(i => i.status === 'done').length}/${batch.items.length}`;
  if (elapsed < 2.5 || batch.frames < 10) return;
  const eta = rem2 + remFiles * avgOvh; ui.bEta.textContent = eta < 1 ? 'any moment' : fmtClock(eta);
  const pctDone = batch.px + remaining > 0 ? Math.round(batch.px / (batch.px + remaining) * 100) : 0;
  ui.bEtaNote.textContent = `${pctDone} % of the work done · finishes around ${new Date(Date.now() + eta * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${fmtTime(eta)} to go`;
  const speed = batch.srcSec / elapsed; ui.bSpeed.textContent = speed.toFixed(2);
  let r = 0; for (let i = 0; i < RANKS.length; i++) if (speed >= RANKS[i].min) r = i;
  if (r !== batch.rank) { const up = r > batch.rank && batch.rank >= 0; batch.rank = r; ui.bRankIco.textContent = RANKS[r].ico; ui.bRankName.textContent = RANKS[r].name; ui.bRankNote.textContent = (cur.info && cur.info.hw !== false && RANKS[r].noteHw) || RANKS[r].note; ui.bRank.className = 'batch-rank'; if (up) { void ui.bRank.offsetWidth; ui.bRank.classList.add('up'); } }
}
function batchItemEnd(it, frames) { if (frames) batchAdd(it, frames); const seg = batch.segs.get(it); if (!seg) return; seg.classList.remove('run'); seg.classList.add(it.status === 'done' ? 'done' : it.status === 'cancelled' ? 'cancel' : 'err'); seg.title = `${it.file.name} – ${it.status === 'done' ? 'done' : it.status === 'cancelled' ? 'cancelled' : 'failed: ' + (it.result || '')}`; if (it.status === 'done') seg.firstChild.style.width = ''; ui.bFrames.textContent = batch.frames.toLocaleString('en-US'); ui.bVids.textContent = `${batch.items.filter(i => i.status === 'done').length}/${batch.items.length}`; }
function batchEnd(ok, secs) {
  if (ok) { ui.bEta.textContent = 'Done'; ui.bEtaNote.textContent = `${batch.frames.toLocaleString('en-US')} frames in ${fmtTime(secs)} · ${(batch.frames / secs).toFixed(1)} fps on average`; }
  else { ui.bEta.textContent = '–'; ui.bEtaNote.textContent = 'stopped'; }
  ui.bElapsed.textContent = fmtClock(secs); if (secs > 0) { ui.bAvg.textContent = (batch.frames / secs).toFixed(1); ui.bSpeed.textContent = (batch.srcSec / secs).toFixed(2); }
}

// ---- results panel: what happened, where the files are, what to do next ----
// ---- correction panel follows the video being processed ----
// In Auto every video gets its own scene and values; the controls now show them (and are locked during a batch,
// because the batch uses the settings it started with). Manual settings apply to every video and simply stay.
const CORR_INPUTS = () => [ui.scene, ui.strength, ui.greenish, ui.redRec, ui.contrast, ui.saturation];
function followStart(base) {
  const f = $('#follow'); if (!f) return;
  CORR_INPUTS().forEach(e => e && (e.disabled = true)); $('#correctionCtl') && $('#correctionCtl').classList.add('locked');
  f.innerHTML = '<span class="dot"></span><span>Menyesuaikan otomatis dengan video – nilai berganti secara halus saat pemandangan bawah air berubah.</span>';
  f.hidden = false;
}
function followItem(item, key) {
  showAdjusted(key, adjFor(item));
  const f = $('#follow'); if (f) f.innerHTML = `<span class="dot"></span><span>Sedang memproses: <b>${esc(item.file.name)}</b> – ${PRESETS[key] ? PRESETS[key].label : key}</span>`;
  const c = $('#correctionCtl'); if (c) { c.classList.remove('flash'); void c.offsetWidth; c.classList.add('flash'); }
}
function followEnd() {
  CORR_INPUTS().forEach(e => e && (e.disabled = false)); const c = $('#correctionCtl'); if (c) c.classList.remove('locked', 'flash');
  const f = $('#follow'); if (f) f.hidden = true;
  if (previewItem) showAdjusted(baseKeyFor(previewItem, adjFor(previewItem)), adjFor(previewItem)); // back to the selected file
}

// ---- live results panel: fills the preview column while a batch runs, finished videos appear as they complete ----
function snapshot(cv) {
  try { const c = document.createElement('canvas'), w = 320; c.width = w; c.height = Math.round(w * cv.height / cv.width); c.getContext('2d').drawImage(cv, 0, 0, c.width, c.height); return c.toDataURL('image/jpeg', 0.72); } catch (_) { return null; }
}
const live = { t0: 0, secs: 0, cancelled: false, final: false, showAll: false };
function renderResults() {
  const box = $('#results'); if (!box) return;
  const inBatch = batch.items.length ? batch.items : items;
  const done = inBatch.filter(i => i.status === 'done'), failed = inBatch.filter(i => i.status === 'error'), total = inBatch.length;
  const where = 'siap disimpan ke galeri perangkat';
  const mb = done.reduce((a, i) => a + (i.outBytes || 0), 0), frames = done.reduce((a, i) => a + (i.bFinal || i.bTotal || 0), 0);
  let head, sub;
  if (!live.final) {
    head = done.length ? `${done.length} dari ${total} selesai` : `Memproses ${countLabel(inBatch)}`;
    sub = done.length ? `${fmtMB(mb)} selesai diproses` : 'Sedang memproses...';
  } else {
    head = live.cancelled ? `Dibatalkan – ${done.length} dari ${total} selesai` : failed.length ? `${done.length} dari ${total} selesai` : `Semua ${countLabel(done)} selesai`;
    sub = `${fmtTime(live.secs)} · ${fmtMB(mb)}`;
  }
  let html = `<div class="rs-head"><span class="rs-ico${live.final ? '' : ' busy'}" aria-hidden="true">${live.final ? (failed.length ? '!' : '✓') : ''}</span><div><b>${head}</b><span>${sub}</span></div></div>`;
  html += `<p class="rs-where">File siap disimpan ke Galeri.</p>`;
  if (done.length) {
    const list = done.slice().reverse();
    const gridW = (box.clientWidth || 640) - 40, cols = Math.max(1, Math.floor((gridW + 10) / (150 + 10))), rows = live.final ? 3 : 2;
    const shown = live.showAll ? list : list.slice(0, cols * rows);
    html += `<div class="rs-grid${live.showAll ? ' all' : ''}">${shown.map(i => {
      const idx = items.indexOf(i), canPlay = !!(i.outFile || i.outHandle || i.viewFile), canSave = !!(i.outFile || i.outHandle || i.viewFile);
      return `<div class="rs-card">${i.thumb ? `<button type="button" class="rs-thumb" data-play="${idx}" ${canPlay ? '' : 'disabled'} aria-label="Play ${esc(i.outName || '')}"><img src="${i.thumb}" alt="">${canPlay ? `<span class="play">${isPhoto(i) ? '⤢' : '▶'}</span>` : ''}</button>` : `<div class="rs-thumb empty"></div>`}
        <div class="rs-meta"><span class="fname" title="${esc(i.outName || i.file.name)}">${esc(i.outName || i.file.name)}</span><span>${i.outBytes ? fmtMB(i.outBytes) : ''}${i.detected && PRESETS[i.detected] ? ' · ' + PRESETS[i.detected].label : ''}${i.streamed ? ' · in Downloads' : ''}</span></div>
        ${canSave ? `<button type="button" class="rs-save" data-save="${idx}">${SAVE_LABEL}</button>` : ''}</div>`;
    }).join('')}</div>${list.length > cols * rows ? `<button type="button" class="rs-toggle" id="rsToggle">${live.showAll ? 'Show fewer' : `Show all ${list.length} finished files`}</button>` : ''}`;
  }
  if (live.final) {
    const btns = [];
    if (done.length) { const saveAllText = (typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.()) ? 'Simpan Semua ke Galeri' : (IS_MOBILE ? 'Simpan Semua' : 'Download Semua'); btns.push(`<button type="button" class="btn btn-glow" id="rsSaveAll">${saveAllText} (${done.length})</button>`); }
    btns.push(`<button type="button" class="btn btn-ghost" id="rsMore">Buka File Lain</button>`);
    
    html += `<div class="rs-btns">${btns.join('')}</div>`;
  }
  if (failed.length) html += `<div class="rs-failed"><b>Kendala:</b><ul>${failed.map(i => `<li><span class="fname">${esc(i.file.name)}</span> – ${esc(i.result || 'error')}</li>`).join('')}</ul></div>`;
  box.innerHTML = html; box.hidden = false;
  box.querySelectorAll('[data-play]').forEach(b => b.addEventListener('click', () => playResult(items[+b.dataset.play], b)));
  box.querySelectorAll('[data-save]').forEach(b => b.addEventListener('click', () => saveOut(items[+b.dataset.save])));
  const sa = $('#rsSaveAll'); if (sa) sa.addEventListener('click', async () => { for (const it of items) if (it.status === 'done' && it.outFile) { await saveOut(it); await new Promise(r => setTimeout(r, 600)); } });
  const more = $('#rsMore'); if (more) more.addEventListener('click', () => { box.hidden = true; ui.fileInput.click(); });
  const tg = $('#rsToggle'); if (tg) tg.addEventListener('click', () => { live.showAll = !live.showAll; renderResults(); });
}
function showResults(r) {
  live.final = true;
  live.secs = r.secs;
  live.cancelled = r.cancelled;
  renderResults();
  ccTrack('results_shown', { ok: r.ok, mode: outMode });
  const failed = items.filter(i => i.status === 'error');
  if (failed.length > 0) {
    const modal = $('#resultsModal');
    if (modal) modal.hidden = false;
  }
}
// play a finished file in a lightweight overlay (reads it back from the folder / browser storage – nothing is uploaded)
let playerUrl = null, playerBusy = false;
async function playResult(it, btn) {
  if (!it || playerBusy) return; playerBusy = true;
  if (btn) btn.classList.add('loading');
  let dlg = $('#rsPlayer');
  if (!dlg) {
    dlg = document.createElement('div'); dlg.id = 'rsPlayer'; dlg.className = 'rs-player'; dlg.hidden = true;
    dlg.innerHTML = `<div class="rs-player-in"><div class="rs-player-top"><span class="fname"></span><button type="button" aria-label="Close">✕</button></div><div class="rs-stage"><video controls playsinline preload="auto"></video><img class="rs-img" alt="" hidden><div class="rs-loading"><span class="spin"></span><b>Loading video…</b><small>Large 4K files can take a few seconds to open.</small></div></div></div>`;
    document.body.appendChild(dlg);
    const v = dlg.querySelector('video');
    const ready = () => dlg.classList.remove('is-loading');
    v.addEventListener('canplay', ready); v.addEventListener('playing', ready);
    v.addEventListener('error', () => { dlg.classList.remove('is-loading'); dlg.querySelector('.rs-loading').innerHTML = '<b>This video cannot be played in the browser.</b><small>The file is fine – open it from your folder with any video player.</small>'; dlg.classList.add('is-loading'); });
    const im = dlg.querySelector('.rs-img'); im.addEventListener('load', ready);
    const close = () => { v.pause(); v.removeAttribute('src'); v.load(); im.removeAttribute('src'); dlg.hidden = true; dlg.classList.remove('is-loading'); };
    dlg.querySelector('.rs-player-top button').addEventListener('click', close); dlg.addEventListener('click', e => { if (e.target === dlg && Date.now() - (+dlg.dataset.openedAt || 0) > 1200 && !dlg.classList.contains('is-loading')) close(); }); // ignore impatient double clicks on the backdrop
    addEventListener('keydown', e => { if (e.key === 'Escape' && !dlg.hidden) close(); });
  }
  // show the overlay straight away with a spinner, then load
  const v = dlg.querySelector('video');
  dlg.querySelector('.rs-loading').innerHTML = '<span class="spin"></span><b>Loading video…</b><small>Large 4K files can take a few seconds to open.</small>';
  dlg.querySelector('.fname').textContent = it.outName || it.file.name; dlg.classList.add('is-loading'); dlg.dataset.openedAt = Date.now(); dlg.hidden = false;
  try {
    let f = it.outFile || it.viewFile; if (!f && it.outHandle) f = await it.outHandle.getFile();
    if (!f) throw new Error('missing');
    if (playerUrl) URL.revokeObjectURL(playerUrl); playerUrl = URL.createObjectURL(f);
    const photo = isPhoto(it), im = dlg.querySelector('.rs-img'); v.hidden = photo; im.hidden = !photo;
    if (photo) { dlg.querySelector('.rs-loading b').textContent = 'Loading photo…'; im.src = playerUrl; } else { v.src = playerUrl; v.play().catch(() => { }); }
  } catch (_) {
    dlg.querySelector('.rs-loading').innerHTML = '<b>The file could not be opened.</b><small>It may have been moved or the folder permission expired – open it from your folder instead.</small>';
  } finally { playerBusy = false; if (btn) btn.classList.remove('loading'); }
  ccTrack('result_play', {});
}
const readLostMsg = () => (ccTrack('read_lost', { android: IS_ANDROID }), IS_ANDROID) ? 'Android withdrew the browser’s access to this file. Please select it again. If it keeps happening, open the app in Chrome instead of Edge, or pick the videos through "Files" / "Browse" instead of the gallery.' : 'The browser lost access to this file (it was moved, renamed or is still syncing). Please select it again.';
function countLabel(list) { const p = list.filter(isPhoto).length, v = list.length - p; return p && v ? (v + ' video dan ' + p + ' foto') : p ? (p + ' foto') : (v + ' video'); }
const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---- review nudge: shown once per finished batch, scrolls to the review form ----
const nudge = { el: $('#rvNudge'), go: $('#rvNudgeGo'), close: $('#rvNudgeClose'), title: $('#rvNudgeTitle') };
function showReviewNudge(n) {
  let done = false; try { done = localStorage.getItem('cc-reviewed') === '1'; } catch (_) { }
  if (done || !nudge.el) return;
  nudge.title.textContent = n === 1 ? 'Your video is done!' : `All ${n} videos are done!`;
  nudge.el.hidden = false; nudge.el.classList.add('sticky');
  ccTrack('review_nudge_show', { videos: n });
}
if (nudge.el) {
  if (nudge.close) nudge.close.addEventListener('click', () => { nudge.el.hidden = true; });
  if (nudge.go) nudge.go.addEventListener('click', () => { nudge.el.hidden = true; });
  document.addEventListener('cc:reviewed', () => { nudge.el.hidden = true; try { localStorage.setItem('cc-reviewed', '1'); } catch (_) { } });
}

let starting = false;
async function start() { // a double tap (two Start buttons) must not run the preparations twice
  if (running || starting) return; starting = true;
  try { await startInner(); } finally { starting = false; }
}
async function startInner() {
  if (running) return;
  await copying; await wmReady;
  if (!items.some(i => i.status === 'queued' || i.status === 'error' || i.status === 'cancelled')) { if (!items.length) ui.fileInput.click(); else setStatus('Semua file dalam antrean sudah selesai diproses.'); return; }
  if (quotaBlocks(items.filter(i => (i.status === 'queued' || i.status === 'error' || i.status === 'cancelled') && !isPhoto(i)).length)) { setStatus(`The ${quota.limit} videos of this subscription year are used – photos still work. Write to jonas@jjsap.com for more.`, 'error'); return; }
  // Seamless start: folder selection is 100% optional
  if (outMode !== 'fsa') { for (const it of items) if (it.status !== 'done') it.outFile = null; await opfsClear(); }
  let wake = null; try { if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch (_) { }
  await previewPromise; if (running) return;
  running = true; cancelled = false; ui.startBtn.disabled = ui.startTop.disabled = true; ui.cancelBtn.disabled = false;
  live.final = false; live.cancelled = false; live.showAll = false;
  { const todo = items.filter(i => i.status !== 'done' && i.status !== 'running');
    ccTrack('run_start', { videos: todo.filter(i => !isPhoto(i)).length, photos: todo.filter(isPhoto).length, minutes: Math.round(todo.reduce((a, i) => a + (i.info ? i.info.duration : 0), 0) / 60 * 10) / 10, res: todo[0] && todo[0].info ? resLabel(todo[0].info.width, todo[0].info.height) : '?', codec: todo[0] && todo[0].info ? codecName(todo[0].info.codec) : '?', decode: todo.some(i => i.info && i.info.hw === false) ? 'software' : 'hardware', scene: ui.scene.value, watermark: wmOn ? 'on' : 'off' }); }
  const base = settings(); const t0 = performance.now(); let totalFrames = 0, totalPixels = 0, okCount = 0, okPhotos = 0, doneMinutes = 0;
  setTimeout(renderResults, 0); followStart(base);
  batchBegin(items.filter(i => i.status !== 'done' && i.status !== 'running'));
  for (const item of items) {
    if (cancelled) break;
    if (item.status === 'done' || item.status === 'running') continue;
    item.status = 'running'; item.result = null; renderQueue();
    const ts = performance.now(); let lastUi = 0; const hist = []; let lastProg = performance.now(), slowShown = false;
    batch.curStart = ts; batch.curFirst = 0; batch.curLast = 0;
    const slowTimer = setInterval(() => {
      if (!running) return; const idle = (performance.now() - lastProg) / 1000, secs = (performance.now() - ts) / 1000;
      const done = hist.length ? hist[hist.length - 1][0] : 0; const cum = secs > 0 ? done / secs : 0;
      if (idle > 20 && !slowShown) { // nothing moved for 20 s: say so instead of leaving the user guessing
        slowShown = true; const info = item.info || {}; const why = info.hw === false ? 'this computer decodes the file in software' : 'the video encoder is not responding';
        showNotice(`<b>Still working on ${item.file.name}, but no new frames for ${Math.round(idle)} s.</b> Likely because ${why}. You can wait, or press Cancel and try "Output size: 1080p" – it is several times faster. ${info.hw === false && /HEVC/.test(codecName(info.codec)) ? 'On a Mac, 5.3K HEVC from a GoPro is decoded in software on Intel machines; recording in 4K avoids that.' : ''}`);
        ccTrack('stall', { codec: codecName(info.codec || ''), res: info.width ? resLabel(info.width, info.height) : '?', decode: info.hw === false ? 'software' : 'hardware', mode: outMode, secs: Math.round(secs), frames: done });
      } else if (!slowShown && secs > 25 && cum > 0 && cum < 6) { // crawling: warn once with the honest ETA and the fast option
        slowShown = true; const total = item.bTotal || 0; const eta = total ? (total - done) / cum : 0;
        showNotice(`<b>This one is slow: ${cum.toFixed(1)} frames per second.</b> ${item.info && item.info.hw === false ? 'Your computer has no hardware decoder for this format, so it decodes in software. ' : ''}${eta ? 'About ' + fmtTime(eta) + ' to go for this file. ' : ''}Faster: press Cancel, set <b>Output size</b> to 1080p (or record in 4K instead of 5.3K) and start again.`);
        ccTrack('slow', { codec: codecName((item.info || {}).codec || ''), res: item.info ? resLabel(item.info.width, item.info.height) : '?', decode: item.info && item.info.hw === false ? 'software' : 'hardware', fps: Math.round(cum * 10) / 10, mode: outMode });
      }
    }, 2000);
    try {
      const r = await processItem(item, base, (done, total, scene) => {
        const now = performance.now(); lastProg = now; hist.push([done, now]); while (hist.length > 2 && now - hist[0][1] > 3000) hist.shift();
        if (now - lastUi < 120) return; lastUi = now;
        const live = hist.length > 1 ? (done - hist[0][0]) / ((now - hist[0][1]) / 1000) : 0;
        const cum = done / ((now - ts) / 1000);
        ui.bar.style.width = (total ? done / total * 100 : 0) + '%';
        batchTick(item, done, total, live);
        setStatus(`${item.file.name}: frame ${done.toLocaleString('en-US')}/${total.toLocaleString('en-US')} · ${live.toFixed(1)} fps` + (item.info && item.info.hw === false ? ' · software decode' : '') + (scene ? ` · ${scene}` : '') + (cum > 0 && total ? ` · about ${fmtTime((total - done) / cum)} left` : ''), 'busy');
      });
      const secs = (performance.now() - ts) / 1000; totalFrames += r.frames; totalPixels += r.pixels || 0; okCount++; item.bFinal = r.frames; item.outBytes = r.bytes; doneMinutes += (item.info ? item.info.duration : 0) / 60;
      item.status = 'done'; rememberDone(item); if (r.photo) okPhotos++;
      item.result = r.photo ? `Foto selesai (${secs.toFixed(1)} dtk) · ${fmtMB(r.bytes)}` : `${r.frames} frame (${fmtTime(secs)}) · ${r.scene} · ${r.codec} · ${fmtMB(r.bytes)}`;
      log(`DONE ${item.file.name} ${JSON.stringify(r)} ${secs.toFixed(2)}s`);
      if (r.photo || items.length === 1) {
        try { await saveOut(item); } catch (autoErr) { console.warn('Auto save failed:', autoErr); }
      }
    } catch (e) {
      if (e && e.message !== '__cancel' && outMode !== 'fsa' && outMode !== 'stream' && !item.memRetry && /save file|open output|write video|finalize/.test(e.message || '') && item.file.size < 600e6) {
        item.memRetry = true; item.noWritable = true; log('retrying in memory after: ' + e.message);
        try { const r2 = await processItem(item, base, () => { }); const secs2 = (performance.now() - ts) / 1000; totalFrames += r2.frames; totalPixels += r2.pixels || 0; okCount++; item.bFinal = r2.frames; item.outBytes = r2.bytes; item.status = 'done'; item.result = `${r2.frames} frames in ${fmtTime(secs2)} · ${r2.scene} · ${r2.codec} · ${fmtMB(r2.bytes)} (${item.inMemory ? 'kept in memory' : 'saved with the fallback writer'})`; clearInterval(slowTimer); batchItemEnd(item, item.bFinal); renderQueue(); renderResults(); continue; } catch (e2) { e = e2; }
      }
      if (e && e.message === '__cancel') { item.status = 'cancelled'; item.result = 'Cancelled'; }
      else { item.status = 'error'; item.result = e && e.name === 'NotReadableError' ? readLostMsg() : e && e.name === 'NotSupportedError' ? `${codecName(item.info && item.info.codec)} could not be decoded: ${e.message}` : (e.message || String(e)); log('ERROR ' + (e.stack || e)); console.error(e); }
    }
    clearInterval(slowTimer); batchItemEnd(item, item.bFinal); renderQueue(); renderResults();
    if (batch.curFirst && item.bFinal > 0) batch.obs.push({ px: item.info ? item.info.width * item.info.height : 1e6, frames: item.bFinal, sec: Math.max(0.01, (batch.curLast - batch.curFirst) / 1000) });
    { const end = performance.now(); batch.ovh += batch.curFirst ? ((batch.curFirst - batch.curStart) + (end - batch.curLast)) / 1000 : (end - batch.curStart) / 1000; batch.nEnded++; }
  }
  running = false; ui.startBtn.disabled = ui.startTop.disabled = false; ui.cancelBtn.disabled = true; ui.bar.style.width = '0';
  followEnd();
  try { wake && wake.release(); } catch (_) { }
  const secs = (performance.now() - t0) / 1000; batchEnd(!cancelled && okCount, secs);
  if (quota.limit && quota.used != null) { quota.used += okCount - okPhotos; quotaRender(); }
  const sceneCount = {}; if (TENANT) for (const i of batch.items) if (i.status === 'done' && !isPhoto(i) && i.detected) sceneCount[i.detected] = (sceneCount[i.detected] || 0) + 1; // dive-centre dashboard: what was filmed, phone or laptop
  if (okCount && !devClip) ccStat('run', { videos: okCount - okPhotos, photos: okPhotos, frames: totalFrames, pixels: totalPixels, minutes: Math.round(doneMinutes * 10) / 10, seconds: Math.round(secs), ...(TENANT ? { mobile: IS_MOBILE ? 1 : 0, scenes: sceneCount } : {}) });
  ccTrack(cancelled ? 'run_cancel' : 'run_done', { videos: okCount - okPhotos, photos: okPhotos, frames: totalFrames, seconds: Math.round(secs), fps: secs > 0 ? Math.round(totalFrames / secs) : 0, watermark: wmOn ? 'on' : 'off' });
  if (cancelled) setStatus('Proses dibatalkan.');
  else if (okCount) setStatus(`Selesai: ${countLabel(batch.items.filter(i => i.status === 'done'))} dalam ${fmtTime(secs)}. Silakan unduh atau simpan hasil di bawah.`);
  else setStatus('Tidak ada file yang diproses. Periksa pesan kendala pada daftar.', 'err');
  showResults({ ok: okCount, total: batch.items.length, frames: totalFrames, secs, cancelled });
  if (!cancelled && okCount) showReviewNudge(okCount);
  if (previewFrame) showPreview();
  if (devClip) document.title = 'DONE';
}
// Chrome/Edge refuse Desktop, Documents, Downloads and the home folder themselves ("can't open this folder because it
// contains system files") – only folders inside them. The page can't tell that apart from Cancel, so after any failed
// pick the note says how to get around it.
const DIR_TIP = 'Desktop, Documents and Downloads themselves are blocked by the browser (“contains system files”) – open one of them and pick or make (“New Folder”) a folder inside it.';
async function pickDir() {
  try { dirHandle = await showDirectoryPicker({ mode: 'readwrite', id: 'freecolor-cc-out', startIn: 'videos' }); }
  catch (e) { if (!dirHandle && outMode === 'fsa') ui.outDirName.textContent = 'No folder chosen. ' + DIR_TIP; throw e; }
  outMode = 'fsa';
  ui.outDirName.textContent = `Saving to: ${dirHandle.name}/  (name_corrected.mp4 / .jpg)`;
}

// ---------- events ----------
ui.drop.addEventListener('click', () => ui.fileInput.click());
ui.drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ui.fileInput.click(); } });
// Never clear the file input after a pick: on Android, resetting it can withdraw the browser's access to the picked
// files, so every file after the first failed with "could not be read" (multi-file picks from the gallery). Instead
// each pick gets a fresh input, and the used one is kept alive (detached) together with its files.
const heldInputs = [];
function onPick() {
  const used = ui.fileInput; addFiles(used.files);
  const fresh = used.cloneNode(false); fresh.addEventListener('change', onPick); if (IS_ANDROID) fresh.setAttribute('accept', ANDROID_ACCEPT);
  used.replaceWith(fresh); heldInputs.push(used); ui.fileInput = fresh;
}
ui.fileInput.addEventListener('change', onPick);
for (const ev of ['dragenter', 'dragover']) document.addEventListener(ev, e => { e.preventDefault(); ui.drop.classList.add('over'); });
for (const ev of ['dragleave', 'drop']) document.addEventListener(ev, e => { e.preventDefault(); if (ev === 'drop' || e.target === document.documentElement) ui.drop.classList.remove('over'); });
document.addEventListener('drop', e => { if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files); });
ui.cmpRange.addEventListener('input', () => ui.cmp.style.setProperty('--pos', ui.cmpRange.value + '%'));
ui.scene.addEventListener('change', () => {
  const v = ui.scene.value, it = previewItem;
  const a = applyTo === 'all' || !it ? globalAdj : (it.adj = it.adj || JSON.parse(JSON.stringify(globalAdj)));
  a.scene = v; if (applyTo === 'all') for (const x of items) delete x.adj;
  showAdjusted(baseKeyFor(it, a), a); rerenderPreview(); renderQueue(); stepSummaries();
  ccTrack('scene_pick', { scene: v, target: applyTo });
});
ui.strength.addEventListener('input', () => { syncOutputs(); userTweak(); rerenderPreview(); });
try { const v = localStorage.getItem('cc-smoothing'); if (v !== null && [...ui.smooth.options].some(o => o.value === v)) ui.smooth.value = v; } catch (_) { }
ui.smooth.addEventListener('change', () => { try { localStorage.setItem('cc-smoothing', ui.smooth.value); } catch (_) { } stepSummaries(); ccTrack('smoothing', { v: ui.smooth.value }); });
ui.greenish.addEventListener('change', () => { userTweak(); rerenderPreview(); });
for (const el of [ui.redRec, ui.contrast, ui.saturation]) el.addEventListener('input', () => { syncOutputs(); userTweak(); rerenderPreview(); });
for (const r of document.querySelectorAll('input[name="applyTo"]')) r.addEventListener('change', () => {
  applyTo = r.value;
  if (applyTo === 'all' && previewItem && previewItem.adj) { globalAdj = JSON.parse(JSON.stringify(previewItem.adj)); } // "apply to all" takes this video's changes
  if (applyTo === 'all') for (const x of items) delete x.adj;
  if (previewItem) showAdjusted(baseKeyFor(previewItem, adjFor(previewItem)), adjFor(previewItem));
  rerenderPreview(); renderQueue(); updateAdjUi(); ccTrack('apply_to', { v: applyTo });
});
$('#adjReset') && $('#adjReset').addEventListener('click', () => {
  if (applyTo === 'all' || !previewItem || !previewItem.adj) { globalAdj = EMPTY_ADJ(); for (const x of items) delete x.adj; } else delete previewItem.adj;
  if (previewItem) showAdjusted(baseKeyFor(previewItem, adjFor(previewItem)), adjFor(previewItem));
  rerenderPreview(); renderQueue(); stepSummaries();
});
// Warmth is an output setting (step 3): same for every video, does not switch the scene to Custom, remembered per browser.
try { const w = localStorage.getItem('cc-warmth'); if (w !== null) ui.warmth.value = w; } catch (_) { }
ui.warmth.addEventListener('input', () => { syncOutputs(); rerenderPreview(); try { localStorage.setItem('cc-warmth', ui.warmth.value); } catch (_) { } });
ui.warmth.addEventListener('change', () => ccTrack('warmth', { v: +ui.warmth.value }));
for (const el of [ui.outSize, ui.quality, ui.measureEvery, ui.scene, ui.outCodec]) el.addEventListener('change', stepSummaries);
ui.denoise.addEventListener('change', () => { stepSummaries(); rerenderPreview(); });
for (const [el, k] of [[ui.outCodec, 'cc-codec'], [ui.quality, 'cc-quality'], [ui.denoise, 'cc-denoise']]) {
  try { const v = localStorage.getItem(k); if (v !== null && [...el.options].some(o => o.value === v)) el.value = v; } catch (_) { }
  el.addEventListener('change', () => { try { localStorage.setItem(k, el.value); } catch (_) { } ccTrack('output_choice', { [k.slice(3)]: el.value }); });
}
stepSummaries();
syncOutputs();
// measureEvery is a fixed processing setting – changing it does not switch the scene to 'custom'.
ui.outDirBtn.addEventListener('click', () => pickDir().catch(() => { }));
// Watermark opt-out: a quiet text toggle; switching it off first offers a donation.
let wmOn = false;
function setWm(on, remember = true) {
  if (TENANT && !TENANT.tagOptional) on = true;           // a centre's tag is always on – that is the point of it; a pro plan may switch its own tag off
  wmOn = on; gl.uniform1f(U.uWmOn, on ? 1 : 0);
  ui.wmToggle.textContent = TENANT ? (on ? 'Your tag: on · remove' : 'Your tag: off · turn on') : (on ? 'Watermark: on · remove' : 'Watermark: off · turn on');
  if (remember) { try { localStorage.setItem('cc-wm', on ? 'on' : 'off'); } catch (_) { } }
  rerenderPreview();
}
const closeWmModal = () => { ui.wmModal.hidden = true; };
ui.wmToggle.addEventListener('click', () => { if (wmOn) { if (TENANT && TENANT.tagOptional) { setWm(false); ccTrack('tag_off', {}); return; } ui.wmModal.hidden = false; ui.wmKeep.focus(); ccTrack('watermark_modal', {}); } else { setWm(true); ccTrack('watermark_on', {}); } });
ui.wmKeep.addEventListener('click', () => { setWm(true); closeWmModal(); ccTrack('watermark_keep', {}); });
ui.wmRemove.addEventListener('click', () => { setWm(false); closeWmModal(); ccTrack('watermark_off', { via: 'no_donation' }); });
ui.wmDonate.addEventListener('click', () => { setWm(false); closeWmModal(); ccTrack('watermark_off', { via: 'donate' }); });
ui.wmModal.addEventListener('click', e => { if (e.target === ui.wmModal) closeWmModal(); });
addEventListener('keydown', e => { if (e.key === 'Escape' && !ui.wmModal.hidden) closeWmModal(); });
try { if (localStorage.getItem('cc-wm') === 'off') setWm(false, false); } catch (_) { }
// Dive-centre address: lock the tag, swap the header for the centre, hide donations and the dive-centre pitch, keep out of search.
function applyTenant(t) {
  const textless = t.style === 'logo' || (t.showName === false && t.showWeb === false);
  WM_SCALE = (+t.scale || (textless ? 0.45 : 0.75)) * (+t.size || 1); setWm(true, false);   // size = the dashboard's size slider (60–140 %)
  [...(t.tagOptional ? [] : [ui.wmToggle]), ...document.querySelectorAll('[data-donate], .nav-actions a[href="/color-correction/dive-centers"]')].forEach(n => { n.hidden = true; n.style.display = 'none'; }); // .btn's display beats [hidden]
  if (t.tagOptional) { try { if (localStorage.getItem('cc-wm') === 'off') setWm(false, false); } catch (_) { } }   // pro plan: remembers the choice like the free tool
  const brand = $('.brand');
  if (brand) {
    if (t.web) brand.href = 'https://' + t.web; brand.setAttribute('aria-label', t.name);
    const im = brand.querySelector('img'), tool = brand.querySelector('.tool');
    if (im && t.logo) { im.alt = t.name; im.removeAttribute('width'); im.removeAttribute('height'); im.style.cssText = ''; im.classList.add('tlogo', 'tlogo-hd'); fitLogo(im, t.logo); }
    else if (im) im.remove();                                // no logo yet: the name alone, never ours
    if (tool) { tool.textContent = t.name; if (!t.logo) tool.style.cssText = 'font-family:var(--display);font-size:1.05rem;font-weight:700;letter-spacing:-.01em;text-transform:none;color:var(--ice);border-left:0;padding-left:0'; }
  }
  const about = $('.nav-actions a[href="/color-correction"]');   // "About the tool" becomes the centre's login
  if (about) { about.textContent = 'Log in'; about.href = '/dashboard'; about.classList.remove('hide-sm'); about.setAttribute('aria-label', 'Dive centre login'); }
  const rv = $('#reviews'); if (rv) rv.remove();
  tenantFooter(t);
  if (t.quota) quotaWatch(t);
  document.title = t.name + ' – fix the colours in your dive videos';
  const m = document.querySelector('meta[name="robots"]') || document.head.appendChild(document.createElement('meta')); m.name = 'robots'; m.content = 'noindex, nofollow';
}
// Pro plans (a creator using the tool for their own customers): a yearly video quota. The server counts videos per
// month per address; the app sums the months of the current subscription year (from `since`), shows the count in
// the footer and stops at the limit – the next year starts on the anniversary of `since`.
const quota = { limit: 0, used: null, el: null };
async function quotaWatch(t) {
  quota.limit = +t.quota || 0; if (!quota.limit) return;
  try {
    const months = DEV && new URLSearchParams(location.search).get('used') ? null : (await (await fetch('/api/stats?host=' + encodeURIComponent(t.host), { cache: 'no-store' })).json()).months || {};
    const since = new Date(t.since || Date.now()), now = new Date(), start = new Date(since); start.setFullYear(now.getFullYear()); if (start > now) start.setFullYear(now.getFullYear() - 1);
    const from = start.toISOString().slice(0, 7);
    quota.used = months ? Object.entries(months).reduce((a, [k, v]) => a + (k >= from ? v : 0), 0) : +new URLSearchParams(location.search).get('used');
  } catch (_) { quota.used = null; }                      // offline or no API: nothing to show, nothing blocked
  quotaRender();
}
function quotaRender() {
  if (!quota.limit || quota.used == null) return;
  if (!quota.el) { quota.el = document.createElement('p'); quota.el.className = 'tf-legal'; quota.el.style.cssText = 'margin-top:.4rem;color:var(--ice)'; const box = document.querySelector('footer .tf'); if (box) box.after(quota.el); }
  quota.el.textContent = `Videos this subscription year: ${quota.used.toLocaleString('en-US')} of ${quota.limit.toLocaleString('en-US')}.`;
  if (quota.used >= quota.limit) { quota.el.style.color = 'var(--sun)'; showNotice(`<b>The ${quota.limit.toLocaleString('en-US')} videos of this subscription year are used.</b> Photos still work. For more videos, write to <a href="mailto:jonas@jjsap.com">jonas@jjsap.com</a> – the next plan has no limit.`); }
}
function quotaBlocks(videoCount) { return !!(quota.limit && quota.used != null && videoCount > 0 && quota.used >= quota.limit); }
// The centre's own footer instead of ours: logo and name, a few lines about the centre, contact links and a note to
// the guests – everything from tenants.json (later editable in the dashboard). No Nordrift branding: that is what the
// centre pays for. All text goes in as text, never as HTML.
// A dive centre's logo, whatever its shape: transparent margins trimmed, own proportions kept (never cropped into a circle
// or stretched), wide wordmarks get the class "wide"; a logo without transparency (a JPG with a white box) gets a light
// rounded plate so it looks intended on the dark page. Logos are same-origin, so the canvas may read them.
function fitLogo(im, src) {
  im.onload = () => {
    im.onload = null; let w = im.naturalWidth, h = im.naturalHeight; if (!w || !h) return;
    try {
      const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.drawImage(im, 0, 0);
      const d = x.getImageData(0, 0, w, h).data; let t = h, l = w, b = -1, r = -1, opaque = true;
      for (let y = 0; y < h; y++) for (let i = 0; i < w; i++) { const a = d[(y * w + i) * 4 + 3]; if (a < 250) opaque = false; if (a > 8) { if (y < t) t = y; if (y > b) b = y; if (i < l) l = i; if (i > r) r = i; } }
      if (opaque) im.classList.add('plate');
      else if (b >= 0 && (r - l + 1) * (b - t + 1) < w * h * 0.92) {
        const o = document.createElement('canvas'); o.width = r - l + 1; o.height = b - t + 1; o.getContext('2d').drawImage(c, l, t, o.width, o.height, 0, 0, o.width, o.height);
        w = o.width; h = o.height; im.src = o.toDataURL('image/png');
      }
    } catch (_) { }
    im.classList.toggle('wide', w / h > 1.6);
  };
  im.src = src;
}
// Contact icons: Tabler Icons (MIT, tabler.io/icons), drawn with the page's stroke colour.
const TF_ICONS = {
  'Find us': '<path d="M9 11a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"/><path d="M17.657 16.657l-4.243 4.243a2 2 0 0 1 -2.827 0l-4.244 -4.243a8 8 0 1 1 11.314 0z"/>',
  Phone: '<path d="M5 4h4l2 5l-2.5 1.5a11 11 0 0 0 5 5l1.5 -2.5l5 2v4a2 2 0 0 1 -2 2a16 16 0 0 1 -15 -15a2 2 0 0 1 2 -2"/>',
  WhatsApp: '<path d="M3 21l1.65 -3.8a9 9 0 1 1 3.4 2.9l-5.05 .9"/><path d="M9 10a.5 .5 0 0 0 1 0v-1a.5 .5 0 0 0 -1 0v1a5 5 0 0 0 5 5h1a.5 .5 0 0 0 0 -1h-1a.5 .5 0 0 0 0 1"/>',
  Email: '<path d="M3 7a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-10z"/><path d="M3 7l9 6l9 -6"/>',
  Instagram: '<path d="M4 8a4 4 0 0 1 4 -4h8a4 4 0 0 1 4 4v8a4 4 0 0 1 -4 4h-8a4 4 0 0 1 -4 -4z"/><path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"/><path d="M16.5 7.5v.01"/>',
  Facebook: '<path d="M7 10v4h3v7h4v-7h3l1 -4h-4v-2a1 1 0 0 1 1 -1h3v-4h-3a5 5 0 0 0 -5 5v2h-3"/>',
  Website: '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0"/><path d="M3.6 9h16.8"/><path d="M3.6 15h16.8"/><path d="M11.5 3a17 17 0 0 0 0 18"/><path d="M12.5 3a17 17 0 0 1 0 18"/>',
};
function tenantFooter(t) {
  const foot = document.querySelector('footer .wrap'); if (!foot) return;
  const E = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  foot.textContent = '';
  const box = E('div', 'tf'), id = E('div', 'tf-id');
  if (t.logo) { const im = E('img', 'tlogo tlogo-ft'); im.alt = ''; fitLogo(im, t.logo); id.appendChild(im); }
  const nm = E('div'); nm.appendChild(E('b', null, t.name)); if (t.web) nm.appendChild(E('span', 'mono', t.web)); id.appendChild(nm); box.appendChild(id);
  if (t.about) box.appendChild(E('p', 'tf-about', t.about));
  const ul = E('ul', 'tf-contact');
  const row = (label, text, href) => { const li = E('li'), ic = E('span', 'tf-ic'); ic.setAttribute('aria-hidden', 'true'); ic.innerHTML = '<svg viewBox="0 0 24 24">' + (TF_ICONS[label] || '') + '</svg>'; li.appendChild(ic); li.appendChild(E('span', 'mono', label)); if (href) { const a = E('a', null, text); a.href = href; if (/^https?:/.test(href)) { a.target = '_blank'; a.rel = 'noopener'; } li.appendChild(a); } else li.appendChild(E('span', null, text)); ul.appendChild(li); };
  if (t.address) row('Find us', t.address, t.maps);
  if (t.phone) row('Phone', t.phone, 'tel:' + t.phone.replace(/[^+\d]/g, ''));
  if (t.whatsapp) row('WhatsApp', t.whatsapp, 'https://wa.me/' + t.whatsapp.replace(/\D/g, ''));
  if (t.email) row('Email', t.email, 'mailto:' + t.email);
  if (t.instagram) { const h = t.instagram.replace(/^@/, ''); row('Instagram', '@' + h, 'https://instagram.com/' + h); }
  if (t.facebook) row('Facebook', t.facebook, 'https://facebook.com/' + t.facebook);
  if (t.web) row('Website', t.web, 'https://' + t.web);
  if (ul.children.length) box.appendChild(ul);
  if (t.note) { const n = E('div', 'tf-note'); n.appendChild(E('span', 'mono', 'From ' + t.name)); n.appendChild(E('span', null, t.note)); box.appendChild(n); }
  foot.appendChild(box);
  foot.appendChild(E('p', 'tf-legal', 'Works offline: open this page once with internet and it keeps working without – on the boat too. Everything runs on your own device, nothing is uploaded, and you keep all rights to your footage. The colour-correction engine is licensed to ' + t.name + '; all rights reserved.'));
}
ui.startBtn.addEventListener('click', start); ui.startTop.addEventListener('click', start);
ui.cancelBtn.addEventListener('click', () => { cancelled = true; ui.cancelBtn.disabled = true; setStatus('Cancelling …', 'busy'); });
addEventListener('beforeunload', e => { if (running) { e.preventDefault(); e.returnValue = ''; } });
syncOutputs();
$('#year').textContent = new Date().getFullYear();
log(`support: ${JSON.stringify(support)}`);

// ---------- dev harness (localhost only): ?dev=<clip in /clips/> ----------
if (devClip) (async () => {
  try {
    if (new URLSearchParams(location.search).has('manual')) { document.title = 'MANUAL'; return; } // demo recordings: user adds files, output still goes to /out
    const files = [];
    for (const name of devClip.split(',')) { const blob = await (await fetch('/clips/' + name)).blob(); files.push(new File([blob], name.split('/').pop(), { type: IMG_RE.test(name) ? ({ png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif' }[name.split('.').pop().toLowerCase()] || 'image/jpeg') : 'video/mp4' })); }
    await addFiles(files);
    if (new URLSearchParams(location.search).has('nostart')) { document.title = 'READY'; return; }
    await new Promise(r => setTimeout(r, 1500));
    await start();
  } catch (e) { log('DEV ERROR ' + (e.stack || e)); document.title = 'ERR'; }
})();
})();
