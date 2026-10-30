// Abstract mode. Each hour of weather is one wet layer of paint over the whole canvas,
// simulated with water and pigment (see paint-sim.js), oldest hour first.
// Weather decides the colours; the artist seed decides placement, shapes,
// orientation, paper grain and how the paint flows.
// Animation is periodic in p (0..1) so exported loops are seamless.

import { rng, hash } from './sky.js';
import { makePaper, WetSim, OilSim, MEDIA } from './paint-sim.js';
import { GpuWetSim, gpuAvailable } from './gpu-sim.js';

const TAU = Math.PI * 2;
const HOUR = 3600000, DAY = 86400000;
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const mix = (c1, c2, t) => c1.map((v, i) => v + (c2[i] - v) * t);
const rgba = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${clamp(a)})`;
const lum = (c) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export const DEFAULTS = {
  range: 'r24',            // 'r24' (rolling last 24 hours), or days: 1 (today), 3, 7, 30
  medium: 'watercolour',   // watercolour | ink | gouache | oil
  palette: 'temperature',  // temperature | pastel | moody | sunset
  size: 1,                 // splotch size
  layers: { colour: 1, rain: 1, sun: 1, cloud: 1, wind: 1 },
};

const PAPER = { watercolour: [247, 242, 231], ink: [246, 240, 226], gouache: [240, 234, 222], oil: [228, 222, 208] };
const RAIN_INK = [52, 82, 132];
const NIGHT_INK = [72, 76, 140];
const GOLD = [236, 170, 52];

// Temperature (°C) to colour.
const PALETTES = {
  temperature: [[-5, [150, 170, 220]], [5, [118, 156, 212]], [12, [104, 170, 194]], [18, [136, 182, 148]], [24, [232, 190, 108]], [30, [234, 134, 84]], [38, [206, 74, 74]]],
  pastel: [[-5, [196, 206, 240]], [8, [180, 214, 230]], [16, [196, 228, 206]], [22, [250, 226, 186]], [28, [248, 198, 184]], [38, [238, 170, 190]]],
  moody: [[-5, [70, 90, 120]], [8, [64, 104, 116]], [16, [86, 112, 96]], [22, [150, 120, 84]], [28, [140, 76, 70]], [38, [112, 48, 64]]],
  sunset: [[-5, [92, 84, 160]], [8, [138, 96, 170]], [16, [206, 112, 150]], [22, [240, 140, 120]], [28, [250, 176, 96]], [38, [250, 208, 92]]],
};

function tempColour(t, palette) {
  const keys = PALETTES[palette] || PALETTES.temperature;
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [t0, c0] = keys[i], [t1, c1] = keys[i + 1];
    if (t <= t1) return mix(c0, c1, (t - t0) / (t1 - t0));
  }
  return keys[keys.length - 1][1];
}

function toHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function fromHsl([h, s, l]) {
  h = ((h % 360) + 360) % 360 / 360;
  const f = (n) => { const k = (n + h * 12) % 12; return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

const isSnow = (h) => (h.code >= 71 && h.code <= 77) || h.code === 85 || h.code === 86;
const isRain = (h) => h.precip > 0.05 && !isSnow(h);
const isStorm = (h) => h.code >= 95;

// ------------------------------------------------------------ data

// series = { points: [{t, temp, precip, cloud, wind, windDir, code, isDay}], start, end, now }
// Times are local wall-clock ms. Long ranges are merged into at most maxLayers layers.
export function toLayers(series, maxLayers = 48) {
  const first = Math.floor(series.start / HOUR) * HOUR;   // whole hours, so a rolling window doesn't reshuffle layers
  const hours = Math.max(1, Math.ceil((series.now - first) / HOUR));
  const per = Math.max(1, Math.ceil(hours / maxLayers));
  const out = [];
  for (let t0 = first; t0 <= series.now; t0 += per * HOUR) {
    const pts = series.points.filter((p) => p.t >= t0 && p.t < t0 + per * HOUR && p.t <= series.now);
    if (!pts.length) continue;
    const avg = (k) => pts.reduce((s, p) => s + p[k], 0) / pts.length;
    out.push({
      t0, per,
      temp: avg('temp'), cloud: avg('cloud'), precip: avg('precip'),
      wind: Math.max(...pts.map((p) => p.wind)), windDir: avg('windDir'),
      code: Math.max(...pts.map((p) => p.code)),
      isDay: pts.filter((p) => p.isDay).length >= pts.length / 2,
    });
  }
  return out;
}

function bucket(hs) {
  if (!hs.length) return null;
  const rain = hs.reduce((s, h) => s + (isRain(h) ? h.precip : 0), 0);
  if (hs.some(isStorm)) return 'storms';
  if (hs.some(isSnow)) return 'snow';
  if (rain >= 0.3) return rain > 15 ? 'heavy rain' : 'rain';
  const cloud = hs.reduce((s, h) => s + h.cloud, 0) / hs.length;
  return cloud < 30 ? 'clear' : cloud > 75 ? 'grey' : 'patchy cloud';
}

export function summarise(series) {
  const upto = series.points.filter((p) => p.t <= series.now);
  const temps = upto.map((h) => h.temp);
  const range = temps.length ? `${Math.round(Math.min(...temps))}°–${Math.round(Math.max(...temps))}°` : '';
  const days = Math.round((series.end - series.start) / DAY);

  if (days > 1) {
    const perDay = [];
    for (let t = series.start; t < series.end; t += DAY) perDay.push(upto.filter((p) => p.t >= t && p.t < t + DAY));
    const rainy = perDay.filter((d) => d.reduce((s, p) => s + p.precip, 0) >= 1).length;
    const stormy = perDay.filter((d) => d.some(isStorm)).length;
    const mm = upto.reduce((s, p) => s + p.precip, 0);
    const bits = [`${rainy} rainy day${rainy === 1 ? '' : 's'}`];
    if (stormy) bits.push(`${stormy} with storms`);
    bits.push(`${Math.round(mm)} mm of rain`);
    return { text: `Last ${days} days: ${bits.join(', ')}`, range };
  }

  // Walk forward in time, grouping hours into parts of the day.
  const partOf = (t) => { const h = (((t % DAY) + DAY) % DAY) / HOUR; return h < 5 ? 'overnight' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening'; };
  const segs = [];
  for (const pt of upto.filter((p) => p.t >= series.start)) {
    const name = partOf(pt.t), day = Math.floor(pt.t / DAY);
    const last = segs[segs.length - 1];
    if (last && last.name === name && (last.day === day || name === 'overnight')) last.pts.push(pt);
    else segs.push({ name, day, pts: [pt] });
  }
  const merged = [];
  for (const sg of segs) {
    const v = bucket(sg.pts);
    const last = merged[merged.length - 1];
    if (last && last.v === v) last.names.push(sg.name);
    else merged.push({ v, names: [sg.name] });
  }
  const when = (names) => (names.length > 2 ? 'throughout' : names.map((n) => (n === 'overnight' ? 'overnight' : `in the ${n}`)).join(' and ').replace(' and in the ', ' and '));
  const NOUN = { clear: 'clear skies', grey: 'grey skies', 'patchy cloud': 'patchy cloud', rain: 'rain', 'heavy rain': 'heavy rain', storms: 'storms', snow: 'snow' };
  const text = (series.rolling ? 'Last 24 hours: ' : 'Today: ') + merged.map(({ v, names }) => `${NOUN[v]} ${when(names)}`).join(', then ');
  return { text, range };
}

// ------------------------------------------------------------ demo data (used offline and with ?demo=)

const DEMO_DAYS = {
  rain: { lo: 17, hi: 26, rain: { 5: 0.4, 6: 1.2, 7: 2.6, 8: 3.2, 9: 1.6, 10: 0.5 }, cloud: (h) => (h < 5 ? 55 : h <= 10 ? 96 : h === 11 ? 70 : h === 12 ? 45 : 18), wind: (h) => (h >= 6 && h <= 9 ? 24 : 9) },
  storm: { lo: 21, hi: 33, rain: { 16: 1.5, 17: 8, 18: 12, 19: 4, 20: 0.8 }, storm: [17, 18, 19], cloud: (h) => (h < 13 ? 15 : h < 16 ? 60 : 100), wind: (h) => (h >= 16 && h <= 19 ? 45 : 10) },
  noon: { lo: 15, hi: 29, rain: {}, cloud: (h) => (h < 7 ? 5 : 10 + (h % 5) * 4), wind: () => 12 },
  grey: { lo: 16, hi: 21, rain: { 13: 0.2 }, cloud: () => 88, wind: () => 18 },
  snow: { lo: -4, hi: 1, snow: [3, 4, 5, 6, 7, 8, 9, 10, 11], rain: { 3: 0.5, 4: 1, 5: 1.4, 6: 1.6, 7: 1.2, 8: 1, 9: 0.6, 10: 0.4, 11: 0.2 }, cloud: (h) => (h < 12 ? 95 : 50), wind: () => 14 },
  night: { lo: 12, hi: 22, rain: { 1: 0.3, 2: 0.6 }, cloud: (h) => (h < 4 ? 80 : 12), wind: () => 6 },
  downpour: { lo: 19, hi: 23, rain: Object.fromEntries([...Array(16).keys()].map((h) => [h, 3 + (h % 4) * 2])), cloud: () => 100, wind: () => 28 },
};
const DEMO_NOW = { rain: 15.4, storm: 20.2, noon: 17, snow: 14, night: 23.6, grey: 12, downpour: 15.5 };

export function demoSeries(name = 'rain', range = 1) {
  if (range === 'r24') {
    const s = demoSeries(name, 2);
    return { ...s, start: s.now - DAY, end: s.now, rolling: true };
  }
  const days = range;
  const today = Date.UTC(2026, 9, 30);
  const start = today - (days - 1) * DAY;
  const cycle = ['noon', 'grey', 'rain', 'noon', 'storm', 'noon', 'night'];
  const points = [];
  for (let d = 0; d < days; d++) {
    const key = d === days - 1 ? (DEMO_DAYS[name] ? name : 'rain') : cycle[(d * 3 + 1) % cycle.length];
    const P = DEMO_DAYS[key];
    const shift = ((d * 7) % 5) - 2;
    for (let h = 0; h < 24; h++) {
      const warmth = (1 - Math.cos((((h - 5 + 24) % 24) / 24) * TAU)) / 2; // coolest ~5am
      const precip = P.rain[h] || 0;
      const cloud = P.cloud(h);
      const code = P.storm?.includes(h) ? 95 : P.snow?.includes(h) ? 73 : precip > 4 ? 65 : precip > 2 ? 63 : precip > 0 ? 61 : cloud > 85 ? 3 : cloud > 40 ? 2 : 0;
      points.push({ t: start + d * DAY + h * HOUR, temp: P.lo + shift + (P.hi - P.lo) * warmth, precip, cloud, wind: P.wind(h), windDir: 200, code, isDay: h >= 6 && h < 18 });
    }
  }
  return { points, start, end: today + DAY, now: today + (DEMO_NOW[name] ?? 15.4) * HOUR };
}

// ------------------------------------------------------------ marks

// Irregular brush shape: an ellipse with layered noise on its outline.
function shapePath(R, x, y, rx, ry, rot, rough = 1) {
  const path = new Path2D();
  const k = 64;
  const ph = [R() * TAU, R() * TAU, R() * TAU, R() * TAU];
  const cs = Math.cos(rot), sn = Math.sin(rot);
  for (let j = 0; j <= k; j++) {
    const t = (j / k) * TAU;
    const r = 1 + rough * (0.16 * Math.sin(2 * t + ph[0]) + 0.1 * Math.sin(3 * t + ph[1]) + 0.06 * Math.sin(7 * t + ph[2]) + 0.035 * Math.sin(13 * t + ph[3]) + (R() - 0.5) * 0.05);
    const px = Math.cos(t) * rx * r, py = Math.sin(t) * ry * r;
    const X = x + px * cs - py * sn, Y = y + px * sn + py * cs;
    j ? path.lineTo(X, Y) : path.moveTo(X, Y);
  }
  path.closePath();
  return path;
}

// Rasterises water, pigment mass and colour for one stage of a layer.
class Marks {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.water = canvas(w, h); this.mass = canvas(w, h); this.colour = canvas(w, h);
    this.wg = this.water.getContext('2d', { willReadFrequently: true });
    this.mg = this.mass.getContext('2d', { willReadFrequently: true });
    this.cg = this.colour.getContext('2d', { willReadFrequently: true });
    this.wg.globalCompositeOperation = 'lighter';
    this.mg.globalCompositeOperation = 'lighter';
    this.any = false;
  }
  // water and mass are in sim units (water up to 2, mass up to 1.5)
  paint(path, water, mass, col) {
    this.any = true;
    if (water > 0) { this.wg.fillStyle = `rgba(255,255,255,${clamp(water / 2)})`; this.wg.fill(path); }
    if (mass > 0) {
      this.mg.fillStyle = `rgba(255,255,255,${clamp(mass / 1.5)})`; this.mg.fill(path);
      this.cg.fillStyle = rgba(col); this.cg.fill(path);
    }
  }
  apply(sim) { if (this.any) sim.addMarks(this.water, this.mass, this.colour); }
}

function maskCanvas(w, h) {
  const c = canvas(w, h);
  return { c, g: c.getContext('2d', { willReadFrequently: true }) };
}

// ------------------------------------------------------------ build

function chooseEngine(medium, force) {
  if (force) return force;
  if (medium === 'oil') return 'oil';
  return gpuAvailable() ? 'gpu' : 'cpu';
}

export function buildAbstract(W, H, series, seed, place = '', opts = {}) {
  const o = { ...DEFAULTS, ...opts, layers: { ...DEFAULTS.layers, ...(opts.layers || {}) } };
  const L = o.layers, S = o.size, medium = o.medium;
  const engine = chooseEngine(medium, o.engine);
  // simulation grid: finer on the GPU
  const simW = o.simW || (engine === 'gpu' ? 720 : engine === 'oil' ? 560 : 300);
  const sw = simW, sh = Math.max(2, Math.round((simW * H) / W));
  const su = Math.min(sw, sh);
  const paperCol = PAPER[medium] || PAPER.watercolour;
  const layers = toLayers(series);
  const n = layers.length;

  const sc = {
    W, H, u: Math.min(W, H), series, place, kind: 'abstract', medium, L, paperCol, layers,
    base: canvas(W, H), done: false, cancelled: false, progress: 0, drops: [], stars: [],
    summary: summarise(series),
  };
  const bctx = sc.base.getContext('2d');
  bctx.fillStyle = rgba(paperCol);
  bctx.fillRect(0, 0, W, H);

  const artist = rng(seed);
  const hueShift = (artist() - 0.5) * 18;       // a personal tint, small enough that rain stays blue
  const satShift = 0.9 + artist() * 0.2;

  const colourOf = (h) => {
    let c = tempColour(h.temp, o.palette);
    c = mix(c, [lum(c), lum(c), lum(c) * 1.05], (h.cloud / 100) * 0.5 * Math.min(1, L.cloud));
    if (isRain(h)) c = mix(c, RAIN_INK, clamp(0.35 + h.precip / 5, 0, 0.85) * Math.min(1, L.rain));
    if (!h.isDay) c = mix(c, NIGHT_INK, 0.4);
    let [hh, ss, ll] = toHsl(c);
    hh += hueShift; ss *= satShift;
    if (medium === 'ink') { ss = Math.min(1, ss * 1.4 + 0.1); ll = Math.min(0.8, ll * 1.05); }
    if (medium === 'gouache') ll = Math.min(0.92, ll * 1.06);
    return fromHsl([hh, clamp(ss), clamp(ll)]);
  };

  const paper = makePaper(sw, sh, seed);
  const sim = engine === 'gpu' ? new GpuWetSim(paper, medium, paperCol)
    : engine === 'oil' ? new OilSim(paper, paperCol)
      : new WetSim(paper, medium, paperCol);
  const P = MEDIA[medium] || MEDIA.watercolour;
  const density = clamp(24 / Math.max(n, 1), 0.35, 1.3);
  // Thin each glaze as layers stack up, like a painter would, so many hours don't turn to mud.
  const strength = clamp(6 / Math.max(n, 1), 0.22, 1);
  const toOut = (x, y) => [(x / sw) * W, (y / sh) * H];

  sc.ready = (async () => {
    try {
      // Ground wash: tone the whole sheet in the day's colours so no bare paper shows.
      const gR = rng(hash(`${seed}|ground|${series.rolling ? 'r24' : series.start}`));
      const cols = layers.length ? layers.map(colourOf) : [colourOf({ temp: 20, cloud: 50, precip: 0, isDay: true, code: 2 })];
      const avg = cols.reduce((a, c) => a.map((v, i) => v + c[i] / cols.length), [0, 0, 0]);
      if (engine === 'oil') {
        for (let k = 0; k < 18; k++) {
          const y = (k / 17) * sh, ang = (gR() - 0.5) * 0.3;
          const pts = [];
          for (let s2 = 0; s2 <= 30; s2++) pts.push([-10 + (s2 / 30) * (sw + 20), y + Math.sin(ang) * (s2 / 30) * sw * 0.2 + (gR() - 0.5) * 3]);
          sim.stroke(pts, sh / 11, mix(cols[Math.floor(gR() * cols.length)], avg, 0.6), 2, gR);
        }
        sim.finishLayer();
      } else {
        const G = new Marks(sw, sh);
        const all = new Path2D(); all.rect(0, 0, sw, sh);
        G.paint(all, 1.1, 0.34 * L.colour, mix(avg, paperCol, 0.1));
        for (let k = 0; k < 10; k++) {
          const r = su * (0.25 + gR() * 0.35);
          G.paint(shapePath(gR, gR() * sw, gR() * sh, r, r * (0.5 + gR() * 0.5), gR() * TAU), 0.2, (0.12 + gR() * 0.18) * L.colour, cols[Math.floor(gR() * cols.length)]);
        }
        G.apply(sim);
        sim.finishLayer(Math.round(1.6 / P.evap) + 20);
      }
      for (let li = 0; li < n; li++) {
        if (sc.cancelled) return;
        const h = layers[li];
        const R = rng(hash(`${seed}|${h.t0}`));   // per-layer seed: earlier layers stay put
        const fresh = strength * (0.85 + 0.9 * ((li + 1) / n) ** 3);
        const col = colourOf(h);
        const recent = li >= n - 3;
        if (engine === 'oil') paintOilLayer(sim, R, h, col, { sw, sh, su, S, L, density, fresh, recent, sc, toOut });
        else paintWetLayer(sim, R, h, col, { sw, sh, su, S, L, P, density, fresh, recent, sc, toOut, medium, colourOf });
        if (li % 2 === 1 || li === n - 1) sim.drawTo(bctx, W, H);
        sc.progress = (li + 1) / n;
        await new Promise((r) => setTimeout(r, 0));
      }
      sim.drawTo(bctx, W, H);
      sc.drops = sc.drops.slice(-6).map((d) => ({ ...d, frames: engine === 'oil' ? null : bloomFrames(d, medium, paperCol, seed) }));
      sc.done = true;
    } finally {
      sim.dispose();
    }
  })();

  sc.paperTile = paperTile(rng(seed), medium);
  return sc;
}

function paintWetLayer(sim, R, h, col, ctx) {
  const { sw, sh, su, S, L, P, density, fresh, recent, sc, toOut, medium } = ctx;
  const rain = isRain(h), snow = isSnow(h);

  // gravity grows with how wet the hour was; wind drags wet paint downwind
  sim.gravity = P.gravity * (1 + Math.min(h.precip, 6) * 0.4);
  const to = ((h.windDir + 180) * Math.PI) / 180;
  const windAmt = Math.min(h.wind, 60) / 60 * 0.02 * L.wind;
  sim.wind = [Math.sin(to) * windAmt, -Math.cos(to) * windAmt];

  // Stage A: washes, cloud and sun, laid in wet
  const A = new Marks(sw, sh);
  const washes = [];
  if (L.colour > 0) {
    const count = Math.max(1, Math.round((1.5 + R() * 2) * density));
    for (let k = 0; k < count; k++) {
      const r = su * (0.1 + R() * 0.26) * S;
      const x = R() * sw, y = R() * sh, rot = R() * TAU, sq = 0.45 + R() * 0.55;
      const water = 0.9 + R() * 0.45;
      const mass = (0.7 + R() * 0.6) * L.colour * fresh;
      A.paint(shapePath(R, x, y, r, r * sq, rot), water, mass * 0.55, col);
      // uneven brush load inside the wash
      for (let j = 0; j < 3; j++) {
        const rr = r * (0.25 + R() * 0.35);
        A.paint(shapePath(R, x + (R() - 0.5) * r, y + (R() - 0.5) * r * sq, rr, rr * (0.5 + R() * 0.5), R() * TAU), 0, mass * (0.2 + R() * 0.4), col);
      }
      washes.push({ x, y, r, sq, rot });
    }
  }
  if (L.cloud > 0 && h.cloud > 30) {
    const count = Math.round((h.cloud / 40) * density);
    const c = h.isDay ? [206, 208, 218] : [138, 140, 170];
    for (let k = 0; k < count; k++) {
      const r = su * (0.1 + R() * 0.16) * S;
      A.paint(shapePath(R, R() * sw, R() * sh, r * 1.6, r * 0.45, (R() - 0.5) * 0.5), 0.8, (0.12 + (h.cloud / 100) * 0.12) * L.cloud * Math.max(0.3, fresh), c);
    }
  }
  if (L.sun > 0 && h.isDay && !rain && h.cloud < 75) {
    const strength = 1 - h.cloud / 100;
    const x = R() * sw, y = R() * sh, r = su * (0.05 + strength * 0.08) * S;
    // lift earlier layers back towards the paper where the sun sits, then glaze gold into it
    const m = maskCanvas(sw, sh);
    const g = m.g.createRadialGradient(x, y, 0, x, y, r * 1.6);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.35, 'rgba(255,255,255,0.6)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    m.g.fillStyle = g; m.g.fill(shapePath(R, x, y, r * 1.6, r * 1.6, 0, 0.6));
    sim.liftDryMask(m.c, 0.32 * strength * Math.min(1, L.sun));
    A.paint(shapePath(R, x, y, r, r * (0.85 + R() * 0.3), R() * TAU, 0.7), 1.0, 0.42 * strength * L.sun * Math.max(0.35, fresh), GOLD);
    if (recent) sc.lastSun = { pos: toOut(x, y), r: (r / sw) * sc.W };
  }
  A.apply(sim);
  sim.run(14 + Math.round(R() * 10));

  // Stage B: rain falls into the damp wash and pushes pigment into blooms; salt for snow
  const B = new Marks(sw, sh);
  const near = () => {
    const wsh = washes.length ? washes[Math.floor(R() * washes.length)] : { x: R() * sw, y: R() * sh, r: su * 0.2, sq: 1 };
    return [wsh.x + (R() - 0.5) * wsh.r * 1.4, wsh.y + (R() - 0.5) * wsh.r * wsh.sq * 1.4];
  };
  if (rain && L.rain > 0) {
    const count = Math.round((2 + Math.min(h.precip, 10) * 2.2) * density * L.rain);
    for (let k = 0; k < count; k++) {
      const [x, y] = near();
      const r = su * (0.012 + R() * 0.035) * S * (0.8 + Math.min(h.precip, 6) / 8);
      B.paint(shapePath(R, x, y, r, r * (0.8 + R() * 0.4), R() * TAU, 0.9), 1.6 + R() * 0.6, 0.02, RAIN_INK);
      if (recent && R() < 0.5) sc.drops.push({ pos: toOut(x, y), cell: sc.W / sw, col, rainCol: mix(RAIN_INK, col, 0.4), seed: Math.floor(R() * 1e9) });
    }
  }
  if (snow && L.rain > 0) {
    for (let k = 0; k < Math.round(40 * density); k++) {
      const [x, y] = near();
      const r = su * (0.004 + R() * 0.008) * S;
      B.paint(shapePath(R, x, y, r, r, 0, 1.2), 1.2, 0, col);
    }
  }
  B.apply(sim);
  sim.finishLayer(Math.round((1.5 + (rain ? 2.1 : 0)) / P.evap) + 30);

  // Dry brush catches the paper's texture in the wind's direction
  if (L.wind > 0 && h.wind > 18) {
    const m = maskCanvas(sw, sh);
    const count = Math.round(((h.wind - 12) / 10) * density);
    const dx = Math.sin(to), dy = -Math.cos(to);
    m.g.lineCap = 'round';
    for (let k = 0; k < count; k++) {
      const x = R() * sw, y = R() * sh, len = su * (0.2 + R() * 0.35) * S, wdt = su * (0.015 + R() * 0.03) * S;
      for (let s = 0; s < 14; s++) {
        const t0 = s / 14, t1 = (s + 1) / 14;
        m.g.strokeStyle = `rgba(0,0,0,${0.9 - t0 * 0.75})`;   // brush runs dry along the stroke
        m.g.lineWidth = wdt;
        m.g.beginPath();
        m.g.moveTo(x + dx * len * t0, y + dy * len * t0 + Math.sin(t0 * 3) * wdt);
        m.g.lineTo(x + dx * len * t1, y + dy * len * t1 + Math.sin(t1 * 3) * wdt);
        m.g.stroke();
      }
    }
    sim.dryBrushMask(m.c, mix(col, [30, 34, 50], 0.12), 0.7 * L.wind);
  }

  // Lightning: scratched back to the paper
  if (isStorm(h) && L.rain > 0) {
    const m = maskCanvas(sw, sh);
    let x = sw * (0.15 + R() * 0.7), y = -2;
    m.g.strokeStyle = '#fff'; m.g.lineWidth = Math.max(1, su * 0.006); m.g.lineJoin = 'round';
    m.g.beginPath(); m.g.moveTo(x, y);
    while (y < sh * (0.55 + R() * 0.35)) { x += (R() - 0.5) * su * 0.09; y += su * (0.05 + R() * 0.07); m.g.lineTo(x, y); }
    m.g.stroke();
    sim.liftDryMask(m.c, 0.85 * Math.min(1, L.rain));
  }

  // Clear nights: specks of white gouache
  if (!h.isDay && h.cloud < 50) {
    const m = maskCanvas(sw, sh);
    m.g.fillStyle = '#fffaf0';
    for (let k = 0; k < Math.round(14 * density); k++) {
      const x = R() * sw, y = R() * sh, r = 0.5 + R() * 1.1;
      m.g.beginPath(); m.g.arc(x, y, r, 0, TAU); m.g.fill();
      if (recent) sc.stars.push({ pos: ctx.toOut(x, y), r: (r / sw) * sc.W, ph: R() });
    }
    sim.dabMask(m.c, 0.9);
  }
}

function paintOilLayer(sim, R, h, col, ctx) {
  const { sw, sh, su, S, L, density, fresh, recent, sc } = ctx;
  const rain = isRain(h), snow = isSnow(h);
  const curve = (x, y, ang, len, bend) => {
    const pts = [];
    for (let s = 0; s <= 24; s++) {
      const t = s / 24 - 0.5;
      pts.push([x + Math.cos(ang) * len * t - Math.sin(ang) * bend * (t * t * 4 - 1), y + Math.sin(ang) * len * t + Math.cos(ang) * bend * (t * t * 4 - 1)]);
    }
    return pts;
  };
  if (L.colour > 0) {
    const count = Math.max(1, Math.round((2 + R() * 2) * density));
    for (let k = 0; k < count; k++) {
      const x = R() * sw, y = R() * sh, r = su * (0.15 + R() * 0.25) * S, ang = R() * Math.PI;
      const strokes = 4 + Math.floor(R() * 4);
      for (let j = 0; j < strokes; j++) {
        const off = (j / (strokes - 1 || 1) - 0.5) * r * 1.2;
        sim.stroke(curve(x - Math.sin(ang) * off, y + Math.cos(ang) * off, ang + (R() - 0.5) * 0.25, r * (1.4 + R() * 0.6), (R() - 0.5) * r * 0.3),
          Math.max(2, r * (0.18 + R() * 0.12)), col, 1.4 * L.colour * Math.max(0.5, fresh), R);
      }
    }
  }
  if (L.cloud > 0 && h.cloud > 35) {
    const c = h.isDay ? [200, 202, 212] : [90, 92, 120];
    for (let k = 0; k < Math.round((h.cloud / 40) * density); k++) {
      const x = R() * sw, y = R() * sh, r = su * (0.1 + R() * 0.15) * S;
      sim.stroke(curve(x, y, (R() - 0.5) * 0.4, r * 2.4, r * 0.2), Math.max(1.5, r * 0.18), c, 0.6 * L.cloud, R);
    }
  }
  if (L.sun > 0 && h.isDay && !rain && h.cloud < 75) {
    const strength = 1 - h.cloud / 100, x = R() * sw, y = R() * sh, r = su * (0.04 + strength * 0.06) * S;
    for (let ring = 0; ring < 3; ring++) {
      const pts = [], rr = r * (0.4 + ring * 0.35), a0 = R() * TAU;
      for (let s = 0; s <= 30; s++) { const a = a0 + (s / 30) * TAU * 0.9; pts.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr]); }
      sim.stroke(pts, Math.max(1.5, r * 0.3), mix(GOLD, [255, 230, 150], ring * 0.2), 1.1 * strength * L.sun, R);
    }
  }
  if (rain && L.rain > 0) {
    const slant = Math.sin(((h.windDir + 180) * Math.PI) / 180) * Math.min(h.wind, 50) / 100;
    for (let k = 0; k < Math.round((3 + Math.min(h.precip, 10) * 3) * density * L.rain); k++) {
      const x = R() * sw, y = R() * sh, len = su * (0.05 + R() * 0.12) * (0.7 + Math.min(h.precip, 6) / 6);
      sim.stroke([[x, y], [x + slant * len * 0.5, y + len * 0.5], [x + slant * len, y + len]], 1 + R() * 1.6, mix(RAIN_INK, col, 0.3), 0.7, R);
    }
  }
  if (L.wind > 0 && h.wind > 18) {
    const to = ((h.windDir + 180) * Math.PI) / 180, ang = Math.atan2(-Math.cos(to), Math.sin(to));
    for (let k = 0; k < Math.round(((h.wind - 12) / 10) * density); k++) {
      const x = R() * sw, y = R() * sh, len = su * (0.25 + R() * 0.3) * S;
      sim.stroke(curve(x, y, ang, len, (R() - 0.5) * len * 0.1), 1.5 + R() * 2, mix(col, [250, 248, 240], 0.5), 0.25 * L.wind, R);
    }
  }
  sim.finishLayer();
  if (snow || (!h.isDay && h.cloud < 50)) {
    const m = maskCanvas(sw, sh);
    m.g.fillStyle = '#fffaf0';
    for (let k = 0; k < Math.round((snow ? 40 : 12) * density); k++) { m.g.beginPath(); m.g.arc(R() * sw, R() * sh, 0.8 + R() * 1.8, 0, TAU); m.g.fill(); }
    sim.dabMask(m.c, 0.95);
  }
  if (rain && recent) for (let k = 0; k < 3; k++) sc.drops.push({ pos: ctx.toOut(R() * sw, R() * sh), cell: sc.W / sw, col, rainCol: mix(RAIN_INK, col, 0.4), seed: Math.floor(R() * 1e9) });
}

// Simulate one drop landing in a damp wash, frame by frame, for the animation.
function bloomFrames(d, medium, paperCol, seed) {
  const N = 64;
  const paper = makePaper(N, N, d.seed ^ seed);
  const sim = new WetSim(paper, medium === 'oil' ? 'watercolour' : medium, paperCol);
  const base = 0.4;
  const c = d.col.map((v) => v / 255);
  for (let i = 0; i < N * N; i++) { sim.W[i] = 0.55; sim.M[i] = base; sim.Pr[i] = base * c[0]; sim.Pg[i] = base * c[1]; sim.Pb[i] = base * c[2]; }
  const R = rng(d.seed);
  const r = 6 + R() * 4;
  const cx = N / 2, cy = N / 2 - 5;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const a = Math.atan2(y - cy, x - cx);
    const rr = r * (1 + 0.15 * Math.sin(3 * a + d.seed) + 0.08 * Math.sin(7 * a));
    if (Math.hypot(x - cx, y - cy) < rr) sim.W[y * N + x] += 2.2;
  }
  sim.gravity = sim.p.gravity * 1.5;
  const frames = [];
  const pc = paperCol;
  const snap = () => {
    const cv = canvas(N, N);
    const g = cv.getContext('2d');
    const img = g.createImageData(N, N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = y * N + x, j = i * 4;
      const total = sim.M[i] + sim.D[i];
      const delta = total - base;
      const edge = clamp((1 - Math.hypot(x - N / 2, y - N / 2) / (N / 2)) * 3);   // feather the patch border
      const pr = total > 0 ? (sim.Pr[i] + sim.Dr[i]) / total : c[0], pg = total > 0 ? (sim.Pg[i] + sim.Dg[i]) / total : c[1], pb = total > 0 ? (sim.Pb[i] + sim.Db[i]) / total : c[2];
      const wet = Math.min(1, sim.W[i]) * 0.18;
      if (delta >= 0) {
        img.data[j] = pr * 255 * 0.7; img.data[j + 1] = pg * 255 * 0.7; img.data[j + 2] = pb * 255 * 0.7;
        img.data[j + 3] = 255 * edge * clamp(1 - Math.exp(-delta * 3.2) + wet);
      } else {
        img.data[j] = pc[0]; img.data[j + 1] = pc[1]; img.data[j + 2] = pc[2];
        img.data[j + 3] = 255 * edge * 0.6 * clamp(1 - Math.exp(delta * 1.6) - wet * 0.5);
      }
    }
    g.putImageData(img, 0, 0);
    frames.push(cv);
  };
  for (let s = 0; s < 14; s++) { sim.run(4); snap(); }
  for (let g = 0; g < 200 && sim.wetCount() > 0; g++) sim.step();
  for (let i = 0; i < N * N; i++) if (sim.M[i] > 0) sim._settle(i, 1);
  snap();
  return frames;
}

function paperTile(R, medium) {
  const tile = canvas(256, 256);
  const tg = tile.getContext('2d');
  const img = tg.createImageData(256, 256);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const i = (y * 256 + x) * 4;
    const v = medium === 'oil'
      ? 232 + ((x % 4 < 2) !== (y % 4 < 2) ? 14 : 0) + R() * 9 // canvas weave
      : 236 + R() * 19;
    img.data[i] = v; img.data[i + 1] = v * 0.99; img.data[i + 2] = v * 0.96; img.data[i + 3] = 255;
  }
  tg.putImageData(img, 0, 0);
  return tile;
}

// ------------------------------------------------------------ paint

export function paintAbstract(ctx, sc, p, { caption = null, grain = 1 } = {}) {
  const { W, H, u, L } = sc;
  ctx.drawImage(sc.base, 0, 0);

  if (sc.done) {
    for (const s of sc.stars) {
      const tw = 0.5 + 0.5 * Math.sin(TAU * (p * 2 + s.ph));
      const g = ctx.createRadialGradient(s.pos[0], s.pos[1], 0, s.pos[0], s.pos[1], s.r * 4);
      g.addColorStop(0, `rgba(255,250,235,${0.35 * tw})`);
      g.addColorStop(1, 'rgba(255,250,235,0)');
      ctx.fillStyle = g;
      ctx.fillRect(s.pos[0] - s.r * 4, s.pos[1] - s.r * 4, s.r * 8, s.r * 8);
    }

    if (sc.lastSun) {
      const [x, y] = sc.lastSun.pos, r = sc.lastSun.r * (3 + 0.6 * Math.sin(TAU * p));
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, rgba(GOLD, 0.16 * Math.min(1, L.sun)));
      g.addColorStop(1, rgba(GOLD, 0));
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }

    // drops fall, ripple, then bloom and dry into the paper
    sc.drops.forEach((d, k) => {
      const t = (p + k / Math.max(1, sc.drops.length)) % 1;
      const [x, y] = d.pos;
      const land = 0.16;
      if (t < land) {
        const q = t / land, yy = -u * 0.05 + (y + u * 0.05) * q * q;
        const g = ctx.createLinearGradient(x, yy - u * 0.02, x, yy + u * 0.006);
        g.addColorStop(0, rgba(d.rainCol, 0));
        g.addColorStop(1, rgba(d.rainCol, 0.5));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.ellipse(x, yy - u * 0.007, u * 0.0035, u * 0.013, 0, 0, TAU); ctx.fill();
        return;
      }
      const q = (t - land) / (1 - land);
      if (d.frames) {
        const fi = Math.min(d.frames.length - 1, Math.floor((q / 0.65) * (d.frames.length - 1)));
        const fade = q < 0.85 ? 1 : 1 - (q - 0.85) / 0.15;
        const size = d.frames[0].width * d.cell * 0.7;
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(d.frames[fi], x - size / 2, y - size / 2 + d.cell * 3, size, size);
        ctx.restore();
      }
      // soft ripples on the wet surface
      for (const lag of [0, 0.12]) {
        const rq = (q - lag) / 0.4;
        if (rq <= 0 || rq >= 1) continue;
        const rr = u * 0.06 * rq;
        ctx.save();
        ctx.shadowColor = 'rgba(255,255,255,0.4)';
        ctx.shadowBlur = u * 0.004;
        ctx.strokeStyle = `rgba(255,255,255,${0.35 * (1 - rq)})`;
        ctx.lineWidth = Math.max(1, u * 0.0025 * (1 - rq));
        ctx.beginPath(); ctx.ellipse(x, y, rr, rr * 0.42, 0, 0, TAU); ctx.stroke();
        ctx.strokeStyle = rgba(d.rainCol, 0.22 * (1 - rq));
        ctx.beginPath(); ctx.ellipse(x, y + u * 0.002, rr * 1.02, rr * 0.43, 0, 0, Math.PI); ctx.stroke();
        ctx.restore();
      }
    });
  }

  if (grain) {
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = (sc.medium === 'oil' ? 0.35 : sc.medium === 'gouache' ? 0.15 : 0.22) * grain;
    ctx.fillStyle = ctx.createPattern(sc.paperTile, 'repeat');
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  if (caption) {
    const x = W * 0.045, y = H * 0.86;
    const shade = ctx.createLinearGradient(0, H * 0.7, 0, H);
    shade.addColorStop(0, 'rgba(30,26,40,0)');
    shade.addColorStop(1, 'rgba(30,26,40,0.32)');
    ctx.fillStyle = shade;
    ctx.fillRect(0, H * 0.7, W, H * 0.3);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.25)';
    ctx.shadowBlur = u * 0.012;
    ctx.fillStyle = 'rgba(255,251,242,0.96)';
    ctx.font = `italic ${Math.round(u * 0.05)}px Fraunces, "Iowan Old Style", Georgia, serif`;
    ctx.fillText(caption.title, x, y);
    ctx.font = `${Math.round(u * 0.022)}px Fraunces, "Iowan Old Style", Georgia, serif`;
    ctx.fillText(caption.sub, x + u * 0.003, y + u * 0.042);
    if (caption.sub2) {
      ctx.globalAlpha = 0.85;
      ctx.font = `${Math.round(u * 0.019)}px Fraunces, "Iowan Old Style", Georgia, serif`;
      ctx.fillText(caption.sub2, x + u * 0.003, y + u * 0.075);
    }
    ctx.restore();
  }

  if (!sc.done) {
    // thin progress line while the layers are still being painted
    ctx.fillStyle = 'rgba(43,39,36,0.35)';
    ctx.fillRect(0, 0, W * sc.progress, Math.max(2, u * 0.003));
  }
}
