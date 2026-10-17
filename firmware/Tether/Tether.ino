/*
  Tether tag firmware v0.1  (working name "Tether")
  Board: Adafruit Circuit Playground Bluefruit (nRF52840)

  What it does
  - Pair it with your phone in the phone's Bluetooth settings (like the Prox PRD).
    The tag shows up as a simple remote-control device, so the phone keeps the
    connection alive on its own, even with no app running.
  - The tag watches that connection. When the signal gets weaker than your
    chosen distance, or the connection drops, it alerts (sound and/or light).
    "Only alert while moving" uses the built-in motion sensor.
  - The Tether app (Chrome on Android or desktop) changes settings over
    Bluetooth: distance, sound, volume, repeats, alert style, quiet times,
    recorded alert sound, ring, do-not-disturb and the walk test.

  Buttons (left button "A" or right button "B" both work)
  - 1 press .......... stop a sounding alert / end do-not-disturb /
                       (during walk test) save this spot as the alert distance
  - 2 presses ........ ask the app to ring your phone (works while the app is open)
  - press and hold ... do not disturb for the time set in the app (default 1 hr)

  Libraries needed (Arduino IDE > Library Manager):
  - Adafruit Circuit Playground
  - Adafruit SPIFlash        (for storing your recorded sound)
  Board package: "Adafruit nRF52" > "Adafruit Circuit Playground Bluefruit"
*/

// The code is in the tether_main.cpp tab. Open this file in the Arduino IDE
// and click Upload.
