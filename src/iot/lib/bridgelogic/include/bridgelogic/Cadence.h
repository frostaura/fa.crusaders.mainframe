// Crusaders Mainframe — the heartbeat interval the API asked for.
//
// The tenant setting `heartbeat_seconds` was served on every heartbeat and
// read by nothing; the box heartbeated every thirty seconds whatever an admin
// set, and the admin screen's default (60) did not even match the firmware's
// (30). The interval is adopted here, bounded: below kMinHeartbeatMs a fleet
// hammers the API and its own UART with 4 s blocking calls; above
// kMaxHeartbeatMs the roster ages and an OTA offer takes minutes to reach a
// box. An absent or unreadable field leaves the interval where it was.
//
// No Arduino headers, no heap.

#ifndef CRUSADERS_BRIDGELOGIC_CADENCE_H
#define CRUSADERS_BRIDGELOGIC_CADENCE_H

#include <stddef.h>
#include <stdint.h>

namespace bridgelogic {

inline constexpr uint32_t kMinHeartbeatMs = 15000UL;
inline constexpr uint32_t kMaxHeartbeatMs = 300000UL;

/// Reads `heartbeat_seconds` out of a heartbeat response into `intervalMs`,
/// clamped into [kMinHeartbeatMs, kMaxHeartbeatMs]. False, with `intervalMs`
/// untouched, when the field is absent or not a bare integer.
bool parseHeartbeatInterval(const char* body, size_t len, uint32_t& intervalMs);

} // namespace bridgelogic

#endif // CRUSADERS_BRIDGELOGIC_CADENCE_H
