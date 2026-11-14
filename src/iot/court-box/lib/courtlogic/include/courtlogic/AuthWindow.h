// Crusaders Mainframe — the bounded window in which button presses count.
//
// WHY THIS EXISTS
// ---------------
// The second of the two safety rules the serial spec puts on the Mega. Carl's
// sketch has an `authenticated` flag with no expiry at all: once a scan sets
// it, a button pressed hours later still fires a relay, and the credits come
// off whoever scanned last. On a court box in a public corridor that is not an
// edge case, it is the normal end of every session.
//
// So authorisation is a deadline, not a flag, and the deadline lives on the
// Mega. `!AUTH,<seconds>` arms it, `!AUTH,0` disarms it, and a lapse emits
// `!EVT,AUTHEXPIRED` exactly once so the bridge can repaint the screen without
// polling for it.
//
// WHY THE LAPSE IS AN EDGE AND NOT A LEVEL
// ----------------------------------------
// lapsed() is true on the single pass the window closes on, and false on every
// pass afterwards. A level-triggered "is expired" would put one `!EVT` per loop
// iteration on a 9600 baud link — several hundred frames a second, which is
// both a flooded link and an event log nobody can read.
//
// Rejected: keeping the window on the ESP. It is the ESP that goes away — a
// restart, WiFi, a crash — and a window that stops expiring when its owner stops running
// is the same defect as the relay timer being on a Windows PC.
//
// No Arduino headers, no heap.

#ifndef CRUSADERS_COURTLOGIC_AUTHWINDOW_H
#define CRUSADERS_COURTLOGIC_AUTHWINDOW_H

#include <stdint.h>

#include "timebase/TimeBase.h"

namespace courtlogic {

/// AUTH_TTL_MS. The window a scan buys when nobody says otherwise, and the
/// window a legacy `<line1>|<line2>` prompt implies.
inline constexpr uint32_t kAuthDefaultMs = 30000UL;

/// Ceiling on an armed window, shared with the relay cap: an authorisation that
/// outlived the longest possible session would be an unexpiring flag again,
/// reached by asking for a large enough number.
inline constexpr uint32_t kAuthMaxMs = 5400000UL;

#ifdef AUTH_TTL_MS
static_assert(AUTH_TTL_MS == kAuthDefaultMs,
              "kAuthDefaultMs and the court_bridge AUTH_TTL_MS build flag have drifted apart");
#endif

class AuthWindow {
public:
  AuthWindow();

  /// Accept button input for `seconds`, clamped to kAuthMaxMs. Zero disarms —
  /// that is how `!AUTH,0` is spelled, and it is why there is no lower clamp
  /// here the way there is on a relay duration.
  ///
  /// Arming an already-armed window replaces the deadline rather than adding
  /// to it: a second scan is a fresh 30 seconds, not 60.
  void arm(uint32_t nowMs, uint32_t seconds);

  /// Close the window now. No `!EVT,AUTHEXPIRED` follows — the bridge asked
  /// for this and does not need to be told about it.
  void disarm();

  /// True while presses count.
  bool allows(uint32_t nowMs) const { return until_.expired(nowMs) ? false : until_.isArmed(); }

  /// True exactly once, on the pass the window closed by itself. The caller
  /// emits `!EVT,AUTHEXPIRED`; calling it again returns false.
  bool lapsed(uint32_t nowMs);

  uint32_t remainingMs(uint32_t nowMs) const { return until_.remaining(nowMs); }

private:
  tb::Deadline until_;
};

} // namespace courtlogic

#endif // CRUSADERS_COURTLOGIC_AUTHWINDOW_H
