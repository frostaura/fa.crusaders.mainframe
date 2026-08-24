// Crusaders Mainframe — SHA-256, clean room, streaming.
//
// WHY THIS EXISTS
// ---------------
// The ESP8266 SDK ships SHA-256 three times over (mbedtls, BearSSL, the core's
// Hash.h) and every one of them is unusable here, for the same reason: they all
// drag in SDK or Arduino headers, so nothing that calls them compiles for the
// host test runner. The device request signature is verified by a C# server
// that this code cannot see; the only thing keeping the two in agreement is the
// shared corpus in src/contracts/device-protocol/http, and a corpus that can
// only be executed on hardware is a corpus nobody executes. A hand-written
// SHA-256 that runs under `pio test -e native` is worth more than a vendor one
// that does not.
//
// It also has to link on the ATmega, where none of those three exist at all.
//
// WHY STREAMING
// -------------
// The ESP8266 has roughly 40 KB of usable heap and this firmware has none of it
// (no malloc anywhere in lib/). An event batch or a roster response does not fit
// in a buffer we can afford, so the body is hashed as it is produced or read,
// 64 bytes of state at a time. init/update/final is not a convenience here, it
// is the only shape that fits.
//
// The block-boundary handling in update() is where hand-written SHA-256
// implementations go wrong, so the tests feed identical input in 1, 63, 64 and
// 65-byte chunks and require the same digest.

#ifndef CRUSADERS_DEVCRYPTO_SHA256_H
#define CRUSADERS_DEVCRYPTO_SHA256_H

#include <stddef.h>
#include <stdint.h>

namespace dc {

class Sha256 {
public:
  static constexpr size_t kDigestSize = 32;
  static constexpr size_t kBlockSize = 64;
  /// Digest as lowercase hex plus its terminator.
  static constexpr size_t kHexSize = 65;

  Sha256() { init(); }

  /// Resets to the standard IV. Safe to call on a used instance — the object is
  /// reusable on purpose, because allocating a second one on an AVR stack frame
  /// costs 112 bytes of the 8 KB the whole board has.
  void init();

  void update(const uint8_t* data, size_t len);

  /// Writes the digest and leaves the instance finalised. Call init() to reuse.
  void final(uint8_t out[kDigestSize]);

  /// One-shot convenience for input already in memory.
  static void hash(const uint8_t* data, size_t len, uint8_t out[kDigestSize]);

private:
  void compress(const uint8_t block[kBlockSize]);

  uint32_t state_[8];
  uint8_t buffer_[kBlockSize];
  size_t buffered_;
  /// Bytes consumed. 64-bit because SHA-256's padding encodes the length in
  /// bits: a 32-bit counter overflows at 512 MB of input, which is not a size
  /// this device will ever hash but is exactly the kind of limit that is
  /// discovered by a signature mismatch rather than by a crash.
  uint64_t totalBytes_;
};

} // namespace dc

#endif // CRUSADERS_DEVCRYPTO_SHA256_H
