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
  // A fresh clock read: the call may have just spent its whole timeout, and a
  // backoff window that starts four seconds in the past is four seconds short.
  // The fault below is stamped from the same instant, for the same reason.
  const uint32_t now = clock_.nowMs();
  // TAUGHT FROM `status`, NOT FROM `peerStatus`. A 200 whose body did not
  // arrive is a call this board learned nothing from, and the breaker exists to
  // count exactly those.
  breaker_.onResult(outcome.status, now);
  recordHttpFault(outcome, now);
  return outcome;
}

void GateApi::recordHttpFault(const HttpOutcome& outcome, uint32_t nowMs) {
  if (outcome.peerStatus == 0U) {
    // Nothing came back at all: no route, no host, a refused connection or a
    // timeout. One code for all of them, because from here they are one thing
    // — this board could not reach the API — and telling them apart would need
    // detail no `IHttpPort` reports.
    faults_.record(kFaultHttpTimeout, nowMs);
    return;
  }
  if (outcome.peerStatus >= 500U) {
    faults_.record(kFaultHttp5xx, nowMs);
    return;
  }
  if (outcome.peerStatus >= 400U) {
    faults_.record(kFaultHttp4xx, nowMs);
    return;
  }
  if (bodyFailed(outcome)) {
    // The server answered and the BODY did not arrive whole — a peer that hung
    // up, malformed chunk framing, or a body that did not fit. That is a
    // transport failure with a 200 on it, and it is counted as one.
    faults_.record(kFaultHttpTimeout, nowMs);
  }
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
