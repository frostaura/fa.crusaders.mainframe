// Crusaders Mainframe — the walk-up purchase, as bytes on the wire and as an
// answer on the screen.
//
// WHY THE REQUEST NAMES A COURT
// -----------------------------
// The old request carried `{minutes, method, token}` and nothing else, so the
// API booked and charged the device's single configured court while the box lit
// whichever relay the member had pressed (review C5). One physical box drives
// up to four courts; the request now carries the court NUMBER the pressed relay
// maps to through the heartbeat's `court_numbers`, and a relay the heartbeat
// never mapped is refused here rather than sold as court zero.
//
// WHY THE REQUEST CARRIES A NONCE
// -------------------------------
// A walk-up is the one box operation that charges money at the moment of the
// request, and the network between the box and the API is the club's WiFi. A
// request that landed but whose response was lost looks, from the box, exactly
// like one that never landed — and re-sending it with no way to tell the two
// apart is a second booking and a second charge. The nonce is the idempotency
// key: the API answers a repeat with the FIRST purchase and `"replayed": true`,
// and the box treats that answer exactly like a fresh grant.
//
// A nonce is minted per purchase and reused only while the previous attempt at
// THE SAME purchase — same member, same court, same minutes — is undecided. A
// decided answer, a grant or a refusal alike, spends it; a different purchase
// gets a fresh one.
//
// No Arduino headers, no heap, no String. Compiles for Xtensa and the host.

#ifndef CRUSADERS_BRIDGELOGIC_WALKUP_H
#define CRUSADERS_BRIDGELOGIC_WALKUP_H

#include <stddef.h>
#include <stdint.h>

#include "court/Session.h"
#include "court/WalkUpPad.h"
#include "devapi/DeviceClient.h"
#include "protocol/Protocol.h"

namespace bridgelogic {

/// Entropy per walk-up nonce, and its hex length on the wire.
inline constexpr size_t kWalkUpNonceBytes = 8U;
inline constexpr size_t kWalkUpNonceHexLen = kWalkUpNonceBytes * 2U;

/// The per-purchase nonce and the rule for when it is reused.
class WalkUpNonce {
public:
  /// The nonce to send for `intent` on behalf of `token`. Fresh unless the last
  /// attempt was for this same purchase and got no decision.
  const char* forPurchase(const court::WalkUpIntent& intent, const char* token,
                          devapi::IEntropySource& entropy);

  /// The last attempt got a decision — a grant or a refusal — so its nonce is
  /// spent and the next purchase, even an identical one, gets a fresh one.
  void decided();

  /// True while an undecided attempt's nonce is live.
  bool pending() const { return undecided_; }

private:
  bool samePurchase(const court::WalkUpIntent& intent, const char* token) const;

  char hex_[kWalkUpNonceHexLen + 1U] = {};
  char token_[proto::kMaxArgLen + 1U] = {};
  uint8_t court_ = 0U;
  uint16_t minutes_ = 0U;
  bool undecided_ = false;
};

/// Renders the walk-up request body. Returns the length, or 0 when it would not
/// fit — never a truncated body, which is a request for something else.
size_t renderWalkUpBody(char* out, size_t cap, const court::WalkUpIntent& intent, int16_t courtNumber,
                        const char* token, const char* nonce);

/// What the API's answer means for the box.
struct WalkUpResult {
  /// The API decided — granted or refused — as opposed to not answering. A
  /// decided attempt spends its nonce.
  bool decided = false;
  /// What to paint and, on a grant, which relay to drive for how long.
  court::Outcome outcome;
};

/// Interprets the walk-up response for the relay the member pressed.
///
///   200        → TurnOn on `relay` for `granted_minutes` (defaulting to what
///                was asked for if the field is missing), display-clamped to
///                the relay cap. `"replayed": true` is the same grant, seen
///                again, and is handled identically.
///   402        → TOO FEW CREDITS
///   409        → COURT NOT FREE, or NO TIME BEFORE / NEXT BOOKING when the
///                body says `no_time_available` — the court is empty and the
///                next player is imminent, which is a different sentence — or
///                PURCHASE ENDED when it says `purchase_ended`: a replayed
///                nonce whose window is over (a replay is granted what is
///                LEFT of the purchase, never the original length).
///   0          → NO CONNECTION (undecided)
///   5xx / 429  → SEE THE DESK (undecided)
///   other      → SEE THE DESK (decided)
///
/// `recognised` — the bit that arms the button window — comes from the body's
/// `error`, never from the status. insufficient_balance, court_in_use,
/// no_time_available and purchase_ended are verdicts about a member the API
/// identified; not_recognised, court_not_on_device, an error this build does
/// not know and a bare status are not, and arm nothing.
WalkUpResult onWalkUpResponse(uint16_t status, const char* body, size_t len, uint8_t relay,
                              uint16_t requestedMinutes);

} // namespace bridgelogic

#endif // CRUSADERS_BRIDGELOGIC_WALKUP_H
