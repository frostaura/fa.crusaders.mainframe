#include "bridgelogic/PayFor.h"

#include <stdio.h>
#include <string.h>

#include "devapi/Json.h"
#include "devcrypto/Hex.h"
#include "memcode/Token.h"

namespace bridgelogic {
namespace {

/// Every refusal reason the contract names, and the screen a member reads for
/// it. A reason this build does not know is still a refusal: SEE THE DESK.
struct ReasonScreen {
  const char* reason;
  ScreenId screen;
};

constexpr ReasonScreen kReasons[] = {
    {"split_booking", ScreenId::PayForSplit},
    {"own_booking", ScreenId::PayForNothingToPay},
    {"already_paid", ScreenId::PayForNothingToPay},
    {"insufficient_balance", ScreenId::InsufficientBalance},
    // A code the server could not tie to a member, and a code that was already
    // used for something the server acted on, send the member to the same
    // place: a fresh code in the app.
    {"not_recognised", ScreenId::NotRecognised},
    {"code_used", ScreenId::NotRecognised},
    {"ended", ScreenId::SlotEnded},
    {"price_changed", ScreenId::PayForPriceChanged},
};

constexpr char kNotBooked[] = "not_booked";

ScreenId screenForReason(const char* body, size_t len) {
  char reason[32] = {};
  if (!devapi::json::topLevelStringField(body, len, "reason", reason, sizeof(reason))) {
    return ScreenId::SeeTheDesk;
  }
  for (const ReasonScreen& row : kReasons) {
    if (strcmp(reason, row.reason) == 0) {
      return row.screen;
    }
  }
  return ScreenId::SeeTheDesk;
}

bool reasonIs(const char* body, size_t len, const char* expected) {
  char reason[32] = {};
  return devapi::json::topLevelStringField(body, len, "reason", reason, sizeof(reason)) &&
         strcmp(reason, expected) == 0;
}

bool undecidedStatus(uint16_t status) {
  return status == 0U || status == 429U || status >= 500U;
}

PayForAnswer answer(PayForKind kind, ScreenId screen) {
  PayForAnswer a;
  a.kind = kind;
  a.screen = screen;
  return a;
}

} // namespace

bool validAmountLabel(const char* label) {
  if (label == nullptr) {
    return false;
  }
  const size_t len = strlen(label);
  if (len == 0U || len > kMaxAmountLabelDigits) {
    return false;
  }
  for (size_t i = 0U; i < len; ++i) {
    if (label[i] < '0' || label[i] > '9') {
      return false; // a point, a sign, a separator: whole minutes are digits only
    }
  }
  return label[0] != '0' || len == 1U; // "0" is a number; "045" is not the server's
}

size_t renderPayForBody(char* out, size_t cap, const PayForRequest& request) {
  if (out == nullptr || cap == 0U) {
    return 0U;
  }
  out[0] = '\0';
  if (request.mac == nullptr || request.mac[0] == '\0' || request.token == nullptr ||
      request.token[0] == '\0' || request.nonce == nullptr ||
      (request.confirm && !validAmountLabel(request.amountLabel))) {
    return 0U;
  }

  char label[32] = {};
  if (request.confirm) {
    snprintf(label, sizeof(label), ",\"amount_label\":\"%s\"", request.amountLabel);
  }
  // scan_age_ms for a v1 member code only, so a legacy code's body is the one
  // the server has always been sent — the same rule as activate and walk-up.
  char age[32] = {};
  if (memcode::looksLikeV1(request.token)) {
    snprintf(age, sizeof(age), ",\"scan_age_ms\":%lu", static_cast<unsigned long>(request.scanAgeMs));
  }
  const int n = snprintf(out, cap,
                         "{\"mac\":\"%s\",\"method\":\"qr\",\"token\":\"%s\",\"court\":%d,\"nonce\":\"%s\","
                         "\"confirm\":%s%s%s}",
                         request.mac, request.token, static_cast<int>(request.courtNumber), request.nonce,
                         request.confirm ? "true" : "false", label, age);
  if (n <= 0 || static_cast<size_t>(n) >= cap) {
    out[0] = '\0';
    return 0U;
  }
  return static_cast<size_t>(n);
}

PayForAnswer onPayForQuote(uint16_t status, const char* body, size_t len, int16_t courtNumber) {
  // Anything that is not a readable decision is the walk-up choice the press
  // always was: a server that does not know pay-for, a dead link, a cut body.
  if (status != 200U || body == nullptr || !devapi::json::isCompleteObject(body, len)) {
    return answer(PayForKind::WalkUp, ScreenId::ChooseTime);
  }
  bool payable = false;
  if (!devapi::json::topLevelBoolField(body, len, "payable", payable)) {
    return answer(PayForKind::WalkUp, ScreenId::ChooseTime);
  }
  if (!payable) {
    if (reasonIs(body, len, kNotBooked)) {
      return answer(PayForKind::WalkUp, ScreenId::ChooseTime);
    }
    return answer(PayForKind::Refused, screenForReason(body, len));
  }

  uint32_t quotedCourt = 0U;
  PayForAnswer quote = answer(PayForKind::Quote, ScreenId::PayForQuote);
  if (!devapi::json::topLevelUnsignedField(body, len, "court_number", quotedCourt) || courtNumber < 0 ||
      quotedCourt != static_cast<uint32_t>(courtNumber) ||
      !devapi::json::topLevelStringField(body, len, "amount_label", quote.amountLabel,
                                         sizeof(quote.amountLabel)) ||
      !validAmountLabel(quote.amountLabel)) {
    // A price for a different court, or one the glass cannot show whole, is not
    // a question a member can be asked. `topLevelStringField` REFUSES a label
    // longer than the buffer rather than cutting it, which is what makes a
    // seven-character label land here and not on the glass as six.
    return answer(PayForKind::WalkUp, ScreenId::ChooseTime);
  }
  return quote;
}

PayForAnswer onPayForConfirm(uint16_t status, const char* body, size_t len, const char* quotedLabel) {
  if (undecidedStatus(status)) {
    return answer(PayForKind::Undecided, status == 0U ? ScreenId::NoConnection : ScreenId::SeeTheDesk);
  }
  if (status != 200U) {
    return answer(PayForKind::Refused, ScreenId::SeeTheDesk);
  }
  bool paid = false;
  if (body == nullptr || !devapi::json::isCompleteObject(body, len) ||
      !devapi::json::topLevelBoolField(body, len, "paid", paid)) {
    // A 200 nobody can read may have paid. UNDECIDED, so a second press sends
    // the same nonce and is answered with the first payment, never a second.
    return answer(PayForKind::Undecided, ScreenId::SeeTheDesk);
  }
  if (!paid) {
    return answer(PayForKind::Refused, screenForReason(body, len));
  }

  PayForAnswer done = answer(PayForKind::Paid, ScreenId::PayForPaid);
  if (!devapi::json::topLevelStringField(body, len, "amount_label", done.amountLabel,
                                         sizeof(done.amountLabel)) ||
      !validAmountLabel(done.amountLabel)) {
    // The glass says what the member agreed to, which is what was quoted.
    done.amountLabel[0] = '\0';
    if (validAmountLabel(quotedLabel)) {
      snprintf(done.amountLabel, sizeof(done.amountLabel), "%s", quotedLabel);
    }
  }
  uint32_t granted = 0U;
  if (devapi::json::topLevelUnsignedField(body, len, "granted_seconds", granted)) {
    done.grantedSeconds = granted;
  }
  return done;
}

const char* PayForFlow::quoteNonce(devapi::IEntropySource& entropy) {
  uint8_t raw[kWalkUpNonceBytes];
  for (size_t i = 0U; i < kWalkUpNonceBytes; ++i) {
    raw[i] = entropy.nextByte();
  }
  static_cast<void>(dc::hex::encodeLower(raw, sizeof(raw), nonce_, sizeof(nonce_)));
  return nonce_;
}

void PayForFlow::arm(uint8_t relay, int16_t courtNumber, const char* amountLabel, uint32_t ttlMs,
                     uint32_t nowMs) {
  relay_ = relay;
  courtNumber_ = courtNumber;
  snprintf(label_, sizeof(label_), "%s", amountLabel != nullptr ? amountLabel : "");
  until_.arm(nowMs, ttlMs);
}

bool PayForFlow::quoted(uint8_t relay, uint32_t nowMs) const {
  return until_.isArmed() && !until_.expired(nowMs) && relay == relay_;
}

bool PayForFlow::tick(uint32_t nowMs) {
  if (!until_.expired(nowMs)) {
    return false;
  }
  clear();
  return true;
}

void PayForFlow::clear() {
  until_.disarm();
  label_[0] = '\0';
}

} // namespace bridgelogic
