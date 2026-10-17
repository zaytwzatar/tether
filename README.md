# Tether prototype: setup guide

This folder has two parts:

- **firmware/Tether**: the code for the tag (Circuit Playground Bluefruit).
- **app**: the phone/computer app. It runs in **Chrome or Edge** on **Android** and **computers** (Windows, Mac, Chromebook, Linux).

You can try the app's **demo tag** before the board arrives (steps C and D).

---

## A. Put the code on the tag (one time, about 20 minutes)

1. Install the **Arduino IDE** from https://www.arduino.cc/en/software
2. Open Arduino IDE > **Settings** (on Mac: Arduino IDE > Settings). In **Additional boards manager URLs**, paste:
   `https://adafruit.github.io/arduino-board-index/package_adafruit_index.json`
   and click OK.
3. Open **Tools > Board > Boards Manager**, search **Adafruit nRF52**, click **Install**.
4. Open **Tools > Manage Libraries** and install:
   - **Adafruit Circuit Playground**
   - **Adafruit SPIFlash** (if it asks to install extra libraries, click **Install all**)
5. Plug the board into the computer with the micro-USB cable.
6. **Tools > Board > Adafruit nRF52 > Adafruit Circuit Playground Bluefruit**
7. **Tools > Port**: pick the port that appears when the board is plugged in.
8. **File > Open** > `firmware/Tether/Tether.ino`. Two tabs open (`Tether.ino` and `tether_main.cpp`); that's expected.
9. Click **Upload** (the → arrow). When it finishes, the lights blink blue twice.

**If the upload fails:** double-click the small **reset** button in the middle of the board (this puts it in upload mode), pick the port again, and click Upload again.

**Linux only:** run `pip3 install --user adafruit-nrfutil` once before uploading.

**See what the tag is doing:** Tools > Serial Monitor, set to **115200 baud**. Every 2 seconds it prints a line like
`phone:yes signal:-58 dBm (alert below -76) moving:no alerting:no dnd:no quiet:no`.

---

## B. Pair the tag with your Android phone (one time)

This is what lets the tag warn you even when the app is closed, the same way the Prox PRD works.

1. Turn the tag on (battery pack switch on, or USB).
2. Phone: **Settings > Connected devices > Pair new device**.
3. Tap **Tether-XXXX**, then **Pair**. If Android asks to install an app for the device, close that message.

Now try it: leave the phone on a table, carry the tag away and keep walking. It should beep and flash, then chirp when you come back.

---

## C. Put the app online (one time, free, about 10 minutes)

Bluetooth in Chrome only works from a secure `https://` address, so the app needs a home online. GitHub Pages is free:

1. Make a free account at https://github.com
2. Click **+ > New repository**. Name it `tether`, choose **Public**, click **Create repository**.
3. Click **uploading an existing file**. Drag in **everything inside the `app` folder** (index.html, app.js, ble.js, sounds.js, styles.css, sw.js, manifest.webmanifest and the `icons` folder). Click **Commit changes**.
4. Go to the repository's **Settings > Pages**. Under **Branch**, pick **main** and **/ (root)**, click **Save**.
5. After a minute or two, your app is at `https://YOUR-USERNAME.github.io/tether/`

**On a computer only**, you can skip GitHub: open a terminal in the `app` folder, run `python3 -m http.server 8000`, then open `http://localhost:8000` in Chrome.

---

## D. Use the app

1. On the Android phone, open your app address in **Chrome**.
2. Tap **+ > Find my tag**, pick **Tether-XXXX**, give it a name, tap **Add tag**.
   (No board yet? Tap **Try a demo tag** instead.)
3. Install it: Chrome **⋮ menu > Add to Home screen**. On a computer: the **Install** icon in the address bar.
4. Allow notifications when asked, and location if you want last-seen spots.

Every setting is in the app: distance (feet, yards or meters, plus the walk test), sound, volume, repeats, your own recording, silent/light modes, do-not-disturb and quiet hours, Ring tag, Find, and last seen.

---

## Tag buttons (left or right button)

| Press | What happens |
|---|---|
| 1 press | Stop a sounding alert. If no alert: blue flash = phone nearby, orange = not nearby. During the walk test: saves this spot as the alert distance. |
| 2 presses | Rings your phone, if the app is open on it. |
| Press and hold (1 sec) | Do not disturb for the time set in the app (default 1 hour). Press once to cancel early. |

---

## Good to know (prototype limits)

- **Phone-side alerts and "ring my phone"** only work while the app is open in Chrome. Browsers can't run Bluetooth in the background. The tag's own left-behind alerts always work, because the phone keeps the paired connection itself. The installed app version (next stage) adds background phone alerts and the iPhone version.
- **Vibrate** isn't on this board, so vibrate modes flash the lights instead.
- **Distance is approximate.** Use the walk test (Alert distance > Start walk test) to match your home.
- **The computer never triggers alerts.** Only the paired phone counts, so you can change settings from a computer safely.
- **Anyone nearby with this app could change the tag's settings.** Fine for testing; a PIN lock should be added before real customers use it.
- **Recording** is stored on the board's flash chip (up to 5 seconds) and plays through the small speaker, so it will sound tinny.
- **Removing the battery** keeps your settings and recording.
