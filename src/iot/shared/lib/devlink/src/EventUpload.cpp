#include "devlink/EventUpload.h"

#include <stdio.h>
#include <string.h>

#include "devapi/Json.h"
#include "timebase/TimeBase.h"

namespace devlink {
namespace {

/// Twelve lowercase hex and nothing else, which is what both composition roots
/// render from `dc::hex::encodeLower` and what the contract pins.
///
/// CHECKED RATHER THAN ESCAPED. The MAC is not scanned bytes, so escaping it
/// would only ever hide a board that had got its own identity wrong; refusing
/// is the answer that says so. It is checked at all because this is the one
/// other `%s` in the body and a renderer should not have a field whose safety
/// rests on nobody having changed its caller.
bool isTwelveLowerHex(const char* mac) {
  size_t i = 0U;
  for (; mac[i] != '\0'; ++i) {
    if (i >= 12U) {
      return false;
    }
    const char c = mac[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) {
      return false;
    }
  }
  return i == 12U;
}

} // namespace

size_t renderEventBody(char* out, size_t cap, const char* mac, uint64_t nowUptimeMs,
                       const eventq::Event& event) {
  if (out == nullptr || cap == 0U) {
    return 0U;
  }
  out[0] = '\0';
  if (mac == nullptr || !isTwelveLowerHex(mac)) {
    return 0U;
  }

  // ESCAPED, NOT INTERPOLATED (round G4, B1). `subject` is whatever was
  // scanned: at a door it is the bytes off a QR code, and `","seq":99999,"x":"`
  // is nineteen characters. Rendered raw it forged the batch's sequence number,
  // and the server answers `accepted_through` from the seq it PARSED — so one
  // crafted code, scanned while the door was offline, discarded every genuine
  // entry queued behind it the moment the link came back.
  char subject[eventq::kMaxSubjectLen * devapi::json::kMaxEscapeExpansion + 1U] = {};
  const size_t subjectLen =
      event.subjectLen > eventq::kMaxSubjectLen ? eventq::kMaxSubjectLen : event.subjectLen;
  if (!devapi::json::escapeInto(event.subject, subjectLen, subject, sizeof(subject))) {
    return 0U;
  }

  // Omitted as a null rather than sent as the string "none", matching what
  // eventq::methodName returns — a release has no identification method, and
  // pretending it had one puts a fiction in the audit trail.
  const char* method = eventq::methodName(event.method);
  char methodJson[16] = "null";
  if (method != nullptr) {
    snprintf(methodJson, sizeof(methodJson), "\"%s\"", method);
  }

  char batchUptime[21] = {};
  char eventUptime[21] = {};
  if (tb::formatU64(nowUptimeMs, batchUptime, sizeof(batchUptime)) == 0U ||
      tb::formatU64(tb::widen(nowUptimeMs, event.uptimeMs), eventUptime, sizeof(eventUptime)) == 0U) {
    return 0U;
  }

  const int written = snprintf(
      out, cap,
      "{\"mac\":\"%s\",\"uptime_ms\":%s,\"events\":[{\"seq\":%lu,\"uptime_ms\":%s,"
      "\"kind\":\"%s\",\"court\":%d,\"method\":%s,\"subject\":\"%s\",\"duration_ms\":%lu}]}",
      mac, batchUptime, static_cast<unsigned long>(event.seq), eventUptime, eventq::kindName(event.kind),
      event.court == eventq::Event::kNoCourt ? -1 : static_cast<int>(event.court), methodJson, subject,
      static_cast<unsigned long>(event.durationMs));
  if (written < 0 || static_cast<size_t>(written) >= cap) {
    // snprintf truncated. A half-rendered body is a request the server refuses
    // as malformed, and the drain path treats a 4xx as "the box caused this"
    // and DROPS the event — so a silent truncation would lose exactly the
    // attendance record that stops a refund.
    out[0] = '\0';
    return 0U;
  }
  return static_cast<size_t>(written);
}

} // namespace devlink
