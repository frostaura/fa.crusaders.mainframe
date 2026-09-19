#include "gatelogic/GateHeartbeat.h"

#include <stdio.h>

#include "devapi/Json.h"
#include "timebase/TimeBase.h"

namespace gatelogic {

uint32_t clampUnlockMs(uint32_t requestedMs, uint32_t hardCapMs) {
  const uint32_t cap = hardCapMs < kMinUnlockMs ? kMinUnlockMs : hardCapMs;
  if (requestedMs < kMinUnlockMs) {
    return kMinUnlockMs;
  }
  return requestedMs > cap ? cap : requestedMs;
}

uint32_t unlockMsFromSeconds(uint32_t seconds, uint32_t hardCapMs) {
  const uint32_t cap = hardCapMs < kMinUnlockMs ? kMinUnlockMs : hardCapMs;
  const uint32_t maxSeconds = cap / 1000UL;
  const uint32_t minSeconds = kMinUnlockMs / 1000UL;
  const uint32_t bounded = seconds > maxSeconds ? maxSeconds : (seconds < minSeconds ? minSeconds : seconds);
  return bounded * 1000UL;
}

size_t renderGateHeartbeatBody(char* out, size_t cap, const char* mac, const char* firmwareVersion,
                               uint64_t uptimeMs) {
  if (out == nullptr || cap == 0U) {
    return 0U;
  }
  out[0] = '\0';
  if (mac == nullptr || mac[0] == '\0' || firmwareVersion == nullptr) {
    return 0U;
  }

  // Digits from tb::formatU64 and in as `%s`: the ESP32 core's 64-bit printf
  // conversion is a build-time choice this firmware does not make, so `%llu`
  // here is a number that prints as garbage on somebody else's build of the
  // same source. The same rule as devlink's two renderers.
  char uptime[21] = {};
  if (tb::formatU64(uptimeMs, uptime, sizeof(uptime)) == 0U) {
    return 0U;
  }

  const int written =
      snprintf(out, cap, "{\"mac\":\"%s\",\"firmware_version\":\"%s\",\"uptime_ms\":%s,\"kind\":\"gate\"}",
               mac, firmwareVersion, uptime);
  if (written < 0 || static_cast<size_t>(written) >= cap) {
    out[0] = '\0';
    return 0U;
  }
  return static_cast<size_t>(written);
}

bool adoptUnlockMs(const char* body, size_t len, uint32_t& unlockMs) {
  if (body == nullptr) {
    return false;
  }

  // BOUNDED TO THE `gate` OBJECT, both ends. devapi::json::findKey is a flat
  // scan by design — the court box reads `button_map` out of the heartbeat's
  // nested `config` with no path — so reading `unlock_seconds` from the whole
  // body would adopt one from anywhere in the document, and reading from the
  // `gate` key onward would adopt one added after the object closed. Either is
  // a lock driven for somebody else's number.
  //
  // This used to be a local colon-requiring copy of findKey, because findKey
  // itself matched a quoted string anywhere and a gate heartbeat opens
  // `{"kind":"gate",…}`. That edge is fixed in devapi now and the copy is gone:
  // one implementation, proven in ../shared/test/test_devapi.
  size_t innerLen = 0U;
  const size_t at = devapi::json::findObject(body, len, "gate", innerLen);
  if (at == devapi::json::kNotFound) {
    return false;
  }

  uint32_t seconds = 0U;
  if (!devapi::json::unsignedField(body + at, innerLen, "unlock_seconds", seconds)) {
    return false;
  }
  // Clamped in SECONDS before the multiply, so a body claiming 4,300,000 cannot
  // wrap into a plausible small number — the same reasoning as Cadence's.
  unlockMs = unlockMsFromSeconds(seconds, kGateConfig.unlockHardCapMs);
  return true;
}

} // namespace gatelogic
