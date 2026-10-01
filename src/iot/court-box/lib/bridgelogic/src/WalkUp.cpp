#include "bridgelogic/WalkUp.h"

#include <stdio.h>
#include <string.h>

#include "bridgelogic/ScanFlow.h"
#include "devapi/Json.h"
#include "devcrypto/Hex.h"
#include "memcode/Token.h"

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
    {"insufficient_balance", "TOO FEW MINUTES", "BUY & RETRY", true},
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
    // The club lowered its walk-up maximum below what this button grants. The
    // member can act on it themselves — press a shorter button — which is the
    // whole reason it is not SEE THE DESK: the box refuses 15/30/45/60 in turn
    // while the panel still advertises all four, and the only sentence the glass
    // had for it sent the member to a desk that is not the problem (M-F1).
    //
    // `recognised` is FALSE, and that is deliberate rather than an oversight.
    // The refusal comes out of `RefuseFields`, which runs BEFORE the API resolves
    // the token, so it is not a verdict about anybody — exactly like
    // court_not_on_device beside it. Nothing on this path acts on the bit
    // (AuthPolicy::afterWalkUp ignores a refusal), so the honest value costs
    // nothing, and a `true` here would be a claim the API never made.
    {"minutes_out_of_range", "TOO LONG", "TRY LESS TIME", false},
    // The API sold the court, could not open it, and UNDID the sale — the money is
    // back and the slot is released before this answer is written
    // (BookingService.VoidUnstartedWalkUpAsync). So the court is FREE, and until
    // 2026-09-07 this fell through byStatus(409) to "COURT NOT FREE / SCAN TO START",
    // which was true while the refused booking still sat on the court and became false
    // the moment the undo landed. A member who scans again now succeeds, and the mail
    // the API sends for this ("Nothing was bought … Try again at the box") said so
    // while the glass in front of them said the opposite.
    //
    // `recognised` is TRUE, unlike the two rows above it: this refusal is produced
    // after the token resolved and after a booking was committed for that member, so
    // it is a verdict about somebody the API knows.
    {"activation_refused", "COULD NOT START", "SCAN TO RETRY", true},
    // A single rotating code the server already acted on (docs/specs/member-
    // code.md §4.4). The member's next code works; the same words the activate
    // path and the offline path use. Not recognised: a used code may be a photo.
    {"code_used", "CODE USED", "WAIT 30 SECONDS", false},
};

/// The one refusal on this path whose second line is not fixed text.
///
/// The API sends the club's own opening time with `club_closed`, and a member
/// standing at a locked club after hours can act on "OPENS 06:00" and cannot act
/// on anything else — there is no desk to see, which is what the old screen told
/// them to do (M-F5). `opens_at` is `HH:mm` local to the club.
///
/// An answer with no `opens_at` still gets the first line, because "CLUB CLOSED"
/// is the half that explains why nothing happened.
court::Outcome clubClosed(const char* body, size_t len) {
  char opens[12] = {};
  char line2[court::kLineLen + 1U] = {};
  if (devapi::json::topLevelStringField(body, len, "opens_at", opens, sizeof(opens)) && opens[0] != '\0') {
    snprintf(line2, sizeof(line2), "OPENS %s", opens);
  } else {
    snprintf(line2, sizeof(line2), "%s", "TRY LATER");
  }

  court::Outcome outcome = lines("CLUB CLOSED", line2);
  // A verdict about a member the API identified: `club_closed` is produced past
  // the token resolution, by the booking attempt itself.
  outcome.recognised = true;
  return outcome;
}

constexpr char kClubClosed[] = "club_closed";

/// The screen for a status whose body named no error this build knows. The
/// status still says what a member can act on; it does not say who they are,
/// so nothing here recognises anybody.
court::Outcome byStatus(uint16_t status) {
  if (status == 402U) {
    return lines("TOO FEW MINUTES", "BUY & RETRY");
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
  if (devapi::json::topLevelStringField(body, len, "error", error, sizeof(error))) {
    if (strcmp(error, kClubClosed) == 0) {
      return clubClosed(body, len);
    }
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

size_t renderWalkUpBody(char* out, size_t cap, const WalkUpRequest& request) {
  if (out == nullptr || cap == 0U || request.token == nullptr || request.nonce == nullptr ||
      request.mac == nullptr || request.mac[0] == '\0') {
    return 0U;
  }
  char age[32] = {};
  if (memcode::looksLikeV1(request.token)) {
    snprintf(age, sizeof(age), ",\"scan_age_ms\":%lu", static_cast<unsigned long>(request.scanAgeMs));
  }
  const int n = snprintf(
      out, cap,
      "{\"mac\":\"%s\",\"minutes\":%u,\"method\":\"qr\",\"token\":\"%s\",\"court\":%d,\"nonce\":\"%s\"%s}",
      request.mac, static_cast<unsigned>(request.intent.minutes), request.token,
      static_cast<int>(request.courtNumber), request.nonce, age);
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
    static_cast<void>(devapi::json::topLevelUnsignedField(body, len, "granted_minutes", granted));
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
