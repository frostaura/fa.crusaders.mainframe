#include "CorpusJson.h"

namespace corpus {
namespace {

int hexNibble(char c) {
  if (c >= '0' && c <= '9') {
    return c - '0';
  }
  if (c >= 'a' && c <= 'f') {
    return (c - 'a') + 10;
  }
  if (c >= 'A' && c <= 'F') {
    return (c - 'A') + 10;
  }
  return -1;
}

/// Appends one code point as UTF-8. Only the BMP below U+D800 is reachable from
/// the corpus, so surrogates are a hard failure rather than a partial encoding.
bool appendUtf8(uint32_t codePoint, char* out, size_t outCap, size_t* len) {
  char encoded[3];
  size_t n = 0;

  if (codePoint < 0x80U) {
    encoded[0] = static_cast<char>(codePoint);
    n = 1;
  } else if (codePoint < 0x800U) {
    encoded[0] = static_cast<char>(0xC0U | (codePoint >> 6));
    encoded[1] = static_cast<char>(0x80U | (codePoint & 0x3FU));
    n = 2;
  } else if (codePoint >= 0xD800U && codePoint <= 0xDFFFU) {
    return false;
  } else {
    encoded[0] = static_cast<char>(0xE0U | (codePoint >> 12));
    encoded[1] = static_cast<char>(0x80U | ((codePoint >> 6) & 0x3FU));
    encoded[2] = static_cast<char>(0x80U | (codePoint & 0x3FU));
    n = 3;
  }

  if (*len + n + 1 > outCap) {
    return false;
  }
  for (size_t i = 0; i < n; ++i) {
    out[*len + i] = encoded[i];
  }
  *len += n;
  return true;
}

bool decodeEscape(const char** cursor, char* out, size_t outCap, size_t* len) {
  const char* p = *cursor; // points at the character after the backslash
  char simple = '\0';

  switch (*p) {
  case '"':
    simple = '"';
    break;
  case '\\':
    simple = '\\';
    break;
  case '/':
    simple = '/';
    break;
  case 'b':
    simple = '\b';
    break;
  case 'f':
    simple = '\f';
    break;
  case 'n':
    simple = '\n';
    break;
  case 'r':
    simple = '\r';
    break;
  case 't':
    simple = '\t';
    break;
  case 'u': {
    uint32_t codePoint = 0;
    for (size_t i = 1; i <= 4; ++i) {
      const int nibble = hexNibble(p[i]);
      if (nibble < 0) {
        return false;
      }
      codePoint = (codePoint << 4) | static_cast<uint32_t>(nibble);
    }
    if (!appendUtf8(codePoint, out, outCap, len)) {
      return false;
    }
    *cursor = p + 5;
    return true;
  }
  default:
    return false;
  }

  if (*len + 2 > outCap) {
    return false;
  }
  out[*len] = simple;
  ++(*len);
  *cursor = p + 1;
  return true;
}

} // namespace

bool stringValue(const char* value, char* out, size_t outCap, size_t* outLen) {
  const char* p = skipWs(value);
  if (p == nullptr || *p != '"' || out == nullptr || outCap == 0) {
    return false;
  }
  ++p;

  size_t len = 0;
  while (*p != '\0' && *p != '"') {
    if (*p == '\\') {
      ++p;
      if (!decodeEscape(&p, out, outCap, &len)) {
        return false;
      }
      continue;
    }
    if (len + 2 > outCap) {
      return false;
    }
    out[len] = *p;
    ++len;
    ++p;
  }

  if (*p != '"') {
    return false;
  }

  out[len] = '\0';
  if (outLen != nullptr) {
    *outLen = len;
  }
  return true;
}

bool ObjectIter::next(char* nameOut, size_t nameCap, const char** valueOut) {
  p_ = skipWs(p_);
  if (p_ == nullptr || *p_ == '\0' || *p_ == '}') {
    return false;
  }
  if (*p_ == ',') {
    p_ = skipWs(p_ + 1);
  }
  if (p_ == nullptr || *p_ != '"') {
    return false;
  }

  if (!stringValue(p_, nameOut, nameCap, nullptr)) {
    return false;
  }

  p_ = skipString(p_);
  p_ = skipWs(p_);
  if (p_ == nullptr || *p_ != ':') {
    return false;
  }

  const char* value = skipWs(p_ + 1);
  *valueOut = value;
  p_ = skipValue(value);
  return p_ != nullptr;
}

bool ArrayIter::next(const char** elementOut) {
  p_ = skipWs(p_);
  if (p_ == nullptr || *p_ == '\0' || *p_ == ']') {
    return false;
  }
  if (*p_ == ',') {
    p_ = skipWs(p_ + 1);
  }
  if (p_ == nullptr || *p_ == '\0' || *p_ == ']') {
    return false;
  }

  *elementOut = p_;
  p_ = skipValue(p_);
  return p_ != nullptr;
}

const char* member(const char* object, const char* name) {
  char memberName[kMaxNameLen];
  const char* value = nullptr;

  ObjectIter it(object);
  while (it.next(memberName, sizeof(memberName), &value)) {
    if (strcmp(memberName, name) == 0) {
      return value;
    }
  }
  return nullptr;
}

bool File::load(const char* fileName) {
  // Walk upward rather than hard-coding a depth: `pio test` runs the binary
  // from src/iot, a manual build may run it from anywhere, and a wrong guess
  // would show up as a skipped suite.
  char path[512];
  loaded_ = false;

  for (int up = 0; up <= 8 && !loaded_; ++up) {
    size_t at = 0;
    for (int i = 0; i < up; ++i) {
      at += static_cast<size_t>(snprintf(path + at, sizeof(path) - at, "../"));
    }
    snprintf(path + at, sizeof(path) - at, "src/contracts/device-protocol/http/%s", fileName);

    FILE* f = fopen(path, "rb");
    if (f == nullptr) {
      continue;
    }

    const size_t read = fread(buffer_, 1, sizeof(buffer_) - 1, f);
    const bool overflowed = (read == sizeof(buffer_) - 1);
    fclose(f);

    if (!overflowed) {
      buffer_[read] = '\0';
      loaded_ = true;
    }
  }

  return loaded_;
}

} // namespace corpus
