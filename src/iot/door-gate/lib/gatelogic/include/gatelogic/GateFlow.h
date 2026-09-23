// Crusaders Mainframe — what happens when somebody scans at a door.
//
// ONLINE FIRST, FOR THE SAME REASON THE COURT BOX IS
// --------------------------------------------------
// Only the API knows about a booking made thirty seconds ago, a member barred
// this morning, or a 60-second `MemberIdent` code that was never in any roster.
// So a gate that can reach the API asks it, and the answer is final.
//
// AND THE DOOR STILL WORKS WHEN THE NETWORK DOES NOT
// --------------------------------------------------
// When the API cannot be asked, the scan is decided here from the roster the
// heartbeat filled, in microseconds, and the gate queues what it did. A router
// reboot is a slower scan, not a club nobody can get into. The degraded mode is
// narrower than the court box's and the contract says so out loud: offline,
// only a member with a rostered booking gets in. A walk-up member's 60-second
// code can never be in a roster, so offline they go to the desk.
//
// THE ONE PLACE THIS DIFFERS FROM THE COURT BRIDGE, AND IT MATTERS
// ----------------------------------------------------------------
// The bridge maps a response through devapi::react(), whose `Rejected` class
// means "a 4xx the box caused — drop it". For a DOOR that mapping is wrong:
// almost every status says the board learned nothing about this member, so 0,
// 401, 404, 408, 429, every 5xx and a 200 whose body cannot be read all fall
// back to the roster. A 200 is an authoritative answer — and a 200 that says
// `opened:false` is authoritative too, so it is NEVER second-guessed against
// the roster. That asymmetry is the whole safety argument:
//
//   * treating a refusal as an outage would let a member the club barred this
//     morning in through a booking the club has not cancelled;
//   * treating an outage as a refusal would leave a member with a valid booking
//     outside in the rain because a container was restarting.
//
// 403 IS THE SECOND AUTHORITATIVE ANSWER
// --------------------------------------
// A 403 on `/gate` is not an outage and not a fault this board can fix: it is
// the club having taken this board OUT OF SERVICE in the admin console. Falling
// back to the roster after one would keep the door admitting rostered members
// for six hours after an admin pressed the button that was supposed to stop
// exactly that — which is the whole point of the button. So a 403 denies, and
// the roster never gets a turn.
//
// THE RESIDUAL, STATED HONESTLY: a board that cannot REACH the server never
// hears the 403 at all. It keeps admitting rostered bookings until its roster
// goes stale at ROSTER_MAX_AGE_MS. Taking a door out of service is therefore
// not instantaneous for a board that is offline, and nothing in this firmware
// can make it so.
//
// WHAT GETS QUEUED
// ----------------
// Only what the API does not already know. An open the API granted is in the
// API's own audit trail; queueing it would file every entry twice. An open this
// board decided from its roster is `gate_open`; a refusal it decided from its
// roster is `unknown_scan`. Neither ever touches attendance — walking through a
// door is not playing a booking.
//
// No Arduino headers, no heap, no String. Compiles for Xtensa and the host.

#ifndef CRUSADERS_GATELOGIC_GATEFLOW_H
#define CRUSADERS_GATELOGIC_GATEFLOW_H

#include <stddef.h>
#include <stdint.h>

#include "eventq/Event.h"
#include "gatelogic/ApiBaseUrl.h"
#include "gatelogic/GateConfig.h"
#include "gatelogic/StaticText.h"
#include "memcode/Token.h"
#include "memcode/Verifier.h"
#include "roster/Roster.h"

namespace gatelogic {

/// The three endpoints this firmware posts to. Constants rather than literals
/// at the call sites, so the corpus can assert the paths as well as the bodies:
/// a correct body at a wrong path is a 404 that reads exactly like an outage.
inline constexpr char kPathHeartbeat[] = "/api/v1/device/heartbeat";
inline constexpr char kPathGate[] = "/api/v1/device/gate";
inline constexpr char kPathEvents[] = "/api/v1/device/events";

/// A fourth endpoint may not outgrow the buffer the base URL and the path are
/// concatenated into. `Esp32HttpPort::post` returns 0 — "the request never
/// completed" — when the two do not fit, which on a door reads as an outage and
/// sends every scan to the roster.
static_assert(text::length(kPathHeartbeat) <= kMaxPathLen && text::length(kPathGate) <= kMaxPathLen &&
                  text::length(kPathEvents) <= kMaxPathLen,
              "a device path is longer than kMaxPathLen, which sizes the URL buffer");

/// The smallest buffer renderScanBody is ever given: three keys, a 12-hex MAC
/// and a token bounded by roster::kMaxTokenLen — ESCAPED, which is up to six
/// bytes per character (round G4, B1). 20 x 6 = 120 for the token alone.
///
/// The assembler refuses bytes outside the roster's alphabet now, so nothing a
/// real scan produces expands at all; the budget is here because the renderer
/// must be safe against its caller rather than because of it.
inline constexpr size_t kScanBodyCap = 192U;

/// The longest `reason` the contract defines is `method_not_supported` (21).
inline constexpr size_t kMaxReasonLen = 24U;

/// A `/gate` response is four short fields. Static at the call site, like every
/// other response buffer on this board.
inline constexpr size_t kScanResponseCap = 128U;

/// Reasons this BOARD decides, in the server's vocabulary where one fits.
///
/// `ok` and `not_recognised` are the contract's own words, used here so the
/// same refusal reads the same way whoever decided it. The three roster ones
/// have no server equivalent — the server never answers "your booking has not
/// opened yet", it answers `no_booking` — and they exist for the LED, the logs
/// and the tests rather than for the wire. Nothing sends these anywhere.
inline constexpr char kReasonOk[] = "ok";
inline constexpr char kReasonNotRecognised[] = "not_recognised";
inline constexpr char kReasonTooEarly[] = "too_early";
inline constexpr char kReasonTooLate[] = "too_late";
inline constexpr char kReasonRosterStale[] = "roster_stale";

/// The club took this board out of service. Decided by the BOARD, from a 403,
/// because the server sends no body it could read one out of.
inline constexpr char kReasonOutOfService[] = "out_of_service";

/// THE LOCK HAS NOT FINISHED RELATCHING. The one refusal here that is not about
/// the member at all — see UnlockTimer.h and round G4's A1. It is a distinct
/// word rather than `not_recognised` because a desk reading a trail full of
/// these is reading "somebody is holding this door open", which is a different
/// conversation from "somebody's code does not work".
inline constexpr char kReasonRelocking[] = "relocking";

/// THIS BOARD IS BEING ASKED FASTER THAN IT WILL ASK THE SERVER. The other
/// refusal that is not about the member — see `kMinScanCallSpacingMs` and round
/// G4's A2. Distinct from `relocking` because they say different things to a
/// desk: one is a door being held open, this is a door being hammered.
inline constexpr char kReasonTooFast[] = "too_fast";

static_assert(text::length(kReasonOutOfService) <= kMaxReasonLen &&
                  text::length(kReasonRelocking) <= kMaxReasonLen &&
                  text::length(kReasonTooFast) <= kMaxReasonLen,
              "a reason longer than the buffer reads as an empty reason at the door");

/// A single rotating member code this board has already opened the door for,
/// presented again inside its window — a photo of somebody's screen, or the
/// member's own second scan inside one step. Decided by the board, offline only:
/// online the server's use table answers, in its own vocabulary (`code_used`).
inline constexpr char kReasonReplayed[] = "replayed";

// A v1 member code transits this board's scanner line, which is bounded by the
// roster's token cap: a code longer than that is one the door could never read.
// Nineteen against twenty; this is where the two meet.
static_assert(memcode::kTokenLen <= roster::kMaxTokenLen,
              "a v1 member code must fit the scanner line the roster's token cap bounds");

/// Whether to ask the API at all.
enum class Attempt : uint8_t {
  /// The radio is associated and the breaker is closed. Ask.
  Online = 0U,
  /// No link, or the breaker says the host is not there. Do not spend four
  /// seconds in a connect timeout with a member standing at the door — the
  /// roster answers in microseconds.
  RosterOnly = 1U,
};

Attempt chooseAttempt(bool wifiUp, bool apiDown);

/// What the board decided, and what it owes the API afterwards.
struct ScanDecision {
  /// True when nothing was decided and the caller must ask the roster. Set
  /// only by the online path, and never by a 200.
  bool fallbackToRoster = false;

  /// Release the lock.
  bool released = false;

  /// For how long, already clamped. Zero for every refusal.
  uint32_t unlockMs = 0U;

  /// Why, for the LED and the logs. NUL-terminated, never truncated silently:
  /// a reason longer than the buffer reads as an empty reason rather than as a
  /// different one.
  char reason[kMaxReasonLen + 1U] = {};

  /// True when the API does not already know about this, so the board has to
  /// tell it later.
  bool queueEvent = false;

  /// THE CLUB TOOK THIS BOARD OUT OF SERVICE, said on the scan path.
  ///
  /// Carried as a flag rather than inferred from `reason`, because the caller
  /// has to act on it — it EMPTIES THE ROSTER, exactly as the same word on the
  /// heartbeat and the event drain does. Denying only this scan would leave the
  /// roster intact, so the next link drop is a door admitting every rostered
  /// member again; and the scan path is often the first one a board speaks on
  /// after an admin presses the button.
  bool outOfService = false;

  /// THIS REFUSAL IS "IN A MOMENT", NOT "NO".
  ///
  /// Set only by the two relock-dwell paths. Every other refusal is a decision
  /// about the MEMBER — a code that is not for today, a membership the club
  /// suspended, a board taken out of service — and the thing to do about it is
  /// to go and find somebody. This one is a decision about the LOCK: it is a
  /// few hundred milliseconds of guaranteed dark time so the strike relatches,
  /// and the thing to do about it is scan again. The lamp is the only channel
  /// a door gate has, so the two must not look the same on it.
  ///
  /// A flag rather than a comparison against `reason`, for the same reason
  /// `outOfService` is one: a caller that had to match a string would be a
  /// caller that silently stops matching the day the word changes, and what it
  /// would fall back to is the refusal blink — the exact bug this closes.
  bool askedToWait = false;

  /// Only meaningful when queueEvent. GateOpen for an open this board decided,
  /// UnknownScan for a refusal it decided.
  eventq::Kind eventKind = eventq::Kind::UnknownScan;
};

/// Renders the `/api/v1/device/gate` body: `{"mac":…,"method":"qr","token":…}`.
///
/// `method` is always `qr`. The board has one scanner and cannot tell a phone's
/// QR code from the same characters typed into a keypad it does not have; the
/// server's `code` method exists for surfaces that can.
///
/// Returns the length written, or 0 with `out` empty — never a truncated body.
size_t renderScanBody(char* out, size_t cap, const char* mac, const char* token);

/// Interprets a `/gate` response.
///
/// TWO statuses are answers and everything else is an outage: a 200, whose body
/// carries the decision, and a 403, which is the club having taken this board
/// out of service and is a refusal with no roster second-guess.
///
/// `adoptedUnlockMs` is what the last heartbeat said, used when a 200 opens the
/// door without naming a duration. `hardCapMs` bounds whatever comes back.
ScanDecision onGateResponse(uint16_t status, const char* body, size_t len, uint32_t adoptedUnlockMs,
                            uint32_t hardCapMs);

/// Turns a roster verdict into the same decision shape. Called only on the
/// fallback path, which is why everything it returns is queued: if the board is
/// deciding for itself, the API by definition does not know.
///
/// The door is released for the ADOPTED unlock time, not for what is left of
/// the booking. A door is released for long enough to walk through; the
/// booking's remaining minutes are the court's business, not the lock's.
ScanDecision fromRoster(const roster::Decision& decision, uint32_t adoptedUnlockMs, uint32_t hardCapMs);

/// The OFFLINE decision for a scan that looks like a v1 member code
/// (docs/specs/member-code.md §6). A code this board cannot hold in a roster —
/// it changes every thirty seconds — is VERIFIED instead: `status` is what
/// memcode::verify said, and for Ok `decision` is the roster's answer for the
/// REF it proved, through the REF lists, so an accepted partner opens the door
/// exactly as the organiser does and on the same window rules.
///
///   Ok        -> fromRoster(decision): ok / too_early / too_late / roster_stale
///   Replayed  -> refused, `replayed`
///   NoClock   -> refused, `roster_stale` — the step is judged at the roster's age
///   otherwise -> refused, `not_recognised`
///
/// Everything is queued, as every roster decision is: the API heard nothing.
/// The caller records the use in its replay ring only if the lock was actually
/// given time — a relocking refusal opened nothing and consumed nothing.
ScanDecision fromMemberCode(memcode::Status status, const roster::Decision& decision,
                            uint32_t adoptedUnlockMs, uint32_t hardCapMs);

/// A door's offline answer to a v1 code, and the verdict behind it — whose REF
/// and which step the caller records as used once the lock was given time.
struct OfflineCodeDecision {
  ScanDecision decision;
  memcode::Verdict verdict;
};

/// The whole offline question for a v1 code, in one call the host suite and
/// GateApp share: verify it, and if it proved a member, ask the roster's REF
/// lists about them.
template <class RosterT, class KeysT, class UsesT>
OfflineCodeDecision
decideOfflineMemberCode(const char* token, const memcode::OfflineCodes<KeysT, UsesT>& codes,
                        const RosterT& cache, uint32_t adoptedUnlockMs, uint32_t hardCapMs, uint32_t nowMs) {
  OfflineCodeDecision out;
  out.verdict = memcode::verify(token, codes, nowMs);
  roster::Decision booked;
  if (out.verdict.status == memcode::Status::Ok) {
    booked = cache.decideMember(out.verdict.token.refText, roster::CourtCount(1U), nowMs);
  }
  out.decision = fromMemberCode(out.verdict.status, booked, adoptedUnlockMs, hardCapMs);
  return out;
}

/// A scan this board will not put on the wire: a line longer than the token cap.
///
/// The bytes were discarded without truncation — a token cut short matches a
/// different member — so there is nothing to ask the API about and nothing to
/// match in the roster. `offline` decides only whether the refusal is queued,
/// on the same rule as a roster refusal: while the API can be reached it can
/// see for itself that nothing was asked.
///
/// `offline` is the SAME judgement a scan makes — `chooseAttempt(...) ==
/// Attempt::RosterOnly`, the radio AND the breaker — not just the radio. A
/// board whose breaker has opened cannot reach the API either, and asking only
/// about the radio queued nothing while the host was down, which is the one
/// window in which an unreadable scan is worth knowing about.
ScanDecision refuseUnreadable(bool offline);

/// A scan this board cannot honour because its own lock is still relatching.
///
/// Round G4's A1. Refused BEFORE the API is asked, on exactly the debounce's
/// precedent — "not a decision, not an API call, not an audit row, and not a
/// re-armed lock" — for two reasons. A 200 answering `opened` would put a door
/// opening in the server's audit trail that did not happen, which is a worse
/// record than none; and spending a whole blocking call to be told yes about a
/// door that cannot open is spending the pass on nothing.
///
/// `offline` decides only whether the refusal is QUEUED, on the same rule as
/// every other refusal the board decides for itself: while the API can be
/// reached it can see for itself that nothing was asked.
ScanDecision refuseRelocking(bool offline);

/// A scan refused because this board will not ask the server again yet.
///
/// Round G4's A2. The debounce bounds REPEATS and cannot bound a stream of
/// tokens it has never seen; this is the bound that does not care what the
/// token is. Refused rather than answered from the ROSTER, deliberately: the
/// roster does not know about a membership barred this morning, so answering a
/// rate-limited scan from it would be this board's own throttle opening a door
/// the API would have refused. A refusal is recoverable — the scanner repeats
/// while a code is presented — and the other direction is not.
ScanDecision refuseTooFast(bool offline);

/// Rewrites a decision that wanted the door open into the relocking refusal.
///
/// The second half of A1's fix, and not redundant with the first: the pass that
/// CLOSES a window is very often the same pass that applies the decision a
/// blocking call inside it produced (`afterBlocking()` pumps the lock, and the
/// decision lands two lines later), so a scan can be decided before the dwell
/// exists and applied after it does. A decision left saying `released` would
/// queue a `gate_open` for a door that never moved.
void markRelocking(ScanDecision& decision);

} // namespace gatelogic

#endif // CRUSADERS_GATELOGIC_GATEFLOW_H
