/*! Nordrift Underwater Color Correction · © 2026 Nordrift / Jonas Jensen. All rights reserved. */
// H.264 bitstream repair for the MP4 muxer. An MP4 needs length-prefixed NAL units plus an avcC record with the
// SPS/PPS. Some browser encoders hand out Annex B (start codes) and/or no avcC description. Chrome and VLC play
// such files anyway, Apple (Photos, iMovie, QuickTime) refuses them. fix() returns repaired data/metadata, or null
// when the chunk is already fine.
window.ccAvc = (() => {
  const isAnnexB = d => d.length > 4 && d[0] === 0 && d[1] === 0 && (d[2] === 1 || (d[2] === 0 && d[3] === 1));
  function annexBNals(d) {
    const out = []; let i = 0, start = -1;
    while (i + 2 < d.length) {
      if (d[i] === 0 && d[i + 1] === 0 && (d[i + 2] === 1 || (d[i + 2] === 0 && i + 3 < d.length && d[i + 3] === 1))) {
        if (start >= 0) out.push(d.subarray(start, i));
        i += d[i + 2] === 1 ? 3 : 4; start = i;
      } else i++;
    }
    if (start >= 0) out.push(d.subarray(start));
    return out.filter(n => n.length);
  }
  function lengthNals(d) {
    const out = [];
    for (let p = 0; p + 4 <= d.length;) { const n = ((d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3]) >>> 0; if (!n || p + 4 + n > d.length) break; out.push(d.subarray(p + 4, p + 4 + n)); p += 4 + n; }
    return out;
  }
  function toLengthPrefixed(list) {
    let n = 0; for (const x of list) n += 4 + x.length;
    const o = new Uint8Array(n); let p = 0;
    for (const x of list) { const l = x.length; o[p] = l >>> 24; o[p + 1] = (l >> 16) & 255; o[p + 2] = (l >> 8) & 255; o[p + 3] = l & 255; o.set(x, p + 4); p += 4 + l; }
    return o;
  }
  function avcC(sps, pps) {
    const o = new Uint8Array(11 + sps.length + pps.length);
    o.set([1, sps[1], sps[2], sps[3], 0xFF, 0xE1, sps.length >> 8, sps.length & 255]); o.set(sps, 8);
    let p = 8 + sps.length; o[p++] = 1; o[p++] = pps.length >> 8; o[p++] = pps.length & 255; o.set(pps, p);
    return o;
  }
  const bytesOf = b => b ? (b instanceof Uint8Array ? b : ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b)) : null;
  // st: per-file state object; codec: the configured codec string (used if the encoder gives no decoderConfig)
  function fix(data, meta, st, codec) {
    const annexB = isAnnexB(data), list = annexB ? annexBNals(data) : null;
    const desc = bytesOf(meta && meta.decoderConfig && meta.decoderConfig.description);
    let newDesc = null;
    if (meta && meta.decoderConfig && !st.descDone) {
      if (desc && desc.length > 6 && desc[0] === 1) st.descDone = true; // a proper avcC
      else { // missing or in Annex B form: build one from the SPS/PPS
        const src = desc && isAnnexB(desc) ? annexBNals(desc) : list || lengthNals(data);
        const sps = src.find(n => (n[0] & 31) === 7), pps = src.find(n => (n[0] & 31) === 8);
        if (sps && pps) { newDesc = avcC(sps, pps); st.descDone = true; st.built = true; }
      }
    }
    if (!annexB && !newDesc) return null;
    if (annexB) st.annexB = true;
    const out = annexB ? toLengthPrefixed(list.filter(n => (n[0] & 31) !== 9)) : data; // drop access unit delimiters
    const m = newDesc ? { ...meta, decoderConfig: { ...meta.decoderConfig, codec: meta.decoderConfig.codec || codec, description: newDesc } } : meta;
    return { data: out, meta: m };
  }
  return { fix, isAnnexB, annexBNals, lengthNals };
})();
