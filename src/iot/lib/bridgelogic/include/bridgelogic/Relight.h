// Crusaders Mainframe — keeping a court lit past the ninety-minute relay cap.
//
// THE GAP
// -------
// One `!ON` buys at most ninety minutes: the Mega clamps every duration to
// kRelayHardCapSeconds, on purpose, so a bridge that DIES cannot leave a court
// burning. A two-hour booking therefore went dark at minute ninety with no
// cue, after an LCD that had promised "90 MIN" for a 120-minute purchase, and
// the only re-light was "scan again" — which the roster refuses once the
// booking is checked in.
//
// THE RULE
// --------
// The bridge knows how long the booking really has: the roster entry's
// `closes_in`, the activate response's `granted_seconds`, the walk-up's
// `granted_minutes` — all carried uncapped in court::Outcome::bookingRemainingMs.
// For a grant longer than the cap this remembers, per court, when the booking
// ends and when the current relay deadline runs out, and says when to send
// `!EXT,<court>,<seconds>`: kExtLeadMs before the deadline, for
// min(cap, what is left of the booking). The Mega's per-command cap is still
// the safety net — every `!EXT` is clamped there too, and a bridge that dies
// mid-booking still fails open at the next cap. A release, by whichever
// messenger, forgets the court.
//
// tb::Deadline throughout: a two-hour booking that straddles the 49.7-day
// millis() wrap is exactly the kind of thing this box is up long enough to see.
//
// No Arduino headers, no heap. Compiles for Xtensa and the host.

#ifndef CRUSADERS_BRIDGELOGIC_RELIGHT_H
#define CRUSADERS_BRIDGELOGIC_RELIGHT_H

#include <stdint.h>

#include "bridgelogic/StateReconcile.h"
#include "court/Session.h"
#include "timebase/TimeBase.h"

namespace bridgelogic {

/// How long before the relay deadline the extension is sent. Long enough to
/// survive a heartbeat's 4 s blocking call and a dropped frame plus the next
/// periodic `!STATE`; short enough that a booking cancelled at the desk is
/// not extended by a whole minute more than it had to be.
inline constexpr uint32_t kExtLeadMs = 60000UL;

/// What to send for one court, if anything.
struct Extension {
  bool due = false;
  uint32_t seconds = 0U;
};

class Relight {
public:
  /// A court was lit (or re-lit) by `outcome` at `nowMs`. Remembers nothing
  /// for a grant the cap did not shorten.
  void onGrant(const court::Outcome& outcome, uint32_t nowMs);

  /// The court went dark, by `!EVT` or `!STATE`. Forgotten.
  void onRelease(uint8_t court);

  /// Whether `court` needs an `!EXT` now, and for how many seconds. Calling
  /// this does not change anything; the caller reports what it sent with
  /// extended().
  Extension check(uint8_t court, uint32_t nowMs) const;

  /// The `!EXT` for `court` was sent for `seconds`: the relay deadline moves.
  ///
  /// Stamped on SEND, which is a belief and not a fact — the frame may still be
  /// corrupted on the wire. observeRelayRemaining is what turns it back into a
  /// fact, and bridgelogic::OnRetry re-sends a frame the Mega said it could not
  /// decode.
  void extended(uint8_t court, uint32_t seconds, uint32_t nowMs);

  /// The Mega's own account of how many seconds `court`'s relay has left,
  /// taken from a `!STATE` frame.
  ///
  /// The Mega is the AUTHORITY on the relay deadline; this half only ever had a
  /// belief about it, formed the instant an `!EXT` left the TX ring. When that
  /// frame is lost the belief is ~29 minutes wrong and the court goes dark
  /// mid-game with the bridge convinced it had extended it (review 3, finding
  /// 7). `!STATE` carries the truth every ten seconds and on every change;
  /// this adopts it, so a lost extension is corrected within one `!STATE` and
  /// re-sent by the ordinary lead-time rule.
  ///
  /// Ignored for a court that is not being tracked: a court whose booking fits
  /// inside one relay deadline has no extension to get wrong.
  void observeRelayRemaining(uint8_t court, uint32_t seconds, uint32_t nowMs);

  /// True while `court` has a booking longer than its current relay deadline.
  bool tracking(uint8_t court) const;

private:
  struct Court {
    /// When the booking ends.
    tb::Deadline bookingEnd;
    /// When the relay's current deadline runs out.
    tb::Deadline relayEnd;
  };

  Court courts_[kStateCourts];
};

/// True when this box is in the middle of something a reboot would break: a
/// court held, a booking whose `!EXT` is still owed, or an armed button window
/// with a member standing at the panel.
///
/// An OTA install blocks for the whole download and then reboots. Across that
/// reboot the bridge loses Relight's per-court booking end, the held-since
/// stamps and the bound button window — so a two-hour booking adopted from the
/// first `!STATE` after the reboot is never extended and darkens at the cap,
/// mid-game (review 3, finding 8). Nothing recovers those from the Mega,
/// because the Mega never knew the booking. Deferring the install to a
/// heartbeat when the box is idle costs at most one heartbeat interval per
/// busy court and is the only bound available without persisting the booking
/// ends.
bool anyCourtBusy(const HeldState held[kStateCourts], const Relight& relight, bool authArmed);

} // namespace bridgelogic

#endif // CRUSADERS_BRIDGELOGIC_RELIGHT_H
