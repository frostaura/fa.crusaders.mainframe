#include "devapi/Json.h"

#include <string.h>

namespace devapi {
namespace json {

namespace {

bool isSpace(char c) {
  return c == ' ' || c == '\t' || c == '\n' || c == '\r';
}

/// Skips whitespace only.
size_t skipSpace(const char* body, size_t len, size_t at) {
  while (at < len && isSpace(body[at])) {
    ++at;
  }
  return at;
}

/// Skips the whitespace and the colon between a key and its value.
size_t skipToValue(const char* body, size_t len, size_t at) {
  while (at < len && (isSpace(body[at]) || body[at] == ':')) {
    ++at;
  }
  return at;
}

/// Index of the CLOSING quote of the string whose opening quote is at `at`, or
/// kNotFound when `at` is not an opening quote or the string is unterminated.
///
/// THE ONE AUTHORITY on where a string ends, used by both the key scan and the
/// value copy, so the two cannot disagree about the same document. A `\` escapes
/// whatever follows it, whatever that is: `"he said \"no\""` is one string and
/// `"ends with \\"` ends at the quote after the escaped backslash. Nothing is
/// decoded here — this is a scanner, and half-decoding is how a value that
/// differs from what the server sent gets acted on as fact.
size_t endOfString(const char* body, size_t len, size_t at) {
  if (at >= len || body[at] != '"') {
    return kNotFound;
  }
  ++at;
  while (at < len) {
    if (body[at] == '\\') {
      at += 2U; // the escaped byte is never a terminator; past the end ends the walk
      continue;
    }
    if (body[at] == '"') {
      return at;
    }
    ++at;
  }
  return kNotFound; // unterminated: a truncated body, reported rather than half-read
}

/// Copies the quoted string starting at the opening quote. `at` ends past the
/// closing quote. False on overflow or an unterminated string. Escape pairs are
/// copied verbatim and cost two bytes of `outCap`, because that is what they are.
bool copyQuoted(const char* body, size_t len, size_t& at, char* out, size_t outCap) {
  if (outCap == 0U) {
    return false;
  }
  const size_t close = endOfString(body, len, at);
  if (close == kNotFound) {
    return false;
  }
  const size_t n = close - (at + 1U);
  if (n + 1U > outCap) {
    return false;
  }
  memcpy(out, body + at + 1U, n);
  out[n] = '\0';
  at = close + 1U;
  return true;
}

} // namespace

size_t findKey(const char* body, size_t len, const char* key) {
  if (body == nullptr || key == nullptr) {
    return kNotFound;
  }
  const size_t keyLen = strlen(key);
  if (keyLen == 0U) {
    return kNotFound;
  }

  size_t i = 0U;
  while (i < len) {
    if (body[i] != '"') {
      ++i;
      continue;
    }
    const size_t close = endOfString(body, len, i);
    if (close == kNotFound) {
      return kNotFound; // the body is truncated inside a string; nothing past it is readable
    }
    const size_t after = skipSpace(body, len, close + 1U);
    if (after >= len || body[after] != ':') {
      // A VALUE or an array element. Skipped whole — this is the whole fix:
      // a gate heartbeat opens `{"kind":"gate",…}` and the first `"gate"` in it
      // is the value of `kind`, not the key of the gate object.
      i = close + 1U;
      continue;
    }
    if (close - (i + 1U) == keyLen && memcmp(body + i + 1U, key, keyLen) == 0) {
      return close + 1U; // just past the KEY's closing quote — skipToValue takes it from here
    }
    i = after + 1U; // a key, but not this one: carry on at its value
  }
  return kNotFound;
}

bool stringField(const char* body, size_t len, const char* key, char* out, size_t outCap) {
  size_t at = findKey(body, len, key);
  if (at == kNotFound) {
    return false;
  }
  at = skipToValue(body, len, at);
  if (!copyQuoted(body, len, at, out, outCap)) {
    return false;
  }
  return out[0] != '\0';
}

namespace {

/// Reads the decimal digits at `at`, advancing past them. False when there are
/// none or the value would not fit — saturating is the caller's decision, and
/// none of them want a wrapped value.
bool readUnsigned(const char* body, size_t len, size_t& at, uint32_t& out) {
  uint32_t value = 0U;
  size_t digits = 0U;
  while (at < len && body[at] >= '0' && body[at] <= '9') {
    const uint32_t digit = static_cast<uint32_t>(body[at] - '0');
    if (value > (UINT32_MAX - digit) / 10U) {
      return false;
    }
    value = value * 10U + digit;
    ++digits;
    ++at;
  }
  if (digits == 0U) {
    return false;
  }
  out = value;
  return true;
}

} // namespace

bool unsignedField(const char* body, size_t len, const char* key, uint32_t& out) {
  size_t at = findKey(body, len, key);
  if (at == kNotFound) {
    return false;
  }
  at = skipToValue(body, len, at);
  return readUnsigned(body, len, at, out);
}

bool boolField(const char* body, size_t len, const char* key, bool& out) {
  size_t at = findKey(body, len, key);
  if (at == kNotFound) {
    return false;
  }
  at = skipToValue(body, len, at);
  if (at + 4U <= len && memcmp(body + at, "true", 4U) == 0) {
    out = true;
    return true;
  }
  if (at + 5U <= len && memcmp(body + at, "false", 5U) == 0) {
    out = false;
    return true;
  }
  return false;
}

size_t findObject(const char* body, size_t len, const char* key, size_t& outLen) {
  size_t at = findKey(body, len, key);
  if (at == kNotFound) {
    return kNotFound;
  }
  at = skipToValue(body, len, at);
  if (at >= len || body[at] != '{') {
    return kNotFound;
  }

  const size_t start = at + 1U;
  size_t depth = 0U;
  while (at < len) {
    if (body[at] == '"') {
      const size_t close = endOfString(body, len, at);
      if (close == kNotFound) {
        return kNotFound; // truncated inside a string: the object never balances
      }
      at = close + 1U;
      continue;
    }
    if (body[at] == '{') {
      ++depth;
    } else if (body[at] == '}') {
      --depth;
      if (depth == 0U) {
        outLen = at - start;
        return start;
      }
    }
    ++at;
  }
  return kNotFound;
}

size_t findArray(const char* body, size_t len, const char* key) {
  size_t at = findKey(body, len, key);
  if (at == kNotFound) {
    return kNotFound;
  }
  at = skipToValue(body, len, at);
  if (at >= len || body[at] != '[') {
    // Present but not an array. Reported as absent so the caller leaves whatever
    // it already had alone, rather than replacing it with nothing.
    return kNotFound;
  }
  return at + 1U;
}

bool nextStringElement(const char* body, size_t len, size_t& at, char* out, size_t outCap) {
  while (at < len && body[at] != '"' && body[at] != ']') {
    ++at;
  }
  if (at >= len || body[at] == ']') {
    return false;
  }
  return copyQuoted(body, len, at, out, outCap);
}

bool nextUnsignedElement(const char* body, size_t len, size_t& at, uint32_t& out) {
  // Skip the separator and any whitespace; stop at a digit, the bracket, or
  // anything else. "Anything else" is a non-integer element — reported as the
  // end of what this reader understands rather than skipped over, because an
  // array of court numbers with a string in it is not a court list.
  while (at < len &&
         (body[at] == ',' || body[at] == ' ' || body[at] == '\t' || body[at] == '\n' || body[at] == '\r')) {
    ++at;
  }
  if (at >= len || body[at] == ']') {
    return false;
  }
  return readUnsigned(body, len, at, out);
}

} // namespace json
} // namespace devapi
