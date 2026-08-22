// Accepting an OFFER. See include/discovery/Offer.h for why a claimed box
// cannot be asked to accept an unsigned one.

#include "discovery/Offer.h"

#include <string.h>

#include "discovery/BeaconCodec.h"

namespace discovery {
namespace {

bool sameText(const char* a, const char* b) {
  while (*a != '\0' && *a == *b) {
    ++a;
    ++b;
  }
  return *a == *b;
}

/// Copy a borrowed nonce into a box. An over-long one becomes empty, and an
/// empty nonce matches no OFFER — a box that cannot say which nonce it is using
/// must accept nothing, not everything.
void copyNonce(const char* nonceHex, char* out, size_t cap) {
  out[0] = '\0';
  if (nonceHex == nullptr) {
    return;
  }
  const size_t n = strlen(nonceHex);
  if (n == 0 || n >= cap) {
    return;
  }
  memcpy(out, nonceHex, n + 1);
}

/// Decimal, saturating. The `t` field is the API's clock; a value that does not
/// fit a uint64 is not a timestamp, so the field is treated as absent.
bool parseUnsigned(const char* s, uint64_t& out) {
  if (s == nullptr || s[0] == '\0') {
    return false;
  }
  uint64_t v = 0;
  for (size_t i = 0; s[i] != '\0'; ++i) {
    if (s[i] < '0' || s[i] > '9') {
      return false;
    }
    const uint64_t digit = static_cast<uint64_t>(s[i] - '0');
    if (v > (UINT64_MAX - digit) / 10U) {
      return false;
    }
    v = (v * 10U) + digit;
  }
  out = v;
  return true;
}

} // namespace

AcceptedOffer::AcceptedOffer() : url_(), unixSeconds_(0) {
  url_[0] = '\0';
}

bool AcceptedOffer::build(const Packet& offer, const char* nonceHex, AcceptedOffer& out) {
  out = AcceptedOffer();
  if (offer.verb() != Verb::Offer || nonceHex == nullptr || nonceHex[0] == '\0') {
    return false;
  }

  const char* version = offer.find("v");
  if (version == nullptr || !sameText(version, kProtocolVersion)) {
    return false;
  }

  const char* echoed = offer.find("n");
  if (echoed == nullptr || !sameText(echoed, nonceHex)) {
    // The nonce is regenerated each boot, so this is what stops an OFFER captured
    // today from being replayed at the board's next boot.
    return false;
  }

  const char* url = offer.find("url");
  if (url == nullptr) {
    return false;
  }

  uint64_t seconds = 0;
  static_cast<void>(parseUnsigned(offer.find("t"), seconds));

  const size_t n = strlen(url);
  if (n > kMaxValueLen) {
    return false;
  }
  memcpy(out.url_, url, n + 1);
  out.unixSeconds_ = seconds;
  return true;
}

UnclaimedBox::UnclaimedBox(const char* nonceHex) : nonce_() {
  copyNonce(nonceHex, nonce_, sizeof(nonce_));
}

bool UnclaimedBox::accept(const Packet& offer, AcceptedOffer& out) const {
  return AcceptedOffer::build(offer, nonce_, out);
}

ClaimedBox::ClaimedBox(const dc::ByteSpan& key, const char* nonceHex)
    : key_(), hasKey_(key.data != nullptr && key.len == kSigningKeyLen), nonce_() {
  if (hasKey_) {
    memcpy(key_, key.data, kSigningKeyLen);
  }
  copyNonce(nonceHex, nonce_, sizeof(nonce_));
}

bool ClaimedBox::accept(const Packet& offer, AcceptedOffer& out) const {
  out = AcceptedOffer();
  if (!hasKey_) {
    return false;
  }
  // Verified BEFORE anything is read out of the packet, so there is no path on
  // which a field of an unverified OFFER reaches the caller.
  const dc::ByteSpan key{key_, kSigningKeyLen};
  if (!verify(offer, key)) {
    return false;
  }
  return AcceptedOffer::build(offer, nonce_, out);
}

} // namespace discovery
