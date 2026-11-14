#include "devota/Ota.h"

#include <stdio.h>
#include <string.h>

#include "devcrypto/Base64Url.h"
#include "devcrypto/Hex.h"
#include "devcrypto/Sha256.h"
#include "devnet/JsonMember.h"
#include "timebase/TimeBase.h"

namespace devota {
namespace {

using devnet::json::Member;

bool isLowerHex(char c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
}

bool isB64Url(char c) {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_';
}

bool allOf(const char* s, size_t n, bool (*pred)(char)) {
  for (size_t i = 0U; i < n; ++i) {
    if (!pred(s[i])) {
      return false;
    }
  }
  return true;
}

/// One version part: "0", or 1–999 with no leading zero.
bool versionPart(const char* s, size_t n, uint16_t& out) {
  if (n == 0U || n > 3U || (n > 1U && s[0] == '0')) {
    return false;
  }
  uint16_t v = 0U;
  for (size_t i = 0U; i < n; ++i) {
    if (s[i] < '0' || s[i] > '9') {
      return false;
    }
    v = static_cast<uint16_t>((v * 10U) + static_cast<uint16_t>(s[i] - '0'));
  }
  out = v;
  return true;
}

int compareVersions(const uint16_t a[3], const uint16_t b[3]) {
  for (int i = 0; i < 3; ++i) {
    if (a[i] != b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
}

bool presence(const char* obj, size_t len, const char* key) {
  // Any member counts as present, whatever its type: `missing_*` is only for
  // a key that is not there at all.
  uint32_t ignored = 0U;
  return devnet::json::unsignedMember(obj, len, key, ignored) != Member::Missing;
}

Refusal firstMissing(const char* obj, size_t len) {
  if (!presence(obj, len, "target")) {
    return Refusal::MissingTarget;
  }
  if (!presence(obj, len, "version")) {
    return Refusal::MissingVersion;
  }
  if (!presence(obj, len, "size")) {
    return Refusal::MissingSize;
  }
  if (!presence(obj, len, "sha256")) {
    return Refusal::MissingSha256;
  }
  if (!presence(obj, len, "sig")) {
    return Refusal::MissingSig;
  }
  if (!presence(obj, len, "path")) {
    return Refusal::MissingPath;
  }
  return Refusal::Ok;
}

bool pathOk(const char* path, size_t n) {
  const size_t prefix = sizeof(kPathPrefix) - 1U;
  if (n <= prefix || n > prefix + 64U || strncmp(path, kPathPrefix, prefix) != 0) {
    return false;
  }
  return allOf(path + prefix, n - prefix, isB64Url);
}

/// The identity checks — target and version.
Refusal checkIdentity(const char* obj, size_t len, const char* ownTarget, Offer& out) {
  size_t n = 0U;
  if (devnet::json::stringMember(obj, len, "target", devnet::json::Out{out.target, sizeof(out.target), n}) !=
          Member::Ok ||
      targetMaxBytes(out.target) == 0U) {
    return Refusal::TargetUnknown;
  }
  if (ownTarget == nullptr || strcmp(out.target, ownTarget) != 0) {
    return Refusal::TargetMismatch;
  }
  uint16_t parts[3] = {0U, 0U, 0U};
  if (devnet::json::stringMember(obj, len, "version",
                                 devnet::json::Out{out.version, sizeof(out.version), n}) != Member::Ok ||
      !parseVersion(out.version, parts)) {
    return Refusal::VersionFormat;
  }
  return Refusal::Ok;
}

/// The content checks — size, digest, signature encoding, path.
Refusal checkContent(const char* obj, size_t len, Offer& out) {
  if (devnet::json::unsignedMember(obj, len, "size", out.size) != Member::Ok || out.size < 1U ||
      out.size > targetMaxBytes(out.target)) {
    return Refusal::Size;
  }
  size_t n = 0U;
  if (devnet::json::stringMember(obj, len, "sha256", devnet::json::Out{out.sha256, sizeof(out.sha256), n}) !=
          Member::Ok ||
      n != 64U || !allOf(out.sha256, n, isLowerHex)) {
    return Refusal::Sha256Format;
  }
  if (devnet::json::stringMember(obj, len, "sig", devnet::json::Out{out.sig, sizeof(out.sig), n}) !=
          Member::Ok ||
      n != kSigB64Len || !allOf(out.sig, n, isB64Url)) {
    return Refusal::SigEncoding;
  }
  if (devnet::json::stringMember(obj, len, "path", devnet::json::Out{out.path, sizeof(out.path), n}) !=
          Member::Ok ||
      !pathOk(out.path, n)) {
    return Refusal::Path;
  }
  return Refusal::Ok;
}

} // namespace

uint32_t targetMaxBytes(const char* target) {
  if (target == nullptr) {
    return 0U;
  }
  if (strcmp(target, kTargetCourtBridge) == 0) {
    return kCourtBridgeMaxBytes;
  }
  if (strcmp(target, kTargetDoorGate) == 0) {
    return kDoorGateMaxBytes;
  }
  return 0U;
}

namespace {

/// One row per Refusal, in enumeration order: its corpus spelling, and the
/// `fw_error` it folds into. A table, not a switch — the same mapping with one
/// place to read it, and an index check instead of 21 branches.
struct RefusalWords {
  const char* name;
  const char* fwError;
};

// In FLASH on the ESP8266 (.rodata is RAM there): two pointers a row, read
// only as whole aligned words, which flash allows.
#if defined(ARDUINO_ARCH_ESP8266)
#define DEVOTA_WORDS_IN_FLASH __attribute__((section(".irom.text.devota_refusals")))
#else
#define DEVOTA_WORDS_IN_FLASH
#endif

constexpr RefusalWords kRefusalWords[] DEVOTA_WORDS_IN_FLASH = {
    {"ok", ""},
    {"missing_target", "http"},
    {"missing_version", "http"},
    {"missing_size", "http"},
    {"missing_sha256", "http"},
    {"missing_sig", "http"},
    {"missing_path", "http"},
    {"target_unknown", "target"},
    {"target_mismatch", "target"},
    {"version_format", "version"},
    {"running_unknown", "version"},
    {"failed_before", "version"},
    {"not_newer", "version"},
    {"size", "size"},
    {"sha256_format", "sha256"},
    {"sig_encoding", "sig"},
    {"sig_range", "sig"},
    {"sig", "sig"},
    {"path", "http"},
    {"sha256", "sha256"},
};

constexpr size_t kRefusalCount = sizeof(kRefusalWords) / sizeof(kRefusalWords[0]);
static_assert(kRefusalCount == static_cast<size_t>(Refusal::Sha256) + 1U,
              "every Refusal needs its row in kRefusalWords, in enumeration order");

} // namespace

const char* refusalName(Refusal refusal) {
  const size_t i = static_cast<size_t>(refusal);
  return i < kRefusalCount ? kRefusalWords[i].name : "unknown";
}

const char* fwErrorFor(Refusal refusal) {
  const size_t i = static_cast<size_t>(refusal);
  return i < kRefusalCount ? kRefusalWords[i].fwError : "http";
}

bool FailedList::contains(const char* version) const {
  if (version == nullptr) {
    return false;
  }
  for (uint8_t i = 0U; i < count && i < kMaxFailed; ++i) {
    if (strcmp(versions[i], version) == 0) {
      return true;
    }
  }
  return false;
}

void FailedList::add(const char* version) {
  if (version == nullptr || version[0] == '\0' || strlen(version) >= kVersionCap || contains(version)) {
    return;
  }
  if (count >= kMaxFailed) {
    for (uint8_t i = 1U; i < kMaxFailed; ++i) {
      memcpy(versions[i - 1U], versions[i], kVersionCap);
    }
    count = kMaxFailed - 1U;
  }
  memcpy(versions[count], version, strlen(version) + 1U);
  ++count;
}

bool parseVersion(const char* text, uint16_t out[3]) {
  if (text == nullptr) {
    return false;
  }
  const size_t n = strlen(text);
  size_t start = 0U;
  uint8_t part = 0U;
  for (size_t i = 0U; i <= n; ++i) {
    if (i == n || text[i] == '.') {
      if (part >= 3U || !versionPart(text + start, i - start, out[part])) {
        return false;
      }
      ++part;
      start = i + 1U;
    }
  }
  return part == 3U;
}

Refusal parseOffer(const char* otaObjectJson, size_t len, const char* ownTarget, Offer& out) {
  if (otaObjectJson == nullptr) {
    return Refusal::MissingTarget;
  }
  const Refusal missing = firstMissing(otaObjectJson, len);
  if (missing != Refusal::Ok) {
    return missing;
  }
  Offer staged;
  Refusal why = checkIdentity(otaObjectJson, len, ownTarget, staged);
  if (why == Refusal::Ok) {
    why = checkContent(otaObjectJson, len, staged);
  }
  if (why == Refusal::Ok) {
    out = staged;
  }
  return why;
}

Refusal acceptVersion(const char* running, const char* offered, const FailedList& failed) {
  uint16_t r[3] = {0U, 0U, 0U};
  uint16_t o[3] = {0U, 0U, 0U};
  if (!parseVersion(offered, o)) {
    return Refusal::VersionFormat;
  }
  if (!parseVersion(running, r)) {
    return Refusal::RunningUnknown;
  }
  if (failed.contains(offered)) {
    return Refusal::FailedBefore;
  }
  if (compareVersions(o, r) <= 0) {
    return Refusal::NotNewer;
  }
  return Refusal::Ok;
}

size_t manifestText(const char* target, const char* version, uint32_t size, const char* sha256Hex, char* out,
                    size_t cap) {
  if (target == nullptr || version == nullptr || sha256Hex == nullptr || out == nullptr || cap == 0U) {
    return 0U;
  }
  const int written = snprintf(out, cap, "%s\n%s\n%s\n%lu\n%s\n", kManifestMagic, target, version,
                               static_cast<unsigned long>(size), sha256Hex);
  if (written < 0 || static_cast<size_t>(written) >= cap) {
    out[0] = '\0';
    return 0U;
  }
  return static_cast<size_t>(written);
}

size_t manifestText(const Offer& offer, char* out, size_t cap) {
  return manifestText(offer.target, offer.version, offer.size, offer.sha256, out, cap);
}

Refusal verifySignature(const char* text, size_t textLen, const char* sigB64,
                        const uint8_t modulus[dc::kRsa2048Bytes], dc::RsaWorkspace& work) {
  if (sigB64 == nullptr || strlen(sigB64) != kSigB64Len || !allOf(sigB64, kSigB64Len, isB64Url)) {
    return Refusal::SigEncoding;
  }
  uint8_t sig[dc::kRsa2048Bytes];
  size_t n = 0U;
  if (!dc::b64url::decode(sigB64, kSigB64Len, sig, sizeof(sig), &n) || n != dc::kRsa2048Bytes) {
    return Refusal::SigEncoding;
  }
  if (modulus == nullptr || !dc::rsa2048InRange(modulus, sig)) {
    return Refusal::SigRange;
  }
  uint8_t digest[dc::kSha256Bytes];
  dc::sha256(reinterpret_cast<const uint8_t*>(text), textLen, digest);
  return dc::rsa2048VerifySha256(modulus, digest, sig, work) ? Refusal::Ok : Refusal::Sig;
}

Refusal verifySignature(const char* text, size_t textLen, const char* sigB64,
                        const uint8_t modulus[dc::kRsa2048Bytes]) {
  // Its own workspace, in THIS function: a board that only ever lends one
  // (the bridge) links none of it (--gc-sections).
  static dc::RsaWorkspace own;
  return verifySignature(text, textLen, sigB64, modulus, own);
}

Refusal verifyStaged(const Offer& offer, const uint8_t imageSha256[32], uint32_t bytes,
                     const uint8_t modulus[dc::kRsa2048Bytes], dc::RsaWorkspace& work) {
  if (bytes != offer.size) {
    return Refusal::Size;
  }
  char hex[kShaHexCap] = {};
  if (imageSha256 == nullptr || !dc::hex::encodeLower(imageSha256, 32U, hex, sizeof(hex)) ||
      strcmp(hex, offer.sha256) != 0) {
    return Refusal::Sha256;
  }
  char text[kManifestCap] = {};
  const size_t n = manifestText(offer, text, sizeof(text));
  if (n == 0U) {
    return Refusal::Size;
  }
  return verifySignature(text, n, offer.sig, modulus, work);
}

Refusal verifyStaged(const Offer& offer, const uint8_t imageSha256[32], uint32_t bytes,
                     const uint8_t modulus[dc::kRsa2048Bytes]) {
  static dc::RsaWorkspace own;
  return verifyStaged(offer, imageSha256, bytes, modulus, own);
}

bool parseModulusHex(const char* hex, uint8_t out[dc::kRsa2048Bytes]) {
  if (hex == nullptr || out == nullptr || strlen(hex) != dc::kRsa2048Bytes * 2U) {
    return false;
  }
  size_t n = 0U;
  uint8_t staged[dc::kRsa2048Bytes];
  if (!dc::hex::decode(hex, dc::kRsa2048Bytes * 2U, staged, sizeof(staged), &n) || n != dc::kRsa2048Bytes) {
    return false;
  }
  memcpy(out, staged, sizeof(staged));
  return true;
}

Probation::Decision Probation::atBoot(uint8_t bootsInProbation) {
  return bootsInProbation > kMaxResets ? Decision::RollBack : Decision::None;
}

void Probation::begin(uint32_t nowMs, uint32_t windowMs) {
  startedMs_ = nowMs;
  windowMs_ = windowMs;
  active_ = true;
}

Probation::Decision Probation::tick(uint32_t nowMs, bool proven) {
  if (!active_) {
    return Decision::None;
  }
  if (proven) {
    active_ = false;
    return Decision::Commit;
  }
  if (tb::since(nowMs, startedMs_) >= windowMs_) {
    active_ = false;
    return Decision::RollBack;
  }
  return Decision::None;
}

} // namespace devota
