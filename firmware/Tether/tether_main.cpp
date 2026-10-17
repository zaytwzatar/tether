// Tether tag firmware: all the code lives here. See Tether.ino for setup notes.


#include <Arduino.h>
#include <Adafruit_CircuitPlayground.h>
#include <bluefruit.h>
#include <Adafruit_LittleFS.h>
#include <InternalFileSystem.h>
#include <Adafruit_SPIFlashBase.h>



// ---------------------------------------------------------------------------
// Bluetooth IDs. The app uses the same values (see app/ble.js).
// Base UUID: 7a1e00XX-5f3b-4c1e-9d4a-2b6c8e0f1a73 (bytes listed in reverse)
// ---------------------------------------------------------------------------
#define TETHER_UUID(x) { 0x73, 0x1a, 0x0f, 0x8e, 0x6c, 0x2b, 0x4a, 0x9d, \
                         0x1e, 0x4c, 0x3b, 0x5f, (x), 0x00, 0x1e, 0x7a }
const uint8_t UUID_SERVICE[]  = TETHER_UUID(0x01);
const uint8_t UUID_SETTINGS[] = TETHER_UUID(0x02);
const uint8_t UUID_COMMAND[]  = TETHER_UUID(0x03);
const uint8_t UUID_STATUS[]   = TETHER_UUID(0x04);
const uint8_t UUID_AUDIO[]    = TETHER_UUID(0x05);
const uint8_t UUID_QUIET[]    = TETHER_UUID(0x06);

BLEService        tetherService(UUID_SERVICE);
BLECharacteristic settingsChr(UUID_SETTINGS);
BLECharacteristic commandChr(UUID_COMMAND);
BLECharacteristic statusChr(UUID_STATUS);
BLECharacteristic audioChr(UUID_AUDIO);
BLECharacteristic quietChr(UUID_QUIET);
BLEDis            dis;

// A tiny "remote control" (consumer control) HID service. It is only here so
// Android/iPhone treat the tag like a Bluetooth accessory and keep it connected
// in the background. It does not act as a keyboard, so the phone's on-screen
// keyboard keeps working.
BLEHidGeneric hid(1, 0, 0);
const uint8_t hidReportMap[] = {
  0x05, 0x0C,        // Usage Page (Consumer)
  0x09, 0x01,        // Usage (Consumer Control)
  0xA1, 0x01,        // Collection (Application)
  0x85, 0x01,        //   Report ID (1)
  0x15, 0x00,        //   Logical Minimum (0)
  0x26, 0xFF, 0x03,  //   Logical Maximum (1023)
  0x19, 0x00,        //   Usage Minimum (0)
  0x2A, 0xFF, 0x03,  //   Usage Maximum (1023)
  0x75, 0x10,        //   Report Size (16)
  0x95, 0x01,        //   Report Count (1)
  0x81, 0x00,        //   Input (Data, Array, Absolute)
  0xC0               // End Collection
};

// ---------------------------------------------------------------------------
// Settings (saved on the tag). Layout must match app/ble.js.
// ---------------------------------------------------------------------------
enum AlertStyle : uint8_t { STYLE_SOUND = 0, STYLE_VIBRATE, STYLE_LIGHT, STYLE_VIBE_LIGHT, STYLE_ALL, STYLE_PHONE_ONLY };
enum Tone : uint8_t { TONE_CHIME = 0, TONE_BEACON, TONE_RISING, TONE_LOW, TONE_MELODY, TONE_SIREN, TONE_RECORDING };

struct __attribute__((packed)) Settings {
  uint8_t version;      // 1
  int8_t  threshold;    // alert when signal is weaker than this (dBm, e.g. -68)
  uint8_t flags;        // bit0: only alert while moving
  uint8_t tone;         // Tone
  uint8_t volume;       // 1..5
  uint8_t repeat;       // 0 = until stopped, otherwise number of times
  uint8_t interval;     // seconds between repeats
  uint8_t style;        // AlertStyle
  uint8_t holdDnd;      // minutes of do-not-disturb from press-and-hold
  uint8_t quietMode;    // during quiet times: 0 = silent, 1 = light only
  uint8_t reserved[2];
};

struct __attribute__((packed)) QuietSlot {
  uint8_t  days;        // bit0 = Sunday ... bit6 = Saturday, 0 = off
  uint16_t startMin;    // minutes after midnight
  uint16_t endMin;      // minutes after midnight (can be earlier than start = overnight)
};

struct __attribute__((packed)) QuietTimes {
  QuietSlot slot[2];
};

const Settings DEFAULT_SETTINGS = { 1, -76, 0x01, TONE_CHIME, 5, 3, 15, STYLE_SOUND, 60, 0, {0, 0} };
Settings   settings = DEFAULT_SETTINGS;
QuietTimes quiet    = { { {0x7F, 22 * 60, 7 * 60}, {0, 9 * 60, 10 * 60} } };

const char* SETTINGS_FILE = "/tether_settings.bin";
const char* QUIET_FILE    = "/tether_quiet.bin";
volatile bool saveSettingsPending = false;
volatile bool saveQuietPending    = false;

// ---------------------------------------------------------------------------
// Recorded sound: stored on the board's 2 MB flash chip.
// 8-bit unsigned audio, up to 5 seconds at 8000 samples per second.
// ---------------------------------------------------------------------------
Adafruit_FlashTransport_QSPI flashTransport;
Adafruit_SPIFlashBase        extFlash(&flashTransport);
bool     extFlashOk   = false;
const uint32_t CLIP_ADDR   = 0x100000;       // 1 MB into the chip, away from anything else
const uint32_t CLIP_MAGIC  = 0x50494C43;     // "CLIP"
const uint32_t CLIP_MAX    = 40000;          // 5 s at 8 kHz
struct __attribute__((packed)) ClipHeader { uint32_t magic; uint32_t length; uint16_t rate; uint16_t pad; };

uint8_t  clipBuf[CLIP_MAX];
volatile uint32_t clipReceived = 0;
volatile uint32_t clipExpected = 0;
volatile uint16_t clipRate     = 8000;
volatile bool     clipSavePending = false;
ClipHeader savedClip = { 0, 0, 0, 0 };

// ---------------------------------------------------------------------------
// Live state
// ---------------------------------------------------------------------------
const uint8_t SPEAKER = CPLAY_BUZZER;   // A0, drives the built-in amplifier

float    rssiAvg        = -50;
bool     haveRssi       = false;
bool     primaryUp      = false;    // the paired phone is connected
bool     seenPrimary    = false;    // we have been connected at least once since power-on
uint16_t primaryHandle  = BLE_CONN_HANDLE_INVALID;
uint32_t weakSinceMs    = 0;        // when the signal first went below the threshold

bool     alertFired     = false;    // separated and already alerted (waits for reconnect)
bool     alerting       = false;    // currently in an alert sequence
uint8_t  alertPlays     = 0;
uint32_t nextAlertMs    = 0;
uint32_t alertStartMs   = 0;
bool     ringOnce       = false;    // "Ring tag" from the app

uint32_t dndUntilMs     = 0;
bool     calibrating    = false;
uint32_t calibrateUntil = 0;

uint32_t lastMotionMs   = 0;
float    lastMag        = 9.8;

// Clock (the app sends the time when it connects)
bool     haveTime       = false;
uint32_t timeBaseMs     = 0;
uint32_t timeBaseSecOfWeek = 0;

// Events for the app
uint8_t  lastEvent      = 0;        // 1 = find my phone, 2 = walk test saved
uint8_t  eventCounter   = 0;

// Commands from the app are queued and handled in loop()
volatile uint8_t pendingCmd[8];
volatile uint8_t pendingCmdLen = 0;

// ---------------------------------------------------------------------------
// Sound
// ---------------------------------------------------------------------------
uint8_t amplitudeFor(uint8_t vol) {
  const uint8_t amp[6] = { 0, 16, 32, 56, 88, 127 };
  if (vol < 1) vol = 1;
  if (vol > 5) vol = 5;
  return amp[vol];
}

void speakerOn()  { CircuitPlayground.speaker.enable(true); analogWrite(SPEAKER, 0); }
void speakerOff() { analogWrite(SPEAKER, 0); CircuitPlayground.speaker.enable(false); }

// Square wave at freq Hz for ms milliseconds. The PWM duty sets the loudness.
void note(uint16_t freq, uint16_t ms, uint8_t amp) {
  uint32_t end = millis() + ms;
  if (freq == 0) { analogWrite(SPEAKER, 0); delay(ms); return; }
  uint32_t half = 500000UL / freq;
  bool high = false;
  uint32_t next = micros();
  while ((int32_t)(millis() - end) < 0) {
    analogWrite(SPEAKER, high ? 128 + amp : 128 - amp);
    high = !high;
    next += half;
    while ((int32_t)(micros() - next) < 0) { }
  }
  analogWrite(SPEAKER, 0);
}

void sweep(uint16_t from, uint16_t to, uint16_t stepMs, uint8_t amp) {
  int dir = (to > from) ? 1 : -1;
  for (int f = from; dir > 0 ? f <= to : f >= to; f += dir * 60) note(f, stepMs, amp);
}

bool playClip(uint8_t vol);

void playTone(uint8_t tone, uint8_t vol) {
  uint8_t a = amplitudeFor(vol);
  speakerOn();
  switch (tone) {
    case TONE_CHIME:   note(1319, 150, a); note(1047, 150, a); note(784, 320, a); break;
    case TONE_BEACON:  note(2000, 120, a); note(0, 80, a); note(2000, 120, a); break;
    case TONE_RISING:  sweep(600, 2400, 18, a); break;
    case TONE_LOW:     note(440, 250, a); note(0, 100, a); note(440, 250, a); note(0, 100, a); note(440, 400, a); break;
    case TONE_MELODY:  note(523, 160, a); note(659, 160, a); note(784, 160, a); note(1047, 220, a); note(784, 160, a); note(1047, 320, a); break;
    case TONE_SIREN:   for (int i = 0; i < 3; i++) { sweep(900, 1800, 8, a); sweep(1800, 900, 8, a); } break;
    case TONE_RECORDING:
      if (!playClip(vol)) { note(1319, 150, a); note(1047, 150, a); note(784, 320, a); }
      break;
  }
  speakerOff();
}

void chirpOk()        { speakerOn(); note(1568, 70, 56); note(2093, 110, 56); speakerOff(); }
void chirpReconnect() { speakerOn(); note(1047, 90, 40); note(1568, 140, 40); speakerOff(); }
void chirpNap()       { speakerOn(); note(784, 140, 40); note(659, 140, 40); note(523, 260, 40); speakerOff(); }

// Play the recorded clip from the flash chip
bool playClip(uint8_t vol) {
  if (!extFlashOk || savedClip.magic != CLIP_MAGIC || savedClip.length == 0) return false;
  uint8_t buf[256];
  uint32_t period = 1000000UL / (savedClip.rate ? savedClip.rate : 8000);
  int scale = vol * 51;   // 51..255
  uint32_t next = micros();
  for (uint32_t pos = 0; pos < savedClip.length; pos += sizeof(buf)) {
    uint32_t n = min((uint32_t)sizeof(buf), savedClip.length - pos);
    extFlash.readBuffer(CLIP_ADDR + sizeof(ClipHeader) + pos, buf, n);
    for (uint32_t i = 0; i < n; i++) {
      int s = 128 + (((int)buf[i] - 128) * scale) / 255;
      analogWrite(SPEAKER, constrain(s, 0, 255));
      next += period;
      while ((int32_t)(micros() - next) < 0) { }
    }
  }
  analogWrite(SPEAKER, 0);
  return true;
}

// ---------------------------------------------------------------------------
// Light
// ---------------------------------------------------------------------------
void flash(uint32_t color, uint8_t times, uint16_t onMs, uint16_t offMs) {
  for (uint8_t t = 0; t < times; t++) {
    for (int i = 0; i < 10; i++) CircuitPlayground.setPixelColor(i, color);
    CircuitPlayground.strip.show();
    delay(onMs);
    CircuitPlayground.clearPixels();
    delay(offMs);
  }
}
const uint32_t ORANGE = 0xFF3800;
const uint32_t BLUE   = 0x0040FF;
const uint32_t GREEN  = 0x00C020;

// ---------------------------------------------------------------------------
// Saving settings
// ---------------------------------------------------------------------------
template <typename T> void saveFile(const char* path, const T& data) {
  InternalFS.remove(path);
  Adafruit_LittleFS_Namespace::File f(InternalFS);
  if (f.open(path, Adafruit_LittleFS_Namespace::FILE_O_WRITE)) { f.write((const uint8_t*)&data, sizeof(T)); f.close(); }
}
template <typename T> bool loadFile(const char* path, T& data) {
  Adafruit_LittleFS_Namespace::File f(InternalFS);
  if (!f.open(path, Adafruit_LittleFS_Namespace::FILE_O_READ)) return false;
  bool ok = f.read((uint8_t*)&data, sizeof(T)) == sizeof(T);
  f.close();
  return ok;
}

void publishSettings() {
  settingsChr.write(&settings, sizeof(settings));
  quietChr.write(&quiet, sizeof(quiet));
}

void loadClipHeader() {
  if (extFlashOk) extFlash.readBuffer(CLIP_ADDR, (uint8_t*)&savedClip, sizeof(savedClip));
  if (savedClip.magic != CLIP_MAGIC || savedClip.length > CLIP_MAX) savedClip.length = 0;
}

void saveClip() {
  if (!extFlashOk) { Serial.println("No flash chip, recording not saved"); return; }
  uint32_t total = sizeof(ClipHeader) + clipReceived;
  for (uint32_t s = 0; s * 4096 < total; s++) extFlash.eraseSector(CLIP_ADDR / 4096 + s);
  ClipHeader h = { CLIP_MAGIC, clipReceived, clipRate, 0 };
  extFlash.writeBuffer(CLIP_ADDR, (const uint8_t*)&h, sizeof(h));
  extFlash.writeBuffer(CLIP_ADDR + sizeof(h), clipBuf, clipReceived);
  savedClip = h;
  Serial.printf("Saved recording: %lu bytes at %u Hz\n", (unsigned long)clipReceived, clipRate);
}

// ---------------------------------------------------------------------------
// Time and quiet hours
// ---------------------------------------------------------------------------
bool inQuietTime() {
  if (!haveTime) return false;
  uint32_t secOfWeek = (timeBaseSecOfWeek + (millis() - timeBaseMs) / 1000) % (7UL * 86400UL);
  uint8_t  day = secOfWeek / 86400;
  uint16_t minute = (secOfWeek % 86400) / 60;
  for (int i = 0; i < 2; i++) {
    const QuietSlot& q = quiet.slot[i];
    if (!q.days) continue;
    if (q.startMin <= q.endMin) {
      if ((q.days & (1 << day)) && minute >= q.startMin && minute < q.endMin) return true;
    } else {
      // Overnight, e.g. 22:00 - 07:00. The evening part belongs to "day",
      // the morning part belongs to the day before.
      uint8_t yesterday = (day + 6) % 7;
      if ((q.days & (1 << day)) && minute >= q.startMin) return true;
      if ((q.days & (1 << yesterday)) && minute < q.endMin) return true;
    }
  }
  return false;
}

bool dndActive() { return dndUntilMs && (int32_t)(millis() - dndUntilMs) < 0; }

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------
void playAlertOnce(bool forceSound) {
  uint8_t style = settings.style;
  bool quietNow = inQuietTime() && !forceSound;
  if (forceSound) style = STYLE_ALL;
  if (quietNow) style = settings.quietMode == 1 ? STYLE_LIGHT : STYLE_PHONE_ONLY;

  bool sound = (style == STYLE_SOUND || style == STYLE_ALL);
  // No vibration motor on this board yet, so "vibrate" falls back to light.
  bool light = (style == STYLE_LIGHT || style == STYLE_VIBE_LIGHT || style == STYLE_VIBRATE || style == STYLE_ALL);

  if (light) flash(ORANGE, 3, 150, 100);
  if (sound) playTone(settings.tone, settings.volume);
  if (light && sound) flash(ORANGE, 2, 120, 80);
}

void startAlert() {
  if (settings.style == STYLE_PHONE_ONLY) { alertFired = true; return; }
  Serial.println("ALERT: separated from phone");
  alerting = true;
  alertFired = true;
  alertPlays = 0;
  alertStartMs = millis();
  nextAlertMs = millis();
}

void stopAlert() { alerting = false; ringOnce = false; }

void serviceAlert() {
  if (!alerting) return;
  if ((int32_t)(millis() - nextAlertMs) < 0) return;
  playAlertOnce(ringOnce);
  alertPlays++;
  uint8_t limit = ringOnce ? 1 : settings.repeat;
  bool tooLong = millis() - alertStartMs > 30UL * 60UL * 1000UL;   // safety stop after 30 min
  if ((limit && alertPlays >= limit) || tooLong) { stopAlert(); return; }
  nextAlertMs = millis() + (uint32_t)max<uint8_t>(settings.interval, 2) * 1000UL;
}

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------
void updateMotion() {
  static uint32_t last = 0;
  if (millis() - last < 100) return;
  last = millis();
  float x = CircuitPlayground.motionX(), y = CircuitPlayground.motionY(), z = CircuitPlayground.motionZ();
  float mag = sqrtf(x * x + y * y + z * z);
  if (fabsf(mag - lastMag) > 1.2f) lastMotionMs = millis();
  lastMag = mag;
}
bool isMoving() { return lastMotionMs && millis() - lastMotionMs < 8000; }

// ---------------------------------------------------------------------------
// Buttons: 1 press, 2 presses, press-and-hold
// ---------------------------------------------------------------------------
void notifyEvent(uint8_t ev) { lastEvent = ev; eventCounter++; }

void onSinglePress() {
  if (calibrating) {
    if (primaryUp && haveRssi) {
      settings.threshold = (int8_t)constrain((int)rssiAvg - 3, -100, -30);
      saveSettingsPending = true;
      publishSettings();
      notifyEvent(2);
      Serial.printf("Walk test: alert distance saved at %d dBm\n", settings.threshold);
      chirpOk(); flash(GREEN, 2, 150, 100);
    } else {
      speakerOn(); note(300, 300, 56); speakerOff();   // can't hear the phone here
    }
    calibrating = false;
    return;
  }
  if (alerting) { stopAlert(); flash(BLUE, 1, 120, 0); return; }
  if (dndActive()) { dndUntilMs = 0; chirpOk(); return; }
  // Connectivity check, like the PRD: blue = phone nearby, orange = not
  flash(primaryUp ? BLUE : ORANGE, 1, 400, 0);
}

void onDoublePress() {
  notifyEvent(1);   // the app (if open) rings the phone
  flash(BLUE, 2, 100, 100);
}

void onHold() {
  stopAlert();
  dndUntilMs = millis() + (uint32_t)settings.holdDnd * 60000UL;
  chirpNap();
  Serial.printf("Do not disturb for %u min\n", settings.holdDnd);
}

void updateButtons() {
  static bool     wasDown = false;
  static uint32_t downAt = 0, lastUp = 0;
  static uint8_t  presses = 0;
  static bool     holdDone = false;
  bool down = CircuitPlayground.leftButton() || CircuitPlayground.rightButton();
  uint32_t now = millis();
  if (down && !wasDown) { downAt = now; holdDone = false; }
  if (down && !holdDone && now - downAt > 1200) { holdDone = true; presses = 0; onHold(); }
  if (!down && wasDown && !holdDone && now - downAt > 30) { presses++; lastUp = now; }
  if (!down && presses && now - lastUp > 400) {
    if (presses == 1) onSinglePress(); else onDoublePress();
    presses = 0;
  }
  wasDown = down;
}

// ---------------------------------------------------------------------------
// Bluetooth callbacks (they only store data; loop() does the work)
// ---------------------------------------------------------------------------
void onSettingsWrite(uint16_t, BLECharacteristic*, uint8_t* data, uint16_t len) {
  if (len < sizeof(Settings) || data[0] != 1) return;
  memcpy(&settings, data, sizeof(Settings));
  settings.volume = constrain(settings.volume, 1, 5);
  settings.threshold = constrain(settings.threshold, -100, -30);
  saveSettingsPending = true;
}

void onQuietWrite(uint16_t, BLECharacteristic*, uint8_t* data, uint16_t len) {
  if (len < sizeof(QuietTimes)) return;
  memcpy(&quiet, data, sizeof(QuietTimes));
  saveQuietPending = true;
}

void onCommandWrite(uint16_t, BLECharacteristic*, uint8_t* data, uint16_t len) {
  if (len == 0 || len > sizeof(pendingCmd) || pendingCmdLen) return;
  for (uint16_t i = 0; i < len; i++) pendingCmd[i] = data[i];
  pendingCmdLen = len;
}

void onAudioWrite(uint16_t, BLECharacteristic*, uint8_t* data, uint16_t len) {
  if (len == 0) return;
  if (data[0] == 0x01 && len >= 5) {                      // start: length (u16), rate (u16)
    clipExpected = min<uint32_t>(data[1] | (data[2] << 8), CLIP_MAX);
    clipRate = data[3] | (data[4] << 8);
    clipReceived = 0;
  } else if (data[0] == 0x02) {                           // data
    uint32_t n = min<uint32_t>(len - 1, CLIP_MAX - clipReceived);
    memcpy(clipBuf + clipReceived, data + 1, n);
    clipReceived += n;
  } else if (data[0] == 0x03) {                           // done
    if (clipReceived > 0) clipSavePending = true;
  }
}

void handleCommand(const uint8_t* c, uint8_t len) {
  switch (c[0]) {
    case 0x01: ringOnce = true; alerting = true; alertPlays = 0; alertStartMs = millis(); nextAlertMs = millis(); break;  // ring
    case 0x02: stopAlert(); break;                                                           // stop
    case 0x03: {                                                                             // do not disturb
      uint16_t mins = len >= 3 ? (c[1] | (c[2] << 8)) : 0;
      if (mins == 0) dndUntilMs = 0;
      else { stopAlert(); dndUntilMs = millis() + (uint32_t)mins * 60000UL; chirpNap(); }
      break;
    }
    case 0x04: flash(ORANGE, 6, 150, 120); break;                                            // flash light
    case 0x05: calibrating = true; calibrateUntil = millis() + 5UL * 60UL * 1000UL; chirpOk(); break;   // start walk test
    case 0x06:                                                                               // set time
      if (len >= 6) {
        uint8_t weekday = c[1];
        uint32_t secOfDay = c[2] | (c[3] << 8) | ((uint32_t)c[4] << 16) | ((uint32_t)c[5] << 24);
        timeBaseSecOfWeek = (uint32_t)weekday * 86400UL + secOfDay;
        timeBaseMs = millis();
        haveTime = true;
      }
      break;
    case 0x07: playTone(len >= 2 ? c[1] : settings.tone, len >= 3 ? c[2] : settings.volume); break;   // preview
    case 0x08: settings = DEFAULT_SETTINGS; saveSettingsPending = true; publishSettings(); chirpOk(); break; // reset
  }
}

bool isPrimary(BLEConnection* conn) {
  // The phone you paired in Bluetooth settings is "bonded". A computer that
  // only connects from Chrome to change settings is not, so it never causes alerts.
  return conn && conn->connected() && conn->bonded();
}

void onConnect(uint16_t handle) {
  BLEConnection* conn = Bluefruit.Connection(handle);
  conn->requestMtuExchange(247);
  Serial.println("Connected");
  // Keep advertising so the app on another device (or Chrome) can also connect
  if (Bluefruit.Periph.connected() < 2) Bluefruit.Advertising.start(0);
}

void onDisconnect(uint16_t handle, uint8_t reason) {
  Serial.printf("Disconnected (reason 0x%02X)\n", reason);
  if (handle == primaryHandle) { primaryUp = false; primaryHandle = BLE_CONN_HANDLE_INVALID; haveRssi = false; }
}

// ---------------------------------------------------------------------------
// Connection watching
// ---------------------------------------------------------------------------
void updateConnection() {
  // Find the paired phone among the connections
  if (!primaryUp) {
    for (uint16_t h = 0; h < BLE_MAX_CONNECTION; h++) {
      BLEConnection* conn = Bluefruit.Connection(h);
      if (isPrimary(conn)) {
        primaryHandle = h;
        primaryUp = true;
        seenPrimary = true;
        conn->monitorRssi();
        haveRssi = false;
        weakSinceMs = 0;
        Serial.println("Phone connected (paired)");
        break;
      }
    }
  }

  if (primaryUp) {
    BLEConnection* conn = Bluefruit.Connection(primaryHandle);
    if (!isPrimary(conn)) { primaryUp = false; primaryHandle = BLE_CONN_HANDLE_INVALID; return; }
    int8_t r = conn->getRssi();
    if (r != 0 && r > -127) {
      rssiAvg = haveRssi ? rssiAvg * 0.85f + r * 0.15f : r;
      haveRssi = true;
    }
  }
}

bool separated() {
  if (!seenPrimary) return false;            // never paired yet: nothing to watch
  if (!primaryUp) return true;               // connection lost
  if (!haveRssi) return false;
  if (rssiAvg < settings.threshold) {
    if (!weakSinceMs) weakSinceMs = millis();
    return millis() - weakSinceMs > 3000;    // weak for 3 seconds
  }
  weakSinceMs = 0;
  return false;
}

void updateAlerts() {
  bool apart = separated();
  if (!apart) {
    if (alertFired) {
      bool wasRinging = alerting && !ringOnce;
      if (wasRinging) stopAlert();
      alertFired = false;
      Serial.println("Back in range");
      if (!dndActive() && !inQuietTime()) chirpReconnect();
    }
    return;
  }
  if (alertFired || dndActive()) return;
  bool motionOnly = settings.flags & 0x01;
  if (motionOnly && !isMoving()) return;     // wait until the tag is moved (Home mode)
  startAlert();
}

// ---------------------------------------------------------------------------
// Status sent to the app once a second
// ---------------------------------------------------------------------------
void sendStatus() {
  static uint32_t last = 0;
  if (millis() - last < 1000) return;
  last = millis();
  uint16_t dndLeft = dndActive() ? (dndUntilMs - millis()) / 60000UL + 1 : 0;
  uint8_t flags = (primaryUp ? 0x01 : 0) | (isMoving() ? 0x02 : 0) | (dndActive() ? 0x04 : 0) |
                  (alerting ? 0x08 : 0) | (inQuietTime() ? 0x10 : 0) | (calibrating ? 0x20 : 0) |
                  (savedClip.length ? 0x40 : 0) | (haveTime ? 0x80 : 0);
  uint8_t s[8] = {
    (uint8_t)(int8_t)(haveRssi ? (int)rssiAvg : 0), flags,
    (uint8_t)(dndLeft & 0xFF), (uint8_t)(dndLeft >> 8),
    (uint8_t)settings.threshold, lastEvent, eventCounter, 1 /* firmware 0.1 */
  };
  statusChr.write(s, sizeof(s));
  for (uint16_t h = 0; h < BLE_MAX_CONNECTION; h++) {
    BLEConnection* conn = Bluefruit.Connection(h);
    if (conn && conn->connected() && statusChr.notifyEnabled(h)) statusChr.notify(h, s, sizeof(s));
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
void setupBle() {
  Bluefruit.configPrphBandwidth(BANDWIDTH_MAX);
  Bluefruit.begin(2, 0);
  Bluefruit.setTxPower(4);

  uint8_t mac[6];
  Bluefruit.getAddr(mac);
  char name[16];
  snprintf(name, sizeof(name), "Tether-%02X%02X", mac[1], mac[0]);
  Bluefruit.setName(name);
  Serial.printf("Name: %s\n", name);

  Bluefruit.Periph.setConnectCallback(onConnect);
  Bluefruit.Periph.setDisconnectCallback(onDisconnect);

  dis.setManufacturer("Tether prototype");
  dis.setModel("Circuit Playground Bluefruit");
  dis.begin();

  uint16_t inputLen[] = { 2 };
  hid.setReportLen(inputLen);
  hid.setReportMap(hidReportMap, sizeof(hidReportMap));
  hid.begin();

  tetherService.begin();

  settingsChr.setProperties(CHR_PROPS_READ | CHR_PROPS_WRITE);
  settingsChr.setPermission(SECMODE_OPEN, SECMODE_OPEN);
  settingsChr.setFixedLen(sizeof(Settings));
  settingsChr.setWriteCallback(onSettingsWrite);
  settingsChr.begin();

  quietChr.setProperties(CHR_PROPS_READ | CHR_PROPS_WRITE);
  quietChr.setPermission(SECMODE_OPEN, SECMODE_OPEN);
  quietChr.setFixedLen(sizeof(QuietTimes));
  quietChr.setWriteCallback(onQuietWrite);
  quietChr.begin();

  commandChr.setProperties(CHR_PROPS_WRITE);
  commandChr.setPermission(SECMODE_NO_ACCESS, SECMODE_OPEN);
  commandChr.setMaxLen(8);
  commandChr.setWriteCallback(onCommandWrite);
  commandChr.begin();

  statusChr.setProperties(CHR_PROPS_READ | CHR_PROPS_NOTIFY);
  statusChr.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  statusChr.setFixedLen(8);
  statusChr.begin();

  audioChr.setProperties(CHR_PROPS_WRITE | CHR_PROPS_WRITE_WO_RESP);
  audioChr.setPermission(SECMODE_NO_ACCESS, SECMODE_OPEN);
  audioChr.setMaxLen(244);
  audioChr.setWriteCallback(onAudioWrite);
  audioChr.begin();

  publishSettings();

  Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
  Bluefruit.Advertising.addAppearance(BLE_APPEARANCE_GENERIC_TAG);
  Bluefruit.Advertising.addService(tetherService);
  Bluefruit.Advertising.addService(hid);
  Bluefruit.ScanResponse.addName();
  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.setInterval(160, 800);   // 100 ms fast, 500 ms slow (units of 0.625 ms)
  Bluefruit.Advertising.setFastTimeout(30);
  Bluefruit.Advertising.start(0);
}

void setup() {
  Serial.begin(115200);
  CircuitPlayground.begin();
  CircuitPlayground.speaker.enable(false);
  CircuitPlayground.setBrightness(40);

  InternalFS.begin();
  Settings s;
  if (loadFile(SETTINGS_FILE, s) && s.version == 1) settings = s;
  loadFile(QUIET_FILE, quiet);

  extFlashOk = extFlash.begin();
  loadClipHeader();

  setupBle();
  flash(BLUE, 2, 120, 120);   // hello
  Serial.println("Tether tag ready. Pair it in your phone's Bluetooth settings.");
}

void loop() {
  if (pendingCmdLen) {
    uint8_t c[8];
    uint8_t n = pendingCmdLen;
    for (uint8_t i = 0; i < n; i++) c[i] = pendingCmd[i];
    pendingCmdLen = 0;
    handleCommand(c, n);
  }
  if (saveSettingsPending) { saveSettingsPending = false; saveFile(SETTINGS_FILE, settings); publishSettings(); Serial.println("Settings saved"); }
  if (saveQuietPending)    { saveQuietPending = false; saveFile(QUIET_FILE, quiet); publishSettings(); Serial.println("Quiet times saved"); }
  if (clipSavePending)     { clipSavePending = false; saveClip(); chirpOk(); }
  if (calibrating && (int32_t)(millis() - calibrateUntil) > 0) calibrating = false;

  updateMotion();
  updateButtons();
  updateConnection();
  updateAlerts();
  serviceAlert();
  sendStatus();

  // Debug line every 2 seconds in the Serial Monitor
  static uint32_t lastLog = 0;
  if (millis() - lastLog > 2000) {
    lastLog = millis();
    Serial.printf("phone:%s signal:%d dBm (alert below %d) moving:%s alerting:%s dnd:%s quiet:%s\n",
                  primaryUp ? "yes" : "no", haveRssi ? (int)rssiAvg : 0, settings.threshold,
                  isMoving() ? "yes" : "no", alerting ? "yes" : "no", dndActive() ? "yes" : "no",
                  inQuietTime() ? "yes" : "no");
  }
  delay(10);
}
