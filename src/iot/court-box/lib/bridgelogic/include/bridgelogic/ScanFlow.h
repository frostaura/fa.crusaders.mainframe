// Crusaders Mainframe — what the bridge does with a scan: ask the API first,
// fall back to the roster only when the API could not be asked.
//
// WHY THERE IS AN ONLINE PATH AT ALL
// ----------------------------------
// The roster is a cache of NEAR-FUTURE bookings, pushed every heartbeat. It is
// what keeps a court working through a router reboot, and it cannot answer
// three things the API can: a booking made in the last thirty seconds, a
// walk-up member with no booking, and whether a member with too few minutes
// may be let on. So a scan on a box that can reach the API asks the API, and
// the API's answer is final — the roster is consulted only when there was no
// answer, never to second-guess one (review C3).
//
// The distinction that matters: a REFUSAL from the API ("no booking", "wrong
// court") is a decision, and the roster does not get a second opinion. A
// TRANSPORT failure (no route, a 5xx, a rate limit, a 401 the client is already
// correcting its clock over, a 200 with no grant in it) is the absence of a
// decision, and the roster decides as it always did.
//
// WHY AN ONLINE GRANT QUEUES NO EVENT
// -----------------------------------
// The event queue is the record of what the API did NOT hear. An activation the
// API itself granted is one it has already recorded; queuing it again would
// double-report attendance for every online scan. The roster path still queues,
// because on that path the API has heard nothing.
//
// WHY THE RESULT CARRIES A "DISARM AUTH" BIT
// ------------------------------------------
// A scan arms the Mega's button window for thirty seconds so the member can buy
// time or release the court. Once their court is lit that window is SPENT: the
// next person to walk up must not get thirty seconds of buttons on the previous
// member's identity. The decision lives here so a host test can pin it.
//
// The rule is the same whichever path lit the court. The online grant carried
// the bit and the roster grant did not (review H1): a box with no link lit the
// court and left the window armed, and the next walk-up was thirty seconds of
// buttons on a stranger's token. `spendsScan` is the one rule for both, and the
// online path's bit is pinned to agree with it.
//
// No Arduino headers, no heap, no String. Compiles for Xtensa and the host.

#ifndef CRUSADERS_BRIDGELOGIC_SCANFLOW_H
#define CRUSADERS_BRIDGELOGIC_SCANFLOW_H

#include <stddef.h>
#include <stdint.h>

#include "bridgelogic/StateReconcile.h"
#include "court/Session.h"
#include "devapi/Json.h"
#include "devlink/RosterSync.h"
#include "protocol/Protocol.h"

namespace bridgelogic {

/// Which path a scan takes.
enum class Attempt : uint8_t {
  /// Ask `/api/v1/device/activate`; the roster only if that yields no decision.
  Online = 0U,
  /// Decide from the roster cache. The API is not reachable, or the box is not
  /// yet in a state where its answer could be acted on.
  RosterOnly = 1U,
};

/// What the bridge knows about its link when the scan arrives.
///
/// It used to carry `provisioned` and `clockKnown` too. Neither exists any
/// more: the key and the API base URL are compiled in, so a box is provisioned
/// from its first instruction, and nothing signs anything, so there is no clock
/// to be unsynchronised. What is left is genuinely about the link.
struct LinkState {
  bool wifiUp = false;
  /// Relays the heartbeat has mapped to court numbers. Zero for ~30 s after
  /// every reboot, and an online grant then names a court the box cannot map:
  /// the API records the attendance and the court stays dark (review #12). A
  /// box with no court list is not ready to ask.
  uint8_t courtCount = 0U;
  /// devlink::ApiBreaker says the API is down. Asking costs a 4 s connect
  /// timeout per scan and answers nothing; the roster answers in microseconds.
  bool apiDown = false;
  /// This box already acted on the scanned v1 code inside its window
  /// (memcode::knownReplay). Not a question for the API: a box that lit a court
  /// OFFLINE and whose link came back before its queued activation was uploaded
  /// would otherwise ask a server that has not heard of the first use, and have
  /// a photo of the same code acted on again (refuted 2026-09-28). The roster
  /// path refuses it as the replay it is — CODE USED, arming nothing.
  bool knownReplay = false;
};

/// What to do with the API's answer.
struct ActivationResult {
  /// The API produced no decision. Decide from the roster.
  bool fallbackToRoster = false;
  /// The court was lit and the scan is spent: forget it. (The button window
  /// itself is bridgelogic::AuthPolicy's, which keeps it armed for the member
  /// who just lit the court so their OFF button works.)
  bool disarmAuth = false;
  /// A recognised member with nothing to light — `no_booking` or `ended`.
  /// The glass invites a walk-up (PICK A COURT / THEN A TIME) after the
  /// greeting rather than sending them to the desk (bridge 2.3.0).
  bool invitesWalkUp = false;
  /// What to paint and, on a grant, which relay to drive for how long.
  court::Outcome outcome;
  /// On a grant: seconds to the end of the chained run, uncapped
  /// (`play_remaining_seconds`, or granted_seconds on a pre-v3 server).
  uint32_t playRemainingSeconds = 0U;
};

/// The relay cap in minutes, for display.
inline constexpr uint32_t kMaxDisplayMinutes = static_cast<uint32_t>(proto::kRelayHardCapSeconds) / 60U;

/// `grantedMinutes`, or the relay cap, whichever is smaller. The Mega clamps
/// the relay to ninety minutes whatever the API sold, so the screen must not
/// promise more than the lights will deliver (review M1).
uint32_t displayMinutes(uint32_t grantedMinutes);

/// Relay index for `courtNumber` within this box's `court_numbers`. False when
/// this box does not drive that court.
bool relayForCourtNumber(int16_t courtNumber, const int16_t courtNumbers[devlink::kMaxCourts],
                         uint8_t courtCount, uint8_t& relay);

/// True when `outcome` lit a court, on ANY path — online, roster or walk-up —
/// and the scan behind it is therefore spent: forget it and close the Mega's
/// button window. A refusal leaves the scan live so the member can still buy
/// time with the buttons.
bool spendsScan(const court::Outcome& outcome);

/// Whether the scan behind `outcome` may still buy anything at the buttons — a
/// walk-up, or a pay-for. False for a court it lit (spendsScan) AND for every
/// scan nobody vouched for: a code the server already acted on (`code_used` —
/// possibly a photo of the code that just lit somebody's court), a code nobody
/// owns, a refusal this build cannot name, a stale roster. Such a scan is
/// forgotten as well as disarmed, so nothing behind the Mega's window can ever
/// send it as a buyer (review round 8, D8-1).
bool scanStaysBuyable(const court::Outcome& outcome);

/// True — with `out` filled — when a roster decision would re-light a court
/// this box already believes is lit, and must not.
///
/// The roster has no idea whether a court is on: it holds bookings, and a
/// booking stays "allowed" for its whole window. So a member who scans again
/// ten minutes into their own game — because the screen has moved on, or
/// because they are showing a partner how it works — was re-granted from the
/// roster, which sent a second `!ON` (re-arming the relay from now, silently
/// extending the court past its slot) and queued a second Activation event for
/// one booking. Two attendance events for one game is a duplicate the API
/// deduplicates on `seq` and not on meaning, and the second `!ON`'s duration is
/// whatever is left of the booking measured from the RESCAN.
///
/// The online path is untouched: an API grant is the API's decision, made with
/// the booking in front of it, and this half does not second-guess one.
///
/// The member is told what is true — the court is on — and the button window is
/// armed and bound to that court so their OFF press still works.
bool regrantsHeldCourt(const roster::Decision& decision, const HeldState held[kStateCourts],
                       court::Outcome& out);

/// Renders the activate request body. Returns the length, or 0 when it would
/// not fit — never a truncated body, which would be a request for a different
/// token. The field order is the corpus's (`http/cases.json`, the
/// `activate-request` vector).
///
/// `mac` is how the request names this box; a body without it names no device
/// and is refused. It is 12 lowercase hex characters with no separators —
/// upper case or colons are a different string to the server, and the symptom
/// is a box that authenticates fine and activates nothing.
///
/// A v1 member code (memcode::looksLikeV1) also carries `scan_age_ms` — how
/// long ago the scanner read it — LAST, so the server verifies its ON half at
/// the instant it was read (docs/specs/member-code.md §5). A legacy code's body
/// is byte-for-byte the one the server has always been sent.
size_t renderActivateBody(char* out, size_t cap, const char* mac, const char* token, uint32_t scanAgeMs = 0U);

/// The buffer the bridge renders an activate body into. A constant here rather
/// than a literal in main.cpp so the host suite renders into the SAME size: the
/// longest body is a 24-byte scan of bytes the escaper writes six for one —
/// 191 bytes and its terminator.
inline constexpr size_t kActivateBodyCap = 224U;

/// Room for a scan of up to proto::kMaxArgLen bytes once escaped, terminator
/// included.
inline constexpr size_t kEscapedScanCap = proto::kMaxArgLen * devapi::json::kMaxEscapeExpansion + 1U;

/// Writes the scanned `token` as the CONTENTS of a JSON string into `out`
/// (R15 D15-1). False, with `out` emptied, when it does not fit.
///
/// ESCAPED, NOT INTERPOLATED. The Mega's assembler passes every byte the
/// scanner sent — a quote, a backslash, anything above 0x7F — and the
/// activate, walk-up and pay-for bodies all put the token in with a bare `%s`.
/// A quote ended the string and let a printed code rewrite the fields around
/// it; a lone 0xE9 was invalid UTF-8. The server could parse neither and
/// answered 500. The one escaper is devapi::json::escapeInto, so these three
/// bodies and the event subject cannot disagree about what a scan looks like.
bool escapeScan(const char* token, char* out, size_t cap);

/// The decision core. Stateless; every input is an argument so the host suite
/// can drive each branch without a socket.
/// Why a scan the roster had to decide got no decision from the server
/// (BR-08, MCV1-08). A valid member the roster does not know — a walk-up
/// member, a v1 code with nothing booked here, a key the ring shed — is not an
/// unknown code, and NOT RECOGNISED / SEE THE DESK told them it was.
enum class OnlineMiss : uint8_t {
  /// Not asked: no WiFi, the breaker open, or no courts mapped.
  NotAsked = 0U,
  /// Asked, and nothing answered (status 0: connect, timeout, budget).
  Unreachable = 1U,
  /// Asked, and the server could not decide: 429, a 5xx, or a 2xx this box
  /// could not read whole. Scanning again in a moment works.
  Busy = 2U,
  /// Asked, and refused for a reason about the BOX (401, 403, 404, ...).
  Refused = 3U,
};

/// The miss for an `/activate` that gave no decision, from its status.
OnlineMiss missFor(uint16_t status);

/// Rewrites a roster refusal that would read NOT RECOGNISED into what is true
/// when the server could not be heard: NO CONNECTION / BOOKINGS ONLY offline,
/// BUSY / SCAN AGAIN when the server was too busy, SEE THE DESK for a box the
/// server refused. Only for an UNRECOGNISED refusal whose scan `couldBeMember`
/// (a legacy token the roster does not hold, a verified v1 code with nothing
/// booked here, or a v1 code with no key): a replay, a throttle, a wrong v1
/// code and a stale roster keep their own words. Never arms anything — the
/// outcome stays unrecognised. True when the lines changed.
bool explainNoDecision(court::Outcome& outcome, OnlineMiss miss, bool couldBeMember);

/// An online grant onto a court this box ALREADY had lit before the grant:
/// the member's own rescan of their game (FSF-06, MCV1-02). It keeps the scan
/// buyable — the member rescanned to extend, and spending the scan on the
/// re-grant looped every court press on SCAN TO EXTEND — and the caller puts
/// the extend prompt up for that court. The server claims no court use for a
/// repeat activation of the session in play (member-code.md, MCV1-02).
bool regrantsLitCourt(const court::Outcome& outcome, bool courtWasLit);

inline constexpr char kBookingsOnlyLine1[] = "NO CONNECTION";
inline constexpr char kBookingsOnlyLine2[] = "BOOKINGS ONLY";
inline constexpr char kServerBusyLine1[] = "BUSY";
inline constexpr char kServerBusyLine2[] = "SCAN AGAIN";

class ScanFlow {
public:
  /// Online only when every precondition for a call the server will accept AND
  /// act on holds: linked, at least one court mapped, and the API not currently
  /// judged down. Anything less is the roster's scan.
  Attempt onScan(const LinkState& link) const;

  /// Interprets the activate response.
  ///
  ///   200 + activated:true   → TurnOn on the relay `court_number` maps to,
  ///                            for `granted_seconds` display-clamped to the
  ///                            relay cap; disarmAuth. A court this box does
  ///                            not drive is refused — no fallback, the API
  ///                            has already recorded the activation. A grant
  ///                            of ZERO seconds is a refusal ("SLOT ENDED"):
  ///                            the wire's one-second floor would turn it into
  ///                            a relay pulse and a spent scan.
  ///   200 + activated:false  → Refuse with a line per `reason`; no fallback.
  ///                            `recognised` (which arms the buttons) only for
  ///                            a known member whose code is unused: no_booking,
  ///                            wrong_court, too_early, insufficient_balance,
  ///                            not_chargeable, ended. Never for code_used,
  ///                            not_recognised, an unknown or missing reason
  ///                            (review round 8, D8-1). `ended`
  ///                            — stamped, nothing left to light — is the same
  ///                            SLOT ENDED as a zero-second grant, and is a
  ///                            decision: the roster would light it.
  ///   200 with no grant      → fallback (malformed).
  ///   anything else          → fallback. A 401 is included: DeviceClient::react
  ///                            has already handled the clock, and THIS scan
  ///                            got no decision.
  ActivationResult onActivateResponse(uint16_t status, const char* body, size_t len,
                                      const int16_t courtNumbers[devlink::kMaxCourts],
                                      uint8_t courtCount) const;
};

} // namespace bridgelogic

#endif // CRUSADERS_BRIDGELOGIC_SCANFLOW_H
