#include "devnet/Net.h"

#include <string.h>

#include "devnet/JsonMember.h"
#include "timebase/TimeBase.h"

namespace devnet {
namespace {

bool isDigit(char c) {
  return c >= '0' && c <= '9';
}

bool isLabelChar(char c) {
  return (c >= 'a' && c <= 'z') || isDigit(c) || c == '-';
}

/// One dotted-quad octet: 0, or 1–255 with no leading zero.
bool octet(const char* s, size_t n) {
  if (n == 0U || n > 3U || (n > 1U && s[0] == '0')) {
    return false;
  }
  uint32_t v = 0U;
  for (size_t i = 0U; i < n; ++i) {
    if (!isDigit(s[i])) {
      return false;
    }
    v = (v * 10U) + static_cast<uint32_t>(s[i] - '0');
  }
  return v <= 255U;
}

bool isIpv4(const char* host, size_t n) {
  size_t start = 0U;
  uint8_t parts = 0U;
  for (size_t i = 0U; i <= n; ++i) {
    if (i == n || host[i] == '.') {
      if (!octet(host + start, i - start)) {
        return false;
      }
      ++parts;
      start = i + 1U;
    }
  }
  return parts == 4U;
}

/// Lowercase DNS name: labels of [a-z0-9-], 1–63 long, not starting or ending
/// with a hyphen, separated by single dots — and not made only of digits and
/// dots, which would be an IPv4 literal that failed its own grammar.
bool isName(const char* host, size_t n) {
  size_t start = 0U;
  bool sawNonDigit = false;
  for (size_t i = 0U; i <= n; ++i) {
    if (i == n || host[i] == '.') {
      const size_t label = i - start;
      if (label == 0U || label > 63U || host[start] == '-' || host[i - 1U] == '-') {
        return false;
      }
      start = i + 1U;
      continue;
    }
    if (!isLabelChar(host[i])) {
      return false;
    }
    if (!isDigit(host[i])) {
      sawNonDigit = true;
    }
  }
  return sawNonDigit;
}

/// A character `BASE_RE` admits in the host part.
bool isHostChar(char c) {
  return c != ':' && c != '/' && c != '?' && c != '#' && c != '@' && c != ' ' && c != '\t' && c != '\r' &&
         c != '\n' && c != '\f' && c != '\v' && c != '\0';
}

Refusal checkPort(const char* port, size_t n) {
  if (port[0] == '0') {
    return Refusal::Port;
  }
  uint32_t v = 0U;
  for (size_t i = 0U; i < n; ++i) {
    v = (v * 10U) + static_cast<uint32_t>(port[i] - '0');
  }
  return (v >= 1U && v <= 65535U) ? Refusal::Ok : Refusal::Port;
}

/// A base-URL grammar refusal as the `net` object's own reason (`host` becomes
/// `base_host`). Empty..Port and BaseEmpty..BasePort are the same six reasons in
/// the same order, which the static_asserts hold; anything else is returned as is.
Refusal prefixed(Refusal base) {
  static_assert(static_cast<int>(Refusal::Port) - static_cast<int>(Refusal::Empty) ==
                    static_cast<int>(Refusal::BasePort) - static_cast<int>(Refusal::BaseEmpty),
                "the base_* reasons must mirror the base-URL reasons one for one");
  const int i = static_cast<int>(base);
  if (i < static_cast<int>(Refusal::Empty) || i > static_cast<int>(Refusal::Port)) {
    return base;
  }
  return static_cast<Refusal>(static_cast<int>(Refusal::BaseEmpty) + (i - static_cast<int>(Refusal::Empty)));
}

bool printableAscii(const char* s, size_t n) {
  for (size_t i = 0U; i < n; ++i) {
    const uint8_t c = static_cast<uint8_t>(s[i]);
    if (c < 0x20U || c > 0x7EU) {
      return false;
    }
  }
  return true;
}

/// An SSID's bytes: no control byte and no DEL. Anything at or above 0x80 is
/// UTF-8 the escape decoder produced, and is allowed.
bool ssidBytesOk(const char* s, size_t n) {
  for (size_t i = 0U; i < n; ++i) {
    const uint8_t c = static_cast<uint8_t>(s[i]);
    if (c < 0x20U || c == 0x7FU) {
      return false;
    }
  }
  return true;
}

/// A decoded SSID the board can join: 1..32 bytes, no control byte.
bool ssidOk(json::Member m, const char* ssid, size_t n) {
  return m == json::Member::Ok && n >= 1U && n <= kSsidMax && ssidBytesOk(ssid, n);
}

/// A decoded password: open (empty) or 8..63 printable ASCII characters.
bool pskOk(const char* psk, size_t n) {
  return printableAscii(psk, n) && (n == 0U || (n >= kPskMin && n <= kPskMax));
}

/// A member that is missing or a JSON null — the reference implementation's None.
bool absent(json::Member m, const char* obj, size_t len, const char* key) {
  return m == json::Member::Missing || (m == json::Member::WrongType && json::isNullMember(obj, len, key));
}

/// One `wifi<slot>_*` pair. `present` false (and Ok) when neither key is there
/// or both are null — the slot is kept as the board has it.
Refusal readProfile(const char* obj, size_t len, uint8_t slot, Profile& out, bool& present) {
  char ssidKey[12] = "wifi0_ssid";
  char pskKey[12] = "wifi0_psk";
  ssidKey[4] = static_cast<char>('0' + slot);
  pskKey[4] = static_cast<char>('0' + slot);

  // Decoded with headroom past the bound, so "too long" is a length check and
  // not a buffer that happened to be full.
  char ssid[(kSsidMax * 2U) + 2U] = {};
  char psk[(kPskMax * 2U) + 2U] = {};
  size_t ssidLen = 0U;
  size_t pskLen = 0U;
  const json::Member s = json::stringMember(obj, len, ssidKey, json::Out{ssid, sizeof(ssid), ssidLen});
  const json::Member p = json::stringMember(obj, len, pskKey, json::Out{psk, sizeof(psk), pskLen});
  const bool pskAbsent = absent(p, obj, len, pskKey);
  present = false;
  if (absent(s, obj, len, ssidKey) && pskAbsent) {
    return Refusal::Ok;
  }
  if (!ssidOk(s, ssid, ssidLen)) {
    return slot == 0U ? Refusal::Wifi0Ssid : Refusal::Wifi1Ssid;
  }
  if (pskAbsent) {
    psk[0] = '\0';
    pskLen = 0U;
  }
  if ((!pskAbsent && p != json::Member::Ok) || !pskOk(psk, pskLen)) {
    return slot == 0U ? Refusal::Wifi0Psk : Refusal::Wifi1Psk;
  }
  memcpy(out.ssid, ssid, ssidLen + 1U);
  memcpy(out.psk, psk, pskLen + 1U);
  present = true;
  return Refusal::Ok;
}

bool keyIdOk(const char* id, size_t n) {
  if (n < 2U || n > 7U || id[0] != 'k' || id[1] < '1' || id[1] > '9') {
    return false;
  }
  for (size_t i = 2U; i < n; ++i) {
    if (!isDigit(id[i])) {
      return false;
    }
  }
  return true;
}

bool keyOk(const char* key, size_t n) {
  if (n != kKeyLen) {
    return false;
  }
  for (size_t i = 0U; i < n; ++i) {
    const char c = key[i];
    const bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || isDigit(c) || c == '-' || c == '_';
    if (!ok) {
      return false;
    }
  }
  return true;
}

} // namespace

namespace {

/// The corpus spelling of each Refusal, in enumeration order. `NetEmpty` is the
/// `nets` family's "empty" — the same word as the base URL's, by the corpus.
constexpr const char* kRefusalNames[] = {
    "ok",           "empty",     "too_long",  "https",      "grammar",       "host",
    "port",         "ver",       "not_newer", "base_empty", "base_too_long", "base_https",
    "base_grammar", "base_host", "base_port", "wifi0_ssid", "wifi0_psk",     "wifi1_ssid",
    "wifi1_psk",    "empty",     "id",        "key",        "current",       "held",
};

constexpr size_t kRefusalNameCount = sizeof(kRefusalNames) / sizeof(kRefusalNames[0]);
static_assert(kRefusalNameCount == static_cast<size_t>(Refusal::Held) + 1U,
              "every Refusal needs its name in kRefusalNames, in enumeration order");

/// The host and optional `:port` after `http://`: Grammar when the shape is wrong.
Refusal checkHostAndPort(const char* host) {
  size_t hostLen = 0U;
  while (isHostChar(host[hostLen])) {
    ++hostLen;
  }
  if (hostLen == 0U) {
    return Refusal::Grammar;
  }
  const char* rest = host + hostLen;
  size_t portLen = 0U;
  if (rest[0] == ':') {
    while (isDigit(rest[1U + portLen])) {
      ++portLen;
    }
    if (portLen == 0U || portLen > 5U || rest[1U + portLen] != '\0') {
      return Refusal::Grammar;
    }
  } else if (rest[0] != '\0') {
    return Refusal::Grammar;
  }
  if (!isIpv4(host, hostLen) && !isName(host, hostLen)) {
    return Refusal::Host;
  }
  return portLen == 0U ? Refusal::Ok : checkPort(rest + 1, portLen);
}

} // namespace

const char* refusalName(Refusal refusal) {
  const size_t i = static_cast<size_t>(refusal);
  return i < kRefusalNameCount ? kRefusalNames[i] : "unknown";
}

Refusal checkBaseUrl(const char* url) {
  if (url == nullptr || url[0] == '\0') {
    return Refusal::Empty;
  }
  if (strlen(url) > kBaseUrlMax) {
    return Refusal::TooLong;
  }
  if (strncmp(url, "https://", 8U) == 0) {
    return Refusal::Https;
  }
  if (strncmp(url, "http://", 7U) != 0) {
    return Refusal::Grammar;
  }
  return checkHostAndPort(url + 7);
}

NetResult adoptNet(const char* netObjectJson, size_t len, uint32_t appliedVer, NetSet& out) {
  NetResult result;
  NetSet staged;
  uint32_t ver = 0U;
  if (json::unsignedMember(netObjectJson, len, "ver", ver) != json::Member::Ok || ver < 1U ||
      ver > 2147483647UL) {
    result.reason = Refusal::Ver;
    return result;
  }
  if (ver <= appliedVer) {
    result.reason = Refusal::NotNewer;
    return result;
  }
  staged.ver = ver;

  char base[(kBaseUrlMax * 2U) + 2U] = {};
  size_t baseLen = 0U;
  const json::Member b =
      json::stringMember(netObjectJson, len, "base", json::Out{base, sizeof(base), baseLen});
  if (b != json::Member::Missing) {
    // Present but not a string (null included) reads as no URL at all, as the
    // reference implementation's `base_url(None)` does: `base_empty`.
    const Refusal why = b == json::Member::Ok
                            ? checkBaseUrl(base)
                            : (b == json::Member::Unreadable ? Refusal::TooLong : Refusal::Empty);
    if (why != Refusal::Ok) {
      result.reason = prefixed(why);
      return result;
    }
    memcpy(staged.base, base, baseLen + 1U);
    staged.hasBase = true;
  }

  for (uint8_t slot = 0U; slot < kProfiles; ++slot) {
    bool present = false;
    const Refusal why = readProfile(netObjectJson, len, slot, staged.wifi[slot], present);
    if (why != Refusal::Ok) {
      result.reason = why;
      return result;
    }
    staged.hasWifi[slot] = present;
  }
  if (!staged.hasBase && !staged.hasWifi[0] && !staged.hasWifi[1]) {
    result.reason = Refusal::NetEmpty;
    return result;
  }
  out = staged;
  return result;
}

Refusal adoptKeyNext(const char* keyNextJson, size_t len, const KeyRing& ring, KeyRing& out) {
  out = ring;
  char id[16] = {};
  size_t idLen = 0U;
  if (json::stringMember(keyNextJson, len, "id", json::Out{id, sizeof(id), idLen}) != json::Member::Ok ||
      !keyIdOk(id, idLen)) {
    return Refusal::Id;
  }
  char key[kKeyLen + 8U] = {};
  size_t keyLen = 0U;
  if (json::stringMember(keyNextJson, len, "key", json::Out{key, sizeof(key), keyLen}) != json::Member::Ok ||
      !keyOk(key, keyLen)) {
    return Refusal::Key;
  }
  if (strcmp(id, ring.currentId) == 0) {
    return Refusal::Current;
  }
  if (ring.hasPrevious && strcmp(id, ring.previousId) == 0) {
    return Refusal::Held;
  }
  KeyRing next;
  memcpy(next.currentId, id, idLen + 1U);
  memcpy(next.currentKey, key, keyLen + 1U);
  next.hasPrevious = ring.currentKey[0] != '\0';
  memcpy(next.previousId, ring.currentId, sizeof(next.previousId));
  memcpy(next.previousKey, ring.currentKey, sizeof(next.previousKey));
  out = next;
  return Refusal::Ok;
}

const char* actionName(Action action) {
  switch (action) {
  case Action::None:
    return "none";
  case Action::ReconnectNextProfile:
    return "reconnect_next_profile";
  case Action::Restart:
    return "restart";
  }
  return "none";
}

Action supervise(uint32_t downS, uint32_t sinceAttemptS, uint32_t attempts) {
  if (downS >= kSupervisorRestartS) {
    return Action::Restart;
  }
  if (downS < kSupervisorGraceS) {
    return Action::None;
  }
  if (attempts != 0U) {
    const uint32_t step =
        attempts - 1U < kSupervisorBackoffSteps ? attempts - 1U : kSupervisorBackoffSteps - 1U;
    if (sinceAttemptS < kSupervisorBackoffS[step]) {
      return Action::None;
    }
  }
  return Action::ReconnectNextProfile;
}

uint32_t Supervisor::downSeconds(uint32_t nowMs) const {
  return down_ ? tb::since(nowMs, downSinceMs_) / 1000U : 0U;
}

Action Supervisor::tick(uint32_t nowMs, bool linkUp) {
  if (linkUp) {
    down_ = false;
    attempts_ = 0U;
    return Action::None;
  }
  if (!down_) {
    down_ = true;
    downSinceMs_ = nowMs;
    lastAttemptMs_ = nowMs;
  }
  const uint32_t downS = tb::since(nowMs, downSinceMs_) / 1000U;
  const uint32_t sinceS = tb::since(nowMs, lastAttemptMs_) / 1000U;
  const Action action = supervise(downS, sinceS, attempts_);
  if (action == Action::ReconnectNextProfile) {
    ++attempts_;
    lastAttemptMs_ = nowMs;
  } else if (action == Action::Restart) {
    // Restart once: the caller restarts the chip, and a caller that cannot (a
    // host test, the simulator) gets a fresh outage rather than a restart per
    // tick.
    down_ = false;
    attempts_ = 0U;
  }
  return action;
}

} // namespace devnet
