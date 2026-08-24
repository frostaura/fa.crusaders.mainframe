// Value types for the discovery beacon. See include/discovery/Beacon.h for why
// there is no public field setter.

#include "discovery/Beacon.h"

#include <string.h>

#include "devcrypto/RequestSigner.h"

namespace discovery {
namespace {

/// Wire names for DecodeError, indexed by the enum value, and identical to the
/// `error` strings in src/contracts/device-protocol/discovery/cases.json. Kept
/// as a table rather than a switch so a new error cannot be added without also
/// giving it a name the corpus can refer to.
constexpr const char* kErrorNames[] = {"",          "bad_magic", "bad_checksum",
                                       "bad_frame", "bad_verb",  "duplicate_key"};

constexpr size_t kErrorNameCount = sizeof(kErrorNames) / sizeof(kErrorNames[0]);

static_assert(kErrorNameCount == 6, "kErrorNames must cover every DecodeError");

/// Indexed by Verb, so Verb::Unknown's "" is at 0.
constexpr const char* kVerbNames[] = {"", "ANNOUNCE", "OFFER"};

static_assert(sizeof(kVerbNames) / sizeof(kVerbNames[0]) == kVerbCount, "kVerbNames must cover every Verb");

bool sameText(const char* a, const char* b) {
  while (*a != '\0' && *a == *b) {
    ++a;
    ++b;
  }
  return *a == *b;
}

bool present(const char* s) {
  return s != nullptr && s[0] != '\0';
}

} // namespace

const char* errorName(DecodeError e) {
  const size_t i = static_cast<size_t>(e);
  return i < kErrorNameCount ? kErrorNames[i] : "";
}

const char* verbName(Verb v) {
  const size_t i = static_cast<size_t>(v);
  return i < kVerbCount ? kVerbNames[i] : "";
}

Verb verbFromName(const char* name) {
  if (name == nullptr || name[0] == '\0') {
    return Verb::Unknown;
  }
  for (size_t i = 1; i < kVerbCount; ++i) {
    if (sameText(kVerbNames[i], name)) {
      return static_cast<Verb>(i);
    }
  }
  return Verb::Unknown;
}

Packet::Packet() : verb_(Verb::Unknown), count_(0), keys_(), values_() {
}

Packet Packet::ofVerb(Verb v) {
  Packet p;
  p.verb_ = v;
  return p;
}

const char* Packet::key(uint8_t i) const {
  return i < count_ ? keys_[i] : "";
}

const char* Packet::value(uint8_t i) const {
  return i < count_ ? values_[i] : "";
}

const char* Packet::find(const char* name) const {
  if (name == nullptr) {
    return nullptr;
  }
  for (uint8_t i = 0; i < count_; ++i) {
    if (sameText(keys_[i], name)) {
      return values_[i];
    }
  }
  return nullptr;
}

bool Packet::addBounded(const char* name, const char* text, size_t textLen) {
  if (count_ >= kMaxFields || !present(name) || text == nullptr || textLen == 0) {
    return false;
  }
  const size_t nameLen = strlen(name);
  if (nameLen > kMaxKeyLen || textLen > kMaxValueLen) {
    return false;
  }
  if (has(name)) {
    // Same rule as the decoder's duplicate_key: a second value for a key is not
    // something a sender means, and last-wins would make which one arrives
    // depend on construction order.
    return false;
  }
  memcpy(keys_[count_], name, nameLen);
  keys_[count_][nameLen] = '\0';
  memcpy(values_[count_], text, textLen);
  values_[count_][textLen] = '\0';
  count_ = static_cast<uint8_t>(count_ + 1U);
  return true;
}

bool Packet::add(const char* name, const char* text) {
  return text != nullptr && addBounded(name, text, strlen(text));
}

bool Packet::addUnsigned(const char* name, uint64_t v) {
  char digits[dc::signer::kMaxUnsignedDigits + 1];
  const size_t n = dc::signer::formatUnsigned(v, digits, sizeof(digits));
  return n != 0 && addBounded(name, digits, n);
}

bool Packet::addIdentity(const Identity& id) {
  bool ok = add("v", kProtocolVersion);
  ok = ok && add("mac", id.mac);
  ok = ok && add("hw", id.hardware);
  ok = ok && add("fw", id.firmware);
  if (present(id.megaFirmware)) {
    // Omitted, not blanked, when the Mega has not answered yet. `mega=` would
    // claim the ATmega reported an empty version.
    ok = ok && add("mega", id.megaFirmware);
  }
  return ok;
}

/// One `key=value` token. The FIRST '=' separates, so a value may contain '=' —
/// a URL with a query string does, and quoting the wire to avoid that would be
/// a second escaping scheme for two implementations to disagree about.
DecodeError Packet::addToken(const char* token, size_t len, Packet& out) {
  size_t eq = 0;
  while (eq < len && token[eq] != '=') {
    ++eq;
  }
  if (len == 0 || eq == len || eq == 0 || eq + 1 == len) {
    // No '=', an empty key, an empty value, or an empty token from a doubled
    // space. An empty value is refused rather than stored: `mega=` would assert
    // that the ATmega reported a blank version, which is not the same fact as
    // the field being absent.
    return DecodeError::BadFrame;
  }
  if (eq > kMaxKeyLen) {
    return DecodeError::BadFrame;
  }

  char name[kMaxKeyLen + 1];
  memcpy(name, token, eq);
  name[eq] = '\0';
  if (out.has(name)) {
    // Distinguished from the capacity failures below because it is the one a
    // human caused: two `st` values is a sender bug, not a full buffer.
    return DecodeError::DuplicateKey;
  }
  return out.addBounded(name, token + eq + 1, len - eq - 1) ? DecodeError::None : DecodeError::BadFrame;
}

DecodeError Packet::fill(const char* body, size_t len, Packet& out) {
  size_t start = 0;
  for (size_t i = 0; i <= len; ++i) {
    if (i != len && body[i] != ' ') {
      continue;
    }
    const DecodeError e = addToken(body + start, i - start, out);
    if (e != DecodeError::None) {
      return e;
    }
    start = i + 1;
  }
  return DecodeError::None;
}

Packet Packet::announceUnclaimed(const Identity& id, const char* nonceHex, const ClaimCommitment& commitment,
                                 uint32_t uptimeSeconds) {
  Packet p = ofVerb(Verb::Announce);
  bool ok = !commitment.empty();
  ok = ok && p.addIdentity(id);
  ok = ok && p.add("st", "unclaimed");
  ok = ok && p.add("n", nonceHex);
  ok = ok && p.add("cch", commitment.hex());
  ok = ok && p.addUnsigned("up", uptimeSeconds);
  // All or nothing, like the serial encoder: a half-built beacon that still
  // encodes is a board that appears in the admin's list and cannot be claimed.
  return ok ? p : Packet();
}

Packet Packet::announceClaimed(const Identity& id, const char* nonceHex, const char* deviceId,
                               const char* tenantSlug, uint32_t uptimeSeconds) {
  Packet p = ofVerb(Verb::Announce);
  bool ok = p.addIdentity(id);
  ok = ok && p.add("st", "claimed");
  ok = ok && p.add("n", nonceHex);
  ok = ok && p.add("dev", deviceId);
  ok = ok && p.add("ten", tenantSlug);
  ok = ok && p.addUnsigned("up", uptimeSeconds);
  return ok ? p : Packet();
}

bool Packet::shouldAnnounceClaimed(bool provisioned, const char* deviceId, const char* tenantSlug) {
  return provisioned && deviceId != nullptr && deviceId[0] != '\0' && tenantSlug != nullptr &&
         tenantSlug[0] != '\0';
}

Packet Packet::offer(const char* url, uint64_t unixSeconds, const char* nonceHex) {
  Packet p = ofVerb(Verb::Offer);
  bool ok = p.add("v", kProtocolVersion);
  ok = ok && p.add("url", url);
  ok = ok && p.addUnsigned("t", unixSeconds);
  ok = ok && p.add("n", nonceHex);
  return ok ? p : Packet();
}

} // namespace discovery
