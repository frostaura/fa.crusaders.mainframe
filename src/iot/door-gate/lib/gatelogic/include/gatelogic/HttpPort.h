// Crusaders Mainframe — one POST to the device API, minus the socket.
//
// WHY THIS PORT EXISTS WHEN THE COURT BRIDGE HAS NONE
// ---------------------------------------------------
// The court bridge makes its calls from `callApi()` inside main.cpp, which
// `pio test -e native` cannot see (`build_src_filter = -<*>`). That is why its
// event-body renderer had a 64-bit bug nothing could reach for three reviews:
// the one place the wrap mattered was the one place no test ran. The gate's
// scan flow is the same shape of code — "ask, and interpret what came back" —
// and it is the code path a member is standing in front of, so it goes behind a
// port and is driven by a fake that can answer 0, 401, 429, 503 and a 200 with
// the body half-written.
//
// WHY IT IS HERE AND NOT IN shared/lib/hal
// ----------------------------------------
// The test for shared/lib is not "could a second device want this", it is
// "would a second device want it UNCHANGED" — and the only other device there
// is makes its calls without a port at all. Promoting this the day a third
// firmware wants exactly this signature is one `git mv`; promoting it now would
// put a port in the shared library on the strength of one user.
//
// No Arduino headers, no heap, no String. Compiles for Xtensa and the host.

#ifndef CRUSADERS_GATELOGIC_HTTPPORT_H
#define CRUSADERS_GATELOGIC_HTTPPORT_H

#include <stddef.h>
#include <stdint.h>

namespace gatelogic {

/// What one POST did.
///
/// TWO STATUSES, AND THE SECOND ONE EXISTS FOR EXACTLY ONE READER.
///
/// `status` is what every decision on this board is made from. `peerStatus` is
/// what the server actually said before the body was judged, and the only thing
/// that reads it is the heartbeat's `no_push` counter — which is the one place
/// where "the server answered and the body was unusable" and "nothing came
/// back at all" are different events. That distinction was LOST in round G2:
/// the body reader collapsed both to 0, `adoptHeartbeat` returned early on a 0,
/// and the diagnostic that exists to scream about an unusable roster push
/// became the quietest path in the firmware.
///
/// Nothing else may branch on `peerStatus`. A refusal the board could not read
/// the body of is not a refusal the board may act on — that asymmetry is the
/// whole safety argument in GateFlow.h — and this struct is not a way around
/// it.
///
/// A plain aggregate with no default member initialisers: the generated sketch
/// compiles at gnu++11, where an NSDMI would stop `HttpOutcome{a, b}` being
/// valid aggregate initialisation.
struct HttpOutcome {
  /// The peer's status, or 0 when the request never completed — no route, no
  /// host, a refused connection, a timeout — OR when its body did not arrive
  /// whole. 0 is not an error code to be mapped onto one: it is the one answer
  /// that says nothing at all about what the server thinks, which is exactly
  /// what the breaker counts and what sends a scan to the roster.
  uint16_t status;

  /// What the peer answered, whatever then happened to the body. 0 when it
  /// never answered.
  uint16_t peerStatus;
};

/// A request the server answered and whose body this board could not use.
constexpr bool bodyFailed(const HttpOutcome& outcome) {
  return outcome.peerStatus != 0U && outcome.status == 0U;
}

/// The outcome of a call that never left this board.
constexpr HttpOutcome noCall() {
  return HttpOutcome{0U, 0U};
}

class IHttpPort {
public:
  virtual ~IHttpPort() = default;

  /// POST `body` as JSON to `path` under the API base URL, with the bearer
  /// header the implementation holds.
  ///
  /// The response body is copied into `out` and NUL-terminated. NEVER
  /// truncated: one that does not fit, does not arrive whole, or does not
  /// parse is reported as `status` 0 — a transport failure — because
  /// `{"opened":true,` cut after the comma is a door that opens. A caller
  /// buffer rather than a String because the ESP32's heap is shared with the
  /// network stack, and a call four times a minute that allocates is a heap
  /// that fragments over a season in a cupboard.
  virtual HttpOutcome post(const char* path, const char* body, char* out, size_t outCap) = 0;
};

} // namespace gatelogic

#endif // CRUSADERS_GATELOGIC_HTTPPORT_H
