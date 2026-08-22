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
bool stringValue(const char* value, char* out, size_t outCap, size_t* outLen);

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
const char* member(const char* object, const char* name);

// --- loading ----------------------------------------------------------------

/// Reads one file from src/contracts/device-protocol/http, searching upward
/// from the working directory. The corpus deliberately lives outside both
/// src/iot and src/backend, so neither side reaches into the other's tree; the
/// price is that the test has to find it. A missing corpus must fail loudly
/// rather than skip — a skipped corpus is exactly the failure mode the
/// executed-count rule exists to prevent.
class File {
public:
  bool load(const char* fileName);

  const char* root() const { return loaded_ ? buffer_ : nullptr; }

private:
  char buffer_[kMaxFileSize];
  bool loaded_ = false;
};

} // namespace corpus

#endif // CRUSADERS_TEST_CORPUS_JSON_H
