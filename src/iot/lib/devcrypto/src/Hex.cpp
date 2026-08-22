#include "devcrypto/Hex.h"

#include <string.h>

namespace dc {
namespace hex {
namespace {

const char kDigits[] = "0123456789abcdef";

/// Returns the nibble value, or 16 for a non-hex character. 16 rather than -1
/// keeps the return type unsigned and the callers free of sign conversions.
uint8_t nibble(char c) {
  if (c >= '0' && c <= '9') {
    return static_cast<uint8_t>(c - '0');
  }
  if (c >= 'a' && c <= 'f') {
    return static_cast<uint8_t>((c - 'a') + 10);
  }
  if (c >= 'A' && c <= 'F') {
    return static_cast<uint8_t>((c - 'A') + 10);
  }
  return 16U;
}

} // namespace

bool encodeLower(const uint8_t* data, size_t len, char* out, size_t outCap) {
  if (out == nullptr || outCap < encodedSize(len)) {
    return false;
  }
  if (data == nullptr && len > 0) {
    return false;
  }

  for (size_t i = 0; i < len; ++i) {
    out[i * 2] = kDigits[(data[i] >> 4) & 0x0FU];
    out[(i * 2) + 1] = kDigits[data[i] & 0x0FU];
  }
  out[len * 2] = '\0';
  return true;
}

bool decode(const char* text, size_t textLen, uint8_t* out, size_t outCap, size_t* outLen) {
  if (out == nullptr || (text == nullptr && textLen > 0)) {
    return false;
  }
  if ((textLen % 2) != 0 || (textLen / 2) > outCap) {
    return false;
  }

  for (size_t i = 0; i < textLen; i += 2) {
    const uint8_t high = nibble(text[i]);
    const uint8_t low = nibble(text[i + 1]);
    if (high > 15U || low > 15U) {
      return false;
    }
    out[i / 2] = static_cast<uint8_t>((high << 4) | low);
  }

  if (outLen != nullptr) {
    *outLen = textLen / 2;
  }
  return true;
}

bool constantTimeEquals(const uint8_t* a, size_t aLen, const uint8_t* b, size_t bLen) {
  if (aLen != bLen) {
    return false;
  }
  if (a == nullptr || b == nullptr) {
    return a == b;
  }

  // The accumulator is the whole point: every byte is examined on every call,
  // and the result is only inspected at the end. Rewriting this as an early
  // `return false` reintroduces the timing oracle described in the header.
  uint8_t difference = 0U;
  for (size_t i = 0; i < aLen; ++i) {
    difference = static_cast<uint8_t>(difference | static_cast<uint8_t>(a[i] ^ b[i]));
  }
  return difference == 0U;
}

bool constantTimeEqualsText(const char* expected, const char* presented) {
  if (expected == nullptr || presented == nullptr) {
    return false;
  }
  return constantTimeEquals(reinterpret_cast<const uint8_t*>(expected), strlen(expected),
                            reinterpret_cast<const uint8_t*>(presented), strlen(presented));
}

} // namespace hex
} // namespace dc
