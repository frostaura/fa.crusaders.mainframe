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
#include "gatelogic/GateHeartbeat.h"
#include "gatelogic/HttpPort.h"

namespace gatelogic {

class GateApi {
public:
  /// `faults` is a REFERENCE and not an optional pointer, unlike
  /// `IDecisionLog`: every board has one, and `post()` below is the ONLY place
  /// in this firmware where an HTTP status is seen for all three routes. A
  /// composition root that could forget it would be a board whose `http_5xx`
  /// count was silently always zero — which is indistinguishable from a healthy
  /// board, and is the exact failure mode every counter here exists to end.
  GateApi(IHttpPort& http, devlink::ApiBreaker& breaker, hal::IClock& clock, FaultLog& faults)
      : http_(http), breaker_(breaker), clock_(clock), faults_(faults) {}

  /// Ask the API about one scan and interpret the answer.
  ///
  /// Never returns a decision the caller has to second-guess: either it decided
  /// (`fallbackToRoster` false) or it says so, and the caller asks the roster
  /// with a FRESH clock read.
  ScanDecision scan(const char* mac, const char* token, uint32_t adoptedUnlockMs, uint32_t hardCapMs);

  /// Heartbeat. The response lands in `out`.
  ///
  /// RETURNS THE WHOLE OUTCOME, not just the status, because this is the one
  /// caller that needs to tell "the server answered and its body was unusable"
  /// apart from "nothing came back": the first is what `no_push` counts and the
  /// second is not. See HttpOutcome.
  ///
  /// `diagnostics` are the two since-boot counters that ride in the request,
  /// each omitted from the body when it is zero — see GateHeartbeat.h for why
  /// they exist and why neither is a lamp pattern.
  HttpOutcome heartbeat(const char* mac, const char* firmwareVersion, uint64_t uptimeMs,
                        const GateDiagnostics& diagnostics, char* out, size_t outCap);

  /// The 2.0.0 heartbeat, with the v3 fields and telemetry (device-api.md §2),
  /// rendered into a static kGateHeartbeatRequestCap buffer: 1.5 KB is too
  /// much to put on the loop task's stack under a blocking call.
  HttpOutcome heartbeatV3(const char* mac, const char* firmwareVersion, uint64_t uptimeMs,
                          const GateDiagnostics& counters, const GateReport& report, char* out, size_t outCap);

  /// Called between a 401 and its retry with the other key: the caller kicks
  /// the watchdog and re-checks the lock, exactly as around any blocking call.
  class IBetweenCalls {
  public:
    virtual ~IBetweenCalls() = default;
    virtual void betweenCalls() = 0;
  };

  /// The device keys (§6). With them, a 401 is retried once with the other key
  /// the board holds. Without them (a host test that does not care), a 401 is
  /// just a 401.
  void useKeys(class GateKeys* keys, IBetweenCalls* between) {
    keys_ = keys;
    between_ = between;
  }

  /// Retries made with the other key since boot. For the host suite.
  uint32_t keyRetries() const { return keyRetries_; }

  /// One already-rendered event-upload body. Rendered by the caller because
  /// devlink owns that shape and every firmware renders it identically.
  uint16_t uploadEvent(const char* body, char* out, size_t outCap);

private:
  /// The one place a call reaches the socket, and the one place the breaker is
  /// taught. A call that never left — an unrenderable body — teaches it
  /// nothing: it says nothing about whether the host is there.
  HttpOutcome post(const char* path, const char* body, char* out, size_t outCap);

  /// One transport-shaped fault per completed call, from ONE place.
  ///
  /// Classified off `peerStatus` rather than `status`, because `peerStatus` is
  /// the field that MEANS "what the peer said" and the classification is a
  /// question about the peer. A call that never left this board is not
  /// classified at all: it says nothing about the host.
  ///
  /// THE TWO FIELDS GIVE THE SAME ANSWER TODAY, and that is said plainly rather
  /// than left to imply coverage this has not got. `statusForBody` keeps any
  /// status at or above `kFirstStatusThatSpeaksForItself` through a failed body
  /// read and zeroes everything below it, so there is no outcome on which the
  /// two disagree and a swap of one for the other is an EQUIVALENT mutant that
  /// no test can kill. `peerStatus` is kept so the classification stays correct
  /// if that carve-out ever moves; the test pins the carve-out itself.
  void recordHttpFault(const HttpOutcome& outcome, uint32_t nowMs);

  class GateKeys* keys_ = nullptr;
  IBetweenCalls* between_ = nullptr;
  uint32_t keyRetries_ = 0U;
  IHttpPort& http_;
  devlink::ApiBreaker& breaker_;
  hal::IClock& clock_;
  FaultLog& faults_;
};

} // namespace gatelogic

#endif // CRUSADERS_GATELOGIC_GATEAPI_H
