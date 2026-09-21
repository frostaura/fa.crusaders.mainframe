// Crusaders Mainframe — what a scan at a court means.
//
// WHERE THIS SITS
// ---------------
// The Mega turns a barcode into a `!SCAN` frame and knows nothing else. The API
// knows everything and is not reachable when it matters most. This is the layer
// in between: it decides, locally and in a few microseconds, whether the lights
// come on — then records what it decided so the club finds out.
//
// WHY THE DECISION IS LOCAL AND THE ACCOUNTING IS NOT
// ---------------------------------------------------
// A member scanning expects lights, not a spinner. Putting an HTTPS round trip
// on that path makes every activation depend on a consumer router and turns a
// DNS stall into a member standing in the dark. So the box decides from the
// roster cache and queues an event; the money is settled by the API when it
// hears about it, which under charge-at-booking has already happened anyway —
// the debit was taken when the booking was made, and this event is what stops
// the no-show sweep reversing it.
//
// That last point is the one worth holding on to. **A queued activation event
// is not a charge. It is the evidence that stops a refund.** A court lit and
// never reported looks exactly like a member who did not turn up.
//
// WHY EVERY REFUSAL SAYS SOMETHING DIFFERENT
// ------------------------------------------
// The display is a character LCD and the member is standing in a corridor.
// "DENIED" sends them to the desk for every one of five unrelated reasons;
// "COURT B NOT C" sends them ten metres down the corridor and "TOO EARLY" tells
// them to wait. The verdict enum exists so the box can be specific, and the
// strings are here rather than in main.cpp so the host suite can assert on them.
//
// The panel is twenty columns by four rows, with a sixteen-by-two SAFE SUBSET —
// see kLineLen below. Rows 0-1 clipped at sixteen must still read as a whole
// message, so the extra room buys enrichment and never carries the verdict.
//
// No Arduino headers, no heap, no String. Compiles for AVR, Xtensa and the host.

#ifndef CRUSADERS_COURT_SESSION_H
#define CRUSADERS_COURT_SESSION_H

#include <stddef.h>
#include <stdint.h>

#include "hal/Display.h"

#include "eventq/Event.h"
#include "eventq/EventQueue.h"
#include "protocol/Protocol.h"
#include "roster/Roster.h"

namespace court {

/// The display's width plus a terminator — the width hal::IDisplayPort will pad
/// or clip to.
///
/// DERIVED, not 16. It was hardcoded, so the panel's geometry lived in two
/// places that could disagree: the flags said how wide the glass was and this
/// said how much text the box was willing to compose for it. On the 2004A that
/// is actually fitted, the second number won and four columns of every line
/// were unreachable.
///
/// The SAFE-SUBSET CONTRACT is what makes widening this safe, and it is not
/// optional: **rows 0 and 1, truncated at column 16, must still be a complete
/// and correct message on every screen.** A 1602 fitted by mistake then
/// degrades to exactly the old behaviour rather than to a half-sentence, which
/// is the property hal/Display.h chose 16x2 for in the first place. The test
/// that enforces it is in the bridge's suite, over every screen at once.
inline constexpr size_t kLineLen = static_cast<size_t>(hal::kDisplayCols);

/// The columns a 1602 would show. Rows 0-1 clipped here must still read as a
/// whole message; columns beyond it, and rows 2-3, carry enrichment only.
///
/// The number lives in hal/Display.h, beside the geometry it qualifies: both
/// the half that composes the text and the half that paints it have to agree
/// about it, and neither may depend on the other's library.
inline constexpr size_t kSafeSubsetCols = static_cast<size_t>(hal::kSafeSubsetCols);

static_assert(kLineLen >= kSafeSubsetCols,
              "a panel narrower than the 16-column safe subset would make the contract "
              "unsatisfiable rather than merely degraded");

/// The longest grant this layer will hand out, in milliseconds: the relay hard
/// cap. The Mega clamps the wire duration to the same number, so a grant past
/// it would light the court for 90 minutes while the display promised more —
/// clamping HERE is what makes the screen, the event and the relay agree.
inline constexpr uint32_t kMaxGrantMs = static_cast<uint32_t>(proto::kRelayHardCapSeconds) * 1000UL;

/// `ms`, or the cap, whichever is smaller.
constexpr uint32_t clampGrantMs(uint32_t ms) {
  return ms > kMaxGrantMs ? kMaxGrantMs : ms;
}

/// What the box should do next.
enum class Action : uint8_t {
  /// Send `!ON` for `court`, for `durationMs`.
  TurnOn = 0U,
  /// Show the lines and do nothing else.
  Refuse = 1U,
};

struct Outcome {
  Action action = Action::Refuse;
  uint8_t court = 0U;
  uint32_t durationMs = 0U;

  /// True when the scan IDENTIFIED somebody — the roster matched an entry
  /// (allowed, too early, too late or wrong court alike) or the API answered
  /// with a verdict about a known member. False for a token nobody knows and
  /// for a stale roster, which knows nothing. bridgelogic::AuthPolicy arms the
  /// Mega's button window on this bit and on nothing else: buttons for a scan
  /// nobody recognised were thirty seconds of relay control for any barcode.
  bool recognised = false;

  /// On a grant, what is LEFT of the booking before the relay cap was applied
  /// — `durationMs` is clamped to ninety minutes because that is all one `!ON`
  /// can buy, and this is the number that says whether the court will need an
  /// `!EXT` before the cap runs out. Equal to durationMs when nothing was
  /// clamped; zero on a refusal.
  uint32_t bookingRemainingMs = 0U;

  /// What to paint. Always both lines, always NUL-terminated, never longer than
  /// kLineLen — a court box that shows nothing after a refused scan is a court
  /// box the member scans again.
  char line1[kLineLen + 1U] = {};
  char line2[kLineLen + 1U] = {};

  /// The event that was queued, for a caller that wants to log or count it.
  /// Every outcome produces one: a refusal the club never hears about is a
  /// member complaining about something with no record.
  uint32_t eventSeq = 0U;

  /// False when the event could not be queued at all. The lights still come on
  /// — refusing to open a court because a queue is full would be punishing the
  /// member for the box's problem — but the club will not learn about this one.
  bool recorded = true;
};

/// Decides scans, and records every decision.
///
/// Templated on the roster and queue types so their capacities stay compile-time
/// facts chosen at the composition root, and so the host suite can drive tiny
/// ones. Neither is owned; both outlive this by construction.
template <typename RosterT, typename QueueT> class Session {
public:
  Session(RosterT& roster, QueueT& queue) : roster_(roster), queue_(queue) {}

  /// A member presented `token` at `court` — a box with a scanner per court.
  Outcome onScan(const char* token, uint8_t court, eventq::Method method, uint32_t nowMs);

  /// A member presented `token` at the box's ONE scanner, which serves the
  /// first `courts.value` relays. The court comes from the matched roster
  /// entry, never from the scan: a barcode that could name its own court would
  /// be a barcode that opens any court in the club.
  Outcome onScan(const char* token, roster::CourtCount courts, eventq::Method method, uint32_t nowMs);

  /// A court's lights went out — the Mega's timer expired, or somebody pressed
  /// off. Recorded so the club can see how long the court was actually used,
  /// which is the number a dispute about a 45-minute booking turns on.
  Outcome onRelease(uint8_t court, uint32_t heldMs, uint32_t nowMs);

  /// The box started. One event, so an unexplained gap in the sequence has an
  /// explanation next to it.
  void onBoot(uint32_t nowMs);

private:
  Outcome record(Outcome outcome, eventq::Event& event);

  /// Turns a roster decision into an outcome and an event. `fallbackCourt` is
  /// what the outcome and the event carry when NO entry matched — the scanned-at
  /// court for the per-court overload, eventq::Event::kNoCourt for the shared
  /// scanner, which has no court to attribute an unknown token to.
  Outcome applyDecision(const roster::Decision& decision, const char* token, uint8_t fallbackCourt,
                        eventq::Method method, uint32_t nowMs);

  RosterT& roster_;
  QueueT& queue_;
};

namespace detail {

/// True for the verdicts that carry a matched entry — the ones whose court is
/// the ENTRY's court, not the caller's.
constexpr bool matchedAnEntry(roster::Verdict verdict) {
  return verdict == roster::Verdict::Allow || verdict == roster::Verdict::TooEarly ||
         verdict == roster::Verdict::TooLate || verdict == roster::Verdict::WrongCourt;
}

/// Copies at most kLineLen characters and terminates. Silently clips, because
/// a display line is the one place where truncation is the correct answer.
void setLine(char* dest, const char* text);

/// Renders "IN 12 MIN" / "45 MIN LEFT" style text into a line.
void setLineWithMinutes(char* dest, const char* prefix, uint32_t ms, const char* suffix);

/// The two lines for a verdict. `court` is 0-3 and renders as A-D.
void linesFor(roster::Verdict verdict, const roster::Entry& entry, uint8_t court, uint32_t ageMs, char* line1,
              char* line2);

} // namespace detail

// --- implementation ---------------------------------------------------------

template <typename RosterT, typename QueueT>
Outcome Session<RosterT, QueueT>::record(Outcome outcome, eventq::Event& event) {
  // The caller's uptimeMs stands. This used to zero it, one line after onScan and
  // onRelease had each set it to nowMs — and EventQueue::push assigns only `seq`,
  // so nothing put it back. Every activation and release therefore went up as
  // "uptime_ms": 0.
  //
  // That is not cosmetic. The API stamps an event against the server clock by
  // subtracting its uptime from the box's uptime now (see eventq::Event), so a
  // zero says "this happened at boot" — on a box that has been up forty days, a
  // wall-clock time forty days in the past. Attendance is what stops the no-show
  // sweep reversing a charge, so it lands on the money path.
  //
  // onBoot never went through here and kept its value, which is what shows this
  // was a slip rather than a convention.
  const eventq::PushResult pushed = queue_.push(event);
  if (pushed == eventq::PushResult::Rejected) {
    outcome.recorded = false;
    return outcome;
  }
  outcome.eventSeq = event.seq;
  return outcome;
}

template <typename RosterT, typename QueueT>
Outcome Session<RosterT, QueueT>::onScan(const char* token, uint8_t court, eventq::Method method,
                                         uint32_t nowMs) {
  return applyDecision(roster_.decide(token, court, nowMs), token, court, method, nowMs);
}

template <typename RosterT, typename QueueT>
Outcome Session<RosterT, QueueT>::onScan(const char* token, roster::CourtCount courts, eventq::Method method,
                                         uint32_t nowMs) {
  return applyDecision(roster_.decide(token, courts, nowMs), token, eventq::Event::kNoCourt, method, nowMs);
}

template <typename RosterT, typename QueueT>
Outcome Session<RosterT, QueueT>::applyDecision(const roster::Decision& decision, const char* token,
                                                uint8_t fallbackCourt, eventq::Method method,
                                                uint32_t nowMs) {
  // THE COURT IS THE ENTRY'S, WHENEVER THERE IS ONE.
  //
  // This used to be the caller's court unconditionally — set before the lines
  // were rendered and set AGAIN after record() — so on a box whose single
  // scanner serves four relays, `!ON` always went to the relay the caller
  // guessed, whatever booking had actually matched (review C4). The entry
  // carries the court the API booked; that is the relay to drive.
  const bool matched = detail::matchedAnEntry(decision.verdict);
  const uint8_t court = matched ? decision.entry.court : fallbackCourt;

  Outcome outcome;
  outcome.court = court;
  outcome.recognised = matched;
  detail::linesFor(decision.verdict, decision.entry, court, roster_.ageMs(nowMs), outcome.line1,
                   outcome.line2);

  eventq::Event event;
  event.uptimeMs = nowMs;
  event.court = court;
  event.method = method;

  if (decision.verdict == roster::Verdict::Allow) {
    // What is LEFT of the booking, capped at what the relay will honour. The
    // display, the event and the wire duration all take this one number.
    const uint32_t grantMs = clampGrantMs(decision.grantMs);
    outcome.action = Action::TurnOn;
    outcome.durationMs = grantMs;
    outcome.bookingRemainingMs = decision.grantMs;
    detail::setLineWithMinutes(outcome.line2, "", grantMs, " MIN");

    event.kind = eventq::Kind::Activation;
    event.durationMs = grantMs;
    // The roster's token, not the scanned bytes. They are equal by construction
    // here, and taking the stored one means a scanner that appends a stray
    // character cannot put it in the ledger reference.
    static_cast<void>(event.setSubject(decision.entry.token));
  } else {
    outcome.action = Action::Refuse;
    event.kind = eventq::Kind::UnknownScan;
    // The presented token, deliberately: a refused scan is only worth recording
    // if it says WHAT was presented. Truncation is tolerated here — this field
    // is a diagnostic, not a charge reference.
    static_cast<void>(event.setSubject(token));
  }

  outcome = record(outcome, event);
  outcome.court = court;
  return outcome;
}

template <typename RosterT, typename QueueT>
Outcome Session<RosterT, QueueT>::onRelease(uint8_t court, uint32_t heldMs, uint32_t nowMs) {
  Outcome outcome;
  outcome.action = Action::Refuse; // nothing to switch on; the lights are already out
  outcome.court = court;
  detail::setLine(outcome.line1, "CRUSADERS COURTS");
  detail::setLine(outcome.line2, "SCAN TO START");

  eventq::Event event;
  event.uptimeMs = nowMs;
  event.kind = eventq::Kind::Release;
  event.court = court;
  event.durationMs = heldMs;

  outcome = record(outcome, event);
  outcome.court = court;
  return outcome;
}

template <typename RosterT, typename QueueT> void Session<RosterT, QueueT>::onBoot(uint32_t nowMs) {
  eventq::Event event;
  event.uptimeMs = nowMs;
  event.kind = eventq::Kind::Boot;
  event.court = eventq::Event::kNoCourt;
  static_cast<void>(queue_.push(event));
}

} // namespace court

#endif // CRUSADERS_COURT_SESSION_H
