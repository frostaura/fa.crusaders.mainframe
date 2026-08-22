#include "devcrypto/Hkdf.h"

#include <string.h>

namespace dc {
namespace hkdf {
namespace {

constexpr size_t kHashLen = HmacSha256::kDigestSize;
constexpr size_t kMaxOutput = 255U * kHashLen;

} // namespace

void extract(const ByteSpan& salt, const ByteSpan& ikm, uint8_t prk[kHashLen]) {
  // §2.2: with no salt, HashLen zero bytes are used. Note this is a zero KEY,
  // not a zero-length key — HMAC pads a zero-length key to a zero block anyway,
  // so the two happen to coincide for SHA-256; spelling it out keeps the code
  // honest against the spec rather than against a coincidence.
  static const uint8_t kZeroSalt[kHashLen] = {0};

  const uint8_t* saltBytes = (salt.len > 0) ? salt.data : kZeroSalt;
  const size_t saltLen = (salt.len > 0) ? salt.len : kHashLen;

  HmacSha256::mac(saltBytes, saltLen, ikm.data, ikm.len, prk);
}

bool expand(const uint8_t prk[kHashLen], const ByteSpan& info, uint8_t* out, size_t outLen) {
  if (out == nullptr || outLen == 0 || outLen > kMaxOutput) {
    return false;
  }

  uint8_t block[kHashLen];
  size_t blockLen = 0; // T(0) is the empty string.
  size_t written = 0;
  uint8_t counter = 1U;

  while (written < outLen) {
    HmacSha256 mac;
    mac.init(prk, kHashLen);
    mac.update(block, blockLen); // T(i-1), empty on the first round
    mac.update(info.data, info.len);
    mac.update(&counter, 1);
    mac.final(block);
    blockLen = kHashLen;

    const size_t remaining = outLen - written;
    const size_t take = (remaining < kHashLen) ? remaining : kHashLen;
    memcpy(out + written, block, take);
    written += take;
    ++counter;
  }

  memset(block, 0, sizeof(block));
  return true;
}

bool derive(const Inputs& in, uint8_t* out, size_t outLen) {
  uint8_t prk[kHashLen];
  extract(in.salt, in.ikm, prk);

  const bool ok = expand(prk, in.info, out, outLen);

  // The PRK is as sensitive as the derived key; it does not outlive the call.
  memset(prk, 0, sizeof(prk));
  return ok;
}

} // namespace hkdf
} // namespace dc
