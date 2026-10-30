// Loop exporters: animated GIF (gifenc) and animated WebP (browser-encoded frames, muxed here).
import { GIFEncoder, quantize, applyPalette } from '../vendor/gifenc.esm.js';

const nextTick = () => new Promise((r) => setTimeout(r, 0));

export async function exportGif({ width, height, fps, seconds, draw, onProgress, signal }) {
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const gif = GIFEncoder();
  const frames = Math.round(fps * seconds);
  // One shared palette (sampled from a few frames) keeps colours steady and the file smaller.
  const sample = [];
  for (const f of [0, 0.33, 0.66]) {
    draw(ctx, f);
    sample.push(ctx.getImageData(0, 0, width, height).data.filter((_, i) => (i >> 2) % 3 === 0));
  }
  const merged = new Uint8ClampedArray(sample.reduce((s, a) => s + a.length, 0));
  sample.reduce((o, a) => (merged.set(a, o), o + a.length), 0);
  const palette = quantize(merged, 256, { format: 'rgb565' });
  for (let i = 0; i < frames; i++) {
    if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
    draw(ctx, i / frames);
    const { data } = ctx.getImageData(0, 0, width, height);
    const index = applyPalette(data, palette, 'rgb565');
    gif.writeFrame(index, width, height, i === 0 ? { palette, delay: Math.round(1000 / fps), repeat: 0 } : { delay: Math.round(1000 / fps) });
    onProgress?.((i + 1) / frames);
    await nextTick();
  }
  gif.finish();
  return new Blob([gif.bytes()], { type: 'image/gif' });
}

export function webpSupported() {
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  return c.toDataURL('image/webp').startsWith('data:image/webp');
}

function toBlob(canvas, type, q) {
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), type, q));
}

const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const u32 = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);

function chunk(type, data) {
  const pad = data.length & 1;
  const out = new Uint8Array(8 + data.length + pad);
  for (let i = 0; i < 4; i++) out[i] = type.charCodeAt(i);
  new DataView(out.buffer).setUint32(4, data.length, true);
  out.set(data, 8);
  return out;
}

function u24(arr, o, v) { arr[o] = v & 255; arr[o + 1] = (v >> 8) & 255; arr[o + 2] = (v >> 16) & 255; }

function concat(parts) {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Pull the image bitstream chunks (ALPH, VP8 , VP8L) out of a still WebP.
function frameChunks(bytes) {
  if (fourcc(bytes, 0) !== 'RIFF' || fourcc(bytes, 8) !== 'WEBP') throw new Error('not a webp');
  const out = [];
  let hasAlpha = false;
  for (let o = 12; o + 8 <= bytes.length;) {
    const type = fourcc(bytes, o), size = u32(bytes, o + 4);
    if (type === 'ALPH' || type === 'VP8 ' || type === 'VP8L') {
      out.push(bytes.subarray(o, o + 8 + size + (size & 1)));
      if (type === 'ALPH') hasAlpha = true;
    }
    o += 8 + size + (size & 1);
  }
  return { parts: out, hasAlpha };
}

export async function exportWebp({ width, height, fps, seconds, draw, onProgress, signal, quality = 0.88 }) {
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  const ctx = c.getContext('2d');
  const frames = Math.round(fps * seconds);
  const duration = Math.round(1000 / fps);
  const anmf = [];
  let anyAlpha = false;
  for (let i = 0; i < frames; i++) {
    if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
    draw(ctx, i / frames);
    const blob = await toBlob(c, 'image/webp', quality);
    if (blob.type !== 'image/webp') throw new Error('This browser cannot encode WebP. Try Chrome, Edge, Opera or Firefox.');
    const { parts, hasAlpha } = frameChunks(new Uint8Array(await blob.arrayBuffer()));
    anyAlpha ||= hasAlpha;
    const head = new Uint8Array(16);
    u24(head, 0, 0); u24(head, 3, 0);
    u24(head, 6, width - 1); u24(head, 9, height - 1);
    u24(head, 12, duration);
    head[15] = 0b10; // do not blend, do not dispose
    anmf.push(chunk('ANMF', concat([head, ...parts])));
    onProgress?.((i + 1) / frames);
  }
  const vp8x = new Uint8Array(10);
  vp8x[0] = 0x02 | (anyAlpha ? 0x10 : 0); // animation (+ alpha)
  u24(vp8x, 4, width - 1); u24(vp8x, 7, height - 1);
  const anim = new Uint8Array(6); // background colour 0, loop forever
  const body = concat([chunk('VP8X', vp8x), chunk('ANIM', anim), ...anmf]);
  const riff = new Uint8Array(12);
  riff.set([82, 73, 70, 70]);
  new DataView(riff.buffer).setUint32(4, body.length + 4, true);
  riff.set([87, 69, 66, 80], 8);
  return new Blob([riff, body], { type: 'image/webp' });
}

export async function exportPng({ width, height, draw, p = 0 }) {
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  draw(c.getContext('2d'), p);
  return toBlob(c, 'image/png');
}
