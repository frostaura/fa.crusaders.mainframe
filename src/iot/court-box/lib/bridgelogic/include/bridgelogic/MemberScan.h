// Crusaders Mainframe — a single rotating code at the court box, with no network.
//
// WHERE THIS SITS
// ---------------
// A scan on a box that can reach the API asks the API — v1 code or legacy, the
// bytes go up unchanged and the answer is final (ScanFlow). This is the OTHER
// half: the roster's scan, for a token that looks like a v1 member code
// (docs/specs/member-code.md §6). It replaces "match the scanned bytes against
// the roster", which a code that changes every thirty seconds can never do,
// with two questions asked in order:
//
//   1. Is this the member the code says? memcode::verify checks OFF under the
//      member's K_day at this box's step, ±1, and that it is not a replay.
//   2. May that member open a court here? The roster's REF lists, through the
//      same verdicts — allow, too early, too late, wrong court, stale — as a
//      legacy code, so the glass reads the same whichever kind was scanned.
//
// WHAT IT NEVER DOES
// ------------------
// Anything with money. A walk-up and a pay-for need the network whatever code
// is presented, exactly as before; offline a v1 code lights only a court its
// holder (or a partner on the same booking) has already paid for.
//
// THE RE-SCAN GUARD HOLDS FOR V1 TOO
// ----------------------------------
// A member who scans again mid-game is told COURT B IS ON, not re-granted: the
// same bridgelogic::regrantsHeldCourt rule the legacy path uses, asked of the
// REF path's decision, BEFORE the session records anything.
//
// No Arduino headers, no heap, no String. Compiles for Xtensa and the host.

#ifndef CRUSADERS_BRIDGELOGIC_MEMBERSCAN_H
#define CRUSADERS_BRIDGELOGIC_MEMBERSCAN_H

#include <stdint.h>

#include "bridgelogic/ScanFlow.h"
#include "bridgelogic/StateReconcile.h"
#include "court/Session.h"
#include "eventq/Event.h"
#include "memcode/Verifier.h"
#include "roster/Roster.h"

namespace bridgelogic {

/// What a member reads for a code this box has already acted on. The code on
/// their phone moves on within thirty seconds; the next one works.
inline constexpr char kCodeUsedLine1[] = "CODE USED";
inline constexpr char kCodeUsedLine2[] = "WAIT 30 SECONDS";

/// Key ring and replay ring sizes for the court box. 24 keys fit the 2048-byte
/// heartbeat contract beside sixteen four-player entries (the corpus's
/// `heartbeat-response-codes-full` is the proof); 16 remembered uses cover more
/// distinct members than four courts see inside one ninety-second window.
inline constexpr uint8_t kCourtKeyRingSlots = 24U;
inline constexpr uint8_t kCourtReplaySlots = 16U;

struct MemberScanResult {
  /// What to paint and whether to light, exactly as a roster scan's outcome.
  court::Outcome outcome;
  /// The verifier's judgement — its REF and step are what the caller commits to
  /// the replay ring once the court is actually lit.
  memcode::Verdict verdict;
  /// The verified member's court is already lit: paint `outcome`, bind the
  /// button window to its court, record nothing.
  bool alreadyOn = false;
};

/// The courts this box drives and what it believes about each: the held
/// state the re-scan guard reads, and how many relays the scanner serves.
struct BoxCourts {
  const HeldState* held;
  uint8_t count;
};

/// The offline decision for a scan that looks like a v1 member code.
template <class SessionT, class RosterT, class KeyRingT, class ReplayT>
MemberScanResult
decideOfflineMemberCode(const char* token, const memcode::OfflineCodes<KeyRingT, ReplayT>& codes,
                        const RosterT& cache, SessionT& session, BoxCourts box, uint32_t nowMs) {
  MemberScanResult result;
  result.verdict = memcode::verify(token, codes, nowMs);
  const roster::CourtCount courts(box.count);

  switch (result.verdict.status) {
  case memcode::Status::Ok: {
    const char* ref = result.verdict.token.refText;
    if (regrantsHeldCourt(cache.decideMember(ref, courts, nowMs), box.held, result.outcome)) {
      result.alreadyOn = true;
      return result;
    }
    result.outcome =
        session.onMemberScan(token, ref, roster::Verdict::Unknown, courts, eventq::Method::Qr, nowMs);
    return result;
  }
  case memcode::Status::Replayed:
    // Recorded as a refused scan, so the club can see a code presented twice,
    // and told as what it is. The member IS known — the code was theirs — so
    // the scan is recognised, which is what arms the button window.
    result.outcome =
        session.onMemberScan(token, nullptr, roster::Verdict::Unknown, courts, eventq::Method::Qr, nowMs);
    court::detail::setLine(result.outcome.line1, kCodeUsedLine1);
    court::detail::setLine(result.outcome.line2, kCodeUsedLine2);
    result.outcome.recognised = true;
    return result;
  case memcode::Status::NoClock:
    // The box no longer knows which step it is. The roster is judged the same
    // way at the same age, so the member reads the roster's own stale screen.
    result.outcome =
        session.onMemberScan(token, nullptr, roster::Verdict::Stale, courts, eventq::Method::Qr, nowMs);
    return result;
  case memcode::Status::Malformed:
  case memcode::Status::NoKey:
  case memcode::Status::WrongCode:
    break;
  }
  result.outcome =
      session.onMemberScan(token, nullptr, roster::Verdict::Unknown, courts, eventq::Method::Qr, nowMs);
  return result;
}

} // namespace bridgelogic

#endif // CRUSADERS_BRIDGELOGIC_MEMBERSCAN_H
