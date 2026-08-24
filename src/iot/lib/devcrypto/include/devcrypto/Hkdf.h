// Crusaders Mainframe — HKDF-SHA256 (RFC 5869), extract-then-expand.
//
// WHY THIS EXISTS
// ---------------
// The server derives every device key from one master secret: salt = the
// tenant's GUID, info = "crusaders-device:<device-id>:v<version>". Nothing
// per-device is stored, so rotation is a version bump. Today the device carries
// the derived key, flashed at provisioning — this is here so that a device that
// is instead given a master and an identity can reach the same 32 bytes, and
// because deriving a key the server already published is the cheapest possible
// end-to-end proof that the HMAC underneath is correct.
//
// The salt is a .NET Guid.ToByteArray(), whose first three groups are
// little-endian while the last two are not. That layout is a .NET
// implementation detail and nothing else in this codebase depends on it, so the
// firmware never re-derives the salt from a GUID string: it is handed the
// 16 salt bytes as they are. Reconstructing them here from the printed GUID is
// the mistake this comment exists to prevent.

#ifndef CRUSADERS_DEVCRYPTO_HKDF_H
#define CRUSADERS_DEVCRYPTO_HKDF_H

#include <stddef.h>
#include <stdint.h>

#include "devcrypto/ByteSpan.h"
#include "devcrypto/HmacSha256.h"

namespace dc {
namespace hkdf {

/// The three RFC 5869 inputs, bundled so the derive call stays inside the
/// parameter-count gate and so ikm, salt and info cannot be transposed at a
/// call site — a transposition that produces a plausible-looking wrong key.
struct Inputs {
  ByteSpan ikm;
  ByteSpan salt;
  ByteSpan info;
};

/// PRK = HMAC(salt, ikm). An empty salt means HashLen zero bytes, per §2.2 —
/// that is the specified behaviour, not a caller error.
void extract(const ByteSpan& salt, const ByteSpan& ikm, uint8_t prk[HmacSha256::kDigestSize]);

/// OKM of `outLen` bytes. False if outLen is 0 or exceeds 255 * HashLen, the
/// hard ceiling of the one-byte counter in §2.3.
bool expand(const uint8_t prk[HmacSha256::kDigestSize], const ByteSpan& info, uint8_t* out, size_t outLen);

/// extract followed by expand.
bool derive(const Inputs& in, uint8_t* out, size_t outLen);

} // namespace hkdf
} // namespace dc

#endif // CRUSADERS_DEVCRYPTO_HKDF_H
