#include "devlink/Cadence.h"

#include <stdio.h>

#include "devapi/Json.h"
#include "timebase/TimeBase.h"

namespace devlink {

bool parseHeartbeatInterval(const char* body, size_t len, uint32_t& intervalMs) {
  uint32_t seconds = 0U;
  // Top level, not the first `heartbeat_seconds` anywhere in the document. It
  // is read on a path that ACTS on it — the box's whole cadence, and with it
  // how fresh its roster ever is — and a field sharing the name inside a
  // nested object would be adopted ahead of the real one. Round G4's B2, in
  // the one field that decides how often this board speaks at all.
  if (!devapi::json::topLevelUnsignedField(body, len, "heartbeat_seconds", seconds)) {
    return false;
  }
  // Clamp in seconds first so the multiply cannot wrap a huge value into a
  // small one.
  const uint32_t maxSeconds = kMaxHeartbeatMs / 1000U;
  const uint32_t minSeconds = kMinHeartbeatMs / 1000U;
  const uint32_t bounded = seconds > maxSeconds ? maxSeconds : (seconds < minSeconds ? minSeconds : seconds);
  intervalMs = bounded * 1000U;
  return true;
}

namespace {

/// `,"restored_relays":N`, or an empty string at zero.
///
/// Its own suffix rather than a conditional format string, so the quiet body is
/// ONE literal and stays byte-identical to the contract corpus's
/// `heartbeat-request` vector. The gate's `renderCounter` is the same idiom for
/// the same reason.
void renderRestored(char* out, size_t cap, uint8_t restored) {
  out[0] = '\0';
  if (restored == 0U) {
    return;
  }
  const int written = snprintf(out, cap, ",\"restored_relays\":%u", static_cast<unsigned>(restored));
  if (written < 0 || static_cast<size_t>(written) >= cap) {
    out[0] = '\0'; // unreachable at kHeartbeatBodyCap; a lie beats a truncation
  }
}

/// `,"relay_state":["0|1834","2|600"]`, or an empty string when the caller does
/// not report relay state at all.
///
/// A DIAGNOSTIC MUST NEVER STOP A HEARTBEAT, so every failure mode here degrades
/// rather than refuses: an element whose relay is not 0-3 is skipped, a count
/// past the cap is truncated to it, and a count with no array behind it renders
/// nothing. See the header.
void renderRelayState(char* out, size_t cap, const RelayState* state, uint8_t count) {
  out[0] = '\0';
  if (state == nullptr) {
    return;
  }

  const uint8_t bounded = count > kMaxRelayStateElements ? kMaxRelayStateElements : count;
  size_t at = 0U;
  int written = snprintf(out, cap, ",\"relay_state\":[");
  if (written < 0) {
    return;
  }
  at = static_cast<size_t>(written);

  uint8_t rendered = 0U;
  for (uint8_t i = 0U; i < bounded && at < cap; ++i) {
    if (state[i].relay > 3U) {
      continue; // no such relay: a caller bug, not a reason to lose the heartbeat
    }
    written = snprintf(out + at, cap - at, "%s\"%u|%lu\"", rendered == 0U ? "" : ",",
                       static_cast<unsigned>(state[i].relay),
                       static_cast<unsigned long>(state[i].remainingSeconds));
    if (written < 0 || static_cast<size_t>(written) >= cap - at) {
      out[0] = '\0';
      return;
    }
    at += static_cast<size_t>(written);
    ++rendered;
  }

  written = snprintf(out + at, cap - at, "]");
  if (written < 0 || static_cast<size_t>(written) >= cap - at) {
    out[0] = '\0';
  }
}

/// A bounded appender: every put() is refused once anything has not fitted,
/// and the caller then renders nothing — a truncated body is a lie.
class Out {
public:
  Out(char* buf, size_t cap) : buf_(buf), cap_(cap), at_(0U), ok_(cap > 0U) {
    if (ok_) {
      buf_[0] = '\0';
    }
  }

  void put(const char* s) {
    for (size_t i = 0U; ok_ && s != nullptr && s[i] != '\0'; ++i) {
      putc(s[i]);
    }
  }

  void putc(char c) {
    if (!ok_ || at_ + 1U >= cap_) {
      ok_ = false;
      return;
    }
    buf_[at_] = c;
    ++at_;
    buf_[at_] = '\0';
  }

  void u32(uint32_t v) {
    char digits[11];
    snprintf(digits, sizeof(digits), "%lu", static_cast<unsigned long>(v));
    put(digits);
  }

  void hex2(uint8_t v) {
    char digits[3];
    snprintf(digits, sizeof(digits), "%02X", static_cast<unsigned>(v));
    put(digits);
  }

  /// `,"key":"value"`
  void str(const char* key, const char* value) {
    put(",\"");
    put(key);
    put("\":\"");
    put(value);
    putc('"');
  }

  void num(const char* key, uint32_t value) {
    put(",\"");
    put(key);
    put("\":");
    u32(value);
  }

  bool ok() const { return ok_; }

  size_t size() const { return at_; }

private:
  char* buf_;
  size_t cap_;
  size_t at_;
  bool ok_;
};

void renderMega(Out& o, const MegaReport& m) {
  o.put(",\"mega\":{\"reset\":\"");
  o.hex2(m.reset);
  o.put("\",\"lcd\":\"");
  o.hex2(m.lcd);
  o.put("\",\"relay\":\"");
  o.put(m.relayLow ? "low" : "high");
  o.put("\",\"scan_baud\":");
  o.u32(m.scanBaud);
  o.put(",\"scan_end\":\"");
  o.put(m.scanCrlf ? "crlf" : "auto");
  o.put("\",\"keys\":\"");
  o.hex2(m.keys);
  o.put("\",\"diag\":[");
  for (uint8_t i = 0U; i < 5U; ++i) {
    if (i > 0U) {
      o.putc(',');
    }
    o.u32(m.counters[i]);
  }
  o.put("]}");
}

void renderDiag(Out& o, const DiagReport& d) {
  o.put(",\"diag\":{\"reset\":\"");
  o.put(d.reset);
  o.putc('"');
  o.num("exc", d.exc);
  o.num("epc1", d.epc1);
  o.num("heap", d.heap);
  o.num("heap_min", d.heapMin);
  o.num("block", d.block);
  o.num("stack_min", d.stackMin);
  o.num("sketch_free", d.sketchFree);
  o.num("flash_mb", d.flashMb);
  o.putc('}');
}

void renderCaps(Out& o, uint8_t caps) {
  static const char* const kNames[6] = {"codes:m1", "hb:3", "ota:1", "key:1", "net:1", "lcd:2"};
  if (caps == 0U) {
    return;
  }
  o.put(",\"caps\":[");
  bool first = true;
  for (uint8_t i = 0U; i < 6U; ++i) {
    if ((caps & (1U << i)) == 0U) {
      continue;
    }
    o.put(first ? "\"" : ",\"");
    o.put(kNames[i]);
    o.putc('"');
    first = false;
  }
  o.putc(']');
}

/// Everything after `relay_state`, in device-api.md §2's order, then caps.
void renderV3(Out& o, const HeartbeatV3& v) {
  if (v.megaVersion != nullptr) {
    o.str("mega_version", v.megaVersion);
  }
  if (v.fwState != nullptr) {
    o.str("fw_state", v.fwState);
  }
  if (v.fwFailed != nullptr) {
    o.str("fw_failed", v.fwFailed);
  }
  if (v.fwError != nullptr) {
    o.str("fw_error", v.fwError);
  }
  if (v.netReported) {
    o.num("net_ver", v.netVer);
    o.str("net_src", v.netSrc);
  }
  if (v.lcdLayout != nullptr) {
    o.str("lcd_layout", v.lcdLayout);
  }
  if (v.restore != nullptr) {
    o.str("restore", v.restore);
  }
  if (v.relight != nullptr && v.relightCount > 0U) {
    o.put(",\"relight\":[");
    const uint8_t n = v.relightCount > kMaxRelightElements ? kMaxRelightElements : v.relightCount;
    for (uint8_t i = 0U; i < n; ++i) {
      o.put(i == 0U ? "\"" : ",\"");
      o.u32(v.relight[i].relay);
      o.putc('|');
      o.put(v.relight[i].ref);
      o.putc('"');
    }
    o.putc(']');
  }
  if (v.mega != nullptr) {
    renderMega(o, *v.mega);
  }
  if (v.diag != nullptr) {
    renderDiag(o, *v.diag);
  }
  if (v.drift != nullptr && v.driftCount > 0U) {
    o.put(",\"drift\":[");
    const uint8_t n = v.driftCount > kMaxDriftNames ? kMaxDriftNames : v.driftCount;
    for (uint8_t i = 0U; i < n; ++i) {
      o.put(i == 0U ? "\"" : ",\"");
      o.put(v.drift[i]);
      o.putc('"');
    }
    o.putc(']');
  }
  renderCaps(o, v.caps);
}

} // namespace

size_t renderHeartbeatBody(char* out, size_t cap, const char* mac, const char* firmwareVersion,
                           uint64_t uptimeMs, const HeartbeatReport& report) {
  if (out == nullptr || cap == 0U) {
    return 0U;
  }
  out[0] = '\0';
  if (mac == nullptr || mac[0] == '\0' || firmwareVersion == nullptr) {
    return 0U;
  }

  // Digits from tb::formatU64 and in as `%s`: avr-libc has no 64-bit printf
  // conversion at all and the ESP8266 core's is a build-time choice this
  // firmware does not make, so `%llu` here would silently print garbage on one
  // target. Same rule as devlink::renderEventBody.
  char uptime[21] = {};
  if (tb::formatU64(uptimeMs, uptime, sizeof(uptime)) == 0U) {
    return 0U;
  }

  // ORDER IS PART OF THE SHAPE: `restored_relays` then `relay_state`, both
  // after `uptime_ms`, both absent at their nothing value. The corpus asserts
  // the bytes, not the keys.
  char restored[28] = {};
  char relayState[80] = {};
  renderRestored(restored, sizeof(restored), report.restoredRelays);
  renderRelayState(relayState, sizeof(relayState), report.relayState, report.relayStateCount);

  if (report.v3 != nullptr) {
    // v3 (device-api.md §2): no `restored_relays` (a v3 box reports `relight`),
    // then `relay_state`, the v3 fields in order, and `caps` last.
    Out o(out, cap);
    o.put("{\"mac\":\"");
    o.put(mac);
    o.put("\",\"firmware_version\":\"");
    o.put(firmwareVersion);
    o.put("\",\"uptime_ms\":");
    o.put(uptime);
    o.put(relayState);
    renderV3(o, *report.v3);
    o.putc('}');
    if (!o.ok()) {
      out[0] = '\0';
      return 0U;
    }
    return o.size();
  }

  // `caps` LAST, after every diagnostic, and absent unless the firmware speaks
  // something the server must negotiate — so a board that names no capability
  // still renders the body every image before it rendered, byte for byte.
  const char* caps = report.codesCapability ? kCodesCapsSuffix : "";

  const int written =
      snprintf(out, cap, "{\"mac\":\"%s\",\"firmware_version\":\"%s\",\"uptime_ms\":%s%s%s%s}", mac,
               firmwareVersion, uptime, restored, relayState, caps);
  if (written < 0 || static_cast<size_t>(written) >= cap) {
    out[0] = '\0';
    return 0U;
  }
  return static_cast<size_t>(written);
}

} // namespace devlink
