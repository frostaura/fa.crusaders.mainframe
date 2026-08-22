// Crusaders Mainframe — lowercase hex, and the comparison used to check a MAC.
//
// WHY LOWERCASE IS A RULE, NOT A PREFERENCE
// -----------------------------------------
// The server produces its signatures with Convert.ToHexString(...).ToLowerInvariant()
// and the existing webhook signature convention is lowercase too. Hex case is
// invisible in a log and fatal in a comparison, so the encoder here only ever
// emits [0-9a-f] and there is no case parameter to get wrong at a call site.
//
// WHY THE COMPARISON LIVES HERE
// -----------------------------
// A signature check written with memcmp or strcmp returns as soon as it finds a
// difference, so the time it takes says how many leading bytes were right. That
// is a byte-at-a-time oracle: an attacker who can retry recovers a valid
// signature in ~16 * 64 attempts instead of 2^256. The device compares MACs
// when it verifies a server response, so the firmware needs this as much as the
// server does.
//
// Length is treated as public: the signature is always 64 hex characters, so a
// length mismatch is not a secret worth hiding and is rejected up front. This
// matches CryptographicOperations.FixedTimeEquals, which likewise requires
// equal lengths.

#ifndef CRUSADERS_DEVCRYPTO_HEX_H
#define CRUSADERS_DEVCRYPTO_HEX_H

#include <stddef.h>
#include <stdint.h>

namespace dc {
namespace hex {

/// Bytes needed to hold `byteCount` bytes as hex text, including the
/// terminator. constexpr so buffers can be sized from a digest length rather
/// than from a literal that drifts.
constexpr size_t encodedSize(size_t byteCount) {
  return (byteCount * 2) + 1;
}

/// Writes `len * 2` lowercase hex characters plus a NUL. Returns false and
/// writes nothing if `outCap` is too small — silently truncating a signature
/// would produce a request that fails authentication for no visible reason.
bool encodeLower(const uint8_t* data, size_t len, char* out, size_t outCap);

/// Decodes hex text. Rejects odd lengths and any non-hex character rather than
/// skipping them: a signing key with a typo in it must fail at provisioning,
/// not silently become a different key. Accepts both cases on input — this side
/// reads what a human pasted, unlike the encoder.
bool decode(const char* text, size_t textLen, uint8_t* out, size_t outCap, size_t* outLen);

/// Constant-time equality over the shorter-of-equal lengths; see the header
/// comment for why memcmp is not acceptable here.
bool constantTimeEquals(const uint8_t* a, size_t aLen, const uint8_t* b, size_t bLen);

/// Same, for NUL-terminated hex text such as a presented signature header.
/// `presented` may be null, which is what a missing header looks like.
bool constantTimeEqualsText(const char* expected, const char* presented);

} // namespace hex
} // namespace dc

#endif // CRUSADERS_DEVCRYPTO_HEX_H
