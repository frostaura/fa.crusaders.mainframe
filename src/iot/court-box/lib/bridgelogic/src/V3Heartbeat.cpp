// See include/bridgelogic/V3Heartbeat.h and docs/specs/device-api.md §3-§5, §11.2.

#include "bridgelogic/V3Heartbeat.h"

#include <string.h>

#include "devapi/Json.h"
#include "devlink/CodeSync.h"
#include "protocol/Protocol.h"
#include "timebase/TimeBase.h"

namespace bridgelogic {

namespace {

namespace json = devapi::json;

/// "123" -> 123; false on anything else (no sign, no space, no overflow).
bool parseDigits(const char* s, size_t n, uint32_t& out) {
  if (n == 0U || n > 10U) {
    return false;
  }
  uint64_t v = 0U;
  for (size_t i = 0U; i < n; ++i) {
    if (s[i] < '0' || s[i] > '9') {
      return false;
    }
    v = v * 10U + static_cast<uint64_t>(s[i] - '0');
  }
  if (v > 0xFFFFFFFFULL) {
    return false;
  }
  out = static_cast<uint32_t>(v);
  return true;
}

bool isHex(char c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
}

/// The first five `|`-fields of one element; any after them are ignored.
bool parseCourtElement(const char* s, size_t n, SnapshotCourt& out) {
  size_t fieldStart[5] = {0U, 0U, 0U, 0U, 0U};
  size_t fieldLen[5] = {0U, 0U, 0U, 0U, 0U};
  uint8_t field = 0U;
  size_t start = 0U;
  for (size_t i = 0U; i <= n && field < 5U; ++i) {
    if (i == n || s[i] == '|') {
      fieldStart[field] = start;
      fieldLen[field] = i - start;
      ++field;
      start = i + 1U;
    }
  }
  if (field < 5U) {
    return false;
  }
  uint32_t relay = 0U;
  uint32_t lit = 0U;
  uint32_t seconds = 0U;
  if (!parseDigits(s + fieldStart[0], fieldLen[0], relay) || relay >= kSnapshotRelays ||
      !parseDigits(s + fieldStart[1], fieldLen[1], lit) || lit > 1U ||
      !parseDigits(s + fieldStart[2], fieldLen[2], seconds) || fieldLen[3] != 1U) {
    return false;
  }
  const char kind = s[fieldStart[3]];
  if (kind != 'b' && kind != 'w' && kind != 'e' && kind != '-') {
    // An unknown kind is a later server's word for "lit, some other reason";
    // the light is what matters, so it reads as a booking.
    out.kind = 'b';
  } else {
    out.kind = kind;
  }
  const char* ref = s + fieldStart[4];
  const size_t refLen = fieldLen[4];
  if (refLen == 1U && ref[0] == '-') {
    out.ref[0] = '\0';
  } else if (refLen == 8U) {
    for (size_t i = 0U; i < 8U; ++i) {
      if (!isHex(ref[i])) {
        return false;
      }
      out.ref[i] = ref[i];
    }
    out.ref[8] = '\0';
  } else {
    return false;
  }
  out.relay = static_cast<uint8_t>(relay);
  out.lit = lit == 1U;
  out.seconds = out.lit ? seconds : 0U;
  return true;
}

/// One `!CFG` key's place in the set and its bounds, the Mega's own.
struct CfgSpec {
  const char* mega;
  uint16_t min;
  uint16_t max;
  uint16_t boot;
};

// Hardware first (in force before any relay frame after a !BOOT), then KEYS,
// then the display keys.
const CfgSpec kSpecs[kMegaCfgKeys] = {
    {"RPOL", 0U, 1U, 0U},       {"LCDA", 0U, 63U, 0U},     {"SBAUD", 0U, 5U, 0U},     {"SSUF", 0U, 1U, 0U},
    {"SGAP", 50U, 500U, 150U},  {"KEYS", 0U, 255U, 15U},   {"LAYOUT", 0U, 1U, 0U},    {"MARQ", 0U, 1U, 1U},
    {"STEP", 250U, 1000U, 400U}, {"PAGE", 2U, 15U, 4U},     {"CEIL", 15U, 120U, 60U},  {"DWELL", 0U, 10U, 3U},
    {"AFTON", 5U, 60U, 15U},    {"REINIT", 30U, 600U, 60U}, {"HINT", 1U, 10U, 3U},     {"SCANH", 3U, 60U, 10U},
    {"CAP", 90U, 720U, 240U},
};

uint16_t clampTo(uint32_t v, uint16_t lo, uint16_t hi) {
  return v < lo ? lo : (v > hi ? hi : static_cast<uint16_t>(v));
}

/// A numeric config key into the Mega key `mega`, clamped by the Mega's
/// bounds. Absent: unchanged. Present and not a bare integer: drift.
void readNumber(const char* obj, size_t len, const char* key, const char* mega, MegaConfig& out, Drift& drift) {
  if (json::findTopLevelKey(obj, len, key) == json::kNotFound) {
    return;
  }
  uint32_t v = 0U;
  if (!json::topLevelUnsignedField(obj, len, key, v)) {
    char name[Drift::kNameLen] = "config.";
    strncat(name, key, sizeof(name) - strlen(name) - 1U);
    drift.add(name);
    return;
  }
  for (uint8_t i = 0U; i < kMegaCfgKeys; ++i) {
    if (strcmp(kSpecs[i].mega, mega) == 0) {
      setCfg(out, mega, clampTo(v, kSpecs[i].min, kSpecs[i].max));
    }
  }
}

void noteDrift(Drift& drift, const char* key) {
  char name[Drift::kNameLen] = "config.";
  strncat(name, key, sizeof(name) - strlen(name) - 1U);
  drift.add(name);
}

/// A string key with an enumerated value; `index` of the matching value, or
/// -1 when absent (no change) and -2 when present but unknown or not a string.
int readEnum(const char* obj, size_t len, const char* key, const char* const* values, uint8_t count) {
  if (json::findTopLevelKey(obj, len, key) == json::kNotFound) {
    return -1;
  }
  char v[16] = {};
  if (!json::topLevelStringField(obj, len, key, v, sizeof(v))) {
    return -2;
  }
  for (uint8_t i = 0U; i < count; ++i) {
    if (strcmp(v, values[i]) == 0) {
      return i;
    }
  }
  return -2;
}

void readDisplay(const char* obj, size_t len, MegaConfig& out, Drift& drift) {
  static const char* const kLayouts[2] = {"compact", "expanded"};
  const int layout = readEnum(obj, len, "lcd_layout", kLayouts, 2U);
  if (layout >= 0) {
    setCfg(out, "LAYOUT", static_cast<uint16_t>(layout));
  } else if (layout == -2) {
    // Unknown is compact: compact is right on any doubt.
    setCfg(out, "LAYOUT", 0U);
    noteDrift(drift, "lcd_layout");
  }
  if (json::findTopLevelKey(obj, len, "lcd_marquee_enabled") != json::kNotFound) {
    bool marq = true;
    if (json::topLevelBoolField(obj, len, "lcd_marquee_enabled", marq)) {
      setCfg(out, "MARQ", marq ? 1U : 0U);
    } else {
      noteDrift(drift, "lcd_marquee_enabled");
    }
  }
  readNumber(obj, len, "lcd_marquee_step_ms", "STEP", out, drift);
  readNumber(obj, len, "lcd_landing_page_seconds", "PAGE", out, drift);
  readNumber(obj, len, "lcd_screen_ceiling_seconds", "CEIL", out, drift);
  readNumber(obj, len, "lcd_landing_dwell_seconds", "DWELL", out, drift);
  readNumber(obj, len, "lcd_after_lights_on_seconds", "AFTON", out, drift);
  readNumber(obj, len, "lcd_reinit_seconds", "REINIT", out, drift);
  readNumber(obj, len, "lcd_hint_seconds", "HINT", out, drift);
  readNumber(obj, len, "lcd_revert_seconds", "SCANH", out, drift);
  readNumber(obj, len, "relay_authorisation_cap_minutes", "CAP", out, drift);
}

uint16_t baudCode(uint32_t baud) {
  return baud == 0U        ? 0U
         : baud == 9600U   ? 1U
         : baud == 19200U  ? 2U
         : baud == 38400U  ? 3U
         : baud == 57600U  ? 4U
         : baud == 115200U ? 5U
                           : 0xFFFFU;
}

bool lcdAddressAllowed(uint32_t v) {
  return v == 0U || (v >= 0x20U && v <= 0x27U) || (v >= 0x38U && v <= 0x3FU);
}

void readHardware(const char* obj, size_t len, MegaConfig& out, Drift& drift) {
  static const char* const kLevels[2] = {"high", "low"};
  static const char* const kEnds[2] = {"auto", "crlf"};
  const int level = readEnum(obj, len, "hw_relay_active_level", kLevels, 2U);
  if (level >= 0) {
    setCfg(out, "RPOL", static_cast<uint16_t>(level));
  } else if (level == -2) {
    noteDrift(drift, "hw_relay_active_level"); // unknown: no change
  }
  if (json::findTopLevelKey(obj, len, "hw_lcd_i2c_address") != json::kNotFound) {
    uint32_t a = 0U;
    if (json::topLevelUnsignedField(obj, len, "hw_lcd_i2c_address", a) && lcdAddressAllowed(a)) {
      setCfg(out, "LCDA", static_cast<uint16_t>(a));
    } else {
      noteDrift(drift, "hw_lcd_i2c_address");
    }
  }
  if (json::findTopLevelKey(obj, len, "hw_scanner_baud") != json::kNotFound) {
    uint32_t b = 0U;
    const uint16_t code = json::topLevelUnsignedField(obj, len, "hw_scanner_baud", b) ? baudCode(b) : 0xFFFFU;
    if (code != 0xFFFFU) {
      setCfg(out, "SBAUD", code);
    } else {
      noteDrift(drift, "hw_scanner_baud");
    }
  }
  const int end = readEnum(obj, len, "hw_scanner_line_end", kEnds, 2U);
  if (end >= 0) {
    setCfg(out, "SSUF", static_cast<uint16_t>(end));
  } else if (end == -2) {
    noteDrift(drift, "hw_scanner_line_end");
  }
  readNumber(obj, len, "hw_scanner_gap_ms", "SGAP", out, drift);
}

} // namespace

void Drift::add(const char* name) {
  for (uint8_t i = 0U; i < count; ++i) {
    if (strcmp(names[i], name) == 0) {
      return;
    }
  }
  if (count >= kMax) {
    return;
  }
  strncpy(names[count], name, kNameLen - 1U);
  names[count][kNameLen - 1U] = '\0';
  ++count;
}

ReadResult readSnapshot(const char* body, size_t len, Snapshot& out, uint32_t nowMs) {
  size_t at = json::findTopLevelArray(body, len, "courts");
  if (at == json::kNotFound) {
    return json::findTopLevelKey(body, len, "courts") == json::kNotFound ? ReadResult::Absent
                                                                          : ReadResult::Unreadable;
  }
  Snapshot next;
  size_t start = 0U;
  size_t n = 0U;
  bool isString = false;
  bool bad = false;
  while (devlink::detail::nextArrayElement(body, len, at, start, n, isString)) {
    SnapshotCourt c;
    if (!isString || next.count >= kSnapshotRelays || !parseCourtElement(body + start, n, c)) {
      bad = true;
      continue;
    }
    next.courts[next.count] = c;
    ++next.count;
  }
  if (bad) {
    return ReadResult::Unreadable;
  }
  next.atMs = nowMs;
  next.valid = true;
  out = next;
  return ReadResult::Adopted;
}

MegaConfig defaultMegaConfig() {
  MegaConfig c;
  for (uint8_t i = 0U; i < kMegaCfgKeys; ++i) {
    setCfg(c, kSpecs[i].mega, kSpecs[i].boot);
  }
  return c;
}

void setCfg(MegaConfig& cfg, const char* key, uint16_t value) {
  for (uint8_t i = 0U; i < cfg.count; ++i) {
    if (strcmp(cfg.items[i].key, key) == 0) {
      cfg.items[i].value = value;
      cfg.expanded = cfgValue(cfg, "LAYOUT", 0U) == 1U;
      return;
    }
  }
  if (cfg.count >= kMegaCfgKeys) {
    return;
  }
  strncpy(cfg.items[cfg.count].key, key, sizeof(cfg.items[cfg.count].key) - 1U);
  cfg.items[cfg.count].value = value;
  ++cfg.count;
  cfg.expanded = cfgValue(cfg, "LAYOUT", 0U) == 1U;
}

uint16_t cfgValue(const MegaConfig& cfg, const char* key, uint16_t fallback) {
  for (uint8_t i = 0U; i < cfg.count; ++i) {
    if (strcmp(cfg.items[i].key, key) == 0) {
      return cfg.items[i].value;
    }
  }
  return fallback;
}

void readMegaConfig(const char* body, size_t len, const MegaConfig& current, MegaConfig& out, Drift& drift) {
  out = current;
  size_t objLen = 0U;
  const size_t at = json::findTopLevelObject(body, len, "config", objLen);
  if (at == json::kNotFound) {
    return;
  }
  // findTopLevelObject answers the first byte INSIDE the braces; the readers
  // below take the object whole, braces included, so only its own members are
  // ever matched (FC-7: never a flat scan of the body).
  const char* obj = body + at - 1U;
  const size_t objWhole = objLen + 2U;
  readDisplay(obj, objWhole, out, drift);
  readHardware(obj, objWhole, out, drift);
}

uint8_t keysFromButtonMap(const court::ButtonMap& map) {
  if (!map.configured()) {
    return 0x0FU; // the 2.1.0 split until the club's map is known
  }
  uint8_t keys = 0U;
  for (uint8_t i = 0U; i < court::kButtonCount; ++i) {
    if (map[i].kind != court::ButtonKind::GrantMinutes) {
      keys = static_cast<uint8_t>(keys | (1U << i));
    }
  }
  return keys;
}

// --- the reconcile ------------------------------------------------------------

Reconciler::Reconciler()
    : lastAtMs_(), tried_(), attempts_(), failed_(), suppressed_(), suppressRef_(), suppressAtMs_(), sawLit_() {
}

int32_t Reconciler::paidSeconds(const Snapshot& snap, uint8_t relay, uint32_t nowMs) {
  if (!snap.valid) {
    return proto::kNoOpinion;
  }
  // Ages never go negative (MCV1-01): a stamp later than now (stamped after
  // `now` was read in the same pass) is age 0, never a 49-day wrap.
  const int32_t signedAge = static_cast<int32_t>(nowMs - snap.atMs);
  const uint32_t age = signedAge < 0 ? 0U : static_cast<uint32_t>(signedAge) / 1000UL;
  for (uint8_t i = 0U; i < snap.count; ++i) {
    const SnapshotCourt& c = snap.courts[i];
    if (c.relay == relay) {
      if (!c.lit) {
        return 0;
      }
      const uint32_t left = c.seconds > age ? c.seconds - age : 0U;
      return left > 86400U ? 86400 : static_cast<int32_t>(left);
    }
  }
  return proto::kNoOpinion;
}

void Reconciler::memberReleased(uint8_t relay, const Snapshot& snap, uint32_t nowMs) {
  if (relay >= kSnapshotRelays) {
    return;
  }
  suppressed_[relay] = true;
  suppressAtMs_[relay] = nowMs;
  suppressRef_[relay][0] = '\0';
  for (uint8_t i = 0U; i < snap.count; ++i) {
    if (snap.courts[i].relay == relay) {
      strncpy(suppressRef_[relay], snap.courts[i].ref, sizeof(suppressRef_[relay]) - 1U);
      suppressRef_[relay][8] = '\0';
    }
  }
}

bool Reconciler::plan(const Snapshot& snap, const RelayView view[kSnapshotRelays], const ReconcileSettings& settings,
                      uint32_t nowMs, bool force, int32_t out[kSnapshotRelays]) {
  bool any = false;
  for (uint8_t r = 0U; r < kSnapshotRelays; ++r) {
    out[r] = proto::kNoOpinion;
  }
  bool wentDark[kSnapshotRelays];
  for (uint8_t r = 0U; r < kSnapshotRelays; ++r) {
    wentDark[r] = sawLit_[r] && !view[r].lit;
    sawLit_[r] = view[r].lit;
  }
  if (!snap.valid || !settings.restoreEnabled) {
    return false;
  }
  for (uint8_t i = 0U; i < snap.count; ++i) {
    const SnapshotCourt& c = snap.courts[i];
    const uint8_t r = c.relay;
    if (suppressed_[r]) {
      const bool sameRef = strcmp(suppressRef_[r], c.ref) == 0 && c.lit;
      if (sameRef && tb::since(nowMs, suppressAtMs_[r]) < kSuppressMs) {
        continue;
      }
      suppressed_[r] = false;
    }
    const int32_t left = paidSeconds(snap, r, nowMs);
    if (left <= 0 || static_cast<uint32_t>(left) < settings.minSeconds) {
      continue;
    }
    const uint32_t wanted = static_cast<uint32_t>(left) > proto::kRelayHardCapSeconds
                                ? static_cast<uint32_t>(proto::kRelayHardCapSeconds)
                                : static_cast<uint32_t>(left);
    const bool needs = !view[r].lit || view[r].seconds + kShortMarginSeconds < wanted;
    if (!needs) {
      attempts_[r] = 0U;
      continue;
    }
    if (!force && !wentDark[r] && tried_[r] && tb::since(nowMs, lastAtMs_[r]) < kRelightEveryMs) {
      continue;
    }
    if (attempts_[r] == kMaxAttempts) {
      // Three !WANTs and the relay is still not lit as owed: relight_failed,
      // once. It keeps being re-tried at the same pace — a relay the snapshot
      // owes is never given up on.
      failed_[r] = true;
    }
    if (attempts_[r] < UINT8_MAX) {
      ++attempts_[r];
    }
    tried_[r] = true;
    lastAtMs_[r] = nowMs;
    out[r] = static_cast<int32_t>(wanted);
    any = true;
  }
  return any;
}

void Reconciler::confirmed(uint8_t relay) {
  if (relay < kSnapshotRelays) {
    attempts_[relay] = 0U;
    failed_[relay] = false;
  }
}

bool Reconciler::takeFailed(uint8_t& relay) {
  for (uint8_t r = 0U; r < kSnapshotRelays; ++r) {
    if (failed_[r]) {
      failed_[r] = false;
      relay = r;
      return true;
    }
  }
  return false;
}

} // namespace bridgelogic
