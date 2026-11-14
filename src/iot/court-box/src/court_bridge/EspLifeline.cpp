#include "EspLifeline.h"

#ifdef TARGET_COURT_BRIDGE

#include <Arduino.h>

#include <LittleFS.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

namespace arduino_hal {

namespace {

constexpr size_t kPathCap = 40U;

bool tmpPath(const char* path, char* out, size_t cap) {
  const int n = snprintf(out, cap, "%s.tmp", path);
  return n > 0 && static_cast<size_t>(n) < cap;
}

/// Replaces `path` with `tmp`: LittleFS's rename replaces an existing file
/// atomically; a core that refuses is given the remove first.
bool commitTmp(const char* tmp, const char* path) {
  if (LittleFS.rename(tmp, path)) {
    return true;
  }
  LittleFS.remove(path);
  return LittleFS.rename(tmp, path);
}

File gStream;
char gStreamPath[kPathCap] = {};
char gStreamTmp[kPathCap] = {};

} // namespace

void LittleFsFiles::prepare() {
  LittleFS.mkdir("/st");
}

bool LittleFsFiles::write(const char* path, const bridgelogic::Part* parts, uint8_t count) {
  char tmp[kPathCap];
  if (!tmpPath(path, tmp, sizeof(tmp))) {
    return false;
  }
  File f = LittleFS.open(tmp, "w");
  if (!f) {
    return false;
  }
  bool ok = true;
  for (uint8_t i = 0U; i < count && ok; ++i) {
    ok = parts[i].len == 0U ||
         f.write(static_cast<const uint8_t*>(parts[i].data), parts[i].len) == parts[i].len;
  }
  f.close();
  if (!ok) {
    LittleFS.remove(tmp);
    return false;
  }
  return commitTmp(tmp, path);
}

size_t LittleFsFiles::read(const char* path, uint32_t offset, void* out, size_t cap) {
  File f = LittleFS.open(path, "r");
  if (!f) {
    return 0U;
  }
  size_t n = 0U;
  if (offset < f.size() && f.seek(offset, SeekSet)) {
    n = f.read(static_cast<uint8_t*>(out), cap);
  }
  f.close();
  return n;
}

uint32_t LittleFsFiles::size(const char* path) {
  File f = LittleFS.open(path, "r");
  if (!f) {
    return 0U;
  }
  const uint32_t n = static_cast<uint32_t>(f.size());
  f.close();
  return n;
}

void LittleFsFiles::remove(const char* path) {
  LittleFS.remove(path);
}

bool LittleFsFiles::begin(const char* path) {
  if (gStream || !tmpPath(path, gStreamTmp, sizeof(gStreamTmp))) {
    return false;
  }
  snprintf(gStreamPath, sizeof(gStreamPath), "%s", path);
  gStream = LittleFS.open(gStreamTmp, "w");
  return static_cast<bool>(gStream);
}

bool LittleFsFiles::append(const void* data, size_t len) {
  return gStream && gStream.write(static_cast<const uint8_t*>(data), len) == len;
}

bool LittleFsFiles::end(bool keep) {
  if (!gStream) {
    return false;
  }
  gStream.close();
  if (!keep) {
    LittleFS.remove(gStreamTmp);
    return true;
  }
  return commitTmp(gStreamTmp, gStreamPath);
}

// --- the warm epoch ----------------------------------------------------------------------

namespace {

/// Above eboot's command words (user words 64..95): the last four of 128.
constexpr uint32_t kRtcWord = 124U;
constexpr uint32_t kEpochMagic = 0x45504F43UL; // "EPOC"

struct RtcEpochImage {
  uint32_t magic;
  uint32_t lo;
  uint32_t hi;
  uint32_t check;
};

uint32_t checkOf(const RtcEpochImage& i) {
  return i.magic ^ i.lo ^ (i.hi * 2654435761UL) ^ 0xA5A5A5A5UL;
}

} // namespace

bool RtcEpoch::begin(bool powerOn, uint32_t nowMs) {
  bootMs_ = nowMs;
  base_ = 0U;
  RtcEpochImage image = {};
  if (!powerOn && ESP.rtcUserMemoryRead(kRtcWord, reinterpret_cast<uint32_t*>(&image), sizeof(image)) &&
      image.magic == kEpochMagic && image.check == checkOf(image)) {
    // Carried: plus the boot itself, which the last write could not see.
    base_ = ((static_cast<uint64_t>(image.hi) << 32) | image.lo) + 1000U;
    return true;
  }
  return false;
}

uint64_t RtcEpoch::tick(uint32_t nowMs) {
  const uint64_t epoch = now(nowMs);
  if (!written_ || nowMs - writtenAtMs_ >= 1000UL) {
    RtcEpochImage image = {kEpochMagic, static_cast<uint32_t>(epoch), static_cast<uint32_t>(epoch >> 32), 0U};
    image.check = checkOf(image);
    static_cast<void>(ESP.rtcUserMemoryWrite(kRtcWord, reinterpret_cast<uint32_t*>(&image), sizeof(image)));
    written_ = true;
    writtenAtMs_ = nowMs;
  }
  return epoch;
}

} // namespace arduino_hal

#endif // TARGET_COURT_BRIDGE
