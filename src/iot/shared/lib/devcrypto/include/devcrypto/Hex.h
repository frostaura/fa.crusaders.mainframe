// Crusaders Mainframe — lowercase hex.
//
// WHY LOWERCASE IS A RULE, NOT A PREFERENCE
// -----------------------------------------
// Hex leaves this box in two places — the MAC that names the device in every
// request body, and the walk-up purchase nonce that makes a retry replay-safe —
// and the server compares both as text. Hex case is invisible in a log and
// fatal in a comparison, so the encoder here only ever emits [0-9a-f] and there
// is no case parameter to get wrong at a call site.
//
// WHAT ELSE IS BESIDE THIS
// ------------------------
// Firmware 2.0.0 deleted SHA-256, HMAC-SHA256, HKDF and the canonical-string
// request signer with request signing — one club, one box, one static bearer
// key. SHA-256, HMAC and HKDF came back in `Sha256.h`, with `Base64Url.h`, for
// a narrower job: verifying the OFF half of a member's single rotating code
// offline (docs/specs/member-code.md). Requests are still NOT signed; the
// request signer and its canonical string are gone for good.
//
// No Arduino headers, no heap, no String. Compiles for AVR, Xtensa and the host.

#ifndef CRUSADERS_DEVCRYPTO_HEX_H
#define CRUSADERS_DEVCRYPTO_HEX_H

#include <stddef.h>
#include <stdint.h>

namespace dc {
namespace hex {

/// Bytes needed to hold `byteCount` bytes as hex text, including the
/// terminator. constexpr so buffers can be sized from a length rather than from
/// a literal that drifts.
constexpr size_t encodedSize(size_t byteCount) {
  return (byteCount * 2) + 1;
}

/// Writes `len * 2` lowercase hex characters plus a NUL. Returns false and
/// writes nothing if `outCap` is too small — silently truncating a MAC would
/// produce a request that names a different device for no visible reason.
bool encodeLower(const uint8_t* data, size_t len, char* out, size_t outCap);

/// Decodes hex text. Rejects odd lengths and any non-hex character rather than
/// skipping them: a value with a typo in it must fail loudly, not silently
/// become a different value. Accepts both cases on input — this side reads what
/// a human pasted, unlike the encoder.
bool decode(const char* text, size_t textLen, uint8_t* out, size_t outCap, size_t* outLen);

} // namespace hex
} // namespace dc

#endif // CRUSADERS_DEVCRYPTO_HEX_H
