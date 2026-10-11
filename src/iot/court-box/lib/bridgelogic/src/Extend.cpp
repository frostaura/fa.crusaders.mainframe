#include "bridgelogic/Extend.h"

#include <stdio.h>
#include <string.h>

#include "bridgelogic/ScanFlow.h"
#include "bridgelogic/WalkUp.h"
#include "devapi/Json.h"
#include "memcode/Token.h"
#include "protocol/Protocol.h"

namespace bridgelogic {

namespace {

court::Outcome lines(const char* line1, const char* line2) {
  court::Outcome outcome;
  outcome.action = court::Action::Refuse;
  outcome.court = eventq::Event::kNoCourt;
  court::detail::setLine(outcome.line1, line1);
  court::detail::setLine(outcome.line2, line2);
  return outcome;
}

bool errorIs(const char* body, size_t len, const char* expected) {
  char error[32] = {};
  return body != nullptr && devapi::json::topLevelStringField(body, len, "error", error, sizeof(error)) &&
         strcmp(error, expected) == 0;
}

/// Extend-specific refusals; everything else is the walk-up's sentence.
struct ExtendError {
  const char* error;
  const char* line1;
  const char* line2;
};

constexpr ExtendError kExtendErrors[] = {
    {"court_not_lit", "COURT NOT ON", "PICK ANOTHER"},
    {"no_time_available", "NO TIME BEFORE", "NEXT BOOKING"},
    {"insufficient_balance", "TOO FEW MINUTES", "BUY & RETRY"},
};

} // namespace

void readGreeting(const char* body, size_t len, Greeting& out) {
  out = Greeting();
  if (body == nullptr || len == 0U) {
    return;
  }
  char raw[48] = {};
  if (devapi::json::topLevelStringField(body, len, "greeting_name", raw, sizeof(raw))) {
    // Printable ASCII only, upper-cased: the HD44780 has no glyph for an
    // escaped byte, and an upper-case name matches every other word on glass.
    size_t at = 0U;
    for (size_t i = 0U; raw[i] != '\0' && at < kGreetingNameCols; ++i) {
      char c = raw[i];
      if (c < 0x20 || c > 0x7E) {
        continue;
      }
      if (c >= 'a' && c <= 'z') {
        c = static_cast<char>(c - 'a' + 'A');
      }
      out.name[at] = c;
      ++at;
    }
    // A name cut mid-way ending in a space reads as a trailing blank; trim it.
    while (at > 0U && out.name[at - 1U] == ' ') {
      --at;
    }
    out.name[at] = '\0';
  }
  uint32_t balance = 0U;
  if (devapi::json::topLevelUnsignedField(body, len, "balance_minutes", balance)) {
    out.hasBalance = true;
    out.balanceMinutes = balance;
  }
}

ScreenId greetingScreen(const Greeting& greeting, ScreenFacts& facts) {
  snprintf(facts.name, sizeof(facts.name), "%s", greeting.name);
  facts.balance = greeting.balanceMinutes;
  return greeting.hasBalance ? ScreenId::Greeting : ScreenId::GreetingNoBalance;
}

size_t renderExtendBody(char* out, size_t cap, const ExtendRequest& request) {
  if (out == nullptr || cap == 0U || request.token == nullptr || request.nonce == nullptr ||
      request.mac == nullptr || request.mac[0] == '\0') {
    return 0U;
  }
  char safeToken[kEscapedScanCap] = {};
  if (!escapeScan(request.token, safeToken, sizeof(safeToken))) {
    out[0] = '\0';
    return 0U;
  }
  char age[32] = {};
  if (memcode::looksLikeV1(request.token)) {
    snprintf(age, sizeof(age), ",\"scan_age_ms\":%lu", static_cast<unsigned long>(request.scanAgeMs));
  }
  const int n = snprintf(
      out, cap,
      "{\"mac\":\"%s\",\"method\":\"qr\",\"token\":\"%s\",\"court\":%d,\"minutes\":%u,\"nonce\":\"%s\"%s}",
      request.mac, safeToken, static_cast<int>(request.courtNumber), static_cast<unsigned>(request.minutes),
      request.nonce, age);
  if (n <= 0 || static_cast<size_t>(n) >= cap) {
    out[0] = '\0';
    return 0U;
  }
  return static_cast<size_t>(n);
}

ExtendResult onExtendResponse(uint16_t status, const char* body, size_t len) {
  ExtendResult result;
  result.decided = !(status == 0U || status == 429U || status >= 500U);

  if (status == 0U) {
    // Never extend offline: extending moves money.
    result.refusal = lines("NO CONNECTION", "EXTEND NEEDS NET");
    return result;
  }

  if (status == 200U) {
    uint32_t minutes = 0U;
    if (body != nullptr && devapi::json::isCompleteObject(body, len) &&
        devapi::json::topLevelUnsignedField(body, len, "extended_minutes", minutes) && minutes > 0U) {
      result.extended = true;
      result.extendedMinutes = minutes;
      uint32_t balance = 0U;
      if (devapi::json::topLevelUnsignedField(body, len, "balance_after_minutes", balance)) {
        result.hasBalance = true;
        result.balanceAfterMinutes = balance;
      }
      return result;
    }
    // A 200 that added nothing: the next booking starts now.
    result.refusal = lines("NO TIME BEFORE", "NEXT BOOKING");
    return result;
  }

  if (status < 500U) {
    for (const ExtendError& row : kExtendErrors) {
      if (errorIs(body, len, row.error)) {
        result.refusal = lines(row.line1, row.line2);
        return result;
      }
    }
  }

  // Everything else reads as the walk-up does — used code, barred, busy,
  // too long, club closed — one situation, one sentence.
  const WalkUpResult walkUp = onWalkUpResponse(status, body, len, eventq::Event::kNoCourt, 0U);
  result.refusal = walkUp.outcome;
  result.refusal.action = court::Action::Refuse;
  result.forgetsScan = walkUp.forgetsScan;
  result.invitesPress = walkUp.invitesPress;
  return result;
}

ExtendPlan planExtension(uint32_t sessionLeftSeconds, uint32_t extendedMinutes) {
  ExtendPlan plan;
  const uint32_t added = extendedMinutes > UINT32_MAX / 60U ? UINT32_MAX : extendedMinutes * 60U;
  plan.sessionSeconds = sessionLeftSeconds > UINT32_MAX - added ? UINT32_MAX : sessionLeftSeconds + added;
  const uint32_t cap = static_cast<uint32_t>(proto::kRelayHardCapSeconds);
  plan.relaySeconds = plan.sessionSeconds > cap ? cap : plan.sessionSeconds;
  if (plan.relaySeconds == 0U) {
    plan.relaySeconds = 1U;
  }
  return plan;
}

} // namespace bridgelogic
