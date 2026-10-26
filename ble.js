// Tether: talking to the tag over Bluetooth (Web Bluetooth), plus a demo tag.
// The byte layouts here must match firmware/Tether/tether_main.cpp.

const uuid = (x) => `7a1e00${x}-5f3b-4c1e-9d4a-2b6c8e0f1a73`;
export const UUIDS = {
  service: uuid('01'),
  settings: uuid('02'),
  command: uuid('03'),
  status: uuid('04'),
  audio: uuid('05'),
  quiet: uuid('06'),
};

export const TONES = [
  { id: 0, name: 'Chime', note: 'Soft, three notes' },
  { id: 1, name: 'Beacon', note: 'Steady double beep' },
  { id: 2, name: 'Rising', note: 'Climbs in pitch' },
  { id: 3, name: 'Low hum', note: 'Lower pitch, easier for some to hear' },
  { id: 4, name: 'Melody', note: 'Short tune' },
  { id: 5, name: 'Siren', note: 'Loudest, for noisy places' },
  { id: 6, name: 'My recording', note: 'Your own sound, up to 5 seconds' },
];

export const STYLES = [
  { id: 0, name: 'Sound', note: 'Beeps out loud' },
  { id: 1, name: 'Vibrate', note: 'Buzz you can feel*' },
  { id: 2, name: 'Flash light', note: 'Blinks, no noise' },
  { id: 3, name: 'Vibrate + light', note: 'Silent but hard to miss*' },
  { id: 4, name: 'Everything', note: 'Sound, buzz and light' },
  { id: 5, name: 'Phone only', note: 'Tag stays silent' },
];

export const DEFAULT_SETTINGS = {
  threshold: -76, motionOnly: true, tone: 0, volume: 5, repeat: 3,
  interval: 15, style: 0, holdDnd: 60, quietMode: 0,
};
export const DEFAULT_QUIET = [
  { days: 0, start: 22 * 60, end: 7 * 60 },
  { days: 0, start: 9 * 60, end: 10 * 60 },
];

// Signal strength <-> approximate distance. Real distance depends on walls,
// pockets and the phone, which is why the walk test exists.
const RSSI_AT_1M = -55;
const PATH_LOSS = 2.2;
export function feetToRssi(feet) {
  const m = Math.max(feet, 1) * 0.3048;
  return Math.round(RSSI_AT_1M - 10 * PATH_LOSS * Math.log10(m));
}
export function rssiToFeet(rssi) {
  const m = Math.pow(10, (RSSI_AT_1M - rssi) / (10 * PATH_LOSS));
  return Math.round((m / 0.3048) / 5) * 5;
}

export function encodeSettings(s) {
  const b = new Uint8Array(12);
  b[0] = 1;
  b[1] = s.threshold & 0xff;
  b[2] = s.motionOnly ? 1 : 0;
  b[3] = s.tone; b[4] = s.volume; b[5] = s.repeat; b[6] = s.interval;
  b[7] = s.style; b[8] = s.holdDnd; b[9] = s.quietMode;
  return b;
}
export function decodeSettings(dv) {
  return {
    threshold: dv.getInt8(1), motionOnly: (dv.getUint8(2) & 1) === 1,
    tone: dv.getUint8(3), volume: dv.getUint8(4), repeat: dv.getUint8(5),
    interval: dv.getUint8(6), style: dv.getUint8(7), holdDnd: dv.getUint8(8),
    quietMode: dv.getUint8(9),
  };
}
export function encodeQuiet(slots) {
  const b = new DataView(new ArrayBuffer(10));
  slots.slice(0, 2).forEach((q, i) => {
    b.setUint8(i * 5, q.days);
    b.setUint16(i * 5 + 1, q.start, true);
    b.setUint16(i * 5 + 3, q.end, true);
  });
  return new Uint8Array(b.buffer);
}
export function decodeQuiet(dv) {
  return [0, 1].map((i) => ({
    days: dv.getUint8(i * 5), start: dv.getUint16(i * 5 + 1, true), end: dv.getUint16(i * 5 + 3, true),
  }));
}
export function decodeStatus(dv) {
  const flags = dv.getUint8(1);
  return {
    rssi: dv.getInt8(0),
    phoneConnected: !!(flags & 0x01), moving: !!(flags & 0x02), dnd: !!(flags & 0x04),
    alerting: !!(flags & 0x08), quiet: !!(flags & 0x10), calibrating: !!(flags & 0x20),
    hasRecording: !!(flags & 0x40), hasTime: !!(flags & 0x80),
    dndMinutes: dv.getUint16(2, true), threshold: dv.getInt8(4),
    event: dv.getUint8(5), eventCounter: dv.getUint8(6), firmware: dv.getUint8(7),
  };
}

export const CMD = { ring: 1, stop: 2, dnd: 3, flash: 4, calibrate: 5, time: 6, preview: 7, reset: 8 };

export function bluetoothSupport() {
  if (!('bluetooth' in navigator)) {
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    return { ok: false, reason: ios
      ? 'iPhone and iPad browsers can\'t use Bluetooth. The iPhone version will be a separate app.'
      : 'This browser can\'t use Bluetooth. Open the app in Chrome or Edge.' };
  }
  if (!window.isSecureContext) return { ok: false, reason: 'Bluetooth only works over https:// (or localhost).' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// A real tag
// ---------------------------------------------------------------------------
export class TagConnection extends EventTarget {
  constructor(device) {
    super();
    this.device = device;
    this.chars = {};
    this.queue = Promise.resolve();
    this.lastHeard = 0;        // when the tag last sent its once-a-second status
    this.ready = false;        // services found and status messages turned on
    this.connecting = null;
    this.onDisconnected = () => { this.ready = false; this.dispatchEvent(new Event('disconnected')); };
    device.addEventListener('gattserverdisconnected', this.onDisconnected);
    this.onStatus = (e) => {
      this.lastHeard = Date.now();
      this.dispatchEvent(new CustomEvent('status', { detail: decodeStatus(e.target.value) }));
    };
  }

  get id() { return this.device.id; }
  get name() { return this.device.name || 'Tether tag'; }
  // Bluetooth link is up AND the tag is actually talking to us
  get connected() { return !!this.device.gatt?.connected && this.ready; }
  get alive() { return this.connected && Date.now() - this.lastHeard < 8000; }

  static async pick() {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [UUIDS.service] }, { namePrefix: 'Tether' }],
      optionalServices: [UUIDS.service, 'device_information'],
    });
    return new TagConnection(device);
  }

  // Devices this site was allowed to use before (Chrome remembers them when supported)
  static async remembered() {
    if (!navigator.bluetooth?.getDevices) return [];
    try { return (await navigator.bluetooth.getDevices()).map((d) => new TagConnection(d)); } catch { return []; }
  }

  // Only one connection attempt at a time; every step has a time limit so
  // nothing can hang forever.
  connect() {
    if (!this.connecting) {
      this.connecting = this._connect().finally(() => { this.connecting = null; });
    }
    return this.connecting;
  }
  async _connect() {
    this.ready = false;
    this.queue = Promise.resolve();          // forget anything stuck from before
    try {
      const server = await withTimeout(this.device.gatt.connect(), 15000, 'connect');
      const svc = await withTimeout(server.getPrimaryService(UUIDS.service), 8000, 'services');
      for (const k of ['settings', 'command', 'status', 'audio', 'quiet']) {
        this.chars[k] = await withTimeout(svc.getCharacteristic(UUIDS[k]), 5000, 'characteristic');
      }
      this.chars.status.removeEventListener('characteristicvaluechanged', this.onStatus);
      this.chars.status.addEventListener('characteristicvaluechanged', this.onStatus);
      await withTimeout(this.chars.status.startNotifications(), 5000, 'notifications');
      this.lastHeard = Date.now();
      this.ready = true;
      await this.sendTime().catch(() => {});
    } catch (e) {
      try { this.device.gatt.disconnect(); } catch { /* ignore */ }
      throw e;
    }
  }

  disconnect() { this.ready = false; try { this.device.gatt.disconnect(); } catch { /* ignore */ } }

  // Resolves true when the tag is heard nearby, false if not heard in time,
  // or null if this browser can't listen for it (then just try connecting).
  async waitUntilNearby(ms) {
    if (!this.device.watchAdvertisements) { await sleep(ms); return null; }
    let done;
    const seen = new Promise((res) => { done = res; });
    const onAd = () => done(true);
    this.device.addEventListener('advertisementreceived', onAd);
    try {
      await this.device.watchAdvertisements();
    } catch {
      this.device.removeEventListener('advertisementreceived', onAd);
      await sleep(ms);
      return null;
    }
    const result = await Promise.race([seen, sleep(ms).then(() => false)]);
    this.device.removeEventListener('advertisementreceived', onAd);
    try { this.device.unwatchAdvertisements?.(); } catch { /* ignore */ }
    return result;
  }

  // Bluetooth can only do one thing at a time. Each step gets 6 seconds;
  // if it doesn't finish, it fails instead of blocking everything after it.
  run(fn) {
    const next = this.queue.catch(() => {}).then(() => withTimeout(fn(), 6000, 'bluetooth'));
    this.queue = next.catch(() => {});
    return next;
  }

  async readSettings() {
    return this.run(async () => ({
      settings: decodeSettings(await this.chars.settings.readValue()),
      quiet: decodeQuiet(await this.chars.quiet.readValue()),
    }));
  }
  async readStatus() { return this.run(async () => decodeStatus(await this.chars.status.readValue())); }
  async writeSettings(s) { return this.run(() => this.chars.settings.writeValueWithResponse(encodeSettings(s))); }
  async writeQuiet(q) { return this.run(() => this.chars.quiet.writeValueWithResponse(encodeQuiet(q))); }
  async command(...bytes) { return this.run(() => this.chars.command.writeValueWithResponse(new Uint8Array(bytes))); }

  async sendTime() {
    const now = new Date();
    const sec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    return this.command(CMD.time, now.getDay(), sec & 0xff, (sec >> 8) & 0xff, (sec >> 16) & 0xff, (sec >> 24) & 0xff);
  }

  // pcm: Uint8Array of 8-bit samples at `rate` samples per second
  async uploadClip(pcm, rate, onProgress) {
    const c = this.chars.audio;
    await this.run(() => c.writeValueWithResponse(new Uint8Array([1, pcm.length & 0xff, pcm.length >> 8, rate & 0xff, rate >> 8])));
    const CHUNK = 180;
    for (let i = 0; i < pcm.length; i += CHUNK) {
      const part = pcm.subarray(i, i + CHUNK);
      const pkt = new Uint8Array(part.length + 1);
      pkt[0] = 2; pkt.set(part, 1);
      await this.run(() => c.writeValueWithResponse(pkt));
      onProgress?.(Math.min(1, (i + CHUNK) / pcm.length));
    }
    await this.run(() => c.writeValueWithResponse(new Uint8Array([3])));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(what + ' took too long')), ms); }),
  ]).finally(() => clearTimeout(t));
}

// ---------------------------------------------------------------------------
// Demo tag: behaves like a real one so the app can be tried with no hardware
// ---------------------------------------------------------------------------
export class DemoTag extends EventTarget {
  constructor(id = 'demo-1', name = 'Tether-DEMO') {
    super();
    this.id = id; this.name = name; this.connected = false;
    this.settings = { ...DEFAULT_SETTINGS };
    this.quiet = DEFAULT_QUIET.map((q) => ({ ...q }));
    this.rssi = -60; this.counter = 0; this.calibrating = false; this.alerting = false;
    this.dndUntil = 0; this.hasRecording = false; this.event = 0;
  }
  async connect() {
    await new Promise((r) => setTimeout(r, 600));
    this.connected = true;
    this.timer = setInterval(() => this.tick(), 1000);
  }
  disconnect() {
    clearInterval(this.timer);
    if (this.connected) { this.connected = false; this.dispatchEvent(new Event('disconnected')); }
  }
  tick() {
    this.rssi = Math.max(-92, Math.min(-45, this.rssi + (Math.random() * 6 - 3)));
    this.dispatchEvent(new CustomEvent('status', { detail: this.status() }));
  }
  status() {
    const dndLeft = Math.max(0, Math.ceil((this.dndUntil - Date.now()) / 60000));
    return {
      rssi: Math.round(this.rssi), phoneConnected: true, moving: Math.random() > 0.5, dnd: dndLeft > 0,
      alerting: this.alerting, quiet: false, calibrating: this.calibrating, hasRecording: this.hasRecording,
      hasTime: true, dndMinutes: dndLeft, threshold: this.settings.threshold, event: this.event,
      eventCounter: this.counter, firmware: 1,
    };
  }
  async readSettings() { return { settings: { ...this.settings }, quiet: this.quiet.map((q) => ({ ...q })) }; }
  async readStatus() { return this.status(); }
  async writeSettings(s) { await wait(200); this.settings = { ...s }; }
  async writeQuiet(q) { await wait(150); this.quiet = q.map((x) => ({ ...x })); }
  async sendTime() {}
  async command(op, a = 0, b = 0) {
    await wait(120);
    if (op === CMD.calibrate) {
      this.calibrating = true;
      // Pretend the user walks off and presses the button 4 seconds later
      setTimeout(() => {
        this.calibrating = false;
        this.settings.threshold = Math.round(this.rssi) - 3;
        this.event = 2; this.counter++;
        this.tick();
      }, 4000);
    }
    if (op === CMD.dnd) this.dndUntil = Date.now() + (a | (b << 8)) * 60000;
    if (op === CMD.ring) { this.alerting = true; setTimeout(() => { this.alerting = false; }, 2500); }
    if (op === CMD.stop) this.alerting = false;
  }
  async uploadClip(pcm, rate, onProgress) {
    for (let i = 1; i <= 10; i++) { await wait(120); onProgress?.(i / 10); }
    this.hasRecording = true;
  }
  get alive() { return this.connected; }
  async waitUntilNearby(ms) {
    const left = Math.max(0, (this.awayUntil || 0) - Date.now());
    await sleep(Math.min(ms, left || 500));
    return Date.now() >= (this.awayUntil || 0);
  }
  // Demo helper: pretend the tag walked out of range for 12 seconds
  simulateLoss() { this.awayUntil = Date.now() + 12000; this.disconnect(); }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
