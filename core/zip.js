/** zip.js — Minimal dependency-free ZIP writer/reader used for .docx/.xlsx.
 *
 * Word and Excel documents are ZIP archives. Office files accept ordinary
 * entry compression (method 8 = deflate), so we hand-roll the ZIP framing and
 * DEFLATE each member with the platform-native Compression Streams API
 * (Chromium/Firefox/Safari + Node 22+ all ship CompressionStream). Node falls
 * back to node:zlib. */

const NODE = typeof process !== 'undefined' && !!process.versions?.node;

// CRC-32 (IEEE 802.3), the polynomial ZIP requires.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function concatBytes(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// Push `bytes` through a (De)CompressionStream and collect the output.
// pipeThrough handles pull/backpressure internally; a bare write-then-read loop
// deadlocks on DecompressionStream (nobody is pulling the readable side).
async function streamThrough(stream, bytes) {
  const out = await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer();
  return new Uint8Array(out);
}

// Raw DEFLATE (what ZIP method 8 stores). CompressionStream 'deflate' is the
// zlib wrapper (2-byte header + 4-byte adler32 tail), so strip both ends.
async function deflateRaw(bytes) {
  if (typeof CompressionStream !== 'undefined') {
    const z = await streamThrough(new CompressionStream('deflate'), bytes);
    return z.subarray(2, Math.max(2, z.length - 4));
  }
  const zlib = await import('node:zlib');
  return new Uint8Array(zlib.deflateRawSync(Buffer.from(bytes)));
}

function adler32(bytes) {
  let a = 1;
  let b = 0;
  const MOD = 65521;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

// Wrap a raw deflate stream in a zlib header + adler32 footer so a plain
// 'deflate' decompressor can open it (browser fallback).
function wrapZlib(bytes) {
  const footer = new Uint8Array(4);
  new DataView(footer.buffer).setUint32(0, adler32(bytes), false);
  return concatBytes([new Uint8Array([0x78, 0x9c]), bytes, footer]);
}

async function inflateRaw(bytes) {
  if (NODE) {
    const zlib = await import('node:zlib');
    return new Uint8Array(zlib.inflateRawSync(Buffer.from(bytes)));
  }
  if (typeof DecompressionStream !== 'undefined') {
    let stream;
    try {
      stream = new DecompressionStream('deflate-raw');
    } catch (_) {
      stream = new DecompressionStream('deflate');
      bytes = wrapZlib(bytes);
    }
    return streamThrough(stream, bytes);
  }
  throw new Error('No inflate support available');
}

function dosStamp(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >>> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** Build a ZIP archive. entries: [{ name, data: string|Uint8Array }] */
export async function zipBytes(entries) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  const { time, date } = dosStamp();
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const data = entry.data instanceof Uint8Array ? entry.data : enc.encode(String(entry.data));
    const comp = await deflateRaw(data);
    const crc = crc32(data);

    const lh = new DataView(new Uint8Array(30).buffer);
    lh.setUint32(0, 0x04034B50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0, true);
    lh.setUint16(8, 8, true);
    lh.setUint16(10, time, true);
    lh.setUint16(12, date, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, comp.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, 0, true);

    parts.push(new Uint8Array(lh.buffer), nameBytes, comp);

    const cd = new DataView(new Uint8Array(46).buffer);
    cd.setUint32(0, 0x02014B50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(10, 8, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, comp.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, offset, true);

    central.push(new Uint8Array(cd.buffer), nameBytes);
    offset += 30 + nameBytes.length + comp.length;
  }

  const cdBytes = concatBytes(central);
  const eocd = new DataView(new Uint8Array(22).buffer);
  eocd.setUint32(0, 0x06054B50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdBytes.length, true);
  eocd.setUint32(16, offset, true);

  return concatBytes([...parts, cdBytes, new Uint8Array(eocd.buffer)]);
}

/** Read a zipBytes-produced archive back into named members (tests/re-reading). */
export async function inspectZip(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
    else throw new Error('inspectZip expects a Uint8Array');
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  let p = 0;
  while (p + 30 <= bytes.length && dv.getUint32(p, true) === 0x04034B50) {
    const method = dv.getUint16(p + 8, true);
    const compSize = dv.getUint32(p + 18, true);
    const nameLen = dv.getUint16(p + 26, true);
    const extraLen = dv.getUint16(p + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 30, p + 30 + nameLen));
    const comp = bytes.subarray(p + 30 + nameLen + extraLen, p + 30 + nameLen + extraLen + compSize);
    const data = method === 0 ? comp : await inflateRaw(comp);
    out.push({ name, data });
    p += 30 + nameLen + extraLen + compSize;
  }
  return out;
}