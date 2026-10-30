// GPU version of the water-based paint simulation (see paint-sim.js for the model).
// Runs each step as a full-screen pass over float textures, so a whole day of
// layers paints in well under a second on most machines.

import { MEDIA } from './paint-sim.js';

const VERT = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const HEAD = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D s0; // W, M, D, paper height
uniform sampler2D s1; // pigment colour (mass-weighted), kx
uniform sampler2D s2; // deposited colour (mass-weighted), ky
const float EPS = 0.002;
`;

const OUT3 = `
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
`;

const STEP = HEAD + OUT3 + `
uniform float flow, slope, front, runAt, grav, mob, evap, edgeEvap, dep, gran, pin, fur;

// per-cell wicking threshold (same hash as cellRand in paint-sim.js)
float fz(ivec2 q) {
  uint h = uint(q.x) * 374761393u + uint(q.y) * 668265263u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  h ^= h >> 16u;
  return max(0.15, 1.0 + fur * (float(h & 0xffffu) / 65535.0 - 0.5) * 2.0);
}
uniform vec2 wind;
ivec2 sz;

bool inside(ivec2 p) { return p.x >= 0 && p.y >= 0 && p.x < sz.x && p.y < sz.y; }

// Flow from a to b. Vertical edges have a above b, so gravity pushes a -> b.
float flux(vec4 a0, float ka, bool chA, float fa, vec4 b0, float kb, bool chB, float fb, bool vert) {
  float wa = a0.x, wb = b0.x;
  if (wa <= EPS && wb <= EPS) return 0.0;
  float f = flow * (ka + kb) * 0.5 * ((wa + slope * a0.w) - (wb + slope * b0.w));
  if (wb <= EPS && f > 0.0) {
    // downhill into dry paper water only leaks out through drip channels
    if (vert && chB && wa > runAt * 0.25) f = f;
    else f = wa > front * max(0.6, 2.0 - kb) * fb ? f * 0.3 * kb : 0.0;
  } else if (wa <= EPS && f < 0.0) {
    f = wb > front * max(0.6, 2.0 - ka) * fa ? f * 0.3 * ka : 0.0;
  }
  if (vert) {
    float gth = chA ? runAt * 0.15 : runAt * 0.5;
    if (wa > gth && (wb > EPS || (wa > runAt * 0.25 && chB))) f += grav * (wa - gth) * 4.0;
  }
  if (wa > EPS && wb > EPS) f += (vert ? wind.y : wind.x) * min(wa, wb);
  return clamp(f, -wb * 0.24, wa * 0.24);
}

// Fraction of the source's pigment carried along with f.
float carry(float f, float wsrc, float wdst) {
  if (wsrc <= 0.0) return 0.0;
  return min(1.0, abs(f) / wsrc) * mob * (wdst <= EPS ? 0.35 : 1.0);
}

void main() {
  sz = textureSize(s0, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c0 = texelFetch(s0, p, 0), c1 = texelFetch(s1, p, 0), c2 = texelFetch(s2, p, 0);
  float W = c0.x, M = c0.y, D = c0.z, H = c0.w;
  vec3 P = c1.xyz, DC = c2.xyz;
  float kx = c1.w, kyv = c2.w;
  bool ch = kyv > 5.0;
  float ky = ch ? kyv - 10.0 : kyv;

  float nW = W, nM = M; vec3 nP = P;
  int dry = 0; float supply = 0.0;

  ivec2 offs[4] = ivec2[4](ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1));
  for (int k = 0; k < 4; k++) {
    ivec2 q = p + offs[k];
    if (!inside(q)) { dry++; continue; }
    vec4 n0 = texelFetch(s0, q, 0), n1 = texelFetch(s1, q, 0), n2 = texelFetch(s2, q, 0);
    if (n0.x <= EPS) dry++;
    supply = max(supply, n0.x);
    bool vert = k >= 2;
    bool nch = n2.w > 5.0;
    float kn = vert ? (nch ? n2.w - 10.0 : n2.w) : n1.w, ks = vert ? ky : kx;
    // canonical edge direction is right / down
    bool selfFirst = (k == 0 || k == 2);
    float fs = fz(p), fn = fz(q);
    float f = selfFirst ? flux(c0, ks, ch, fs, n0, kn, nch, fn, vert) : flux(n0, kn, nch, fn, c0, ks, ch, fs, vert);
    // positive out = water leaving this cell
    float out_ = selfFirst ? f : -f;
    if (out_ > 0.0) {
      float fr = carry(out_, W, n0.x);
      nW -= out_; nM -= M * fr; nP -= P * fr;
    } else if (out_ < 0.0) {
      float fr = carry(out_, n0.x, W);
      nW -= out_; nM += n0.y * fr; nP += n1.xyz * fr;
    }
  }

  if (nW > 0.0) {
    nW -= evap * (1.0 + edgeEvap * float(dry) * 0.25);
    if (dry > 0 && nW < pin && supply > pin * 1.6) nW = pin;
  }
  float settle = nW <= EPS ? 1.0 : clamp(dep + gran * (1.0 - H), 0.0, 1.0);
  if (nW <= EPS) nW = 0.0;
  nM = max(nM, 0.0); nP = max(nP, vec3(0.0));
  float m = nM * settle; vec3 pc = nP * settle;
  o0 = vec4(nW, nM - m, D + m, H);
  o1 = vec4(nP - pc, kx);
  o2 = vec4(DC + pc, kyv);
}`;

// Water lifts some dried paint back into suspension (shared by ADD and REWET).
const LIFT_FN = `
uniform sampler2D tC;
uniform vec3 paperCol;
uniform float redissolve, absorb;
vec3 liftOf(vec3 C, float w) {
  float f = min(1.0, w) * redissolve;
  return -log(max(C / paperCol, vec3(0.02))) * f;
}`;

const ADD = HEAD + OUT3 + LIFT_FN + `
uniform sampler2D tw, tm, tc;
uniform float waterScale, massScale;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c0 = texelFetch(s0, p, 0), c1 = texelFetch(s1, p, 0), c2 = texelFetch(s2, p, 0);
  float w = texelFetch(tw, p, 0).a * waterScale;
  float m = texelFetch(tm, p, 0).a * massScale;
  vec3 col = texelFetch(tc, p, 0).rgb;
  vec3 P = c1.xyz + col * m;
  float M = c0.y + m;
  if (w > 0.0 && redissolve > 0.0) {
    vec3 l = liftOf(texelFetch(tC, p, 0).rgb, w);
    float lm = (l.x + l.y + l.z) / 3.0 / absorb;
    if (lm > 1e-4) { M += lm; P += lm * exp(-l / (lm * absorb)); }
  }
  o0 = vec4(c0.x + w, M, c0.z, c0.w);
  o1 = vec4(P, c1.w);
  o2 = c2;
}`;

const REWET = `#version 300 es
precision highp float;
precision highp sampler2D;
` + LIFT_FN + `
uniform sampler2D tw;
uniform float waterScale;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 C = texelFetch(tC, p, 0).rgb;
  float w = texelFetch(tw, p, 0).a * waterScale;
  if (w > 0.0 && redissolve > 0.0) {
    vec3 l = liftOf(C, w);
    if ((l.x + l.y + l.z) / 3.0 / absorb > 1e-4) C = min(paperCol, C * exp(l));
  }
  o = vec4(C, 1.0);
}`;

const LIFT = HEAD + OUT3 + `
uniform sampler2D tmask;
uniform float amount;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c0 = texelFetch(s0, p, 0), c1 = texelFetch(s1, p, 0), c2 = texelFetch(s2, p, 0);
  float k = texelFetch(tmask, p, 0).a * amount;
  o0 = vec4(c0.x * (1.0 - k * 0.5), c0.y * (1.0 - k), c0.z, c0.w);
  o1 = vec4(c1.xyz * (1.0 - k), c1.w);
  o2 = c2;
}`;

// Dry everything and glaze the layer onto the canvas colour.
const GLAZE = HEAD + `
uniform sampler2D tC;
uniform float absorb, hide;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c0 = texelFetch(s0, p, 0), c1 = texelFetch(s1, p, 0), c2 = texelFetch(s2, p, 0);
  vec3 C = texelFetch(tC, p, 0).rgb;
  float raw = c0.y + c0.z;
  if (raw > 1e-5) {
    vec3 col = (c1.xyz + c2.xyz) / raw;
    float m = raw / (1.0 + raw * 0.8);
    C *= exp(-m * absorb * -log(max(col, vec3(0.03))));
    if (hide > 0.0) C = mix(C, col, 1.0 - exp(-m * hide));
  }
  o = vec4(C, 1.0);
}`;

// Reset the wet layer, keeping the paper.
const CLEAR = HEAD + OUT3 + `
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  o0 = vec4(0.0, 0.0, 0.0, texelFetch(s0, p, 0).w);
  o1 = vec4(0.0, 0.0, 0.0, texelFetch(s1, p, 0).w);
  o2 = vec4(0.0, 0.0, 0.0, texelFetch(s2, p, 0).w);
}`;

// Operations on the dried canvas: dry brush, scrubbing out, opaque dabs.
const CANVAS_OP = HEAD + `
uniform sampler2D tC, tmask;
uniform int mode; // 0 dry brush, 1 lift towards paper, 2 opaque dab
uniform vec3 colour, paperCol;
uniform float amount, absorb;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 C = texelFetch(tC, p, 0).rgb;
  vec4 mk = texelFetch(tmask, p, 0);
  float H = texelFetch(s0, p, 0).w;
  if (mode == 0) {
    float load = mk.a;
    float c = max(0.0, H - (1.0 - load) * 0.9 - 0.25) * amount;
    C *= exp(-c * absorb * -log(max(colour, vec3(0.03))));
  } else if (mode == 1) {
    C = mix(C, paperCol, mk.a * amount);
  } else {
    C = mix(C, mk.rgb, mk.a * amount * (0.6 + H * 0.6));
  }
  o = vec4(C, 1.0);
}`;

const SHOW = `#version 300 es
precision highp float;
uniform sampler2D tC;
out vec4 o;
void main() {
  ivec2 sz = textureSize(tC, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  o = vec4(clamp(texelFetch(tC, ivec2(p.x, sz.y - 1 - p.y), 0).rgb, 0.0, 1.0), 1.0);
}`;

function compile(gl, src, type) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

function program(gl, frag) {
  const pr = gl.createProgram();
  gl.attachShader(pr, compile(gl, VERT, gl.VERTEX_SHADER));
  gl.attachShader(pr, compile(gl, frag, gl.FRAGMENT_SHADER));
  gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
  const u = {};
  const n = gl.getProgramParameter(pr, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(pr, i); u[info.name] = gl.getUniformLocation(pr, info.name); }
  return { pr, u };
}

export function gpuAvailable() {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    return !!(gl && gl.getExtension('EXT_color_buffer_float'));
  } catch { return false; }
}

export class GpuWetSim {
  constructor(paper, medium, paperColour) {
    const { w, h } = paper;
    this.w = w; this.h = h; this.paper = paper;
    this.p = MEDIA[medium] || MEDIA.watercolour;
    this.paperColour = paperColour.map((v) => v / 255);
    this.wind = [0, 0];
    this.gravity = this.p.gravity;

    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false, premultipliedAlpha: false });
    if (!gl || !gl.getExtension('EXT_color_buffer_float')) throw new Error('WebGL2 float buffers not available');
    this.canvas = canvas; this.gl = gl;
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    this.progs = {
      step: program(gl, STEP), add: program(gl, ADD), lift: program(gl, LIFT),
      glaze: program(gl, GLAZE), rewet: program(gl, REWET), clear: program(gl, CLEAR), op: program(gl, CANVAS_OP), show: program(gl, SHOW),
    };
    this.vao = gl.createVertexArray();

    const N = w * h;
    const d0 = new Float32Array(N * 4), d1 = new Float32Array(N * 4), d2 = new Float32Array(N * 4), dc = new Float32Array(N * 4);
    const f = this.p.fibre;
    for (let i = 0; i < N; i++) {
      d0[i * 4 + 3] = paper.H[i];
      d1[i * 4 + 3] = Math.max(0.05, 1 + f * (paper.nx[i] - 0.5) * 2.4);
      d2[i * 4 + 3] = Math.max(0.05, 1 + f * (paper.ny[i] - 0.5) * 2.4) + (paper.chan && paper.chan[i] ? 10 : 0);
      dc[i * 4] = this.paperColour[0]; dc[i * 4 + 1] = this.paperColour[1]; dc[i * 4 + 2] = this.paperColour[2]; dc[i * 4 + 3] = 1;
    }
    this.state = [this._stateSet([d0, d1, d2]), this._stateSet([d0, d1, d2])];
    this.cur = 0;
    this.C = [this._fbo1(dc), this._fbo1(dc)];
    this.cC = 0;
    this.markTex = [0, 1, 2, 3].map(() => this._tex8());
  }

  _texF(data) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, this.w, this.h, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  _tex8() {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return t;
  }

  _stateSet(datas) {
    const gl = this.gl;
    const tex = datas.map((d) => this._texF(d));
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    tex.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
    return { tex, fb };
  }

  _fbo1(data) {
    const gl = this.gl;
    const tex = this._texF(data);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fb };
  }

  _upload(t, source) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }

  // Run a pass that reads the current state (+ extra textures) and writes `target`.
  _pass(prog, target, extra = {}, uniforms = {}) {
    const gl = this.gl;
    const { pr, u } = prog;
    gl.useProgram(pr);
    gl.bindVertexArray(this.vao);
    gl.viewport(0, 0, this.w, this.h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    const st = this.state[this.cur];
    const bind = { s0: st.tex[0], s1: st.tex[1], s2: st.tex[2], ...extra };
    let unit = 0;
    for (const [name, tex] of Object.entries(bind)) {
      if (!u[name]) continue;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(u[name], unit++);
    }
    for (const [name, v] of Object.entries(uniforms)) {
      if (!u[name]) continue;
      if (Array.isArray(v)) (v.length === 2 ? gl.uniform2fv : gl.uniform3fv).call(gl, u[name], v);
      else if (name === 'mode') gl.uniform1i(u[name], v);
      else gl.uniform1f(u[name], v);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  _swap(prog, extra, uniforms) {
    this._pass(prog, this.state[1 - this.cur].fb, extra, uniforms);
    this.cur = 1 - this.cur;
  }

  addMarks(water, mass, colour, waterScale = 2, massScale = 1.5) {
    const [tw, tm, tc] = this.markTex;
    this._upload(tw, water); this._upload(tm, mass); this._upload(tc, colour);
    const rw = { waterScale, massScale, redissolve: this.p.redissolve || 0, absorb: this.p.absorb, paperCol: this.paperColour };
    this._swap(this.progs.add, { tw, tm, tc, tC: this.C[this.cC].tex }, rw);
    if (rw.redissolve > 0) {
      const next = 1 - this.cC;
      this._pass(this.progs.rewet, this.C[next].fb, { tw, tC: this.C[this.cC].tex }, rw);
      this.cC = next;
    }
  }

  lift(mask, amount) {
    const t = this.markTex[3];
    this._upload(t, mask);
    this._swap(this.progs.lift, { tmask: t }, { amount });
  }

  run(steps) {
    const p = this.p;
    const uni = {
      flow: p.flow, slope: p.slope * 0.05, front: p.wetFront, runAt: p.runAt, grav: this.gravity, mob: p.mobility,
      evap: p.evap, edgeEvap: p.edgeEvap, dep: p.deposit, gran: p.granulate, pin: p.pin ?? 0, fur: p.fur ?? 0, wind: this.wind,
    };
    for (let s = 0; s < steps; s++) this._swap(this.progs.step, {}, uni);
  }

  finishLayer(steps = 110) {
    this.run(steps);
    const next = 1 - this.cC;
    this._pass(this.progs.glaze, this.C[next].fb, { tC: this.C[this.cC].tex }, { absorb: this.p.absorb, hide: this.p.hide });
    this.cC = next;
    this._swap(this.progs.clear);
  }

  _canvasOp(mask, mode, uniforms) {
    const t = this.markTex[3];
    this._upload(t, mask);
    const next = 1 - this.cC;
    this._pass(this.progs.op, this.C[next].fb, { tC: this.C[this.cC].tex, tmask: t }, { mode, absorb: this.p.absorb, paperCol: this.paperColour, colour: [0, 0, 0], ...uniforms });
    this.cC = next;
  }

  dryBrushMask(mask, colour, amount) { this._canvasOp(mask, 0, { colour: colour.map((v) => v / 255), amount }); }
  liftDryMask(mask, amount) { this._canvasOp(mask, 1, { amount }); }
  dabMask(mask, opacity) { this._canvasOp(mask, 2, { amount: opacity }); }

  // Draw the canvas colour into a 2D context.
  drawTo(ctx, W, H) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const { pr, u } = this.progs.show;
    gl.useProgram(pr);
    gl.viewport(0, 0, this.w, this.h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.C[this.cC].tex);
    gl.uniform1i(u.tC, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.canvas, 0, 0, W, H);
  }

  dispose() {
    const ext = this.gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
  }
}
