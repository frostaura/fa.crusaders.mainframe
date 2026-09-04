// Crusaders Mainframe — what the bridge does with a scan: ask the API first,
// fall back to the roster only when the API could not be asked.
//
// WHY THERE IS AN ONLINE PATH AT ALL
// ----------------------------------
// The roster is a cache of NEAR-FUTURE bookings, pushed every heartbeat. It is
// what keeps a court working through a router reboot, and it cannot answer
// three things the API can: a booking made in the last thirty seconds, a
// walk-up member with no booking, and whether a member with too little credit
// may be let on. So a scan on a box that can reach the API asks the API, and
// the API's answer is final — the roster is consulted only when there was no
// answer, never to second-guess one (review C3).
//
// The distinction that matters: a REFUSAL from the API ("no booking", "wrong
// court") is a decision, and the roster does not get a second opinion. A
// TRANSPORT failure (no route, a 5xx, a rate limit, a 401 the client is already
// correcting its clock over, a 200 with no grant in it) is the absence of a
// decision, and the roster decides as it always did.
//
// WHY AN ONLINE GRANT QUEUES NO EVENT
// -----------------------------------
// The event queue is the record of what the API did NOT hear. An activation the
// API itself granted is one it has already recorded; queuing it again would
// double-report attendance for every online scan. The roster path still queues,
// because on that path the API has heard nothing.
//
// WHY THE RESULT CARRIES A "DISARM AUTH" BIT
// ------------------------------------------
// A scan arms the Mega's button window for thirty seconds so the member can buy
// time or release the court. Once their court is lit that window is SPENT: the
// next person to walk up must not get thirty seconds of buttons on the previous
// member's identity. The decision lives here so a host test can pin it.
//
// The rule is the same whichever path lit the court. The online grant carried
// the bit and the roster grant did not (review H1): a box with no link lit the
// court and left the window armed, and the next walk-up was thirty seconds of
// buttons on a stranger's token. `spendsScan` is the one rule for both, and the
// online path's bit is pinned to agree with it.
//
// No Arduino headers, no heap, no String. Compiles for Xtensa and the host.

#ifndef CRUSADERS_BRIDGELOGIC_SCANFLOW_H
#define CRUSADERS_BRIDGELOGIC_SCANFLOW_H

#include <stddef.h>
#include <stdint.h>

#include "bridgelogic/RosterSync.h"
#include "court/Session.h"

namespace bridgelogic {

/// Which path a scan takes.
enum class Attempt : uint8_t {
  /// Ask `/api/v1/device/activate`; the roster only if that yields no decision.
  Online = 0U,
  /// Decide from the roster cache. The API is not reachable, or could not be
  /// asked correctly — an unsynchronised clock signs a request the server will
  /// refuse for skew, which would read as a decision when it is not one.
  RosterOnly = 1U,
};

/// What the bridge knows about its link when the scan arrives.
struct LinkState {
  bool provisioned = false;
  bool wifiUp = false;
  bool clockKnown = false;
};

/// What to do with the API's answer.
struct ActivationResult {
  /// The API produced no decision. Decide from the roster.
  bool fallbackToRoster = false;
  /// The court was lit: close the button window and forget the scan.
  bool disarmAuth = false;
  /// What to paint and, on a grant, which relay to drive for how long.
  court::Outcome outcome;
};

/// The relay cap in minutes, for display.
inline constexpr uint32_t kMaxDisplayMinutes = static_cast<uint32_t>(proto::kRelayHardCapSeconds) / 60U;

/// `grantedMinutes`, or the relay cap, whichever is smaller. The Mega clamps
/// the relay to ninety minutes whatever the API sold, so the screen must not
/// promise more than the lights will deliver (review M1).
uint32_t displayMinutes(uint32_t grantedMinutes);

/// Relay index for `courtNumber` within this box's `court_numbers`. False when
/// this box does not drive that court.
bool relayForCourtNumber(int16_t courtNumber, const int16_t courtNumbers[kMaxCourts], uint8_t courtCount,
                         uint8_t& relay);

/// True when `outcome` lit a court, on ANY path — online, roster or walk-up —
/// and the scan behind it is therefore spent: forget it and close the Mega's
/// button window. A refusal leaves the scan live so the member can still buy
/// time with the buttons.
bool spendsScan(const court::Outcome& outcome);

/// Renders the activate request body. Returns the length, or 0 when it would
/// not fit — never a truncated body, which would be a request for a different
/// token. The field order is the corpus's (`http/cases.json`, the
/// `/api/v1/device/activate` request): the signature covers these exact bytes.
size_t renderActivateBody(char* out, size_t cap, const char* token);

/// The decision core. Stateless; every input is an argument so the host suite
/// can drive each branch without a socket.
class ScanFlow {
public:
  /// Online only when every precondition for a SIGNED call that the server
  /// will accept holds. Anything less is the roster's scan.
  Attempt onScan(const LinkState& link) const;

  /// Interprets the activate response.
  ///
  ///   200 + activated:true   → TurnOn on the relay `court_number` maps to,
  ///                            for `granted_seconds` display-clamped to the
  ///                            relay cap; disarmAuth. A court this box does
  ///                            not drive is refused — no fallback, the API
  ///                            has already recorded the activation.
  ///   200 + activated:false  → Refuse with a line per `reason`; no fallback.
  ///   200 with no grant      → fallback (malformed).
  ///   anything else          → fallback. A 401 is included: DeviceClient::react
  ///                            has already handled the clock, and THIS scan
  ///                            got no decision.
  ActivationResult onActivateResponse(uint16_t status, const char* body, size_t len,
                                      const int16_t courtNumbers[kMaxCourts], uint8_t courtCount) const;
};

} // namespace bridgelogic

#endif // CRUSADERS_BRIDGELOGIC_SCANFLOW_H
