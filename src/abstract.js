// Abstract mode. Each hour of weather is painted as one layer over the whole canvas,
// oldest first, so the painting builds up over the day.
// Animation is periodic in p (0..1) so exported loops are seamless.

import { rng, hash } from './sky.js';

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
  range: 1,                // days of weather to layer: 1, 3, 7 or 30
  medium: 'watercolour',   // watercolour | gouache | oil | ink
  palette: 'temperature',  // temperature | pastel | moody | sunset
  size: 1,                 // splotch size
  layers: { colour: 1, rain: 1, sun: 1, cloud: 1, wind: 1 },
};

const PAPER = { watercolour: [246, 240, 228], gouache: [240, 234, 222], oil: [232, 226, 214], ink: [244, 236, 220] };
const RAIN_INK = [62, 96, 140];
const NIGHT_INK = [50, 52, 102];
const GOLD = [232, 172, 64];
const SEAL_RED = [196, 48, 38];

// Temperature (°C) to colour.
const PALETTES = {
  temperature: [[-5, [150, 170, 220]], [5, [128, 162, 214]], [12, [118, 176, 198]], [18, [146, 188, 160]], [24, [234, 198, 128]], [30, [236, 146, 98]], [38, [212, 88, 88]]],
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

const isSnow = (h) => (h.code >= 71 && h.code <= 77) || h.code === 85 || h.code === 86;
const isRain = (h) => h.precip > 0.05 && !isSnow(h);
const isStorm = (h) => h.code >= 95;

// ------------------------------------------------------------ data

// series = { points: [{t, temp, precip, cloud, wind, windDir, code, isDay}], start, end, now }
// Times are local wall-clock ms. Long ranges are merged into at most maxLayers layers.
export function toLayers(series, maxLayers = 48) {
  const hours = Math.max(1, Math.ceil((series.now - series.start) / HOUR));
  const per = Math.max(1, Math.ceil(hours / maxLayers));
  const out = [];
  for (let t0 = series.start; t0 <= series.now; t0 += per * HOUR) {
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

  const hr = (p) => (p.t - series.start) / HOUR;
  const parts = [['overnight', 0, 5], ['morning', 5, 12], ['afternoon', 12, 18], ['evening', 18, 24]]
    .map(([name, a, b]) => [name, bucket(upto.filter((h) => hr(h) >= a && hr(h) < b))])
    .filter(([, v]) => v);
  const merged = [];
  for (const [name, v] of parts) {
    const last = merged[merged.length - 1];
    if (last && last.v === v) last.names.push(name);
    else merged.push({ v, names: [name] });
  }
  const when = (names) => (names.length > 2 ? 'all day' : names.map((n) => (n === 'overnight' ? 'overnight' : `in the ${n}`)).join(' and ').replace(' and in the ', ' and '));
  const NOUN = { clear: 'clear skies', grey: 'grey skies', 'patchy cloud': 'patchy cloud', rain: 'rain', 'heavy rain': 'heavy rain', storms: 'storms', snow: 'snow' };
  let text = merged.map(({ v, names }) => `${NOUN[v]} ${when(names)}`).join(', then ');
  text = text.charAt(0).toUpperCase() + text.slice(1);
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
};
const DEMO_NOW = { rain: 15.4, storm: 20.2, noon: 17, snow: 14, night: 23.6, grey: 12 };

export function demoSeries(name = 'rain', days = 1) {
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
      const code = P.storm?.includes(h) ? 95 : P.snow?.includes(h) ? 73 : precip > 2 ? 63 : precip > 0 ? 61 : cloud > 85 ? 3 : cloud > 40 ? 2 : 0;
      points.push({ t: start + d * DAY + h * HOUR, temp: P.lo + shift + (P.hi - P.lo) * warmth, precip, cloud, wind: P.wind(h), windDir: 200, code, isDay: h >= 6 && h < 18 });
    }
  }
  return { points, start, end: today + DAY, now: today + (DEMO_NOW[name] ?? 15.4) * HOUR };
}

// ------------------------------------------------------------ mediums

function makeBrush(g, u, medium) {
  const tone = medium === 'ink'
    ? (c) => { const v = 40 + (lum(c) / 255) * 200; return [v, v * 0.98, v * 0.95]; }
    : medium === 'gouache' ? (c) => mix(c, [250, 246, 236], 0.12) : (c) => c;

  function blobPath(R, x, y, rx, ry, wob = 1) {
    const k = 12, ph = R() * TAU, ph2 = R() * TAU, pts = [];
    for (let j = 0; j < k; j++) {
      const t = (j / k) * TAU;
      const r = 1 + wob * (0.12 * Math.sin(3 * t + ph) + 0.06 * Math.sin(5 * t + ph2) + (R() - 0.5) * 0.06);
      pts.push([x + Math.cos(t) * rx * r, y + Math.sin(t) * ry * r]);
    }
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    g.beginPath();
    const m = mid(pts[k - 1], pts[0]);
    g.moveTo(m[0], m[1]);
    for (let j = 0; j < k; j++) { const n = mid(pts[j], pts[(j + 1) % k]); g.quadraticCurveTo(pts[j][0], pts[j][1], n[0], n[1]); }
    g.closePath();
  }

  // One dab of paint. `a` is tuned for watercolour; the other mediums scale it up.
  return function dab(R, x, y, rx, ry, col, a, { edge = 0.5, keepColour = false, angle } = {}) {
    if (a <= 0.003) return;
    const c = keepColour ? col : tone(col);
    if (medium === 'watercolour' || medium === 'ink') {
      blobPath(R, x, y, rx, ry);
      g.fillStyle = rgba(c, a);
      g.fill();
      if (edge) {
        // pigment collects at the edge as it dries
        g.strokeStyle = rgba(mix(c, [20, 20, 40], 0.35), a * edge);
        g.lineWidth = Math.max(1, u * 0.0015);
        g.stroke();
      }
    } else if (medium === 'gouache') {
      blobPath(R, x, y, rx * 0.85, ry * 0.85, 0.6);
      g.fillStyle = rgba(c, Math.min(0.92, a * 3.2));
      g.fill();
    } else {
      // oil: a few thick strokes with a light ridge on top and a shadow below
      const n = 3 + Math.floor(R() * 3);
      const ang = angle ?? (R() - 0.5) * 0.9;
      const lw = Math.max(2, ry * 0.55);
      const alpha = Math.min(0.9, a * 4);
      g.lineCap = 'round';
      for (let i = 0; i < n; i++) {
        const off = (i / (n - 1 || 1) - 0.5) * ry * 1.3;
        const cx = x - Math.sin(ang) * off, cy = y + Math.cos(ang) * off;
        const len = rx * (0.7 + R() * 0.4);
        const dx = Math.cos(ang) * len, dy = Math.sin(ang) * len;
        const cc = mix(c, R() < 0.5 ? [255, 255, 255] : [0, 0, 0], R() * 0.12);
        const stroke = (col2, alpha2, width, shift, sx = 1) => {
          g.strokeStyle = rgba(col2, alpha2);
          g.lineWidth = width;
          g.beginPath();
          g.moveTo(cx - dx * sx, cy - dy * sx + shift);
          g.quadraticCurveTo(cx, cy + shift + (R() - 0.5) * lw * 0.3, cx + dx * sx, cy + dy * sx + shift);
          g.stroke();
        };
        stroke(cc, alpha, lw, 0);
        stroke(mix(cc, [255, 255, 255], 0.45), alpha * 0.5, Math.max(1, lw * 0.12), -lw * 0.3, 0.85);
        stroke(mix(cc, [0, 0, 0], 0.35), alpha * 0.35, Math.max(1, lw * 0.12), lw * 0.35, 0.85);
      }
    }
  };
}

function paperTile(R, medium) {
  const tile = canvas(256, 256);
  const tg = tile.getContext('2d');
  const img = tg.createImageData(256, 256);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const i = (y * 256 + x) * 4;
    const v = medium === 'oil'
      ? 232 + ((x % 4 < 2) !== (y % 4 < 2) ? 14 : 0) + R() * 9 // canvas weave
      : 228 + R() * 27;
    img.data[i] = v; img.data[i + 1] = v * 0.99; img.data[i + 2] = v * 0.96; img.data[i + 3] = 255;
  }
  tg.putImageData(img, 0, 0);
  return tile;
}

// ------------------------------------------------------------ build

export function buildAbstract(W, H, series, seed, place = '', opts = {}) {
  const o = { ...DEFAULTS, ...opts, layers: { ...DEFAULTS.layers, ...(opts.layers || {}) } };
  const L = o.layers, S = o.size, medium = o.medium;
  const u = Math.min(W, H);
  const area = Math.sqrt((W * H) / (u * u)); // more dabs on wide canvases
  const paper = PAPER[medium] || PAPER.watercolour;
  const layers = toLayers(series);
  const n = layers.length;
  const sc = { W, H, u, series, place, kind: 'abstract', medium, L, paper, layers };

  const colourOf = (h) => {
    let c = tempColour(h.temp, o.palette);
    c = mix(c, [lum(c), lum(c), lum(c) * 1.05], (h.cloud / 100) * 0.45 * Math.min(1, L.cloud));
    if (isRain(h)) c = mix(c, RAIN_INK, clamp(0.25 + h.precip / 4, 0, 0.65) * Math.min(1, L.rain));
    if (!h.isDay) c = mix(c, NIGHT_INK, 0.55);
    return c;
  };

  const base = canvas(W, H);
  const g = base.getContext('2d');
  const dab = makeBrush(g, u, medium);

  // Ground: a wash of the average colour so the canvas is never bare.
  const avg = layers.length ? layers.map(colourOf).reduce((s, c) => s.map((v, i) => v + c[i] / n), [0, 0, 0]) : [200, 200, 210];
  g.fillStyle = rgba(paper);
  g.fillRect(0, 0, W, H);
  g.fillStyle = rgba(mix(medium === 'ink' ? [200, 196, 188] : avg, paper, 0.35), medium === 'ink' ? 0.5 : 0.55 * Math.min(1, L.colour + 0.2));
  g.fillRect(0, 0, W, H);

  // Fewer dabs per layer when there are many layers, so long ranges don't turn to mud.
  const density = clamp(24 / Math.max(n, 1), 0.35, 1.4) * area;
  sc.suns = [];
  sc.stars = [];
  sc.falling = [];
  sc.wind = [];

  layers.forEach((h, i) => {
    // Each layer has its own seed, so earlier layers stay put as new hours arrive.
    const R = rng(hash(`${seed}|${h.t0}`));
    const age = (i + 1) / n;                // 0..1, newest = 1
    const fresh = 0.8 + 0.35 * age * age;   // recent hours read a bit stronger
    const col = colourOf(h);
    const rx = () => u * (0.12 + R() * 0.28) * S;

    // 1. colour
    if (L.colour > 0) {
      const count = Math.round(7 * density);
      for (let k = 0; k < count; k++) {
        const r = rx();
        dab(R, R() * W, R() * H, r * (1 + R() * 0.8), r * (0.5 + R() * 0.5), mix(col, paper, R() * 0.2), (0.05 + R() * 0.07) * L.colour * fresh, { angle: (R() - 0.5) * 0.6 });
      }
    }

    // 2. cloud: pale glazes, more of them when it's overcast
    if (L.cloud > 0 && h.cloud > 30) {
      const count = Math.round((h.cloud / 30) * density);
      const c = h.isDay ? [218, 218, 226] : [108, 110, 140];
      for (let k = 0; k < count; k++) {
        const r = rx() * 0.8;
        dab(R, R() * W, R() * H * 0.85, r * 1.6, r * 0.55, c, (0.06 + (h.cloud / 100) * 0.1) * L.cloud * fresh, { edge: 0.7, angle: (R() - 0.5) * 0.3 });
      }
    }

    // 3. sun: a gold bloom, stronger when the sky is clear
    if (L.sun > 0 && h.isDay && !isRain(h) && h.cloud < 75) {
      const strength = 1 - h.cloud / 100;
      const x = W * (0.1 + R() * 0.8), y = H * (0.08 + R() * 0.6);
      const r = u * (0.03 + strength * 0.07) * S;
      const c = medium === 'ink' ? SEAL_RED : GOLD;
      const glow = g.createRadialGradient(x, y, 0, x, y, r * 3);
      glow.addColorStop(0, rgba(c, 0.25 * strength * Math.min(1, L.sun)));
      glow.addColorStop(1, rgba(c, 0));
      g.fillStyle = glow;
      g.fillRect(x - r * 3, y - r * 3, r * 6, r * 6);
      dab(R, x, y, r, r, medium === 'ink' ? c : mix(c, [255, 220, 120], 0.3), (0.3 + strength * 0.35) * L.sun * fresh, { edge: 0.6, keepColour: true });
      if (medium !== 'ink') dab(R, x + r * 0.1, y - r * 0.1, r * 0.65, r * 0.65, [255, 228, 150], 0.25 * L.sun, { edge: 0, keepColour: true });
      sc.suns.push({ x, y, r, i, col: c });
    }

    // 4. clear nights: specks of white gouache
    if (!h.isDay && h.cloud < 50) {
      for (let k = 0; k < Math.round(10 * density); k++) {
        sc.stars.push({ x: R() * W, y: R() * H * 0.8, r: u * (0.0015 + R() * 0.003), ph: R(), k: 1 + Math.floor(R() * 2), i });
      }
    }

    // 5. rain: blooms where water pushed the pigment out, with drips running down
    if (L.rain > 0 && isRain(h)) {
      const rc = medium === 'ink' ? [70, 70, 76] : mix(RAIN_INK, col, 0.3);
      const count = Math.round((2 + Math.min(h.precip, 10) * 2) * density);
      for (let k = 0; k < count; k++) {
        const x = R() * W, y = R() * H * 0.9;
        const r = u * (0.015 + R() * 0.05) * (0.7 + Math.min(h.precip, 6) / 8) * S;
        if (medium === 'watercolour' || medium === 'ink') {
          const fill = g.createRadialGradient(x, y, 0, x, y, r);
          fill.addColorStop(0, rgba(mix(rc, paper, 0.7), 0.35 * L.rain));
          fill.addColorStop(0.85, rgba(mix(rc, paper, 0.35), 0.22 * L.rain));
          fill.addColorStop(1, rgba(rc, 0.1 * L.rain));
          g.fillStyle = fill;
          g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
          g.strokeStyle = rgba(rc, 0.42 * L.rain);
          g.lineWidth = Math.max(1, r * 0.05);
          g.beginPath();
          for (let j = 0; j <= 24; j++) {
            const t = (j / 24) * TAU, rr = r * (1 + (R() - 0.5) * 0.18);
            j ? g.lineTo(x + Math.cos(t) * rr, y + Math.sin(t) * rr) : g.moveTo(x + Math.cos(t) * rr, y + Math.sin(t) * rr);
          }
          g.stroke();
        } else {
          dab(R, x, y, r, r * (medium === 'oil' ? 0.5 : 1), rc, 0.22 * L.rain, { keepColour: true, angle: Math.PI / 2 });
        }
        // some blooms run
        if (R() < 0.35) {
          const len = u * (0.04 + R() * 0.12) * (0.6 + Math.min(h.precip, 6) / 6) * S;
          const w = u * (0.0018 + R() * 0.0025) * Math.sqrt(S);
          g.strokeStyle = rgba(rc, 0.45 * Math.min(1, L.rain));
          g.lineWidth = w;
          g.lineCap = 'round';
          g.beginPath(); g.moveTo(x, y + r * 0.8); g.quadraticCurveTo(x + (R() - 0.5) * u * 0.004, y + r + len * 0.6, x + (R() - 0.5) * u * 0.003, y + r + len); g.stroke();
          g.fillStyle = rgba(rc, 0.55 * Math.min(1, L.rain));
          g.beginPath(); g.ellipse(x, y + r + len + w * 0.6, w * 1.3, w * 1.7, 0, 0, TAU); g.fill();
        }
      }
      if (i >= n - 3) {
        for (let k = 0; k < Math.round((1 + Math.min(h.precip, 6)) * density); k++) {
          sc.falling.push({ x: R() * W, land: H * (0.2 + R() * 0.7), ph: R(), k: 1 + Math.floor(R() * 2), r: u * (0.03 + R() * 0.04) * S });
        }
      }
    }

    // 6. snow
    if (isSnow(h)) {
      for (let k = 0; k < Math.round(30 * density); k++) {
        g.fillStyle = `rgba(255,255,255,${(0.6 + R() * 0.35) * Math.min(1, L.rain)})`;
        g.beginPath(); g.arc(R() * W, R() * H, u * (0.002 + R() * 0.005) * S, 0, TAU); g.fill();
      }
    }

    // 7. storms: one lightning stroke per stormy layer
    if (isStorm(h) && L.rain > 0) {
      let x = W * (0.15 + R() * 0.7), y = -u * 0.02;
      g.lineJoin = 'round';
      g.beginPath(); g.moveTo(x, y);
      while (y < H * (0.6 + R() * 0.3)) { x += (R() - 0.5) * u * 0.08; y += u * (0.05 + R() * 0.07); g.lineTo(x, y); }
      g.strokeStyle = rgba([40, 36, 60], 0.7 * Math.min(1, L.rain));
      g.lineWidth = u * 0.005;
      g.stroke();
      g.strokeStyle = rgba(medium === 'ink' ? SEAL_RED : GOLD, 0.85 * Math.min(1, L.rain));
      g.lineWidth = u * 0.0018;
      g.stroke();
    }

    // 8. wind: dry-brush strokes, animated on the recent layers
    if (L.wind > 0 && h.wind > 15) {
      const dir = -Math.sin((h.windDir * Math.PI) / 180) || 1;
      const count = Math.max(1, Math.round(((h.wind - 10) / 6) * density));
      for (let k = 0; k < count; k++) {
        const len = u * (0.15 + R() * 0.3) * S;
        const stroke = { x: R() * W - len * 0.3, y: R() * H, len, curve: (R() - 0.5) * u * 0.08, w: u * (0.0015 + R() * 0.0025) * Math.sqrt(S), dir, k: 1 + Math.floor(R() * 2), a: (0.18 + R() * 0.2) * L.wind };
        if (i >= n - 3) sc.wind.push(stroke);
        else {
          g.strokeStyle = `rgba(250,246,236,${clamp(stroke.a * 0.8)})`;
          g.lineWidth = stroke.w;
          g.lineCap = 'round';
          g.setLineDash([len * 0.2, len * 0.07]);
          g.beginPath(); g.moveTo(stroke.x, stroke.y); g.quadraticCurveTo(stroke.x + len / 2, stroke.y + stroke.curve, stroke.x + len, stroke.y); g.stroke();
          g.setLineDash([]);
        }
      }
    }
  });

  sc.paperTile = paperTile(rng(seed), medium);
  sc.base = base;
  sc.summary = summarise(series);
  return sc;
}

// ------------------------------------------------------------ paint

export function paintAbstract(ctx, sc, p, { caption = null, grain = 1 } = {}) {
  const { W, H, u, L, layers } = sc;
  const n = layers.length;
  ctx.drawImage(sc.base, 0, 0);

  for (const s of sc.stars) {
    ctx.fillStyle = `rgba(255,252,240,${0.5 + 0.4 * Math.sin(TAU * (p * s.k + s.ph))})`;
    ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, TAU); ctx.fill();
  }

  // the latest sun breathes, if it's from the last few layers
  const last = sc.suns[sc.suns.length - 1];
  if (last && last.i >= n - 3) {
    const r = last.r * (2.4 + 0.5 * Math.sin(TAU * p));
    const glow = ctx.createRadialGradient(last.x, last.y, 0, last.x, last.y, r);
    glow.addColorStop(0, rgba(last.col, 0.2 * Math.min(1, L.sun)));
    glow.addColorStop(1, rgba(last.col, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(last.x - r, last.y - r, r * 2, r * 2);
  }

  ctx.lineCap = 'round';
  for (const w of sc.wind) {
    const dash = w.len / 3;
    ctx.setLineDash([dash * 0.7, dash * 0.3]);
    ctx.lineDashOffset = -w.dir * p * dash * w.k;
    ctx.strokeStyle = `rgba(250,246,236,${clamp(w.a)})`;
    ctx.lineWidth = w.w;
    ctx.beginPath(); ctx.moveTo(w.x, w.y); ctx.quadraticCurveTo(w.x + w.len / 2, w.y + w.curve, w.x + w.len, w.y); ctx.stroke();
  }
  ctx.setLineDash([]);

  // drops fall, land, and ripple out
  const rainCol = sc.medium === 'ink' ? [50, 50, 56] : RAIN_INK;
  const ra = Math.min(1, L.rain);
  for (const d of sc.falling) {
    const t = (p * d.k + d.ph) % 1;
    if (t < 0.3) {
      const y = -u * 0.05 + (d.land + u * 0.05) * (t / 0.3);
      ctx.fillStyle = rgba(rainCol, 0.55 * ra);
      ctx.beginPath(); ctx.ellipse(d.x, y, u * 0.003, u * 0.009, 0, 0, TAU); ctx.fill();
    } else {
      const q = (t - 0.3) / 0.7;
      for (const lag of [0, 0.25]) {
        const qq = q - lag;
        if (qq <= 0) continue;
        ctx.strokeStyle = rgba(rainCol, 0.45 * (1 - qq) * ra);
        ctx.lineWidth = Math.max(1, u * 0.002 * (1 - qq));
        ctx.beginPath(); ctx.ellipse(d.x, d.land, d.r * qq, d.r * qq * 0.45, 0, 0, TAU); ctx.stroke();
      }
    }
  }

  if (grain) {
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = (sc.medium === 'oil' ? 0.35 : sc.medium === 'gouache' ? 0.18 : 0.28) * grain;
    ctx.fillStyle = ctx.createPattern(sc.paperTile, 'repeat');
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  if (caption) {
    const x = W * 0.045, y = H * 0.9;
    const shade = ctx.createLinearGradient(0, H * 0.72, 0, H);
    shade.addColorStop(0, 'rgba(30,26,40,0)');
    shade.addColorStop(1, 'rgba(30,26,40,0.32)');
    ctx.fillStyle = shade;
    ctx.fillRect(0, H * 0.72, W, H * 0.28);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.25)';
    ctx.shadowBlur = u * 0.012;
    ctx.fillStyle = 'rgba(255,251,242,0.95)';
    ctx.font = `italic ${Math.round(u * 0.05)}px Fraunces, "Iowan Old Style", Georgia, serif`;
    ctx.fillText(caption.title, x, y);
    ctx.font = `${Math.round(u * 0.021)}px Fraunces, "Iowan Old Style", Georgia, serif`;
    ctx.globalAlpha = 0.9;
    ctx.fillText(caption.sub, x + u * 0.003, y + u * 0.04);
    ctx.restore();
    if (sc.medium === 'ink') {
      const sz = u * 0.055, sx = W - W * 0.045 - sz, sy = y - sz * 0.75;
      ctx.fillStyle = 'rgba(180,40,34,0.88)';
      ctx.fillRect(sx, sy, sz, sz);
      ctx.fillStyle = 'rgb(244,236,220)';
      ctx.font = `bold ${Math.round(sz * 0.42)}px Georgia, serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText((sc.place || 'sky').slice(0, 2).toUpperCase(), sx + sz / 2, sy + sz / 2);
      ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
    }
  }
}
