// Crusaders Mainframe — the three calls this board makes, above the socket.
//
// WHY THIS IS A LIBRARY AND NOT THREE FUNCTIONS IN main.cpp
// ---------------------------------------------------------
// That is exactly where the court bridge put them, and `pio test -e native`
// cannot see main.cpp — `build_src_filter = -<*>`. The cost is on the record:
// the bridge's event body printed two 64-bit uptimes through a 32-bit cast for
// three reviews, because the one place the millis() wrap mattered was the one
// place no test could reach.
//
// So the sequence — render the body, post it, teach the breaker what happened,
// interpret the answer — lives here, behind IHttpPort, where a fake can answer
// 0, 401, 429, 503, a 200 with a truncated body, and a 200 that takes four
// seconds to arrive.
//
// WHY THE CLOCK IS READ AGAIN AFTER THE CALL
// ------------------------------------------
// post() blocks for up to the HTTP timeout. A breaker taught with the instant
// the call STARTED has its backoff window already four seconds old, and a lock
// deadline stamped from before the call is four seconds short of what the
// member was granted. Every instant that matters is sampled after the call
// returns, which is why this needs a clock at all.
//
// No Arduino headers, no heap, no String. Compiles for Xtensa and the host.

#ifndef CRUSADERS_GATELOGIC_GATEAPI_H
#define CRUSADERS_GATELOGIC_GATEAPI_H

#include <stddef.h>
#include <stdint.h>

#include "hal/Clock.h"

#include "devlink/ApiBreaker.h"
#include "gatelogic/GateFlow.h"
#include "gatelogic/HttpPort.h"

namespace gatelogic {

class GateApi {
public:
  GateApi(IHttpPort& http, devlink::ApiBreaker& breaker, hal::IClock& clock)
      : http_(http), breaker_(breaker), clock_(clock) {}

  /// Ask the API about one scan and interpret the answer.
  ///
  /// Never returns a decision the caller has to second-guess: either it decided
  /// (`fallbackToRoster` false) or it says so, and the caller asks the roster
  /// with a FRESH clock read.
  ScanDecision scan(const char* mac, const char* token, uint32_t adoptedUnlockMs, uint32_t hardCapMs);

  /// Heartbeat. The response lands in `out`; the status is returned so the
  /// caller can decide whether to adopt anything from it.
  ///
  /// `noPush` is the diagnostic counter of accepted heartbeats that carried no
  /// usable roster. Omitted from the body when it is zero — see
  /// GateHeartbeat.h for why it exists and why it is not a lamp pattern.
  uint16_t heartbeat(const char* mac, const char* firmwareVersion, uint64_t uptimeMs, uint32_t noPush,
                     char* out, size_t outCap);

  /// One already-rendered event-upload body. Rendered by the caller because
  /// devlink owns that shape and every firmware renders it identically.
  uint16_t uploadEvent(const char* body, char* out, size_t outCap);

private:
  /// The one place a call reaches the socket, and the one place the breaker is
  /// taught. A call that never left — an unrenderable body — teaches it
  /// nothing: it says nothing about whether the host is there.
  uint16_t post(const char* path, const char* body, char* out, size_t outCap);

  IHttpPort& http_;
  devlink::ApiBreaker& breaker_;
  hal::IClock& clock_;
};

} // namespace gatelogic

#endif // CRUSADERS_GATELOGIC_GATEAPI_H
