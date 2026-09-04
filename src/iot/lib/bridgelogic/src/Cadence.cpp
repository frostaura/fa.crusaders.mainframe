#include "bridgelogic/Cadence.h"

#include "devapi/Json.h"

namespace bridgelogic {

bool parseHeartbeatInterval(const char* body, size_t len, uint32_t& intervalMs) {
  uint32_t seconds = 0U;
  if (!devapi::json::unsignedField(body, len, "heartbeat_seconds", seconds)) {
    return false;
  }
  // Clamp in seconds first so the multiply cannot wrap a huge value into a
  // small one.
  const uint32_t maxSeconds = kMaxHeartbeatMs / 1000U;
  const uint32_t minSeconds = kMinHeartbeatMs / 1000U;
  const uint32_t bounded = seconds > maxSeconds ? maxSeconds : (seconds < minSeconds ? minSeconds : seconds);
  intervalMs = bounded * 1000U;
  return true;
}

} // namespace bridgelogic
