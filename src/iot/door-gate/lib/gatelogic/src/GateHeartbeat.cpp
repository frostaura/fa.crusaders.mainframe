#include "gatelogic/GateHeartbeat.h"

#include <stdio.h>
#include <string.h>

#include "devapi/Json.h"
#include "timebase/TimeBase.h"

namespace gatelogic {
namespace {

/// Position just past `"gate":`, or kNotFound.
///
/// NOT devapi::json::findKey. That looks for the quoted text anywhere in the
/// body and returns the first hit — and a gate heartbeat response opens with
/// `"kind":"gate"`, so the first `"gate"` in every single response is the VALUE
/// of `kind`, not the key of the gate object. Reading from there happens to
/// work on the corpus vectors, where the only `unlock_seconds` in the document
/// is the right one; it stops working the moment any field is added between
/// them, and the failure is a lock driven for somebody else's number.
///
/// So this requires a colon after the closing quote. It is a local helper
/// rather than a change to devapi::json::findKey because that function's
/// behaviour is relied on by another firmware's suite; the sharp edge is worth
/// fixing there, deliberately, rather than as a side effect of this project.
size_t findObjectKey(const char* body, size_t len, const char* key, size_t keyLen) {
  if (body == nullptr || keyLen == 0U || len < keyLen + 3U) {
    return devapi::json::kNotFound;
  }
  for (size_t i = 0U; i + keyLen + 2U <= len; ++i) {
    if (body[i] != '"' || memcmp(body + i + 1U, key, keyLen) != 0 || body[i + keyLen + 1U] != '"') {
      continue;
    }
    size_t at = i + keyLen + 2U;
    while (at < len && (body[at] == ' ' || body[at] == '\t' || body[at] == '\n' || body[at] == '\r')) {
      ++at;
    }
    if (at < len && body[at] == ':') {
      return at + 1U;
    }
  }
  return devapi::json::kNotFound;
}

} // namespace

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
  const size_t at = findObjectKey(body, len, "gate", 4U);
  if (at == devapi::json::kNotFound || at >= len) {
    return false;
  }

  uint32_t seconds = 0U;
  if (!devapi::json::unsignedField(body + at, len - at, "unlock_seconds", seconds)) {
    return false;
  }
  // Clamped in SECONDS before the multiply, so a body claiming 4,300,000 cannot
  // wrap into a plausible small number — the same reasoning as Cadence's.
  unlockMs = unlockMsFromSeconds(seconds, kGateConfig.unlockHardCapMs);
  return true;
}

} // namespace gatelogic
