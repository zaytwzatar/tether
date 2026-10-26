// Tether app: screens, saved data and wiring to the tag.
import {
  TagConnection, DemoTag, bluetoothSupport, TONES, DEFAULT_SETTINGS, DEFAULT_QUIET,
  feetToRssi, rssiToFeet, CMD,
} from './ble.js';
import { playPattern, startAlarm, stopAlarm, Recorder, playPcm } from './sounds.js';

// ===========================================================================
// Saved data (stays on this device only)
// ===========================================================================
const COLORS = [
  { bg: '#FFE6D5', fg: '#B03A0A' },
  { bg: '#DDF5EA', fg: '#0F6B4F' },
  { bg: '#E1EEFF', fg: '#1F59A6' },
  { bg: '#FFF0C2', fg: '#7A5200' },
  { bg: '#EEE7FF', fg: '#5B3BB5' },
];


const STORE_KEY = 'tether-v1';
const store = load();
function load() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(STORE_KEY)); } catch { /* first run */ }
  if (!s || !Array.isArray(s.tags)) s = { tags: [] };
  s.units ??= 'ft';
  s.textSize ??= 'm';
  const old = s.tags[0]?.phone;
  s.phone ??= {
    popup: old ? old.leave !== false : true,
    sound: old?.alarm ? 'loud' : 'short',
    vibrate: true, notify: true, tone: 5,
    saveLocation: old ? old.saveLocation !== false : true,
  };
  s.tags.forEach((t, i) => {
    t.color ??= i % COLORS.length;
    t.pausedUntil ??= 0;
    t.phone ??= { leave: true, alarm: false, saveLocation: true };
    t.quietNames ??= ['Night', 'Meeting'];
  });
  return s;
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch { /* storage full or blocked */ }
}
const tagById = (id) => store.tags.find((t) => t.id === id);

function newTag(id, deviceName, demo) {
  return {
    id, deviceName, demo, name: 'My tag',
    color: store.tags.length % COLORS.length,
    settings: { ...DEFAULT_SETTINGS },
    quiet: DEFAULT_QUIET.map((q) => ({ ...q })),
    quietNames: ['Night', 'Meeting'],
    phone: { leave: true, alarm: false, saveLocation: true },
    pausedUntil: 0, lastSeen: null, needsSync: false, addedAt: Date.now(),
  };
}

// ===========================================================================
// Live connections
// ===========================================================================
const live = new Map();       // id -> TagConnection | DemoTag
const status = new Map();     // id -> latest status from the tag
const lastEventCount = new Map();
const userClosed = new Set();
const reconnecting = new Set();
const rssiHistory = new Map();

const ui = {
  modal: null, queue: [], untilBack: new Set(), lastRing: {},
  down: new Set(), recovering: new Set(), lastStatus: {}, visibleSince: Date.now(), needTap: false,
  draft: null, draftKey: '', editing: false,
  recorder: null, clip: null, uploading: 0, busy: '',
  pending: null, pendingName: '', installPrompt: null,
};

const isConnected = (id) => !!live.get(id)?.connected;
const isPaused = (tag) => tag.pausedUntil > Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function attach(tag, conn) {
  live.set(tag.id, conn);
  conn.addEventListener('status', (e) => onStatus(tag.id, e.detail));
  conn.addEventListener('disconnected', () => onDisconnected(tag.id));
}

// After any (re)connection: send what changed while away, or read the tag's settings
async function afterConnect(tag) {
  if (tag.needsSync || tag.demo) await pushToTag(tag);
  else {
    const fromTag = await live.get(tag.id).readSettings();
    tag.settings = fromTag.settings;
    tag.quiet = fromTag.quiet;
  }
  await syncPause(tag);
  save();
}

async function connectTag(tag) {
  let conn = live.get(tag.id);
  if (!conn) {
    if (tag.demo) conn = new DemoTag(tag.id, tag.deviceName);
    else {
      const known = (await TagConnection.remembered()).find((c) => c.id === tag.id);
      conn = known || await TagConnection.pick();
      if (conn.id !== tag.id) { toast('That is a different tag. Choose ' + tag.deviceName + '.'); return; }
    }
    attach(tag, conn);
  }
  userClosed.delete(tag.id);
  await conn.connect();
  ui.down.delete(tag.id);
  await afterConnect(tag);
  render();
}

async function pushToTag(tag) {
  const conn = live.get(tag.id);
  if (!conn?.connected) { tag.needsSync = true; save(); return false; }
  await conn.writeSettings(tag.settings);
  await conn.writeQuiet(tag.quiet);
  tag.needsSync = false;
  save();
  return true;
}

async function saveTagNow(tag, msg) {
  try {
    const sent = await pushToTag(tag);
    toast(sent ? msg : 'Saved! It will reach the tag when it connects.');
  } catch (e) { tag.needsSync = true; save(); toast('Saved here, but the tag did not answer. It will try again.'); }
  render();
}

async function command(tag, ...bytes) {
  const conn = live.get(tag.id);
  if (!conn?.connected) { toast(tag.name + ' is not connected right now.'); return false; }
  try { await conn.command(...bytes); return true; } catch { toast('Could not reach ' + tag.name + '. Try again.'); return false; }
}

async function ringTag(tag) {
  ui.lastRing[tag.id] = Date.now();
  if (await command(tag, CMD.ring)) toast('Ringing ' + tag.name + '…');
}

// ---------------------------------------------------------------------------
// Pausing alerts (on the phone and on the tag)
// ---------------------------------------------------------------------------
const PAUSES = [
  { min: 60, label: '1 hour' },
  { min: 180, label: '3 hours' },
  { min: 1440, label: 'All day', sub: '24 hours' },
];
async function pauseTag(tag, minutes) {
  tag.pausedUntil = minutes ? Date.now() + minutes * 60000 : 0;
  tag.pauseSync = true;
  save();
  await syncPause(tag);
}
async function syncPause(tag) {
  const st = status.get(tag.id);
  // A pause started with the tag's own button: let the app know it's being cleared
  if (!tag.pauseSync) return;
  const conn = live.get(tag.id);
  if (!conn?.connected) return;
  const left = Math.max(0, Math.ceil((tag.pausedUntil - Date.now()) / 60000));
  try {
    await conn.command(CMD.dnd, left & 0xff, (left >> 8) & 0xff);
    tag.pauseSync = false;
    save();
  } catch { /* try again next time */ }
  if (st) st.dnd = left > 0;
}
async function pauseMany(tags, minutes) {
  for (const t of tags) await pauseTag(t, minutes);
  if (minutes) toast('Alerts paused until ' + clock(Date.now() + minutes * 60000) + '.');
  else toast('Alerts are back on.');
  render();
}

// ---------------------------------------------------------------------------
// Things the tag tells us
// ---------------------------------------------------------------------------
function onStatus(id, st) {
  const tag = tagById(id);
  if (!tag) return;
  const prev = status.get(id);
  status.set(id, st);
  ui.lastStatus[id] = st;
  ui.down.delete(id);
  const hist = rssiHistory.get(id) || [];
  hist.push(st.rssi); if (hist.length > 6) hist.shift();
  rssiHistory.set(id, hist);

  // A pause the user started with the tag's button
  if (st.dnd && !isPaused(tag) && !tag.pauseSync) { tag.pausedUntil = Date.now() + st.dndMinutes * 60000; save(); }
  if (!st.dnd && isPaused(tag) && !tag.pauseSync && prev?.dnd) { tag.pausedUntil = 0; save(); }

  const prevCount = lastEventCount.get(id);
  lastEventCount.set(id, st.eventCounter);
  if (prevCount !== undefined && prevCount !== st.eventCounter) {
    if (st.event === 1) {
      startAlarm(store.phone.tone);
      notify('Here is your phone!', tag.name + ' is calling your phone.');
      openModal({ type: 'phone', id });
    }
    if (st.event === 2) {
      tag.settings.threshold = st.threshold;
      if (ui.draft && 'threshold' in ui.draft) ui.draft.threshold = st.threshold;
      save();
      toast('Got it! The tag will beep at about ' + fmtDist(rssiToFeet(st.threshold)) + '.');
    }
  }

  // Waiting for this tag to come back, and its signal is strong again
  if (ui.untilBack.has(id) && st.rssi && st.rssi > tag.settings.threshold + 2) onBack(tag);

  // The tag started alerting while still connected (signal got weak)
  const rangAt = ui.lastRing[id] || 0;
  if (st.alerting && !prev?.alerting && Date.now() - rangAt > 20000 && !isPaused(tag)) {
    raiseAlert(tag);
  }
  softRender();
}

function onDisconnected(id) {
  const tag = tagById(id);
  const lastSt = status.get(id) || ui.lastStatus[id];
  status.delete(id);
  if (!tag) return;
  if (userClosed.has(id)) { softRender(); return; }
  if (ui.down.has(id)) { keepTrying(tag); return; }   // already handled
  ui.down.add(id);
  // The app lost touch but the link may just need a restart: try quietly first,
  // and only alert if the tag still can't be reached.
  if (ui.recovering.has(id)) {
    softRender();
    keepTrying(tag);
    setTimeout(() => {
      ui.recovering.delete(id);
      if (!isConnected(id) && tagById(id) && !userClosed.has(id)) { ui.down.delete(id); onDisconnected(id); }
    }, 15000);
    return;
  }
  tag.lastSeenAt = Date.now();
  if (store.phone.saveLocation && 'geolocation' in navigator) {
    navigator.geolocation.getCurrentPosition((p) => {
      tag.lastSeen = { lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy), time: Date.now() };
      save(); softRender();
    }, () => {}, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  }
  save();
  const quietNow = lastSt?.quiet || lastSt?.dnd;
  if (!isPaused(tag) && !quietNow) raiseAlert(tag);
  softRender();
  keepTrying(tag);
}

// What THIS PHONE does when a tag goes out of range (My Phone tab)
function raiseAlert(tag) {
  const ph = store.phone;
  if (ph.notify) notify(tag.name + ' is out of range!', 'Did you leave something behind?');
  if (ph.vibrate && navigator.vibrate) navigator.vibrate([400, 150, 400, 150, 400]);
  if (ph.sound === 'loud') startAlarm(ph.tone);
  else if (ph.sound === 'short') playPattern(ph.tone, 4);
  if (ph.popup) openModal({ type: 'alert', id: tag.id });
  else toast(tag.name + ' is out of range!');
}
const phoneTone = () => store.phone.tone;

// While the app is open, keep looking for the tag and reconnect by itself
// as soon as it's back in range.
const wakers = new Set();             // lets "app opened again" skip the wait
const wakeUp = () => { const ws = [...wakers]; wakers.clear(); ws.forEach((w) => w()); };
async function keepTrying(tag) {
  if (reconnecting.has(tag.id)) return;
  reconnecting.add(tag.id);
  let attempt = 0;
  softRender();
  while (tagById(tag.id) && !isConnected(tag.id) && !userClosed.has(tag.id)) {
    const conn = live.get(tag.id);
    if (!conn) break;
    attempt++;
    // Listen for the tag if the browser can; otherwise just wait a little
    const waitMs = Math.min(2000 * attempt, 8000);
    let waker;
    const near = await Promise.race([conn.waitUntilNearby(waitMs), new Promise((r) => { waker = () => r(null); wakers.add(waker); })]);
    wakers.delete(waker);
    if (!tagById(tag.id) || userClosed.has(tag.id) || isConnected(tag.id)) break;
    if (near === false) continue;     // not heard yet
    try {
      await conn.connect();
      await afterConnect(tag).catch(() => {});
      attempt = 0;
      onBack(tag);
    } catch { /* still away; try again */ }
  }
  reconnecting.delete(tag.id);
  softRender();
}

// If we stop hearing the tag's once-a-second message, the link is stuck:
// restart it quietly instead of pretending everything is fine.
function watchdog() {
  if (document.visibilityState !== 'visible' || Date.now() - ui.visibleSince < 10000) return;
  for (const tag of store.tags) {
    const conn = live.get(tag.id);
    if (!conn || tag.demo || !conn.connected || conn.alive || ui.recovering.has(tag.id)) continue;
    ui.recovering.add(tag.id);
    conn.disconnect();
    setTimeout(() => { if (!ui.down.has(tag.id) && !isConnected(tag.id)) onDisconnected(tag.id); }, 1500);
  }
}

function onBack(tag) {
  ui.down.delete(tag.id);
  const quietFix = ui.recovering.delete(tag.id);
  if (quietFix) { softRender(); return; }     // a quick hiccup, fixed without bothering anyone
  notify(tag.name + ' is back!', 'Back in range.');
  const waited = ui.untilBack.delete(tag.id);
  if (waited && ui.untilBack.size === 0) stopAlarm();
  if (ui.modal?.type === 'alert' && ui.modal.id === tag.id) closeModal(true);
  ui.queue = ui.queue.filter((m) => !(m.type === 'alert' && m.id === tag.id));
  if (waited) openModal({ type: 'back', id: tag.id });
  else toast(tag.name + ' is back in range.');
  softRender();
}

// ===========================================================================
// Helpers
// ===========================================================================
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel) => document.querySelector(sel);
const enc = encodeURIComponent;

function fmtDist(feet) {
  if (store.units === 'yd') return Math.round(feet / 3) + ' yards';
  if (store.units === 'm') return Math.round(feet * 0.3048) + ' meters';
  return feet + ' feet';
}
function fmtMin(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}
function clock(t) {
  const d = new Date(t), now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  const tmr = new Date(now); tmr.setDate(now.getDate() + 1);
  if (d.toDateString() === tmr.toDateString()) return 'tomorrow ' + time;
  return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + time;
}
function timeAgo(t) {
  if (!t) return '';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + (mins === 1 ? ' minute ago' : ' minutes ago');
  const d = new Date(t);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? 'today at ' + time : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' at ' + time;
}
const toTimeInput = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const fromTimeInput = (v) => { const [h, m] = v.split(':').map(Number); return h * 60 + m; };
const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function daysText(mask) {
  if (mask === 0x7f) return 'every day';
  if (mask === 0x3e) return 'weekdays';
  if (mask === 0x41) return 'weekends';
  return DAY_NAMES.filter((_, i) => mask & (1 << i)).map((d) => d.slice(0, 3)).join(', ') || 'no days';
}
function closeness(rssi) {
  if (!rssi) return 'Connected';
  if (rssi > -60) return 'Right here with you';
  if (rssi > -72) return 'Close by';
  if (rssi > -84) return 'Nearby';
  return 'Getting far away';
}

function tagStatus(tag) {
  const st = status.get(tag.id);
  if (isPaused(tag) || st?.dnd) {
    return { k: 'paused', short: 'Paused', text: isPaused(tag) ? 'Alerts paused until ' + clock(tag.pausedUntil) : 'Alerts paused' };
  }
  if (isConnected(tag.id)) {
    if (st?.alerting) return { k: 'alert', short: 'Beeping', text: 'Beeping right now' };
    return { k: 'good', short: 'With you', text: closeness(st?.rssi) };
  }
  if (ui.recovering.has(tag.id)) return { k: 'idle', short: 'Reconnecting…', text: 'Just a moment' };
  if (reconnecting.has(tag.id) && (tag.lastSeenAt || tag.lastSeen)) {
    return { k: 'away', short: 'Out of range', text: 'Looking for it… last seen ' + timeAgo(tag.lastSeenAt || tag.lastSeen?.time) };
  }
  if (tag.lastSeenAt || tag.lastSeen) return { k: 'away', short: 'Out of range', text: 'Last seen ' + timeAgo(tag.lastSeenAt || tag.lastSeen?.time) };
  return { k: 'idle', short: 'Not connected', text: 'Tap Connect when it is nearby' };
}

const ICONS = {
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/>',
  remote: '<rect x="7" y="2" width="10" height="20" rx="3"/><circle cx="12" cy="7" r="1.5"/><path d="M10 12h4M10 15h4M10 18h4"/>',
  bag: '<path d="M6 9a6 6 0 0 1 12 0v10a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2z"/><path d="M9 4.5V3h6v1.5M9 14h6v4H9z"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M16 14h2"/>',
  purse: '<path d="M5 9h14l-1 11H6z"/><path d="M9 9V7a3 3 0 0 1 6 0v2"/>',
  house: '<path d="M3 11l9-8 9 8"/><path d="M5 10v11h14V10"/><path d="M10 21v-6h4v6"/>',
  tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="8" cy="8" r="1.5"/>',
  find: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
  play: '<path d="M8 5l11 7-11 7z" fill="currentColor" stroke="none"/>',
  ring: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/>',
  mute: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9l5 6M22 9l-5 6"/>',
  flash: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  both: '<path d="M3 9h3l4-3v12l-4-3H3z"/><path d="M17 3l-3 7h4l-2 7"/>',
  pin: '<path d="M12 21s-7-6.5-7-12a7 7 0 0 1 14 0c0 5.5-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>',
  bt: '<path d="M7 7l10 10-5 4V3l5 4L7 17"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  ruler: '<path d="M3 17L17 3l4 4L7 21z"/><path d="M7 13l2 2M10 10l2 2M13 7l2 2"/>',
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  near: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8" stroke-dasharray="2 3"/>',
  door: '<path d="M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17"/><path d="M3 21h18"/><circle cx="14.5" cy="12" r="1"/>',
  tree: '<path d="M12 22v-6"/><path d="M12 3l6 8h-3l4 5H5l4-5H6z"/>',
  walk: '<circle cx="13" cy="4" r="2"/><path d="M10 22l2-7 3 3v6M8 12l3-4 4 2 3 3M11 8l-1 5"/>',
  phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  heart: '<path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10z"/>',
};
const icon = (name, size = 24, extra = '') =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${ICONS[name]}</svg>`;

function kindFor(name) {
  const n = name.toLowerCase();
  if (/key|car/.test(n)) return 'key';
  if (/remote|tv/.test(n)) return 'remote';
  if (/purse|handbag/.test(n)) return 'purse';
  if (/bag|pack|luggage|suitcase/.test(n)) return 'bag';
  if (/wallet/.test(n)) return 'wallet';
  return 'tag';
}
function avatar(tag, size = '', extra = '') {
  const c = COLORS[tag.color % COLORS.length];
  const alive = isConnected(tag.id) && !isPaused(tag) && !status.get(tag.id)?.dnd;
  return `<span class="avatar ${size} ${extra} ${alive && !extra ? 'live' : ''}" style="--av-bg:${c.bg};--av-fg:${c.fg}">${icon(kindFor(tag.name))}</span>`;
}
const pill = (s) => `<span class="pill-status k-${s.k}">${esc(s.short)}</span>`;

// ===========================================================================
// Toasts and notifications
// ===========================================================================
function toast(text, actionLabel, action) {
  const box = $('#toast');
  box.innerHTML = `<span>${esc(text)}</span>${actionLabel ? `<button type="button" class="toast-btn">${esc(actionLabel)}</button>` : ''}`;
  box.hidden = false;
  box.querySelector('.toast-btn')?.addEventListener('click', () => { action?.(); box.hidden = true; });
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { box.hidden = true; }, actionLabel ? 12000 : 4000);
}
async function notify(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) reg.showNotification(title, { body, icon: 'icons/icon-192.png', tag: title, vibrate: [300, 100, 300] });
    else new Notification(title, { body });
  } catch { /* notifications blocked */ }
}

// ===========================================================================
// Popups
// ===========================================================================
function openModal(m) {
  if (ui.modal && ui.modal.type === 'alert' && m.type !== 'phone') { ui.queue.push(m); return; }
  if (ui.modal) ui.queue.unshift(ui.modal);
  ui.lastFocus = document.activeElement;
  ui.modal = m;
  renderModal();
}
function closeModal(silent) {
  ui.modal = ui.queue.shift() || null;
  renderModal();
  if (!ui.modal && !silent) ui.lastFocus?.focus?.();
}

function confetti() {
  const colors = ['#D9480F', '#FFC93C', '#13795B', '#6D4AD6', '#1F63B5', '#FF8A5B'];
  return '<div class="confetti" aria-hidden="true">' + Array.from({ length: 26 }, (_, i) =>
    `<i style="--x:${(i * 37) % 100}%;--c:${colors[i % colors.length]};--d:${1.6 + (i % 5) * 0.3}s;--w:${(i % 7) * 0.08}s;--r:${(i * 47) % 360}deg"></i>`).join('') + '</div>';
}

function viewModal() {
  const m = ui.modal;
  if (!m) return '';
  const tag = m.id ? tagById(m.id) : null;
  if (m.id && !tag) return '';
  const wrap = (inner, cls = '', label = 'm-title') =>
    `<div class="modal-backdrop" data-backdrop><div class="modal ${cls}" role="${cls.includes('alert') ? 'alertdialog' : 'dialog'}" aria-modal="true" aria-labelledby="${label}" aria-describedby="m-desc">${inner}</div></div>`;

  if (m.type === 'alert') {
    const connected = isConnected(tag.id);
    return wrap(`
      ${avatar(tag, 'xl', 'shake')}
      <h2 id="m-title">${esc(tag.name)} is out of range!</h2>
      <p id="m-desc">Did you leave it behind? Or did you leave your phone?</p>
      <button type="button" class="btn big primary" data-action="m-silence">${icon('check', 22)}OK, silence this alert</button>
      <button type="button" class="btn big soft" data-action="m-until-back">${icon('ring', 22)}Keep alerting until it's back</button>
      <div class="pause-label">Or pause alerts for</div>
      <div class="pause-row">${PAUSES.map((p) => `<button type="button" class="btn" data-action="m-pause" data-min="${p.min}"><span>${p.label}${p.sub ? `<small>${p.sub}</small>` : ''}</span></button>`).join('')}</div>
      ${connected ? '' : '<p class="fine">The tag itself stops after its beeps, or when you press its button.</p>'}`, 'alert-modal');
  }
  if (m.type === 'phone') {
    return wrap(`
      <span class="avatar xl shake" style="--av-bg:#FFF0C2;--av-fg:#7A5200">${icon('phone')}</span>
      <h2 id="m-title">Here's your phone!</h2>
      <p id="m-desc">${esc(tag.name)} asked your phone to ring.</p>
      <button type="button" class="btn big good" data-action="m-found">${icon('check', 22)}Found it! Stop ringing</button>`);
  }
  if (m.type === 'back') {
    return wrap(`${confetti()}
      ${avatar(tag, 'xl', 'hop')}
      <h2 id="m-title">${esc(tag.name)} is back!</h2>
      <p id="m-desc">It's in range again, and alerts are on.</p>
      <button type="button" class="btn big good" data-action="m-close">Great!</button>`);
  }
  if (m.type === 'added') {
    return wrap(`${confetti()}
      ${avatar(tag, 'xl', 'hop')}
      <h2 id="m-title">${esc(tag.name)} is ready!</h2>
      <p id="m-desc">Try it: leave your phone here and walk away with the tag. It will beep when you get too far.</p>
      <button type="button" class="btn big primary" data-action="m-close">Let's go</button>`);
  }
  if (m.type === 'pause') {
    const tags = tag ? [tag] : store.tags;
    const anyPaused = tags.some((t) => isPaused(t) || status.get(t.id)?.dnd);
    return wrap(`
      <span class="avatar lg" style="--av-bg:var(--pause-soft);--av-fg:var(--pause)">${icon('pause')}</span>
      <h2 id="m-title">Pause alerts</h2>
      <p id="m-desc">${tag ? `${esc(tag.name)} won't beep, and your phone won't alert.` : 'None of your tags will beep, and your phone won\'t alert.'} They turn back on by themselves.</p>
      <div class="sheet-list">${PAUSES.map((p) => `<button type="button" class="btn" data-action="m-pause-sheet" data-min="${p.min}">${icon('moon', 22)}<span class="lines">${p.label}<span class="when">until ${clock(Date.now() + p.min * 60000)}</span></span></button>`).join('')}</div>
      ${anyPaused ? '<button type="button" class="btn big good" data-action="m-pause-sheet" data-min="0">Turn alerts back on now</button>' : ''}
      <button type="button" class="btn ghost wide" data-action="m-close">Cancel</button>`);
  }
  return '';
}

function renderModal() {
  const box = $('#modal');
  box.innerHTML = viewModal();
  document.body.style.overflow = ui.modal ? 'hidden' : '';
  if (ui.modal) box.querySelector('.modal .btn')?.focus();
}

// ===========================================================================
// Screens
// ===========================================================================
function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return { page: parts[0] || 'home', id: parts[1] ? decodeURIComponent(parts[1]) : null, sub: parts[2] || null };
}
const go = (hash) => { location.hash = hash; };
const back = (href, label) => `<a class="back" href="${href}">${icon('back', 22)}<span>${esc(label)}</span></a>`;
const notConnectedNote = (tag) => isConnected(tag.id) ? '' :
  `<p class="note k-away">${icon('bt', 18)}<span>${esc(tag.name)} isn't connected. Your changes are saved and will be sent when it connects.</span></p>`;

function draftFor(tag, key) {
  const k = tag.id + ':' + key;
  if (ui.draftKey !== k) {
    ui.draftKey = k;
    ui.draft = key === 'quiet'
      ? { quiet: tag.quiet.map((q) => ({ ...q })), names: [...tag.quietNames], settings: { ...tag.settings } }
      : { ...tag.settings };
  }
  return ui.draft;
}

// ----- Zone headers: every page says whose settings these are -----
const ZONE = {
  phone: { label: 'My Phone', ic: 'phone' },
  tag: { label: 'My Tags', ic: 'tag' },
  settings: { label: 'Settings', ic: 'gear' },
};
const badge = (zone, text) => `<span class="zone-badge">${icon(ZONE[zone].ic, 16)}${esc(text || ZONE[zone].label)}</span>`;
function zoneHead(zone, title, sub, right = '', badgeText = '') {
  return `<header class="zone-head">
    ${badge(zone, badgeText)}
    <div class="zh-row"><h1>${title}</h1>${right}</div>
    ${sub ? `<p class="lead">${sub}</p>` : ''}
  </header>`;
}

// ----- My Tags (home) -----
function viewHome() {
  const support = bluetoothSupport();
  if (!store.tags.length) {
    return `
      ${zoneHead('tag', 'Hello!', '', '', 'Welcome to Tether')}
      <section class="card welcome">
        <div class="art" aria-hidden="true"><span class="ring"></span><span class="ring"></span><span class="ring"></span><span class="core">${icon('phone')}</span></div>
        <h2 class="h2">Never leave your phone behind</h2>
        <p class="muted">Clip a Tether tag to your keys. When you walk away from your phone, the tag beeps.</p>
        ${support.ok ? '' : `<p class="note k-away">${esc(support.reason)}</p>`}
        <a class="btn big primary" href="#/add">${icon('plus', 22)}Add my tag</a>
        <button type="button" class="btn ghost" data-action="demo">Just looking? Try a pretend tag</button>
      </section>`;
  }
  const all = store.tags;
  const away = all.filter((t) => !isConnected(t.id) && live.has(t.id) && (t.lastSeenAt || t.lastSeen));
  const pausedAll = all.every((t) => isPaused(t) || status.get(t.id)?.dnd);
  let summary = '';
  if (pausedAll) {
    const until = Math.max(...all.map((t) => t.pausedUntil));
    summary = `<section class="summary k-paused"><span class="sum-icon">${icon('moon', 26)}</span>
      <span class="grow"><b>Alerts are paused</b><span>${until > Date.now() ? 'Until ' + clock(until) : 'For now'}</span></span>
      <button type="button" class="btn purple" data-action="resume-all">Turn back on</button></section>`;
  } else if (all.some((t) => !t.demo && !live.has(t.id))) {
    summary = `<section class="summary k-idle"><span class="sum-icon">${icon('bt', 26)}</span>
      <span class="grow"><b>Tap Connect to link up</b><span>After the app restarts, tap Connect once. Then it reconnects by itself.</span></span></section>`;
  } else if (away.length) {
    summary = `<section class="summary k-away"><span class="sum-icon">${icon('alert', 26)}</span>
      <span class="grow"><b>${esc(away.map((t) => t.name).join(' and '))} ${away.length === 1 ? 'is' : 'are'} out of range</b><span>Looking for ${away.length === 1 ? 'it' : 'them'}. ${away.length === 1 ? 'It reconnects' : 'They reconnect'} by itself when back.</span></span></section>`;
  } else if (all.some((t) => isConnected(t.id))) {
    summary = `<section class="summary k-good"><span class="sum-icon">${icon('check', 26)}</span>
      <span class="grow"><b>All good!</b><span>${all.length === 1 ? 'Your tag is' : 'Your tags are'} connected and watching.</span></span></section>`;
  }

  const cards = all.map((tag) => {
    const s = tagStatus(tag);
    const connected = isConnected(tag.id);
    return `
      <article class="card tag-card">
        <a class="tag-main" href="#/tag/${enc(tag.id)}">
          ${avatar(tag)}
          <span class="grow"><span class="tag-name">${esc(tag.name)}</span>${pill(s)}<span class="tag-sub">${esc(s.text)}</span></span>
          ${icon('chev', 26, 'class="chev"')}
        </a>
        <div class="row">
          ${connected
            ? `<button type="button" class="btn primary" data-action="ring" data-id="${esc(tag.id)}">${icon('ring', 20)}Ring it</button>
               <a class="btn soft" href="#/find/${enc(tag.id)}">${icon('find', 20)}Find it</a>`
            : `<button type="button" class="btn dark" data-action="connect" data-id="${esc(tag.id)}">${icon('bt', 20)}Connect</button>
               ${tag.lastSeen ? `<a class="btn soft" href="#/tag/${enc(tag.id)}/lastseen">${icon('pin', 20)}Where was it?</a>` : ''}`}
        </div>
      </article>`;
  }).join('');

  return `
    ${zoneHead('tag', 'My Tags', 'Your tags and what they do.', pausedAll ? '' : `<button type="button" class="btn purple" data-action="open-pause">${icon('pause', 20)}Pause</button>`)}
    ${support.ok ? '' : `<p class="note k-away">${esc(support.reason)}</p>`}
    ${summary}
    <div class="tag-grid">${cards}
      <a class="add-card" href="#/add"><span class="plus">${icon('plus', 22)}</span>Add a tag</a>
    </div>`;
}

// ----- One tag: everything the TAG does -----
const STYLE_CHOICES = [
  { v: 0, label: 'Beep', ic: 'ring', c: 'orange' },
  { v: 2, label: 'Flash', ic: 'flash', c: 'yellow' },
  { v: 4, label: 'Beep + flash', ic: 'both', c: 'green' },
  { v: 5, label: 'Stay quiet', ic: 'mute', c: 'purple' },
];
const styleShown = (v) => (v === 1 ? 2 : v === 3 ? 4 : v);   // vibrate options show as their light version

function viewTag(tag) {
  const st = status.get(tag.id);
  const connected = isConnected(tag.id);
  const s = tagStatus(tag);
  const set = tag.settings;
  const paused = isPaused(tag) || st?.dnd;
  const quietOn = tag.quiet.map((q, i) => ({ ...q, name: tag.quietNames[i] })).filter((q) => q.days);

  const tiles = [
    connected
      ? `<button type="button" class="tile" data-action="ring" data-id="${esc(tag.id)}"><span class="ti orange">${icon('ring')}</span>Ring it</button>`
      : `<button type="button" class="tile" data-action="connect" data-id="${esc(tag.id)}"><span class="ti blue">${icon('bt')}</span>Connect</button>`,
    `<a class="tile" href="#/find/${enc(tag.id)}"><span class="ti green">${icon('find')}</span>Find it</a>`,
    paused
      ? `<button type="button" class="tile" data-action="resume" data-id="${esc(tag.id)}"><span class="ti purple">${icon('play')}</span>Turn alerts on</button>`
      : `<button type="button" class="tile" data-action="open-pause" data-id="${esc(tag.id)}"><span class="ti purple">${icon('pause')}</span>Pause alerts</button>`,
    `<a class="tile" href="#/tag/${enc(tag.id)}/lastseen"><span class="ti blue">${icon('pin')}</span>Where was it?</a>`,
  ].join('');

  const choices = STYLE_CHOICES.map((c) =>
    `<button type="button" class="tile ${styleShown(set.style) === c.v ? 'on' : ''}" aria-pressed="${styleShown(set.style) === c.v}" data-action="quick-style" data-v="${c.v}"><span class="ti ${c.c}">${icon(c.ic)}</span>${c.label}</button>`).join('');

  const problems = [];
  if (connected && st && !tag.demo && !st.phoneConnected) problems.push(`<li><b>Pair the tag with this phone too.</b> Open your phone's Settings › Connected devices › Pair new device, then tap <b>${esc(tag.deviceName)}</b>.</li>`);
  if (connected && st?.quiet) problems.push('<li><b>It\'s quiet time right now.</b> <button type="button" class="link-btn" data-action="quiet-off">Turn quiet times off</button></li>');
  if (paused) problems.push(`<li><b>Alerts are paused.</b> <button type="button" class="link-btn" data-action="resume" data-id="${esc(tag.id)}">Turn them back on</button></li>`);
  if (set.style === 5) problems.push('<li><b>The tag is set to stay quiet.</b> Pick Beep or Flash above.</li>');
  const verb = styleShown(set.style) === 2 ? 'flash' : styleShown(set.style) === 4 ? 'beep and flash' : 'beep';
  const check = !connected ? ''
    : problems.length
      ? `<div class="check k-away">${icon('alert', 22)}<div><b>The tag won't alert right now</b><ul>${problems.join('')}</ul></div></div>`
      : `<div class="check k-good">${icon('check', 22)}<span><b>All set!</b> The tag will ${verb} when you get too far from your phone.</span></div>`;

  return `
    ${back('#/home', 'My Tags')}
    <div class="narrow">
    ${badge('tag', 'Tag settings & alerts')}
    <section class="card tag-hero hero-${s.k}">
      ${avatar(tag, 'xl')}
      <h1>${esc(tag.name)}</h1>
      ${pill(s)}
      <span class="status-line">${esc(s.text)}</span>
    </section>
    <div class="action-grid">${tiles}</div>

    <section class="card pad stack">
      <h2 class="h2">When I walk away from my phone, the tag will…</h2>
      <div class="choice-grid" role="group" aria-label="Tag alert">${choices}</div>
      ${check}
      ${connected && set.motionOnly && set.style !== 5 ? `<p class="note k-idle">${icon('walk', 18)}<span>It only beeps while the tag is <b>moving</b>. Leaving the tag on a table and walking away with your phone? <button type="button" class="link-btn" data-action="motion-off">Beep even when it's still</button></span></p>` : ''}
      ${connected ? `<button type="button" class="btn soft wide" data-action="test-alert" data-id="${esc(tag.id)}">${icon('sparkle', 20)}Test it now</button>` : ''}
    </section>

    <nav class="card setting-list" aria-label="Tag settings">
      ${settingRow(`#/tag/${enc(tag.id)}/sound`, 'music', 'yellow', 'Which sound?', `${TONES[set.tone]?.name}, volume ${set.volume}, ${set.repeat ? set.repeat === 1 ? 'once' : set.repeat + ' times' : 'until it\'s back'}`)}
      ${settingRow(`#/tag/${enc(tag.id)}/quiet`, 'moon', 'purple', 'Quiet times', quietOn.length ? quietOn.map((q) => `${q.name} ${fmtMin(q.start)}–${fmtMin(q.end)}`).join(', ') : 'None set')}
      ${settingRow(`#/distance/${enc(tag.id)}`, 'ruler', 'orange', 'How far?', `About ${fmtDist(rssiToFeet(set.threshold))} · in Settings`)}
    </nav>

    <section class="card pad stack">
      <h2 class="h2">The tag's button</h2>
      <ul class="help-list">
        <li><span class="key">Press once</span><span>Stop the beeping</span></li>
        <li><span class="key">Press twice</span><span>Ring your phone</span></li>
        <li><span class="key">Hold down</span><span>Pause alerts for ${set.holdDnd >= 60 ? (set.holdDnd / 60) + (set.holdDnd === 60 ? ' hour' : ' hours') : set.holdDnd + ' minutes'}</span></li>
      </ul>
    </section>

    <details class="card more">
      <summary>Name, remove and more ${icon('chev', 22, 'class="caret"')}</summary>
      <div class="more-body">
        <label class="field"><span>Name</span><input type="text" value="${esc(tag.name)}" data-bind="rename" maxlength="30"></label>
        <p class="small muted">Bluetooth name: ${esc(tag.deviceName)}${tag.demo ? ' (pretend tag)' : ''}${connected && st?.rssi ? ` · signal ${st.rssi} dBm` : ''}</p>
        ${tag.demo && connected ? `<button type="button" class="btn soft wide" data-action="demo-loss" data-id="${esc(tag.id)}">${icon('walk', 20)}Pretend I walked away</button>` : ''}
        <div class="row">
          ${connected ? `<button type="button" class="btn ghost" data-action="disconnect" data-id="${esc(tag.id)}">Disconnect</button>` : ''}
          <button type="button" class="btn ghost danger" data-action="remove" data-id="${esc(tag.id)}">Remove this tag</button>
        </div>
      </div>
    </details>
    </div>`;
}

function settingRow(href, ic, color, title, sub) {
  return `<a class="setting-row" href="${href}"><span class="ti ${color} row-icon">${icon(ic)}</span>
    <span class="grow"><b>${esc(title)}</b><small>${esc(sub)}</small></span>${icon('chev', 24, 'class="chev"')}</a>`;
}

function toggle(bind, on, title, sub, extra = '') {
  return `<label class="toggle"><span class="grow"><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span>
    <input type="checkbox" class="switch" role="switch" data-bind="${bind}" ${extra} ${on ? 'checked' : ''}></label>`;
}

// ----- My Phone: everything THIS PHONE does -----
const PHONE_SOUNDS = [0, 1, 4, 5];
function viewPhone() {
  const ph = store.phone;
  const notif = 'Notification' in window ? Notification.permission : 'unsupported';
  const withSpots = store.tags.filter((t) => t.lastSeen || t.lastSeenAt);
  const soundOpt = (v, l) => `<button type="button" class="seg ${ph.sound === v ? 'on' : ''}" aria-pressed="${ph.sound === v}" data-action="phone-sound" data-v="${v}">${l}</button>`;
  return `
    ${zoneHead('phone', 'My Phone', 'What <b>this phone</b> does when a tag goes out of range.')}
    <div class="narrow">
    <section class="card pad stack">
      <h2 class="h2">When a tag goes out of range, my phone will…</h2>
      ${toggle('ph-popup', ph.popup, 'Show a big alert on the screen', 'With buttons to silence it or pause alerts')}
      <div class="stack tight">
        <b>Play a sound</b>
        <div class="seg-row">${soundOpt('off', 'No sound')}${soundOpt('short', 'Once')}${soundOpt('loud', 'Keep ringing')}</div>
      </div>
      ${'vibrate' in navigator ? toggle('ph-vibrate', ph.vibrate, 'Vibrate', '') : ''}
      ${toggle('ph-notify', notif === 'granted' && ph.notify, 'Send a notification', notif === 'denied' ? 'Blocked. Turn notifications on in Chrome\'s site settings.' : notif === 'unsupported' ? 'This browser can\'t show notifications' : 'Shows up even if you\'re in another app', notif === 'denied' || notif === 'unsupported' ? 'disabled' : '')}
      <button type="button" class="btn soft wide" data-action="test-phone">${icon('sparkle', 20)}Test my phone's alert</button>
    </section>

    <section class="card pad stack">
      <h2 class="h2">My phone's alarm sound</h2>
      <p class="muted">Also plays when you press the tag's button twice to find your phone.</p>
      <div class="sound-grid">${PHONE_SOUNDS.map((t) => `
        <label class="sound-card ${ph.tone === t ? 'on' : ''}">
          <input type="radio" name="ph-tone" value="${t}" data-bind="ph-tone" ${ph.tone === t ? 'checked' : ''}>
          <b>${TONES[t].name}</b><small>${esc(TONES[t].note)}</small>
          <button type="button" class="play" aria-label="Listen to ${TONES[t].name}" data-action="listen" data-tone="${t}">${icon('play', 18)}</button>
        </label>`).join('')}</div>
    </section>

    <section class="card pad stack">
      <h2 class="h2">Remember where tags were left</h2>
      ${toggle('ph-location', ph.saveLocation, 'Save the spot when a tag goes out of range', 'Uses this phone\'s location. Kept only on this phone.')}
      ${withSpots.length ? `<div class="setting-list inset">${withSpots.map((t) => settingRow(`#/tag/${enc(t.id)}/lastseen`, 'pin', 'blue', t.name, 'Last seen ' + timeAgo(t.lastSeenAt || t.lastSeen?.time))).join('')}</div>` : '<p class="small muted">No spots saved yet.</p>'}
    </section>

    <p class="note k-idle">${icon('phone', 18)}<span>Phone alerts work while the Tether app is open (it can be in the background). The tag's own beep works even when the app is closed.</span></p>
    </div>`;
}

// ----- How far (in Settings) -----
const ZONES = [
  { name: 'Very close', feet: 15, hint: 'A few steps away', ic: 'near' },
  { name: 'Leave the room', feet: 30, hint: 'Out the door', ic: 'door' },
  { name: 'Leave the house', feet: 60, hint: 'Down the hall or outside', ic: 'house' },
  { name: 'Far', feet: 120, hint: 'Yard or parking lot', ic: 'tree' },
];
function zoneFor(feet) { let z = ZONES[0]; ZONES.forEach((x) => { if (feet >= x.feet) z = x; }); return z; }

function viewDistance(tag) {
  const d = draftFor(tag, 'distance');
  const st = status.get(tag.id);
  const feet = Math.min(150, Math.max(10, rssiToFeet(d.threshold)));
  const zone = zoneFor(feet);
  const tiles = ZONES.map((z) => `<button type="button" class="tile ${zone === z ? 'on' : ''}" aria-pressed="${zone === z}" data-action="zone" data-feet="${z.feet}">
    <span class="ti orange">${icon(z.ic)}</span><b>${z.name}</b><small>${z.hint}</small></button>`).join('');
  const unitBtn = (u, l) => `<button type="button" class="seg ${store.units === u ? 'on' : ''}" aria-pressed="${store.units === u}" data-action="unit" data-unit="${u}">${l}</button>`;
  const chips = store.tags.length > 1
    ? `<div class="chip-row" role="group" aria-label="Which tag">${store.tags.map((t) => `<a class="chip ${t.id === tag.id ? 'on' : ''}" href="#/distance/${enc(t.id)}" ${t.id === tag.id ? 'aria-current="true"' : ''}>${esc(t.name)}</a>`).join('')}</div>` : '';
  return `
    ${back('#/settings', 'Settings')}
    <div class="narrow">
    ${zoneHead('settings', 'How far?', `How far can you walk from your phone before ${esc(tag.name)} alerts?`)}
    ${chips}
    ${notConnectedNote(tag)}
    <div class="dist-grid">${tiles}</div>

    <section class="card pad stack">
      ${toggle('draft-motionOnly', d.motionOnly, 'Only alert while the tag is moving', 'Fewer alerts when your keys sit on a table. Turn off to alert even when the tag is still.')}
    </section>

    <section class="card pad stack">
      <h2 class="h2">Set it by walking</h2>
      <p class="muted">The easiest way to get it just right for your home.</p>
      <ol class="steps-list">
        <li>Leave your phone where it usually sits.</li>
        <li>Tap the button below.</li>
        <li>Walk to where you want the alert, and press the tag's button once.</li>
      </ol>
      <button type="button" class="btn dark wide" data-action="calibrate" ${st?.calibrating ? 'disabled' : ''}>${icon('walk', 22)}${st?.calibrating ? 'Waiting for you to press the tag…' : 'Start the walk test'}</button>
    </section>

    <details class="card more">
      <summary>Fine-tune the exact distance ${icon('chev', 22, 'class="caret"')}</summary>
      <div class="more-body">
        <div class="seg-row" role="group" aria-label="Units">${unitBtn('ft', 'Feet')}${unitBtn('yd', 'Yards')}${unitBtn('m', 'Meters')}</div>
        <div class="readout"><span class="muted">About</span><strong id="dist-readout">${fmtDist(feet)}</strong></div>
        <label class="sr-only" for="dist">Distance</label>
        <input id="dist" type="range" min="10" max="150" step="5" value="${feet}" data-bind="feet">
        <p class="small muted">Bluetooth guesses distance from signal strength, so walls and pockets change it. The walk test is more accurate.</p>
      </div>
    </details>
    <div class="save-bar"><button type="button" class="btn big primary" data-action="save-settings">Save</button></div>
    </div>`;
}

// ----- Which sound -----
function viewSound(tag) {
  const d = draftFor(tag, 'sound');
  const st = status.get(tag.id);
  const hasRec = st?.hasRecording || ui.clip;
  const cards = TONES.filter((t) => t.id !== 6 || hasRec).map((t) => `
    <label class="sound-card ${d.tone === t.id ? 'on' : ''}">
      <input type="radio" name="tone" value="${t.id}" data-bind="tone" ${d.tone === t.id ? 'checked' : ''}>
      <b>${t.name}</b><small>${t.id === 6 ? 'Your own voice' : esc(t.note)}</small>
      <button type="button" class="play" aria-label="Listen to ${t.name}" data-action="listen" data-tone="${t.id}">${icon('play', 18)}</button>
    </label>`).join('');
  const reps = [[1, 'Once'], [3, '3 times'], [5, '5 times'], [0, 'Until it\'s back']];
  return `
    ${back('#/tag/' + enc(tag.id), tag.name)}
    <div class="narrow">
    ${badge('tag', 'Tag settings · ' + tag.name)}
    <header><h1>Which sound?</h1><p class="lead">Tap a sound to pick it. Tap ${icon('play', 14)} to listen.</p></header>
    ${notConnectedNote(tag)}
    <div class="sound-grid" role="radiogroup" aria-label="Sound">${cards}</div>

    <section class="card pad stack">
      <h2 class="h2">Record your own</h2>
      <p class="muted">Say something like “Hey, grab your phone!” Up to 5 seconds.</p>
      <button type="button" class="mic ${ui.recorder ? 'rec' : ''}" data-action="record" aria-label="${ui.recorder ? 'Stop recording' : 'Start recording'}">${icon(ui.recorder ? 'stop' : 'mic')}</button>
      <p class="center small muted">${ui.recorder ? 'Recording… tap to stop' : 'Tap to record'}</p>
      ${ui.clip ? `<div class="row">
        <button type="button" class="btn soft" data-action="play-clip">${icon('play', 18)}Play it back</button>
        <button type="button" class="btn dark" data-action="upload-clip" ${ui.uploading ? 'disabled' : ''}>${ui.uploading ? 'Sending… ' + Math.round(ui.uploading * 100) + '%' : 'Use this sound'}</button>
      </div>` : ''}
    </section>

    <section class="card pad stack">
      <h2 class="h2">How loud?</h2>
      <div class="vol-row" role="group" aria-label="Volume">
        ${[1, 2, 3, 4, 5].map((v) => `<button type="button" class="vol-dot ${d.volume >= v ? 'on' : ''}" style="height:${1.8 + v * 0.55}rem" aria-label="Volume ${v} of 5" aria-pressed="${d.volume === v}" data-action="volume" data-v="${v}">${v === d.volume ? v : ''}</button>`).join('')}
      </div>
      <div class="row small muted" style="justify-content:space-between"><span>Quiet</span><span>Loud</span></div>
    </section>

    <section class="card pad stack">
      <h2 class="h2">How many times?</h2>
      <div class="seg-row" style="--n:2">${reps.map(([v, l]) => `<button type="button" class="seg ${d.repeat === v ? 'on' : ''}" aria-pressed="${d.repeat === v}" data-action="repeat" data-v="${v}">${l}</button>`).join('')}</div>
      <label class="field"><span>Wait between beeps</span>
        <select data-bind="interval">${[5, 15, 30, 60].map((v) => `<option value="${v}" ${d.interval === v ? 'selected' : ''}>${v < 60 ? v + ' seconds' : '1 minute'}</option>`).join('')}</select></label>
    </section>

    <div class="save-bar row">
      <button type="button" class="btn soft" data-action="preview-tag">${icon('ring', 20)}Try on tag</button>
      <button type="button" class="btn primary" data-action="save-settings">Save</button>
    </div>
    </div>`;
}

// ----- Quiet times -----
function viewQuiet(tag) {
  const d = draftFor(tag, 'quiet');
  const paused = isPaused(tag) || status.get(tag.id)?.dnd;
  const slot = (q, i) => `
    <div class="quiet-slot">
      ${toggle('qon', !!q.days, d.names[i], q.days ? `${fmtMin(q.start)} – ${fmtMin(q.end)}, ${daysText(q.days)}` : 'Off', `data-i="${i}"`)}
      ${q.days ? `
      <div class="time-row">
        <label class="field"><span>From</span><input type="time" value="${toTimeInput(q.start)}" data-bind="qstart" data-i="${i}"></label>
        <label class="field"><span>To</span><input type="time" value="${toTimeInput(q.end)}" data-bind="qend" data-i="${i}"></label>
      </div>
      <div class="days" role="group" aria-label="Days">
        ${DAYS.map((ch, di) => `<button type="button" class="day ${q.days & (1 << di) ? 'on' : ''}" aria-pressed="${!!(q.days & (1 << di))}" aria-label="${DAY_NAMES[di]}" data-action="day" data-i="${i}" data-d="${di}">${ch}</button>`).join('')}
      </div>
      <label class="field"><span>Name</span><input type="text" value="${esc(d.names[i])}" data-bind="qname" data-i="${i}" maxlength="20"></label>` : ''}
    </div>`;
  return `
    ${back('#/tag/' + enc(tag.id), tag.name)}
    <div class="narrow">
    ${badge('tag', 'Tag settings · ' + tag.name)}
    <header><h1>Quiet times</h1><p class="lead">Times when ${esc(tag.name)} should not beep.</p></header>
    ${notConnectedNote(tag)}
    <section class="card pad stack">
      <h2 class="h2">Pause right now</h2>
      ${paused ? `<p class="note k-paused">${icon('moon', 18)}<span>Paused${isPaused(tag) ? ' until ' + clock(tag.pausedUntil) : ''}.</span></p>` : ''}
      <div class="seg-row">${PAUSES.map((p) => `<button type="button" class="seg" data-action="pause-one" data-min="${p.min}">${p.label}</button>`).join('')}</div>
      ${paused ? '<button type="button" class="btn good wide" data-action="pause-one" data-min="0">Turn alerts back on</button>' : ''}
    </section>

    <section class="card pad stack">
      <h2 class="h2">Every week</h2>
      ${d.quiet.map(slot).join('')}
      <h3 class="small" style="margin-top:.4rem">During quiet times the tag should</h3>
      <label class="radio-row"><input type="radio" name="qm" value="0" data-bind="quietMode" ${d.settings.quietMode === 0 ? 'checked' : ''}>Stay completely silent</label>
      <label class="radio-row"><input type="radio" name="qm" value="1" data-bind="quietMode" ${d.settings.quietMode === 1 ? 'checked' : ''}>Just flash its lights</label>
    </section>

    <section class="card pad stack">
      <label class="field"><span>Holding the tag's button pauses it for</span>
        <select data-bind="holdDnd">${[[30, '30 minutes'], [60, '1 hour'], [120, '2 hours'], [180, '3 hours'], [240, '4 hours']].map(([m, l]) => `<option value="${m}" ${d.settings.holdDnd === m ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    </section>
    <div class="save-bar"><button type="button" class="btn big primary" data-action="save-quiet">Save</button></div>
    </div>`;
}

// ----- Find -----
function findLevel(tag) {
  if (!isConnected(tag.id)) return 0;
  return Math.max(1, Math.min(5, Math.round(((status.get(tag.id)?.rssi || -92) + 97) / 9)));
}
const findTrend = () => '';
function viewFind(id) {
  const tags = store.tags;
  const sel = tagById(id) || tags.find((t) => isConnected(t.id)) || tags[0];
  if (!sel) {
    return `${zoneHead('tag', 'Find', '')}<section class="card welcome"><p class="muted">Add a tag first, then you can find it here.</p><a class="btn big primary" href="#/add">${icon('plus', 22)}Add a tag</a></section>`;
  }
  const st = status.get(sel.id);
  const connected = isConnected(sel.id);
  const level = findLevel(sel);
  const HEAT = [
    { w: 'Out of range', c: '#9C92A3', t: 'Walk around until it connects, or check where it was last seen.' },
    { w: 'Cold', c: '#1F63B5', t: 'It\'s far away. Keep walking.' },
    { w: 'Cool', c: '#2C8C8C', t: 'You\'re getting there.' },
    { w: 'Warm', c: '#C98A00', t: 'Getting closer!' },
    { w: 'Hot!', c: '#D9480F', t: 'Very close! Tap Ring it.' },
    { w: 'On fire!', c: '#C81E3A', t: 'It\'s right next to you.' },
  ][level];
  const chips = tags.map((t) => `<a class="chip ${t.id === sel.id ? 'on' : ''}" href="#/find/${enc(t.id)}" ${t.id === sel.id ? 'aria-current="true"' : ''}>${esc(t.name)}</a>`).join('');
  return `
    ${zoneHead('tag', 'Find', 'Walk around slowly. The circle heats up as you get closer.')}
    <div class="chip-row" role="group" aria-label="Which tag">${chips}</div>
    <section class="card radar-card" style="--heat:${HEAT.c}" aria-live="polite">
      <div class="radar ${connected ? '' : 'off'}" aria-hidden="true"><span class="wave"></span><span class="wave"></span><span class="wave"></span><span class="core">${icon(kindFor(sel.name))}</span></div>
      <div class="heat-word" style="color:${HEAT.c}">${HEAT.w}</div>
      <div class="meter" aria-label="Closeness ${level} of 5">${[1, 2, 3, 4, 5].map((i) => `<span class="${i <= level ? 'on' : ''}"></span>`).join('')}</div>
      <p class="muted">${HEAT.t}</p>
    </section>
    ${connected
      ? `<div class="row">
          <button type="button" class="btn big primary" data-action="ring" data-id="${esc(sel.id)}">${icon('ring', 24)}Ring it</button>
          <button type="button" class="btn big soft" data-action="flash" data-id="${esc(sel.id)}">${icon('flash', 24)}Flash it</button>
        </div>
        ${st?.alerting ? `<button type="button" class="btn big dark" data-action="stop" data-id="${esc(sel.id)}">Found it! Stop ringing</button>` : ''}`
      : `<div class="row">
          <button type="button" class="btn big dark" data-action="connect" data-id="${esc(sel.id)}">${icon('bt', 22)}Connect</button>
          <a class="btn big soft" href="#/tag/${enc(sel.id)}/lastseen">${icon('pin', 22)}Where was it?</a>
        </div>`}`;
}

// ----- Last seen -----
function viewLastSeen(tag) {
  const ls = tag.lastSeen;
  let map = `<div class="map-empty">${icon('pin', 40)}<p>No spot saved yet. When a tag goes out of range while this app is open, the spot is saved here.</p></div>`;
  if (ls) {
    const dLat = 0.004, dLng = 0.006;
    const bbox = [ls.lng - dLng, ls.lat - dLat, ls.lng + dLng, ls.lat + dLat].join('%2C');
    map = `<iframe class="map" title="Map of where ${esc(tag.name)} was last seen" loading="lazy"
      src="https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&amp;layer=mapnik&amp;marker=${ls.lat}%2C${ls.lng}"></iframe>`;
  }
  return `
    ${back('#/tag/' + enc(tag.id), tag.name)}
    <div class="narrow">
    ${badge('phone', 'Saved by my phone')}
    <header><h1>Where was it?</h1><p class="lead">${isConnected(tag.id) ? esc(tag.name) + ' is connected right now.' : 'Last seen ' + esc(timeAgo(tag.lastSeenAt || ls?.time) || 'never')}</p></header>
    <figure class="card map-wrap">${map}${ls ? `<figcaption>Where your phone was when it lost ${esc(tag.name)}${ls.acc ? ` (within about ${fmtDist(Math.round(ls.acc * 3.28))})` : ''}</figcaption>` : ''}</figure>
    <div class="row">
      ${ls ? `<a class="btn big dark" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&amp;destination=${ls.lat},${ls.lng}">${icon('walk', 22)}Directions</a>` : ''}
      <a class="btn big soft" href="#/find/${enc(tag.id)}">${icon('find', 22)}I'm nearby</a>
    </div>
    <p class="small muted">${icon('lock', 14)} Saved only on this phone. No account, nothing uploaded.</p>
    </div>`;
}

// ----- Add a tag -----
const PRESETS = [['Car keys', 'key'], ['House keys', 'key'], ['Wallet', 'wallet'], ['Backpack', 'bag'], ['TV remote', 'remote'], ['Purse', 'purse']];
function viewAdd() {
  const support = bluetoothSupport();
  if (ui.pending) {
    return `
      ${back('#/home', 'Cancel')}
      <div class="narrow">
      <header><h1>What will you clip it to?</h1><p class="lead">Pick one, or type your own name.</p></header>
      <div class="preset-grid">${PRESETS.map(([p, ic]) => `<button type="button" class="tile ${ui.pendingName === p ? 'on' : ''}" aria-pressed="${ui.pendingName === p}" data-action="preset" data-name="${p}"><span class="ti orange">${icon(ic)}</span>${p}</button>`).join('')}</div>
      <label class="field"><span>Name</span><input type="text" value="${esc(ui.pendingName)}" data-bind="pending-name" maxlength="30"></label>
      <div class="save-bar"><button type="button" class="btn big primary" data-action="finish-add">${icon('check', 22)}Done</button></div>
      </div>`;
  }
  const android = /Android/.test(navigator.userAgent);
  return `
    ${back('#/home', 'Cancel')}
    <div class="narrow">
    <header><h1>Add a tag</h1><p class="lead">Three quick steps. Keep the tag next to your phone.</p></header>
    <section class="card pad step-card"><span class="step-num">1</span>
      <div><b>Turn the tag on</b><p class="muted">Switch on the battery pack. The lights blink blue twice.</p></div></section>
    <section class="card pad step-card"><span class="step-num">2</span>
      <div><b>Pair it with your phone</b><p class="muted">${android ? 'Open Settings › Connected devices › Pair new device, and tap <b>Tether-…</b>.' : 'On your phone, open Bluetooth settings and pair <b>Tether-…</b>. (On a computer you can skip this.)'} This lets the tag warn you even when this app is closed.</p></div></section>
    <section class="card pad step-card"><span class="step-num">3</span>
      <div class="grow stack"><div><b>Connect this app</b><p class="muted">Pick your tag from the list that pops up.</p></div>
        ${support.ok
          ? `<button type="button" class="btn big primary" data-action="pick" ${ui.busy ? 'disabled' : ''}>${icon('bt', 22)}${ui.busy ? 'Connecting…' : 'Find my tag'}</button>`
          : `<p class="note k-away">${esc(support.reason)}</p>`}
      </div></section>
    <button type="button" class="btn ghost wide" data-action="demo">No tag yet? Try a pretend tag</button>
    </div>`;
}

// ----- Settings: general things -----
function viewSettings() {
  const sizes = [['m', 'Regular', '1.3rem'], ['l', 'Large', '1.7rem'], ['xl', 'Extra large', '2.1rem']];
  const anyPaused = store.tags.some((t) => isPaused(t) || status.get(t.id)?.dnd);
  const until = Math.max(0, ...store.tags.map((t) => t.pausedUntil));
  return `
    ${zoneHead('settings', 'Settings', 'Distance, pausing and how the app looks.')}
    <div class="narrow">
    <section class="card pad stack">
      <h2 class="h2">How far before it alerts?</h2>
      ${store.tags.length
        ? `<div class="setting-list inset">${store.tags.map((t) => settingRow(`#/distance/${enc(t.id)}`, 'ruler', 'orange', t.name, 'About ' + fmtDist(rssiToFeet(t.settings.threshold)) + (t.settings.motionOnly ? ', only while moving' : ''))).join('')}</div>`
        : '<p class="muted">Add a tag first.</p>'}
    </section>

    <section class="card pad stack">
      <h2 class="h2">Pause all alerts</h2>
      <p class="muted">${anyPaused ? `Paused${until > Date.now() ? ' until ' + clock(until) : ''}. Tags and your phone stay quiet.` : 'Quiet for a while, on your tags and your phone. They turn back on by themselves.'}</p>
      ${anyPaused
        ? '<button type="button" class="btn good wide" data-action="resume-all">Turn alerts back on</button>'
        : `<div class="seg-row">${PAUSES.map((p) => `<button type="button" class="seg" data-action="pause-all" data-min="${p.min}">${p.label}</button>`).join('')}</div>`}
    </section>

    <section class="card pad stack">
      <h2 class="h2">Distances in</h2>
      <div class="seg-row">${[['ft', 'Feet'], ['yd', 'Yards'], ['m', 'Meters']].map(([u, l]) => `<button type="button" class="seg ${store.units === u ? 'on' : ''}" aria-pressed="${store.units === u}" data-action="unit" data-unit="${u}">${l}</button>`).join('')}</div>
    </section>

    <section class="card pad stack">
      <h2 class="h2">Text size</h2>
      <div class="size-row">${sizes.map(([v, l, fs]) => `<button type="button" class="size-btn ${store.textSize === v ? 'on' : ''}" aria-pressed="${store.textSize === v}" data-action="text-size" data-v="${v}"><span class="aa" style="font-size:${fs}">Aa</span>${l}</button>`).join('')}</div>
    </section>

    <section class="card pad stack">
      <h2 class="h2">Put it on your home screen</h2>
      <p class="muted">${matchMedia('(display-mode: standalone)').matches ? 'Done! Open Tether from your home screen.' : 'In Chrome, tap the ⋮ menu and choose <b>Add to Home screen</b>. On a computer, click <b>Install</b> in the address bar.'}</p>
      ${ui.installPrompt ? '<button type="button" class="btn soft wide" data-action="install">Install Tether</button>' : ''}
    </section>

    <section class="card pad stack">
      <h2 class="h2">Privacy</h2>
      <p class="muted">${icon('lock', 16)} No account, no cloud. Everything stays on this phone.</p>
      <button type="button" class="btn ghost danger" data-action="forget-all">Remove all tags from this phone</button>
    </section>
    <p class="small muted center">Tether prototype 0.3</p>
    </div>`;
}

// ===========================================================================
// Render
//
// The tag reports in every second. Redrawing the page that often makes it
// jump while you scroll, so the page is only redrawn when something you can
// see has changed, never while your finger is on the screen, and always at
// the same scroll position.
// ===========================================================================
function pageKey() {
  const r = route();
  const tags = store.tags.map((t) => {
    const st = status.get(t.id);
    const s = tagStatus(t);
    return [t.id, t.name, isConnected(t.id), s.k, s.short, s.text, st?.alerting, st?.dnd, st?.quiet, st?.calibrating,
      st?.hasRecording, st?.phoneConnected, t.pausedUntil, !!t.lastSeen, t.settings.threshold, r.page === 'find' ? findLevel(t) + findTrend(t) : 0].join('|');
  });
  return [location.hash, store.textSize, store.units, ui.untilBack.size, tags.join('/')].join('#');
}

let lastKey = '';
let pendingRender = false;
// Background updates: only redraw if something visible changed, and not mid-scroll
function softRender() {
  if (ui.touching || Date.now() - ui.lastScroll < 900 || ui.editing || ui.recorder) { pendingRender = true; return; }
  const f = document.activeElement;
  if (f && /^(INPUT|SELECT|TEXTAREA)$/.test(f.tagName) && !['checkbox', 'radio'].includes(f.type)) { pendingRender = true; return; }
  if (pageKey() === lastKey) return;
  render();
}
function flushRender() { if (pendingRender) { pendingRender = false; softRender(); } }

function render() {
  pendingRender = false;
  document.documentElement.dataset.size = store.textSize;
  const r = route();
  const tag = r.id ? tagById(r.id) : null;
  if (r.page !== 'add') ui.pending = null;
  if ((r.page === 'tag' || r.page === 'distance') && !tag) { go(r.page === 'distance' ? '#/settings' : '#/home'); return; }
  let html, zone;
  if (r.page === 'tag') {
    zone = 'tag';
    if (r.sub === 'sound') html = viewSound(tag);
    else if (r.sub === 'quiet') html = viewQuiet(tag);
    else if (r.sub === 'lastseen') html = viewLastSeen(tag);
    else { ui.draftKey = ''; html = viewTag(tag); }
  } else if (r.page === 'distance') { zone = 'settings'; html = viewDistance(tag); }
  else {
    ui.draftKey = '';
    if (r.page === 'phone') { zone = 'phone'; html = viewPhone(); }
    else if (r.page === 'settings') { zone = 'settings'; html = viewSettings(); }
    else if (r.page === 'add') { zone = 'tag'; html = viewAdd(); }
    else if (r.page === 'find') { zone = 'tag'; html = viewFind(r.id); }
    else { zone = 'tag'; html = viewHome(); }
  }
  document.body.dataset.zone = zone;

  const view = $('#view');
  const samePage = ui.renderedHash === location.hash;
  const y = window.scrollY;
  const openDetails = [...view.querySelectorAll('details[open] > summary')].map((s) => s.textContent.trim());
  const focusedBind = document.activeElement?.dataset?.bind;
  const focusedAction = document.activeElement?.dataset?.action;
  view.innerHTML = html;
  if (samePage) {
    view.querySelectorAll('details > summary').forEach((s) => { if (openDetails.includes(s.textContent.trim())) s.parentElement.open = true; });
    if (focusedBind) view.querySelector(`[data-bind="${focusedBind}"]`)?.focus({ preventScroll: true });
    else if (focusedAction && !ui.modal) view.querySelector(`[data-action="${focusedAction}"]`)?.focus({ preventScroll: true });
    window.scrollTo(0, y);
  }
  ui.renderedHash = location.hash;
  lastKey = pageKey();

  const names = [...ui.untilBack].map((id) => tagById(id)?.name).filter(Boolean);
  $('#banner').innerHTML = names.length
    ? `<div class="banner" role="status"><span class="bell">${icon('ring', 24)}</span><span class="grow">Alerting until ${esc(names.join(' and '))} ${names.length === 1 ? 'is' : 'are'} back</span><button type="button" class="btn" data-action="stop-until-back">Stop</button></div>`
    : '';
  const tab = zone === 'tag' ? 'home' : zone;
  document.querySelectorAll('[data-tab]').forEach((a) => {
    const on = a.dataset.tab === tab;
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}

// ===========================================================================
// Button actions
// ===========================================================================
const actions = {
  async connect(el) {
    const tag = tagById(el.dataset.id);
    el.disabled = true;
    try { await connectTag(tag); toast('Connected to ' + tag.name + '!'); }
    catch (e) { if (e.name !== 'NotFoundError') toast('Could not connect. Make sure the tag is on and close by.'); render(); }
  },
  disconnect(el) { userClosed.add(el.dataset.id); live.get(el.dataset.id)?.disconnect(); render(); },
  ring(el) { ringTag(tagById(el.dataset.id)); },
  async 'test-alert'(el) {
    const t = tagById(el.dataset.id);
    ui.lastRing[t.id] = Date.now();
    if (await command(t, CMD.ring)) toast('Listen! ' + t.name + ' should beep and flash now.');
  },
  async stop(el) { await command(tagById(el.dataset.id), CMD.stop); },
  async flash(el) { await command(tagById(el.dataset.id), CMD.flash); },
  'demo-loss'(el) { live.get(el.dataset.id)?.simulateLoss?.(); },

  // Pausing
  'open-pause'(el) { openModal({ type: 'pause', id: el.dataset.id || null }); },
  async 'resume-all'() { await pauseMany(store.tags, 0); },
  async resume(el) { await pauseMany([tagById(el.dataset.id)], 0); },
  async 'pause-all'(el) { await pauseMany(store.tags, Number(el.dataset.min)); },
  'phone-sound'(el) { store.phone.sound = el.dataset.v; save(); if (el.dataset.v !== 'off') playPattern(store.phone.tone, 4); render(); },
  'test-phone'() {
    const ph = store.phone;
    if (ph.vibrate) navigator.vibrate?.([300, 120, 300]);
    if (ph.notify) notify('This is a test', 'This is how Tether alerts you.');
    if (ph.sound === 'loud') startAlarm(ph.tone, { limitMs: 6000 });
    else if (ph.sound === 'short') playPattern(ph.tone, 4);
    if (ph.popup) toast('This is how your phone will alert you.', 'Stop', stopAlarm);
    else toast('Test sent. The big on-screen alert is turned off.');
  },
  async 'pause-one'(el) { await pauseMany([tagById(route().id)], Number(el.dataset.min)); },

  // Popup buttons
  async 'm-silence'() {
    const tag = tagById(ui.modal.id);
    stopAlarm();
    closeModal();
    if (isConnected(tag.id)) await command(tag, CMD.stop);
    toast('Alert silenced.');
  },
  'm-until-back'() {
    const tag = tagById(ui.modal.id);
    ui.untilBack.add(tag.id);
    startAlarm(phoneTone(), { gapMs: 4000, limitMs: 60 * 60000 });
    closeModal();
    render();
    toast('Your phone will keep alerting until ' + tag.name + ' is back.');
  },
  async 'm-pause'(el) {
    const tag = tagById(ui.modal.id);
    stopAlarm();
    closeModal();
    if (isConnected(tag.id)) await command(tag, CMD.stop);
    await pauseMany([tag], Number(el.dataset.min));
  },
  async 'm-pause-sheet'(el) {
    const tags = ui.modal.id ? [tagById(ui.modal.id)] : store.tags;
    closeModal();
    await pauseMany(tags, Number(el.dataset.min));
  },
  'm-found'() { stopAlarm(); closeModal(); },
  'm-close'() { closeModal(); },
  'stop-until-back'() { ui.untilBack.clear(); stopAlarm(); render(); },

  // Tag alert choice
  async 'quick-style'(el) {
    const tag = tagById(route().id);
    tag.settings = { ...tag.settings, style: Number(el.dataset.v) };
    await saveTagNow(tag, Number(el.dataset.v) === 5 ? 'The tag will stay quiet.' : 'Saved!');
  },
  async 'motion-off'() {
    const tag = tagById(route().id);
    tag.settings = { ...tag.settings, motionOnly: false };
    await saveTagNow(tag, 'Done! The tag beeps even when it sits still.');
  },
  async 'quiet-off'() {
    const tag = tagById(route().id);
    tag.quiet = tag.quiet.map((q) => ({ ...q, days: 0 }));
    await saveTagNow(tag, 'Quiet times turned off.');
  },

  // Remove
  remove(el) {
    const tag = tagById(el.dataset.id);
    if (!confirm(`Remove ${tag.name}? You can add it again later.`)) return;
    userClosed.add(tag.id);
    live.get(tag.id)?.disconnect();
    live.delete(tag.id);
    store.tags = store.tags.filter((t) => t.id !== tag.id);
    save();
    go('#/home');
  },
  'forget-all'() {
    if (!confirm('Remove all tags and saved spots from this phone?')) return;
    for (const [id, c] of live) { userClosed.add(id); c.disconnect(); }
    live.clear();
    store.tags = [];
    save();
    go('#/home'); render();
  },

  // Settings
  unit(el) { store.units = el.dataset.unit; save(); render(); },
  'text-size'(el) { store.textSize = el.dataset.v; save(); render(); },
  async notif() { await Notification.requestPermission(); render(); },
  async install() { ui.installPrompt?.prompt(); ui.installPrompt = null; render(); },

  // How far
  zone(el) { ui.draft.threshold = feetToRssi(Number(el.dataset.feet)); render(); },
  async calibrate() {
    const tag = tagById(route().id);
    if (await command(tag, CMD.calibrate)) toast('Now walk to where you want the beep, and press the tag\'s button once.');
  },

  // Sound
  volume(el) { ui.draft.volume = Number(el.dataset.v); playPattern(ui.draft.tone === 6 ? 0 : ui.draft.tone, ui.draft.volume); render(); },
  repeat(el) { ui.draft.repeat = Number(el.dataset.v); render(); },
  listen(el) {
    const t = Number(el.dataset.tone);
    if (t === 6 && ui.clip) playPcm(ui.clip.pcm, ui.clip.rate);
    else playPattern(t === 6 ? 0 : t, ui.draft?.volume || 3);
  },
  async 'preview-tag'() { await command(tagById(route().id), CMD.preview, ui.draft.tone, ui.draft.volume); },
  async 'save-settings'() {
    const tag = tagById(route().id);
    tag.settings = { ...ui.draft };
    const fromSettings = route().page === 'distance';
    await saveTagNow(tag, 'Saved!');
    go(fromSettings ? '#/settings' : '#/tag/' + enc(tag.id));
  },
  async 'save-quiet'() {
    const tag = tagById(route().id);
    tag.quiet = ui.draft.quiet.map((q) => ({ days: q.days, start: q.start, end: q.end }));
    tag.quietNames = [...ui.draft.names];
    tag.settings = { ...tag.settings, holdDnd: ui.draft.settings.holdDnd, quietMode: ui.draft.settings.quietMode };
    await saveTagNow(tag, 'Saved!');
    go('#/tag/' + enc(tag.id));
  },
  day(el) { ui.draft.quiet[Number(el.dataset.i)].days ^= (1 << Number(el.dataset.d)); render(); },
  async record() {
    if (ui.recorder) {
      const r = ui.recorder;
      ui.recorder = null;
      try { ui.clip = await r.stop(); playPcm(ui.clip.pcm, ui.clip.rate); } catch { toast('Recording didn\'t work. Try again.'); }
      render();
      return;
    }
    try {
      ui.recorder = new Recorder();
      await ui.recorder.start();
      render();
      setTimeout(() => { if (ui.recorder) actions.record(); }, 5100);
    } catch { ui.recorder = null; toast('Please allow the microphone to record.'); render(); }
  },
  'play-clip'() { if (ui.clip) playPcm(ui.clip.pcm, ui.clip.rate); },
  async 'upload-clip'() {
    const tag = tagById(route().id);
    const conn = live.get(tag.id);
    if (!conn?.connected) { toast(tag.name + ' is not connected right now.'); return; }
    ui.uploading = 0.01; render();
    try {
      await conn.uploadClip(ui.clip.pcm, ui.clip.rate, (p) => { ui.uploading = p; render(); });
      ui.draft.tone = 6;
      toast('Your sound is on the tag! Tap Save to use it.');
    } catch { toast('Could not send the sound. Move closer and try again.'); }
    ui.uploading = 0; render();
  },

  // Adding
  async pick() {
    ui.busy = 'pick'; render();
    try {
      const conn = await TagConnection.pick();
      await conn.connect();
      const existing = tagById(conn.id);
      if (existing) { attach(existing, conn); ui.busy = ''; toast(existing.name + ' is already added. Connected!'); go('#/tag/' + enc(existing.id)); return; }
      ui.pending = { conn, deviceName: conn.name, demo: false, fromTag: await conn.readSettings() };
      ui.pendingName = 'Car keys';
    } catch (e) {
      if (e.name !== 'NotFoundError') toast('Could not connect. Make sure the tag is on and close by.');
    }
    ui.busy = ''; render();
  },
  async demo() {
    const n = store.tags.filter((t) => t.demo).length + 1;
    const conn = new DemoTag('demo-' + Date.now(), 'Tether-DEMO' + n);
    await conn.connect();
    ui.pending = { conn, deviceName: conn.name, demo: true, fromTag: await conn.readSettings() };
    ui.pendingName = 'Car keys';
    if (route().page !== 'add') go('#/add'); else render();
  },
  preset(el) { ui.pendingName = el.dataset.name; render(); },
  'finish-add'() {
    const p = ui.pending;
    const tag = newTag(p.conn.id, p.deviceName, p.demo);
    tag.name = (ui.pendingName || 'My tag').trim() || 'My tag';
    tag.settings = p.fromTag.settings;
    tag.quiet = p.fromTag.quiet;
    store.tags.push(tag);
    save();
    attach(tag, p.conn);
    ui.pending = null;
    go('#/tag/' + enc(tag.id));
    openModal({ type: 'added', id: tag.id });
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().then(render);
  },
};

// ===========================================================================
// Typing, sliders, switches
// ===========================================================================
function onInput(el, final) {
  const b = el.dataset.bind;
  const tag = tagById(route().id);
  const i = Number(el.dataset.i);
  switch (b) {
    case 'feet': {
      ui.draft.threshold = feetToRssi(Number(el.value));
      const r = document.getElementById('dist-readout');
      if (r) r.textContent = fmtDist(Number(el.value));
      if (final) render();
      return;
    }
    case 'tone': ui.draft.tone = Number(el.value); render(); return;
    case 'interval': ui.draft.interval = Number(el.value); return;
    case 'holdDnd': ui.draft.settings.holdDnd = Number(el.value); return;
    case 'quietMode': ui.draft.settings.quietMode = Number(el.value); return;
    case 'qname': ui.draft.names[i] = el.value; return;
    case 'qon': {
      const q = ui.draft.quiet[i];
      if (el.checked) q.days = q.lastDays || 0x7f; else { q.lastDays = q.days; q.days = 0; }
      render(); return;
    }
    case 'qstart': if (el.value) ui.draft.quiet[i].start = fromTimeInput(el.value); return;
    case 'qend': if (el.value) ui.draft.quiet[i].end = fromTimeInput(el.value); return;
    case 'draft-motionOnly': ui.draft.motionOnly = el.checked; return;
    case 'tag-motion':
      tag.settings = { ...tag.settings, motionOnly: el.checked };
      saveTagNow(tag, el.checked ? 'The tag only beeps while it\'s moving.' : 'The tag beeps even when it sits still.');
      return;
    case 'ph-popup': store.phone.popup = el.checked; save(); return;
    case 'ph-vibrate': store.phone.vibrate = el.checked; save(); if (el.checked) navigator.vibrate?.(200); return;
    case 'ph-tone': store.phone.tone = Number(el.value); save(); playPattern(store.phone.tone, 4); render(); return;
    case 'ph-notify':
      if (el.checked && 'Notification' in window && Notification.permission !== 'granted') {
        Notification.requestPermission().then((p) => { store.phone.notify = p === 'granted'; save(); render(); });
        return;
      }
      store.phone.notify = el.checked; save(); return;
    case 'ph-location':
      store.phone.saveLocation = el.checked; save();
      if (el.checked && 'geolocation' in navigator) navigator.geolocation.getCurrentPosition(() => {}, () => toast('Location is blocked, so spots can\'t be saved.'));
      return;
    case 'rename': if (final) { tag.name = el.value.trim() || tag.name; save(); render(); } return;
    case 'pending-name': ui.pendingName = el.value; return;
  }
}

// ===========================================================================
// Start
// ===========================================================================
function start() {
  document.addEventListener('click', (e) => {
    if (e.target.matches('[data-backdrop]') && ui.modal && ui.modal.type !== 'alert' && ui.modal.type !== 'phone') { closeModal(); return; }
    const el = e.target.closest('[data-action]');
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    actions[el.dataset.action]?.(el);
  });
  document.addEventListener('input', (e) => { if (e.target.dataset.bind) { ui.editing = true; onInput(e.target, false); } });
  document.addEventListener('change', (e) => { if (e.target.dataset.bind) { ui.editing = false; onInput(e.target, true); } });
  document.addEventListener('focusout', () => { ui.editing = false; });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !ui.modal) return;
    if (ui.modal.type === 'alert') actions['m-silence']();
    else if (ui.modal.type === 'phone') actions['m-found']();
    else closeModal();
  });
  window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); ui.installPrompt = e; });
  // Keep "paused until" and "last seen" times fresh
  setInterval(() => { if (!ui.modal) softRender(); }, 30000);
  // Never redraw under a finger or mid-scroll; catch up right after
  ui.touching = false; ui.lastScroll = 0;
  addEventListener('touchstart', () => { ui.touching = true; }, { passive: true });
  const touchEnd = () => { ui.touching = false; setTimeout(flushRender, 950); };
  addEventListener('touchend', touchEnd, { passive: true });
  addEventListener('touchcancel', touchEnd, { passive: true });
  addEventListener('scroll', () => { ui.lastScroll = Date.now(); clearTimeout(ui.scrollT); ui.scrollT = setTimeout(flushRender, 950); }, { passive: true });
  document.addEventListener('focusout', () => setTimeout(flushRender, 300));

  // Pretend tags come back each time; real tags reconnect if Chrome remembers them
  for (const tag of store.tags) {
    if (tag.demo) {
      const d = new DemoTag(tag.id, tag.deviceName);
      attach(tag, d);
      d.connect().then(() => afterConnect(tag)).then(render);
    }
  }
  const canRemember = !!navigator.bluetooth?.getDevices;
  TagConnection.remembered().then((known) => {
    for (const conn of known) {
      const tag = tagById(conn.id);
      if (!tag || live.has(tag.id)) continue;
      attach(tag, conn);
      conn.connect().then(() => afterConnect(tag)).then(render).catch(() => keepTrying(tag));
    }
    ui.needTap = store.tags.some((t) => !t.demo && !live.has(t.id));
    if (ui.needTap && !canRemember) render();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    ui.visibleSince = Date.now();
    for (const tag of store.tags) if (live.has(tag.id) && !isConnected(tag.id) && !userClosed.has(tag.id)) keepTrying(tag);
    wakeUp();
    softRender();
  });
  setInterval(watchdog, 2000);

  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  render();
}

start();
