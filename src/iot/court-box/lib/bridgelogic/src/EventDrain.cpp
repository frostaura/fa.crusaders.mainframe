#include "bridgelogic/EventDrain.h"

#include "devapi/DeviceClient.h"

namespace bridgelogic {

EventOutcome eventOutcome(uint16_t status) {
  if (status == 404U) {
    // A 404 ON `/events` IS NOT A REJECTION, and `devapi::react` — shared, and
    // right for a request this box got wrong — says it is. On this route the
    // API answers 404 for one reason: it does not know this MAC, because the
    // console deleted the box's row. The next heartbeat registers it again and
    // the same event is then accepted, so dropping it threw an evening's
    // attendance away (review round 16, D16-3). The other way to get one — a
    // proxy route that does not reach the API — is an outage a person fixes,
    // and wants the event kept too. The door gate's rule since round G3.
    return EventOutcome::Keep;
  }

  switch (devapi::react(status)) {
  case devapi::Reaction::Accepted:
    return EventOutcome::Release;
  case devapi::Reaction::Rejected:
    return EventOutcome::Drop;
  case devapi::Reaction::Retry:
    return EventOutcome::Keep;
  }
  return EventOutcome::Keep;
}

bool DrainPace::ready(uint32_t nowMs) {
  if (at_.remaining(nowMs) > 0U) {
    return false;
  }
  // Elapsed (or never armed). Disarmed here rather than left to age: an armed
  // deadline more than 2^31 ms in the past reads as pending again, and a box
  // that drained nothing for 25 days would then wait up to one more window.
  // `backoffMs_` is kept, so the next refusal still doubles from it.
  at_.disarm();
  return true;
}

void DrainPace::settle(bool queueMoved, uint32_t settledAtMs) {
  if (queueMoved) {
    // Progress. Back to the loop's own pace at once, so a rate limiter lifting
    // does not leave a healthy box posting once every five minutes for the
    // rest of the evening.
    backoffMs_ = 0U;
    at_.disarm();
    return;
  }

  backoffMs_ = (backoffMs_ == 0U)                      ? kEventRetryStartMs
               : (backoffMs_ >= kEventRetryMaxMs / 2U) ? kEventRetryMaxMs
                                                       : backoffMs_ * 2U;
  at_.arm(settledAtMs, backoffMs_);
}

} // namespace bridgelogic
