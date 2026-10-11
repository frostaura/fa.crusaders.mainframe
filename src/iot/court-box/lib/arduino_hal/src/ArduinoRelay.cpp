// The court-light relay driver. See include/arduino_hal/ArduinoRelay.h.

#include "arduino_hal/ArduinoRelay.h"

#include <Arduino.h>

#include "arduino_hal/Pins.h"

namespace arduino_hal {

namespace {

// THE COURT RELAY POLARITY, from the build (Mega 2.1.0). The club replaced the
// SONGLE coil board with NORMALLY-OPEN SOLID-STATE relays, which close when
// their input is driven HIGH; the 2.0.0 image drove LOW for "on" and so turned
// the lights OFF whenever it meant ON. platformio.ini now builds court_mega
// with RELAY_ACTIVE_LOW=0. A build that does not say is refused: guessing the
// polarity of a building's lighting circuit is not a default.
//
// hal::relayLevelFor() (shared, active-LOW) is still what the host fakes and
// the simulator model; this is the one place THIS board's level is decided,
// and ArduinoRelay is its only caller.
//
// Here and not in Pins.h because the bridge compiles this library too (for its
// clock, serial and store) and has no relays: only the Mega must name it.
#ifndef RELAY_ACTIVE_LOW
#ifdef TARGET_COURT_MEGA
#error "RELAY_ACTIVE_LOW is not defined — set it in platformio.ini (0 = active HIGH, 1 = active LOW)"
#endif
#define RELAY_ACTIVE_LOW 0
#endif
constexpr hal::PinLevel kCourtRelayOnLevel = RELAY_ACTIVE_LOW ? hal::PinLevel::kLow : hal::PinLevel::kHigh;
constexpr hal::PinLevel kCourtRelayOffLevel = RELAY_ACTIVE_LOW ? hal::PinLevel::kHigh : hal::PinLevel::kLow;

constexpr hal::PinLevel courtRelayLevelFor(bool on) {
  return on ? kCourtRelayOnLevel : kCourtRelayOffLevel;
}

/// The single translation from "the lights are on" to a level on a pin. It goes
/// through courtRelayLevelFor() (above, from the RELAY_ACTIVE_LOW build flag)
/// and nowhere else: an inverted digitalWrite written out by hand here would put
/// the building's lights on whenever the system believed they were off, and
/// nothing in software would ever notice.
void drive(uint8_t pin, bool on) {
  digitalWrite(pin, hal::toDigital(courtRelayLevelFor(on)));
}

} // namespace

ArduinoRelay::ArduinoRelay() : state_() {
  for (uint8_t i = 0U; i < hal::kRelayChannelCount; ++i) {
    state_[i] = false;
  }
}

void ArduinoRelay::begin() {
  for (uint8_t i = 0U; i < hal::kRelayChannelCount; ++i) {
    // Level first, direction second. See the header: the other order closes
    // all four contacts for the width of one instruction at every reset.
    drive(kRelayPins[i], false);
    pinMode(kRelayPins[i], OUTPUT);
    drive(kRelayPins[i], false);
    state_[i] = false;
  }
  pinMode(kStatusLedPin, OUTPUT);
  digitalWrite(kStatusLedPin, LOW);
}

void ArduinoRelay::set(uint8_t channel, bool on) {
  if (channel >= hal::kRelayChannelCount) {
    // Ignored, never clamped: an out-of-range index is a caller bug, and
    // clamping it would drive a real, wrong court.
    return;
  }
  state_[channel] = on;
  drive(kRelayPins[channel], on);

  bool any = false;
  for (uint8_t i = 0U; i < hal::kRelayChannelCount; ++i) {
    any = any || state_[i];
  }
  digitalWrite(kStatusLedPin, any ? HIGH : LOW);
}

bool ArduinoRelay::isOn(uint8_t channel) const {
  return channel < hal::kRelayChannelCount && state_[channel];
}

void ArduinoRelay::allOff() {
  for (uint8_t i = 0U; i < hal::kRelayChannelCount; ++i) {
    set(i, false);
  }
}

} // namespace arduino_hal
