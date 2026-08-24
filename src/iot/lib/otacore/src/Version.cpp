#include "otacore/Version.h"

namespace ota {

namespace {

/// Reads digits into `out`, advancing `text`. False on no digits or overflow.
bool readNumber(const char*& text, uint16_t& out) {
  uint32_t value = 0U;
  int digits = 0;
  while (*text >= '0' && *text <= '9') {
    value = value * 10U + static_cast<uint32_t>(*text - '0');
    if (value > 65535U) {
      return false;
    }
    ++digits;
    ++text;
  }
  if (digits == 0) {
    return false;
  }
  out = static_cast<uint16_t>(value);
  return true;
}

int cmp(uint16_t a, uint16_t b) {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

} // namespace

Version parseVersion(const char* text) {
  Version v;
  if (text == nullptr) {
    return v;
  }

  const char* p = text;
  if (!readNumber(p, v.major) || *p != '.') {
    return v;
  }
  ++p;
  if (!readNumber(p, v.minor) || *p != '.') {
    return v;
  }
  ++p;
  if (!readNumber(p, v.patch) || *p != '\0') {
    // Trailing text refused rather than ignored: "1.2.3-rc1" is not "1.2.3", and
    // treating them as equal is how a release candidate blocks the release.
    return v;
  }

  v.parsed = true;
  return v;
}

int Version::compare(const Version& other) const {
  if (!parsed || !other.parsed) {
    if (parsed) {
      return 1;
    }
    return other.parsed ? -1 : 0;
  }

  const int byMajor = cmp(major, other.major);
  if (byMajor != 0) {
    return byMajor;
  }
  const int byMinor = cmp(minor, other.minor);
  if (byMinor != 0) {
    return byMinor;
  }
  return cmp(patch, other.patch);
}

} // namespace ota
