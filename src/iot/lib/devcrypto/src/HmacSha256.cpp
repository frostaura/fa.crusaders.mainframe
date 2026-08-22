#include "devcrypto/HmacSha256.h"

#include <string.h>

namespace dc {
namespace {

constexpr uint8_t kInnerPadByte = 0x36U;
constexpr uint8_t kOuterPadByte = 0x5cU;

} // namespace

void HmacSha256::init(const uint8_t* key, size_t keyLen) {
  uint8_t block[kBlockSize];
  memset(block, 0, sizeof(block));

  // The three key-length cases are written out separately because they are
  // three different pieces of behaviour, and because the middle one is where
  // the off-by-one lives: written as `keyLen >= kBlockSize`, a key of exactly
  // 64 bytes gets hashed down to 32 and every MAC it produces is silently wrong
  // — wrong in a way that still looks like a MAC, so it is only ever found as a
  // 401 in the field. The corpus carries keys of 0, 3, 32, 64, 65 and 200 bytes
  // so all three paths and both boundaries are executed.
  if (keyLen > kBlockSize) {
    // Longer than a block: hashed first, then zero-padded to a block.
    Sha256::hash(key, keyLen, block);
  } else if (keyLen == kBlockSize) {
    // Exactly a block: used as-is, no hashing and no padding.
    memcpy(block, key, kBlockSize);
  } else if (keyLen > 0) {
    // Shorter than a block: zero-padded on the right.
    memcpy(block, key, keyLen);
  }
  // keyLen == 0 leaves the block all zeroes, which is what RFC 2104 specifies
  // and is not the same thing as an error.

  for (size_t i = 0; i < kBlockSize; ++i) {
    outerPad_[i] = static_cast<uint8_t>(block[i] ^ kOuterPadByte);
    block[i] = static_cast<uint8_t>(block[i] ^ kInnerPadByte);
  }

  inner_.init();
  inner_.update(block, kBlockSize);

  // The inner pad still holds the key XOR 0x36. Nothing here is secret to this
  // process, but a key sitting in a stack frame that later gets reused as a
  // response buffer is how key material ends up on the wire.
  memset(block, 0, sizeof(block));
}

void HmacSha256::update(const uint8_t* data, size_t len) {
  inner_.update(data, len);
}

void HmacSha256::final(uint8_t out[kDigestSize]) {
  uint8_t innerDigest[kDigestSize];
  inner_.final(innerDigest);

  // Reusing inner_ for the outer hash rather than declaring a second Sha256
  // keeps the peak stack at one hash state.
  inner_.init();
  inner_.update(outerPad_, kBlockSize);
  inner_.update(innerDigest, kDigestSize);
  inner_.final(out);

  memset(innerDigest, 0, sizeof(innerDigest));
  memset(outerPad_, 0, sizeof(outerPad_));
}

void HmacSha256::mac(const uint8_t* key, size_t keyLen, const uint8_t* message, size_t messageLen,
                     uint8_t out[kDigestSize]) {
  HmacSha256 hmac;
  hmac.init(key, keyLen);
  hmac.update(message, messageLen);
  hmac.final(out);
}

} // namespace dc
