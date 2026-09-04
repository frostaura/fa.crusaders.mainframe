// Crusaders Mainframe — retrying an `!ON` the Mega did not take.
//
// The link is 9600 baud beside four relay coils, and the Mega answers a frame
// whose checksum did not survive it with `!ERR,BADCRC` — or, for a line that
// overran its buffer, `!EVT,OVERRUN,RX`. The bridge counted those and did
// nothing. For a `!LCD` that is a missed repaint; for the `!ON` that lights a
// paid court it is a member on a dark court with a screen saying "COURT B 45
// MIN", and a `!STATE` two seconds later synthesising a Release for a session
// that never started.
//
// So the last `!ON` is kept, and when the Mega reports a receive error inside
// kRetryWindowMs of it, it is sent ONCE more. Once, not until acknowledged: a
// second failure is a cable, not a transient, and a loop of ONs on a broken
// link is a loop of ONs. Inside the window, not any time: an error arriving
// later than the reconcile grace cannot be about this frame, and re-sending an
// ON for a court that was since released would be lights nobody asked for.
//
// No Arduino headers, no heap. Compiles for Xtensa and the host.

#ifndef CRUSADERS_BRIDGELOGIC_ONRETRY_H
#define CRUSADERS_BRIDGELOGIC_ONRETRY_H

#include <stdint.h>

#include "protocol/Protocol.h"
#include "timebase/TimeBase.h"

namespace bridgelogic {

/// How long after an `!ON` a receive error from the Mega is taken to be about
/// it. A frame is ~20 ms on the wire and the Mega answers within a pass; this
/// is generous, and it is shorter than the reconcile grace on purpose so the
/// retry lands before a `!STATE` could be acted on.
inline constexpr uint32_t kRetryWindowMs = 1500UL;

/// True for the uplink reports that mean "your last line did not decode":
/// `!ERR,BADCRC` and `!EVT,OVERRUN,RX`. `name` and `detail` are the frame's
/// two arguments. `!EVT,OVERRUN,TX` is the Mega reporting a drop on ITS way
/// out, which says nothing about what it received, and does not count.
bool isReceiveError(proto::Verb verb, const char* name, const char* detail);

class OnRetry {
public:
  /// An `!ON` left the bridge at `nowMs`. Kept for one retry.
  void sent(const proto::Frame& on, uint32_t nowMs);

  /// The Mega reported a receive error at `nowMs`. True — with `out` set to
  /// the frame to re-send — exactly once per remembered `!ON`, and only inside
  /// the window. False otherwise.
  bool shouldResend(uint32_t nowMs, proto::Frame& out);

  /// Forget the remembered frame: the court was released, or the retry was
  /// spent. Idempotent.
  void clear();

  bool pending() const { return window_.isArmed(); }

  /// Retries sent since boot. Diagnostics: a climbing count is a cable.
  uint16_t retries() const { return retries_; }

private:
  proto::Frame frame_;
  tb::Deadline window_;
  uint16_t retries_ = 0U;
};

} // namespace bridgelogic

#endif // CRUSADERS_BRIDGELOGIC_ONRETRY_H
