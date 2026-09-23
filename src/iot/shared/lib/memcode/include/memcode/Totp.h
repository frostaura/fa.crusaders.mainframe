// Crusaders Mainframe — the arithmetic of the two codes.
//
// ON and OFF are both TOTP (RFC 6238) in its SHA-256 mode: an HMAC-SHA-256 of
// the 30-second step counter as eight big-endian bytes, cut to a number by
// RFC 4226's dynamic truncation — the offset is the low nibble of the digest's
// LAST byte — and reduced modulo 10^digits. They differ only in the key:
//
//     ON  = TOTP-8 (member secret S,              step)   server only
//     OFF = TOTP-6 (K_day = HMAC(S, label|day)[0:12], step) offline too
//
// A device only ever computes OFF, under a K_day the heartbeat gave it. The
// derivations of S and K_day are here as well so the host suite can prove the
// whole chain against derivation.json — no board calls them, and the linker
// drops them from every image.
//
// DOMAIN SEPARATION, STATED BECAUSE IT IS NOT OBVIOUS
// ---------------------------------------------------
// S keys two HMACs: ON's, over exactly eight bytes, and K_day's, over the
// ASCII label `crusaders/kday/v1|YYYY-MM-DD` — twenty-eight bytes that begin
// with a letter. No input to one can be an input to the other, so K_day never
// equals an ON digest and handing a day's key to a device hands it nothing
// about ON. That is the property that makes a stolen court box able to forge
// OFF for a day and never ON at all.
//
// No Arduino headers, no heap. Compiles for AVR, Xtensa and the host.

#ifndef CRUSADERS_MEMCODE_TOTP_H
#define CRUSADERS_MEMCODE_TOTP_H

#include <stddef.h>
#include <stdint.h>

namespace memcode {

/// The TOTP step, in seconds and milliseconds. T0 is the Unix epoch.
inline constexpr uint32_t kStepSeconds = 30U;
inline constexpr uint32_t kStepMs = kStepSeconds * 1000UL;

/// The verification window, in steps either side of the verifier's own.
inline constexpr uint32_t kWindowSteps = 1U;

/// Bytes of a member secret and of a day key.
inline constexpr size_t kSecretBytes = 32U;
inline constexpr size_t kDayKeyBytes = 12U;

/// The K_day label's prefix; the club day (`YYYY-MM-DD`) follows it.
inline constexpr char kDayKeyLabel[] = "crusaders/kday/v1|";

/// The HKDF salt, and the info string's prefix, of a member secret.
inline constexpr char kSecretSalt[] = "crusaders/member-code/v1";
inline constexpr char kSecretInfoPrefix[] = "member-secret|";

/// RFC 4226 HOTP over HMAC-SHA-256: `digits` in [1, 9], the value modulo
/// 10^digits. 0 for a null key or a digit count out of range — a caller that
/// compares against 0 is comparing against a code that is never produced by a
/// real key only one time in 10^digits, which is why every caller checks its
/// own inputs first.
uint32_t hotp(const uint8_t* key, size_t keyLen, uint64_t counter, uint8_t digits);

/// The ON code at `step`, under a 32-byte member secret.
uint32_t onCode(const uint8_t* secret, uint32_t step);

/// The OFF code at `step`, under a 12-byte day key.
uint32_t offCode(const uint8_t* dayKey, uint32_t step);

/// K_day for `clubDay` (`YYYY-MM-DD`, ten characters) under `secret`. False on
/// a club day that is not ten characters.
bool deriveDayKey(const uint8_t* secret, const char* clubDay, uint8_t* out);

/// The member secret: HKDF-SHA-256(salt = kSecretSalt, IKM = master,
/// info = "member-secret|<tenant>|<user>|<generation>", L = 32). Tenant and
/// user are canonical lower-case UUIDs. SERVER ONLY; here for the host suite.
bool deriveMemberSecret(const uint8_t* master, size_t masterLen, const char* tenantId, const char* userId,
                        uint32_t generation, uint8_t* out);

} // namespace memcode

#endif // CRUSADERS_MEMCODE_TOTP_H
