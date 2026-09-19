// A read-only JSON reader for the shared device-protocol corpus.
//
// WHY NOT A GENERATED HEADER
// --------------------------
// The obvious alternative is a Python generator that turns cases.json into a
// C++ header. It was rejected because it breaks the anti-drift rule the corpus
// exists to enforce: with the cases AND the declared counts both frozen into a
// generated file, someone can add a vector to cases.json, bump case_count, and
// the C++ side keeps executing the stale set and keeps passing. Reading the
// JSON at test time means a case added to the corpus is a case this suite runs
// on its next execution, with no generator step to forget.
//
// WHY NOT ArduinoJson
// -------------------
// It allocates, and it is not available to the host test environment without
// adding a dependency to a suite whose entire purpose is to run everywhere. The
// corpus is machine-generated, flat, and under 20 KB; a scanner over it is
// about a hundred lines and has no failure modes that matter here. This is test
// scaffolding, not firmware — but it still allocates nothing, because the
// buffers are static and bounded.

// WHY THIS IS HEADER-ONLY
// -----------------------
// Several suites read the corpus, and PlatformIO builds each test_<name>
// directory into its own binary without compiling anything outside it. A shared
// .cpp here would compile and then fail to link, which is exactly what happened
// when it was tried. Everything is therefore `inline` in the header, each test
// binary gets its own copy, and there is no build configuration to keep in step
// with a new suite.
//
// WHY IT LIVES IN shared/test/support/ AND NOT IN A DEVICE PROJECT
// ---------------------------------------------------------------
// It was in court-box/test/support/, where it was invisible to every other
// firmware project: PlatformIO puts a project's OWN test_dir on the include
// path and nothing else, so the door gate's suite could not have read the
// corpus at all without a second copy of this file. Two copies of a corpus
// reader is two ways to read the corpus, which is the drift the corpus exists
// to catch, one level up.
//
// It is reached from every project by the SAME line, because each project's
// `[strict_host]` block carries `-I$PROJECT_DIR/../shared/test` and those blocks
// are kept byte-identical on purpose. That expression is this directory from
// any of them, including from `shared` itself, where it is redundant and kept
// anyway so the blocks stay identical.

#ifndef CRUSADERS_TEST_CORPUS_JSON_H
#define CRUSADERS_TEST_CORPUS_JSON_H

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

namespace corpus {

constexpr size_t kMaxFileSize = 65536;
constexpr size_t kMaxStringLen = 4096;
constexpr size_t kMaxNameLen = 64;

// --- scanning ---------------------------------------------------------------

inline bool isWs(char c) {
  return c == ' ' || c == '\t' || c == '\n' || c == '\r';
}

inline const char* skipWs(const char* p) {
  while (p != nullptr && *p != '\0' && isWs(*p)) {
    ++p;
  }
  return p;
}

/// `p` points at the opening quote; returns the character after the closing one.
inline const char* skipString(const char* p) {
  if (p == nullptr || *p != '"') {
    return nullptr;
  }
  ++p;
  while (*p != '\0') {
    if (*p == '\\') {
      if (p[1] == '\0') {
        return nullptr;
      }
      p += 2;
      continue;
    }
    if (*p == '"') {
      return p + 1;
    }
    ++p;
  }
  return nullptr;
}

/// Returns the character after the value `p` points at, or null if malformed.
inline const char* skipValue(const char* p) {
  p = skipWs(p);
  if (p == nullptr || *p == '\0') {
    return nullptr;
  }

  if (*p == '"') {
    return skipString(p);
  }

  if (*p == '{' || *p == '[') {
    // Depth counting per bracket type. Safe because the input is valid JSON, in
    // which the two kinds nest independently but each is balanced.
    const char open = *p;
    const char close = (open == '{') ? '}' : ']';
    int depth = 0;
    while (*p != '\0') {
      if (*p == '"') {
        p = skipString(p);
        if (p == nullptr) {
          return nullptr;
        }
        continue;
      }
      if (*p == open) {
        ++depth;
      } else if (*p == close) {
        --depth;
        if (depth == 0) {
          return p + 1;
        }
      }
      ++p;
    }
    return nullptr;
  }

  // Number, true, false or null: runs to the next structural character.
  while (*p != '\0' && *p != ',' && *p != '}' && *p != ']' && !isWs(*p)) {
    ++p;
  }
  return p;
}

// --- values -----------------------------------------------------------------

inline bool isArray(const char* value) {
  const char* p = skipWs(value);
  return p != nullptr && *p == '[';
}

/// Decodes a JSON string value into `out`. Handles the escapes the corpus can
/// contain, including \uXXXX (the manifest carries an em dash) — encoded as
/// UTF-8, since the byte-level comparisons downstream are UTF-8. Surrogate
/// pairs are rejected rather than mangled; nothing in the corpus needs them and
/// silently emitting broken UTF-8 would be worse than failing.
inline bool stringValue(const char* value, char* out, size_t outCap, size_t* outLen);

inline uint64_t unsignedValue(const char* value) {
  const char* p = skipWs(value);
  uint64_t result = 0;
  while (p != nullptr && *p >= '0' && *p <= '9') {
    result = (result * 10U) + static_cast<uint64_t>(*p - '0');
    ++p;
  }
  return result;
}

// --- objects and arrays -----------------------------------------------------

/// Iterates the members of a JSON object. `object` points at '{'.
class ObjectIter {
public:
  explicit ObjectIter(const char* object) : p_(skipWs(object)) {
    if (p_ != nullptr && *p_ == '{') {
      ++p_;
    } else {
      p_ = nullptr;
    }
  }

  /// Yields the next member's name and a pointer to its value.
  bool next(char* nameOut, size_t nameCap, const char** valueOut);

private:
  const char* p_;
};

/// Iterates the elements of a JSON array. `array` points at '['.
class ArrayIter {
public:
  explicit ArrayIter(const char* array) : p_(skipWs(array)) {
    if (p_ != nullptr && *p_ == '[') {
      ++p_;
    } else {
      p_ = nullptr;
    }
  }

  bool next(const char** elementOut);

private:
  const char* p_;
};

/// Finds a member by name. Returns null when absent — callers treat that as a
/// failure, since a corpus case missing a field is a corpus that changed shape.
inline const char* member(const char* object, const char* name);

/// Decodes the hex-string member `name` of `object` into `out`, writing the
/// byte count to `outLen`. False when the member is absent, not a string, has
/// an odd length or a non-hex digit, or does not fit — never a partial decode.
/// Shared by every suite that reads `*_hex` fields, so the decoding rule cannot
/// drift between them.
inline bool hexField(const char* object, const char* name, uint8_t* out, size_t outCap, size_t* outLen);

// --- loading ----------------------------------------------------------------

/// Reads one file from a src/contracts/device-protocol family, searching upward
/// from the working directory. The corpus deliberately lives outside both
/// src/iot and src/backend, so neither side reaches into the other's tree; the
/// price is that the test has to find it. A missing corpus must fail loudly
/// rather than skip — a skipped corpus is exactly the failure mode the
/// executed-count rule exists to prevent.
class File {
public:
  /// `family` is the corpus subdirectory — "http", "buttonmap", and so on. It is
  /// a parameter rather than a constant because the corpus grew a second family
  /// that two implementations have to agree on, and hardcoding one directory is
  /// how the second family ends up with a reader of its own that drifts.
  bool load(const char* family, const char* fileName);

  const char* root() const { return loaded_ ? buffer_ : nullptr; }

private:
  char buffer_[kMaxFileSize];
  bool loaded_ = false;
};

// --- definitions ------------------------------------------------------------
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
inline bool appendUtf8(uint32_t codePoint, char* out, size_t outCap, size_t* len) {
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

inline bool decodeEscape(const char** cursor, char* out, size_t outCap, size_t* len) {
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

inline bool stringValue(const char* value, char* out, size_t outCap, size_t* outLen) {
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

inline bool ObjectIter::next(char* nameOut, size_t nameCap, const char** valueOut) {
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

inline bool ArrayIter::next(const char** elementOut) {
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

inline const char* member(const char* object, const char* name) {
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

inline bool hexField(const char* object, const char* name, uint8_t* out, size_t outCap, size_t* outLen) {
  // Static, not stack: the longest corpus string is 4 KB and this runs inside
  // a Unity test frame.
  static char text[kMaxStringLen];

  const char* value = member(object, name);
  size_t textLen = 0;
  if (value == nullptr || out == nullptr || outLen == nullptr ||
      !stringValue(value, text, sizeof(text), &textLen)) {
    return false;
  }
  if ((textLen % 2U) != 0U || textLen / 2U > outCap) {
    return false;
  }

  for (size_t i = 0; i < textLen; i += 2U) {
    const int hi = hexNibble(text[i]);
    const int lo = hexNibble(text[i + 1U]);
    if (hi < 0 || lo < 0) {
      return false;
    }
    out[i / 2U] = static_cast<uint8_t>((hi << 4) | lo);
  }
  *outLen = textLen / 2U;
  return true;
}

inline bool File::load(const char* family, const char* fileName) {
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
    snprintf(path + at, sizeof(path) - at, "src/contracts/device-protocol/%s/%s", family, fileName);

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

#endif // CRUSADERS_TEST_CORPUS_JSON_H
