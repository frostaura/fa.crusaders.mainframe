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
// The display is 16x2 and the member is standing in a corridor. "DENIED" sends
// them to the desk for every one of five unrelated reasons; "COURT B NOT C"
// sends them ten metres down the corridor and "TOO EARLY" tells them to wait.
// The verdict enum exists so the box can be specific, and the strings are here
// rather than in main.cpp so the host suite can assert on them.
//
// No Arduino headers, no heap, no String. Compiles for AVR, Xtensa and the host.

#ifndef CRUSADERS_COURT_SESSION_H
#define CRUSADERS_COURT_SESSION_H

#include <stddef.h>
#include <stdint.h>

#include "eventq/Event.h"
#include "eventq/EventQueue.h"
#include "roster/Roster.h"

namespace court {

/// Exactly 16 characters plus a terminator: the display's width, and the width
/// hal::IDisplayPort will pad or clip to.
inline constexpr size_t kLineLen = 16U;

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

  /// A member presented `token` at `court`.
  Outcome onScan(const char* token, uint8_t court, eventq::Method method, uint32_t nowMs);

  /// A court's lights went out — the Mega's timer expired, or somebody pressed
  /// off. Recorded so the club can see how long the court was actually used,
  /// which is the number a dispute about a 45-minute booking turns on.
  Outcome onRelease(uint8_t court, uint32_t heldMs, uint32_t nowMs);

  /// The box started. One event, so an unexplained gap in the sequence has an
  /// explanation next to it.
  void onBoot(uint32_t nowMs);

private:
  Outcome record(Outcome outcome, eventq::Event& event);

  RosterT& roster_;
  QueueT& queue_;
};

namespace detail {

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
  const roster::Decision decision = roster_.decide(token, court, nowMs);

  Outcome outcome;
  outcome.court = court;
  detail::linesFor(decision.verdict, decision.entry, court, roster_.ageMs(nowMs), outcome.line1,
                   outcome.line2);

  eventq::Event event;
  event.uptimeMs = nowMs;
  event.court = court;
  event.method = method;

  if (decision.verdict == roster::Verdict::Allow) {
    outcome.action = Action::TurnOn;
    outcome.durationMs = decision.entry.durationMs;

    event.kind = eventq::Kind::Activation;
    event.durationMs = decision.entry.durationMs;
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
