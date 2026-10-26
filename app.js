// Tether app: screens, saved data and wiring to the tag.
import {
  TagConnection, DemoTag, bluetoothSupport, TONES, STYLES, DEFAULT_SETTINGS, DEFAULT_QUIET,
  feetToRssi, rssiToFeet, CMD,
} from './ble.js';
import { playPattern, startAlarm, stopAlarm, alarmRunning, Recorder, playPcm } from './sounds.js';

// ---------------------------------------------------------------------------
// Saved data (stays on this device only)
// ---------------------------------------------------------------------------
const STORE_KEY = 'tether-v1';
const store = load();
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && Array.isArray(s.tags)) return s;
  } catch { /* first run */ }
  return { tags: [], units: 'ft' };
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch { /* storage full or blocked */ }
}
const tagById = (id) => store.tags.find((t) => t.id === id);

function newTag(id, deviceName, demo) {
  return {
    id, deviceName, demo, name: 'My tag',
    settings: { ...DEFAULT_SETTINGS },
    quiet: DEFAULT_QUIET.map((q) => ({ ...q })),
    quietNames: ['Night', 'Meeting'],
    phone: { leave: true, alarm: false, saveLocation: true },
    lastSeen: null, needsSync: false, addedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Live connections
// ---------------------------------------------------------------------------
const live = new Map();     // id -> TagConnection | DemoTag
const status = new Map();   // id -> latest status from the tag
const lastEventCount = new Map();
const userClosed = new Set();
const reconnecting = new Set();
const rssiHistory = new Map();

function isConnected(id) { return !!live.get(id)?.connected; }

function attach(tag, conn) {
  live.set(tag.id, conn);
  conn.addEventListener('status', (e) => onStatus(tag.id, e.detail));
  conn.addEventListener('disconnected', () => onDisconnected(tag.id));
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
  if (tag.needsSync) await pushToTag(tag);
  else {
    const fromTag = await conn.readSettings();
    tag.settings = fromTag.settings;
    tag.quiet = fromTag.quiet;
  }
  save();
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

async function command(tag, ...bytes) {
  const conn = live.get(tag.id);
  if (!conn?.connected) { toast('Connect to ' + tag.name + ' first.'); return false; }
  try { await conn.command(...bytes); return true; } catch (e) { toast('Could not reach the tag: ' + e.message); return false; }
}

function onStatus(id, st) {
  const tag = tagById(id);
  if (!tag) return;
  status.set(id, st);
  const hist = rssiHistory.get(id) || [];
  hist.push(st.rssi); if (hist.length > 6) hist.shift();
  rssiHistory.set(id, hist);

  const prev = lastEventCount.get(id);
  lastEventCount.set(id, st.eventCounter);
  if (prev !== undefined && prev !== st.eventCounter) {
    if (st.event === 1) {
      startAlarm(0);
      notify('Here is your phone', tag.name + ' asked your phone to ring.');
      toast('Your tag is ringing this phone. Tap Stop to silence it.', 'Stop', stopAlarm);
    }
    if (st.event === 2) {
      tag.settings.threshold = st.threshold;
      if (ui.draft) ui.draft.threshold = st.threshold;
      save();
      toast('Walk test saved: about ' + fmtDist(rssiToFeet(st.threshold)) + '.');
    }
  }
  const f = document.activeElement;
  const typing = f && /^(INPUT|SELECT|TEXTAREA)$/.test(f.tagName) && f.type !== 'checkbox' && f.type !== 'radio';
  if (!ui.editing && !typing && !ui.recorder) render();
}

function onDisconnected(id) {
  const tag = tagById(id);
  status.delete(id);
  if (!tag) return;
  if (userClosed.has(id)) { render(); return; }
  tag.lastSeenAt = Date.now();
  if (tag.phone.saveLocation && 'geolocation' in navigator) {
    navigator.geolocation.getCurrentPosition((p) => {
      tag.lastSeen = { lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy), time: Date.now() };
      save(); render();
    }, () => {}, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  } else {
    tag.lastSeen = tag.lastSeen ? { ...tag.lastSeen, time: Date.now() } : null;
  }
  save();
  if (tag.phone.leave) {
    notify(tag.name + ' is out of range', 'Did you leave it behind?');
    if (tag.phone.alarm) {
      startAlarm(tag.settings.tone === 6 ? 5 : tag.settings.tone);
      toast(tag.name + ' is out of range.', 'Stop alarm', stopAlarm);
    } else {
      playPattern(1, 4);
      if (navigator.vibrate) navigator.vibrate([300, 150, 300]);
      toast(tag.name + ' is out of range.');
    }
  }
  render();
  keepTrying(tag);
}

// While the app is open, quietly try to reconnect when the tag comes back
async function keepTrying(tag) {
  if (reconnecting.has(tag.id) || tag.demo) return;
  reconnecting.add(tag.id);
  while (tagById(tag.id) && !isConnected(tag.id) && !userClosed.has(tag.id)) {
    await new Promise((r) => setTimeout(r, 10000));
    try {
      await Promise.race([live.get(tag.id).connect(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))]);
      notify(tag.name + ' is back', 'Back in range.');
      if (tag.needsSync) await pushToTag(tag);
      render();
    } catch { /* still away */ }
  }
  reconnecting.delete(tag.id);
}

// ---------------------------------------------------------------------------
// Little helpers
// ---------------------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel) => document.querySelector(sel);

function fmtDist(feet) {
  if (store.units === 'yd') return Math.round(feet / 3) + ' yd';
  if (store.units === 'm') return Math.round(feet * 0.3048) + ' m';
  return feet + ' ft';
}
function fmtMin(min) {
  const h = Math.floor(min / 60), m = min % 60;
  const ap = h >= 12 ? 'PM' : 'AM';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${ap}`;
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
function timeAgo(t) {
  if (!t) return '';
  const d = new Date(t), now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return 'today, ' + time;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + time;
}
function zoneFor(feet) {
  if (feet < 30) return { name: 'Close', hint: 'Alerts as soon as you step away' };
  if (feet < 60) return { name: 'Room', hint: 'About when you leave the room' };
  if (feet < 120) return { name: 'House', hint: 'About when you leave the house' };
  return { name: 'Far', hint: 'Yard, parking lot or open space' };
}
function bars(rssi) {
  if (!rssi) return 0;
  return Math.max(0, Math.min(4, Math.round((rssi + 95) / 10)));
}

const ICONS = {
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/>',
  remote: '<rect x="7" y="2" width="10" height="20" rx="3"/><circle cx="12" cy="7" r="1.5"/><path d="M10 12h4M10 15h4M10 18h4"/>',
  bag: '<path d="M6 9a6 6 0 0 1 12 0v10a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2z"/><path d="M9 4.5V3h6v1.5M9 14h6v4H9z"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M16 14h2"/>',
  tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="8" cy="8" r="1.5"/>',
  find: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  ring: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/>',
  pin: '<path d="M12 21s-7-6.5-7-12a7 7 0 0 1 14 0c0 5.5-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  play: '<path d="M8 5l11 7-11 7z" fill="currentColor" stroke="none"/>',
  bt: '<path d="M7 7l10 10-5 4V3l5 4L7 17"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
};
const icon = (name, size = 22, extra = '') =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${ICONS[name]}</svg>`;
function kindFor(name) {
  const n = name.toLowerCase();
  if (/key|car/.test(n)) return 'key';
  if (/remote|tv/.test(n)) return 'remote';
  if (/bag|pack|purse|luggage|suitcase/.test(n)) return 'bag';
  if (/wallet/.test(n)) return 'wallet';
  return 'tag';
}
function signalSvg(n, color = 'var(--blue)') {
  const r = [0, 1, 2, 3].map((i) =>
    `<rect x="${1 + i * 6}" y="${14 - i * 4}" width="4" height="${6 + i * 4}" rx="1" fill="${i < n ? color : 'var(--line-strong)'}"/>`).join('');
  return `<svg width="24" height="20" viewBox="0 0 24 20" role="img" aria-label="Signal ${n} of 4">${r}</svg>`;
}

// Tag summary for lists
function tagState(tag) {
  const st = status.get(tag.id);
  if (isConnected(tag.id)) {
    if (st?.dnd) return { tone: 'muted', icon: 'moon', text: `Do not disturb · ${st.dndMinutes} min left` };
    if (st?.alerting) return { tone: 'alert', text: 'Alerting now' };
    return { tone: 'ok', text: 'Connected · ' + (bars(st?.rssi) >= 3 ? 'close by' : 'nearby') };
  }
  if (tag.lastSeenAt || tag.lastSeen) return { tone: 'alert', text: 'Not connected · seen ' + timeAgo(tag.lastSeenAt || tag.lastSeen?.time) };
  return { tone: 'muted', text: 'Not connected' };
}

// ---------------------------------------------------------------------------
// Toasts and notifications
// ---------------------------------------------------------------------------
function toast(text, actionLabel, action) {
  const box = $('#toast');
  box.innerHTML = `<span>${esc(text)}</span>${actionLabel ? `<button type="button" class="toast-btn">${esc(actionLabel)}</button>` : ''}`;
  box.hidden = false;
  box.querySelector('.toast-btn')?.addEventListener('click', () => { action?.(); box.hidden = true; });
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { box.hidden = true; }, actionLabel ? 15000 : 4500);
}
async function notify(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) reg.showNotification(title, { body, icon: 'icons/icon-192.png', tag: title, vibrate: [300, 100, 300] });
    else new Notification(title, { body });
  } catch { /* notifications blocked */ }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
const ui = { draft: null, draftKey: '', editing: false, recorder: null, clip: null, uploading: 0, busy: '' };

function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return { page: parts[0] || 'tags', id: parts[1] ? decodeURIComponent(parts[1]) : null, sub: parts[2] || null };
}
function go(hash) { location.hash = hash; }

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

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------
function backLink(href, label) {
  return `<a class="back" href="${href}">${icon('back', 20)}<span>${esc(label)}</span></a>`;
}
function syncNote(tag) {
  if (isConnected(tag.id)) return '';
  return `<p class="note warn">${icon('bt', 16)} Not connected. Changes are saved here and sent to the tag when it connects.</p>`;
}

function viewTags() {
  const support = bluetoothSupport();
  const cards = store.tags.map((tag) => {
    const s = tagState(tag);
    const st = status.get(tag.id);
    const kind = kindFor(tag.name);
    const connected = isConnected(tag.id);
    return `
      <article class="card tag-card">
        <a class="tag-row" href="#/tag/${encodeURIComponent(tag.id)}">
          <span class="tag-icon ${s.tone}">${icon(kind, 24)}</span>
          <span class="grow">
            <span class="title">${esc(tag.name)}</span>
            <span class="state ${s.tone}">${s.icon ? icon(s.icon, 14) : '<span class="dot"></span>'}${esc(s.text)}</span>
          </span>
          ${connected ? signalSvg(bars(st?.rssi)) : icon('chev', 18, 'class="muted-icon"')}
        </a>
        <div class="chips">
          <span class="chip">Distance: about ${fmtDist(rssiToFeet(tag.settings.threshold))}</span>
          <span class="chip">Sound: ${esc(TONES[tag.settings.tone]?.name)}</span>
          ${tag.demo ? '<span class="chip">Demo</span>' : ''}
        </div>
        ${connected ? '' : `<div class="row-btns">
          <button type="button" class="btn dark" data-action="connect" data-id="${esc(tag.id)}">${icon('bt', 18)}Connect</button>
          ${tag.lastSeen ? `<a class="btn outline" href="#/tag/${encodeURIComponent(tag.id)}/lastseen">${icon('pin', 18)}Last seen</a>` : ''}
        </div>`}
        ${st?.dnd ? `<button type="button" class="btn outline" data-action="dnd-off" data-id="${esc(tag.id)}">Turn alerts back on</button>` : ''}
      </article>`;
  }).join('');

  return `
    <header class="page-head">
      <div>
        <span class="brand">Tether</span>
        <h1>My tags</h1>
        <p class="sub">${store.tags.length ? store.tags.length + (store.tags.length === 1 ? ' tag' : ' tags') + ' on this device' : 'No tags yet'}</p>
      </div>
      <a class="round-btn" href="#/add" aria-label="Add a tag">${icon('plus', 22)}</a>
    </header>
    ${support.ok ? '' : `<p class="note warn">${esc(support.reason)} You can still try the demo tag.</p>`}
    ${cards || `<section class="card empty">
        <h2>Add your first tag</h2>
        <p>Pair your Circuit Playground tag, or try a demo tag to see how everything works.</p>
        <a class="btn accent" href="#/add">${icon('plus', 18)}Add a tag</a>
      </section>`}`;
}

function viewDetail(tag) {
  const st = status.get(tag.id);
  const connected = isConnected(tag.id);
  const s = tag.settings;
  const quietOn = tag.quiet.filter((q) => q.days);
  const quietText = quietOn.length ? quietOn.map((q) => `${fmtMin(q.start)} – ${fmtMin(q.end)}`)[0] : 'no quiet times';
  return `
    ${backLink('#/tags', 'My tags')}
    <section class="hero">
      <div class="hero-top">
        <span class="hero-icon">${icon(kindFor(tag.name), 26)}</span>
        <div>
          <h1>${esc(tag.name)}</h1>
          <span class="hero-state">${esc(tagState(tag).text)}</span>
        </div>
      </div>
      <div class="stats">
        <div><span>Signal</span><strong>${connected && st?.rssi ? st.rssi + ' dBm' : '—'}</strong></div>
        <div><span>Paired phone</span><strong>${connected ? (st?.phoneConnected ? 'Nearby' : 'Not linked') : '—'}</strong></div>
        <div><span>Moving</span><strong>${connected ? (st?.moving ? 'Yes' : 'No') : '—'}</strong></div>
      </div>
      <div class="row-btns">
        ${connected
          ? `<button type="button" class="btn accent" data-action="ring" data-id="${esc(tag.id)}">${icon('ring', 18)}Ring tag</button>
             <a class="btn hero-alt" href="#/tag/${encodeURIComponent(tag.id)}/quiet">${icon('moon', 18)}Snooze</a>`
          : `<button type="button" class="btn accent" data-action="connect" data-id="${esc(tag.id)}">${icon('bt', 18)}Connect</button>`}
      </div>
    </section>

    ${leaveBehindSection(tag, st, connected)}

    <h2 class="section">More tag settings</h2>
    <nav class="list" aria-label="Tag alert settings">
      <a href="#/tag/${encodeURIComponent(tag.id)}/distance"><span class="grow"><b>Alert distance</b><small>About ${fmtDist(rssiToFeet(s.threshold))}${s.motionOnly ? ' · only while moving' : ''}</small></span>${icon('chev', 18)}</a>
      <a href="#/tag/${encodeURIComponent(tag.id)}/sound"><span class="grow"><b>Alert sound</b><small>${esc(TONES[s.tone]?.name)} · volume ${s.volume} · ${s.repeat ? 'repeat ' + s.repeat + '×' : 'until stopped'}</small></span>${icon('chev', 18)}</a>
      <a href="#/tag/${encodeURIComponent(tag.id)}/quiet"><span class="grow"><b>Silent &amp; quiet time</b><small>${esc(STYLES[s.style]?.name)} · ${esc(quietText)}</small></span>${icon('chev', 18)}</a>
    </nav>

    <h2 class="section">Also alert on this phone</h2>
    <div class="list">
      ${toggleRow('phone-leave', tag.phone.leave, 'Notify me if this tag leaves', 'While this app is open. Background alerts come with the installed app version.')}
      ${toggleRow('phone-alarm', tag.phone.alarm, 'Play an alarm, not just a notification', 'Keeps ringing until you stop it')}
      ${toggleRow('phone-location', tag.phone.saveLocation, 'Save where it was last seen', 'Stored only on this device')}
    </div>

    <h2 class="section">Tag button</h2>
    <div class="list static">
      <div><b>1 press</b><span>Stop the alert</span></div>
      <div><b>2 presses</b><span>Ring this phone (app open)</span></div>
      <div><b>Press and hold</b><span>Do not disturb, ${s.holdDnd >= 60 ? s.holdDnd / 60 + ' hr' : s.holdDnd + ' min'}</span></div>
    </div>

    <h2 class="section">Name</h2>
    <div class="card pad">
      <label class="field"><span>What it's attached to</span>
        <input type="text" value="${esc(tag.name)}" data-bind="rename" maxlength="30"></label>
      <p class="small muted">Bluetooth name: ${esc(tag.deviceName)}${tag.demo ? ' (demo)' : ''}</p>
    </div>

    ${tag.demo && connected ? `<section class="card pad stack"><b>Demo</b><p class="small muted">See what happens when a tag goes out of range while the app is open.</p>
      <button type="button" class="btn outline" data-action="demo-loss" data-id="${esc(tag.id)}">Pretend I walked away</button></section>` : ''}

    <div class="row-btns end">
      ${connected ? `<button type="button" class="btn ghost" data-action="disconnect" data-id="${esc(tag.id)}">Disconnect</button>` : ''}
      <button type="button" class="btn ghost danger" data-action="remove" data-id="${esc(tag.id)}">Remove this tag</button>
    </div>`;
}

// "When you leave your phone behind": the tag's own alert, front and center,
// plus a check of everything that would keep the tag silent.
const QUICK_STYLES = [
  { v: 0, label: 'Beep' },
  { v: 2, label: 'Flash' },
  { v: 4, label: 'Beep + flash' },
  { v: 5, label: 'Off' },
];
function leaveBehindSection(tag, st, connected) {
  const s = tag.settings;
  const quick = QUICK_STYLES.some((q) => q.v === s.style) ? s.style : null;
  const styleBtns = QUICK_STYLES.map((q) =>
    `<button type="button" class="seg ${quick === q.v ? 'on' : ''}" aria-pressed="${quick === q.v}" data-action="quick-style" data-v="${q.v}">${q.label}</button>`).join('');

  const problems = [];
  if (connected && st && !tag.demo) {
    if (!st.phoneConnected) problems.push(`<li><b>The tag isn't paired with this phone yet</b>, so it can't tell when you walk away. On your phone open Settings › Connected devices › Pair new device and tap <b>${esc(tag.deviceName)}</b>.</li>`);
    if (st.quiet) problems.push(`<li><b>Quiet time is on right now</b>, so the tag stays silent. <button type="button" class="link-btn" data-action="quiet-off">Turn quiet times off</button></li>`);
    if (st.dnd) problems.push(`<li><b>Do not disturb is on</b> (${st.dndMinutes} min left). <button type="button" class="link-btn" data-action="dnd-off" data-id="${esc(tag.id)}">Turn alerts back on</button></li>`);
  }
  if (s.style === 5) problems.push('<li><b>The tag alert is off.</b> Pick Beep, Flash or Beep + flash above.</li>');

  let check;
  if (!connected) check = '<p class="small muted">Connect to check that the tag is ready to alert.</p>';
  else if (problems.length) check = `<div class="check warn"><b>The tag won't alert right now:</b><ul>${problems.join('')}</ul></div>`;
  else check = `<div class="check ok-box">${icon('ring', 16)}<span><b>Ready.</b> The tag will ${s.style === 2 ? 'flash' : s.style === 4 ? 'beep and flash' : 'beep'} when you get too far from your phone.</span></div>`;

  return `
    <h2 class="section">When you leave your phone behind</h2>
    <section class="card pad stack">
      <div>
        <b>The tag will</b>
        <div class="segmented four tight" role="group" aria-label="Tag alert">${styleBtns}</div>
        ${quick === null ? `<p class="small muted">Using “${esc(STYLES[s.style]?.name)}”. More choices in Silent &amp; quiet time.</p>` : ''}
      </div>
      <label class="toggle-row bare"><span class="grow"><b>Only while the tag is moving</b>
        <small>Stops beeps when your keys sit on a table. Testing by walking away with your <i>phone</i> and leaving the tag still? Turn this off.</small></span>
        <input type="checkbox" role="switch" data-bind="tag-motion" ${s.motionOnly ? 'checked' : ''}></label>
      ${check}
      ${connected ? `<button type="button" class="btn outline" data-action="test-alert" data-id="${esc(tag.id)}">${icon('ring', 18)}Test the tag's alert</button>` : ''}
    </section>`;
}

async function saveTagNow(tag, msg) {
  try {
    const sent = await pushToTag(tag);
    toast(sent ? msg : 'Saved. It will be sent when the tag connects.');
  } catch (e) { tag.needsSync = true; save(); toast('Saved here, but the tag did not answer: ' + e.message); }
  render();
}

function toggleRow(bind, on, title, sub) {
  return `<label class="toggle-row"><span class="grow"><b>${esc(title)}</b><small>${esc(sub)}</small></span>
    <input type="checkbox" role="switch" data-bind="${bind}" ${on ? 'checked' : ''}></label>`;
}

function viewDistance(tag) {
  const d = draftFor(tag, 'distance');
  const st = status.get(tag.id);
  const feet = Math.min(150, Math.max(10, rssiToFeet(d.threshold)));
  const zone = zoneFor(feet);
  const unitBtn = (u, label) => `<button type="button" class="seg ${store.units === u ? 'on' : ''}" aria-pressed="${store.units === u}" data-action="unit" data-unit="${u}">${label}</button>`;
  const zoneBtn = (name, ft) => `<button type="button" class="pill ${zone.name === name ? 'on' : ''}" data-action="zone" data-feet="${ft}">${name}</button>`;
  return `
    ${backLink('#/tag/' + encodeURIComponent(tag.id), tag.name)}
    <header class="page-head simple"><div><h1>Alert distance</h1><p class="sub">How far you can walk from your phone before the tag beeps.</p></div></header>
    ${syncNote(tag)}
    <section class="card pad stack">
      <div class="segmented" role="group" aria-label="Units">${unitBtn('ft', 'Feet')}${unitBtn('yd', 'Yards')}${unitBtn('m', 'Meters')}</div>
      <div class="big-readout"><span class="small muted">About</span><strong>${fmtDist(feet)}</strong><span class="muted">${zone.hint}</span></div>
      <label class="sr-only" for="dist">Alert distance</label>
      <input id="dist" type="range" min="10" max="150" step="5" value="${feet}" data-bind="feet">
      <div class="range-ends"><span>${fmtDist(10)}</span><span>${fmtDist(150)}</span></div>
      <div class="pills center">${zoneBtn('Close', 15)}${zoneBtn('Room', 30)}${zoneBtn('House', 60)}${zoneBtn('Far', 120)}</div>
      <p class="small muted center">Bluetooth estimates distance from signal strength, so walls, pockets and bags shift it. The walk test makes it match your space.</p>
    </section>

    <section class="signal-box">
      ${signalSvg(bars(st?.rssi))}
      <span><b>Signal right now: ${st?.rssi ? st.rssi + ' dBm' : 'not connected'}</b><small>Alert point: ${d.threshold} dBm</small></span>
    </section>

    <section class="card pad stack">
      <h2 class="h3">Set it by walking</h2>
      <ol class="steps">
        <li>Tap <b>Start walk test</b> below.</li>
        <li>Leave your phone where it usually sits.</li>
        <li>Carry the tag to where you want the alert and press its button once.</li>
      </ol>
      <p class="small muted">Use the phone you paired with the tag. The tag measures the signal from that phone.</p>
      <button type="button" class="btn outline" data-action="calibrate" ${st?.calibrating ? 'disabled' : ''}>${st?.calibrating ? 'Waiting for the button press…' : 'Start walk test'}</button>
    </section>

    ${toggleRowDraft('motionOnly', d.motionOnly, 'Only alert while the tag is moving', 'No beeps when your keys sit on a table')}

    <div class="save-bar"><button type="button" class="btn dark wide" data-action="save-settings">Save to tag</button></div>`;
}

function toggleRowDraft(key, on, title, sub) {
  return `<label class="toggle-row card"><span class="grow"><b>${esc(title)}</b><small>${esc(sub)}</small></span>
    <input type="checkbox" role="switch" data-bind="draft-${key}" ${on ? 'checked' : ''}></label>`;
}

function viewSound(tag) {
  const d = draftFor(tag, 'sound');
  const st = status.get(tag.id);
  const tones = TONES.map((t) => `
    <label class="tone-row ${d.tone === t.id ? 'on' : ''}">
      <input type="radio" name="tone" value="${t.id}" data-bind="tone" ${d.tone === t.id ? 'checked' : ''}>
      <span class="grow"><b>${t.name}</b><small>${t.id === 6 ? (st?.hasRecording || ui.clip ? 'Your recording' : 'Record one below first') : t.note}</small></span>
      <button type="button" class="play-btn" aria-label="Play ${t.name}" data-action="preview-local" data-tone="${t.id}">${icon('play', 14)}</button>
    </label>`).join('');
  const repeat = (v, label) => `<button type="button" class="seg ${d.repeat === v ? 'on' : ''}" aria-pressed="${d.repeat === v}" data-action="repeat" data-v="${v}">${label}</button>`;
  const recording = ui.recorder;
  return `
    ${backLink('#/tag/' + encodeURIComponent(tag.id), tag.name)}
    <header class="page-head simple"><div><h1>Alert sound</h1><p class="sub">Tap ${icon('play', 12)} to hear a sound here, or test it on the tag.</p></div></header>
    ${syncNote(tag)}
    <fieldset class="plain"><legend class="section">Sound</legend><div class="list">${tones}</div></fieldset>

    <section class="card pad stack">
      <div><h2 class="h3">Record your own</h2><p class="small muted">Up to 5 seconds, like “Hey, grab your phone!” It's stored on the tag.</p></div>
      <button type="button" class="btn ${recording ? 'dark' : 'accent'} wide" data-action="record">${icon('mic', 20)}${recording ? 'Stop recording' : 'Record'}</button>
      ${ui.clip ? `<div class="row-btns">
          <button type="button" class="btn outline" data-action="play-clip">${icon('play', 14)}Play (${ui.clip.seconds.toFixed(1)} s)</button>
          <button type="button" class="btn dark" data-action="upload-clip" ${ui.uploading ? 'disabled' : ''}>${ui.uploading ? 'Sending… ' + Math.round(ui.uploading * 100) + '%' : 'Send to tag'}</button>
        </div>` : ''}
    </section>

    <section class="card pad stack">
      <label for="vol"><b>Volume</b></label>
      <div class="vol">${icon('ring', 18)}<input id="vol" type="range" min="1" max="5" value="${d.volume}" data-bind="volume"><b>${d.volume}</b></div>
    </section>

    <section class="card pad stack">
      <b>Repeat</b>
      <div class="segmented four">${repeat(1, 'Once')}${repeat(3, '3×')}${repeat(5, '5×')}${repeat(0, 'Until I stop')}</div>
      <label class="inline-field"><span>Time between repeats</span>
        <select data-bind="interval">
          ${[5, 15, 30, 60].map((v) => `<option value="${v}" ${d.interval === v ? 'selected' : ''}>${v < 60 ? v + ' seconds' : '1 minute'}</option>`).join('')}
        </select></label>
    </section>
    <p class="small muted pad-x">Longer, louder and repeating alerts use more battery.</p>

    <div class="save-bar two">
      <button type="button" class="btn outline" data-action="preview-tag">Test on tag</button>
      <button type="button" class="btn dark" data-action="save-settings">Save to tag</button>
    </div>`;
}

function viewQuiet(tag) {
  const d = draftFor(tag, 'quiet');
  const st = status.get(tag.id);
  const styles = STYLES.map((s) => `
    <button type="button" class="style-btn ${d.settings.style === s.id ? 'on' : ''}" aria-pressed="${d.settings.style === s.id}" data-action="style" data-v="${s.id}">
      <b>${s.name}</b><small>${s.note}</small></button>`).join('');
  const slot = (q, i) => `
    <div class="quiet-slot">
      <div class="quiet-head">
        <input type="text" class="name-input" aria-label="Name of quiet time ${i + 1}" value="${esc(d.names[i])}" data-bind="qname" data-i="${i}" maxlength="20">
        <label class="switch-label"><span class="sr-only">Turn on ${esc(d.names[i])}</span>
          <input type="checkbox" role="switch" data-bind="qon" data-i="${i}" ${q.days ? 'checked' : ''}></label>
      </div>
      <div class="time-row">
        <label class="field"><span>From</span><input type="time" value="${toTimeInput(q.start)}" data-bind="qstart" data-i="${i}"></label>
        <label class="field"><span>To</span><input type="time" value="${toTimeInput(q.end)}" data-bind="qend" data-i="${i}"></label>
      </div>
      <div class="days" role="group" aria-label="Days for ${esc(d.names[i])}">
        ${DAYS.map((ch, di) => `<button type="button" class="day ${(q.days || q.lastDays || 0) & (1 << di) ? 'on' : ''}" aria-pressed="${!!((q.days || 0) & (1 << di))}" aria-label="${DAY_NAMES[di]}" data-action="day" data-i="${i}" data-d="${di}">${ch}</button>`).join('')}
      </div>
      <small class="muted">${q.days ? fmtMin(q.start) + ' – ' + fmtMin(q.end) + ' · ' + daysText(q.days) : 'Off'}</small>
    </div>`;
  return `
    ${backLink('#/tag/' + encodeURIComponent(tag.id), tag.name)}
    <header class="page-head simple"><div><h1>Silent &amp; quiet time</h1><p class="sub">Choose how the tag gets your attention, and when it should stay quiet.</p></div></header>
    ${syncNote(tag)}
    <h2 class="section">Alert style</h2>
    <div class="style-grid">${styles}</div>
    <p class="small muted pad-x">*This prototype board has no vibration motor yet, so vibrate shows as light.</p>

    <section class="card pad stack">
      <h2 class="h3">Do not disturb now</h2>
      <p class="small muted">Same as holding the tag's button. Alerts come back on by themselves.${st?.dnd ? ` <b>On now: ${st.dndMinutes} min left.</b>` : ''}</p>
      <div class="pills">
        ${[[30, '30 min'], [60, '1 hr'], [120, '2 hr'], [240, '4 hr']].map(([m, l]) => `<button type="button" class="pill" data-action="dnd" data-min="${m}">${l}</button>`).join('')}
        ${st?.dnd ? '<button type="button" class="pill on" data-action="dnd" data-min="0">Turn off</button>' : ''}
      </div>
      <label class="inline-field"><span>Holding the tag button gives</span>
        <select data-bind="holdDnd">${[[30, '30 min'], [60, '1 hr'], [120, '2 hr'], [240, '4 hr']].map(([m, l]) => `<option value="${m}" ${d.settings.holdDnd === m ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    </section>

    <h2 class="section">Scheduled quiet times</h2>
    <div class="card pad stack">${d.quiet.map(slot).join('<hr>')}</div>

    <fieldset class="card pad stack plain-border">
      <legend class="sr-only">During quiet times</legend>
      <b>During quiet times</b>
      <label class="radio-row"><input type="radio" name="qm" value="0" data-bind="quietMode" ${d.settings.quietMode === 0 ? 'checked' : ''}>Stay completely silent</label>
      <label class="radio-row"><input type="radio" name="qm" value="1" data-bind="quietMode" ${d.settings.quietMode === 1 ? 'checked' : ''}>Flash the light only</label>
    </fieldset>

    <div class="save-bar"><button type="button" class="btn dark wide" data-action="save-quiet">Save to tag</button></div>`;
}

function viewFind(id) {
  const tags = store.tags;
  const sel = tagById(id) || tags.find((t) => isConnected(t.id)) || tags[0];
  if (!sel) return `<header class="page-head"><div><h1>Find</h1></div></header><section class="card empty"><p>Add a tag first.</p><a class="btn accent" href="#/add">Add a tag</a></section>`;
  const st = status.get(sel.id);
  const connected = isConnected(sel.id);
  const hist = rssiHistory.get(sel.id) || [];
  const level = connected ? Math.max(1, Math.min(5, Math.round(((st?.rssi || -90) + 95) / 9))) : 0;
  let trend = 'Walk slowly and watch the circle';
  if (hist.length >= 4) {
    const recent = (hist.at(-1) + hist.at(-2)) / 2, older = (hist[0] + hist[1]) / 2;
    if (recent - older > 3) trend = 'Getting warmer';
    else if (older - recent > 3) trend = 'Getting colder';
  }
  const chips = tags.map((t) => `<a class="pill ${t.id === sel.id ? 'on' : ''}" href="#/find/${encodeURIComponent(t.id)}" aria-current="${t.id === sel.id}">${esc(t.name)}</a>`).join('');
  return `
    <header class="page-head"><div><h1>Find</h1></div></header>
    <div class="pills" role="group" aria-label="Choose a tag">${chips}</div>
    <section class="card radar-card" aria-label="How close the tag is">
      <div class="radar r1 ${level >= 1 ? 'lit' : ''}"><div class="radar r2 ${level >= 3 ? 'lit' : ''}"><div class="radar r3 ${level >= 5 ? 'lit' : ''}">${icon(kindFor(sel.name), 30)}</div></div></div>
      <div class="center"><strong class="big">${connected ? trend : 'Not in range'}</strong>
      <p class="muted">${connected ? `Signal ${level} of 5 · ${st?.rssi ?? ''} dBm` : 'Connect when you are near it, or check where it was last seen.'}</p></div>
    </section>
    ${connected ? `<div class="row-btns">
        <button type="button" class="btn accent grow2" data-action="ring" data-id="${esc(sel.id)}">${icon('ring', 20)}Ring tag</button>
        <button type="button" class="btn outline" data-action="flash" data-id="${esc(sel.id)}">Flash light</button>
      </div>
      ${st?.alerting ? `<button type="button" class="btn dark wide" data-action="stop" data-id="${esc(sel.id)}">Stop ringing</button>` : ''}`
    : `<div class="row-btns">
        <button type="button" class="btn dark" data-action="connect" data-id="${esc(sel.id)}">${icon('bt', 18)}Connect</button>
        <a class="btn outline" href="#/tag/${encodeURIComponent(sel.id)}/lastseen">${icon('pin', 18)}Last seen</a>
      </div>`}`;
}

function viewLastSeen(tag) {
  const ls = tag.lastSeen;
  let map = `<div class="map-empty">${icon('pin', 32)}<p>No location saved yet. When a tag goes out of range while this app is open, its spot is saved here.</p></div>`;
  if (ls) {
    const dLat = 0.004, dLng = 0.006;
    const bbox = [ls.lng - dLng, ls.lat - dLat, ls.lng + dLng, ls.lat + dLat].join('%2C');
    map = `<iframe class="map" title="Map of where ${esc(tag.name)} was last seen" loading="lazy"
      src="https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&amp;layer=mapnik&amp;marker=${ls.lat}%2C${ls.lng}"></iframe>`;
  }
  return `
    ${backLink('#/tag/' + encodeURIComponent(tag.id), tag.name)}
    <header class="page-head simple"><div><h1>${esc(tag.name)}</h1>
      <p class="sub alert-text">${isConnected(tag.id) ? 'Connected now' : 'Out of range' + (tag.lastSeenAt || ls ? ' · last seen ' + timeAgo(tag.lastSeenAt || ls?.time) : '')}</p></div></header>
    <figure class="map-wrap">${map}
      ${ls ? `<figcaption>Where this device was when it lost the tag${ls.acc ? ` (within about ${fmtDist(Math.round(ls.acc * 3.28))})` : ''}</figcaption>` : ''}</figure>
    <div class="row-btns">
      ${ls ? `<a class="btn dark" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&amp;destination=${ls.lat},${ls.lng}">Directions</a>` : ''}
      <a class="btn outline" href="#/find/${encodeURIComponent(tag.id)}">I'm nearby</a>
    </div>
    ${toggleRow('phone-location', tag.phone.saveLocation, 'Save where it was last seen', 'Uses this device\'s location only when a tag goes out of range')}
    <p class="small muted pad-x">${icon('lock', 14)} Location is stored only on this device. No account, nothing uploaded.</p>`;
}

function viewAdd() {
  const support = bluetoothSupport();
  const android = /Android/.test(navigator.userAgent);
  const presets = ['Car keys', 'House keys', 'Wallet', 'Backpack', 'TV remote', 'Purse'];
  if (ui.pending) {
    return `
      ${backLink('#/tags', 'Cancel')}
      <header class="page-head simple"><div><h1>Name your tag</h1></div></header>
      <section class="found">${icon('bt', 20)}<span><b>Tag found</b><small>${esc(ui.pending.deviceName)}${ui.pending.demo ? ' (demo)' : ''}</small></span></section>
      <section class="card pad stack">
        <label class="field"><span class="h3">What's it attached to?</span>
          <input type="text" id="new-name" value="${esc(ui.pendingName || 'Car keys')}" data-bind="pending-name" maxlength="30"></label>
        <div class="pills">${presets.map((p) => `<button type="button" class="pill ${ui.pendingName === p ? 'on' : ''}" data-action="preset" data-name="${p}">${p}</button>`).join('')}</div>
      </section>
      <p class="small muted pad-x">Starts with the tag's current settings. You can change everything after.</p>
      <div class="save-bar"><button type="button" class="btn accent wide" data-action="finish-add">Add tag</button></div>`;
  }
  return `
    ${backLink('#/tags', 'Cancel')}
    <header class="page-head simple"><div><h1>Add a tag</h1><p class="sub">Keep the tag next to this ${android ? 'phone' : 'device'} while you set it up.</p></div></header>
    <section class="card pad step">
      <span class="step-num">1</span>
      <div><b>Turn the tag on</b><p class="small muted">Plug in the battery pack or USB. The lights blink blue twice when it's ready.</p></div>
    </section>
    <section class="card pad step">
      <span class="step-num">2</span>
      <div><b>${android ? 'Pair it in Android settings' : 'On your phone (for alerts)'}</b>
        <p class="small muted">Open Settings › Connected devices › Pair new device, and tap <b>Tether-…</b>. This lets the tag stay linked to your phone even when this app is closed, so it can warn you when you walk away.${android ? '' : ' On a computer you can skip this; a computer only changes settings.'}</p></div>
    </section>
    <section class="card pad step">
      <span class="step-num">3</span>
      <div class="grow"><b>Connect this app</b>
        <p class="small muted">Pick the tag in the list that pops up.</p>
        ${support.ok
          ? `<button type="button" class="btn accent wide" data-action="pick" ${ui.busy ? 'disabled' : ''}>${icon('bt', 18)}${ui.busy === 'pick' ? 'Connecting…' : 'Find my tag'}</button>`
          : `<p class="note warn">${esc(support.reason)}</p>`}
      </div>
    </section>
    <button type="button" class="btn ghost wide" data-action="demo">No tag yet? Try a demo tag</button>`;
}

function viewSettings() {
  const notif = 'Notification' in window ? Notification.permission : 'unsupported';
  return `
    <header class="page-head"><div><h1>Settings</h1></div></header>
    <h2 class="section">Distance units</h2>
    <div class="segmented card" role="group" aria-label="Units">
      ${[['ft', 'Feet'], ['yd', 'Yards'], ['m', 'Meters']].map(([u, l]) => `<button type="button" class="seg ${store.units === u ? 'on' : ''}" aria-pressed="${store.units === u}" data-action="unit" data-unit="${u}">${l}</button>`).join('')}
    </div>
    <h2 class="section">Notifications</h2>
    <div class="card pad stack">
      <p class="small">${notif === 'granted' ? 'On. You\'ll get a notification when a tag goes out of range while the app is open.' : notif === 'denied' ? 'Blocked. Turn them on in your browser\'s site settings.' : notif === 'unsupported' ? 'This browser doesn\'t support notifications.' : 'Get a notification when a tag goes out of range.'}</p>
      ${notif === 'default' ? '<button type="button" class="btn outline" data-action="notif">Turn on notifications</button>' : ''}
    </div>
    <h2 class="section">Install</h2>
    <div class="card pad stack">
      <p class="small">${matchMedia('(display-mode: standalone)').matches ? 'Installed. Open it from your home screen or app list.' : 'In Chrome, open the ⋮ menu and choose <b>Add to Home screen</b> (Android) or <b>Install</b> (computer).'}</p>
      ${ui.installPrompt ? '<button type="button" class="btn outline" data-action="install">Install app</button>' : ''}
    </div>
    <h2 class="section">Privacy</h2>
    <div class="card pad stack">
      <p class="small">${icon('lock', 14)} No account and no cloud. Tags, settings and last-seen locations are stored only on this device.</p>
      <button type="button" class="btn ghost danger" data-action="forget-all">Remove all tags from this device</button>
    </div>
    <p class="small muted pad-x">Tether prototype 0.1 · works in Chrome and Edge on Android and computers.</p>`;
}

function sidebar() {
  if (!store.tags.length) return `<p class="small muted">No tags yet.</p><a class="btn accent wide" href="#/add">${icon('plus', 18)}Add a tag</a>`;
  const r = route();
  return store.tags.map((t) => {
    const s = tagState(t);
    return `<a class="side-tag ${r.id === t.id ? 'on' : ''}" href="#/tag/${encodeURIComponent(t.id)}" ${r.id === t.id ? 'aria-current="page"' : ''}>
      <span class="tag-icon small ${s.tone}">${icon(kindFor(t.name), 20)}</span>
      <span class="grow"><b>${esc(t.name)}</b><small class="${s.tone}">${esc(s.text)}</small></span></a>`;
  }).join('') + `<a class="btn outline wide" href="#/add">${icon('plus', 18)}Add tag</a>`;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function render() {
  const r = route();
  let html;
  const tag = r.id ? tagById(r.id) : null;
  if (r.page !== 'add') { ui.pending = null; }
  if (r.page === 'tag' && !tag) { go('#/tags'); return; }
  if (r.page === 'tag') {
    if (r.sub === 'distance') html = viewDistance(tag);
    else if (r.sub === 'sound') html = viewSound(tag);
    else if (r.sub === 'quiet') html = viewQuiet(tag);
    else if (r.sub === 'lastseen') html = viewLastSeen(tag);
    else { ui.draftKey = ''; html = viewDetail(tag); }
  } else {
    ui.draftKey = '';
    if (r.page === 'add') html = viewAdd();
    else if (r.page === 'find') html = viewFind(r.id);
    else if (r.page === 'settings') html = viewSettings();
    else html = viewTags();
  }
  const view = $('#view');
  const focusedBind = document.activeElement?.dataset?.bind;
  view.innerHTML = html;
  if (focusedBind) view.querySelector(`[data-bind="${focusedBind}"]`)?.focus();
  $('#side-list').innerHTML = sidebar();
  document.querySelectorAll('.tabbar a').forEach((a) => {
    const on = a.dataset.tab === (r.page === 'tag' || r.page === 'add' ? 'tags' : r.page);
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}

// ---------------------------------------------------------------------------
// Actions (buttons)
// ---------------------------------------------------------------------------
const actions = {
  async connect(el) {
    const tag = tagById(el.dataset.id);
    el.disabled = true; el.textContent = 'Connecting…';
    try { await connectTag(tag); toast('Connected to ' + tag.name + '.'); }
    catch (e) { if (e.name !== 'NotFoundError') toast('Could not connect: ' + e.message); render(); }
  },
  disconnect(el) {
    userClosed.add(el.dataset.id);
    live.get(el.dataset.id)?.disconnect();
    render();
  },
  async 'quick-style'(el) {
    const tag = tagById(route().id);
    tag.settings = { ...tag.settings, style: Number(el.dataset.v) };
    await saveTagNow(tag, Number(el.dataset.v) === 5 ? 'Tag alert turned off.' : 'Saved to ' + tag.name + '.');
  },
  async 'quiet-off'() {
    const tag = tagById(route().id);
    tag.quiet = tag.quiet.map((q) => ({ ...q, days: 0 }));
    await saveTagNow(tag, 'Quiet times turned off.');
  },
  async 'test-alert'(el) {
    const t = tagById(el.dataset.id);
    if (await command(t, CMD.ring)) toast('The tag should beep and flash now. If it stays silent, tell me what the Serial Monitor shows.');
  },
  async ring(el) { const t = tagById(el.dataset.id); if (await command(t, CMD.ring)) toast('Ringing ' + t.name + '…'); },
  async stop(el) { await command(tagById(el.dataset.id), CMD.stop); },
  async flash(el) { await command(tagById(el.dataset.id), CMD.flash); },
  async 'dnd-off'(el) { await command(tagById(el.dataset.id), CMD.dnd, 0, 0); },
  async dnd(el) {
    const tag = tagById(route().id);
    const m = Number(el.dataset.min);
    if (await command(tag, CMD.dnd, m & 0xff, m >> 8)) toast(m ? 'Do not disturb for ' + (m >= 60 ? m / 60 + ' hr' : m + ' min') + '.' : 'Alerts are back on.');
  },
  remove(el) {
    const tag = tagById(el.dataset.id);
    if (!confirm(`Remove ${tag.name} from this device? You can add it again later.`)) return;
    userClosed.add(tag.id);
    live.get(tag.id)?.disconnect();
    live.delete(tag.id);
    store.tags = store.tags.filter((t) => t.id !== tag.id);
    save();
    go('#/tags');
  },
  'forget-all'() {
    if (!confirm('Remove all tags and saved locations from this device?')) return;
    for (const [id, c] of live) { userClosed.add(id); c.disconnect(); }
    live.clear();
    store.tags = [];
    save();
    go('#/tags'); render();
  },
  unit(el) { store.units = el.dataset.unit; save(); render(); },
  zone(el) { ui.draft.threshold = feetToRssi(Number(el.dataset.feet)); render(); },
  async calibrate() {
    const tag = tagById(route().id);
    if (await command(tag, CMD.calibrate)) toast('Walk test started. Walk away with the tag and press its button once.');
  },
  repeat(el) { ui.draft.repeat = Number(el.dataset.v); render(); },
  style(el) { ui.draft.settings.style = Number(el.dataset.v); render(); },
  day(el) {
    const q = ui.draft.quiet[Number(el.dataset.i)];
    q.days ^= (1 << Number(el.dataset.d));
    render();
  },
  'preview-local'(el) {
    const t = Number(el.dataset.tone);
    if (t === 6 && ui.clip) playPcm(ui.clip.pcm, ui.clip.rate);
    else playPattern(t === 6 ? 0 : t, ui.draft?.volume || 3);
  },
  'demo-loss'(el) { live.get(el.dataset.id)?.simulateLoss?.(); },
  async 'preview-tag'() {
    const tag = tagById(route().id);
    await command(tag, CMD.preview, ui.draft.tone, ui.draft.volume);
  },
  async 'save-settings'() {
    const tag = tagById(route().id);
    tag.settings = { ...ui.draft };
    try {
      const sent = await pushToTag(tag);
      toast(sent ? 'Saved to ' + tag.name + '.' : 'Saved. It will be sent when the tag connects.');
    } catch (e) { tag.needsSync = true; save(); toast('Saved here, but the tag did not answer: ' + e.message); }
    go('#/tag/' + encodeURIComponent(tag.id));
  },
  async 'save-quiet'() {
    const tag = tagById(route().id);
    tag.quiet = ui.draft.quiet.map((q) => ({ days: q.days, start: q.start, end: q.end }));
    tag.quietNames = [...ui.draft.names];
    tag.settings = { ...tag.settings, style: ui.draft.settings.style, holdDnd: ui.draft.settings.holdDnd, quietMode: ui.draft.settings.quietMode };
    try {
      const sent = await pushToTag(tag);
      toast(sent ? 'Saved to ' + tag.name + '.' : 'Saved. It will be sent when the tag connects.');
    } catch (e) { tag.needsSync = true; save(); toast('Saved here, but the tag did not answer: ' + e.message); }
    go('#/tag/' + encodeURIComponent(tag.id));
  },
  async record() {
    if (ui.recorder) {
      const r = ui.recorder;
      ui.recorder = null;
      try { ui.clip = await r.stop(); playPcm(ui.clip.pcm, ui.clip.rate); } catch (e) { toast('Recording failed: ' + e.message); }
      render();
      return;
    }
    try {
      ui.recorder = new Recorder();
      await ui.recorder.start();
      render();
      setTimeout(() => { if (ui.recorder) actions.record(); }, 5100);
    } catch (e) { ui.recorder = null; toast('Could not use the microphone: ' + e.message); render(); }
  },
  'play-clip'() { if (ui.clip) playPcm(ui.clip.pcm, ui.clip.rate); },
  async 'upload-clip'() {
    const tag = tagById(route().id);
    const conn = live.get(tag.id);
    if (!conn?.connected) { toast('Connect to ' + tag.name + ' first.'); return; }
    ui.uploading = 0.01; render();
    try {
      await conn.uploadClip(ui.clip.pcm, ui.clip.rate, (p) => { ui.uploading = p; render(); });
      ui.draft.tone = 6;
      toast('Recording saved on the tag and picked as the sound. Tap Save to keep it.');
    } catch (e) { toast('Could not send the recording: ' + e.message); }
    ui.uploading = 0; render();
  },
  async pick() {
    ui.busy = 'pick'; render();
    try {
      const conn = await TagConnection.pick();
      await conn.connect();
      const existing = tagById(conn.id);
      if (existing) { attach(existing, conn); ui.busy = ''; toast(existing.name + ' is already added. Connected.'); go('#/tag/' + encodeURIComponent(existing.id)); return; }
      const fromTag = await conn.readSettings();
      ui.pending = { conn, deviceName: conn.name, demo: false, fromTag };
      ui.pendingName = 'Car keys';
    } catch (e) {
      if (e.name !== 'NotFoundError') toast('Could not connect: ' + e.message);
    }
    ui.busy = ''; render();
  },
  async demo() {
    const n = store.tags.filter((t) => t.demo).length + 1;
    const conn = new DemoTag('demo-' + Date.now(), 'Tether-DEMO' + n);
    await conn.connect();
    ui.pending = { conn, deviceName: conn.name, demo: true, fromTag: await conn.readSettings() };
    ui.pendingName = 'Car keys';
    render();
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
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().then(render);
    go('#/tag/' + encodeURIComponent(tag.id));
  },
  async notif() { await Notification.requestPermission(); render(); },
  async install() { ui.installPrompt?.prompt(); ui.installPrompt = null; render(); },
};

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------
function onInput(el, final) {
  const b = el.dataset.bind;
  const tag = tagById(route().id);
  const i = Number(el.dataset.i);
  switch (b) {
    case 'feet': ui.draft.threshold = feetToRssi(Number(el.value)); if (final) render(); else updateDistanceReadout(Number(el.value)); return;
    case 'volume': ui.draft.volume = Number(el.value); if (final) render(); else el.nextElementSibling.textContent = el.value; return;
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
    case 'qstart': if (el.value) ui.draft.quiet[i].start = fromTimeInput(el.value); if (final) render(); return;
    case 'qend': if (el.value) ui.draft.quiet[i].end = fromTimeInput(el.value); if (final) render(); return;
    case 'draft-motionOnly': ui.draft.motionOnly = el.checked; return;
    case 'tag-motion':
      tag.settings = { ...tag.settings, motionOnly: el.checked };
      saveTagNow(tag, el.checked ? 'The tag only alerts while it moves.' : 'The tag alerts even when it sits still.');
      return;
    case 'phone-leave': tag.phone.leave = el.checked; save(); return;
    case 'phone-alarm': tag.phone.alarm = el.checked; save(); return;
    case 'phone-location':
      tag.phone.saveLocation = el.checked; save();
      if (el.checked && 'geolocation' in navigator) navigator.geolocation.getCurrentPosition(() => {}, () => toast('Location is blocked for this site, so last-seen spots can\'t be saved.'));
      return;
    case 'rename': if (final) { tag.name = el.value.trim() || tag.name; save(); render(); } return;
    case 'pending-name': ui.pendingName = el.value; return;
  }
}
function updateDistanceReadout(feet) {
  const z = zoneFor(feet);
  const box = document.querySelector('.big-readout');
  if (box) box.innerHTML = `<span class="small muted">About</span><strong>${fmtDist(feet)}</strong><span class="muted">${z.hint}</span>`;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
function start() {
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    e.preventDefault();
    actions[el.dataset.action]?.(el);
  });
  document.addEventListener('input', (e) => { if (e.target.dataset.bind) { ui.editing = true; onInput(e.target, false); } });
  document.addEventListener('change', (e) => { if (e.target.dataset.bind) { ui.editing = false; onInput(e.target, true); } });
  document.addEventListener('focusout', () => { ui.editing = false; });
  window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); ui.installPrompt = e; });

  // Demo tags come back each time the app opens; real tags reconnect if Chrome remembers them
  for (const tag of store.tags) {
    if (tag.demo) {
      const d = new DemoTag(tag.id, tag.deviceName);
      attach(tag, d);
      d.connect().then(render);
    }
  }
  TagConnection.remembered().then((known) => {
    for (const conn of known) {
      const tag = tagById(conn.id);
      if (!tag || live.has(tag.id)) continue;
      attach(tag, conn);
      conn.connect().then(() => { if (tag.needsSync) pushToTag(tag); render(); }).catch(() => keepTrying(tag));
    }
  });

  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  render();
}

// Exposed for the demo only: pretend a demo tag walked out of range
window.tetherDemoLoss = (id) => { const c = live.get(id || store.tags.find((t) => t.demo)?.id); c?.simulateLoss?.(); };

start();
