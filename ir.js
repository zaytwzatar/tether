// Turns TV codes into on/off timings (microseconds, starting with "on") for the tag's IR LED.
// Codes come from tvcodes.json, built from the Flipper-IRDB project
// (github.com/Lucaslhm/Flipper-IRDB). The address/command layouts follow
// Flipper's encoders so the same numbers produce the same signals.

export const TV_SLOTS = ['power', 'volUp', 'volDown', 'mute', 'chUp', 'chDown', 'input', 'home'];
export const TV_LABELS = ['Power', 'Volume +', 'Volume −', 'Mute', 'Channel +', 'Channel −', 'Input', 'Home'];
export const TV_MAX = 250;   // the tag stores up to 250 timings per button

let dbPromise = null;
export function loadTvCodes() {
  if (!dbPromise) dbPromise = fetch('tvcodes.json').then((r) => r.json()).catch((e) => { dbPromise = null; throw e; });
  return dbPromise;
}

// Bits of an array of bytes, least significant bit first
function bitsLsb(bytes, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push((bytes[i >> 3] >> (i & 7)) & 1);
  return out;
}
// Pulse distance: every bit is a fixed "on", then a short or long "off". Ends with an "on".
function pulseDistance(head, bits, mark, zero, one) {
  const t = [...head];
  for (const b of bits) t.push(mark, b ? one : zero);
  t.push(mark);
  return t;
}
// Manchester (RC5/RC6): list of [level, duration] halves -> merged on/off timings starting with "on"
function fromHalves(halves) {
  const t = []; let level = null;
  for (const [l, d] of halves) {
    if (!t.length && !l) continue;            // skip leading "off"
    if (l === level) t[t.length - 1] += d; else { t.push(d); level = l; }
  }
  if (t.length % 2 === 0) t.pop();             // end on an "on"
  return t;
}
const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
// repeat a frame (Sony needs 3), padding each to a fixed period
function repeatFrame(t, times, period) {
  const len = t.reduce((a, b) => a + b, 0);
  const out = [...t];
  for (let i = 1; i < times; i++) out.push(Math.max(2000, period - len), ...t);
  return out;
}

const ENCODERS = {
  NEC(a, c) {
    const b = [a & 0xff, ~a & 0xff, c & 0xff, ~c & 0xff];
    return { khz: 38, t: pulseDistance([9000, 4500], bitsLsb(b, 32), 560, 560, 1690) };
  },
  NECext(a, c) {
    const b = [a & 0xff, (a >> 8) & 0xff, c & 0xff, (c >> 8) & 0xff];
    return { khz: 38, t: pulseDistance([9000, 4500], bitsLsb(b, 32), 560, 560, 1690) };
  },
  Samsung32(a, c) {
    const b = [a & 0xff, a & 0xff, c & 0xff, ~c & 0xff];
    return { khz: 38, t: pulseDistance([4500, 4500], bitsLsb(b, 32), 550, 550, 1650) };
  },
  Kaseikyo(a, c) {
    const id = (a >>> 24) & 3, vendor = (a >>> 8) & 0xffff, g1 = (a >>> 4) & 0xf, g2 = a & 0xf;
    const d = [vendor & 0xff, vendor >> 8];
    let vp = d[0] ^ d[1]; vp = (vp & 0xf) ^ (vp >> 4);
    d[2] = (vp & 0xf) | (g1 << 4);
    d[3] = (g2 & 0xf) | ((c & 0xf) << 4);
    d[4] = ((id << 6) | (c >> 4)) & 0xff;
    d[5] = d[2] ^ d[3] ^ d[4];
    return { khz: 38, t: pulseDistance([3456, 1728], bitsLsb(d, 48), 432, 432, 1296) };
  },
  RCA(a, c) {
    const v = (a & 0xf) | ((c & 0xff) << 4) | ((~a & 0xf) << 12) | ((~c & 0xff) << 16);
    return { khz: 38, t: pulseDistance([4000, 4000], bitsLsb(u32(v), 24), 500, 1000, 2000) };
  },
  // Sony: the "on" length is the bit; 3 copies, 45 ms apart
  SIRC(a, c, addrBits = 5) {
    const v = (c & 0x7f) | ((a & ((1 << addrBits) - 1)) << 7);
    const bits = bitsLsb(u32(v), 7 + addrBits);
    const t = [2400];
    bits.forEach((b) => t.push(600, b ? 1200 : 600));
    return { khz: 40, t: repeatFrame(t, 3, 45000) };
  },
  SIRC15(a, c) { return ENCODERS.SIRC(a, c, 8); },
  SIRC20(a, c) { return ENCODERS.SIRC(a, c, 13); },
  // RC5: start bits, toggle, 5 address bits, 6 command bits, most significant first; "1" = off then on
  RC5(a, c, x = false) {
    const bits = [1, x ? 0 : 1, 0];
    for (let i = 4; i >= 0; i--) bits.push((a >> i) & 1);
    for (let i = 5; i >= 0; i--) bits.push((c >> i) & 1);
    const halves = [];
    for (const b of bits) halves.push(b ? [0, 889] : [1, 889], b ? [1, 889] : [0, 889]);
    return { khz: 36, t: fromHalves(halves) };
  },
  RC5X(a, c) { return ENCODERS.RC5(a, c, true); },
  // RC6 mode 0: leader, start bit, 3 mode bits, double-length toggle, 8 address, 8 command; "1" = on then off
  RC6(a, c) {
    const halves = [[1, 2666], [0, 889]];
    const bit = (b, w = 444) => halves.push(b ? [1, w] : [0, w], b ? [0, w] : [1, w]);
    bit(1); bit(0); bit(0); bit(0); bit(0, 889);
    for (let i = 7; i >= 0; i--) bit((a >> i) & 1);
    for (let i = 7; i >= 0; i--) bit((c >> i) & 1);
    return { khz: 36, t: fromHalves(halves) };
  },
};

// code: [protocolIndex, address, command] or ['raw', frequencyHz, timings]
export function encodeTv(code, protocols) {
  if (!code) return null;
  let out;
  if (code[0] === 'raw') {
    const t = code[2].slice(0, TV_MAX);
    if (t.length % 2 === 0) t.pop();
    out = { khz: Math.round(code[1] / 1000) || 38, t };
  } else {
    const enc = ENCODERS[protocols[code[0]]];
    if (!enc) return null;
    out = enc(code[1] >>> 0, code[2] >>> 0);
  }
  if (out.t.length < 5 || out.t.length > TV_MAX) return null;
  out.t = out.t.map((x) => Math.max(1, Math.min(65535, Math.round(x))));
  return out;
}

// Bytes for the tag's IR characteristic: [op, slot, kHz, timings as 16-bit little endian]
export function irPacket(op, slot, enc) {
  const b = new Uint8Array(3 + enc.t.length * 2);
  b[0] = op; b[1] = slot; b[2] = enc.khz;
  enc.t.forEach((x, i) => { b[3 + i * 2] = x & 0xff; b[4 + i * 2] = x >> 8; });
  return b;
}
