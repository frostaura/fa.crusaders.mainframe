#include "gatelogic/GateFlow.h"

#include <stdio.h>

#include "devapi/Json.h"
#include "gatelogic/GateHeartbeat.h"

namespace gatelogic {
namespace {

/// Copies a reason in, refusing rather than truncating. Half a reason is a
/// different reason, and the only thing worse than an unexplained refusal at a
/// door is a wrongly explained one.
void setReason(ScanDecision& decision, const char* reason) {
  size_t i = 0U;
  while (reason[i] != '\0' && i < kMaxReasonLen) {
    decision.reason[i] = reason[i];
    ++i;
  }
  if (reason[i] != '\0') {
    decision.reason[0] = '\0';
    return;
  }
  decision.reason[i] = '\0';
}

} // namespace

Attempt chooseAttempt(bool wifiUp, bool apiDown) {
  return (wifiUp && !apiDown) ? Attempt::Online : Attempt::RosterOnly;
}

size_t renderScanBody(char* out, size_t cap, const char* mac, const char* token) {
  if (out == nullptr || cap == 0U) {
    return 0U;
  }
  out[0] = '\0';
  if (mac == nullptr || mac[0] == '\0' || token == nullptr || token[0] == '\0') {
    return 0U;
  }

  const int written = snprintf(out, cap, "{\"mac\":\"%s\",\"method\":\"qr\",\"token\":\"%s\"}", mac, token);
  if (written < 0 || static_cast<size_t>(written) >= cap) {
    out[0] = '\0';
    return 0U;
  }
  return static_cast<size_t>(written);
}

ScanDecision onGateResponse(uint16_t status, const char* body, size_t len, uint32_t adoptedUnlockMs,
                            uint32_t hardCapMs) {
  ScanDecision decision;

  // AUTHORITATIVE, AND NOT AN OUTAGE. A 403 on `/gate` is the club having taken
  // this board out of service in the admin console — the one 4xx that is a
  // statement about the board rather than about this request. Falling back
  // would keep the door admitting rostered members for the whole staleness
  // window after an admin pressed the button meant to stop exactly that.
  //
  // Before the body is looked at, and whatever the body says: the server sends
  // none, and a proxy's error page must not be able to open a door.
  if (status == 403U) {
    setReason(decision, kReasonOutOfService);
    // And the ROSTER goes, not just this scan. Denying the scan in front of us
    // and keeping the roster would leave the next link drop admitting every
    // rostered member again — which is the window the whole 403 rule exists to
    // close, and the scan path is often the first one a board speaks on after
    // an admin presses the button.
    decision.outOfService = true;
    return decision;
  }

  // devapi::react() is deliberately NOT used here. Its `Rejected` class means
  // "a 4xx this box caused — drop it and move on", which is the right answer
  // for an event upload and the wrong one for a door: a 400 or a 404 says this
  // board learned nothing about the member standing in front of it, and the
  // roster may well know them. Everything left is an outage.
  if (status != 200U || body == nullptr) {
    decision.fallbackToRoster = true;
    return decision;
  }

  bool opened = false;
  if (!devapi::json::boolField(body, len, "opened", opened)) {
    // A 200 whose body is truncated, empty, or shaped differently from the
    // contract. It is not a refusal — nobody said no — so it is an outage with
    // a 200 on it, and the roster gets its turn.
    decision.fallbackToRoster = true;
    return decision;
  }

  if (!devapi::json::stringField(body, len, "reason", decision.reason, sizeof(decision.reason))) {
    // The flag is the decision; the reason is commentary. A 200 that opens the
    // door with no readable reason still opens the door.
    decision.reason[0] = '\0';
  }

  if (!opened) {
    // AUTHORITATIVE. No roster second-guess, ever: the API knows about the
    // membership suspended this morning and the roster does not.
    return decision;
  }

  uint32_t seconds = 0U;
  decision.released = true;
  decision.unlockMs = devapi::json::unsignedField(body, len, "unlock_seconds", seconds)
                          ? unlockMsFromSeconds(seconds, hardCapMs)
                          : clampUnlockMs(adoptedUnlockMs, hardCapMs);
  return decision;
}

ScanDecision fromRoster(const roster::Decision& decision, uint32_t adoptedUnlockMs, uint32_t hardCapMs) {
  ScanDecision out;
  // Everything decided here is news to the API by definition: this path only
  // runs because the API could not be asked.
  out.queueEvent = true;
  out.eventKind = eventq::Kind::UnknownScan;

  switch (decision.verdict) {
  case roster::Verdict::Allow:
    out.released = true;
    // The ADOPTED release time, not decision.grantMs. grantMs is what is left
    // of the booking — 25 minutes for somebody who arrived late — and a door
    // held open for 25 minutes is a door that is not a door.
    out.unlockMs = clampUnlockMs(adoptedUnlockMs, hardCapMs);
    out.eventKind = eventq::Kind::GateOpen;
    setReason(out, kReasonOk);
    return out;
  case roster::Verdict::TooEarly:
    setReason(out, kReasonTooEarly);
    return out;
  case roster::Verdict::TooLate:
    setReason(out, kReasonTooLate);
    return out;
  case roster::Verdict::Stale:
    // A roster past its maximum age admits NOBODY, however good the match
    // looks. The member goes to the desk and an admin lets them in — annoying,
    // recoverable. The other direction is a door that opens for a booking
    // cancelled a week ago and a club that finds out at month end.
    setReason(out, kReasonRosterStale);
    return out;
  case roster::Verdict::WrongCourt:
    // A gate asks with CourtCount(1) and the contract's roster carries relay 0
    // for every entry, so this is unreachable from a well-formed push. It is
    // handled rather than defaulted so that -Wswitch-enum still fails on a
    // verdict added later, and it refuses — an entry naming a relay this board
    // does not drive is an entry this board cannot act on.
    setReason(out, kReasonNotRecognised);
    return out;
  case roster::Verdict::Unknown:
    setReason(out, kReasonNotRecognised);
    return out;
  }

  // Reachable only from a verdict byte no enumerator covers.
  setReason(out, kReasonNotRecognised);
  return out;
}

ScanDecision refuseUnreadable(bool offline) {
  ScanDecision decision;
  setReason(decision, kReasonNotRecognised);
  decision.queueEvent = offline;
  decision.eventKind = eventq::Kind::UnknownScan;
  return decision;
}

} // namespace gatelogic
