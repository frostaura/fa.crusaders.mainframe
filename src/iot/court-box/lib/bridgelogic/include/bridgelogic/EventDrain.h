// Crusaders Mainframe — the court box's event drain, out of main.cpp.
//
// WHY THIS IS NOT IN main.cpp ANY MORE
// ------------------------------------
// It was, and `pio test -e native` cannot see main.cpp (`build_src_filter =
// -<*>`). What that hid (review round 16, D16-2): every post that left the
// head event where it was — a 401, 403, 408, 429, a 5xx the breaker had not
// yet tripped on, or a 200 whose `accepted_through` missed the head — was
// re-posted on the very next pass. A box the club had DISABLED is answered 403
// in about five milliseconds, so it posted its `boot` event a couple of hundred
// times a second for ever; the club's whole device budget is 120 requests a
// minute, so every other box and the door gate were then answered 429 too, and
// each of THEM began re-posting on every pass. The breaker never helped: it
// counts only a call that never completed or a 5xx, because a 4xx and a 429
// mean the API is there.
//
// The door gate met the same hot loop in round G2 and its cure is ported here
// rather than shared: GateApp's drain also commits an empty roster on a 403,
// which is a door rule, and the gate's binary must not move for a court-box
// finding. The pace below is the gate's, number for number — see
// memory/decisions-door-gate-loop.md.
//
// No Arduino headers, no heap. Compiles for Xtensa and the host.

#ifndef CRUSADERS_BRIDGELOGIC_EVENTDRAIN_H
#define CRUSADERS_BRIDGELOGIC_EVENTDRAIN_H

#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "hal/Clock.h"

#include "devapi/Json.h"
#include "devlink/EventUpload.h"
#include "eventq/Event.h"
#include "timebase/TimeBase.h"

namespace bridgelogic {

/// WHERE THE DRAIN'S BACKOFF STARTS, AND WHERE THE DOUBLING STOPS.
///
/// Fifteen seconds is short enough that a rate limiter lifting is noticed
/// inside one heartbeat interval; five minutes is long enough that a box that
/// is refused for ever costs twelve requests an hour instead of seven hundred
/// thousand. Anything that actually MOVES the queue clears it. The door gate's
/// own numbers (gatelogic::kEventRetryStartMs / kEventRetryMaxMs).
inline constexpr uint32_t kEventRetryStartMs = 15000UL;
inline constexpr uint32_t kEventRetryMaxMs = 300000UL;

static_assert(kEventRetryStartMs > 0U && kEventRetryStartMs <= kEventRetryMaxMs,
              "the event backoff must start somewhere at or below its own cap");

/// What one `/api/v1/device/events` answer does to the head event.
enum class EventOutcome : uint8_t {
  /// 2xx: release everything at or below the body's `accepted_through`.
  Release,
  /// A 4xx this box caused: drop the head so the next event gets a turn.
  Drop,
  /// Transient, or a statement about the whole box rather than this event:
  /// keep it and offer it again — at the backoff's pace.
  Keep,
};

/// The rule, status by status. 2xx → Release. 0, 401, 403, 404, 408, 429 and
/// 5xx → Keep. Any other 4xx → Drop.
EventOutcome eventOutcome(uint16_t status);

/// The drain's pace: disarmed on a healthy box, armed by every post that left
/// the head event exactly where it was.
class DrainPace {
public:
  /// True when the drain may post now. Disarms an elapsed window so a deadline
  /// left armed across the 24.8-day half of the uint32 range cannot read as
  /// pending again.
  bool ready(uint32_t nowMs);

  /// Records one settled post. `queueMoved` is whether the ring got SHORTER —
  /// not what the server said. `settledAtMs` is a clock read taken AFTER the
  /// call returned.
  void settle(bool queueMoved, uint32_t settledAtMs);

  /// The window the last refusal armed; 0 on a healthy box. Diagnostics.
  uint32_t backoffMs() const { return backoffMs_; }

private:
  tb::Deadline at_;
  uint32_t backoffMs_ = 0U;
};

/// Who is uploading: the batch-level fields `renderEventBody` takes.
struct DrainSource {
  const char* mac = nullptr;
  uint32_t bootId = 0U;
  uint64_t uptimeMs = 0U;
};

/// One step of the drain, at most one post. `post(body, response, cap)` makes
/// the call and returns its HTTP status (0 for none). Returns true when a post
/// was made.
///
/// The caller checks the link and the breaker; this checks the pace and the
/// queue, renders the head, posts it, applies the answer and settles the pace.
template <typename Queue, typename Post>
bool pumpEventDrain(Queue& queue, DrainPace& pace, const DrainSource& source, hal::IClock& clock,
                    Post&& post) {
  if (!pace.ready(clock.nowMs()) || queue.empty()) {
    return false;
  }

  // One event per pass. A board back from a week offline has a full ring, and
  // draining it all in one loop iteration would starve the Mega link — which
  // is how a flooded uplink becomes a court whose lights stay on.
  eventq::Event event;
  if (!queue.peek(event)) {
    return false;
  }

  char body[devlink::kEventBodyCap];
  if (devlink::renderEventBody(body, sizeof(body), source.mac, source.bootId, source.uptimeMs, event) == 0U) {
    // Unrenderable. The caps make this unreachable, but KEEPING it would pin
    // every later event behind it forever and the box would stop reporting
    // attendance at all.
    static_cast<void>(queue.release());
    return false;
  }

  char response[192] = {};
  const uint16_t held = queue.size();
  const uint16_t status = post(static_cast<const char*>(body), response, sizeof(response));
  switch (eventOutcome(status)) {
  case EventOutcome::Release: {
    uint32_t through = 0U;
    if (devapi::json::topLevelUnsignedField(response, strlen(response), "accepted_through", through)) {
      static_cast<void>(queue.releaseThrough(through));
    }
    break;
  }
  case EventOutcome::Drop:
    static_cast<void>(queue.release());
    break;
  case EventOutcome::Keep:
    break;
  }

  // DID THE QUEUE ACTUALLY MOVE? Not "what did the server say": a 200 whose
  // `accepted_through` misses the head leaves it exactly where a 429 does. A
  // FRESH clock read, because the call may just have spent its whole timeout,
  // and a window armed from before it would start that much in the past.
  pace.settle(queue.size() < held, clock.nowMs());
  return true;
}

} // namespace bridgelogic

#endif // CRUSADERS_BRIDGELOGIC_EVENTDRAIN_H
