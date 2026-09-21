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

namespace {

/// The string value at a position `findKey` or `findTopLevelKey` returned.
/// Shared by both families so the two can never disagree about what a value is
/// — only about where a key may be found.
bool stringAt(const char* body, size_t len, size_t at, char* out, size_t outCap) {
  if (at == kNotFound) {
    return false;
  }
  at = skipToValue(body, len, at);
  if (!copyQuoted(body, len, at, out, outCap)) {
    return false;
  }
  return out[0] != '\0';
}

} // namespace

bool stringField(const char* body, size_t len, const char* key, char* out, size_t outCap) {
  return stringAt(body, len, findKey(body, len, key), out, outCap);
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

namespace {

bool unsignedAt(const char* body, size_t len, size_t at, uint32_t& out) {
  if (at == kNotFound) {
    return false;
  }
  at = skipToValue(body, len, at);
  return readUnsigned(body, len, at, out);
}

bool boolAt(const char* body, size_t len, size_t at, bool& out) {
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

} // namespace

bool unsignedField(const char* body, size_t len, const char* key, uint32_t& out) {
  return unsignedAt(body, len, findKey(body, len, key), out);
}

bool boolField(const char* body, size_t len, const char* key, bool& out) {
  return boolAt(body, len, findKey(body, len, key), out);
}

namespace {

size_t objectAt(const char* body, size_t len, size_t at, size_t& outLen) {
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

size_t arrayAt(const char* body, size_t len, size_t at) {
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

} // namespace

size_t findObject(const char* body, size_t len, const char* key, size_t& outLen) {
  return objectAt(body, len, findKey(body, len, key), outLen);
}

size_t findArray(const char* body, size_t len, const char* key) {
  return arrayAt(body, len, findKey(body, len, key));
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

namespace {

/// The opener stack, as one word.
///
/// Bit `depth` is 1 when the container opened at that level was `{` and 0 when
/// it was `[`. Remembering the KIND is the whole difference between this and a
/// depth counter, which let `{"a":1]` reach zero and declare a cut body whole.
struct Nesting {
  uint32_t openers = 0U;
  uint32_t depth = 0U;

  /// False when the document nests deeper than the stack holds.
  bool open(char opener) {
    if (depth >= kMaxNesting) {
      return false;
    }
    if (opener == '{') {
      openers |= bit(depth);
    } else {
      openers &= static_cast<uint32_t>(~bit(depth));
    }
    ++depth;
    return true;
  }

  /// False when nothing is open, or when `closer` does not match its opener.
  bool close(char closer) {
    if (depth == 0U) {
      return false;
    }
    --depth;
    return ((openers & bit(depth)) != 0U) == (closer == '}');
  }

  bool balanced() const { return depth == 0U; }

private:
  /// One bit of the word, in the word's own width. `1UL` is 64 bits on the
  /// host and 32 on both boards, and GCC's -Wconversion (the strict-compile
  /// gate, which Apple clang does not reproduce) refuses the narrowing back.
  static uint32_t bit(uint32_t level) { return static_cast<uint32_t>(1U) << level; }
};

/// Scans from the `{` at `at` to its matching `}` and answers the position just
/// past it. kNotFound when the body was cut short, when a closer does not match
/// its opener, or when it nests deeper than Nesting holds.
size_t pastBalancedObject(const char* body, size_t len, size_t at) {
  Nesting nesting;
  while (at < len) {
    const char c = body[at];
    if (c == '"') {
      // Through endOfString, the one authority on where a string ends, so a
      // brace inside a value — or an escaped quote — cannot be miscounted here
      // in a way the field readers would not miscount.
      const size_t end = endOfString(body, len, at);
      if (end == kNotFound) {
        return kNotFound; // unterminated: the body was cut inside a string
      }
      at = end + 1U;
      continue;
    }
    if (c == '{' || c == '[') {
      if (!nesting.open(c)) {
        return kNotFound;
      }
    } else if (c == '}' || c == ']') {
      if (!nesting.close(c)) {
        return kNotFound;
      }
      if (nesting.balanced()) {
        return at + 1U;
      }
    }
    ++at;
  }
  return kNotFound;
}

} // namespace

namespace {

/// One escaped byte, written into `out` at `at`. Returns the new `at`, or
/// kNotFound when it would not fit — checked per byte rather than up front,
/// because the expansion depends on the bytes and an up-front worst-case check
/// would refuse a subject that fits comfortably.
size_t writeEscaped(char byte, char* out, size_t outCap, size_t at) {
  const char* pair = nullptr;
  switch (byte) {
  case '"':
    pair = "\\\"";
    break;
  case '\\':
    pair = "\\\\";
    break;
  case '\b':
    pair = "\\b";
    break;
  case '\f':
    pair = "\\f";
    break;
  case '\n':
    pair = "\\n";
    break;
  case '\r':
    pair = "\\r";
    break;
  case '\t':
    pair = "\\t";
    break;
  default:
    break;
  }

  if (pair != nullptr) {
    if (at + 2U >= outCap) {
      return kNotFound;
    }
    out[at] = pair[0];
    out[at + 1U] = pair[1];
    return at + 2U;
  }

  const unsigned char value = static_cast<unsigned char>(byte);
  if (value >= 0x20U) {
    // Everything printable, and every UTF-8 continuation byte, straight
    // through: escaping those would change what the server stores.
    if (at + 1U >= outCap) {
      return kNotFound;
    }
    out[at] = byte;
    return at + 1U;
  }

  // A control byte with no short form. Raw, it is not legal JSON at all, and a
  // body the server refuses is a record the drain then drops.
  static const char kHex[] = "0123456789abcdef";
  if (at + 6U >= outCap) {
    return kNotFound;
  }
  out[at] = '\\';
  out[at + 1U] = 'u';
  out[at + 2U] = '0';
  out[at + 3U] = '0';
  out[at + 4U] = kHex[(value >> 4) & 0x0FU];
  out[at + 5U] = kHex[value & 0x0FU];
  return at + 6U;
}

} // namespace

bool escapeInto(const char* in, size_t inLen, char* out, size_t outCap) {
  if (out == nullptr || outCap == 0U) {
    return false;
  }
  out[0] = '\0';
  if (in == nullptr) {
    return inLen == 0U;
  }

  size_t at = 0U;
  for (size_t i = 0U; i < inLen; ++i) {
    at = writeEscaped(in[i], out, outCap, at);
    if (at == kNotFound) {
      out[0] = '\0';
      return false;
    }
  }
  out[at] = '\0';
  return true;
}

namespace {

/// Past the value that starts at `at`, whatever kind it is. kNotFound when the
/// document ends inside it or a container never balances.
///
/// `pastBalancedObject` below handles `{` and `[` alike — it remembers each
/// opener's KIND — so it is the one walker for both. A scalar is anything up to
/// the next `,` or `}` at this level, which cannot be inside a string because a
/// string is skipped whole above it.
size_t pastBalancedObject(const char* body, size_t len, size_t at);

size_t pastValue(const char* body, size_t len, size_t at) {
  if (at >= len) {
    return kNotFound;
  }
  if (body[at] == '"') {
    const size_t close = endOfString(body, len, at);
    return close == kNotFound ? kNotFound : close + 1U;
  }
  if (body[at] == '{' || body[at] == '[') {
    return pastBalancedObject(body, len, at);
  }
  while (at < len && body[at] != ',' && body[at] != '}') {
    ++at;
  }
  return at;
}

} // namespace

size_t findTopLevelKey(const char* body, size_t len, const char* key) {
  if (body == nullptr || key == nullptr) {
    return kNotFound;
  }
  const size_t keyLen = strlen(key);
  if (keyLen == 0U) {
    return kNotFound;
  }

  size_t at = skipSpace(body, len, 0U);
  // A TOP-LEVEL ARRAY IS NOT AN OBJECT, and that is one of the two bodies B2
  // reported: `[{"opened":true}]` released a lock through the flat scan.
  if (at >= len || body[at] != '{') {
    return kNotFound;
  }
  ++at;

  while (true) {
    at = skipSpace(body, len, at);
    if (at >= len || body[at] != '"') {
      return kNotFound; // the closing brace, a trailing comma, or malformed
    }
    const size_t close = endOfString(body, len, at);
    if (close == kNotFound) {
      return kNotFound;
    }
    const size_t colon = skipSpace(body, len, close + 1U);
    if (colon >= len || body[colon] != ':') {
      return kNotFound; // a member with no value: not a document this reads
    }
    if (close - (at + 1U) == keyLen && memcmp(body + at + 1U, key, keyLen) == 0) {
      return close + 1U; // the same contract findKey returns
    }
    // NOT THIS ONE: past its value WHOLE, so a key nested inside it is never a
    // match however early in the document it appears.
    at = pastValue(body, len, skipToValue(body, len, colon));
    if (at == kNotFound) {
      return kNotFound;
    }
    at = skipSpace(body, len, at);
    if (at >= len || body[at] != ',') {
      return kNotFound; // the object ended, and the key was not in it
    }
    ++at;
  }
}

bool topLevelStringField(const char* body, size_t len, const char* key, char* out, size_t outCap) {
  return stringAt(body, len, findTopLevelKey(body, len, key), out, outCap);
}

bool topLevelUnsignedField(const char* body, size_t len, const char* key, uint32_t& out) {
  return unsignedAt(body, len, findTopLevelKey(body, len, key), out);
}

bool topLevelBoolField(const char* body, size_t len, const char* key, bool& out) {
  return boolAt(body, len, findTopLevelKey(body, len, key), out);
}

size_t findTopLevelObject(const char* body, size_t len, const char* key, size_t& outLen) {
  return objectAt(body, len, findTopLevelKey(body, len, key), outLen);
}

size_t findTopLevelArray(const char* body, size_t len, const char* key) {
  return arrayAt(body, len, findTopLevelKey(body, len, key));
}

bool isCompleteObject(const char* body, size_t len) {
  if (body == nullptr) {
    return false;
  }
  const size_t at = skipSpace(body, len, 0U);
  if (at >= len || body[at] != '{') {
    return false;
  }

  const size_t past = pastBalancedObject(body, len, at);
  // Nothing after the outermost `}` but whitespace. A second document, or any
  // trailing byte, is a buffer this reader does not understand — and the caller
  // asking is about to replace something with it.
  return past != kNotFound && skipSpace(body, len, past) >= len;
}

} // namespace json
} // namespace devapi
