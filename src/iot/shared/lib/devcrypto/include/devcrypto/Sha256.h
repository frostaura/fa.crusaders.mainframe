// Crusaders Mainframe — SHA-256, and HMAC-SHA-256 and HKDF built on it.
//
// WHY THESE ARE BACK
// ------------------
// Firmware 2.0.0 deleted a SHA-256, an HMAC and an HKDF from beside the hex
// codec, because the request signing they served had gone: one club, one box,
// one static bearer key, and nothing on the device computed a digest. They are
// back for a different job and a narrower one — the single rotating member
// code (docs/specs/member-code.md). A box or a door that cannot reach the
// server verifies the OFF half of a member's code against a per-day key the
// heartbeat delivered, and OFF is a TOTP, which is an HMAC-SHA-256 of a step
// counter. Nothing here signs a request, and the device API is still a bearer
// key.
//
// WHY NOT THE BOARD'S OWN
// -----------------------
// The ESP8266 core carries BearSSL and the ESP32 core carries mbedTLS, and a
// lib/ that reached for either could not be proved on the host, would differ
// between the two boards this tree ships, and would break the purity rule every
// lib/ is gated on. A portable implementation is ~200 lines, is proved here
// against FIPS 180-4, RFC 4231 and RFC 5869 by the shared corpus, and is the
// same bytes on the court bridge, the door gate and the test runner.
//
// COST ON THE BOARD
// -----------------
// One offline verification is at most three HMACs of an eight-byte counter
// under a twelve-byte key: twelve compression rounds, well under a millisecond
// on either ESP. The context is 108 bytes and the message schedule 256 more,
// on the stack, for the length of one compression — affordable on the ESP8266's
// 4 KB continuation stack, and the reason nothing here recurses.
//
// No Arduino headers, no heap, no String. Compiles for AVR, Xtensa and the host,
// and is valid C++11 as well as C++17: both generated sketches build at gnu++11.

#ifndef CRUSADERS_DEVCRYPTO_SHA256_H
#define CRUSADERS_DEVCRYPTO_SHA256_H

#include <stddef.h>
#include <stdint.h>

namespace dc {

/// Digest length and block length of SHA-256, in bytes.
inline constexpr size_t kSha256Bytes = 32U;
inline constexpr size_t kSha256BlockBytes = 64U;

/// Streaming SHA-256 (FIPS 180-4). update() any number of times, then finish()
/// once; finish() resets the context, so one object can hash many messages.
class Sha256 {
public:
  Sha256() { reset(); }

  void reset();

  void update(const uint8_t* data, size_t len);

  /// Writes the 32-byte digest and resets the context. `out` may not be null.
  void finish(uint8_t* out);

private:
  void compress(const uint8_t* block);

  uint32_t state_[8];
  uint8_t buffer_[kSha256BlockBytes];
  uint64_t totalBytes_;
  size_t fill_;
};

/// One-shot SHA-256 of `len` bytes.
void sha256(const uint8_t* data, size_t len, uint8_t* out);

/// Streaming HMAC-SHA-256 (RFC 2104). A key longer than a block is hashed
/// first, exactly as the RFC says — RFC 4231's cases 6 and 7 pin it.
class HmacSha256 {
public:
  HmacSha256(const uint8_t* key, size_t keyLen);
  ~HmacSha256();

  HmacSha256(const HmacSha256&) = delete;
  HmacSha256& operator=(const HmacSha256&) = delete;

  void update(const uint8_t* data, size_t len);

  /// Writes the 32-byte MAC. The object is spent afterwards.
  void finish(uint8_t* out);

private:
  Sha256 inner_;
  uint8_t outerPad_[kSha256BlockBytes];
};

/// One-shot HMAC-SHA-256.
void hmacSha256(const uint8_t* key, size_t keyLen, const uint8_t* data, size_t len, uint8_t* out);

/// A run of bytes. HKDF takes three of them, and three pointer-and-length pairs
/// are six arguments that swap silently at a call site.
struct ByteSpan {
  const uint8_t* data;
  size_t len;
};

/// HKDF-SHA-256 (RFC 5869): extract with `salt` (an empty salt is 32 zero
/// bytes, as the RFC says), then expand `info` to `outLen` bytes. False, with
/// nothing written, when `outLen` is zero or past the RFC's 255 x 32 ceiling.
///
/// No board calls this: only the server derives a member secret from the
/// master key. It is here so the host suite can prove the WHOLE chain in
/// derivation.json — master key to member secret to K_day to OFF — against the
/// corpus, which is then checked by two implementations instead of one.
bool hkdfSha256(ByteSpan salt, ByteSpan ikm, ByteSpan info, uint8_t* out, size_t outLen);

/// Overwrites `len` bytes with zero in a way the optimiser may not remove.
/// Used on every buffer that held key material, because a stack frame that
/// held a K_day is the next call's uninitialised local.
void wipe(void* data, size_t len);

} // namespace dc

#endif // CRUSADERS_DEVCRYPTO_SHA256_H
