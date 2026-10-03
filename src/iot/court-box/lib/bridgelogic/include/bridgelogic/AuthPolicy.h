// Crusaders Mainframe — when the Mega's button window is armed, and for whom.
//
// WHAT WENT WRONG BEFORE
// ----------------------
// The H1 fix sent `!AUTH,30` the instant a scan arrived, before anything had
// decided what the scan was, and sent `!AUTH,0` the instant a court was lit.
// Two consequences, both inverted from what a club would want:
//
//   * a scan nobody recognised — any barcode — opened thirty seconds of
//     buttons, and with an admin-mapped OFF button that was COURT B, OFF:
//     a league match in the dark from a junior with a supermarket receipt;
//   * the member whose scan lit the court had their window closed by the
//     grant, and a rescan is another grant, so THEY could never press OFF.
//
// THE RULE
// --------
// The window is armed only for a RECOGNISED scan: the API answered with a
// verdict about a known member (activated, or refused for any reason except
// not_recognised — a known member with no booking is exactly who buys a
// walk-up), or the roster matched an entry (allowed, too early, too late or
// wrong court). An unknown token and a stale roster arm nothing.
//
// A grant does not close the window; it BINDS it. The court that was just lit
// is remembered, the window stays armed for the same TTL, and an OFF press is
// honoured for that court and refused for every other. The scan itself is
// spent by the grant (no walk-up on a lit member's token — that is the
// composition root's gLastScan, unchanged), so the bound window is release-only.
// A lapse disarms it, as it always did.
//
// No Arduino headers, no heap. Compiles for Xtensa and the host.

#ifndef CRUSADERS_BRIDGELOGIC_AUTHPOLICY_H
#define CRUSADERS_BRIDGELOGIC_AUTHPOLICY_H

#include <stdint.h>

#include "court/Session.h"
#include "timebase/TimeBase.h"

namespace bridgelogic {

/// What the composition root sends the Mega after the policy has spoken.
enum class AuthCommand : uint8_t {
  /// Nothing changed on the Mega's side.
  None = 0U,
  /// `!AUTH,<ttl seconds>` — arm (or re-arm) the window.
  Arm = 1U,
  /// `!AUTH,0` — close the window now.
  Disarm = 2U,
};

class AuthPolicy {
public:
  /// `ttlMs` is the window a recognised scan buys — the same number the scan
  /// is remembered for, because the two are one fact seen from either end of
  /// the cable.
  explicit AuthPolicy(uint32_t ttlMs) : ttlMs_(ttlMs) {}

  /// Adopt the tenant's `scan_memory_seconds`.
  ///
  /// From the NEXT scan, never the live window: shortening the window under a
  /// member who is mid-purchase would close the buttons they are reaching for.
  /// The same rule the heartbeat interval and the pad's selection TTL follow.
  ///
  /// The parser holds `scan_memory_seconds >= lcd_choice_seconds` by RAISING
  /// this rather than lowering the choice window, which is what stops the box
  /// forgetting who scanned while their selection is still on the pad — the
  /// next person's presses would otherwise buy on their token.
  void setTtlMs(uint32_t ttlMs) { ttlMs_ = ttlMs; }

  uint32_t ttlMs() const { return ttlMs_; }

  /// A scan was decided, by whichever path. Arms for a recognised scan and
  /// binds the window to the court if one was lit; disarms for an unrecognised
  /// one. Returns what to send the Mega.
  AuthCommand afterScan(const court::Outcome& outcome, uint32_t nowMs);

  /// A member rescanned on a court this box already has lit. Nothing is
  /// granted, but the window is armed and BOUND to that court: they are the
  /// person standing at the panel and their OFF press has to work. Arming
  /// unbound — which is what a plain recognised refusal does — would answer
  /// that press with NOT YOUR COURT on their own game.
  AuthCommand afterHeldCourtRescan(uint8_t court, uint32_t nowMs);

  /// A walk-up was answered. A grant binds the window to the court it lit so
  /// the buyer can release it; a refusal leaves the window as it was.
  AuthCommand afterWalkUp(const court::Outcome& outcome, uint32_t nowMs);

  /// A pay-for quote is on the glass (D10). The window is re-armed, unbound,
  /// for a full scan-memory TTL: the member is being asked to press the court
  /// again, and the Mega's window is the thing that forwards that press. A
  /// PAID answer afterwards goes through afterWalkUp, which binds the window
  /// to a court it lit.
  AuthCommand afterPayForQuote(uint32_t nowMs);

  /// Whether an OFF press for `court` is honoured right now: the window must
  /// be armed, unexpired and bound to exactly that court.
  bool allowsRelease(uint8_t court, uint32_t nowMs) const;

  /// The window ran out on its own. True exactly once, on the pass it lapsed,
  /// so the caller sends one `!AUTH,0` and the two ends cannot drift.
  bool lapsed(uint32_t nowMs);

  /// Close the window now. What a forgotten scan does.
  AuthCommand disarm();

  bool armed(uint32_t nowMs) const { return until_.isArmed() && !until_.expired(nowMs); }

  /// The court a release is allowed on, or kUnbound.
  uint8_t boundCourt() const { return court_; }

  static constexpr uint8_t kUnbound = 0xFFU;

private:
  AuthCommand arm(uint8_t court, uint32_t nowMs);

  uint32_t ttlMs_;
  tb::Deadline until_;
  uint8_t court_ = kUnbound;
};

} // namespace bridgelogic

#endif // CRUSADERS_BRIDGELOGIC_AUTHPOLICY_H
