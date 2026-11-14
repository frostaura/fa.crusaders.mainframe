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
// REF path's decision, BEFORE the session records anything. That includes the
// SAME code scanned again inside its window: a replay whose REF holds a lit
// court here is that court's ON screen with its OFF bound, and the scan spent
// — "holds" by the roster, or by this box's own online grant (OnlineGrants).
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

/// What a member reads while the guess guard has offline verification locked
/// (memcode/GuessGuard.h): somebody has been presenting wrong codes here.
inline constexpr char kThrottledLine1[] = "TOO MANY TRIES";
inline constexpr char kThrottledLine2[] = "TRY IN A MINUTE";

/// Key ring and replay ring sizes for the court box. 64 keys: the most the
/// server sends a hb:3 box (device-api.md §11.4, MCV1-07 — 3.0.0 held 24, and
/// the 40 it shed were booked members refused offline). The ring replaces in
/// place (memcode::KeyRing), so 64 cost 1.3 KB rather than 2.6. 16 remembered
/// uses cover more distinct members than four courts see in ninety seconds.
inline constexpr uint8_t kCourtKeyRingSlots = 64U;
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
  /// The scan buys nothing: forget it before any button is pressed. Set for a
  /// used code shown its own lit court — the OFF is bound, but a walk-up or a
  /// pay-for must never ride a code that may be a photo of somebody's screen.
  bool scanSpent = false;
  /// The code may well be a valid member's: verified with nothing booked
  /// here, or no key to verify it with (MCV1-08). The caller words its
  /// refusal for why the server was not heard (explainNoDecision).
  bool couldBeMember = false;
};

/// A refused v1 scan, recorded as an unknown scan and told in its own words.
/// Never recognised: nothing about it arms the buttons.
template <class SessionT>
MemberScanResult refusedAs(const char* token, roster::CourtCount courts, SessionT& session, uint32_t nowMs,
                           const char* line1, const char* line2) {
  MemberScanResult result;
  result.outcome =
      session.onMemberScan(token, nullptr, roster::Verdict::Unknown, courts, eventq::Method::Qr, nowMs);
  court::detail::setLine(result.outcome.line1, line1);
  court::detail::setLine(result.outcome.line2, line2);
  result.outcome.recognised = false;
  return result;
}

/// The member each court was lit for by THIS box's own online call — an
/// activation, a walk-up or a pay-for — by REF, until the court goes dark.
///
/// The roster cannot answer that question for every lighting: it lists a
/// booking's organiser and its accepted partners, and a walk-up booking (or a
/// booking the server created a moment ago) reaches it only with the next
/// heartbeat. So a member who bought court C at the buttons and scanned the
/// same code again inside its thirty seconds was a replay with no game of
/// theirs on the roster, and read CODE USED with the OFF disarmed under their
/// own game (round 7, D7-1). This remembers what the box itself did, which is
/// the one thing it can know without being told. A legacy code remembers
/// nothing: it has no REF to prove.
class OnlineGrants {
public:
  /// `court` was just lit online for whoever scanned `token`.
  void lit(uint8_t court, const char* token) {
    if (court >= kStateCourts) {
      return;
    }
    memcode::Token parsed;
    refs_[court] = token != nullptr && memcode::parse(token, parsed) ? parsed.ref : 0U;
  }

  /// `court` went dark: nobody's game is on it any more.
  void released(uint8_t court) {
    if (court < kStateCourts) {
      refs_[court] = 0U;
    }
  }

  /// The court this box lit online for `ref`, when it still remembers one.
  /// REF zero is reserved (memcode/Token.h), so it is the empty slot.
  bool courtFor(uint32_t ref, uint8_t& court) const {
    for (uint8_t i = 0U; ref != 0U && i < kStateCourts; ++i) {
      if (refs_[i] == ref) {
        court = i;
        return true;
      }
    }
    return false;
  }

private:
  uint32_t refs_[kStateCourts] = {};
};

/// An ONLINE decision just tried to light `outcome.court` for whoever scanned
/// `token`: remember whose game it is so their own rescan of the same code
/// reads its ON screen (D7-1) — only when THIS attempt's `!ON` left the bridge
/// (`onSent`). The held state alone was the old test, and it is still true
/// from the previous game when the new `!ON` fails: a court that never lit for
/// this member named them (review round 8, D8-3).
inline void noteOnlineLighting(OnlineGrants& grants, const court::Outcome& outcome,
                               const HeldState held[kStateCourts], bool onSent, const char* token) {
  if (onSent && outcome.action == court::Action::TurnOn && outcome.court < kStateCourts &&
      held[outcome.court].held) {
    grants.lit(outcome.court, token);
  }
}

/// The `!ON` for `court` failed twice (OnRetry): the court is dark in this
/// half's books, so the next `!STATE` does not synthesise a Release for a
/// session that never started — and nobody's game is on it, so the online
/// grant goes with it, as on every other path a court goes dark by (D8-3).
inline void courtStaysDark(uint8_t court, HeldState held[kStateCourts], OnlineGrants& grants,
                           uint32_t nowMs) {
  if (court < kStateCourts) {
    held[court] = HeldState{nowMs, false};
    grants.released(court);
  }
}

/// The courts this box drives and what it believes about each: the held
/// state the re-scan guard reads, how many relays the scanner serves, and
/// which of them this box lit online for whom (null: none remembered).
struct BoxCourts {
  const HeldState* held;
  uint8_t count;
  const OnlineGrants* online;
};

/// The re-scan guard for a court this box lit ONLINE for `ref`: the same
/// decision regrantsHeldCourt reads from the roster, built from the box's own
/// memory instead — so the ON screen, its lines and the held-state check are
/// one rule, whichever of the two knew whose game it is.
inline bool regrantsOnlineGrant(uint32_t ref, const BoxCourts& box, court::Outcome& out) {
  uint8_t court = 0U;
  if (box.online == nullptr || !box.online->courtFor(ref, court) || court >= box.count) {
    return false;
  }
  roster::Decision decision;
  decision.verdict = roster::Verdict::Allow;
  decision.entry.court = court;
  return regrantsHeldCourt(decision, box.held, out);
}

/// The offline decision for a scan that looks like a v1 member code.
template <class SessionT, class RosterT, class KeyRingT, class ReplayT>
MemberScanResult
decideOfflineMemberCode(const char* token, const memcode::OfflineCodes<KeyRingT, ReplayT>& codes,
                        const RosterT& cache, SessionT& session, BoxCourts box, uint32_t nowMs) {
  MemberScanResult result;
  result.verdict = memcode::verifyGuarded(token, codes, nowMs);
  const roster::CourtCount courts(box.count);

  switch (result.verdict.status) {
  case memcode::Status::Ok: {
    const char* ref = result.verdict.token.refText;
    if (regrantsHeldCourt(cache.decideMember(ref, courts, nowMs), box.held, result.outcome) ||
        regrantsOnlineGrant(result.verdict.token.ref, box, result.outcome)) {
      result.alreadyOn = true;
      return result;
    }
    result.outcome =
        session.onMemberScan(token, ref, roster::Verdict::Unknown, courts, eventq::Method::Qr, nowMs);
    result.couldBeMember = cache.decideMember(ref, courts, nowMs).verdict == roster::Verdict::Unknown;
    return result;
  }
  case memcode::Status::Replayed:
    // OFF matched, so the REF is proven — only the step is spent. The member
    // who just lit their court and scans the same code again inside its thirty
    // seconds (to switch off, or to check) reads COURT B IS ON with the OFF
    // bound to it, as a fresh code gives them — never CODE USED with the
    // buttons disarmed under their own game (round 6, D6-3). The scan is spent:
    // a used code may be a photo of somebody else's screen, so it binds that
    // court's OFF and buys nothing. Nothing is recorded, as for any rescan.
    // "Their court" is the roster's booking naming them, or a court this box
    // lit online for them — a walk-up or a pay-for is on no roster until the
    // next heartbeat (round 7, D7-1).
    if (regrantsHeldCourt(cache.decideMember(result.verdict.token.refText, courts, nowMs), box.held,
                          result.outcome) ||
        regrantsOnlineGrant(result.verdict.token.ref, box, result.outcome)) {
      result.alreadyOn = true;
      result.scanSpent = true;
      return result;
    }
    // No game of theirs lit here: recorded as a refused scan, so the club can
    // see a code presented twice, and told as what it is. NOT recognised:
    // whoever is holding a used code may be holding a photo of somebody else's
    // screen, and a recognised scan arms the buttons — a walk-up or a pay-for
    // on the victim's identity.
    [[fallthrough]];
  case memcode::Status::Throttled: {
    const bool used = result.verdict.status == memcode::Status::Replayed;
    const memcode::Verdict verdict = result.verdict;
    result = refusedAs(token, courts, session, nowMs, used ? kCodeUsedLine1 : kThrottledLine1,
                       used ? kCodeUsedLine2 : kThrottledLine2);
    result.verdict = verdict;
    return result;
  }
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
  // No key: the box cannot tell, and a member whose key was shed is not an
  // unknown code. A wrong or malformed code IS one.
  result.couldBeMember = result.verdict.status == memcode::Status::NoKey;
  return result;
}

} // namespace bridgelogic

#endif // CRUSADERS_BRIDGELOGIC_MEMBERSCAN_H
