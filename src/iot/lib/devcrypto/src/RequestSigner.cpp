#include "devcrypto/RequestSigner.h"

#include <string.h>

#include "devcrypto/Hex.h"

namespace dc {
namespace signer {
namespace {

constexpr char kFieldSeparator = '\n';

/// ASCII upper-case only. HTTP methods are ASCII tokens (RFC 9110 §9), and the
/// server uses ToUpperInvariant, so a locale-aware mapping here would be a
/// divergence rather than a nicety — Turkish 'i' being the classic way that
/// bites.
inline char upperAscii(char c) {
  return (c >= 'a' && c <= 'z') ? static_cast<char>(c - ('a' - 'A')) : c;
}

/// A cursor over a fixed output buffer that refuses to overflow and remembers
/// that it refused. Checking every append at the call site is how one of them
/// ends up unchecked.
class Writer {
public:
  Writer(char* out, size_t cap) : out_(out), cap_(cap) {}

  void put(char c) {
    if (!ok_ || len_ + 1 >= cap_) {
      ok_ = false;
      return;
    }
    out_[len_] = c;
    ++len_;
  }

  void puts(const char* s) {
    if (s == nullptr) {
      return; // An absent nonce signs as empty, matching a server-side null.
    }
    for (size_t i = 0; s[i] != '\0'; ++i) {
      put(s[i]);
    }
  }

  void putsUpper(const char* s) {
    if (s == nullptr) {
      return;
    }
    for (size_t i = 0; s[i] != '\0'; ++i) {
      put(upperAscii(s[i]));
    }
  }

  /// Returns the length written, or 0 if anything was dropped. Always
  /// terminates what it did write.
  size_t finish() {
    if (out_ == nullptr || cap_ == 0) {
      return 0;
    }
    out_[ok_ ? len_ : 0] = '\0';
    return ok_ ? len_ : 0;
  }

private:
  char* out_;
  size_t cap_;
  size_t len_ = 0;
  bool ok_ = true;
};

/// Feeds a NUL-terminated string into a MAC without a length pass over it
/// first; strlen would walk it twice.
void macPuts(HmacSha256& mac, const char* s) {
  if (s == nullptr) {
    return;
  }
  mac.update(reinterpret_cast<const uint8_t*>(s), strlen(s));
}

void macPutChar(HmacSha256& mac, char c) {
  const uint8_t byte = static_cast<uint8_t>(c);
  mac.update(&byte, 1);
}

} // namespace

size_t formatUnsigned(uint64_t value, char* out, size_t outCap) {
  char digits[kMaxUnsignedDigits];
  size_t count = 0;

  // Emitted least-significant first, then reversed. Repeated division by 10 on
  // a 64-bit value is not free on an 8-bit core, but it happens once per
  // request and it is correct on every target, which %llu is not.
  do {
    digits[count] = static_cast<char>('0' + static_cast<char>(value % 10U));
    value /= 10U;
    ++count;
  } while (value != 0U && count < kMaxUnsignedDigits);

  if (out == nullptr || outCap < count + 1) {
    return 0;
  }

  for (size_t i = 0; i < count; ++i) {
    out[i] = digits[count - 1 - i];
  }
  out[count] = '\0';
  return count;
}

void feedCanonical(HmacSha256& mac, const DeviceRequest& request,
                   const uint8_t bodyHash[Sha256::kDigestSize]) {
  char scratch[Sha256::kHexSize];

  if (request.method != nullptr) {
    for (size_t i = 0; request.method[i] != '\0'; ++i) {
      macPutChar(mac, upperAscii(request.method[i]));
    }
  }
  macPutChar(mac, kFieldSeparator);

  macPuts(mac, request.pathAndQuery);
  macPutChar(mac, kFieldSeparator);

  const size_t digits = formatUnsigned(request.unixSeconds, scratch, sizeof(scratch));
  mac.update(reinterpret_cast<const uint8_t*>(scratch), digits);
  macPutChar(mac, kFieldSeparator);

  macPuts(mac, request.nonce);
  macPutChar(mac, kFieldSeparator);

  if (hex::encodeLower(bodyHash, Sha256::kDigestSize, scratch, sizeof(scratch))) {
    mac.update(reinterpret_cast<const uint8_t*>(scratch), Sha256::kDigestSize * 2);
  }
}

size_t canonicalString(const DeviceRequest& request, const uint8_t bodyHash[Sha256::kDigestSize], char* out,
                       size_t outCap) {
  char bodyHex[Sha256::kHexSize];
  if (!hex::encodeLower(bodyHash, Sha256::kDigestSize, bodyHex, sizeof(bodyHex))) {
    return 0;
  }

  char timestamp[kMaxUnsignedDigits + 1];
  if (formatUnsigned(request.unixSeconds, timestamp, sizeof(timestamp)) == 0) {
    return 0;
  }

  Writer w(out, outCap);
  w.putsUpper(request.method);
  w.put(kFieldSeparator);
  w.puts(request.pathAndQuery);
  w.put(kFieldSeparator);
  w.puts(timestamp);
  w.put(kFieldSeparator);
  w.puts(request.nonce);
  w.put(kFieldSeparator);
  w.puts(bodyHex);
  return w.finish();
}

size_t canonicalStringFromBody(const DeviceRequest& request, const ByteSpan& body, char* out, size_t outCap) {
  uint8_t bodyHash[Sha256::kDigestSize];
  Sha256::hash(body.data, body.len, bodyHash);
  return canonicalString(request, bodyHash, out, outCap);
}

bool sign(const DeviceRequest& request, const uint8_t bodyHash[Sha256::kDigestSize], const ByteSpan& key,
          char* outHex, size_t outCap) {
  if (outHex == nullptr || outCap < kSignatureBufSize) {
    return false;
  }

  HmacSha256 mac;
  mac.init(key.data, key.len);
  feedCanonical(mac, request, bodyHash);

  uint8_t signature[HmacSha256::kDigestSize];
  mac.final(signature);

  return hex::encodeLower(signature, sizeof(signature), outHex, outCap);
}

bool signBody(const DeviceRequest& request, const ByteSpan& body, const ByteSpan& key, char* outHex,
              size_t outCap) {
  uint8_t bodyHash[Sha256::kDigestSize];
  Sha256::hash(body.data, body.len, bodyHash);
  return sign(request, bodyHash, key, outHex, outCap);
}

bool verify(const DeviceRequest& request, const uint8_t bodyHash[Sha256::kDigestSize], const ByteSpan& key,
            const char* presented) {
  char expected[kSignatureBufSize];
  if (!sign(request, bodyHash, key, expected, sizeof(expected))) {
    return false;
  }
  return hex::constantTimeEqualsText(expected, presented);
}

} // namespace signer
} // namespace dc
