// Crusaders Mainframe — hal::IRelayPort on the four SONGLE channels.
//
// WHY begin() DRIVES THE PIN BEFORE IT CONFIGURES IT
// --------------------------------------------------
// pinMode(pin, OUTPUT) latches whatever the PORT bit holds onto the pin. Writing
// the RELEASED level while the pin is still an input sets that bit first, so
// the pin becomes an output already at "off" and no court ever flickers on.
//
// The club now runs NORMALLY-OPEN SOLID-STATE relays, ACTIVE HIGH (Mega 2.1.0,
// RELAY_ACTIVE_LOW=0): released is LOW. An AVR resets with PORT=0 and DDR=0,
// so the bit is already LOW; writing LOW first keeps the pullup OFF (a pullup
// on an SSR input could half-drive it) and pinMode() then latches LOW = off.
// The order still matters for the other polarity: on an active-LOW board,
// pinMode() first would latch the power-on LOW and close all four contacts for
// as long as it took to write HIGH. Level first, direction second, either way.
//
// Between reset and begin() — the bootloader's ~1 s — the pins are high-Z
// inputs. An SSR input left floating is OFF in practice, but a pull-down
// resistor on each input is what makes that a guarantee rather than a hope;
// see the README's wiring table.
//
// This is not theoretical tidiness. A brownout that resets the Mega repeatedly
// would otherwise strobe four lighting circuits.
//
// WHY THE STATE IS MIRRORED IN RAM
// --------------------------------
// isOn() must answer without reading the pin back. digitalRead() on an output
// returns the latched value, which sounds equivalent but is not: it reports
// what the register holds, not whether the coil pulled in or the lamp struck.
// The port's contract says exactly that — "what was last commanded, NOT a
// sensed contact state" — and mirroring makes the honest answer the only one
// available.

#ifndef CRUSADERS_ARDUINO_HAL_ARDUINORELAY_H
#define CRUSADERS_ARDUINO_HAL_ARDUINORELAY_H

#include <stdint.h>

#include "hal/Relay.h"

namespace arduino_hal {

class ArduinoRelay final : public hal::IRelayPort {
public:
  ArduinoRelay();

  /// Configure the four pins with every contact open. Call once, from setup(),
  /// before anything else touches a relay.
  void begin();

  void set(uint8_t channel, bool on) override;

  bool isOn(uint8_t channel) const override;

  void allOff() override;

private:
  bool state_[hal::kRelayChannelCount];
};

} // namespace arduino_hal

#endif // CRUSADERS_ARDUINO_HAL_ARDUINORELAY_H
