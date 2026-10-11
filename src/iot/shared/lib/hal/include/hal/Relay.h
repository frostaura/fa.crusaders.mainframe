// Crusaders Mainframe — the court-light relay port.
//
// WHY THIS EXISTS
// ---------------
// Four SONGLE SRD-05VDC-SL-C channels on Mega pins 2, 3, 4, 5, courts A-D. The
// board is ACTIVE LOW: driving the input LOW energises the coil, closes the
// contact and turns a court's lights on. The wiring is fixed and cannot change.
//
// Getting that inversion backwards is not a cosmetic bug. It means the lights
// are on whenever the system believes they are off — no booking, no ledger
// debit, nobody in the building, and nothing in the software that would ever
// notice. The inversion is therefore expressed once, here, by relayLevelFor(),
// and nowhere else in the codebase.
//
// This port is deliberately dumb: set a channel, read back what was last
// commanded. The duration, the hard cap and the auto-off timer are NOT here.
// They live in pure logic above the port so `pio test -e native` can prove them
// with no board attached — which is the entire reason the relay is behind an
// interface at all.
//
// No Arduino headers. Compiles for AVR, Xtensa and the host test runner.

#ifndef CRUSADERS_HAL_RELAY_H
#define CRUSADERS_HAL_RELAY_H

#include <stdint.h>

#include "hal/PinLevel.h"

namespace hal {

/// Courts A, B, C, D — channel index 0..3. Fixed by the wiring.
constexpr uint8_t kRelayChannelCount = 4U;

/// LOW energises the coil and closes the contact: LOW == lights on.
constexpr PinLevel kRelayAssertedLevel = PinLevel::kLow;
constexpr PinLevel kRelayReleasedLevel = PinLevel::kHigh;

/// Which level closes the contact. A FACT ABOUT THE FITTED RELAY MODULE, not a
/// preference: the SONGLE coil board above is ACTIVE LOW, and the
/// normally-open solid-state relays the club fitted for Mega 2.1.0 close on a
/// HIGH input (`RELAY_ACTIVE_LOW=0`). A build names its polarity; nothing
/// guesses it.
enum class RelayPolarity : uint8_t { kActiveLow = 0U, kActiveHigh = 1U };

/// The build flag `RELAY_ACTIVE_LOW` read as a polarity: non-zero is the coil
/// board, zero the solid-state relays.
constexpr RelayPolarity relayPolarityFor(bool activeLowFlag) {
  return activeLowFlag ? RelayPolarity::kActiveLow : RelayPolarity::kActiveHigh;
}

/// The one and only place the logical-to-electrical mapping is written down,
/// for either polarity. A driver that computes the level any other way is a
/// defect, and a test that asserts this mapping is asserting the safety
/// property, not a coding style. One return statement: the Arduino cores
/// compile this at gnu++11.
constexpr PinLevel relayLevelFor(bool on, RelayPolarity polarity) {
  return (on == (polarity == RelayPolarity::kActiveHigh)) ? PinLevel::kHigh : PinLevel::kLow;
}

/// The ACTIVE-LOW mapping, kept as the default the host fakes model unless a
/// test names the other polarity.
constexpr PinLevel relayLevelFor(bool on) {
  return relayLevelFor(on, RelayPolarity::kActiveLow);
}

static_assert(relayLevelFor(true) == kRelayAssertedLevel && relayLevelFor(false) == kRelayReleasedLevel,
              "the active-LOW default must stay the coil board's mapping");

/// Drives the four court-light relays.
///
/// Vtable is deliberately three slots plus the destructor. There is no
/// channelCount() accessor because kRelayChannelCount is a compile-time
/// constant fixed by the wiring; a virtual would cost flash and RAM on an 8-bit
/// part to return a number that cannot vary.
class IRelayPort {
public:
  virtual ~IRelayPort() = default;

  /// Command channel `channel` on or off. `on` is LOGICAL: true means the
  /// court's lights are lit. The implementation applies relayLevelFor().
  ///
  /// A channel index at or beyond kRelayChannelCount is ignored, never
  /// clamped. Clamping would drive a real, wrong court — an out-of-range index
  /// is a caller bug and the safe response is to touch nothing.
  virtual void set(uint8_t channel, bool on) = 0;

  /// What was last commanded for this channel — NOT a sensed contact state.
  /// This board has no readback; nothing measures whether the contact actually
  /// closed, whether the coil is stuck, or whether the lamp struck. Anything
  /// that needs real confirmation needs new hardware, not a new method here.
  ///
  /// Out-of-range channels report false: an unknown court is never "on".
  virtual bool isOn(uint8_t channel) const = 0;

  /// Release every channel. Called on reset, on loss of the bridge, and on the
  /// hard-cap expiry. Separate from set() in a loop because it must remain the
  /// single cheapest, most obviously correct way to make the building dark.
  virtual void allOff() = 0;
};

} // namespace hal

#endif // CRUSADERS_HAL_RELAY_H
