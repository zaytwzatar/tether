# Tether on the M5StickS3: setup guide

Everything is built into the StickS3 (screen, speaker, buttons, motion sensor,
battery). You only need to load the Tether code onto it once.

You need: the M5StickS3, a **USB-C data cable**, and a computer.

---

## 1. Load the code (one time, about 20 minutes)

1. Open **Arduino IDE** (you already have it from the Circuit Playground).
2. **Tools › Board › Boards Manager**: search **esp32**, install
   **"esp32 by Espressif Systems"**.
3. **Tools › Manage Libraries**: install
   - **M5Unified** (if asked to install extra libraries such as M5GFX, click **Install all**)
   - **NimBLE-Arduino** (version 2.x)
4. Download the code: **github.com/zaytwzatar/tether** › green **Code** button ›
   **Download ZIP**, then unzip it.
5. **File › Open** › `firmware/TetherS3/TetherS3.ino`
   (two tabs open: `TetherS3.ino` and `tether_s3.cpp`; that's expected).
6. In the **Tools** menu, set:

   | Setting | Choose |
   |---|---|
   | Board | **ESP32S3 Dev Module** |
   | USB CDC On Boot | **Enabled** |
   | Flash Size | **8MB (64Mb)** |
   | Partition Scheme | **8M with spiffs (3MB APP/1.5MB SPIFFS)** |
   | PSRAM | **OPI PSRAM** |

7. Plug in the StickS3, pick its port under **Tools › Port**, click **Upload** (→).
8. When it's done, the screen says **"Hi! I'm My keys"** with a chirp.

**If the upload fails:** press and hold the small **power button** until the
little green light flashes (upload mode), then click Upload again.

**To see what it's doing:** Tools › Serial Monitor at **115200**.

---

## 2. Pair it with your phone

**Android:** Settings › Connected devices › Pair new device › **Tether-XXXX** › Pair.

**iPhone:** Settings › Bluetooth › **Tether-XXXX** › Pair.
For caller ID and texts on the tag: tap the **ⓘ** next to Tether-XXXX and turn on
**Share System Notifications** (if iPhone asks to allow notifications, tap Allow).

Then add it in the app: **My Tags › Add a tag › Find my tag**. The app sets the
tag's clock and name automatically.

---

## 3. Buttons

| Button | What it does |
|---|---|
| **Front, once** | Stop an alert. Otherwise, do what the screen says (see below). |
| **Front, twice** | Ring your phone (the app must be open on it) |
| **Front, hold** | Pause alerts (hold again to turn them back on) |
| **Side, once** | Next screen |
| **Side, hold** | Back home and turn the screen off |
| **Power (small)** | Press to turn on, double-press to turn off |

When the screen is dark, the first press just wakes it (and stops an alert).

## 4. The screens (press the side button to go through them)

| Screen | Front button |
|---|---|
| **Home**: face, phone status, battery, clock, streak | — |
| **Find my phone**: Cold → Warm → Hot! as you get closer | ring your phone |
| **Before you go**: your checklist ("Phone" ticks itself) | tick next item |
| **Parking timer** | add time (hold to clear) |
| **Voice note** | hold to record (up to 10 s), press to play |
| **Camera remote** | take a photo (open your camera app first) |
| **Flashlight** | on / off |
| **If found**: your message | — |
| **Your streak**: days without forgetting, saves, best | — |

Change colors, brightness, how long the screen stays on, the checklist, the
"if found" message, caller ID and the camera remote in the app:
**My Tags › your tag › Screen & extras**.

---

## Good to know

- **Battery:** it's a small rechargeable battery. Expect to charge it about daily
  (we'll measure the real number). The screen turns off by itself to save power.
- **Streaks** start counting once the app has set the tag's clock. A "save" is when
  the tag warned you and you went back for your phone within 10 minutes.
- **Caller ID and texts** work with iPhone only for now. Android needs the full
  native app.
- **Camera remote** works like a Bluetooth selfie button (it presses "volume up").
- **First version:** this code hasn't run on a real StickS3 yet. Expect a round of
  small fixes. Tell me what you see on the screen and in the Serial Monitor.
- **Attaching it to keys:** the StickS3 has no keyring hole and a magnetic back,
  so you'll need a strap, case or keyring adapter.
