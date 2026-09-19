// Crusaders Mainframe — the door lock: which electrical level means LOCKED,
// and the order the pin is brought up in.
//
// THE TWO QUESTIONS, WHICH ARE NOT THE SAME QUESTION
// --------------------------------------------------
// 1. `relayActiveHigh` — a fact about the RELAY MODULE. Does driving its input
//    HIGH or LOW energise the coil? The cheap opto-isolated boards are usually
//    active LOW; Carl's is active HIGH.
// 2. `unlockEnergisesRelay` — a fact about the LOCK'S OWN WIRING. Is the lock
//    fed through the relay's normally-OPEN contact (so energising releases it)
//    or its normally-CLOSED contact (so energising locks it)?
//
// Either one alone reads, at a call site, like "the flag that says which way
// round this door works". They compose, and getting the composition wrong is a
// door that is unlocked whenever the software believes it is locked — with
// nothing in the software that would ever notice, because there is no readback.
// So the composition is written ONCE, here, in a constexpr function the host
// suite drives through all four combinations.
//
// WHAT FIRMWARE CANNOT DO
// -----------------------
// "The door is released when there is no power" is the owner's requirement and
// it is a property of the LOCK and its supply — a fail-safe lock, de-energised
// by a power cut — which no firmware can create. What this file guarantees is
// narrower and it is the part that is ours: the LOCKED level is asserted before
// the pin ever drives anything, so a boot, a brown-out recovery or a watchdog
// reset cannot pulse the door open on the way up. README.md's truth table says
// which wiring gives the owner what they asked for, and says plainly that fire
// egress must be mechanical and independent of this board.
//
// No Arduino headers, no heap. Compiles for Xtensa and the host test runner.

#ifndef CRUSADERS_GATELOGIC_LOCKDRIVER_H
#define CRUSADERS_GATELOGIC_LOCKDRIVER_H

#include "hal/PinLevel.h"

#include "gatelogic/PinOut.h"

namespace gatelogic {

/// The level the relay pin must carry for the lock to be in `released` state.
///
/// The one place the two polarity flags are composed. Four combinations, all
/// four pinned by the suite:
///
///   activeHigh  unlockEnergises  released -> level   locked -> level
///   ----------  ---------------  -----------------   ---------------
///   true        true             HIGH                LOW
///   true        false            LOW                 HIGH
///   false       true             LOW                 HIGH
///   false       false            HIGH                LOW
///
/// Read it as: energise == (released == unlockEnergises), then the module's
/// polarity turns "energise" into a level.
///
/// ONE return statement, and it has to stay one. The ESP32 Arduino core
/// hard-codes `-std=gnu++11` in its `platform.txt` for every variant and a
/// sketch cannot override it, so the generated `arduino/door_gate/` sketch —
/// which is the DEPLOYMENT route — compiles this header at C++11, where a
/// `constexpr` function body may be nothing but a return. The named `energise`
/// local this used to carry is a C++14 feature and failed the IDE build with
/// "body of 'constexpr' function not a return-statement". `arduino-cli compile`
/// in CI is what keeps it honest; `make build-iot` alone cannot, because
/// PlatformIO unflags the core's standard and gets C++17.
constexpr hal::PinLevel lockPinLevel(bool released, bool relayActiveHigh, bool unlockEnergisesRelay) {
  return ((released == unlockEnergisesRelay) == relayActiveHigh) ? hal::PinLevel::kHigh : hal::PinLevel::kLow;
}

/// Drives one lock relay, and knows nothing about when it should be open.
///
/// The release WINDOW is UnlockTimer's; this only ever answers "make it so".
/// Keeping them apart is what lets the timer be proven at the millis() wrap
/// with no pin in the picture, and the polarity be proven with no clock.
class LockDriver {
public:
  LockDriver(IPinOut& pin, bool relayActiveHigh, bool unlockEnergisesRelay)
      : pin_(pin), relayActiveHigh_(relayActiveHigh), unlockEnergisesRelay_(unlockEnergisesRelay) {}

  /// Boot. The LOCKED level goes into the output register BEFORE the pin
  /// becomes an output, so the first thing the relay ever sees is the level
  /// that keeps the door shut. Reversing these two lines is a door that clicks
  /// open on every reset; a fake records the order, and the suite asserts it.
  void begin() {
    pin_.write(lockPinLevel(false, relayActiveHigh_, unlockEnergisesRelay_));
    pin_.driveOutput();
    released_ = false;
  }

  /// Release or hold the lock. Idempotent: commanding the state it is already
  /// in still writes the level, because the only thing that could have changed
  /// the pin is something nobody here can see.
  void set(bool released) {
    pin_.write(lockPinLevel(released, relayActiveHigh_, unlockEnergisesRelay_));
    released_ = released;
  }

  /// What this driver last commanded. Never a measurement of the contact.
  bool released() const { return released_; }

private:
  IPinOut& pin_;
  bool relayActiveHigh_;
  bool unlockEnergisesRelay_;
  bool released_ = false;
};

} // namespace gatelogic

#endif // CRUSADERS_GATELOGIC_LOCKDRIVER_H
