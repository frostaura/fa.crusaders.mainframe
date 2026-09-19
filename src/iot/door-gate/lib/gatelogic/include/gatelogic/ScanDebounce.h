// Crusaders Mainframe — the same phone, held at the window.
//
// WHY
// ---
// A QR scanner re-reads while the code is in front of it: one presentation is
// several identical lines, hundreds of milliseconds apart. Without this, each
// one is a POST to /gate, an audit row against the member, and a re-arm of the
// release window — so a member who leaves their phone on the reader holds the
// door open for as long as they leave it there, and the club's audit trail
// shows them entering eleven times.
//
// THE RULE, FROM THE CONTRACT
// ---------------------------
// The same token within kScanDebounceMs of a DECISION for it is ignored. Of a
// decision, not of the previous scan: the window starts when the board knows
// what it thinks, so a scan that spent four seconds in an HTTP timeout is not
// immediately followed by a second attempt at the same token.
//
// A DIFFERENT token is never suppressed. Two members arriving together are two
// decisions, and making the second one wait would be a door that refuses the
// person standing behind the person it just let in.
//
// No Arduino headers, no heap. Compiles for Xtensa and the host test runner.

#ifndef CRUSADERS_GATELOGIC_SCANDEBOUNCE_H
#define CRUSADERS_GATELOGIC_SCANDEBOUNCE_H

#include <stdint.h>

#include "gatelogic/GateConfig.h"
#include "roster/Roster.h"
#include "timebase/TimeBase.h"

namespace gatelogic {

class ScanDebounce {
public:
  explicit ScanDebounce(uint32_t windowMs = kScanDebounceMs) : windowMs_(windowMs) {}

  /// True when this token was decided less than the window ago and should be
  /// dropped without a decision.
  bool suppresses(const char* token, uint32_t nowMs) const;

  /// Remember that `token` has just been decided, whatever the decision was. A
  /// refusal is debounced exactly like an open: a member whose code the club
  /// has barred is also standing there holding their phone up.
  void decided(const char* token, uint32_t nowMs);

  /// Forget the last decision, so the next scan of it is answered immediately.
  void reset() { seen_ = false; }

private:
  uint32_t windowMs_;
  char last_[roster::kMaxTokenLen + 1U] = {};
  uint32_t decidedAtMs_ = 0U;
  /// A flag, not "decidedAtMs_ == 0". Every uint32_t is a legal millis()
  /// reading, so no value is free to mean "never" — the rule TimeBase.h states.
  bool seen_ = false;
};

} // namespace gatelogic

#endif // CRUSADERS_GATELOGIC_SCANDEBOUNCE_H
