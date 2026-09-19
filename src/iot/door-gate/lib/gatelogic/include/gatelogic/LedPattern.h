// Crusaders Mainframe — the one LED, and the four things it has to say.
//
// WHY THE LED CARRIES ANYTHING AT ALL
// -----------------------------------
// The door has no LCD, no buzzer and no screen. This lamp is the entire user
// interface and the entire diagnostic surface: it is what tells a member their
// scan was seen, and what tells the founder on a ladder whether the board is on
// the WiFi. Getting it wrong is not cosmetic — a dark LED and a dark LED are
// the same thing to the member who scanned, so "nothing happened" must be
// impossible to confuse with "refused".
//
//   solid            the lock is released — push the door
//   3 fast blinks    refused
//   1 Hz blink       the radio is not associated (roster-only mode)
//   2 quick blinks   the board just booted
//
// WHY IT IS A STATE MACHINE AND NOT delay()
// -----------------------------------------
// The obvious three blinks are `for (i<3) { on; delay(120); off; delay(120); }`,
// which is 720 ms in which the scanner is not drained, the watchdog is not fed
// and the release deadline is not checked. The whole point of a door that works
// while the network does not is a loop that never stops running, so the LED is
// asked "what level are you now" once per pass and answers from the clock.
//
// PRIORITY, HIGHEST FIRST
// -----------------------
// Released beats everything: while the door is open the lamp is solid, even if
// the WiFi dropped a second ago, because "you may go in" is the only thing that
// matters to the person in the doorway. A transient cue (refusal, boot) beats
// the link state. The link blink is what is left.
//
// No Arduino headers, no heap. Compiles for Xtensa and the host test runner.

#ifndef CRUSADERS_GATELOGIC_LEDPATTERN_H
#define CRUSADERS_GATELOGIC_LEDPATTERN_H

#include <stdint.h>

#include "hal/PinLevel.h"

#include "timebase/TimeBase.h"

namespace gatelogic {

/// The lamp's own polarity, composed in one named place for the same reason the
/// lock's is: `digitalWrite(pin, on)` compiles, looks right, and drives an
/// active-LOW lamp dark whenever the firmware believes it is lit — which for
/// this board means a member who scanned sees nothing and scans again.
constexpr hal::PinLevel ledPinLevel(bool on, bool activeHigh) {
  return (on == activeHigh) ? hal::PinLevel::kHigh : hal::PinLevel::kLow;
}

/// A one-shot pattern, played once and then forgotten.
enum class LedCue : uint8_t {
  /// Two quick blinks: the board is up. Distinguishable at a glance from the
  /// three of a refusal, which is why it is two and not three.
  Boot = 0U,
  /// Three fast blinks: refused.
  Denied = 1U,
};

/// Milliseconds. Half-periods, so a "blink" is on for one and off for one.
inline constexpr uint32_t kDeniedHalfMs = 120U;
inline constexpr uint32_t kBootHalfMs = 90U;
inline constexpr uint8_t kDeniedBlinks = 3U;
inline constexpr uint8_t kBootBlinks = 2U;
/// 1 Hz: on for half a second, off for half a second.
inline constexpr uint32_t kLinkDownHalfMs = 500U;

class LedPattern {
public:
  /// Start a one-shot. A new cue replaces one in flight rather than queueing
  /// behind it: the member is looking at the lamp NOW, and the most recent
  /// thing that happened is the thing worth showing.
  void cue(LedCue cue, uint32_t nowMs);

  /// The lock's state. Solid light while released.
  void setReleased(bool released) { released_ = released; }

  /// Whether the radio is associated. Slow blink while it is not.
  void setLinkUp(bool up) { linkUp_ = up; }

  /// What the lamp should be showing at `nowMs`. Pure: calling it twice with
  /// the same clock gives the same answer, so a test can sample a whole pattern
  /// without a fake pin.
  bool on(uint32_t nowMs) const;

private:
  /// Half-periods elapsed since the cue started, or the total the cue lasts.
  uint32_t cueHalfMs_ = 0U;
  uint32_t cueStartedAtMs_ = 0U;
  uint8_t cueHalves_ = 0U;
  bool cueActive_ = false;
  bool released_ = false;
  bool linkUp_ = false;
};

} // namespace gatelogic

#endif // CRUSADERS_GATELOGIC_LEDPATTERN_H
