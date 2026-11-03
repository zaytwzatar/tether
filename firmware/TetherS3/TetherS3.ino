/*
  Tether tag firmware for the M5Stack StickS3  (version 0.1)

  Works with the same Tether app as the Circuit Playground version.

  WHAT IT DOES
  - Pair it in your phone's Bluetooth settings. It beeps and flashes its screen
    when you walk too far from your phone, and stops when you come back.
  - The screen shows a friendly face, your phone's status, battery and clock.
  - Extras: find-my-phone (hot/cold), "before you go" checklist, "if found"
    message, flashlight, parking timer, voice note, camera remote, streaks,
    and caller ID / texts from an iPhone.

  BUTTONS
    Front button (A):  1 press  = stop alert / do the thing on this screen
                       2 presses = ring your phone (app open)
                       hold      = pause alerts (hold again to turn back on)
    Side button (B):   1 press  = next screen
                       hold      = go back home and turn the screen off
    Power button:      the small one; press to turn on, double-press to turn off

  ARDUINO SETUP (one time)
    1. Boards Manager: install "esp32 by Espressif Systems".
    2. Library Manager: install "M5Unified" (also installs M5GFX) and
       "NimBLE-Arduino" (version 2.x).
    3. Tools menu:
         Board ............ ESP32S3 Dev Module
         USB CDC On Boot .. Enabled
         Flash Size ....... 8MB (64Mb)
         Partition Scheme . 8M with spiffs (3MB APP/1.5MB SPIFFS)
         PSRAM ............ OPI PSRAM
    4. Plug in with USB-C, pick the port, click Upload.
       If it won't upload: press and hold the power button until the small
       green light flashes (upload mode), then click Upload again.

  The code lives in the tether_s3.cpp tab.
*/
