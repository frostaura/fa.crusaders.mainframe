#include "devlink/CodeSync.h"

namespace devlink {
namespace detail {

bool syncStepClock(const char* body, size_t len, memcode::StepClock& clock, uint32_t nowMs) {
  uint32_t step = 0U;
  uint32_t stepMs = 0U;
  // BOTH, or the clock is left alone. A step with no phase is up to thirty
  // seconds wrong in a direction nobody can tell, which is a whole window.
  if (!devapi::json::topLevelUnsignedField(body, len, "code_step", step) ||
      !devapi::json::topLevelUnsignedField(body, len, "code_step_ms", stepMs)) {
    return false;
  }
  return clock.sync(step, stepMs, nowMs);
}

namespace {

/// Past the string whose opening quote is at `at`, honouring backslash escapes.
/// `len` when it never closes.
size_t pastString(const char* body, size_t len, size_t at) {
  ++at;
  while (at < len && body[at] != '"') {
    at += body[at] == '\\' ? 2U : 1U;
  }
  return at < len ? at + 1U : len;
}

/// Past the non-string value at `at`: to the `,` or `]` that ends it at depth
/// zero, strings and nested brackets skipped whole. `len` when it never ends.
size_t pastValue(const char* body, size_t len, size_t at) {
  uint8_t depth = 0U;
  while (at < len) {
    const char c = body[at];
    if (c == '"') {
      at = pastString(body, len, at);
      continue;
    }
    if (depth == 0U && (c == ',' || c == ']')) {
      return at;
    }
    if (c == '[' || c == '{') {
      if (depth == UINT8_MAX) {
        return len;
      }
      ++depth;
    } else if ((c == ']' || c == '}') && depth > 0U) {
      --depth;
    }
    ++at;
  }
  return len;
}

bool isSpace(char c) {
  return c == ' ' || c == '\t' || c == '\r' || c == '\n';
}

} // namespace

bool nextArrayElement(const char* body, size_t len, size_t& at, size_t& start, size_t& n, bool& isString) {
  while (at < len && (isSpace(body[at]) || body[at] == ',')) {
    ++at;
  }
  if (at >= len || body[at] == ']') {
    return false;
  }
  if (body[at] == '"') {
    const size_t end = pastString(body, len, at);
    if (end >= len) {
      // Inside a complete object no string can end the buffer: an array still
      // has its `]` to come. So this is a cut body, and it ends the walk.
      return false;
    }
    start = at + 1U;
    n = end - start - 1U;
    at = end;
    isString = true;
    return true;
  }
  const size_t end = pastValue(body, len, at);
  if (end >= len) {
    return false;
  }
  start = at;
  n = end - at;
  at = end;
  isString = false;
  return true;
}

} // namespace detail
} // namespace devlink
