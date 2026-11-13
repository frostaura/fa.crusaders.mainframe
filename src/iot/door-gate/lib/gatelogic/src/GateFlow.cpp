#include "gatelogic/GateFlow.h"

#include <stdio.h>
#include <string.h>

#include "devapi/Json.h"
#include "gatelogic/GateHeartbeat.h"
#include "gatelogic/GateReply.h"

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

  // ESCAPED, NOT INTERPOLATED (round G4, B1). These bytes came off a scanner
  // and a QR code is whatever somebody printed on it; a bare `%s` let a
  // seventeen-character code re-write `method` and a twenty-one-character one
  // re-write `mac`. The assembler refuses bytes outside the roster's alphabet
  // now as well, and that is the layer that stops a forged token being asked
  // about at all — but a renderer that is only safe because of what its caller
  // happens to feed it is a renderer one refactor away from being unsafe.
  char safeToken[roster::kMaxTokenLen * devapi::json::kMaxEscapeExpansion + 1U] = {};
  if (!devapi::json::escapeInto(token, strlen(token), safeToken, sizeof(safeToken))) {
    return 0U;
  }

  const int written =
      snprintf(out, cap, "{\"mac\":\"%s\",\"method\":\"qr\",\"token\":\"%s\"}", mac, safeToken);
  if (written < 0 || static_cast<size_t>(written) >= cap) {
    out[0] = '\0';
    return 0U;
  }
  return static_cast<size_t>(written);
}

ScanDecision onGateResponse(uint16_t status, const char* body, size_t len, uint32_t adoptedUnlockMs,
                            uint32_t hardCapMs) {
  // 2.0.0 reads the decision by device-api.md §11.2 (GateReply.h): every 2xx,
  // exact kinds, and an open with no `unlock_seconds` is unreadable — decided
  // offline — rather than filled in from the heartbeat's release time.
  static_cast<void>(adoptedUnlockMs);
  return readScanReply(status, body, len, hardCapMs);
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

ScanDecision fromMemberCode(memcode::Status status, const roster::Decision& decision,
                            uint32_t adoptedUnlockMs, uint32_t hardCapMs) {
  if (status == memcode::Status::Ok) {
    return fromRoster(decision, adoptedUnlockMs, hardCapMs);
  }
  ScanDecision out;
  out.queueEvent = true;
  out.eventKind = eventq::Kind::UnknownScan;
  switch (status) {
  case memcode::Status::Replayed:
    setReason(out, kReasonReplayed);
    return out;
  case memcode::Status::NoClock:
    // The board no longer knows which step it is — the same age at which it
    // stops trusting its roster, and the same refusal a member reads for that.
    setReason(out, kReasonRosterStale);
    return out;
  case memcode::Status::Throttled:
    // Too many wrong codes here lately (memcode/GuessGuard.h): the board's own
    // limit, not a verdict about this member — the same word the online path
    // uses for this board being asked too fast.
    setReason(out, kReasonTooFast);
    return out;
  case memcode::Status::Ok:
  case memcode::Status::Malformed:
  case memcode::Status::NoKey:
  case memcode::Status::WrongCode:
    break;
  }
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

ScanDecision refuseRelocking(bool offline) {
  ScanDecision decision;
  decision.askedToWait = true;
  setReason(decision, kReasonRelocking);
  decision.queueEvent = offline;
  decision.eventKind = eventq::Kind::UnknownScan;
  return decision;
}

ScanDecision refuseTooFast(bool offline) {
  ScanDecision decision;
  setReason(decision, kReasonTooFast);
  decision.queueEvent = offline;
  decision.eventKind = eventq::Kind::UnknownScan;
  return decision;
}

void markRelocking(ScanDecision& decision) {
  decision.released = false;
  decision.unlockMs = 0U;
  decision.askedToWait = true;
  // The RECORD changes too, not just the lamp. An event still saying `gate_open`
  // would be this board reporting an opening it refused, which is the one thing
  // an audit trail must never contain.
  decision.eventKind = eventq::Kind::UnknownScan;
  setReason(decision, kReasonRelocking);
}

} // namespace gatelogic
