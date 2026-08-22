// Crusaders Mainframe — HMAC-SHA256 (RFC 2104) over the hand-written SHA-256.
//
// WHY THIS EXISTS
// ---------------
// Same reason as Sha256: the vendor implementations cannot be compiled or
// tested on the host, and this MAC is the only thing standing between the
// relay-control endpoints and anyone who can reach the LAN.
//
// WHY STREAMING
// -------------
// The device signs a canonical string it never materialises (see
// RequestSigner): method, path, timestamp, nonce and body hash are fed in as
// they are formatted. Keeping init/update/final here means the signer needs no
// canonical-string buffer at all on the hot path.
//
// RAM NOTE
// --------
// Only the outer key pad is retained, not a second Sha256 instance — 64 bytes
// instead of 112. On the ESP8266 that is unremarkable; it matters if this ever
// links into the ATmega image, which has 8 KB of SRAM in total.

#ifndef CRUSADERS_DEVCRYPTO_HMACSHA256_H
#define CRUSADERS_DEVCRYPTO_HMACSHA256_H

#include <stddef.h>
#include <stdint.h>

#include "devcrypto/Sha256.h"

namespace dc {

class HmacSha256 {
public:
  static constexpr size_t kDigestSize = Sha256::kDigestSize;
  static constexpr size_t kBlockSize = Sha256::kBlockSize;

  /// A null key with length 0 is legal and is a real corpus case.
  void init(const uint8_t* key, size_t keyLen);

  void update(const uint8_t* data, size_t len);

  void final(uint8_t out[kDigestSize]);

  /// One-shot convenience for a message already in memory.
  static void mac(const uint8_t* key, size_t keyLen, const uint8_t* message, size_t messageLen,
                  uint8_t out[kDigestSize]);

private:
  Sha256 inner_;
  /// Zeroed at construction so an instance used before init() produces a wrong
  /// MAC deterministically rather than one that depends on whatever was in the
  /// stack frame — the difference between a bug that reproduces and one that
  /// does not.
  uint8_t outerPad_[kBlockSize] = {0};
};

} // namespace dc

#endif // CRUSADERS_DEVCRYPTO_HMACSHA256_H
