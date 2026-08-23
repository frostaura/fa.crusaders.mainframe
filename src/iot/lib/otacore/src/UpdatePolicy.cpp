#include "otacore/UpdatePolicy.h"

#include <string.h>

#include "devapi/Json.h"

namespace ota {

namespace {

/// Reads an unsigned integer field. Zero when absent or unreadable, which every
/// caller treats as "unusable" rather than as a legitimate zero.
uint32_t unsignedField(const char* body, size_t len, const char* key) {
  size_t at = devapi::json::findKey(body, len, key);
  if (at == devapi::json::kNotFound) {
    return 0U;
  }
  while (at < len && (body[at] == ' ' || body[at] == ':')) {
    ++at;
  }

  uint32_t value = 0U;
  size_t digits = 0U;
  while (at < len && body[at] >= '0' && body[at] <= '9') {
    const uint32_t digit = static_cast<uint32_t>(body[at] - '0');
    if (value > (UINT32_MAX - digit) / 10U) {
      return 0U; // saturating, never wrapping into a plausible small size
    }
    value = value * 10U + digit;
    ++digits;
    ++at;
  }
  return digits == 0U ? 0U : value;
}

} // namespace

Manifest parseManifest(const char* body, size_t len) {
  Manifest manifest;
  if (body == nullptr || len == 0U) {
    return manifest;
  }
  if (devapi::json::findKey(body, len, "ota") == devapi::json::kNotFound) {
    return manifest;
  }

  // The fields are read from the whole body rather than from a delimited `ota`
  // object. That is safe because the names are unique in this response and it
  // avoids a nesting-aware scan; if the heartbeat ever grows a second `url` or
  // `version` field, this has to become a scoped read and the corpus will say so.
  manifest.present = true;
  static_cast<void>(
      devapi::json::stringField(body, len, "ota_version", manifest.version, sizeof(manifest.version)));
  static_cast<void>(devapi::json::stringField(body, len, "ota_url", manifest.url, sizeof(manifest.url)));
  manifest.sizeBytes = unsignedField(body, len, "ota_size");
  return manifest;
}

Decision decide(const Manifest& manifest, const char* runningVersion, const BootGuard& guard,
                uint32_t freeSketchSpace) {
  if (!manifest.present) {
    return Decision::NothingOffered;
  }
  if (manifest.version[0] == '\0' || manifest.url[0] == '\0' || manifest.sizeBytes == 0U) {
    return Decision::Unusable;
  }

  // Checked before the version comparison: a build that was condemned is refused
  // even when it is genuinely newer, which is the whole point of condemning it.
  if (guard.isKnownBad(manifest.version)) {
    return Decision::KnownBad;
  }

  const Version offered = parseVersion(manifest.version);
  if (!offered.parsed) {
    return Decision::Unusable;
  }
  const Version running = parseVersion(runningVersion);
  if (!running.olderThan(offered)) {
    return Decision::NotNewer;
  }

  if (freeSketchSpace > 0U && manifest.sizeBytes > freeSketchSpace) {
    // Before the download, not during it. Finding out halfway leaves a
    // half-written sketch on a board in a locked cupboard.
    return Decision::WillNotFit;
  }

  return Decision::Install;
}

const char* describe(Decision decision) {
  switch (decision) {
  case Decision::Install:
    return "installing";
  case Decision::NothingOffered:
    return "no update offered";
  case Decision::NotNewer:
    return "offered version is not newer";
  case Decision::KnownBad:
    return "offered version previously failed to start";
  case Decision::WillNotFit:
    return "image is larger than the free sketch space";
  case Decision::Unusable:
    return "update manifest is incomplete";
  }
  return "unknown";
}

} // namespace ota
