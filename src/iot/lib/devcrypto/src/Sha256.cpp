#include "devcrypto/Sha256.h"

#include <string.h>

namespace dc {
namespace {

// FIPS 180-4 §4.2.2 — the first 32 bits of the fractional parts of the cube
// roots of the first 64 primes. Transcribed, not computed: computing them at
// startup would cost flash and floating point on a board that has neither to
// spare, and a typo here is caught by the very first corpus vector.
const uint32_t kRoundConstants[64] = {
    0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U, 0x3956c25bU, 0x59f111f1U, 0x923f82a4U, 0xab1c5ed5U,
    0xd807aa98U, 0x12835b01U, 0x243185beU, 0x550c7dc3U, 0x72be5d74U, 0x80deb1feU, 0x9bdc06a7U, 0xc19bf174U,
    0xe49b69c1U, 0xefbe4786U, 0x0fc19dc6U, 0x240ca1ccU, 0x2de92c6fU, 0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU,
    0x983e5152U, 0xa831c66dU, 0xb00327c8U, 0xbf597fc7U, 0xc6e00bf3U, 0xd5a79147U, 0x06ca6351U, 0x14292967U,
    0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU, 0x53380d13U, 0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U,
    0xa2bfe8a1U, 0xa81a664bU, 0xc24b8b70U, 0xc76c51a3U, 0xd192e819U, 0xd6990624U, 0xf40e3585U, 0x106aa070U,
    0x19a4c116U, 0x1e376c08U, 0x2748774cU, 0x34b0bcb5U, 0x391c0cb3U, 0x4ed8aa4aU, 0x5b9cca4fU, 0x682e6ff3U,
    0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U, 0x90befffaU, 0xa4506cebU, 0xbef9a3f7U, 0xc67178f2U};

// Every one of these takes and returns uint32_t explicitly. Written with plain
// operators and no casts, the integer promotions in ch/maj/sigma turn into
// `int` arithmetic on AVR (16-bit int) and on the host alike, which is what the
// -Wconversion gate is there to catch. The casts are load-bearing, not noise.
inline uint32_t rotr32(uint32_t value, unsigned bits) {
  return static_cast<uint32_t>(value >> bits) | static_cast<uint32_t>(value << (32U - bits));
}

inline uint32_t ch(uint32_t x, uint32_t y, uint32_t z) {
  return (x & y) ^ (static_cast<uint32_t>(~x) & z);
}

inline uint32_t maj(uint32_t x, uint32_t y, uint32_t z) {
  return (x & y) ^ (x & z) ^ (y & z);
}

inline uint32_t bigSigma0(uint32_t x) {
  return rotr32(x, 2U) ^ rotr32(x, 13U) ^ rotr32(x, 22U);
}

inline uint32_t bigSigma1(uint32_t x) {
  return rotr32(x, 6U) ^ rotr32(x, 11U) ^ rotr32(x, 25U);
}

inline uint32_t smallSigma0(uint32_t x) {
  return rotr32(x, 7U) ^ rotr32(x, 18U) ^ static_cast<uint32_t>(x >> 3U);
}

inline uint32_t smallSigma1(uint32_t x) {
  return rotr32(x, 17U) ^ rotr32(x, 19U) ^ static_cast<uint32_t>(x >> 10U);
}

inline uint32_t loadBigEndian32(const uint8_t* p) {
  return static_cast<uint32_t>(static_cast<uint32_t>(p[0]) << 24) |
         static_cast<uint32_t>(static_cast<uint32_t>(p[1]) << 16) |
         static_cast<uint32_t>(static_cast<uint32_t>(p[2]) << 8) | static_cast<uint32_t>(p[3]);
}

inline void storeBigEndian32(uint32_t value, uint8_t* p) {
  p[0] = static_cast<uint8_t>(value >> 24);
  p[1] = static_cast<uint8_t>(value >> 16);
  p[2] = static_cast<uint8_t>(value >> 8);
  p[3] = static_cast<uint8_t>(value);
}

} // namespace

void Sha256::init() {
  // FIPS 180-4 §5.3.3 — fractional parts of the square roots of the first eight
  // primes.
  state_[0] = 0x6a09e667U;
  state_[1] = 0xbb67ae85U;
  state_[2] = 0x3c6ef372U;
  state_[3] = 0xa54ff53aU;
  state_[4] = 0x510e527fU;
  state_[5] = 0x9b05688cU;
  state_[6] = 0x1f83d9abU;
  state_[7] = 0x5be0cd19U;

  buffered_ = 0;
  totalBytes_ = 0;
  memset(buffer_, 0, sizeof(buffer_));
}

void Sha256::compress(const uint8_t block[kBlockSize]) {
  // The 64-word schedule is expanded in full rather than kept in a 16-word
  // rolling window. The window saves 192 bytes of stack and costs a modular
  // index on every access; on the ESP8266 the stack is not the scarce resource
  // and the rolling form is the version people get wrong. If this ever has to
  // run the signer on the ATmega, revisit that trade with a measurement.
  uint32_t w[64];

  for (size_t i = 0; i < 16; ++i) {
    w[i] = loadBigEndian32(block + (i * 4));
  }
  for (size_t i = 16; i < 64; ++i) {
    w[i] = smallSigma1(w[i - 2]) + w[i - 7] + smallSigma0(w[i - 15]) + w[i - 16];
  }

  uint32_t a = state_[0];
  uint32_t b = state_[1];
  uint32_t c = state_[2];
  uint32_t d = state_[3];
  uint32_t e = state_[4];
  uint32_t f = state_[5];
  uint32_t g = state_[6];
  uint32_t h = state_[7];

  for (size_t i = 0; i < 64; ++i) {
    const uint32_t t1 = h + bigSigma1(e) + ch(e, f, g) + kRoundConstants[i] + w[i];
    const uint32_t t2 = bigSigma0(a) + maj(a, b, c);

    h = g;
    g = f;
    f = e;
    e = d + t1;
    d = c;
    c = b;
    b = a;
    a = t1 + t2;
  }

  state_[0] += a;
  state_[1] += b;
  state_[2] += c;
  state_[3] += d;
  state_[4] += e;
  state_[5] += f;
  state_[6] += g;
  state_[7] += h;
}

void Sha256::update(const uint8_t* data, size_t len) {
  if (data == nullptr || len == 0) {
    return;
  }

  totalBytes_ += len;
  size_t offset = 0;

  // Top the partial block up first. Everything after that is consumed straight
  // out of the caller's buffer without a copy, which is what makes hashing a
  // streamed body cheap.
  if (buffered_ > 0) {
    const size_t wanted = kBlockSize - buffered_;
    const size_t take = (len < wanted) ? len : wanted;

    memcpy(buffer_ + buffered_, data, take);
    buffered_ += take;
    offset = take;

    if (buffered_ < kBlockSize) {
      return;
    }

    compress(buffer_);
    buffered_ = 0;
  }

  while ((len - offset) >= kBlockSize) {
    compress(data + offset);
    offset += kBlockSize;
  }

  const size_t rest = len - offset;
  if (rest > 0) {
    memcpy(buffer_, data + offset, rest);
    buffered_ = rest;
  }
}

void Sha256::final(uint8_t out[kDigestSize]) {
  // Length in BITS, big-endian, in the last 8 bytes — captured before padding
  // is appended, since the padding is not part of the message.
  const uint64_t bitLength = totalBytes_ * 8U;

  static const uint8_t kPaddingStart = 0x80U;
  update(&kPaddingStart, 1);

  // Zero-fill to 56 mod 64. When the 0x80 landed past byte 55 this rolls into a
  // second block, which is the case that a `len % 64 < 56` shortcut gets wrong;
  // the corpus carries inputs at 55, 56, 57, 63, 64 and 65 bytes for exactly
  // that reason.
  static const uint8_t kZero = 0U;
  while (buffered_ != 56) {
    update(&kZero, 1);
  }

  uint8_t lengthBytes[8];
  for (size_t i = 0; i < 8; ++i) {
    lengthBytes[i] = static_cast<uint8_t>(bitLength >> ((7U - i) * 8U));
  }
  update(lengthBytes, sizeof(lengthBytes));

  for (size_t i = 0; i < 8; ++i) {
    storeBigEndian32(state_[i], out + (i * 4));
  }
}

void Sha256::hash(const uint8_t* data, size_t len, uint8_t out[kDigestSize]) {
  Sha256 sha;
  sha.update(data, len);
  sha.final(out);
}

} // namespace dc
