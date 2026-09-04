#include "bridgelogic/ScanFlow.h"

#include <stdio.h>
#include <string.h>

namespace bridgelogic {

namespace {

/// Every refusal the contract can name, and what a member reads for it. Held
/// as a table so the strings sit in one place and the host suite can assert
/// each one; a `reason` this build does not know falls to the last row.
struct ReasonLines {
  const char* reason;
  const char* line1;
  const char* line2;
};

constexpr ReasonLines kReasons[] = {
    {"no_booking", "NO BOOKING", "SEE THE DESK"},
    {"insufficient_balance", "TOO FEW CREDITS", "TOP UP & RETRY"},
    {"wrong_court", "WRONG COURT", "SEE THE DESK"},
    {"not_recognised", "NOT RECOGNISED", "SEE THE DESK"},
    {"not_chargeable", "SEE THE DESK", ""},
};

court::Outcome refusal(const char* line1, const char* line2) {
  court::Outcome outcome;
  outcome.action = court::Action::Refuse;
  outcome.court = eventq::Event::kNoCourt;
  court::detail::setLine(outcome.line1, line1);
  court::detail::setLine(outcome.line2, line2);
  return outcome;
}

/// "TOO EARLY" is the one refusal with a number in it: how long to wait, from
/// `starts_in_seconds`. The same wording as the roster's own TooEarly, so a
/// member sees one screen for one situation whichever path decided it.
court::Outcome tooEarly(const char* body, size_t len) {
  uint32_t startsIn = 0U;
  if (!devapi::json::unsignedField(body, len, "starts_in_seconds", startsIn)) {
    return refusal("TOO EARLY", "SEE THE DESK");
  }
  court::Outcome outcome = refusal("TOO EARLY", "");
  const uint32_t ms = startsIn > UINT32_MAX / 1000U ? UINT32_MAX : startsIn * 1000U;
  court::detail::setLineWithMinutes(outcome.line2, "WAIT ", ms, " MIN");
  return outcome;
}

court::Outcome refusedFor(const char* body, size_t len) {
  char reason[24] = {};
  if (devapi::json::stringField(body, len, "reason", reason, sizeof(reason))) {
    if (strcmp(reason, "too_early") == 0) {
      return tooEarly(body, len);
    }
    for (const ReasonLines& row : kReasons) {
      if (strcmp(reason, row.reason) == 0) {
        return refusal(row.line1, row.line2);
      }
    }
  }
  // No reason, or one this build does not know. The API refused; the desk can
  // say why.
  return refusal("SEE THE DESK", "");
}

ActivationResult fallback() {
  ActivationResult result;
  result.fallbackToRoster = true;
  return result;
}

ActivationResult granted(uint32_t grantedSeconds, uint8_t relay) {
  ActivationResult result;
  result.disarmAuth = true;

  // Clamp the SECONDS before the multiply, for the reason RelayGuard does: a
  // value that wraps on conversion turns the longest grant into the shortest.
  const uint32_t seconds =
      grantedSeconds > proto::kRelayHardCapSeconds ? proto::kRelayHardCapSeconds : grantedSeconds;

  result.outcome.action = court::Action::TurnOn;
  result.outcome.court = relay;
  result.outcome.durationMs = seconds * 1000U;

  char line1[court::kLineLen + 1U] = "COURT ?";
  line1[6] = static_cast<char>('A' + relay);
  court::detail::setLine(result.outcome.line1, line1);
  court::detail::setLineWithMinutes(result.outcome.line2, "", result.outcome.durationMs, " MIN");
  return result;
}

} // namespace

uint32_t displayMinutes(uint32_t grantedMinutes) {
  return grantedMinutes > kMaxDisplayMinutes ? kMaxDisplayMinutes : grantedMinutes;
}

bool relayForCourtNumber(int16_t courtNumber, const int16_t courtNumbers[kMaxCourts], uint8_t courtCount,
                         uint8_t& relay) {
  const uint8_t count = courtCount > kMaxCourts ? kMaxCourts : courtCount;
  for (uint8_t i = 0U; i < count; ++i) {
    if (courtNumbers[i] == courtNumber) {
      relay = i;
      return true;
    }
  }
  return false;
}

size_t renderActivateBody(char* out, size_t cap, const char* token) {
  if (out == nullptr || cap == 0U || token == nullptr) {
    return 0U;
  }
  const int n = snprintf(out, cap, "{\"method\":\"qr\",\"token\":\"%s\"}", token);
  if (n <= 0 || static_cast<size_t>(n) >= cap) {
    out[0] = '\0';
    return 0U;
  }
  return static_cast<size_t>(n);
}

Attempt ScanFlow::onScan(const LinkState& link) const {
  return link.provisioned && link.wifiUp && link.clockKnown ? Attempt::Online : Attempt::RosterOnly;
}

ActivationResult ScanFlow::onActivateResponse(uint16_t status, const char* body, size_t len,
                                              const int16_t courtNumbers[kMaxCourts],
                                              uint8_t courtCount) const {
  if (status != 200U || body == nullptr) {
    // Includes 0, 401, 429 and every 5xx. Only a 200 carries a decision.
    return fallback();
  }

  bool activated = false;
  if (!devapi::json::boolField(body, len, "activated", activated)) {
    return fallback();
  }
  if (!activated) {
    ActivationResult result;
    result.outcome = refusedFor(body, len);
    return result;
  }

  uint32_t grantedSeconds = 0U;
  if (!devapi::json::unsignedField(body, len, "granted_seconds", grantedSeconds)) {
    return fallback();
  }

  uint32_t courtNumber = 0U;
  uint8_t relay = 0U;
  if (!devapi::json::unsignedField(body, len, "court_number", courtNumber) ||
      courtNumber > static_cast<uint32_t>(INT16_MAX) ||
      !relayForCourtNumber(static_cast<int16_t>(courtNumber), courtNumbers, courtCount, relay)) {
    // The API lit a court this box does not drive, or did not say which. It has
    // already recorded the activation, so the roster must not be asked to light
    // a second one; the desk untangles it.
    ActivationResult result;
    result.outcome = refusal("SEE THE DESK", "");
    return result;
  }

  return granted(grantedSeconds, relay);
}

} // namespace bridgelogic
