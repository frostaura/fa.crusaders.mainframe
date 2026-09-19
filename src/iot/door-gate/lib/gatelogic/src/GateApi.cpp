#include "gatelogic/GateApi.h"

#include <string.h>

#include "gatelogic/GateHeartbeat.h"

namespace gatelogic {

HttpOutcome GateApi::post(const char* path, const char* body, char* out, size_t outCap) {
  if (body == nullptr || body[0] == '\0') {
    // An unrenderable body. Refused here rather than sent as something the
    // server has to reject — and it teaches the breaker nothing, because it
    // says nothing about whether the host is reachable.
    return noCall();
  }
  if (out != nullptr && outCap > 0U) {
    out[0] = '\0';
  }
  const HttpOutcome outcome = http_.post(path, body, out, outCap);
  // TAUGHT FROM `status`, NOT FROM `peerStatus`. A 200 whose body did not
  // arrive is a call this board learned nothing from, and the breaker exists to
  // count exactly those.
  //
  // A fresh clock read: the call may have just spent its whole timeout, and a
  // backoff window that starts four seconds in the past is four seconds short.
  breaker_.onResult(outcome.status, clock_.nowMs());
  return outcome;
}

ScanDecision GateApi::scan(const char* mac, const char* token, uint32_t adoptedUnlockMs, uint32_t hardCapMs) {
  char body[kScanBodyCap] = {};
  if (renderScanBody(body, sizeof(body), mac, token) == 0U) {
    // Nothing went on the wire, so nothing was decided. The roster gets it,
    // which is the same answer as an unreachable host.
    ScanDecision decision;
    decision.fallbackToRoster = true;
    return decision;
  }

  char response[kScanResponseCap] = {};
  const HttpOutcome outcome = post(kPathGate, body, response, sizeof(response));
  // `status`, deliberately: a 200 whose body this board could not read is not a
  // decision anybody may act on, and it goes to the roster.
  return onGateResponse(outcome.status, response, strlen(response), adoptedUnlockMs, hardCapMs);
}

HttpOutcome GateApi::heartbeat(const char* mac, const char* firmwareVersion, uint64_t uptimeMs,
                               const GateDiagnostics& diagnostics, char* out, size_t outCap) {
  char body[kGateHeartbeatBodyCap] = {};
  if (renderGateHeartbeatBody(body, sizeof(body), mac, firmwareVersion, uptimeMs, diagnostics) == 0U) {
    return noCall();
  }
  return post(kPathHeartbeat, body, out, outCap);
}

uint16_t GateApi::uploadEvent(const char* body, char* out, size_t outCap) {
  return post(kPathEvents, body, out, outCap).status;
}

} // namespace gatelogic
