// Crusaders Mainframe — acting on an OFFER, and the rule that a claimed box
// cannot act on an unsigned one.
//
// THE ATTACK
// ----------
// An OFFER carries the base URL of the mainframe. A box that takes any OFFER it
// receives takes the URL of whatever answered first — so anyone on the club
// WiFi can point a claimed court box at a mainframe they control, and from
// there at the relays. The spec's answer is that an OFFER to a claimed box is
// signed with the device key, and a claimed box refuses an unsigned one.
//
// WHY THAT IS A TYPE AND NOT AN `if`
// ----------------------------------
// Written as a runtime check it is one line — `if (claimed && !verify(...))
// return` — sitting in a function that will be edited by somebody who is
// thinking about DHCP, not about a rogue on the LAN. A line like that is
// removable by accident and its absence looks like nothing.
//
// So the accept path is two types instead:
//
//   * ClaimedBox's constructor REQUIRES the signing key. There is no default
//     constructor, no setter and no key-less overload, so a ClaimedBox without
//     a key is not a value that can exist.
//   * ClaimedBox::accept() has no parameter, flag or overload that skips
//     verification. "Accept this OFFER without checking the signature" is not
//     an expression a caller can write.
//   * AcceptedOffer has no public constructor. The only things that can produce
//     one are these two classes, so a URL that reached the box unverified
//     cannot be handed to the HTTP client by any other route.
//
// The unclaimed case has its own type because it is genuinely different: a box
// with no key cannot verify anything, and demanding a signature it has no way
// to check would mean no board could ever be claimed. UnclaimedBox says that
// out loud rather than leaving it as a special case inside one function.
//
// WHAT IS CHECKED EITHER WAY
// --------------------------
// The verb, the protocol version, and that the OFFER echoes THIS boot's nonce.
// The nonce echo is what stops an OFFER captured today from being replayed at
// the board's next boot.
//
// No Arduino headers, no heap.

#ifndef CRUSADERS_DISCOVERY_OFFER_H
#define CRUSADERS_DISCOVERY_OFFER_H

#include <stddef.h>
#include <stdint.h>

#include "devcrypto/ByteSpan.h"
#include "discovery/Beacon.h"

namespace discovery {

/// Bytes of device key held by a ClaimedBox. The key is HMAC-SHA256's, derived
/// server-side at claim time; 32 is its natural length.
inline constexpr size_t kSigningKeyLen = 32;

/// An OFFER the box has decided to act on.
///
/// No public constructor beyond the empty one. Obtainable only from
/// UnclaimedBox::accept() or ClaimedBox::accept(), which is what makes an
/// unverified URL unreachable from the rest of the firmware.
class AcceptedOffer {
public:
  /// Empty: url() is "" and unixSeconds() is 0. Usable as an out-parameter.
  AcceptedOffer();

  bool empty() const { return url_[0] == '\0'; }

  /// Base URL of the mainframe. Never null.
  const char* url() const { return url_; }

  /// The API's clock, for a board that has no RTC and no NTP yet.
  uint64_t unixSeconds() const { return unixSeconds_; }

private:
  friend class UnclaimedBox;
  friend class ClaimedBox;

  /// Verb, version and nonce echo. Everything that is true of an acceptable
  /// OFFER regardless of which box is receiving it; the signature rule is the
  /// part that differs, and it lives in the two callers.
  static bool build(const Packet& offer, const char* nonceHex, AcceptedOffer& out);

  char url_[kMaxValueLen + 1];
  uint64_t unixSeconds_;
};

/// A board with no key yet. It can only take OFFERs at face value, because it
/// has nothing to check one with.
class UnclaimedBox {
public:
  /// `nonceHex` is the nonce this boot's ANNOUNCEs carry.
  explicit UnclaimedBox(const char* nonceHex);

  /// A signed OFFER is accepted too — the signature is simply not checkable
  /// yet, and refusing one would mean an API that always signs could never
  /// claim a board.
  bool accept(const Packet& offer, AcceptedOffer& out) const;

private:
  char nonce_[kMaxValueLen + 1];
};

/// A claimed board. Holds the device key, so it can and always does verify.
class ClaimedBox {
public:
  /// The key is a required constructor argument and always will be: see the
  /// header comment. It is COPIED — a ClaimedBox outlives the call it was
  /// built in, and dc::ByteSpan promises nothing about the bytes it points at.
  ClaimedBox(const dc::ByteSpan& key, const char* nonceHex);

  ClaimedBox() = delete;

  /// Refuses an OFFER that is unsigned or wrongly signed. There is no overload
  /// that does otherwise.
  bool accept(const Packet& offer, AcceptedOffer& out) const;

  /// False when the key handed to the constructor was not kSigningKeyLen bytes.
  /// Such a box accepts nothing at all, rather than verifying against a key
  /// that is quietly the wrong length.
  bool hasKey() const { return hasKey_; }

private:
  uint8_t key_[kSigningKeyLen];
  bool hasKey_;
  char nonce_[kMaxValueLen + 1];
};

} // namespace discovery

#endif // CRUSADERS_DISCOVERY_OFFER_H
