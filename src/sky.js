// Sky painting: turns live weather into a looping generative painting.
// Every moving thing is periodic over LOOP_SECONDS, so exported GIF/WebP loops are seamless.

export const LOOP_SECONDS = 8;

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => c1.map((v, i) => v + (c2[i] - v) * t);
const rgba = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const TAU = Math.PI * 2;

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

// ---------------------------------------------------------------- weather -> state

const CODES = {
  0: 'clear sky', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'light showers', 81: 'showers', 82: 'violent showers', 85: 'snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with hail',
};

export function describeCode(code) {
  const label = CODES[code] ?? 'weather';
  const rainy = (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95;
  const snow = (code >= 71 && code <= 77) || code === 85 || code === 86;
  const fog = code === 45 || code === 48;
  const thunder = code >= 95;
  const minCloud = code === 0 ? 0 : code === 1 ? 0.15 : code === 2 ? 0.4 : code === 3 ? 0.9 : rainy || snow ? 0.75 : fog ? 0.6 : 0;
  const minRain = rainy ? (code === 61 || code === 51 || code === 80 ? 0.4 : code === 65 || code === 82 || code >= 95 ? 4 : 1.5) : 0;
  return { label, rainy, snow, fog, thunder, minCloud, minRain };
}

function moonPhase(ms) {
  const synodic = 29.530588853;
  const ref = Date.UTC(2000, 0, 6, 18, 14);
  return (((ms - ref) / 86400000) % synodic + synodic) % synodic / synodic; // 0 new, 0.5 full
}

// w: { code, cloud(0-100), precip(mm), wind(km/h), windDir(deg), temp, now, sunrise, sunset } — times are "local ms"
export function stateFromWeather(w) {
  const d = describeCode(w.code);
  const day = 86400000;
  let elev, sunT;
  if (w.now >= w.sunrise && w.now <= w.sunset) {
    sunT = (w.now - w.sunrise) / (w.sunset - w.sunrise);
    elev = Math.sin(Math.PI * sunT);
  } else {
    const start = w.now > w.sunset ? w.sunset : w.sunset - day;
    const end = w.now > w.sunset ? w.sunrise + day : w.sunrise;
    sunT = (w.now - start) / (end - start);
    elev = -Math.sin(Math.PI * sunT);
  }
  return {
    elev,                         // -1 (midnight) .. 0 (horizon) .. 1 (noon)
    sunT,                         // 0..1 progress through the current day or night
    isDay: elev >= 0,
    cloud: clamp(Math.max((w.cloud ?? 0) / 100, d.minCloud)),
    rain: d.snow ? 0 : Math.max(w.precip ?? 0, d.minRain),
    snow: d.snow ? Math.max(w.precip ?? 0, 0.6) : 0,
    thunder: d.thunder,
    fog: d.fog,
    wind: w.wind ?? 5,
    windDir: w.windDir ?? 270,
    temp: w.temp,
    label: d.label,
    moon: moonPhase(w.utcNow ?? Date.now()),
  };
}

export const DEMOS = {
  noon: { code: 1, cloud: 20, precip: 0, wind: 12, windDir: 120, temp: 27, hour: 12.5 },
  sunset: { code: 2, cloud: 45, precip: 0, wind: 9, windDir: 250, temp: 24, hour: 18.05 },
  night: { code: 0, cloud: 8, precip: 0, wind: 4, windDir: 200, temp: 16, hour: 23.5 },
  rain: { code: 63, cloud: 95, precip: 2.5, wind: 22, windDir: 160, temp: 19, hour: 15 },
  storm: { code: 95, cloud: 100, precip: 7, wind: 45, windDir: 230, temp: 23, hour: 17.2 },
  snow: { code: 73, cloud: 90, precip: 1, wind: 10, windDir: 300, temp: -2, hour: 10 },
  fog: { code: 45, cloud: 70, precip: 0, wind: 3, windDir: 90, temp: 9, hour: 7.2 },
  dawn: { code: 1, cloud: 30, precip: 0, wind: 6, windDir: 90, temp: 14, hour: 5.6 },
};

export function demoWeather(name) {
  const d = DEMOS[name] || DEMOS.sunset;
  const base = Date.UTC(2026, 0, 1);
  return { ...d, now: base + d.hour * 3600000, sunrise: base + 5.3 * 3600000, sunset: base + 18.3 * 3600000 };
}

// ---------------------------------------------------------------- colours

const NIGHT = [[8, 12, 34], [20, 26, 62], [44, 42, 86]];
const BLUE_HOUR = [[24, 36, 92], [78, 70, 138], [176, 108, 136]];
const SUNSET = [[48, 70, 140], [206, 116, 130], [255, 178, 106]];
const GOLDEN = [[70, 124, 204], [164, 188, 226], [255, 214, 162]];
const DAY = [[48, 116, 212], [118, 174, 236], [204, 230, 250]];
const SKY_KEYS = [[-1, NIGHT], [-0.22, NIGHT], [-0.07, BLUE_HOUR], [0.03, SUNSET], [0.2, GOLDEN], [0.55, DAY], [1, DAY]];

const HILL_NIGHT = [12, 14, 30], HILL_DUSK = [62, 42, 78], HILL_DAY = [46, 78, 82];

function keyed(keys, e) {
  for (let i = 0; i < keys.length - 1; i++) {
    const [e0, c0] = keys[i], [e1, c1] = keys[i + 1];
    if (e >= e0 && e <= e1) {
      const t = (e - e0) / (e1 - e0 || 1);
      return Array.isArray(c0[0]) ? c0.map((c, j) => mix(c, c1[j], t)) : mix(c0, c1, t);
    }
  }
  return keys[keys.length - 1][1];
}

function palette(s) {
  let [top, mid, bottom] = keyed(SKY_KEYS, s.elev);
  // overcast: pull towards grey of similar brightness
  const lum = (c) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
  const grey = (c, k) => { const l = lum(c) * k; return [l, l * 1.02, l * 1.08]; };
  const og = s.cloud * s.cloud * 0.75 + (s.rain > 0 ? 0.15 : 0) + (s.fog ? 0.3 : 0);
  const dark = s.rain > 0 ? 0.82 - Math.min(s.rain, 8) * 0.025 : 1;
  top = mix(top, grey(top, 0.95), clamp(og)).map((v) => v * dark);
  mid = mix(mid, grey(mid, 0.95), clamp(og)).map((v) => v * dark);
  bottom = mix(bottom, grey(bottom, 1.0), clamp(og * 0.9)).map((v) => v * dark);

  const hill = keyed([[-1, HILL_NIGHT], [-0.15, HILL_NIGHT], [0.03, HILL_DUSK], [0.3, HILL_DAY], [1, HILL_DAY]], s.elev);
  const warm = clamp(1 - Math.abs(s.elev - 0.05) / 0.25) * (1 - s.cloud * 0.6);
  const night = clamp(-s.elev * 5);
  const lit = mix(mix([255, 255, 255], [255, 196, 168], warm), [74, 82, 116], night).map((v) => v * (s.rain > 0 ? 0.86 : 1));
  const shade = mix(mix(mid, [124, 130, 146], 0.55), [30, 34, 62], night).map((v) => v * (s.rain > 0 ? 0.8 : 1));
  return { top, mid, bottom, hill, lit, shade, warm, night };
}

// ---------------------------------------------------------------- scene

export function buildScene(W, H, s, seed, place = '') {
  const R = rng(seed);
  const pal = palette(s);
  const horizon = H * 0.8;
  const sc = { W, H, s, pal, horizon, place, seed };
  const unit = Math.min(W, H);

  // --- sky wash
  const sky = canvas(W, H);
  const g = sky.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, horizon);
  grad.addColorStop(0, rgba(pal.top));
  grad.addColorStop(0.58, rgba(pal.mid));
  grad.addColorStop(1, rgba(pal.bottom));
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  const colAt = (y) => (y < horizon * 0.58 ? mix(pal.top, pal.mid, y / (horizon * 0.58)) : mix(pal.mid, pal.bottom, clamp((y - horizon * 0.58) / (horizon * 0.42))));
  // pigment blooms
  for (let i = 0; i < 70; i++) {
    const x = R() * W, y = R() * horizon, r = unit * (0.08 + R() * 0.32);
    const tint = R() < 0.5 ? [255, 210, 220] : [150, 190, 255];
    const c = mix(colAt(y), tint, 0.06 + R() * 0.1);
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    const a = 0.05 + R() * 0.08;
    rg.addColorStop(0, rgba(c, a));
    rg.addColorStop(0.8, rgba(c, a * 0.9));
    rg.addColorStop(0.93, rgba(mix(c, [0, 0, 0], 0.08), a * 1.4)); // dried edge
    rg.addColorStop(1, rgba(c, 0));
    g.fillStyle = rg;
    g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
  }
  // horizontal brush passes
  for (let i = 0; i < 14; i++) {
    const y = R() * horizon, h = unit * (0.02 + R() * 0.07);
    const c = mix(colAt(y), R() < 0.5 ? [255, 255, 255] : [0, 0, 20], 0.08);
    g.fillStyle = rgba(c, 0.05 + R() * 0.05);
    g.beginPath();
    g.moveTo(-20, y);
    for (let x = 0; x <= W + 40; x += W / 18) g.lineTo(x, y + Math.sin(x * 0.004 + i) * h * 0.4 + (R() - 0.5) * h * 0.3);
    for (let x = W + 40; x >= -20; x -= W / 18) g.lineTo(x, y + h + Math.sin(x * 0.005 + i * 2) * h * 0.4 + (R() - 0.5) * h * 0.3);
    g.fill();
  }
  sc.sky = sky;

  // --- hills
  const hills = canvas(W, H);
  const hg = hills.getContext('2d');
  const layers = 3;
  for (let L = 0; L < layers; L++) {
    const base = horizon + L * H * 0.055 - H * 0.02;
    const amp = H * (0.07 - L * 0.016);
    const ph = [R() * TAU, R() * TAU, R() * TAU];
    const f = [1 + R(), 2.5 + R() * 2, 6 + R() * 5];
    const col = mix(mix(pal.bottom, pal.hill, 0.45 + L * 0.25), [0, 0, 0], L * 0.05 + pal.night * 0.2);
    const yAt = (x) => {
      const u = x / W;
      return base - amp * (0.55 + 0.3 * Math.sin(u * f[0] * Math.PI + ph[0]) + 0.12 * Math.sin(u * f[1] * Math.PI + ph[1]) + 0.04 * Math.sin(u * f[2] * Math.PI + ph[2]));
    };
    for (let pass = 0; pass < 3; pass++) {
      const j = (pass - 1) * unit * 0.004;
      hg.fillStyle = rgba(col, pass === 1 ? 0.75 : 0.22);
      hg.beginPath();
      hg.moveTo(0, H);
      for (let i = 0; i <= 120; i++) { const x = (W * i) / 120; hg.lineTo(x, yAt(x) + j + (R() - 0.5) * unit * 0.002); }
      hg.lineTo(W, H);
      hg.fill();
    }
    // edge darkening along the ridge
    hg.strokeStyle = rgba(mix(col, [0, 0, 0], 0.25), 0.35);
    hg.lineWidth = unit * 0.0025;
    hg.beginPath();
    for (let i = 0; i <= 120; i++) { const x = (W * i) / 120; i ? hg.lineTo(x, yAt(x)) : hg.moveTo(x, yAt(x)); }
    hg.stroke();
    // misty band at the foot of each layer
    const mist = hg.createLinearGradient(0, base - amp * 0.2, 0, base + H * 0.08);
    mist.addColorStop(0, rgba(pal.bottom, 0));
    mist.addColorStop(1, rgba(pal.bottom, 0.18));
    hg.fillStyle = mist;
    hg.fillRect(0, base - amp * 0.2, W, H);
  }
  sc.hills = hills;

  // --- paper grain (tile)
  const tile = canvas(256, 256);
  const tg = tile.getContext('2d');
  const img = tg.createImageData(256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 225 + R() * 30;
    img.data[i] = v; img.data[i + 1] = v * 0.99; img.data[i + 2] = v * 0.96; img.data[i + 3] = 255;
  }
  tg.putImageData(img, 0, 0);
  tg.strokeStyle = 'rgba(160,150,130,0.18)';
  for (let i = 0; i < 70; i++) {
    tg.lineWidth = 0.5 + R();
    const x = R() * 256, y = R() * 256, a = R() * TAU, l = 6 + R() * 22;
    tg.beginPath(); tg.moveTo(x, y); tg.quadraticCurveTo(x + Math.cos(a) * l * 0.5 + R() * 4, y + Math.sin(a) * l * 0.5, x + Math.cos(a) * l, y + Math.sin(a) * l); tg.stroke();
  }
  sc.paperTile = tile;

  // --- sun / moon path
  const arcX = (t) => W * (0.08 + 0.84 * t);
  const arcY = (e) => horizon - (horizon - H * 0.14) * e;
  sc.sun = { x: arcX(s.isDay ? s.sunT : 0), y: arcY(s.elev), r: unit * 0.045 };
  sc.moon = { x: arcX(s.isDay ? 0.5 : s.sunT), y: arcY(Math.abs(s.isDay ? 0 : s.elev)) , r: unit * 0.032 };

  // --- stars
  sc.stars = [];
  const starCount = Math.round(260 * (1 - s.cloud * 0.85) * pal.night);
  for (let i = 0; i < starCount; i++) {
    sc.stars.push({ x: R() * W, y: R() * horizon * 0.85, r: unit * (0.0008 + R() * R() * 0.003), a: 0.3 + R() * 0.7, k: 1 + Math.floor(R() * 3), ph: R() });
  }

  // --- clouds
  sc.clouds = [];
  const cloudCount = Math.round(2 + s.cloud * 13 + (s.rain > 0 ? 3 : 0));
  for (let i = 0; i < cloudCount; i++) {
    const depth = R(); // 0 far .. 1 near
    const cw = W * (0.14 + depth * 0.28 + s.cloud * 0.12);
    const ch = cw * (0.32 + R() * 0.16);
    const sprite = makeCloud(R, cw, ch, pal, s, depth);
    const windAmp = W * 0.006 * (1 + Math.min(s.wind, 60) / 12) * (0.5 + depth);
    sc.clouds.push({
      sprite, depth,
      x: R() * (W + cw) - cw * 0.6,
      y: horizon * (0.05 + (1 - depth) * 0.25 + R() * 0.35) - ch * 0.6,
      amp: windAmp, ph: R(), bob: unit * 0.004 * R(),
    });
  }
  sc.clouds.sort((a, b) => a.depth - b.depth);

  // wind direction: meteorological "from" -> screen x-direction of travel (east = right)
  sc.windX = -Math.sin((s.windDir * Math.PI) / 180) || 1;

  // --- wind streaks
  sc.streaks = [];
  if (s.wind > 12) {
    const n = Math.round(Math.min(s.wind, 70) / 5);
    for (let i = 0; i < n; i++) sc.streaks.push({ y: R() * horizon * 0.9, len: W * (0.08 + R() * 0.18), ph: R(), k: 1 + Math.floor(R() * 2), w: unit * (0.001 + R() * 0.0025), curve: (R() - 0.5) * unit * 0.03 });
  }

  // --- rain / snow
  sc.drops = [];
  if (s.rain > 0) {
    const n = Math.round(Math.min(900, 120 + s.rain * 110) * (W * H) / (1920 * 1080));
    for (let i = 0; i < n; i++) sc.drops.push({ x: R() * 1.4 - 0.2, y: R(), k: 2 + Math.floor(R() * 3), len: H * (0.02 + R() * 0.035), a: 0.15 + R() * 0.3, w: unit * (0.0008 + R() * 0.0012) });
  }
  sc.flakes = [];
  if (s.snow > 0) {
    const n = Math.round(Math.min(600, 150 + s.snow * 120) * (W * H) / (1920 * 1080));
    for (let i = 0; i < n; i++) sc.flakes.push({ x: R() * 1.2 - 0.1, y: R(), r: unit * (0.0015 + R() * 0.004), ph: R(), sway: unit * (0.005 + R() * 0.015), a: 0.5 + R() * 0.5 });
  }

  // --- lightning bolt
  if (s.thunder) {
    const pts = [];
    let x = W * (0.25 + R() * 0.5), y = horizon * 0.15;
    while (y < horizon * 0.95) { pts.push([x, y]); x += (R() - 0.5) * unit * 0.07; y += unit * (0.03 + R() * 0.05); }
    pts.push([x, horizon * 0.98]);
    sc.bolt = pts;
  }

  // --- fog banks
  sc.fogBands = s.fog ? [0, 1, 2, 3].map(() => ({ y: horizon * (0.55 + R() * 0.5), h: H * (0.1 + R() * 0.12), ph: R(), amp: W * 0.03 })) : [];

  // --- ink seal (used by ink style)
  sc.sealText = (place || 'sky').trim().slice(0, 2).toUpperCase();
  return sc;
}

function makeCloud(R, w, h, pal, s, depth) {
  const c = canvas(w * 1.25, h * 1.7);
  const g = c.getContext('2d');
  const cx = c.width / 2, base = c.height * 0.78;
  const n = 30 + Math.floor(R() * 26);
  const heavy = s.rain > 0 || s.thunder;
  const lit = mix(pal.lit, pal.shade, heavy ? 0.35 : 0);
  const shade = mix(pal.shade, [0, 0, 0], heavy ? 0.25 : 0);
  // Irregular translucent washes, layered: like glazing watercolour, not circles.
  const wash = (x, y, r, col, a) => {
    const k = 14, ph1 = R() * TAU, ph2 = R() * TAU;
    const pts = [];
    for (let j = 0; j < k; j++) {
      const t = (j / k) * TAU;
      const rr = r * (1 + 0.18 * Math.sin(3 * t + ph1) + 0.1 * Math.sin(5 * t + ph2) + (R() - 0.5) * 0.12);
      pts.push([x + Math.cos(t) * rr * 1.25, y + Math.sin(t) * rr * (Math.sin(t) > 0 ? 0.55 : 0.85)]);
    }
    g.beginPath();
    pts.forEach(([px, py], j) => {
      const [nx, ny] = pts[(j + 1) % k];
      j ? g.quadraticCurveTo(px, py, (px + nx) / 2, (py + ny) / 2) : g.moveTo((px + nx) / 2, (py + ny) / 2);
    });
    g.quadraticCurveTo(pts[0][0], pts[0][1], (pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2);
    g.closePath();
    g.fillStyle = rgba(col, a);
    g.fill();
    g.strokeStyle = rgba(mix(col, shade, 0.5), a * 0.6); // faint dried edge
    g.lineWidth = Math.max(1, r * 0.025);
    g.stroke();
  };
  for (let i = 0; i < n * 2; i++) {
    const u = R() * 2 - 1;
    const r = h * (0.14 + R() * 0.26) * (1 - 0.5 * Math.abs(u));
    const x = cx + u * w * 0.42;
    const y = base - r * 0.4 - (1 - u * u) * h * (0.1 + R() * 0.45);
    const t = clamp((base - y) / (h * 0.85));
    const col = mix(shade, lit, Math.pow(t, 0.7));
    wash(x, y, r, col, (0.05 + R() * 0.08) * (0.6 + depth * 0.4));
  }
  // a soft shadow wash along the base
  for (let i = 0; i < 6; i++) wash(cx + (R() - 0.5) * w * 0.6, base - h * 0.08, h * (0.2 + R() * 0.12), shade, 0.05);
  return c;
}

// ---------------------------------------------------------------- drawing

function drawSun(ctx, sc, p) {
  const { s, sun, pal } = sc;
  if (s.elev < -0.12) return;
  const vis = clamp(1 - s.cloud * (s.rain > 0 || s.thunder ? 0.97 : 0.75)) * clamp((s.elev + 0.12) / 0.12);
  const pulse = 1 + 0.04 * Math.sin(TAU * p);
  const glowCol = mix([255, 240, 200], [255, 170, 110], pal.warm);
  const gr = ctx.createRadialGradient(sun.x, sun.y, 0, sun.x, sun.y, sun.r * 7 * pulse);
  gr.addColorStop(0, rgba(glowCol, 0.7 * vis));
  gr.addColorStop(0.3, rgba(glowCol, 0.28 * vis));
  gr.addColorStop(1, rgba(glowCol, 0));
  ctx.fillStyle = gr;
  ctx.fillRect(sun.x - sun.r * 8, sun.y - sun.r * 8, sun.r * 16, sun.r * 16);
  if (s.elev < 0) return;
  const disc = mix([255, 236, 186], [255, 186, 110], pal.warm);
  ctx.fillStyle = rgba(disc, 0.92 * vis);
  ctx.beginPath(); ctx.arc(sun.x, sun.y, sun.r, 0, TAU); ctx.fill();
  ctx.strokeStyle = rgba(mix(disc, [230, 120, 60], 0.4), 0.35 * vis);
  ctx.lineWidth = sun.r * 0.08;
  ctx.stroke();
}

function drawMoon(ctx, sc, p) {
  const { s, moon } = sc;
  if (s.elev > -0.05) return;
  const vis = clamp(1 - s.cloud * 0.8) * clamp((-s.elev - 0.05) / 0.1);
  if (vis <= 0.01) return;
  const { x, y, r } = moon;
  const gl = ctx.createRadialGradient(x, y, 0, x, y, r * 5);
  gl.addColorStop(0, `rgba(220,226,255,${0.25 * vis})`);
  gl.addColorStop(1, 'rgba(220,226,255,0)');
  ctx.fillStyle = gl;
  ctx.fillRect(x - r * 5, y - r * 5, r * 10, r * 10);
  // phase: draw lit disc, then shadow disc offset
  const ph = s.moon;
  ctx.save();
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.clip();
  ctx.fillStyle = `rgba(246,240,220,${0.95 * vis})`;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
  // shadow disc slides off to the left while waxing, back in from the right while waning
  const dx = ph < 0.5 ? -4 * r * ph : 4 * r * (1 - ph);
  ctx.fillStyle = `rgba(20,24,52,${0.85 * vis})`;
  ctx.beginPath(); ctx.arc(x + dx, y, r * 1.02, 0, TAU); ctx.fill();
  ctx.restore();
}

function drawStars(ctx, sc, p) {
  for (const st of sc.stars) {
    const tw = 0.55 + 0.45 * Math.sin(TAU * (p * st.k + st.ph));
    ctx.fillStyle = `rgba(255,250,235,${st.a * tw})`;
    ctx.beginPath(); ctx.arc(st.x, st.y, st.r, 0, TAU); ctx.fill();
  }
}

function drawClouds(ctx, sc, p) {
  for (const c of sc.clouds) {
    const x = c.x + sc.windX * c.amp * Math.sin(TAU * (p + c.ph));
    const y = c.y + c.bob * Math.sin(TAU * (p * 2 + c.ph));
    ctx.drawImage(c.sprite, x, y);
  }
}

function drawStreaks(ctx, sc, p) {
  const { W, pal } = sc;
  ctx.lineCap = 'round';
  for (const st of sc.streaks) {
    const u = ((st.ph + p * st.k) % 1);
    const pos = sc.windX > 0 ? u : 1 - u;
    const x = -st.len + pos * (W + st.len * 2);
    const a = Math.sin(Math.PI * u) * 0.22;
    ctx.strokeStyle = rgba(mix(pal.lit, [255, 255, 255], 0.5), a);
    ctx.lineWidth = st.w;
    ctx.beginPath();
    ctx.moveTo(x, st.y);
    ctx.quadraticCurveTo(x + st.len / 2, st.y + st.curve, x + st.len, st.y);
    ctx.stroke();
  }
}

function drawRain(ctx, sc, p) {
  const { W, H, s } = sc;
  const slant = sc.windX * clamp(s.wind / 50) * 0.35;
  ctx.lineCap = 'round';
  const col = sc.pal.night > 0.5 ? [170, 180, 220] : [210, 222, 240];
  for (const d of sc.drops) {
    const y = ((d.y + p * d.k) % 1) * (H + d.len) - d.len;
    const x = d.x * W + slant * y;
    ctx.strokeStyle = rgba(col, d.a);
    ctx.lineWidth = d.w;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + slant * d.len, y + d.len); ctx.stroke();
  }
}

function drawSnow(ctx, sc, p) {
  const { W, H, s } = sc;
  const slant = sc.windX * clamp(s.wind / 50) * 0.3;
  for (const f of sc.flakes) {
    const y = ((f.y + p) % 1) * (H + 20) - 10;
    const x = f.x * W + slant * y + f.sway * Math.sin(TAU * (p * 2 + f.ph));
    ctx.fillStyle = `rgba(255,255,255,${f.a})`;
    ctx.beginPath(); ctx.arc(x, y, f.r, 0, TAU); ctx.fill();
  }
}

function drawFog(ctx, sc, p) {
  const { W, pal } = sc;
  for (const b of sc.fogBands) {
    const dx = b.amp * Math.sin(TAU * (p + b.ph));
    const g = ctx.createLinearGradient(0, b.y - b.h, 0, b.y + b.h);
    const c = mix(pal.bottom, [235, 235, 240], 0.5);
    g.addColorStop(0, rgba(c, 0));
    g.addColorStop(0.5, rgba(c, 0.38));
    g.addColorStop(1, rgba(c, 0));
    ctx.fillStyle = g;
    ctx.fillRect(dx - W * 0.1, b.y - b.h, W * 1.2, b.h * 2);
  }
}

function drawLightning(ctx, sc, p) {
  // two flashes per loop
  const f = (p > 0.62 && p < 0.645) ? 1 : (p > 0.67 && p < 0.69) ? 0.6 : 0;
  if (!f) return;
  ctx.fillStyle = `rgba(235,235,255,${0.28 * f})`;
  ctx.fillRect(0, 0, sc.W, sc.H);
  ctx.strokeStyle = `rgba(255,255,255,${0.9 * f})`;
  ctx.lineWidth = Math.min(sc.W, sc.H) * 0.004;
  ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(190,200,255,0.9)';
  ctx.shadowBlur = 20;
  ctx.beginPath();
  sc.bolt.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.stroke();
  ctx.shadowBlur = 0;
}

function drawPaper(ctx, sc, strength = 0.32) {
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = strength;
  ctx.fillStyle = ctx.createPattern(sc.paperTile, 'repeat');
  ctx.fillRect(0, 0, sc.W, sc.H);
  ctx.restore();
}

function drawCaption(ctx, sc, caption, ink) {
  if (!caption) return;
  const { W, H } = sc;
  const u = Math.min(W, H);
  const x = W * 0.045, y = H * 0.9;
  ctx.save();
  ctx.fillStyle = ink ? 'rgba(248,240,224,0.95)' : 'rgba(255,250,240,0.92)';
  ctx.shadowColor = 'rgba(0,0,0,0.3)'; ctx.shadowBlur = u * 0.01;
  ctx.font = `italic ${Math.round(u * 0.05)}px Fraunces, "Iowan Old Style", Georgia, serif`;
  ctx.fillText(caption.title, x, y);
  ctx.font = `${Math.round(u * 0.021)}px Fraunces, "Iowan Old Style", Georgia, serif`;
  ctx.globalAlpha = 0.85;
  ctx.fillText(caption.sub, x + u * 0.003, y + u * 0.038);
  ctx.restore();
}

// Draws the plain watercolour scene.
function renderBase(ctx, sc, p) {
  ctx.drawImage(sc.sky, 0, 0);
  drawStars(ctx, sc, p);
  drawMoon(ctx, sc, p);
  drawSun(ctx, sc, p);
  drawClouds(ctx, sc, p);
  ctx.drawImage(sc.hills, 0, 0);
  if (sc.fogBands.length) drawFog(ctx, sc, p);
  drawStreaks(ctx, sc, p);
  if (sc.drops.length) drawRain(ctx, sc, p);
  if (sc.flakes.length) drawSnow(ctx, sc, p);
  if (sc.bolt) drawLightning(ctx, sc, p);
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => v / 16 - 0.5);

// Paint one frame at loop progress p (0..1) in the given style.
export function paint(ctx, sc, p, { style = 'watercolour', caption = null, grain = 1 } = {}) {
  const { W, H } = sc;
  if (style === 'watercolour') {
    renderBase(ctx, sc, p);
    if (grain) drawPaper(ctx, sc, 0.32 * grain);
    drawCaption(ctx, sc, caption, false);
    return;
  }

  sc.scratch ||= canvas(W, H);
  const sctx = sc.scratch.getContext('2d');
  renderBase(sctx, sc, p);

  if (style === 'pixel') {
    const px = Math.max(4, Math.round(Math.min(W, H) / 135));
    const tw = Math.ceil(W / px), th = Math.ceil(H / px);
    sc.tiny ||= canvas(tw, th);
    const t = sc.tiny.getContext('2d', { willReadFrequently: true });
    t.imageSmoothingEnabled = true;
    t.drawImage(sc.scratch, 0, 0, tw, th);
    const img = t.getImageData(0, 0, tw, th);
    const d = img.data, levels = 11, step = 255 / (levels - 1);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const i = (y * tw + x) * 4, b = BAYER[(y & 3) * 4 + (x & 3)] * step * 0.45;
      for (let c = 0; c < 3; c++) d[i + c] = Math.round(clamp((d[i + c] + b) / 255) * (levels - 1)) * step;
    }
    t.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(sc.tiny, 0, 0, tw * px, th * px);
    ctx.imageSmoothingEnabled = true;
    if (caption) {
      ctx.save();
      const u = Math.min(W, H);
      ctx.font = `bold ${Math.round(u * 0.04)}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
      ctx.fillStyle = '#fff8e8';
      ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowOffsetX = ctx.shadowOffsetY = Math.max(2, px / 2);
      ctx.fillText(caption.title.toUpperCase(), W * 0.045, H * 0.9);
      ctx.font = `${Math.round(u * 0.02)}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
      ctx.fillText(caption.sub, W * 0.047, H * 0.9 + u * 0.035);
      ctx.restore();
    }
    return;
  }

  // ink (sumi-e)
  if ('filter' in ctx) {
    ctx.filter = 'grayscale(1) brightness(1.32) contrast(1.15)';
    ctx.drawImage(sc.scratch, 0, 0);
    ctx.filter = 'none';
  } else {
    const img = sctx.getImageData(0, 0, W, H), d = img.data;
    for (let i = 0; i < d.length; i += 4) { const l = clamp(((0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]) * 1.32 - 128) * 1.15 + 128, 0, 255); d[i] = d[i + 1] = d[i + 2] = l; }
    ctx.putImageData(img, 0, 0);
  }
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = 'rgb(244,234,214)';
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
  if (grain) drawPaper(ctx, sc, 0.45 * grain);
  // red sun, or a pale moon, as the one spot of colour
  const { s, sun } = sc;
  if (s.elev > -0.05) {
    const vis = clamp(1 - s.cloud * 0.55);
    ctx.fillStyle = `rgba(196,48,38,${0.85 * vis})`;
    ctx.beginPath(); ctx.arc(sun.x, sun.y, sun.r * 1.15, 0, TAU); ctx.fill();
  }
  // artist's seal
  const u = Math.min(W, H), sz = u * 0.055, sx = W - W * 0.045 - sz, sy = H * 0.86;
  ctx.fillStyle = 'rgba(180,40,34,0.88)';
  ctx.fillRect(sx, sy, sz, sz);
  ctx.fillStyle = 'rgb(244,234,214)';
  ctx.font = `bold ${Math.round(sz * 0.42)}px Georgia, serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(sc.sealText, sx + sz / 2, sy + sz / 2 + sz * 0.03);
  ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
  drawCaption(ctx, sc, caption, true);
}
