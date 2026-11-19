// Text <-> share code: gzip (CompressionStream) + base64url. Works in browsers and Node 18+.
// Code layout: "RC1." + base64url(gzip(utf8)). "RC0." marks an uncompressed payload (no CompressionStream).

const MAX_OUT = 192 * 1024 * 1024;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const hasCompression = () => typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

export function toBase64Url(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s) {
  const clean = String(s).replace(/[\s]/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (/[^A-Za-z0-9+/=]/.test(clean)) throw new Error('Share code contains invalid characters');
  const bin = atob(clean + '==='.slice((clean.length + 3) % 4));
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

async function pump(stream, limit) {
  const reader = stream.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) { await reader.cancel(); throw new Error('Share code expands beyond the size limit'); }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export async function gzipBytes(u8) {
  const stream = new Blob([u8]).stream().pipeThrough(new CompressionStream('gzip'));
  return pump(stream, Infinity);
}

export async function gunzipBytes(u8, limit = MAX_OUT) {
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
  return pump(stream, limit);
}

export async function compressText(text) {
  const raw = enc.encode(String(text));
  return hasCompression() ? gzipBytes(raw) : raw;
}

export async function decompressText(u8) {
  return dec.decode(await gunzipBytes(u8));
}

export async function encodeShareCode(text) {
  const raw = enc.encode(String(text));
  if (!hasCompression()) return 'RC0.' + toBase64Url(raw);
  return 'RC1.' + toBase64Url(await gzipBytes(raw));
}

export async function decodeShareCode(code) {
  const s = String(code || '').trim();
  const m = /^RC([01])\.([\s\S]+)$/.exec(s);
  if (!m) throw new Error('Not a REMAIN CALM share code');
  let bytes;
  try { bytes = fromBase64Url(m[2]); } catch (e) { throw new Error('Share code is damaged or incomplete'); }
  if (m[1] === '0') return dec.decode(bytes);
  if (!hasCompression()) throw new Error('This browser cannot unpack compressed share codes');
  try { return dec.decode(await gunzipBytes(bytes)); } catch (e) {
    if (/size limit/.test(e.message)) throw e;
    throw new Error('Share code is damaged or incomplete');
  }
}
