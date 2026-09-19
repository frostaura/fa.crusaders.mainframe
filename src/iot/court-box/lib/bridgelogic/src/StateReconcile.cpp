#include "bridgelogic/StateReconcile.h"

#include <stddef.h>
#include <stdint.h>

namespace bridgelogic {

bool parseStateMask(const char* arg, uint8_t& mask) {
  if (arg == nullptr || arg[0] == '\0') {
    return false;
  }
  uint16_t value = 0U;
  for (size_t i = 0U; arg[i] != '\0'; ++i) {
    const char c = arg[i];
    if (c < '0' || c > '9') {
      return false;
    }
    value = static_cast<uint16_t>(value * 10U + static_cast<uint16_t>(c - '0'));
    if (value > 15U) {
      return false; // also bounds the loop: three digits cannot get here
    }
  }
  mask = static_cast<uint8_t>(value);
  return true;
}

bool parseStateSeconds(const char* arg, uint16_t& seconds) {
  if (arg == nullptr || arg[0] == '\0') {
    return false;
  }
  uint32_t value = 0U;
  for (size_t i = 0U; arg[i] != '\0'; ++i) {
    const char c = arg[i];
    if (c < '0' || c > '9') {
      return false;
    }
    value = value * 10U + static_cast<uint32_t>(c - '0');
    if (value > UINT16_MAX) {
      return false; // also bounds the loop: six digits cannot get here
    }
  }
  seconds = static_cast<uint16_t>(value);
  return true;
}

Reconciliation reconcile(uint8_t mask, const HeldState held[kStateCourts], uint32_t nowMs) {
  Reconciliation result;
  for (uint8_t i = 0U; i < kStateCourts; ++i) {
    const bool lit = (mask & static_cast<uint8_t>(1U << i)) != 0U;
    if (lit == held[i].held) {
      continue;
    }
    // tb::since, never subtraction: a session that straddles the 49.7-day wrap
    // must report its true length, and a belief formed just before the wrap
    // must not read as 49 days old just after it.
    const uint32_t age = tb::since(nowMs, held[i].sinceMs);
    if (age < kReconcileGraceMs) {
      continue; // a frame that was in flight when the belief changed
    }
    if (held[i].held) {
      result.action[i] = CourtAction::SynthesizeRelease;
      result.heldMs[i] = age;
    } else {
      result.action[i] = CourtAction::AdoptHeld;
    }
  }
  return result;
}

HeldState afterOnAttempt(const HeldState& previous, bool sent, uint32_t nowMs) {
  if (!sent) {
    return previous;
  }
  HeldState held;
  held.sinceMs = nowMs;
  held.held = true;
  return held;
}

} // namespace bridgelogic
