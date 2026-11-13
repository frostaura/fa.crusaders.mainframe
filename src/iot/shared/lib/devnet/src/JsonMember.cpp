#include "devnet/JsonMember.h"

#include "devapi/Json.h"

namespace devnet {
namespace json {
namespace {

bool isWs(char c) {
  return c == ' ' || c == '\t' || c == '\r' || c == '\n';
}

/// Position of the first byte of `key`'s VALUE, or kNotFound.
size_t valueAt(const char* object, size_t len, const char* key) {
  if (object == nullptr || key == nullptr) {
    return devapi::json::kNotFound;
  }
  size_t at = devapi::json::findTopLevelKey(object, len, key);
  if (at == devapi::json::kNotFound) {
    return at;
  }
  while (at < len && isWs(object[at])) {
    ++at;
  }
  if (at >= len || object[at] != ':') {
    return devapi::json::kNotFound;
  }
  ++at;
  while (at < len && isWs(object[at])) {
    ++at;
  }
  return at < len ? at : devapi::json::kNotFound;
}

int hexValue(char c) {
  if (c >= '0' && c <= '9') {
    return c - '0';
  }
  if (c >= 'a' && c <= 'f') {
    return c - 'a' + 10;
  }
  if (c >= 'A' && c <= 'F') {
    return c - 'A' + 10;
  }
  return -1;
}

bool readHex4(const char* p, size_t remaining, uint32_t& out) {
  if (remaining < 4U) {
    return false;
  }
  out = 0U;
  for (size_t i = 0U; i < 4U; ++i) {
    const int v = hexValue(p[i]);
    if (v < 0) {
      return false;
    }
    out = (out << 4) | static_cast<uint32_t>(v);
  }
  return true;
}

/// Appends `cp` as UTF-8. False when it does not fit (one byte is always kept
/// for the terminator).
bool appendUtf8(uint32_t cp, char* out, size_t cap, size_t& n) {
  uint8_t buf[4];
  size_t k = 0U;
  if (cp < 0x80U) {
    buf[k++] = static_cast<uint8_t>(cp);
  } else if (cp < 0x800U) {
    buf[k++] = static_cast<uint8_t>(0xC0U | (cp >> 6));
    buf[k++] = static_cast<uint8_t>(0x80U | (cp & 0x3FU));
  } else if (cp < 0x10000U) {
    buf[k++] = static_cast<uint8_t>(0xE0U | (cp >> 12));
    buf[k++] = static_cast<uint8_t>(0x80U | ((cp >> 6) & 0x3FU));
    buf[k++] = static_cast<uint8_t>(0x80U | (cp & 0x3FU));
  } else {
    buf[k++] = static_cast<uint8_t>(0xF0U | (cp >> 18));
    buf[k++] = static_cast<uint8_t>(0x80U | ((cp >> 12) & 0x3FU));
    buf[k++] = static_cast<uint8_t>(0x80U | ((cp >> 6) & 0x3FU));
    buf[k++] = static_cast<uint8_t>(0x80U | (cp & 0x3FU));
  }
  if (n + k + 1U > cap) {
    return false;
  }
  for (size_t i = 0U; i < k; ++i) {
    out[n++] = static_cast<char>(buf[i]);
  }
  return true;
}

/// One `\uXXXX`, or a surrogate pair of them, starting at the `u`. Advances `i`
/// past the last hex digit consumed.
bool decodeUnicode(const char* s, size_t len, size_t& i, uint32_t& cp) {
  if (!readHex4(s + i + 1U, len - i - 1U, cp)) {
    return false;
  }
  i += 4U;
  if (cp >= 0xDC00U && cp <= 0xDFFFU) {
    return false; // a lone low surrogate
  }
  if (cp >= 0xD800U && cp <= 0xDBFFU) {
    uint32_t low = 0U;
    if (i + 2U >= len || s[i + 1U] != '\\' || s[i + 2U] != 'u' || !readHex4(s + i + 3U, len - i - 3U, low) ||
        low < 0xDC00U || low > 0xDFFFU) {
      return false;
    }
    i += 6U;
    cp = 0x10000U + ((cp - 0xD800U) << 10) + (low - 0xDC00U);
  }
  return cp != 0U;
}

char simpleEscape(char c) {
  switch (c) {
  case '"':
    return '"';
  case '\\':
    return '\\';
  case '/':
    return '/';
  case 'b':
    return '\b';
  case 'f':
    return '\f';
  case 'n':
    return '\n';
  case 'r':
    return '\r';
  case 't':
    return '\t';
  default:
    return '\0';
  }
}

} // namespace

namespace {

/// The escape at object[i] (just past the backslash), appended to out; `i` is
/// left on its last character. False when it is malformed or does not fit.
bool appendEscape(const char* object, size_t len, size_t& i, Out& out, size_t& n) {
  if (object[i] == 'u') {
    uint32_t cp = 0U;
    return decodeUnicode(object, len, i, cp) && appendUtf8(cp, out.buf, out.cap, n);
  }
  const char decoded = simpleEscape(object[i]);
  if (decoded == '\0' || n + 2U > out.cap) {
    return false;
  }
  out.buf[n++] = decoded;
  return true;
}

/// Decodes the string whose opening quote is at object[at]. Ok with the
/// terminator written; Unreadable on a control byte, a bad escape or overflow.
Member decodeString(const char* object, size_t len, size_t at, Out& out) {
  size_t n = 0U;
  for (size_t i = at + 1U; i < len; ++i) {
    const char c = object[i];
    if (c == '"') {
      out.buf[n] = '\0';
      out.len = n;
      return Member::Ok;
    }
    if (static_cast<uint8_t>(c) < 0x20U) {
      break; // a raw control byte is not legal inside a JSON string
    }
    if (c == '\\') {
      ++i;
      if (i >= len || !appendEscape(object, len, i, out, n)) {
        break;
      }
      continue;
    }
    if (n + 2U > out.cap) {
      break;
    }
    out.buf[n++] = c;
  }
  out.buf[0] = '\0';
  return Member::Unreadable;
}

} // namespace

Member stringMember(const char* object, size_t len, const char* key, Out out) {
  out.len = 0U;
  const size_t at = valueAt(object, len, key);
  if (at == devapi::json::kNotFound) {
    return Member::Missing;
  }
  if (object[at] != '"') {
    return Member::WrongType;
  }
  if (out.buf == nullptr || out.cap == 0U) {
    return Member::Unreadable;
  }
  return decodeString(object, len, at, out);
}

Member unsignedMember(const char* object, size_t len, const char* key, uint32_t& out) {
  const size_t at = valueAt(object, len, key);
  if (at == devapi::json::kNotFound) {
    return Member::Missing;
  }
  if (object[at] < '0' || object[at] > '9') {
    return Member::WrongType;
  }
  uint64_t value = 0U;
  size_t i = at;
  for (; i < len && object[i] >= '0' && object[i] <= '9'; ++i) {
    value = (value * 10U) + static_cast<uint64_t>(object[i] - '0');
    if (value > 0xFFFFFFFFULL) {
      return Member::Unreadable;
    }
  }
  if (i < len && (object[i] == '.' || object[i] == 'e' || object[i] == 'E')) {
    return Member::WrongType; // a fraction or an exponent is not an integer
  }
  if (object[at] == '0' && i - at > 1U) {
    return Member::Unreadable; // JSON forbids leading zeros
  }
  out = static_cast<uint32_t>(value);
  return Member::Ok;
}

bool isNullMember(const char* object, size_t len, const char* key) {
  const size_t at = valueAt(object, len, key);
  if (at == devapi::json::kNotFound || at + 4U > len) {
    return false;
  }
  if (object[at] != 'n' || object[at + 1U] != 'u' || object[at + 2U] != 'l' || object[at + 3U] != 'l') {
    return false;
  }
  return at + 4U == len || object[at + 4U] == ',' || object[at + 4U] == '}' || isWs(object[at + 4U]);
}

bool topLevelObjectText(const char* body, size_t len, const char* key, const char*& object,
                        size_t& objectLen) {
  size_t inner = 0U;
  const size_t at = devapi::json::findTopLevelObject(body, len, key, inner);
  if (at == devapi::json::kNotFound || at == 0U || at + inner >= len) {
    return false;
  }
  object = body + at - 1U;
  objectLen = inner + 2U;
  return true;
}

} // namespace json
} // namespace devnet
