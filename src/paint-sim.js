// Paint simulation on a grid of paper cells.
//
// Water-based media (watercolour, ink, gouache) follow a simplified version of
// Curtis et al. 1997, "Computer-Generated Watercolor":
//   - water flows between neighbouring cells, downhill over the paper surface
//   - suspended pigment travels with the water, so wet colours bleed together
//   - cells at the edge of a wet area evaporate faster, which pulls water and
//     pigment outwards and leaves darker rims
//   - pigment settles faster in the paper's valleys (granulation)
//   - very wet areas run downwards (the board is slightly tilted)
//   - dried pigment is glazed onto the paper with Beer–Lambert absorption,
//     plus a hiding term for opaque media
//
// Oil uses a separate bristle-brush model: strokes push and pick up wet paint,
// thin out as the brush unloads, and build up a height map that is lit later.

import { rng } from './sky.js';

export const MEDIA = {
  watercolour: { flow: 0.2, wetFront: 1.3, fibre: 0.75, slope: 0.6, gravity: 0.28, runAt: 0.6, evap: 0.016, edgeEvap: 3.2, mobility: 1.0, deposit: 0.0012, granulate: 0.035, absorb: 1.25, hide: 0.04, pin: 0.12, redissolve: 0.2, fur: 0.85, steps: 80 },
  ink:         { flow: 0.3, wetFront: 0.12, fibre: 1.0, slope: 0.04, gravity: 0.08, runAt: 0.7, evap: 0.016, edgeEvap: 4.0, mobility: 1.0, deposit: 0.0015, granulate: 0.004, absorb: 1.5, hide: 0.0, pin: 0.16, redissolve: 0.75, fur: 1.0, steps: 70 },
  gouache:     { flow: 0.12, wetFront: 0.9, fibre: 0.15, slope: 0.2, gravity: 0.0, runAt: 9, evap: 0.026, edgeEvap: 0.15, mobility: 0.55, deposit: 0.02, granulate: 0.0, absorb: 0.7, hide: 2.4, pin: 0, redissolve: 0.35, fur: 0.6, steps: 45 },
};

const EPS = 0.002;

// Per-cell random wicking threshold: every fibre takes water a little differently,
// which breaks wet edges into fine, furry fingers. Same hash as the GPU shader.
export function cellRand(x, y) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return (h & 0xffff) / 65535;
}

// Accept a canvas or raw RGBA bytes.
function pixels(src) {
  if (src && src.getContext) return src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, src.width, src.height).data;
  return src;
}

// ------------------------------------------------------------ paper

function valueNoise(w, h, R, cell) {
  const gw = Math.ceil(w / cell) + 2, gh = Math.ceil(h / cell) + 2;
  const grid = new Float32Array(gw * gh).map(() => R());
  const out = new Float32Array(w * h);
  const s = (t) => t * t * (3 - 2 * t);
  for (let y = 0; y < h; y++) {
    const gy = y / cell, y0 = gy | 0, ty = s(gy - y0);
    for (let x = 0; x < w; x++) {
      const gx = x / cell, x0 = gx | 0, tx = s(gx - x0);
      const a = grid[y0 * gw + x0], b = grid[y0 * gw + x0 + 1], c = grid[(y0 + 1) * gw + x0], d = grid[(y0 + 1) * gw + x0 + 1];
      out[y * w + x] = (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * ty;
    }
  }
  return out;
}

export function makePaper(w, h, seed) {
  const R = rng(seed ^ 0x9e3779b9);
  const H = new Float32Array(w * h);
  const octaves = [[24, 0.35], [10, 0.3], [4, 0.2], [2, 0.15]];
  for (const [cell, wt] of octaves) {
    const n = valueNoise(w, h, R, cell);
    for (let i = 0; i < H.length; i++) H[i] += n[i] * wt;
  }
  // fibres: short random strokes pressed into the sheet
  for (let f = 0; f < (w * h) / 40; f++) {
    let x = R() * w, y = R() * h;
    const a = R() * Math.PI, len = 4 + R() * 14, dx = Math.cos(a), dy = Math.sin(a), amt = (R() - 0.4) * 0.12;
    for (let k = 0; k < len; k++) {
      const xi = x | 0, yi = y | 0;
      if (xi >= 0 && yi >= 0 && xi < w && yi < h) H[yi * w + xi] += amt;
      x += dx; y += dy;
    }
  }
  let lo = Infinity, hi = -Infinity;
  for (const v of H) { if (v < lo) lo = v; if (v > hi) hi = v; }
  for (let i = 0; i < H.length; i++) H[i] = (H[i] - lo) / (hi - lo);

  // Direction-dependent conductivity, so water creeps further along some fibres.
  const nx = valueNoise(w, h, R, 3), ny = valueNoise(w, h, R, 3);
  // A few columns where water can find a line down the tilted sheet (drips).
  const chan = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    if (R() > 0.035) continue;
    let cx = x;
    for (let y = 0; y < h; y++) {
      if (R() < 0.04) cx += R() < 0.5 ? -1 : 1;
      if (cx >= 0 && cx < w) chan[y * w + cx] = 1;
    }
  }
  return { w, h, H, nx, ny, chan };
}

// ------------------------------------------------------------ water-based media

export class WetSim {
  constructor(paper, medium, paperColour) {
    const { w, h } = paper;
    this.w = w; this.h = h; this.n = w * h;
    this.paper = paper;
    this.p = MEDIA[medium] || MEDIA.watercolour;
    const N = this.n;
    this.W = new Float32Array(N);   // water
    this.M = new Float32Array(N);   // suspended pigment mass
    this.Pr = new Float32Array(N); this.Pg = new Float32Array(N); this.Pb = new Float32Array(N); // mass-weighted colour
    this.D = new Float32Array(N);   // deposited mass (this layer)
    this.Dr = new Float32Array(N); this.Dg = new Float32Array(N); this.Db = new Float32Array(N);
    this.fx = new Float32Array(N); this.fy = new Float32Array(N);
    // canvas colour, linear-ish 0..1
    this.C = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) { this.C[i * 3] = paperColour[0] / 255; this.C[i * 3 + 1] = paperColour[1] / 255; this.C[i * 3 + 2] = paperColour[2] / 255; }
    this.paperColour = paperColour.map((v) => v / 255);
    const f = this.p.fibre;
    this.kx = new Float32Array(N); this.ky = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      this.kx[i] = Math.max(0.05, 1 + f * (paper.nx[i] - 0.5) * 2.4);
      this.ky[i] = Math.max(0.05, 1 + f * (paper.ny[i] - 0.5) * 2.4);
    }
    this.wind = [0, 0];
    this.gravity = this.p.gravity;
    this.fz = new Float32Array(N);
    const fur = this.p.fur ?? 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) this.fz[y * w + x] = Math.max(0.15, 1 + fur * (cellRand(x, y) - 0.5) * 2);
  }

  // Add water and pigment from rasterised marks (Uint8ClampedArray RGBA from canvases).
  addMarks(water, mass, colour, waterScale = 2, massScale = 1.5) {
    water = pixels(water); mass = pixels(mass); colour = pixels(colour);
    const { W, M, Pr, Pg, Pb, C } = this;
    const rd = this.p.redissolve || 0, absorb = this.p.absorb, pc = this.paperColour;
    for (let i = 0, j = 0; i < this.n; i++, j += 4) {
      // amounts are stored in the alpha channel (the canvases are built up additively)
      const wv = water[j + 3] / 255 * waterScale;
      if (wv > 0) W[i] += wv;
      // Re-wetting: water lifts some of the dried paint back into suspension.
      if (wv > 0 && rd > 0) {
        const f = Math.min(1, wv) * rd, k = 3 * i;
        const l0 = -Math.log(Math.max(C[k] / pc[0], 0.02)) * f;
        const l1 = -Math.log(Math.max(C[k + 1] / pc[1], 0.02)) * f;
        const l2 = -Math.log(Math.max(C[k + 2] / pc[2], 0.02)) * f;
        const m = (l0 + l1 + l2) / 3 / absorb;
        if (m > 1e-4) {
          C[k] = Math.min(pc[0], C[k] * Math.exp(l0)); C[k + 1] = Math.min(pc[1], C[k + 1] * Math.exp(l1)); C[k + 2] = Math.min(pc[2], C[k + 2] * Math.exp(l2));
          M[i] += m;
          Pr[i] += m * Math.exp(-l0 / (m * absorb)); Pg[i] += m * Math.exp(-l1 / (m * absorb)); Pb[i] += m * Math.exp(-l2 / (m * absorb));
        }
      }
      const m = mass[j + 3] / 255 * massScale;
      if (m > 0) {
        const r = colour[j] / 255, g = colour[j + 1] / 255, b = colour[j + 2] / 255;
        M[i] += m; Pr[i] += m * r; Pg[i] += m * g; Pb[i] += m * b;
      }
    }
  }

  // Blotting or salt: remove some suspended pigment and water.
  lift(mask, amount) {
    mask = pixels(mask);
    const { W, M, Pr, Pg, Pb } = this;
    for (let i = 0, j = 0; i < this.n; i++, j += 4) {
      const k = (mask[j + 3] / 255) * amount;
      if (!k) continue;
      const keep = 1 - k;
      M[i] *= keep; Pr[i] *= keep; Pg[i] *= keep; Pb[i] *= keep; W[i] *= 1 - k * 0.5;
    }
  }

  // Scrub dried paint from earlier layers back towards the paper.
  liftDry(mask, amount) {
    mask = pixels(mask);
    const C = this.C, pc = this.paperColour;
    for (let i = 0, j = 0; i < this.n; i++, j += 4) {
      const k = (mask[j + 3] / 255) * amount;
      if (!k) continue;
      C[i * 3] += (pc[0] - C[i * 3]) * k; C[i * 3 + 1] += (pc[1] - C[i * 3 + 1]) * k; C[i * 3 + 2] += (pc[2] - C[i * 3 + 2]) * k;
    }
  }

  step() {
    const { w, h, W, M, Pr, Pg, Pb, D, Dr, Dg, Db, fx, fy, kx, ky, fz } = this;
    const { H, chan } = this.paper;
    const p = this.p;
    const flow = p.flow, slope = p.slope * 0.05, front = p.wetFront, runAt = p.runAt, grav = this.gravity;
    const [wx, wy] = this.wind;

    // 1. water flux across each cell edge
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x, wi = W[i];
        fx[i] = 0; fy[i] = 0;
        if (x < w - 1) {
          const j = i + 1, wj = W[j];
          let f = 0;
          if (wi > EPS || wj > EPS) {
            f = flow * (kx[i] + kx[j]) * 0.5 * ((wi + slope * H[i]) - (wj + slope * H[j]));
            // dry paper only takes water from a very wet neighbour, and the fibres decide where
            // dry paper takes water unevenly, following the fibres: feathered edges
            if (wj <= EPS && f > 0) f = wi > front * Math.max(0.6, 2 - kx[j]) * fz[j] ? f * 0.3 * kx[j] : 0;
            else if (wi <= EPS && f < 0) f = wj > front * Math.max(0.6, 2 - kx[i]) * fz[i] ? f * 0.3 * kx[i] : 0;
            if (wi > EPS && wj > EPS) f += wx * Math.min(wi, wj);
            if (f > wi * 0.24) f = wi * 0.24; else if (f < -wj * 0.24) f = -wj * 0.24;
          }
          fx[i] = f;
        }
        if (y < h - 1) {
          const j = i + w, wj = W[j];
          let f = 0;
          if (wi > EPS || wj > EPS) {
            f = flow * (ky[i] + ky[j]) * 0.5 * ((wi + slope * H[i]) - (wj + slope * H[j]));
            // Downhill into dry paper, water collects as a bead along the edge and only leaks
            // out through a few channels; uphill it creeps like any other edge.
            if (wj <= EPS && f > 0) f = chan[j] && wi > runAt * 0.25 ? f : wi > front * Math.max(0.6, 2 - ky[j]) * fz[j] ? f * 0.3 * ky[j] : 0;
            else if (wi <= EPS && f < 0) f = wj > front * Math.max(0.6, 2 - ky[i]) * fz[i] ? f * 0.3 * ky[i] : 0;
            // gravity: pooled water runs down. Into dry paper it only breaks through at the
            // most absorbent channels, so the runs stay narrow, like drips.
            // inside a drip channel even a thin trickle keeps running
            const gth = chan[i] ? runAt * 0.15 : runAt * 0.5;
            if (wi > gth && (wj > EPS || (wi > runAt * 0.25 && chan[j]))) f += grav * (wi - gth) * 4;
            if (wi > EPS && wj > EPS) f += wy * Math.min(wi, wj);
            if (f > wi * 0.24) f = wi * 0.24; else if (f < -wj * 0.24) f = -wj * 0.24;
          }
          fy[i] = f;
        }
      }
    }

    // 2. move water and the pigment it carries (water soaking into dry paper runs ahead of the pigment)
    const mob = p.mobility;
    for (let i = 0; i < this.n; i++) {
      for (let e = 0; e < 2; e++) {
        const f = e === 0 ? fx[i] : fy[i];
        if (f === 0) continue;
        const j = e === 0 ? i + 1 : i + w;
        const src = f > 0 ? i : j, dst = f > 0 ? j : i, af = f > 0 ? f : -f;
        const ws = W[src];
        if (ws <= 0) continue;
        let frac = af / ws; if (frac > 1) frac = 1;
        frac *= W[dst] <= EPS ? mob * 0.35 : mob;
        W[src] = ws - af; W[dst] += af;
        const ms = M[src];
        if (ms > 0) {
          const m = ms * frac, r = Pr[src] * frac, g = Pg[src] * frac, b = Pb[src] * frac;
          M[src] = ms - m; Pr[src] -= r; Pg[src] -= g; Pb[src] -= b;
          M[dst] += m; Pr[dst] += r; Pg[dst] += g; Pb[dst] += b;
        }
      }
    }

    // 3. evaporation (faster at the wet edge) and pigment settling
    const evap = p.evap, edgeEvap = p.edgeEvap, dep = p.deposit, gran = p.granulate, pin = p.pin ?? 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (W[i] <= 0) { if (M[i] > 0) this._settle(i, 1); continue; }
        let dry = 0;
        if (x === 0 || W[i - 1] <= EPS) dry++;
        if (x === w - 1 || W[i + 1] <= EPS) dry++;
        if (y === 0 || W[i - w] <= EPS) dry++;
        if (y === h - 1 || W[i + w] <= EPS) dry++;
        W[i] -= evap * (1 + edgeEvap * dry * 0.25);
        // The edge of a wet patch stays pinned while there's water behind it, so
        // water keeps flowing out to the edge and leaves its pigment there.
        if (dry > 0 && W[i] < pin) {
          let supply = 0;
          if (x > 0 && W[i - 1] > supply) supply = W[i - 1];
          if (x < w - 1 && W[i + 1] > supply) supply = W[i + 1];
          if (y > 0 && W[i - w] > supply) supply = W[i - w];
          if (y < h - 1 && W[i + w] > supply) supply = W[i + w];
          if (supply > pin * 1.6) W[i] = pin;
        }
        if (W[i] <= EPS) { W[i] = 0; this._settle(i, 1); continue; }
        if (M[i] > 0) this._settle(i, dep + gran * (1 - H[i]));
      }
    }
  }

  _settle(i, frac) {
    const { M, Pr, Pg, Pb, D, Dr, Dg, Db } = this;
    if (frac > 1) frac = 1;
    const m = M[i] * frac;
    if (m <= 0) return;
    const r = Pr[i] * frac, g = Pg[i] * frac, b = Pb[i] * frac;
    M[i] -= m; Pr[i] -= r; Pg[i] -= g; Pb[i] -= b;
    D[i] += m; Dr[i] += r; Dg[i] += g; Db[i] += b;
  }

  run(steps) { for (let s = 0; s < steps; s++) this.step(); }

  liftDryMask(mask, amount) { this.liftDry(mask, amount); }

  dryBrushMask(mask, colour, amount) {
    const m = pixels(mask), { C } = this, { H } = this.paper;
    const c = colour.map((v) => v / 255), absorb = this.p.absorb;
    for (let i = 0; i < this.n; i++) {
      const load = m[i * 4 + 3] / 255;
      if (!load) continue;
      const k = Math.max(0, H[i] - (1 - load) * 0.9 - 0.25) * amount;
      if (k <= 0) continue;
      for (let ch = 0; ch < 3; ch++) C[i * 3 + ch] *= Math.exp(-k * absorb * -Math.log(Math.max(c[ch], 0.03)));
    }
  }

  dabMask(mask, opacity) {
    const m = pixels(mask), { C } = this, { H } = this.paper;
    for (let i = 0; i < this.n; i++) {
      const a = (m[i * 4 + 3] / 255) * opacity * (0.6 + H[i] * 0.6);
      if (!a) continue;
      for (let ch = 0; ch < 3; ch++) C[i * 3 + ch] += (m[i * 4 + ch] / 255 - C[i * 3 + ch]) * a;
    }
  }

  drawTo(ctx, W, H) {
    const c = document.createElement('canvas');
    c.width = this.w; c.height = this.h;
    const g = c.getContext('2d');
    g.putImageData(this.toImageData(g), 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(c, 0, 0, W, H);
  }

  dispose() {}

  wetCount() { let c = 0; for (const v of this.W) if (v > EPS) c++; return c; }

  // Dry everything and glaze this layer onto the canvas.
  finishLayer() {
    for (let guard = 0; guard < 280 && this.wetCount() > this.n * 0.003; guard++) this.step();
    const { C, D, Dr, Dg, Db, W, M, Pr, Pg, Pb } = this;
    const absorb = this.p.absorb, hide = this.p.hide;
    for (let i = 0; i < this.n; i++) {
      if (M[i] > 0) this._settle(i, 1);
      const raw = D[i];
      const m = raw / (1 + raw * 0.8);
      if (raw > 1e-5) {
        const r = Dr[i] / raw, g = Dg[i] / raw, b = Db[i] / raw;
        const k = 3 * i;
        // transparent glaze: Beer–Lambert, each channel absorbs by how dark the pigment is
        C[k] *= Math.exp(-m * absorb * -Math.log(Math.max(r, 0.03)));
        C[k + 1] *= Math.exp(-m * absorb * -Math.log(Math.max(g, 0.03)));
        C[k + 2] *= Math.exp(-m * absorb * -Math.log(Math.max(b, 0.03)));
        if (hide > 0) {
          const a = 1 - Math.exp(-m * hide);
          C[k] += (r - C[k]) * a; C[k + 1] += (g - C[k + 1]) * a; C[k + 2] += (b - C[k + 2]) * a;
        }
      }
      W[i] = 0; M[i] = 0; Pr[i] = Pg[i] = Pb[i] = 0; D[i] = 0; Dr[i] = Dg[i] = Db[i] = 0;
    }
  }

  // Opaque specks (white gouache stars, etc.)
  dab(x, y, r, colour, opacity) {
    const { w, h, C } = this;
    const c = colour.map((v) => v / 255);
    for (let yy = Math.max(0, Math.floor(y - r)); yy <= Math.min(h - 1, Math.ceil(y + r)); yy++) {
      for (let xx = Math.max(0, Math.floor(x - r)); xx <= Math.min(w - 1, Math.ceil(x + r)); xx++) {
        const d = Math.hypot(xx - x, yy - y) / r;
        if (d > 1) continue;
        const a = opacity * (1 - d * d) * (0.6 + this.paper.H[yy * w + xx] * 0.6);
        const k = 3 * (yy * w + xx);
        C[k] += (c[0] - C[k]) * a; C[k + 1] += (c[1] - C[k + 1]) * a; C[k + 2] += (c[2] - C[k + 2]) * a;
      }
    }
  }

  // Dry brush: pigment only catches on the tops of the paper's texture.
  dryBrush(path, width, colour, amount) {
    const { w, h, C } = this;
    const { H } = this.paper;
    const c = colour.map((v) => v / 255);
    const absorb = this.p.absorb;
    for (let s = 0; s < path.length; s++) {
      const [x, y, load] = path[s];
      for (let o = -width; o <= width; o += 0.7) {
        const xx = Math.round(x + o * path.nx), yy = Math.round(y + o * path.ny);
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const i = yy * w + xx;
        const catchAmt = Math.max(0, H[i] - (1 - load) * 0.9 - 0.25) * amount;
        if (catchAmt <= 0) continue;
        const k = 3 * i;
        for (let ch = 0; ch < 3; ch++) C[k + ch] *= Math.exp(-catchAmt * absorb * -Math.log(Math.max(c[ch], 0.03)));
      }
    }
  }

  // Patch simulation snapshot: signed density relative to `base` mass, used for animated blooms.
  densityTotal(i) { return this.M[i] + this.D[i]; }

  toImageData(ctx) {
    const img = ctx.createImageData(this.w, this.h);
    const d = img.data, C = this.C;
    for (let i = 0, j = 0; i < this.n; i++, j += 4) {
      d[j] = Math.max(0, Math.min(255, C[i * 3] * 255));
      d[j + 1] = Math.max(0, Math.min(255, C[i * 3 + 1] * 255));
      d[j + 2] = Math.max(0, Math.min(255, C[i * 3 + 2] * 255));
      d[j + 3] = 255;
    }
    return img;
  }
}

// ------------------------------------------------------------ oil

export class OilSim {
  constructor(paper, paperColour) {
    const { w, h } = paper;
    this.w = w; this.h = h; this.n = w * h; this.paper = paper;
    const N = this.n;
    this.C = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) { this.C[i * 3] = paperColour[0] / 255; this.C[i * 3 + 1] = paperColour[1] / 255; this.C[i * 3 + 2] = paperColour[2] / 255; }
    this.Z = new Float32Array(N);              // paint thickness (impasto)
    this.wetA = new Float32Array(N);           // wet paint amount this layer
    this.wet = new Float32Array(N * 3);        // wet paint colour this layer
  }

  // One brush stroke along `path` [[x,y], ...]. Bristles carry paint, pick up
  // wet paint already on the canvas, and run dry towards the end.
  stroke(path, width, colour, load, R) {
    const { w, h, wetA, wet, Z } = this;
    const { H } = this.paper;
    const n = Math.max(4, Math.round(width * 3));
    const bristles = [];
    for (let b = 0; b < n; b++) {
      bristles.push({ off: (b / (n - 1) - 0.5) * 2 * width + (R() - 0.5) * 0.6, c: colour.map((v) => v / 255 * (0.94 + R() * 0.12)), paint: load * (3 + R() * 3) });
    }
    for (let s = 1; s < path.length; s++) {
      const [x0, y0] = path[s - 1], [x1, y1] = path[s];
      const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len;
      const sub = Math.ceil(len);
      for (let t = 0; t < sub; t++) {
        const px = x0 + (dx * t) / sub, py = y0 + (dy * t) / sub;
        for (const b of bristles) {
          if (b.paint <= 0.002) continue;
          const xx = Math.round(px + nx * b.off), yy = Math.round(py + ny * b.off);
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const i = yy * w + xx, k = 3 * i;
          // a nearly empty brush only touches the high points of the weave
          const touch = b.paint > 0.4 ? 1 : Math.max(0, H[i] - 0.5 + b.paint * 1.4);
          if (touch <= 0) continue;
          // pick up paint already here. Oil stays workable for days, so earlier hours smear too.
          if (wetA[i] > 0) {
            const pick = Math.min(0.35, wetA[i]) * 0.5;
            b.c[0] += (wet[k] - b.c[0]) * pick; b.c[1] += (wet[k + 1] - b.c[1]) * pick; b.c[2] += (wet[k + 2] - b.c[2]) * pick;
          } else if (this.Z[i] > 0.05) {
            const pick = 0.12;
            b.c[0] += (this.C[k] - b.c[0]) * pick; b.c[1] += (this.C[k + 1] - b.c[1]) * pick; b.c[2] += (this.C[k + 2] - b.c[2]) * pick;
          }
          const put = Math.min(b.paint, 0.09) * touch;
          const total = wetA[i] + put;
          wet[k] = (wet[k] * wetA[i] + b.c[0] * put) / total;
          wet[k + 1] = (wet[k + 1] * wetA[i] + b.c[1] * put) / total;
          wet[k + 2] = (wet[k + 2] * wetA[i] + b.c[2] * put) / total;
          wetA[i] = total;
          Z[i] += put * 1.4;
          b.paint -= put * 0.22;
        }
      }
    }
  }

  finishLayer() {
    const { C, wet, wetA } = this;
    for (let i = 0; i < this.n; i++) {
      if (wetA[i] <= 0) continue;
      const a = 1 - Math.exp(-wetA[i] * 9);
      const k = 3 * i;
      C[k] += (wet[k] - C[k]) * a; C[k + 1] += (wet[k + 1] - C[k + 1]) * a; C[k + 2] += (wet[k + 2] - C[k + 2]) * a;
      wetA[i] = 0;
    }
  }

  dab(x, y, r, colour, opacity) {
    const c = colour.map((v) => v / 255);
    const { w, h, C, Z } = this;
    for (let yy = Math.max(0, Math.floor(y - r)); yy <= Math.min(h - 1, Math.ceil(y + r)); yy++) {
      for (let xx = Math.max(0, Math.floor(x - r)); xx <= Math.min(w - 1, Math.ceil(x + r)); xx++) {
        const d = Math.hypot(xx - x, yy - y) / r;
        if (d > 1) continue;
        const a = opacity * (1 - d * d);
        const k = 3 * (yy * w + xx);
        C[k] += (c[0] - C[k]) * a; C[k + 1] += (c[1] - C[k + 1]) * a; C[k + 2] += (c[2] - C[k + 2]) * a;
        Z[yy * w + xx] += a * 0.6;
      }
    }
  }

  liftDry() {}
  liftDryMask() {}
  dabMask(mask, opacity) {
    const m = pixels(mask), { C, Z } = this;
    for (let i = 0; i < this.n; i++) {
      const a = (m[i * 4 + 3] / 255) * opacity;
      if (!a) continue;
      for (let ch = 0; ch < 3; ch++) C[i * 3 + ch] += (m[i * 4 + ch] / 255 - C[i * 3 + ch]) * a;
      Z[i] += a * 0.5;
    }
  }
  drawTo(ctx, W, H) {
    const c = document.createElement('canvas');
    c.width = this.w; c.height = this.h;
    const g = c.getContext('2d');
    g.putImageData(this.toImageData(g), 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(c, 0, 0, W, H);
  }
  dispose() {}

  // Light the impasto from the top left.
  toImageData(ctx) {
    const { w, h, C } = this;
    // soften the height map a little so ridges read as paint, not noise
    const Z = new Float32Array(this.n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let sum = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        sum += this.Z[yy * w + xx]; c++;
      }
      Z[y * w + x] = sum / c;
    }
    const img = ctx.createImageData(w, h);
    const d = img.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x, j = i * 4;
        const zx = (Z[Math.min(i + 1, i - x + w - 1)] - Z[Math.max(i - 1, y * w)]);
        const zy = (Z[Math.min(i + w, this.n - 1)] - Z[Math.max(i - w, 0)]);
        const shade = 1 - (zx + zy) * 0.18;
        const spec = Math.max(0, -(zx + zy) * 0.6) ** 2 * 0.15;
        for (let c = 0; c < 3; c++) d[j + c] = Math.max(0, Math.min(255, (C[i * 3 + c] * shade + spec) * 255));
        d[j + 3] = 255;
      }
    }
    return img;
  }
}
