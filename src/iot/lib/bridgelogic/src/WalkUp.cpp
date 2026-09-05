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

/// Every refusal the contract names on this path, what a member reads for
/// it, and whether it is a verdict about a KNOWN member. That last bit is
/// what arms the button window, and it comes from the body's `error` and from
/// nothing else: it used to be set on every 402 and 409 by status alone, so a
/// 409 with no error — or one the API sent for a token it never identified —
/// armed thirty seconds of buttons for a stranger's barcode.
struct ErrorLines {
  const char* error;
  const char* line1;
  const char* line2;
  bool recognised;
};

constexpr ErrorLines kErrors[] = {
    // Priced: the API knows who this is and what they have.
    {"insufficient_balance", "TOO FEW CREDITS", "TOP UP & RETRY", true},
    // A verdict about the court, for a member the API identified.
    {"court_in_use", "COURT NOT FREE", "SCAN TO START", true},
    // Distinct from court_in_use: the court is empty and the next player is
    // imminent, which is a different sentence.
    {"no_time_available", "NO TIME BEFORE", "NEXT BOOKING", true},
    // A replayed nonce whose purchase is over. The API grants a replay what is
    // LEFT of the purchase, and nothing once the window has ended (#20).
    {"purchase_ended", "PURCHASE ENDED", "SCAN TO START", true},
    // Nobody the API knows. No window.
    {"not_recognised", "SEE THE DESK", "SCAN TO START", false},
    // A relay the heartbeat never mapped, or a court this box does not drive.
    {"court_not_on_device", "SEE THE DESK", "SCAN TO START", false},
};

/// The screen for a status whose body named no error this build knows. The
/// status still says what a member can act on; it does not say who they are,
/// so nothing here recognises anybody.
court::Outcome byStatus(uint16_t status) {
  if (status == 402U) {
    return lines("TOO FEW CREDITS", "TOP UP & RETRY");
  }
  if (status == 409U) {
    return lines("COURT NOT FREE", "SCAN TO START");
  }
  if (status == 0U) {
    return lines("NO CONNECTION", "SCAN TO START");
  }
  return lines("SEE THE DESK", "SCAN TO START");
}

/// The refusal in `body`, by its `error`, or by `status` when the body names
/// none this build knows.
court::Outcome refusal(uint16_t status, const char* body, size_t len) {
  // A transport failure or a server error is not a verdict about who scanned,
  // whatever its body happens to name: only a decided 4xx may recognise.
  if (status == 0U || status >= 500U) {
    return byStatus(status);
  }
  char error[32] = {};
  if (devapi::json::stringField(body, len, "error", error, sizeof(error))) {
    for (const ErrorLines& row : kErrors) {
      if (strcmp(error, row.error) == 0) {
        court::Outcome outcome = lines(row.line1, row.line2);
        outcome.recognised = row.recognised;
        return outcome;
      }
    }
  }
  return byStatus(status);
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
    result.outcome.recognised = true;
    // Uncapped: what the API SOLD. Past the relay cap it is what an `!EXT` will
    // have to honour later (bridgelogic::Relight).
    result.outcome.bookingRemainingMs = granted > UINT32_MAX / 60000U ? UINT32_MAX : granted * 60000U;

    char line1[court::kLineLen + 1U] = "COURT ?";
    line1[6] = static_cast<char>('A' + relay);
    court::detail::setLine(result.outcome.line1, line1);
    court::detail::setLineWithMinutes(result.outcome.line2, "", result.outcome.durationMs, " MIN");
    return result;
  }

  // Every refusal reads differently to somebody standing in a corridor. 402 is
  // the one they can act on themselves. A refusal the API could price, or
  // decide about a court, is a refusal of a member it recognised — the scan
  // stays usable for another attempt. No connection and a server fault say
  // nothing about who scanned, and neither does a status on its own.
  result.outcome = refusal(status, body, len);
  return result;
}

} // namespace bridgelogic
