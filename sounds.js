// Sounds played on this phone or computer: previews of the tag's tones,
// "find my phone" alarm and the phone-side "tag left" alarm.

let ctx;
function audio() {
  ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// Same patterns as the tag firmware: [frequency Hz, milliseconds], 0 = pause
const PATTERNS = {
  0: [[1319, 150], [1047, 150], [784, 320]],
  1: [[2000, 120], [0, 80], [2000, 120]],
  2: Array.from({ length: 31 }, (_, i) => [600 + i * 60, 18]),
  3: [[440, 250], [0, 100], [440, 250], [0, 100], [440, 400]],
  4: [[523, 160], [659, 160], [784, 160], [1047, 220], [784, 160], [1047, 320]],
  5: [].concat(...Array.from({ length: 3 }, () => [
    ...Array.from({ length: 16 }, (_, i) => [900 + i * 60, 8 * 2]),
    ...Array.from({ length: 16 }, (_, i) => [1800 - i * 60, 8 * 2]),
  ])),
};

export function playPattern(tone, volume = 3) {
  const a = audio();
  const gainValue = 0.04 + (volume / 5) * 0.16;
  let t = a.currentTime + 0.02;
  for (const [f, ms] of PATTERNS[tone] || PATTERNS[0]) {
    const dur = ms / 1000;
    if (f > 0) {
      const o = a.createOscillator();
      const g = a.createGain();
      o.type = 'square';
      o.frequency.value = f;
      g.gain.setValueAtTime(gainValue, t);
      g.gain.setValueAtTime(0, t + dur);
      o.connect(g).connect(a.destination);
      o.start(t); o.stop(t + dur + 0.01);
    }
    t += dur;
  }
  return (t - a.currentTime) * 1000;
}

let alarmTimer = null;
let alarmLimit = null;
// gapMs: pause between rounds. limitMs: stop by itself after this long.
export function startAlarm(tone = 5, { gapMs = 500, limitMs = 60000 } = {}) {
  stopAlarm();
  const loop = () => {
    const ms = playPattern(tone, 5);
    if (navigator.vibrate) navigator.vibrate([400, 200, 400]);
    alarmTimer = setTimeout(loop, ms + gapMs);
  };
  loop();
  alarmLimit = setTimeout(stopAlarm, limitMs);
}
export function stopAlarm() {
  clearTimeout(alarmTimer);
  clearTimeout(alarmLimit);
  alarmTimer = null;
  if (navigator.vibrate) navigator.vibrate(0);
}
export const alarmRunning = () => alarmTimer !== null;

// Play recorded 8-bit audio locally
export function playPcm(pcm, rate) {
  const a = audio();
  const buf = a.createBuffer(1, pcm.length, rate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = (pcm[i] - 128) / 128;
  const src = a.createBufferSource();
  src.buffer = buf;
  src.connect(a.destination);
  src.start();
}

// ---------------------------------------------------------------------------
// Recording: microphone -> 8 kHz 8-bit audio the tag can play
// ---------------------------------------------------------------------------
export const CLIP_RATE = 8000;
export const CLIP_SECONDS = 5;

export class Recorder {
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true } });
    this.chunks = [];
    this.rec = new MediaRecorder(this.stream);
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.done = new Promise((res) => { this.rec.onstop = res; });
    this.rec.start();
    this.autoStop = setTimeout(() => this.stop(), CLIP_SECONDS * 1000);
  }
  async stop() {
    clearTimeout(this.autoStop);
    if (this.rec && this.rec.state !== 'inactive') this.rec.stop();
    await this.done;
    this.stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(this.chunks, { type: this.rec.mimeType });
    return toPcm(await blob.arrayBuffer());
  }
}

async function toPcm(arrayBuffer) {
  const decoded = await audio().decodeAudioData(arrayBuffer);
  const seconds = Math.min(decoded.duration, CLIP_SECONDS);
  const length = Math.max(1, Math.floor(seconds * CLIP_RATE));
  const off = new OfflineAudioContext(1, length, CLIP_RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const out = (await off.startRendering()).getChannelData(0);
  // Make it as loud as possible without distortion
  let peak = 0.01;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const gain = 0.95 / peak;
  const pcm = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) pcm[i] = Math.max(0, Math.min(255, Math.round(out[i] * gain * 127 + 128)));
  return { pcm, rate: CLIP_RATE, seconds };
}
