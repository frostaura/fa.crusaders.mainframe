#include "bridgelogic/WalkUp.h"

#include <stdio.h>
#include <string.h>

#include "bridgelogic/ScanFlow.h"
#include "devapi/Json.h"
#include "devcrypto/Hex.h"

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

/// True when `error` in the body is exactly `name`.
bool errorIs(const char* body, size_t len, const char* name) {
  char error[32] = {};
  return devapi::json::stringField(body, len, "error", error, sizeof(error)) && strcmp(error, name) == 0;
}

bool undecided(uint16_t status) {
  return status == 0U || status == 429U || status >= 500U;
}

} // namespace

bool WalkUpNonce::samePurchase(const court::WalkUpIntent& intent, const char* token) const {
  return intent.court == court_ && intent.minutes == minutes_ && strcmp(token, token_) == 0;
}

const char* WalkUpNonce::forPurchase(const court::WalkUpIntent& intent, const char* token,
                                     devapi::IEntropySource& entropy) {
  if (undecided_ && samePurchase(intent, token)) {
    return hex_;
  }

  uint8_t raw[kWalkUpNonceBytes];
  for (size_t i = 0U; i < kWalkUpNonceBytes; ++i) {
    raw[i] = entropy.nextByte();
  }
  static_cast<void>(dc::hex::encodeLower(raw, sizeof(raw), hex_, sizeof(hex_)));

  court_ = intent.court;
  minutes_ = intent.minutes;
  snprintf(token_, sizeof(token_), "%s", token);
  undecided_ = true;
  return hex_;
}

void WalkUpNonce::decided() {
  undecided_ = false;
}

size_t renderWalkUpBody(char* out, size_t cap, const court::WalkUpIntent& intent, int16_t courtNumber,
                        const char* token, const char* nonce) {
  if (out == nullptr || cap == 0U || token == nullptr || nonce == nullptr) {
    return 0U;
  }
  const int n =
      snprintf(out, cap, "{\"minutes\":%u,\"method\":\"qr\",\"token\":\"%s\",\"court\":%d,\"nonce\":\"%s\"}",
               static_cast<unsigned>(intent.minutes), token, static_cast<int>(courtNumber), nonce);
  if (n <= 0 || static_cast<size_t>(n) >= cap) {
    out[0] = '\0';
    return 0U;
  }
  return static_cast<size_t>(n);
}

WalkUpResult onWalkUpResponse(uint16_t status, const char* body, size_t len, uint8_t relay,
                              uint16_t requestedMinutes) {
  WalkUpResult result;
  result.decided = !undecided(status);

  if (status == 200U) {
    // What was ACTUALLY sold, from the response — not what was asked for.
    // Twenty minutes may be all there was, and telling the member sixty would
    // be a complaint waiting to happen. A replayed grant carries the same
    // fields and is the same grant.
    uint32_t granted = requestedMinutes;
    static_cast<void>(devapi::json::unsignedField(body, len, "granted_minutes", granted));
    const uint32_t minutes = displayMinutes(granted);

    result.outcome.action = court::Action::TurnOn;
    result.outcome.court = relay;
    result.outcome.durationMs = minutes * 60000U;

    char line1[court::kLineLen + 1U] = "COURT ?";
    line1[6] = static_cast<char>('A' + relay);
    court::detail::setLine(result.outcome.line1, line1);
    court::detail::setLineWithMinutes(result.outcome.line2, "", result.outcome.durationMs, " MIN");
    return result;
  }

  // Every refusal reads differently to somebody standing in a corridor. 402 is
  // the one they can act on themselves.
  if (status == 402U) {
    result.outcome = lines("TOO FEW CREDITS", "TOP UP & RETRY");
  } else if (status == 409U && errorIs(body, len, "no_time_available")) {
    result.outcome = lines("NO TIME BEFORE", "NEXT BOOKING");
  } else if (status == 409U) {
    result.outcome = lines("COURT NOT FREE", "SCAN TO START");
  } else if (status == 0U) {
    result.outcome = lines("NO CONNECTION", "SCAN TO START");
  } else {
    result.outcome = lines("SEE THE DESK", "SCAN TO START");
  }
  return result;
}

} // namespace bridgelogic
