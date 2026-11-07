// Specialist 4: Backscatter & Marine Snow Eliminator (BackscatterXterminator Logic)
// Uses Separable 1D Directional Morphology max(open_X, open_Y) to detect isolated
// floating detritus and strobe-illuminated backscatter specks (1 to 10 px) without damaging
// fine structural edges (such as mask straps, turtle shell sutures, diver fingers, or coral tips).
// Applies Normalized Spatial Convolution Inpainting to restore clean ambient color.

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function luma(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function boxBlur(src, w, h, r) {
  if (r <= 0) return new Float32Array(src);
  const n = w * h;
  const tmp = new Float32Array(n);
  const out = new Float32Array(n);

  // Horizontal pass
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = -r; x <= r; x++) {
      const px = Math.min(Math.max(x, 0), w - 1);
      sum += src[row + px];
    }
    const inv = 1 / (2 * r + 1);
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum * inv;
      const left = Math.max(x - r, 0);
      const right = Math.min(x + r + 1, w - 1);
      sum += src[row + right] - src[row + left];
    }
  }

  // Vertical pass
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) {
      const py = Math.min(Math.max(y, 0), h - 1);
      sum += tmp[py * w + x];
    }
    const inv = 1 / (2 * r + 1);
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum * inv;
      const top = Math.max(y - r, 0);
      const bottom = Math.min(y + r + 1, h - 1);
      sum += tmp[bottom * w + x] - tmp[top * w + x];
    }
  }

  return out;
}

export function eliminateBackscatter({
  R,
  G,
  B,
  w,
  h,
  spotRemovalParam = 0,
}) {
  const n = w * h;
  const speckAmt = spotRemovalParam / 100;
  const speckMask = new Uint8Array(n);
  let backscatterSpots = 0;
  let speckPixels = 0;

  if (speckAmt <= 0.01 || n <= 4096) {
    return { backscatterSpots: 0, speckPixels: 0, speckMask };
  }

  const curL = new Float32Array(n);
  for (let i = 0; i < n; i++) curL[i] = luma(R[i], G[i], B[i]);

  const rMorph = Math.max(3, Math.min(8, Math.round(Math.min(w, h) / 100)));

  // 1. Separable 1D Horizontal Opening (min then max)
  const openX = new Float32Array(n);
  const tempX = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let mn = 1.0;
      const xMin = Math.max(0, x - rMorph);
      const xMax = Math.min(w - 1, x + rMorph);
      for (let k = xMin; k <= xMax; k++) {
        const val = curL[row + k];
        if (val < mn) mn = val;
      }
      tempX[row + x] = mn;
    }
    for (let x = 0; x < w; x++) {
      let mx = 0.0;
      const xMin = Math.max(0, x - rMorph);
      const xMax = Math.min(w - 1, x + rMorph);
      for (let k = xMin; k <= xMax; k++) {
        const val = tempX[row + k];
        if (val > mx) mx = val;
      }
      openX[row + x] = mx;
    }
  }

  // 2. Separable 1D Vertical Opening (min then max)
  const openY = new Float32Array(n);
  const tempY = new Float32Array(n);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let mn = 1.0;
      const yMin = Math.max(0, y - rMorph);
      const yMax = Math.min(h - 1, y + rMorph);
      for (let k = yMin; k <= yMax; k++) {
        const val = curL[k * w + x];
        if (val < mn) mn = val;
      }
      tempY[y * w + x] = mn;
    }
    for (let y = 0; y < h; y++) {
      let mx = 0.0;
      const yMin = Math.max(0, y - rMorph);
      const yMax = Math.min(h - 1, y + rMorph);
      for (let k = yMin; k <= yMax; k++) {
        const val = tempY[k * w + x];
        if (val > mx) mx = val;
      }
      openY[y * w + x] = mx;
    }
  }

  // 3. Directional Structure Fusion:
  // Continuous real edges survive openX or openY.
  // Isolated round/elliptical backscatter specks vanish in BOTH!
  const cleanR = new Float32Array(n);
  const cleanG = new Float32Array(n);
  const cleanB = new Float32Array(n);
  const cleanWeight = new Float32Array(n);

  const thresh = 0.065 - speckAmt * 0.025;

  for (let y = 1; y < h - 1; y++) {
    const yNorm = y / (h - 1);
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = row + x;
      const l = curL[i];
      // Skip extreme top sun glare
      if (yNorm < 0.08 && l > 0.88) {
        cleanR[i] = R[i];
        cleanG[i] = G[i];
        cleanB[i] = B[i];
        cleanWeight[i] = 1.0;
        continue;
      }

      const structEnv = Math.max(openX[i], openY[i]);
      const peak = l - structEnv;

      if (peak > thresh && l > 0.18) {
        speckMask[i] = 1;
        backscatterSpots++;
      } else {
        cleanR[i] = R[i];
        cleanG[i] = G[i];
        cleanB[i] = B[i];
        cleanWeight[i] = 1.0;
      }
    }
  }

  // 4. Normalized Spatial Convolution Inpainting
  if (backscatterSpots > 0) {
    const rInpaint = rMorph + 2;
    const numR = boxBlur(cleanR, w, h, rInpaint);
    const numG = boxBlur(cleanG, w, h, rInpaint);
    const numB = boxBlur(cleanB, w, h, rInpaint);
    const den = boxBlur(cleanWeight, w, h, rInpaint);
    const blendStr = clamp01(speckAmt * 1.35);

    for (let i = 0; i < n; i++) {
      if (!speckMask[i]) continue;
      const wgt = den[i];
      if (wgt > 0.02) {
        const inpR = numR[i] / wgt;
        const inpG = numG[i] / wgt;
        const inpB = numB[i] / wgt;
        R[i] = clamp01(R[i] * (1 - blendStr) + inpR * blendStr);
        G[i] = clamp01(G[i] * (1 - blendStr) + inpG * blendStr);
        B[i] = clamp01(B[i] * (1 - blendStr) + inpB * blendStr);
        speckPixels++;
      }
    }
  }

  return {
    backscatterSpots,
    speckPixels,
    speckMask,
  };
}
