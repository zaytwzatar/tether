// Tether tag firmware for the M5Stack StickS3. Setup notes are in TetherS3.ino.
#include <Arduino.h>
#include <M5Unified.h>
#include <NimBLEDevice.h>
#include <NimBLEHIDDevice.h>
#include <Preferences.h>
#include <LittleFS.h>
#include <sys/time.h>
#include <esp_mac.h>
#include <vector>
#include "tether_voices.h"

// ===========================================================================
// Bluetooth IDs. Must match the app (app/ble.js).
// ===========================================================================
#define TETHER_UUID(x) "7a1e00" x "-5f3b-4c1e-9d4a-2b6c8e0f1a73"
static const char* UUID_SERVICE  = TETHER_UUID("01");
static const char* UUID_SETTINGS = TETHER_UUID("02");
static const char* UUID_COMMAND  = TETHER_UUID("03");
static const char* UUID_STATUS   = TETHER_UUID("04");
static const char* UUID_AUDIO    = TETHER_UUID("05");
static const char* UUID_QUIET    = TETHER_UUID("06");
static const char* UUID_INFO     = TETHER_UUID("07");   // what this tag can do (screen, speaker...)
static const char* UUID_EXTRAS   = TETHER_UUID("08");   // screen and extra-feature settings
static const char* UUID_TEXT     = TETHER_UUID("09");   // name, "if found" message, checklist
static const char* UUID_STATS    = TETHER_UUID("0a");   // streaks, saves, battery
static const char* UUID_IR       = TETHER_UUID("0b");   // TV remote codes (save, test, learn)

// iPhone notifications (Apple Notification Center Service), used for caller ID
static const char* ANCS_SERVICE = "7905F431-B5CE-4E99-A40F-4B1E122D00D0";
static const char* ANCS_NOTIF   = "9FBF120D-6301-42D9-8C58-25E699A21DBD";
static const char* ANCS_CONTROL = "69D1D8F3-45E1-49A8-9821-9BBDFDAAD9D9";
static const char* ANCS_DATA    = "22EAC6E9-24D6-4BB5-BE44-B36ACE7C7BFB";

static const uint8_t MODEL_STICKS3 = 2;
static const uint8_t FW_VERSION = 3;   // 2: talking alerts, funny faces, vibration add-on  3: TV remote, voice changer

// ===========================================================================
// Settings (same layout as the Circuit Playground version)
// ===========================================================================
enum AlertStyle : uint8_t { STYLE_SOUND = 0, STYLE_VIBRATE, STYLE_LIGHT, STYLE_VIBE_LIGHT, STYLE_ALL, STYLE_PHONE_ONLY };
enum Tone : uint8_t { TONE_CHIME = 0, TONE_BEACON, TONE_RISING, TONE_LOW, TONE_MELODY, TONE_SIREN, TONE_RECORDING };

struct __attribute__((packed)) Settings {
  uint8_t version;      // 1
  int8_t  threshold;    // alert when the phone's signal is weaker than this (dBm)
  uint8_t flags;        // bit0: only alert while moving
  uint8_t tone, volume, repeat, interval, style, holdDnd, quietMode;
  uint8_t reserved[2];
};
struct __attribute__((packed)) QuietSlot { uint8_t days; uint16_t startMin; uint16_t endMin; };
struct __attribute__((packed)) QuietTimes { QuietSlot slot[2]; };

// Screen and extras. bit flags:
enum ExtraFlag : uint8_t { X_FACE = 1, X_CHECKLIST = 2, X_CAMERA = 4, X_CALLER_ID = 8, X_CLOCK24 = 16, X_PICKUP_WAKE = 32,
                           X_CALM_FACE = 64,   // no funny faces
                           X_VIBE = 128 };     // vibration motor plugged into the side port
struct __attribute__((packed)) Extras {
  uint8_t version;      // 1
  uint8_t brightness;   // 1..5
  uint8_t screenSecs;   // how long the screen stays on
  uint8_t theme;        // 0 orange, 1 blue, 2 green, 3 purple, 4 pink
  uint8_t flags;        // ExtraFlag bits
  uint8_t timerStep;    // minutes added per press on the parking timer
  uint8_t reserved[10];
};

const Settings   DEFAULT_SETTINGS = { 1, -76, 0x01, TONE_CHIME, 4, 3, 15, STYLE_ALL, 60, 0, {0, 0} };
const QuietTimes DEFAULT_QUIET    = { { {0, 22 * 60, 7 * 60}, {0, 9 * 60, 10 * 60} } };
const Extras     DEFAULT_EXTRAS   = { 1, 3, 10, 0, X_FACE | X_CHECKLIST | X_CAMERA | X_CALLER_ID | X_PICKUP_WAKE, 15, {0} };

Settings   settings = DEFAULT_SETTINGS;
QuietTimes quiet    = DEFAULT_QUIET;
Extras     extras   = DEFAULT_EXTRAS;
String tagName = "My keys";
String foundMsg = "If found, please call the owner";
String checkItems[4] = { "Phone", "Wallet", "Keys", "Water bottle" };

Preferences prefs;

// Streaks and saves (kept across restarts)
struct Stats { int32_t firstDay = -1; int32_t lastForgotDay = -1; uint16_t saves = 0; uint16_t best = 0; } stats;

// ===========================================================================
// Live state
// ===========================================================================
NimBLEServer* server = nullptr;
NimBLECharacteristic *settingsChr, *commandChr, *statusChr, *audioChr, *quietChr, *infoChr, *extrasChr, *textChr, *statsChr, *irChr = nullptr;
NimBLEHIDDevice* hid = nullptr;
NimBLECharacteristic* hidInput = nullptr;

bool     primaryUp = false, seenPrimary = false;
NimBLEClient* primaryClient = nullptr;      // reused: asking the library again would reset it
uint16_t primaryHandle = 0xFFFF;
uint32_t primarySince = 0;
float    rssiAvg = -50; bool haveRssi = false;
uint32_t weakSinceMs = 0;

bool     alertFired = false, alerting = false, ringOnce = false;
uint8_t  alertPlays = 0; uint32_t nextAlertMs = 0, alertStartMs = 0;
uint32_t episodeStart = 0; bool episodeForgot = false;   // for streaks
uint32_t dndUntilMs = 0;
bool     calibrating = false; uint32_t calibrateUntil = 0;
uint32_t lastMotionMs = 0, stillSinceMs = 0; float lastMag = 1.0f;
uint8_t  lastEvent = 0, eventCounter = 0;
int      battery = -1; bool charging = false;

// Clock: the app sends the time when it connects
bool haveClock = false; int16_t tzMinutes = 0;          // full date and time
bool haveWeekClock = false; uint32_t weekBaseMs = 0, weekBaseSec = 0;  // older app: weekday + time only

// Commands and data from the app are copied here and handled in loop()
volatile bool saveSettingsPending = false, saveQuietPending = false, saveExtrasPending = false, saveTextPending = false;
uint8_t pendingCmd[8]; volatile uint8_t pendingCmdLen = 0;
uint8_t* clipBuf = nullptr; uint32_t clipLen = 0; uint16_t clipRate = 8000;
volatile uint32_t clipRecv = 0, clipExpected = 0; volatile bool clipSavePending = false;
const uint32_t CLIP_MAX = 40000;

// Voice note
uint8_t* noteBuf = nullptr; uint32_t noteLen = 0; const uint32_t VOICE_RATE = 8000, VOICE_MAX = VOICE_RATE * 10;

// TV remote: IR LED on G46, IR receiver on G42
const int IR_TX = 46, IR_RX = 42;
const uint8_t TV_SLOTS = 8, TV_MAX = 250;
const char* TV_NAMES[TV_SLOTS] = { "Power", "Volume +", "Volume -", "Mute", "Channel +", "Channel -", "Input", "Home" };
struct TvCode { uint16_t khz; uint16_t n; uint16_t t[TV_MAX]; };
TvCode* tvCodes = nullptr;          // in PSRAM
uint8_t tvMask = 0, tvSel = 0;      // which buttons are saved; which one is picked on the screen
bool irTxReady = false, irRxOn = false;
int8_t learnSlot = -1; uint32_t learnUntil = 0;
uint32_t irLastUse = 0, tvSentFlash = 0;
uint8_t irPend[520]; volatile uint16_t irPendLen = 0;
rmt_data_t irRx[200]; size_t irRxCount = 0;

// Voice changer
const uint32_t FX_RATE = 16000, FX_MAX = FX_RATE * 6, FX_OUT = FX_MAX + FX_RATE * 2;
const char* FX_NAMES[] = { "Chipmunk", "Monster", "Robot", "Alien", "Echo", "Backwards" };
const uint8_t FX_COUNT = 6;
int16_t* fxIn = nullptr; int16_t* fxOut = nullptr;
uint32_t fxLen = 0, fxPos = 0; bool fxRecording = false; uint8_t fxEffect = 0;
bool recordingNote = false; uint32_t notePos = 0;

// Parking timer
uint32_t timerEndMs = 0; bool timerDone = false;

// iPhone notifications
bool ancsTried = false, ancsReady = false;
NimBLERemoteCharacteristic* ancsControl = nullptr;
QueueHandle_t ancsQueue = nullptr;
struct AncsMsg { uint8_t kind; uint8_t len; uint8_t data[244]; };   // kind 0 = notification source, 1 = data source
std::vector<uint8_t> ancsData;
uint32_t notifyUid = 0, callUid = 0xFFFFFFFF; uint8_t notifyCat = 0;
String notifyTitle, notifyBody; uint32_t notifyUntil = 0;

// ===========================================================================
// Time helpers
// ===========================================================================
time_t localNow() { return time(nullptr) + (time_t)tzMinutes * 60; }
int32_t today() { return haveClock ? (int32_t)(localNow() / 86400) : -1; }
bool clockParts(uint8_t& weekday, uint16_t& minuteOfDay) {
  if (haveClock) {
    time_t t = localNow();
    struct tm tmv; gmtime_r(&t, &tmv);
    weekday = tmv.tm_wday; minuteOfDay = tmv.tm_hour * 60 + tmv.tm_min;
    return true;
  }
  if (haveWeekClock) {
    uint32_t s = (weekBaseSec + (millis() - weekBaseMs) / 1000) % (7UL * 86400UL);
    weekday = s / 86400; minuteOfDay = (s % 86400) / 60;
    return true;
  }
  return false;
}
String clockText() {
  uint8_t wd; uint16_t m;
  if (!clockParts(wd, m)) return "";
  int h = m / 60, mm = m % 60;
  char buf[12];
  if (extras.flags & X_CLOCK24) snprintf(buf, sizeof(buf), "%d:%02d", h, mm);
  else snprintf(buf, sizeof(buf), "%d:%02d %s", ((h + 11) % 12) + 1, mm, h >= 12 ? "PM" : "AM");
  return String(buf);
}
String untilText(uint32_t untilMs) {
  uint8_t wd; uint16_t m;
  if (!clockParts(wd, m)) { uint32_t mins = (untilMs - millis()) / 60000 + 1; return String(mins) + " min"; }
  uint32_t target = (m + (untilMs - millis()) / 60000) % 1440;
  int h = target / 60, mm = target % 60;
  char buf[12];
  if (extras.flags & X_CLOCK24) snprintf(buf, sizeof(buf), "%d:%02d", h, mm);
  else snprintf(buf, sizeof(buf), "%d:%02d %s", ((h + 11) % 12) + 1, mm, h >= 12 ? "PM" : "AM");
  return String(buf);
}

bool inQuietTime() {
  uint8_t day; uint16_t minute;
  if (!clockParts(day, minute)) return false;
  for (int i = 0; i < 2; i++) {
    const QuietSlot& q = quiet.slot[i];
    if (!q.days) continue;
    if (q.startMin <= q.endMin) {
      if ((q.days & (1 << day)) && minute >= q.startMin && minute < q.endMin) return true;
    } else {
      uint8_t yesterday = (day + 6) % 7;
      if ((q.days & (1 << day)) && minute >= q.startMin) return true;
      if ((q.days & (1 << yesterday)) && minute < q.endMin) return true;
    }
  }
  return false;
}
bool dndActive() { return dndUntilMs && (int32_t)(millis() - dndUntilMs) < 0; }

// ===========================================================================
// Saving
// ===========================================================================
void loadAll() {
  prefs.begin("tether", false);
  Settings s; if (prefs.getBytes("set", &s, sizeof(s)) == sizeof(s) && s.version == 1) settings = s;
  QuietTimes q; if (prefs.getBytes("quiet", &q, sizeof(q)) == sizeof(q)) quiet = q;
  Extras x; if (prefs.getBytes("extras", &x, sizeof(x)) == sizeof(x) && x.version == 1) extras = x;
  tagName = prefs.getString("name", tagName);
  foundMsg = prefs.getString("found", foundMsg);
  for (int i = 0; i < 4; i++) checkItems[i] = prefs.getString(("ck" + String(i)).c_str(), checkItems[i]);
  stats.firstDay = prefs.getInt("first", -1);
  stats.lastForgotDay = prefs.getInt("forgot", -1);
  stats.saves = prefs.getUShort("saves", 0);
  stats.best = prefs.getUShort("best", 0);
}
void saveStats() {
  prefs.putInt("first", stats.firstDay);
  prefs.putInt("forgot", stats.lastForgotDay);
  prefs.putUShort("saves", stats.saves);
  prefs.putUShort("best", stats.best);
}
void saveTexts() {
  prefs.putString("name", tagName);
  prefs.putString("found", foundMsg);
  for (int i = 0; i < 4; i++) prefs.putString(("ck" + String(i)).c_str(), checkItems[i]);
}

int streakDays() {
  int32_t t = today();
  if (t < 0) return -1;
  if (stats.firstDay < 0) { stats.firstDay = t; saveStats(); }
  int32_t from = max(stats.firstDay, stats.lastForgotDay + 1);
  int s = max(0, (int)(t - from + 1));
  if (s > stats.best) { stats.best = s; saveStats(); }
  return s;
}

// ===========================================================================
// Sound: short melodies played a note at a time so the screen keeps moving
// ===========================================================================
struct Note { uint16_t f; uint16_t ms; };
const uint8_t TONE_COUNT = 17;   // 0-5 built in, 6 = recording, 7-16 extra sounds
std::vector<Note> patterns[TONE_COUNT];
std::vector<Note>* playing = nullptr; size_t playIdx = 0; uint32_t noteEnd = 0;

void buildPatterns() {
  patterns[TONE_CHIME]  = { {1319, 150}, {1047, 150}, {784, 320} };
  patterns[TONE_BEACON] = { {2000, 120}, {0, 80}, {2000, 120} };
  for (int f = 600; f <= 2400; f += 60) patterns[TONE_RISING].push_back({ (uint16_t)f, 18 });
  patterns[TONE_LOW]    = { {440, 250}, {0, 100}, {440, 250}, {0, 100}, {440, 400} };
  patterns[TONE_MELODY] = { {523, 160}, {659, 160}, {784, 160}, {1047, 220}, {784, 160}, {1047, 320} };
  for (int r = 0; r < 3; r++) {
    for (int f = 900; f <= 1800; f += 60) patterns[TONE_SIREN].push_back({ (uint16_t)f, 16 });
    for (int f = 1800; f >= 900; f -= 60) patterns[TONE_SIREN].push_back({ (uint16_t)f, 16 });
  }
  // 7 doorbell, 8 bird song, 9 coin, 10 power up, 11 alarm clock,
  // 12 sonar, 13 cuckoo, 14 laser, 15 twinkle, 16 fanfare
  patterns[7] = { {1319, 300}, {1047, 500} };
  patterns[8] = { {2637, 50}, {0, 30}, {3136, 50}, {0, 30}, {3520, 80}, {0, 140}, {2637, 50}, {0, 30}, {3136, 50}, {0, 30}, {3520, 80} };
  patterns[9] = { {988, 80}, {1319, 320} };
  patterns[10] = { {523, 60}, {659, 60}, {784, 60}, {1047, 60}, {1319, 60}, {1568, 60}, {2093, 160} };
  patterns[11] = { {2093, 70}, {0, 50}, {2093, 70}, {0, 50}, {2093, 70}, {0, 50}, {2093, 70}, {0, 50}, {0, 250}, {2093, 70}, {0, 50}, {2093, 70}, {0, 50}, {2093, 70}, {0, 50}, {2093, 70}, {0, 50}, {0, 250} };
  patterns[12] = { {1568, 60}, {0, 40}, {1568, 450} };
  patterns[13] = { {784, 250}, {0, 60}, {659, 400}, {0, 250}, {784, 250}, {0, 60}, {659, 400} };
  patterns[14] = { {2000, 10}, {1900, 10}, {1800, 10}, {1700, 10}, {1600, 10}, {1500, 10}, {1400, 10}, {1300, 10}, {1200, 10}, {1100, 10}, {1000, 10}, {900, 10}, {800, 10}, {700, 10}, {600, 10}, {0, 70}, {2000, 10}, {1900, 10}, {1800, 10}, {1700, 10}, {1600, 10}, {1500, 10}, {1400, 10}, {1300, 10}, {1200, 10}, {1100, 10}, {1000, 10}, {900, 10}, {800, 10}, {700, 10}, {600, 10}, {0, 70}, {2000, 10}, {1900, 10}, {1800, 10}, {1700, 10}, {1600, 10}, {1500, 10}, {1400, 10}, {1300, 10}, {1200, 10}, {1100, 10}, {1000, 10}, {900, 10}, {800, 10}, {700, 10}, {600, 10}, {0, 70} };
  patterns[15] = { {523, 180}, {0, 40}, {523, 180}, {0, 40}, {784, 180}, {0, 40}, {784, 180}, {0, 40}, {880, 180}, {0, 40}, {880, 180}, {0, 40}, {784, 360} };
  patterns[16] = { {784, 100}, {0, 30}, {784, 100}, {0, 30}, {784, 100}, {0, 30}, {1047, 450} };
}
// Top volume stays under 75%: M5Stack says louder can make the StickS3 restart on battery
uint8_t volumeFor(uint8_t v) { const uint8_t m[6] = { 0, 45, 80, 115, 155, 190 }; return m[constrain(v, 1, 5)]; }

bool micActive = false, speakerOn = false;
void useSpeaker() {
  if (micActive) { M5.Mic.end(); micActive = false; }
  if (!speakerOn) { M5.Speaker.begin(); speakerOn = true; }
}

void playTone(uint8_t tone, uint8_t vol) {
  useSpeaker();
  M5.Speaker.setVolume(volumeFor(vol));
  if (tone == TONE_RECORDING) {
    if (clipBuf && clipLen) { M5.Speaker.playRaw(clipBuf, clipLen, clipRate, false, 1, 0, true); playing = nullptr; return; }
    tone = TONE_CHIME;
  }
  if (tone >= VOICE_FIRST && tone <= VOICE_LAST) {   // talking alert
    const VoiceClip& v = VOICE_CLIPS[tone - VOICE_FIRST];
    M5.Speaker.playRaw(v.pcm, v.len, VOICE_CLIP_RATE, false, 1, 0, true); playing = nullptr; return;
  }
  if (tone >= TONE_COUNT || patterns[tone].empty()) tone = TONE_CHIME;
  playing = &patterns[tone]; playIdx = 0; noteEnd = 0;
}
void stopSound() { playing = nullptr; if (speakerOn) M5.Speaker.stop(); }
bool soundBusy() { return playing != nullptr || M5.Speaker.isPlaying(); }
void serviceSound() {
  if (!playing || (int32_t)(millis() - noteEnd) < 0) return;
  if (playIdx >= playing->size()) { playing = nullptr; return; }
  const Note& n = (*playing)[playIdx++];
  if (n.f) M5.Speaker.tone(n.f, n.ms, 0, true);
  noteEnd = millis() + n.ms;
}
void chirp(uint16_t a, uint16_t b) {
  useSpeaker(); M5.Speaker.setVolume(volumeFor(min<uint8_t>(settings.volume, 3)));
  static std::vector<Note> c; c = { {a, 90}, {b, 140} }; playing = &c; playIdx = 0; noteEnd = 0;
}

void sillySound() {
  useSpeaker(); M5.Speaker.setVolume(volumeFor(min<uint8_t>(settings.volume, 2)));
  static std::vector<Note> s;
  switch (random(4)) {
    case 0: s.clear(); for (int f = 300; f <= 1100; f += 80) s.push_back({ (uint16_t)f, 12 }); break;             // boing
    case 1: s = { {1568, 50}, {0, 30}, {1568, 50} }; break;                                                     // boop boop
    case 2: s.clear(); for (int f = 1400; f >= 500; f -= 90) s.push_back({ (uint16_t)f, 14 }); break;             // whee-down
    default: s = { {880, 60}, {1175, 60}, {1760, 90} };                                                          // ta-da
  }
  playing = &s; playIdx = 0; noteEnd = 0;
}

// ===========================================================================
// Vibration add-on (M5Stack Unit Vibrator on the side port: yellow wire = G9)
// ===========================================================================
const int VIBE_PIN = 9;
bool vibeReady = false;
std::vector<uint16_t> vibePat; size_t vibeIdx = 0; uint32_t vibeNext = 0;
uint32_t vibeTestUntil = 0;   // the app's "test vibration" works before the setting is saved
bool vibeOn() { return (extras.flags & X_VIBE) || (int32_t)(vibeTestUntil - millis()) > 0; }
void stopVibe() { if (vibeReady) { ledcWrite(VIBE_PIN, 0); vibeIdx = vibePat.size() + 1; } }
// pattern: on, off, on, off... in milliseconds
void buzz(std::initializer_list<uint16_t> p) {
  if (!vibeOn()) return;
  M5.Power.setExtOutput(true);   // the side port's 5V (the TV remote may have turned it off)
  if (!vibeReady) { vibeReady = ledcAttach(VIBE_PIN, 10000, 8); if (!vibeReady) return; }
  vibePat.assign(p); vibeIdx = 0; vibeNext = 0;
}
void serviceVibe() {
  if (!vibeReady || vibeIdx > vibePat.size() || (int32_t)(millis() - vibeNext) < 0) return;
  if (vibeIdx == vibePat.size() || !vibeOn()) { ledcWrite(VIBE_PIN, 0); vibeIdx = vibePat.size() + 1; return; }
  ledcWrite(VIBE_PIN, vibeIdx % 2 == 0 ? 210 : 0);
  vibeNext = millis() + vibePat[vibeIdx++];
}

// ===========================================================================
// Screen
// ===========================================================================
M5Canvas canvas(&M5.Display);
enum Screen : uint8_t { SCR_HOME = 0, SCR_FIND, SCR_TV, SCR_CHECK, SCR_TIMER, SCR_NOTE, SCR_VOICEFX, SCR_CAMERA, SCR_LIGHT, SCR_FOUND, SCR_STATS, SCR_COUNT };
Screen screen = SCR_HOME;
bool screenOn = true; uint32_t lastActivity = 0;
uint32_t flashUntil = 0;            // light alert
String toastText; uint32_t toastUntil = 0;
bool flashlight = false;
bool checks[4] = { false, false, false, false };
uint32_t happyUntil = 0;            // "phone saved!" celebration

const uint32_t THEMES[5] = { 0xF06A1E, 0x2F7DE1, 0x1FA672, 0x7C5CE0, 0xE0457B };
uint16_t accent() { uint32_t c = THEMES[extras.theme % 5]; return canvas.color565(c >> 16, (c >> 8) & 0xFF, c & 0xFF); }
uint16_t rgb(uint32_t c) { return canvas.color565(c >> 16, (c >> 8) & 0xFF, c & 0xFF); }

void wake(uint32_t extraMs = 0) {
  lastActivity = millis() + extraMs;
  if (!screenOn) { M5.Display.wakeup(); screenOn = true; }
  const uint8_t b[6] = { 0, 30, 70, 120, 180, 255 };
  M5.Display.setBrightness(b[constrain(extras.brightness, 1, 5)]);
}
void sleepScreen() {
  if (!screenOn) return;
  flashlight = false;
  M5.Display.setBrightness(0);
  M5.Display.sleep();
  screenOn = false;
}
void toast(const String& t, uint32_t ms = 2500) { toastText = t; toastUntil = millis() + ms; wake(); }

// --- the little face ---
enum Mood { HAPPY, WORRIED, SLEEPY, EXCITED, NEUTRAL,
            WINK, TONGUE, COOL, LOVE, SURPRISED, DIZZY, CROSSEYED, KISSY, CRYING, ANGRY, GRIN };
const Mood SILLY_FACES[] = { WINK, TONGUE, COOL, LOVE, SURPRISED, CROSSEYED, KISSY, GRIN, ANGRY, DIZZY };
Mood sillyMood = HAPPY; uint32_t sillyUntil = 0, nextSilly = 0;
bool sillyOn() { return (extras.flags & X_FACE) && !(extras.flags & X_CALM_FACE); }
void makeFace(Mood m, uint32_t ms) { sillyMood = m; sillyUntil = millis() + ms; }
Mood randomSilly() { return SILLY_FACES[random(sizeof(SILLY_FACES) / sizeof(SILLY_FACES[0]))]; }

void heart(int x, int y, int s, uint16_t c) {
  canvas.fillCircle(x - s / 2, y - s / 4, s / 2 + 1, c); canvas.fillCircle(x + s / 2, y - s / 4, s / 2 + 1, c);
  canvas.fillTriangle(x - s - 1, y - s / 8, x + s + 1, y - s / 8, x, y + s, c);
}
void drawFace(int cx, int cy, int r, Mood mood, uint16_t col) {
  uint32_t t = millis();
  canvas.fillCircle(cx, cy, r, col);
  const uint16_t ink = TFT_BLACK, white = TFT_WHITE, red = rgb(0xE5304F), pink = rgb(0xFF8FA8), blue = rgb(0x5BC0FF);
  int ex = r * 38 / 100, ey = cy - r * 18 / 100, er = max(3, r / 7);
  int lx = cx - ex, rx = cx + ex;
  auto openEye   = [&](int x, int dx, int dy, int s) { canvas.fillCircle(x, ey, s + 2, white); canvas.fillCircle(x + dx, ey + 1 + dy, max(1, s - 1), ink); };
  auto closedEye = [&](int x) { canvas.fillRect(x - er, ey, er * 2, 3, ink); };
  auto happyEye  = [&](int x) { canvas.fillArc(x, ey + er / 2 + 1, er + 1, er - 2, 200, 340, ink); };   // ^
  auto sadEye    = [&](int x) { canvas.fillArc(x, ey - er / 2, er + 1, er - 2, 20, 160, ink); };        // u
  bool blink = (t / 150) % 25 == 0;

  // cheeks
  if (mood == LOVE || mood == KISSY || mood == GRIN) {
    canvas.fillEllipse(cx - r * 62 / 100, cy + r / 8, r / 7, r / 11, pink);
    canvas.fillEllipse(cx + r * 62 / 100, cy + r / 8, r / 7, r / 11, pink);
  }
  // eyes
  switch (mood) {
    case SLEEPY: closedEye(lx); closedEye(rx); break;
    case WINK:   openEye(lx, 0, 0, er); happyEye(rx); break;
    case KISSY: case GRIN: happyEye(lx); happyEye(rx); break;
    case CRYING: sadEye(lx); sadEye(rx); {
                   int drop = (t / 25) % (r / 2 + 6);
                   canvas.fillCircle(lx - 1, ey + er + 3 + drop, 3, blue); canvas.fillCircle(rx + 1, ey + er + 3 + (drop + r / 4) % (r / 2 + 6), 3, blue);
                 } break;
    case COOL: {
                 int w = er * 2 + 8, h = er * 2 + 3;
                 canvas.fillRoundRect(lx - w / 2, ey - h / 2, w, h, 4, ink); canvas.fillRoundRect(rx - w / 2, ey - h / 2, w, h, 4, ink);
                 canvas.fillRect(lx + w / 2 - 1, ey - h / 2 + 1, rx - lx - w + 2, 3, ink);
                 canvas.drawLine(lx - w / 2 + 3, ey - 1, lx - w / 2 + 6, ey - h / 2 + 3, white);
                 canvas.drawLine(rx - w / 2 + 3, ey - 1, rx - w / 2 + 6, ey - h / 2 + 3, white);
               } break;
    case LOVE: { int s = er + 1 + (int)((t / 220) % 2); heart(lx, ey, s, red); heart(rx, ey, s, red); } break;
    case SURPRISED: canvas.fillCircle(lx, ey, er + 5, white); canvas.fillCircle(rx, ey, er + 5, white);
                    canvas.fillCircle(lx, ey, max(2, er - 2), ink); canvas.fillCircle(rx, ey, max(2, er - 2), ink); break;
    case DIZZY:
      for (int x : { lx, rx }) {
        canvas.fillCircle(x, ey, er + 3, white);
        int a = (t / 3) % 360;
        canvas.fillArc(x, ey, er + 2, er, a, a + 270, ink);
        canvas.fillArc(x, ey, er - 2, max(0, er - 4), a + 180, a + 450, ink);
      } break;
    case CROSSEYED: openEye(lx, 3, 0, er + 1); openEye(rx, -3, 0, er + 1); break;
    case TONGUE: openEye(lx, 0, -2, er); openEye(rx, 0, -2, er); break;
    case ANGRY:  openEye(lx, 1, 1, er); openEye(rx, -1, 1, er);
                 for (int k = 0; k < 3; k++) {   // thick brows pointing down to the middle
                   canvas.drawLine(lx - er - 2, ey - er - 7 + k, lx + er + 1, ey - er - 1 + k, ink);
                   canvas.drawLine(rx + er + 2, ey - er - 7 + k, rx - er - 1, ey - er - 1 + k, ink);
                 } break;
    default:
      if (blink) { closedEye(lx); closedEye(rx); break; }
      { int look = mood == WORRIED ? (int)(sin(t / 180.0) * 2) : 0; openEye(lx, look, 0, er); openEye(rx, look, 0, er); }
  }
  if (mood == WORRIED) {   // eyebrows, high in the middle
    canvas.drawLine(lx - er, ey - er - 2, lx + er, ey - er - 6, ink);
    canvas.drawLine(rx + er, ey - er - 2, rx - er, ey - er - 6, ink);
  }
  // mouth
  int my = cy + r * 35 / 100;
  switch (mood) {
    case HAPPY: case WINK: case LOVE: canvas.fillArc(cx, my - r / 5, r / 2, r / 2 - 4, 20, 160, ink); break;
    case EXCITED: canvas.fillEllipse(cx, my, r / 4, r / 6, ink); break;
    case WORRIED: canvas.fillArc(cx, my + r / 5, r / 3, r / 3 - 4, 200, 340, ink); break;
    case CRYING:  canvas.fillArc(cx, my + r / 4, r / 3, r / 3 - 5, 200, 340, ink); break;
    case SLEEPY:  canvas.fillRect(cx - r / 6, my, r / 3, 3, ink);
                  canvas.setFont(&fonts::FreeSansBold9pt7b); canvas.setTextColor(white); canvas.setTextDatum(middle_center);
                  canvas.drawString("z", cx + r + 6, cy - r + 4 - (t / 300) % 6); break;
    case TONGUE: case CROSSEYED:
                  canvas.fillArc(cx, my - r / 5, r / 2, r / 2 - 4, 20, 160, ink);
                  canvas.fillEllipse(cx + r / 8, my + r / 6, r / 6, r / 5, red);
                  canvas.drawFastVLine(cx + r / 8, my + r / 12, r / 5, rgb(0x9C1B30)); break;
    case COOL:    canvas.fillArc(cx + r / 6, my - r / 4, r / 3, r / 3 - 4, 30, 120, ink); break;
    case SURPRISED: canvas.fillCircle(cx, my + 2, r / 5, ink); canvas.fillCircle(cx, my + 2, max(1, r / 5 - 4), rgb(0x7A1626)); break;
    case DIZZY:   for (int i = -r / 3; i <= r / 3; i += 2) canvas.fillRect(cx + i, my + (int)(sin((i + t / 25.0) / 3.0) * 3), 2, 3, ink); break;
    case KISSY:   canvas.fillArc(cx, my - 3, 5, 3, 270, 450, ink); canvas.fillArc(cx, my + 4, 5, 3, 270, 450, ink);
                  heart(cx + r + 4, cy - r / 3 - (int)((t / 40) % 16), 5, red); break;
    case ANGRY:   canvas.fillRoundRect(cx - r / 4, my, r / 2, 6, 2, ink); break;
    case GRIN:    canvas.fillArc(cx, my - r / 6, r / 2, 0, 0, 180, ink);
                  canvas.fillRect(cx - r / 2 + 4, my - r / 6 + 1, r - 8, 4, white); break;
    default:      canvas.fillRect(cx - r / 5, my, r * 2 / 5, 3, ink);
  }
}

void drawBattery(int x, int y) {
  canvas.drawRoundRect(x, y, 26, 13, 3, TFT_WHITE);
  canvas.fillRect(x + 26, y + 4, 2, 5, TFT_WHITE);
  int lvl = battery < 0 ? 0 : battery;
  uint16_t c = lvl <= 15 ? TFT_RED : lvl <= 35 ? TFT_ORANGE : TFT_GREEN;
  canvas.fillRect(x + 2, y + 2, max(1, 22 * lvl / 100), 9, c);
  if (charging) { canvas.fillTriangle(x + 14, y + 1, x + 9, y + 7, x + 13, y + 7, TFT_YELLOW); canvas.fillTriangle(x + 12, y + 12, x + 17, y + 6, x + 13, y + 6, TFT_YELLOW); }
}

void drawTop(const char* title) {
  canvas.setFont(&fonts::FreeSansBold9pt7b);
  canvas.setTextDatum(top_left); canvas.setTextColor(TFT_WHITE);
  canvas.drawString(title, 8, 6);
  String c = clockText();
  canvas.setTextDatum(top_right);
  if (c.length()) canvas.drawString(c, 202, 6);
  drawBattery(208, 8);
}
void drawHint(const char* text) {
  canvas.setFont(&fonts::Font2); canvas.setTextDatum(bottom_center); canvas.setTextColor(rgb(0xB8B3C8));
  canvas.drawString(text, 120, 133);
}
void bigText(const String& t, int y, uint16_t color, const lgfx::IFont* f = &fonts::FreeSansBold12pt7b) {
  canvas.setFont(f); canvas.setTextDatum(middle_center); canvas.setTextColor(color); canvas.drawString(t, 120, y);
}

int signalLevel() {   // 0..5
  if (!primaryUp || !haveRssi) return 0;
  return constrain((int)roundf((rssiAvg + 97) / 9), 1, 5);
}
void drawBars(int x, int y, int level, uint16_t on) {
  for (int i = 0; i < 5; i++) {
    int h = 6 + i * 5;
    canvas.fillRoundRect(x + i * 9, y + 30 - h, 6, h, 2, i < level ? on : rgb(0x3A3550));
  }
}

const uint16_t BG = 0x10A3;   // deep plum
void drawScreen() {
  uint32_t now = millis();
  bool flashing = (int32_t)(flashUntil - now) > 0;
  bool alertView = alerting && !ringOnce;

  // --- full-screen states first ---
  if (flashlight && screen == SCR_LIGHT) { canvas.fillScreen(TFT_WHITE); canvas.pushSprite(0, 0); return; }

  if (alertView || flashing) {
    bool on = (now / 250) % 2;
    canvas.fillScreen(on ? accent() : rgb(0xC81E3A));
    drawFace(42, 62, 30, alertView ? ((now / 2500) % 2 ? CRYING : WORRIED) : SURPRISED, rgb(0xFFC93C));
    canvas.setFont(&fonts::FreeSansBold12pt7b); canvas.setTextDatum(middle_left); canvas.setTextColor(TFT_WHITE);
    canvas.drawString(alertView ? "Grab your" : "Here I am!", 84, 46);
    canvas.drawString(alertView ? "phone!" : "", 84, 74);
    drawHint(alertView ? "A: stop    hold A: pause" : "A: stop");
    canvas.pushSprite(0, 0); return;
  }
  if (notifyUntil && (int32_t)(notifyUntil - now) > 0) {
    canvas.fillScreen(rgb(0x1F63B5));
    canvas.setFont(&fonts::FreeSansBold9pt7b); canvas.setTextDatum(top_left); canvas.setTextColor(rgb(0xCFE2FF));
    const char* what = notifyCat == 1 ? "Incoming call" : notifyCat == 2 ? "Missed call" : notifyCat == 3 ? "Voicemail" : "Message";
    canvas.drawString(what, 10, 8);
    canvas.setFont(&fonts::FreeSansBold12pt7b); canvas.setTextColor(TFT_WHITE);
    String t = notifyTitle.length() ? notifyTitle : String("Someone");
    if (t.length() > 16) t = t.substring(0, 15) + "...";
    canvas.drawString(t, 10, 32);
    canvas.setFont(&fonts::FreeSans9pt7b);
    String b = notifyCat == 1 ? String("is calling you") : notifyBody;
    canvas.setTextWrap(true);
    canvas.setCursor(10, 66);
    if (b.length() > 70) b = b.substring(0, 69) + "...";
    canvas.print(b);
    canvas.setTextWrap(false);
    drawHint("A: dismiss");
    canvas.pushSprite(0, 0); return;
  }
  if (calibrating) {
    canvas.fillScreen(rgb(0x2B2440));
    drawTop("Walk test");
    bigText("Walk to where", 50, TFT_WHITE); bigText("you want the beep", 76, TFT_WHITE);
    drawBars(98, 92, signalLevel(), accent());
    drawHint("then press A");
    canvas.pushSprite(0, 0); return;
  }

  canvas.fillScreen(BG);
  switch (screen) {
    case SCR_HOME: {
      bool paused = dndActive();
      bool quietNow = inQuietTime();
      Mood mood = (int32_t)(happyUntil - now) > 0 ? LOVE : paused || quietNow ? SLEEPY : primaryUp ? HAPPY : seenPrimary ? WORRIED : NEUTRAL;
      if ((int32_t)(sillyUntil - now) > 0) mood = sillyMood;
      drawTop(tagName.c_str());
      if (extras.flags & X_FACE) drawFace(52, 74, 36, mood, accent());
      int x = (extras.flags & X_FACE) ? 100 : 12;
      canvas.setTextDatum(top_left);
      canvas.setFont(&fonts::FreeSansBold12pt7b); canvas.setTextColor(TFT_WHITE);
      String line1 = (int32_t)(happyUntil - now) > 0 ? "Phone saved!" : paused ? "Paused" : quietNow ? "Quiet time" : primaryUp ? "Phone nearby" : seenPrimary ? "Phone is away" : "Pair me";
      canvas.drawString(line1, x, 40);
      canvas.setFont(&fonts::FreeSans9pt7b); canvas.setTextColor(rgb(0xD6D1E6));
      String line2 = paused ? "until " + untilText(dndUntilMs) : primaryUp ? "All good" : seenPrimary ? "Looking for it..." : "in Bluetooth settings";
      canvas.drawString(line2, x, 68);
      if (primaryUp && !paused) drawBars(x, 88, signalLevel(), accent());
      int s = streakDays();
      if (s > 0 && x > 12) { canvas.setFont(&fonts::Font2); canvas.setTextColor(rgb(0xFFC93C)); canvas.setTextDatum(top_left); canvas.drawString(String(s) + (s == 1 ? " day streak" : " day streak"), x + 52, 100); }
      drawHint(sillyOn() ? "A: make a face   B: more" : "B: more    A x2: ring phone");
      break;
    }
    case SCR_FIND: {
      drawTop("Find my phone");
      int lvl = signalLevel();
      const char* words[6] = { "Out of range", "Cold", "Cool", "Warm", "Hot!", "On fire!" };
      const uint32_t cols[6] = { 0x8A8399, 0x2F7DE1, 0x2C8C8C, 0xE0A100, 0xF06A1E, 0xE5304F };
      uint16_t c = rgb(cols[lvl]);
      int pulse = (now / 60) % 30;
      if (lvl) canvas.drawCircle(52, 76, 20 + pulse, c);
      canvas.fillCircle(52, 76, 18 + lvl * 3, c);
      canvas.setFont(lvl ? &fonts::FreeSansBold18pt7b : &fonts::FreeSansBold12pt7b);
      canvas.setTextDatum(middle_left); canvas.setTextColor(c);
      canvas.drawString(words[lvl], 98, 52);
      drawBars(100, 78, lvl, c);
      drawHint(primaryUp ? "A: make my phone ring" : "Get closer to your phone");
      break;
    }
    case SCR_CHECK: {
      drawTop("Before you go");
      canvas.setFont(&fonts::FreeSans9pt7b); canvas.setTextDatum(middle_left);
      for (int i = 0; i < 4; i++) {
        bool done = checks[i] || (i == 0 && checkItems[0].equalsIgnoreCase("phone") && primaryUp);
        int y = 40 + i * 22;
        canvas.drawRoundRect(10, y - 8, 16, 16, 4, done ? TFT_GREEN : TFT_WHITE);
        if (done) { canvas.drawLine(13, y, 17, y + 4, TFT_GREEN); canvas.drawLine(17, y + 4, 24, y - 5, TFT_GREEN); }
        canvas.setTextColor(done ? rgb(0x9AE6B4) : TFT_WHITE);
        canvas.drawString(checkItems[i], 34, y);
      }
      drawHint("A: tick next item");
      break;
    }
    case SCR_TIMER: {
      drawTop("Parking timer");
      if (timerEndMs) {
        int32_t left = (int32_t)(timerEndMs - now) / 1000;
        if (left < 0) left = 0;
        char buf[16]; snprintf(buf, sizeof(buf), "%d:%02d:%02d", (int)(left / 3600), (int)((left / 60) % 60), (int)(left % 60));
        bigText(buf, 64, left < 600 ? rgb(0xFFC93C) : TFT_WHITE, &fonts::FreeSansBold18pt7b);
        drawHint("A: +15 min    hold A: clear");
      } else if (timerDone) {
        bigText("Time's up!", 64, accent(), &fonts::FreeSansBold18pt7b);
        drawHint("A: start again");
      } else {
        bigText("No timer", 56, TFT_WHITE);
        canvas.setFont(&fonts::FreeSans9pt7b); canvas.setTextColor(rgb(0xD6D1E6)); canvas.drawString("Each A press adds " + String(extras.timerStep) + " min", 120, 84);
        drawHint("A: start");
      }
      break;
    }
    case SCR_NOTE: {
      drawTop("Voice note");
      if (recordingNote) {
        canvas.fillCircle(120, 66, 22 + (now / 120) % 6, rgb(0xC81E3A));
        bigText("Recording...", 108, TFT_WHITE, &fonts::FreeSans9pt7b);
      } else {
        canvas.fillCircle(120, 62, 22, accent());
        canvas.fillRoundRect(114, 48, 12, 22, 6, TFT_WHITE); canvas.drawFastVLine(120, 72, 6, TFT_WHITE);
        bigText(noteLen ? String(noteLen / VOICE_RATE) + "s note saved" : "No note yet", 100, rgb(0xD6D1E6), &fonts::FreeSans9pt7b);
      }
      drawHint("hold A: record    A: play");
      break;
    }
    case SCR_TV: {
      drawTop("TV remote");
      if (learnSlot >= 0) {
        int p = (now / 90) % 14;
        canvas.fillRoundRect(16, 52, 30, 52, 6, rgb(0x5B5670)); canvas.fillCircle(31, 62, 5, rgb(0xE5304F));
        for (int i = 0; i < 3; i++) canvas.drawArc(31, 50, 10 + i * 8 + p / 3, 9 + i * 8 + p / 3, 230, 310, accent());
        canvas.setFont(&fonts::FreeSans9pt7b); canvas.setTextDatum(top_left); canvas.setTextColor(TFT_WHITE);
        canvas.drawString("Point your old remote", 60, 44);
        canvas.drawString("at me and press", 60, 64);
        canvas.setFont(&fonts::FreeSansBold12pt7b); canvas.setTextColor(accent());
        canvas.drawString(TV_NAMES[learnSlot], 60, 86);
        break;
      }
      if (!tvMask) {
        bigText("Not set up yet", 56, TFT_WHITE);
        canvas.setFont(&fonts::FreeSans9pt7b); canvas.setTextColor(rgb(0xD6D1E6));
        canvas.drawString("Set it up in the app:", 120, 84); canvas.drawString("your tag > TV remote", 120, 102);
        break;
      }
      bool flash = (int32_t)(tvSentFlash - now) > 0;
      canvas.fillRoundRect(10, 38, 220, 56, 12, flash ? TFT_WHITE : accent());
      canvas.setFont(&fonts::FreeSansBold18pt7b); canvas.setTextDatum(middle_center); canvas.setTextColor(flash ? accent() : TFT_WHITE);
      canvas.drawString(TV_NAMES[tvSel], 120, 66);
      int count = 0; for (int i = 0; i < TV_SLOTS; i++) if (tvMask & (1 << i)) count++;
      int x = 120 - (count - 1) * 7;
      for (int i = 0; i < TV_SLOTS; i++) if (tvMask & (1 << i)) { canvas.fillCircle(x, 104, i == tvSel ? 4 : 2, i == tvSel ? TFT_WHITE : rgb(0x8A8399)); x += 14; }
      drawHint("A: send   A x2: next   hold: repeat");
      break;
    }
    case SCR_VOICEFX: {
      drawTop("Voice changer");
      if (fxRecording) {
        canvas.fillCircle(120, 62, 22 + (now / 120) % 6, rgb(0xC81E3A));
        bigText("Talk now...", 104, TFT_WHITE, &fonts::FreeSans9pt7b);
      } else {
        // a little mouth that talks while it plays
        bool talking = M5.Speaker.isPlaying();
        int open = talking ? 4 + (now / 70) % 10 : 3;
        canvas.fillRoundRect(16, 40, 64, 56, 14, accent());
        canvas.fillCircle(34, 58, 5, TFT_WHITE); canvas.fillCircle(62, 58, 5, TFT_WHITE);
        canvas.fillCircle(34, 59, 2, TFT_BLACK); canvas.fillCircle(62, 59, 2, TFT_BLACK);
        canvas.fillRoundRect(36, 76 - open / 2, 24, open + 2, 3, TFT_BLACK);
        canvas.setFont(&fonts::FreeSansBold12pt7b); canvas.setTextDatum(middle_left); canvas.setTextColor(TFT_WHITE);
        canvas.drawString(FX_NAMES[fxEffect], 92, 60);
        canvas.setFont(&fonts::Font2); canvas.setTextColor(rgb(0xD6D1E6));
        canvas.drawString(fxLen ? "A: next voice" : "Hold A and talk", 92, 84);
      }
      drawHint("hold A: talk    A: next voice");
      break;
    }
    case SCR_CAMERA: {
      drawTop("Camera remote");
      canvas.fillRoundRect(84, 42, 72, 48, 8, accent());
      canvas.fillCircle(120, 66, 15, BG); canvas.fillCircle(120, 66, 9, accent());
      canvas.fillRect(96, 36, 20, 8, accent());
      canvas.setFont(&fonts::FreeSans9pt7b); canvas.setTextDatum(middle_center); canvas.setTextColor(rgb(0xD6D1E6));
      canvas.drawString(primaryUp ? "Open your camera app" : "Not connected to phone", 120, 104);
      drawHint("A: take photo");
      break;
    }
    case SCR_LIGHT: {
      drawTop("Flashlight");
      canvas.fillCircle(120, 66, 24, rgb(0xFFF3C4));
      drawHint("A: turn on / off");
      break;
    }
    case SCR_FOUND: {
      drawTop("If found");
      canvas.setFont(&fonts::FreeSansBold9pt7b); canvas.setTextColor(TFT_WHITE);
      canvas.setTextWrap(true); canvas.setCursor(10, 40);
      canvas.print(foundMsg);
      canvas.setTextWrap(false);
      drawHint("Set this message in the app");
      break;
    }
    case SCR_STATS: {
      drawTop("Your streak");
      int s = streakDays();
      canvas.fillTriangle(40, 40, 22, 86, 58, 86, rgb(0xF06A1E)); canvas.fillCircle(40, 84, 18, rgb(0xF06A1E)); canvas.fillCircle(40, 86, 9, rgb(0xFFC93C));
      canvas.setFont(&fonts::FreeSansBold18pt7b); canvas.setTextDatum(middle_left); canvas.setTextColor(TFT_WHITE);
      canvas.drawString(s < 0 ? "--" : String(s), 76, 52);
      canvas.setFont(&fonts::FreeSans9pt7b); canvas.setTextColor(rgb(0xD6D1E6));
      canvas.drawString(s == 1 ? "day without forgetting" : "days without forgetting", 76, 78);
      canvas.drawString("Saves: " + String(stats.saves) + "   Best: " + String(stats.best), 76, 100);
      drawHint(s < 0 ? "Open the app once to set the date" : "Keep it going!");
      break;
    }
    default: break;
  }

  // page dots
  for (int i = 0; i < SCR_COUNT; i++) canvas.fillCircle(120 - (SCR_COUNT - 1) * 4 + i * 8, 120, 2, i == screen ? TFT_WHITE : rgb(0x5A5470));

  if ((int32_t)(toastUntil - now) > 0) {
    canvas.fillRoundRect(16, 96, 208, 30, 10, TFT_WHITE);
    canvas.setFont(&fonts::FreeSansBold9pt7b); canvas.setTextDatum(middle_center); canvas.setTextColor(BG);
    canvas.drawString(toastText, 120, 111);
  }
  canvas.pushSprite(0, 0);
}

// ===========================================================================
// Alerts
// ===========================================================================
void playAlertOnce(bool force) {
  uint8_t style = settings.style;
  if (force) style = STYLE_ALL;
  else if (inQuietTime()) style = settings.quietMode == 1 ? STYLE_LIGHT : STYLE_PHONE_ONLY;
  bool sound = style == STYLE_SOUND || style == STYLE_ALL;
  bool vibe  = style == STYLE_VIBRATE || style == STYLE_VIBE_LIGHT || style == STYLE_ALL;
  // without the vibration add-on, "vibrate" flashes the screen instead
  bool light = style == STYLE_LIGHT || style == STYLE_VIBE_LIGHT || style == STYLE_ALL || (style == STYLE_VIBRATE && !vibeOn());
  if (vibe) buzz({ 500, 250, 500, 250, 500 });
  if (light || sound || vibe) wake();
  if (light) flashUntil = millis() + 3000;
  if (sound) playTone(settings.tone, settings.volume);
}
void startAlert() {
  alertFired = true;
  if (settings.style == STYLE_PHONE_ONLY) return;
  Serial.println("ALERT: separated from phone");
  alerting = true; ringOnce = false; alertPlays = 0; alertStartMs = millis(); nextAlertMs = millis();
  screen = SCR_HOME;
}
void stopAlert() { alerting = false; ringOnce = false; flashUntil = 0; stopSound(); stopVibe(); }
void serviceAlert() {
  if (!alerting || (int32_t)(millis() - nextAlertMs) < 0 || soundBusy()) return;
  playAlertOnce(ringOnce);
  alertPlays++;
  uint8_t limit = ringOnce ? 1 : settings.repeat;
  if ((limit && alertPlays >= limit) || millis() - alertStartMs > 30UL * 60000UL) { alerting = false; ringOnce = false; return; }
  nextAlertMs = millis() + (uint32_t)max<uint8_t>(settings.interval, 2) * 1000UL;
}

// ===========================================================================
// Motion
// ===========================================================================
void updateMotion() {
  static uint32_t last = 0;
  if (millis() - last < 100) return;
  last = millis();
  float ax, ay, az;
  if (!M5.Imu.getAccel(&ax, &ay, &az)) return;
  float mag = sqrtf(ax * ax + ay * ay + az * az);   // in g
  if (fabsf(mag - lastMag) > 0.12f) {
    bool wasStill = !lastMotionMs || millis() - lastMotionMs > 20UL * 60000UL;
    lastMotionMs = millis();
    // Picked up after sitting still for a while: show the checklist
    if (wasStill && (extras.flags & X_PICKUP_WAKE) && !alerting) {
      if (extras.flags & X_CHECKLIST) { screen = SCR_CHECK; for (bool& c : checks) c = false; }
      wake();
    }
  }
  // Shake it (screen on): dizzy face
  static uint8_t shakes = 0; static uint32_t shakeStart = 0;
  if (fabsf(mag - lastMag) > 0.9f && screenOn && sillyOn() && !alerting) {
    if (millis() - shakeStart > 1500) { shakeStart = millis(); shakes = 0; }
    if (++shakes >= 4) {
      shakes = 0; shakeStart = 0;
      screen = SCR_HOME; makeFace(DIZZY, 3500); toast("Whoa! Dizzy!", 2000);
      useSpeaker(); M5.Speaker.setVolume(volumeFor(2));
      static std::vector<Note> w; w.clear();
      for (int r = 0; r < 3; r++) for (int f = 1200; f >= 600; f -= 100) w.push_back({ (uint16_t)f, 15 });
      playing = &w; playIdx = 0; noteEnd = 0;
    }
  }
  lastMag = mag;
}
bool isMoving() { return lastMotionMs && millis() - lastMotionMs < 8000; }

// ===========================================================================
// Events for the app, HID camera button
// ===========================================================================
void notifyEvent(uint8_t ev) { lastEvent = ev; eventCounter++; }

void cameraShutter() {
  if (!hidInput || !primaryUp) { toast("Not connected"); return; }
  uint8_t down[2] = { 0xE9, 0x00 }, up[2] = { 0, 0 };   // Consumer "Volume Up" = camera shutter
  hidInput->setValue(down, 2); hidInput->notify();
  delay(60);
  hidInput->setValue(up, 2); hidInput->notify();
  toast("Click!", 1200);
}

// ===========================================================================
// Voice note (microphone)
// ===========================================================================
void startNote() {
  if (!noteBuf) return;
  stopSound(); M5.Speaker.end(); speakerOn = false;
  if (!M5.Mic.begin()) { useSpeaker(); toast("Mic error"); return; }
  micActive = true; recordingNote = true; notePos = 0;
}
void serviceNote() {
  if (!recordingNote) return;
  const uint32_t CH = 800;
  if (M5.Mic.isRecording() < 2 && notePos + CH <= VOICE_MAX) { M5.Mic.record(noteBuf + notePos, CH, VOICE_RATE); notePos += CH; }
}
void stopNote();
void checkNoteFull() { if (recordingNote && notePos + 800 > VOICE_MAX) stopNote(); }
void stopNote() {
  if (!recordingNote) return;
  while (M5.Mic.isRecording()) delay(5);
  recordingNote = false;
  M5.Mic.end(); micActive = false;
  useSpeaker();
  noteLen = notePos;
  File f = LittleFS.open("/note.raw", "w");
  if (f) { f.write(noteBuf, noteLen); f.close(); }
  toast(String(noteLen / VOICE_RATE) + "s note saved");
}
void playNote() {
  if (!noteLen) { toast("No note yet"); return; }
  useSpeaker(); M5.Speaker.setVolume(volumeFor(5));
  M5.Speaker.playRaw(noteBuf, noteLen, VOICE_RATE, false, 1, 0, true);
}


// ===========================================================================
// TV remote (IR LED on G46, IR receiver on G42; both powered from the 5V port rail)
// A saved button is a list of on/off times in microseconds, starting with "on".
// The app builds them from the TV-code list, or the tag learns them from an old remote.
// ===========================================================================

void irPower() { M5.Power.setExtOutput(true); irLastUse = millis(); }
void loadTv() {
  tvMask = 0;
  if (!tvCodes) return;
  if (File f = LittleFS.open("/tv.bin", "r")) { f.read((uint8_t*)tvCodes, sizeof(TvCode) * TV_SLOTS); f.close(); }
  for (int i = 0; i < TV_SLOTS; i++) if (tvCodes[i].n >= 4 && tvCodes[i].n <= TV_MAX) tvMask |= 1 << i; else tvCodes[i].n = 0;
  while (tvMask && !(tvMask & (1 << tvSel))) tvSel = (tvSel + 1) % TV_SLOTS;
}
void saveTv() {
  if (File f = LittleFS.open("/tv.bin", "w")) { f.write((uint8_t*)tvCodes, sizeof(TvCode) * TV_SLOTS); f.close(); }
  loadTv();
  uint8_t m = tvMask; irChr->setValue(&m, 1);
}
// Send one code. Times over 32 ms are split, since one RMT step holds at most 32767 us.
void irSend(uint16_t khz, const uint16_t* t, uint16_t n) {
  if (!n) return;
  irPower();
  if (!irTxReady) { irTxReady = rmtInit(IR_TX, RMT_TX_MODE, RMT_MEM_NUM_BLOCKS_1, 1000000); rmtSetEOT(IR_TX, 0); }
  if (!irTxReady) { toast("IR error"); return; }
  rmtSetCarrier(IR_TX, true, true, (uint32_t)constrain(khz, 30, 60) * 1000, 0.33f);
  static rmt_data_t sym[TV_MAX + 40];
  size_t k = 0; int half = 0;
  auto put = [&](bool level, uint32_t d) {
    while (d && k < sizeof(sym) / sizeof(sym[0])) {
      uint16_t part = d > 32767 ? 32767 : d; d -= part;
      if (half == 0) { sym[k].level0 = level; sym[k].duration0 = part; half = 1; }
      else { sym[k].level1 = level; sym[k].duration1 = part; half = 0; k++; }
    }
  };
  for (uint16_t i = 0; i < n; i++) put(i % 2 == 0, t[i]);
  if (half) { sym[k].level1 = 0; sym[k].duration1 = 100; k++; }
  rmtWrite(IR_TX, sym, k, 300);
}
void tvPress(uint8_t slot) {
  if (!(tvMask & (1 << slot))) return;
  irSend(tvCodes[slot].khz, tvCodes[slot].t, tvCodes[slot].n);
  tvSentFlash = millis() + 250;
}

// Learning: listen to an old remote for up to 15 seconds
void startLearn(uint8_t slot) {
  if (slot >= TV_SLOTS) return;
  stopSound(); if (speakerOn) { M5.Speaker.end(); speakerOn = false; }   // the speaker amp drowns out the receiver
  irPower();
  if (!irRxOn) {
    irRxOn = rmtInit(IR_RX, RMT_RX_MODE, RMT_MEM_NUM_BLOCKS_4, 1000000);
    if (!irRxOn) { toast("IR error"); notifyEvent(4); return; }
    rmtSetRxMaxThreshold(IR_RX, 15000);   // 15 ms of quiet = end of a code
    rmtSetRxMinThreshold(IR_RX, 100);     // ignore blips under 0.1 ms
  }
  irRxCount = sizeof(irRx) / sizeof(irRx[0]);
  rmtReadAsync(IR_RX, irRx, &irRxCount);
  learnSlot = slot; learnUntil = millis() + 15000;
  screen = SCR_TV; tvSel = slot; wake();
}
void endLearn() {
  learnSlot = -1;
  if (irRxOn) { rmtDeinit(IR_RX); irRxOn = false; }
}
void serviceLearn() {
  if (learnSlot < 0) return;
  if ((int32_t)(millis() - learnUntil) > 0) { endLearn(); notifyEvent(4); toast("Didn't hear a remote"); return; }
  if (!rmtReceiveCompleted(IR_RX)) return;
  // The receiver pulls its pin low while it sees IR, so low = "on"
  TvCode& c = tvCodes[learnSlot];
  uint16_t n = 0; int lastLevel = -1;
  for (size_t i = 0; i < irRxCount && n < TV_MAX; i++) {
    for (int h = 0; h < 2; h++) {
      uint16_t d = h ? irRx[i].duration1 : irRx[i].duration0;
      int on = (h ? irRx[i].level1 : irRx[i].level0) == 0;
      if (!d) { i = irRxCount; break; }
      if (n == 0 && !on) continue;                 // skip leading quiet
      if (on == lastLevel && n) { c.t[n - 1] = min<uint32_t>(65535, c.t[n - 1] + d); continue; }
      if (n < TV_MAX) c.t[n++] = d; lastLevel = on;
    }
  }
  if (n % 2 == 0 && n) n--;                        // end on an "on"
  if (n < 12) {                                    // too short: noise, listen again
    irRxCount = sizeof(irRx) / sizeof(irRx[0]); rmtReadAsync(IR_RX, irRx, &irRxCount); return;
  }
  // Sony remotes expect the code 3 times
  if (c.t[0] > 2000 && c.t[0] < 2800 && n <= 42 && n * 3 + 2 <= TV_MAX) {
    uint32_t len = 0; for (int i = 0; i < n; i++) len += c.t[i];
    uint16_t gap = len < 44000 ? 45000 - len : 2000;
    for (int r = 1; r < 3; r++) { c.t[r * (n + 1) - 1] = gap; memcpy(&c.t[r * (n + 1)], c.t, n * 2); }
    n = n * 3 + 2;
  }
  c.n = n; c.khz = 38;
  uint8_t slot = learnSlot;
  endLearn(); saveTv();
  notifyEvent(3);
  toast(String("Learned ") + TV_NAMES[slot] + "!"); chirp(1568, 2093);
}

// Writes from the app: [1 save | 2 test, slot, kHz, times (u16 little endian)...], [3 clear], [4 learn, slot], [5 send saved, slot]
void handleIr(const uint8_t* d, uint16_t len) {
  if (!tvCodes || !len) return;
  switch (d[0]) {
    case 1: case 2: {
      if (len < 3 + 8 || d[1] >= TV_SLOTS) return;
      uint16_t n = min<uint16_t>((len - 3) / 2, TV_MAX);
      static TvCode tmp; TvCode& c = d[0] == 1 ? tvCodes[d[1]] : tmp;
      c.khz = d[2]; c.n = n;
      for (uint16_t i = 0; i < n; i++) c.t[i] = d[3 + i * 2] | (d[4 + i * 2] << 8);
      if (d[0] == 1) saveTv(); else { irSend(c.khz, c.t, c.n); toast(String("Sent ") + TV_NAMES[d[1]], 1200); }
      break;
    }
    case 3: for (int i = 0; i < TV_SLOTS; i++) tvCodes[i].n = 0; saveTv(); break;
    case 4: if (len >= 2) startLearn(d[1]); break;
    case 5: if (len >= 2) { tvPress(d[1]); toast(String("Sent ") + TV_NAMES[d[1] % TV_SLOTS], 1200); } break;
    case 6: endLearn(); break;
  }
}
void nextTvButton() {
  if (!tvMask) return;
  do { tvSel = (tvSel + 1) % TV_SLOTS; } while (!(tvMask & (1 << tvSel)));
}

// ===========================================================================
// Voice changer: hold to talk, let go to hear it back funny
// ===========================================================================

void startFx() {
  if (!fxIn) return;
  stopSound(); if (speakerOn) { M5.Speaker.end(); speakerOn = false; }
  if (!M5.Mic.begin()) { useSpeaker(); toast("Mic error"); return; }
  micActive = true; fxRecording = true; fxPos = 0;
}
void serviceFx() {
  if (!fxRecording) return;
  const uint32_t CH = 800;
  if (M5.Mic.isRecording() < 2 && fxPos + CH <= FX_MAX) { M5.Mic.record(fxIn + fxPos, CH, FX_RATE); fxPos += CH; }
}
void playFx() {
  if (!fxLen) { toast("Hold A and talk"); return; }
  uint32_t n = fxLen, rate = FX_RATE;
  const float TWO_PI_F = 6.2831853f;
  switch (fxEffect) {
    case 0: memcpy(fxOut, fxIn, n * 2); rate = FX_RATE * 16 / 10; break;          // faster = higher
    case 1: memcpy(fxOut, fxIn, n * 2); rate = FX_RATE * 68 / 100; break;         // slower = deeper
    case 2:                                                                        // robot: ring modulation + metal ring
      for (uint32_t i = 0; i < n; i++) {
        float m = sinf(TWO_PI_F * 70.0f * i / FX_RATE);
        float y = fxIn[i] * m + (i >= 96 ? 0.45f * fxOut[i - 96] : 0);
        fxOut[i] = (int16_t)constrain((int)y, -32767, 32767);
      } break;
    case 3:                                                                        // alien: fast wobble
      { float phase = 0;
        for (uint32_t i = 0; i < n; i++) {
          phase += TWO_PI_F * (300.0f + 120.0f * sinf(TWO_PI_F * 3.0f * i / FX_RATE)) / FX_RATE;
          if (phase > TWO_PI_F) phase -= TWO_PI_F;
          fxOut[i] = (int16_t)constrain((int)(fxIn[i] * (0.35f + 0.9f * sinf(phase))), -32767, 32767);
        } }
      rate = FX_RATE * 115 / 100; break;
    case 4: {                                                                      // echo
      const uint32_t D = FX_RATE / 4;
      n = min<uint32_t>(fxLen + FX_RATE * 3 / 2, FX_OUT);
      for (uint32_t i = 0; i < n; i++) {
        float y = (i < fxLen ? fxIn[i] : 0) + (i >= D ? 0.55f * fxOut[i - D] : 0);
        fxOut[i] = (int16_t)constrain((int)y, -32767, 32767);
      } break;
    }
    default: for (uint32_t i = 0; i < n; i++) fxOut[i] = fxIn[n - 1 - i];         // backwards
  }
  useSpeaker(); M5.Speaker.setVolume(volumeFor(5));
  M5.Speaker.playRaw(fxOut, n, rate, false, 1, 0, true);
}
void stopFx() {
  if (!fxRecording) return;
  while (M5.Mic.isRecording()) delay(5);
  fxRecording = false;
  M5.Mic.end(); micActive = false;
  fxLen = fxPos;
  if (fxLen < FX_RATE / 4) { fxLen = 0; useSpeaker(); toast("Hold A while you talk"); return; }
  // Make quiet recordings loud, and cut the click at the start
  int peak = 1;
  for (uint32_t i = 0; i < fxLen; i++) peak = max(peak, abs((int)fxIn[i]));
  float g = min(8.0f, 29000.0f / peak);
  for (uint32_t i = 0; i < fxLen; i++) fxIn[i] = (int16_t)(fxIn[i] * g * (i < 400 ? i / 400.0f : 1.0f));
  playFx();
}
void checkFxFull() { if (fxRecording && fxPos + 800 > FX_MAX) stopFx(); }

// ===========================================================================
// Buttons
// ===========================================================================
void onButtonA_single() {
  if (calibrating) {
    if (primaryUp && haveRssi) {
      settings.threshold = (int8_t)constrain((int)rssiAvg - 3, -100, -30);
      saveSettingsPending = true; notifyEvent(2);
      toast("Distance saved!"); chirp(1568, 2093);
    } else { toast("Can't hear phone"); }
    calibrating = false; return;
  }
  if (alerting || (int32_t)(flashUntil - millis()) > 0) { stopAlert(); toast("Alert stopped"); return; }
  if (notifyUntil) { notifyUntil = 0; return; }
  switch (screen) {
    case SCR_HOME:   if (dndActive()) { dndUntilMs = 0; toast("Alerts on"); }
                     else if (sillyOn()) { Mood m; do { m = randomSilly(); } while (m == sillyMood); makeFace(m, 2500); sillySound(); }
                     break;
    case SCR_FIND:   if (primaryUp) { notifyEvent(1); toast("Ringing your phone"); } break;
    case SCR_CHECK:  for (int i = 0; i < 4; i++) if (!checks[i]) { checks[i] = true; chirp(1047, 1319); break; } break;
    case SCR_TIMER:  timerDone = false;
                     timerEndMs = (timerEndMs ? timerEndMs : millis()) + (uint32_t)extras.timerStep * 60000UL;
                     if (timerEndMs - millis() > 4UL * 3600000UL) timerEndMs = millis() + 4UL * 3600000UL; break;
    case SCR_NOTE:   playNote(); break;
    case SCR_TV:     if (learnSlot >= 0) { endLearn(); notifyEvent(4); toast("Stopped"); } else tvPress(tvSel); break;
    case SCR_VOICEFX: if (fxLen) { fxEffect = (fxEffect + 1) % FX_COUNT; playFx(); } else toast("Hold A and talk"); break;
    case SCR_CAMERA: cameraShutter(); break;
    case SCR_LIGHT:  flashlight = !flashlight; if (flashlight) M5.Display.setBrightness(255); else wake(); break;
    default: break;
  }
}
void onButtonA_double() {
  if (screen == SCR_TV && tvMask) { nextTvButton(); return; }
  if (primaryUp) { notifyEvent(1); toast("Ringing your phone"); }
  else toast("Phone not connected");
}
void onButtonA_hold() {
  if (screen == SCR_NOTE) { startNote(); return; }
  if (screen == SCR_VOICEFX) { startFx(); return; }
  if (screen == SCR_TV && tvMask) { tvPress(tvSel); return; }   // keeps sending while held (see loop)
  if (screen == SCR_TIMER && timerEndMs) { timerEndMs = 0; timerDone = false; toast("Timer cleared"); return; }
  stopAlert();
  if (dndActive()) { dndUntilMs = 0; toast("Alerts on"); return; }
  dndUntilMs = millis() + (uint32_t)settings.holdDnd * 60000UL;
  chirp(784, 523);
  toast("Paused until " + untilText(dndUntilMs));
}

// A press while the screen is dark only wakes it (and stops an alert), so you
// can't change something by accident in your pocket.
bool swallowA = false, swallowB = false;
void updateButtons() {
  if (M5.BtnA.wasPressed() || M5.BtnB.wasPressed()) {
    if (!screenOn) {
      if (M5.BtnA.wasPressed()) swallowA = true; else swallowB = true;
      wake();
      if (alerting) { stopAlert(); toast("Alert stopped"); }
    }
    lastActivity = millis();
  }
  if (M5.BtnA.wasHold()) { swallowA = false; onButtonA_hold(); }   // holding is deliberate, so it works even from a dark screen
  if (M5.BtnA.wasReleased() && recordingNote) stopNote();
  if (M5.BtnA.wasReleased() && fxRecording) stopFx();
  if (M5.BtnA.wasDecideClickCount()) {
    if (swallowA) swallowA = false;
    else if (M5.BtnA.getClickCount() == 1) onButtonA_single();
    else if (M5.BtnA.getClickCount() == 2) onButtonA_double();
  }
  if (M5.BtnB.wasHold() && swallowB) swallowB = false;
  if (M5.BtnB.wasDecideClickCount() && swallowB) { swallowB = false; return; }
  if (M5.BtnB.wasSingleClicked()) {
    flashlight = false;
    screen = (Screen)((screen + 1) % SCR_COUNT);
    if (screen == SCR_CHECK && !(extras.flags & X_CHECKLIST)) screen = SCR_TIMER;
    if (screen == SCR_TV && !tvMask && learnSlot < 0) screen = SCR_CHECK;
    if (screen == SCR_CHECK && !(extras.flags & X_CHECKLIST)) screen = SCR_TIMER;
    if (screen == SCR_CAMERA && !(extras.flags & X_CAMERA)) screen = SCR_LIGHT;
    if (learnSlot >= 0 && screen != SCR_TV) { endLearn(); notifyEvent(4); }
    wake();
  }
  if (M5.BtnB.wasHold()) { screen = SCR_HOME; sleepScreen(); }
}

// ===========================================================================
// Bluetooth: callbacks only copy data; loop() does the work
// ===========================================================================
class SettingsCB : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* c, NimBLEConnInfo&) override {
    NimBLEAttValue v = c->getValue();
    if (c == settingsChr && v.size() >= sizeof(Settings) && v.data()[0] == 1) {
      memcpy(&settings, v.data(), sizeof(Settings));
      settings.volume = constrain(settings.volume, 1, 5);
      settings.threshold = constrain(settings.threshold, -100, -30);
      saveSettingsPending = true;
    } else if (c == quietChr && v.size() >= sizeof(QuietTimes)) {
      memcpy(&quiet, v.data(), sizeof(QuietTimes)); saveQuietPending = true;
    } else if (c == extrasChr && v.size() >= sizeof(Extras) && v.data()[0] == 1) {
      memcpy(&extras, v.data(), sizeof(Extras));
      extras.brightness = constrain(extras.brightness, 1, 5);
      extras.screenSecs = constrain(extras.screenSecs, 3, 120);
      if (!extras.timerStep) extras.timerStep = 15;
      saveExtrasPending = true;
    } else if (c == textChr && v.size() >= 1) {
      String s((const char*)v.data() + 1, v.size() - 1);
      switch (v.data()[0]) {
        case 1: tagName = s.substring(0, 24); break;
        case 2: foundMsg = s.substring(0, 80); break;
        case 3: case 4: case 5: case 6: checkItems[v.data()[0] - 3] = s.substring(0, 18); break;
      }
      saveTextPending = true;
    } else if (c == commandChr && v.size() && v.size() <= sizeof(pendingCmd) && !pendingCmdLen) {
      memcpy(pendingCmd, v.data(), v.size()); pendingCmdLen = v.size();
    } else if (c == irChr && v.size() && v.size() <= sizeof(irPend) && !irPendLen) {
      memcpy(irPend, v.data(), v.size()); irPendLen = v.size();
    } else if (c == audioChr && v.size()) {
      const uint8_t* d = v.data();
      if (d[0] == 1 && v.size() >= 5) { clipExpected = min<uint32_t>(d[1] | (d[2] << 8), CLIP_MAX); clipRate = d[3] | (d[4] << 8); clipRecv = 0; }
      else if (d[0] == 2 && clipBuf) { uint32_t n = min<uint32_t>(v.size() - 1, CLIP_MAX - clipRecv); memcpy(clipBuf + clipRecv, d + 1, n); clipRecv += n; }
      else if (d[0] == 3 && clipRecv) clipSavePending = true;
    }
  }
} settingsCB;

class ServerCB : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* s, NimBLEConnInfo& info) override {
    Serial.println("Connected");
    if (s->getConnectedCount() < 3) NimBLEDevice::startAdvertising();   // let the app connect too
  }
  void onDisconnect(NimBLEServer* s, NimBLEConnInfo& info, int reason) override {
    Serial.printf("Disconnected (reason %d)\n", reason);
    if (info.getConnHandle() == primaryHandle) { primaryUp = false; primaryHandle = 0xFFFF; haveRssi = false; ancsReady = false; ancsControl = nullptr; primaryClient = nullptr; }
    NimBLEDevice::startAdvertising();
  }
} serverCB;

void publishSettings() {
  settingsChr->setValue((uint8_t*)&settings, sizeof(settings));
  quietChr->setValue((uint8_t*)&quiet, sizeof(quiet));
  extrasChr->setValue((uint8_t*)&extras, sizeof(extras));
}
void publishStats() {
  int s = streakDays();
  uint8_t b[10] = { (uint8_t)(s < 0 ? 0xFF : s & 0xFF), (uint8_t)(s < 0 ? 0xFF : (s >> 8) & 0xFF),
                    (uint8_t)(stats.saves & 0xFF), (uint8_t)(stats.saves >> 8), (uint8_t)(stats.best & 0xFF), (uint8_t)(stats.best >> 8),
                    (uint8_t)(battery < 0 ? 0xFF : battery), (uint8_t)(charging ? 1 : 0), (uint8_t)(noteLen ? 1 : 0), (uint8_t)(ancsReady ? 1 : 0) };
  statsChr->setValue(b, sizeof(b));
}

void handleCommand(const uint8_t* c, uint8_t len) {
  switch (c[0]) {
    case 0x01: ringOnce = true; alerting = true; alertPlays = 0; alertStartMs = millis(); nextAlertMs = millis(); wake(); break;  // ring
    case 0x02: stopAlert(); break;
    case 0x03: {
      uint16_t mins = len >= 3 ? (c[1] | (c[2] << 8)) : 0;
      if (!mins) dndUntilMs = 0; else { stopAlert(); dndUntilMs = millis() + (uint32_t)mins * 60000UL; chirp(784, 523); }
      break;
    }
    case 0x04: flashUntil = millis() + 3000; wake(); break;                                     // flash
    case 0x05: calibrating = true; calibrateUntil = millis() + 5UL * 60000UL; wake(); chirp(1568, 2093); break;
    case 0x06: if (len >= 6) { weekBaseSec = c[1] * 86400UL + (c[2] | (c[3] << 8) | ((uint32_t)c[4] << 16) | ((uint32_t)c[5] << 24)); weekBaseMs = millis(); haveWeekClock = true; } break;
    case 0x07: playTone(len >= 2 ? c[1] : settings.tone, len >= 3 ? c[2] : settings.volume); break;
    case 0x08: settings = DEFAULT_SETTINGS; extras = DEFAULT_EXTRAS; saveSettingsPending = true; saveExtrasPending = true; chirp(1568, 2093); break;
    case 0x09:                                                                                   // full clock
      if (len >= 7) {
        uint32_t epoch = c[1] | (c[2] << 8) | ((uint32_t)c[3] << 16) | ((uint32_t)c[4] << 24);
        tzMinutes = (int16_t)(c[5] | (c[6] << 8));
        struct timeval tv = { (time_t)epoch, 0 }; settimeofday(&tv, nullptr);
        haveClock = true;
      }
      break;
    case 0x0A: toast(len >= 2 && c[1] ? "Hello!" : "Hi from the app"); screen = SCR_HOME; makeFace(GRIN, 2500); break;   // test the screen
    case 0x0B: vibeTestUntil = millis() + 3000; buzz({ 400, 200, 400 }); toast("Bzzz!", 1500); break;    // test vibration
    case 0x0C: screen = SCR_HOME; wake();                                                              // pull a funny face
               makeFace(len >= 2 && c[1] < sizeof(SILLY_FACES) ? SILLY_FACES[c[1]] : randomSilly(), 3000); sillySound(); break;
  }
}

// ===========================================================================
// Connection watching
// ===========================================================================
void updateConnection() {
  static uint32_t last = 0;
  if (millis() - last < 200) return;
  last = millis();
  if (!primaryUp) {
    for (uint16_t h : server->getPeerDevices()) {
      NimBLEConnInfo info = server->getPeerInfoByHandle(h);
      if (info.isBonded()) {
        primaryHandle = h; primaryUp = true; seenPrimary = true; primarySince = millis();
        primaryClient = server->getClient(info);
        haveRssi = false; weakSinceMs = 0; ancsTried = false;
        Serial.println("Phone connected (paired)");
        break;
      }
    }
  }
  if (primaryUp) {
    int r = primaryClient ? primaryClient->getRssi() : 0;
    if (r < 0 && r > -127) { rssiAvg = haveRssi ? rssiAvg * 0.85f + r * 0.15f : r; haveRssi = true; }
  }
}

bool separated() {
  if (!seenPrimary) return false;
  if (!primaryUp) return true;
  if (!haveRssi) return false;
  if (rssiAvg < settings.threshold) { if (!weakSinceMs) weakSinceMs = millis(); return millis() - weakSinceMs > 3000; }
  weakSinceMs = 0;
  return false;
}

void updateAlerts() {
  bool apart = separated();
  if (!apart) {
    if (episodeStart) {           // came back
      uint32_t dur = millis() - episodeStart;
      if (!episodeForgot && dur < 10UL * 60000UL) { stats.saves++; saveStats(); happyUntil = millis() + 6000; }
      episodeStart = 0; episodeForgot = false;
    }
    if (alertFired) {
      if (alerting && !ringOnce) stopAlert();
      alertFired = false;
      if (!dndActive() && !inQuietTime()) { chirp(1047, 1568); wake(); }
    }
    return;
  }
  if (!episodeStart) episodeStart = millis();
  if (!episodeForgot && millis() - episodeStart > 10UL * 60000UL) {   // gone a long time: the streak resets
    episodeForgot = true;
    if (today() >= 0) { stats.lastForgotDay = today(); saveStats(); }
  }
  if (alertFired || dndActive()) return;
  if ((settings.flags & 0x01) && !isMoving()) return;
  startAlert();
}

// ===========================================================================
// iPhone caller ID and messages (Apple Notification Center Service)
// ===========================================================================
void onAncsNotif(NimBLERemoteCharacteristic*, uint8_t* d, size_t len, bool) {
  AncsMsg m; m.kind = 0; m.len = min<size_t>(len, sizeof(m.data)); memcpy(m.data, d, m.len);
  if (ancsQueue) xQueueSend(ancsQueue, &m, 0);
}
void onAncsData(NimBLERemoteCharacteristic*, uint8_t* d, size_t len, bool) {
  AncsMsg m; m.kind = 1; m.len = min<size_t>(len, sizeof(m.data)); memcpy(m.data, d, m.len);
  if (ancsQueue) xQueueSend(ancsQueue, &m, 0);
}

void setupAncs() {
  if (ancsTried || !primaryUp || !(extras.flags & X_CALLER_ID) || millis() - primarySince < 3000) return;
  ancsTried = true;
  if (!primaryClient) return;
  NimBLERemoteService* svc = primaryClient->getService(ANCS_SERVICE);
  if (!svc) { Serial.println("No iPhone notifications on this phone (Android?)"); return; }
  NimBLERemoteCharacteristic* ns = svc->getCharacteristic(ANCS_NOTIF);
  NimBLERemoteCharacteristic* ds = svc->getCharacteristic(ANCS_DATA);
  ancsControl = svc->getCharacteristic(ANCS_CONTROL);
  if (!ns || !ds || !ancsControl) return;
  bool ok = ds->subscribe(true, onAncsData) && ns->subscribe(true, onAncsNotif);
  ancsReady = ok;
  Serial.printf("iPhone notifications %s\n", ok ? "on" : "failed");
}

void showNotification() {
  if (dndActive() || inQuietTime()) return;
  notifyUntil = millis() + (notifyCat == 1 ? 25000 : 8000);
  if (notifyCat == 1) buzz({ 600, 300, 600, 300, 600, 300, 600 }); else buzz({ 150, 120, 150 });
  wake(notifyCat == 1 ? 25000 : 8000);
  if (!alerting) { useSpeaker(); M5.Speaker.setVolume(volumeFor(3)); static std::vector<Note> n; n = { {1175, 90}, {0, 60}, {1568, 140} }; playing = &n; playIdx = 0; noteEnd = 0; }
}

void serviceAncs() {
  setupAncs();
  AncsMsg m;
  while (ancsQueue && xQueueReceive(ancsQueue, &m, 0) == pdTRUE) {
    if (m.kind == 0 && m.len >= 8) {
      uint8_t eventId = m.data[0], flags = m.data[1], cat = m.data[2];
      uint32_t uid = m.data[4] | (m.data[5] << 8) | ((uint32_t)m.data[6] << 16) | ((uint32_t)m.data[7] << 24);
      if (eventId == 2 && uid == callUid) { callUid = 0xFFFFFFFF; if (notifyCat == 1) notifyUntil = 0; continue; }
      if (eventId != 0 || (flags & 0x04) || cat < 1 || cat > 4 || !ancsControl) continue;   // new calls and messages only
      notifyUid = uid; notifyCat = cat; if (cat == 1) callUid = uid;
      ancsData.clear();
      uint8_t req[] = { 0x00, m.data[4], m.data[5], m.data[6], m.data[7], 0x01, 32, 0, 0x03, 80, 0 };   // title (32) + message (80)
      ancsControl->writeValue(req, sizeof(req), true);
    } else if (m.kind == 1) {
      ancsData.insert(ancsData.end(), m.data, m.data + m.len);
      if (ancsData.size() > 600) { ancsData.clear(); continue; }
      // [cmd][uid x4] then attributes: [id][len lo][len hi][bytes]
      size_t p = 5; String title, body; int found = 0;
      while (ancsData.size() >= p + 3) {
        uint8_t id = ancsData[p]; uint16_t l = ancsData[p + 1] | (ancsData[p + 2] << 8);
        if (ancsData.size() < p + 3 + l) break;
        String v((const char*)&ancsData[p + 3], l);
        if (id == 1) title = v; else if (id == 3) body = v;
        p += 3 + l; found++;
      }
      if (found >= 2) { notifyTitle = title; notifyBody = body; ancsData.clear(); showNotification(); }
    }
  }
}

// ===========================================================================
// Status for the app, once a second
// ===========================================================================
void sendStatus() {
  static uint32_t last = 0;
  if (millis() - last < 1000) return;
  last = millis();
  uint16_t dndLeft = dndActive() ? (dndUntilMs - millis()) / 60000UL + 1 : 0;
  uint8_t flags = (primaryUp ? 0x01 : 0) | (isMoving() ? 0x02 : 0) | (dndActive() ? 0x04 : 0) | (alerting ? 0x08 : 0) |
                  (inQuietTime() ? 0x10 : 0) | (calibrating ? 0x20 : 0) | (clipLen ? 0x40 : 0) | ((haveClock || haveWeekClock) ? 0x80 : 0);
  uint8_t s[8] = { (uint8_t)(int8_t)(haveRssi ? (int)rssiAvg : 0), flags, (uint8_t)(dndLeft & 0xFF), (uint8_t)(dndLeft >> 8),
                   (uint8_t)settings.threshold, lastEvent, eventCounter, FW_VERSION };
  statusChr->setValue(s, sizeof(s));
  statusChr->notify();
  static uint32_t lastStats = 0;
  if (millis() - lastStats > 5000) { lastStats = millis(); publishStats(); }
}

// ===========================================================================
// Setup
// ===========================================================================
const uint8_t hidReportMap[] = {
  0x05, 0x0C, 0x09, 0x01, 0xA1, 0x01, 0x85, 0x01, 0x15, 0x00, 0x26, 0xFF, 0x03,
  0x19, 0x00, 0x2A, 0xFF, 0x03, 0x75, 0x10, 0x95, 0x01, 0x81, 0x00, 0xC0
};

void setupBle() {
  uint8_t mac[6]; esp_read_mac(mac, ESP_MAC_BT);
  char name[16]; snprintf(name, sizeof(name), "Tether-%02X%02X", mac[4], mac[5]);
  NimBLEDevice::init(name);
  NimBLEDevice::setPower(9);
  NimBLEDevice::setSecurityAuth(true, false, true);            // remember the phone (bonding)
  NimBLEDevice::setSecurityIOCap(BLE_HS_IO_NO_INPUT_OUTPUT);
  NimBLEDevice::setMTU(247);
  server = NimBLEDevice::createServer();
  server->setCallbacks(&serverCB);
  server->advertiseOnDisconnect(true);

  // A tiny "remote control" so phones treat the tag as an accessory and keep it connected
  hid = new NimBLEHIDDevice(server);
  hid->setManufacturer("Tether");
  hid->setPnp(0x02, 0x303A, 0x7E57, 0x0100);
  hid->setHidInfo(0x00, 0x01);
  hid->setReportMap((uint8_t*)hidReportMap, sizeof(hidReportMap));
  hidInput = hid->getInputReport(1);
  hid->setBatteryLevel(100);

  NimBLEService* svc = server->createService(UUID_SERVICE);
  settingsChr = svc->createCharacteristic(UUID_SETTINGS, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE);
  quietChr    = svc->createCharacteristic(UUID_QUIET,    NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE);
  commandChr  = svc->createCharacteristic(UUID_COMMAND,  NIMBLE_PROPERTY::WRITE);
  statusChr   = svc->createCharacteristic(UUID_STATUS,   NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  audioChr    = svc->createCharacteristic(UUID_AUDIO,    NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  infoChr     = svc->createCharacteristic(UUID_INFO,     NIMBLE_PROPERTY::READ);
  extrasChr   = svc->createCharacteristic(UUID_EXTRAS,   NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE);
  textChr     = svc->createCharacteristic(UUID_TEXT,     NIMBLE_PROPERTY::WRITE);
  statsChr    = svc->createCharacteristic(UUID_STATS,    NIMBLE_PROPERTY::READ);
  irChr       = svc->createCharacteristic(UUID_IR,       NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE, 520);
  for (auto* c : { settingsChr, quietChr, commandChr, audioChr, extrasChr, textChr, irChr }) c->setCallbacks(&settingsCB);
  { uint8_t m = tvMask; irChr->setValue(&m, 1); }
  uint8_t info[4] = { MODEL_STICKS3, FW_VERSION, 0xFF /* screen, speaker, mic, camera, caller ID, stats, TV remote, voice changer */, 0 };
  infoChr->setValue(info, sizeof(info));
  publishSettings();
  publishStats();
  uint8_t s0[8] = { 0 }; statusChr->setValue(s0, 8);

  server->start();

  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  NimBLEAdvertisementData ad, sr;
  ad.setFlags(BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP);
  ad.setAppearance(0x0180);                       // generic remote control
  ad.addServiceUUID(NimBLEUUID((uint16_t)0x1812));
  ad.addServiceUUID(NimBLEUUID(UUID_SERVICE));
  sr.setName(name);
  adv->setAdvertisementData(ad);
  adv->setScanResponseData(sr);
  adv->setMinInterval(160); adv->setMaxInterval(400);
  NimBLEDevice::startAdvertising();
  Serial.printf("Name: %s\n", name);
}

void setup() {
  auto cfg = M5.config();
  cfg.serial_baudrate = 115200;
  M5.begin(cfg);
  setCpuFrequencyMhz(80);                         // saves battery; plenty for this job
  M5.Display.setRotation(1);
  canvas.setColorDepth(16);
  canvas.setPsram(true);
  canvas.createSprite(240, 135);
  M5.BtnA.setHoldThresh(700);
  M5.BtnB.setHoldThresh(700);

  buildPatterns();
  loadAll();
  LittleFS.begin(true);
  clipBuf = (uint8_t*)ps_malloc(CLIP_MAX);
  noteBuf = (uint8_t*)ps_malloc(VOICE_MAX);
  tvCodes = (TvCode*)ps_calloc(TV_SLOTS, sizeof(TvCode));
  fxIn  = (int16_t*)ps_malloc(FX_MAX * 2);
  fxOut = (int16_t*)ps_malloc(FX_OUT * 2);
  loadTv();
  if (File f = LittleFS.open("/clip.raw", "r")) { clipRate = f.read() | (f.read() << 8); clipLen = f.read(clipBuf, CLIP_MAX); f.close(); }
  if (File f = LittleFS.open("/note.raw", "r")) { noteLen = f.read(noteBuf, VOICE_MAX); f.close(); }
  ancsQueue = xQueueCreate(8, sizeof(AncsMsg));

  useSpeaker();
  setupBle();
  battery = M5.Power.getBatteryLevel();
  wake();
  toast("Hi! I'm " + tagName, 2500);
  chirp(1047, 1568);
  Serial.println("Tether StickS3 ready. Pair it in your phone's Bluetooth settings.");
}

void loop() {
  M5.update();
  if (pendingCmdLen) { uint8_t c[8]; uint8_t n = pendingCmdLen; memcpy(c, pendingCmd, n); pendingCmdLen = 0; handleCommand(c, n); }
  if (saveSettingsPending) { saveSettingsPending = false; prefs.putBytes("set", &settings, sizeof(settings)); publishSettings(); }
  if (saveQuietPending)    { saveQuietPending = false; prefs.putBytes("quiet", &quiet, sizeof(quiet)); publishSettings(); }
  if (saveExtrasPending)   { saveExtrasPending = false; prefs.putBytes("extras", &extras, sizeof(extras)); publishSettings(); if (screenOn) wake(); }
  if (saveTextPending)     { saveTextPending = false; saveTexts(); }
  if (clipSavePending) {
    clipSavePending = false; clipLen = clipRecv;
    File f = LittleFS.open("/clip.raw", "w");
    if (f) { f.write(clipRate & 0xFF); f.write(clipRate >> 8); f.write(clipBuf, clipLen); f.close(); }
    toast("New sound saved"); chirp(1568, 2093);
  }
  if (calibrating && (int32_t)(millis() - calibrateUntil) > 0) calibrating = false;
  if (timerEndMs && (int32_t)(millis() - timerEndMs) >= 0) {
    timerEndMs = 0; timerDone = true; screen = SCR_TIMER; wake(10000);
    playTone(TONE_MELODY, 5);
  }

  updateMotion();
  updateButtons();
  serviceNote();
  checkNoteFull();
  updateConnection();
  updateAlerts();
  serviceAlert();
  serviceSound();
  serviceVibe();
  serviceFx(); checkFxFull();
  serviceLearn();
  if (irPendLen) { static uint8_t d[520]; uint16_t n = irPendLen; memcpy(d, irPend, n); irPendLen = 0; handleIr(d, n); }
  // holding A on the TV screen keeps sending (good for volume)
  static uint32_t tvRepeat = 0;
  if (screen == SCR_TV && tvMask && M5.BtnA.isHolding() && millis() - tvRepeat > 220) { tvRepeat = millis(); if (tvSel == 1 || tvSel == 2 || tvSel == 4 || tvSel == 5) tvPress(tvSel); }   // volume and channel only
  // turn the 5V port off again when nothing needs it (saves battery)
  if (irLastUse && millis() - irLastUse > 20000 && learnSlot < 0 && !vibeOn()) { irLastUse = 0; M5.Power.setExtOutput(false); }
  serviceAncs();
  // Every so often, pull a funny face on the home screen
  if (screenOn && screen == SCR_HOME && sillyOn() && primaryUp && !alerting && !dndActive() && (int32_t)(millis() - nextSilly) > 0) {
    if (nextSilly) makeFace(randomSilly(), 1800);
    nextSilly = millis() + random(12000, 30000);
  }
  sendStatus();

  static uint32_t lastBatt = 0;
  if (millis() - lastBatt > 30000) { lastBatt = millis(); battery = M5.Power.getBatteryLevel(); charging = M5.Power.isCharging() == m5::Power_Class::is_charging; if (battery >= 0) hid->setBatteryLevel(battery, true); }

  // Screen: keep it on while something needs it, otherwise turn it off after a while
  bool busy = alerting || calibrating || recordingNote || fxRecording || learnSlot >= 0 || (flashlight && screen == SCR_LIGHT) || (int32_t)(flashUntil - millis()) > 0 ||
              (notifyUntil && (int32_t)(notifyUntil - millis()) > 0) || (screen == SCR_FIND && millis() - lastActivity < 120000);
  if (busy) lastActivity = max(lastActivity, millis());
  if (screenOn && !busy && (int32_t)(millis() - lastActivity) > (int32_t)extras.screenSecs * 1000) { screen = SCR_HOME; sleepScreen(); }
  if (screenOn) {
    static uint32_t lastDraw = 0;
    if (millis() - lastDraw > 66) { lastDraw = millis(); drawScreen(); }
  }

  static uint32_t lastLog = 0;
  if (millis() - lastLog > 2000) {
    lastLog = millis();
    Serial.printf("phone:%s signal:%d (alert below %d) moving:%s alerting:%s paused:%s quiet:%s battery:%d%%\n",
                  primaryUp ? "yes" : "no", haveRssi ? (int)rssiAvg : 0, settings.threshold, isMoving() ? "yes" : "no",
                  alerting ? "yes" : "no", dndActive() ? "yes" : "no", inQuietTime() ? "yes" : "no", battery);
  }
  delay(screenOn ? 5 : 20);
}
