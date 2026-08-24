// Crusaders Mainframe — the canonical string a device signs, and the HMAC over it.
//
// THE FORMAT (must match DeviceRequestSigner.CanonicalString on the server)
// ------------------------------------------------------------------------
//     METHOD \n PATH_AND_QUERY \n UNIX_SECONDS \n NONCE \n lowercase_hex(sha256(body))
//
// Method upper-cased; path taken verbatim including its query, so a signature
// for GET /a cannot be replayed against POST /a or /a?admin=1. Every field is
// newline-delimited and the body is hashed rather than embedded, so no two
// distinct requests can produce the same signing string.
//
// WHY THE TIMESTAMP IS 64-BIT
// ---------------------------
// The server passes a long and the corpus carries 4294967295, which is neither
// an int32 nor a plausible clock reading — it is there precisely because a
// firmware that stores the timestamp in a 32-bit signed value produces
// "-1" and a 401 that nobody can explain. It is formatted by repeated division
// rather than with printf: %lld is unreliable on AVR's cut-down libc, and
// pulling in a full printf costs about 1.5 KB of flash to render one integer.
//
// WHY THE CANONICAL STRING IS OPTIONAL
// ------------------------------------
// The signing path never materialises it. sign() feeds the fields straight into
// the HMAC, so there is no canonical buffer, no maximum path length to get
// wrong, and no truncation to produce a valid signature over the wrong request.
// canonicalString() exists for the corpus test and for diagnostics, where being
// able to print the exact bytes is worth the buffer.

#ifndef CRUSADERS_DEVCRYPTO_REQUESTSIGNER_H
#define CRUSADERS_DEVCRYPTO_REQUESTSIGNER_H

#include <stddef.h>
#include <stdint.h>

#include "devcrypto/ByteSpan.h"
#include "devcrypto/HmacSha256.h"
#include "devcrypto/Sha256.h"

namespace dc {

/// The request being signed. Strings are NUL-terminated and borrowed; none of
/// them is copied.
struct DeviceRequest {
  const char* method = nullptr;
  const char* pathAndQuery = nullptr;
  uint64_t unixSeconds = 0;
  const char* nonce = nullptr;
};

namespace signer {

/// 64 hex characters plus a terminator.
constexpr size_t kSignatureHexLen = Sha256::kDigestSize * 2;
constexpr size_t kSignatureBufSize = kSignatureHexLen + 1;

/// Longest uint64 in decimal is 20 digits.
constexpr size_t kMaxUnsignedDigits = 20;

/// Decimal, no sign, no padding, no printf. Returns characters written
/// excluding the terminator, or 0 if the buffer is too small — 0 is
/// unambiguous because the value 0 still writes one character.
size_t formatUnsigned(uint64_t value, char* out, size_t outCap);

/// Feeds the canonical string into an already-initialised HMAC. This is the
/// path the firmware uses; the string never exists in one piece.
void feedCanonical(HmacSha256& mac, const DeviceRequest& request,
                   const uint8_t bodyHash[Sha256::kDigestSize]);

/// Materialises the canonical string. Returns its length excluding the
/// terminator, or 0 if it does not fit. Not used on the signing path.
size_t canonicalString(const DeviceRequest& request, const uint8_t bodyHash[Sha256::kDigestSize], char* out,
                       size_t outCap);

/// Same, hashing an in-memory body first. A streamed body must be hashed by the
/// caller and passed to the bodyHash form.
size_t canonicalStringFromBody(const DeviceRequest& request, const ByteSpan& body, char* out, size_t outCap);

/// Lowercase hex HMAC-SHA256 over the canonical string. `outCap` must be at
/// least kSignatureBufSize.
bool sign(const DeviceRequest& request, const uint8_t bodyHash[Sha256::kDigestSize], const ByteSpan& key,
          char* outHex, size_t outCap);

/// Same, for an in-memory body.
bool signBody(const DeviceRequest& request, const ByteSpan& body, const ByteSpan& key, char* outHex,
              size_t outCap);

/// Constant-time verification of a presented lowercase-hex signature. False for
/// a null or wrong-length signature; never leaks how many characters matched.
bool verify(const DeviceRequest& request, const uint8_t bodyHash[Sha256::kDigestSize], const ByteSpan& key,
            const char* presented);

} // namespace signer
} // namespace dc

#endif // CRUSADERS_DEVCRYPTO_REQUESTSIGNER_H
