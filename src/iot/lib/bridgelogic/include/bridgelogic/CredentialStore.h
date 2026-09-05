// Crusaders Mainframe — what the ESP keeps in flash besides the device key:
// the API base URL, and the checked-record primitive the whole store rests on.
//
// WHAT USED TO BE HERE, AND WHY IT IS NOT
// ---------------------------------------
// The club WiFi credential lived here too, with a `!WIFI,<ssid>,<password>`
// provisioning line over USB and a precedence rule between the store and a
// compiled-in secrets.h. All of it is gone: the credential is compiled in, and
// a password change is a reflash. One club, one box, and the person who flashes
// it is the person who knows the password — so the runtime store bought nothing
// and cost a precedence rule that shipped backwards once (review 3, finding 1),
// a provisioning path whose acknowledgement appeared where nobody was looking
// (finding 19), and a boot screen promising a state that could not be reached
// (finding 9).
//
// WHAT STAYS, AND WHY
// -------------------
// The device credential and the API base URL. Those come from provisioning —
// the admin presses "connect" once against the claim code on the glass — and if
// they did not survive a power cycle the box would re-provision itself every
// time the breaker tripped. That is the thing flash is here for.
//
// WHY EVERY RECORD CARRIES AN INTEGRITY BYTE
// ------------------------------------------
// hal/Store.h makes it the caller's job: a torn write hands back a value that
// is half new and half old with kOk, and half a URL is a request to somewhere
// else. A CRC-8 trailer turns that into "absent".
//
// WHY THE URL MOVED TO A NEW KEY
// ------------------------------
// The old `api_url` record was capped at 32 bytes and a longer URL was
// silently truncated in RAM and quietly not persisted — a DNS-named advertised
// base failed discovery with nothing on the glass. `api_base` holds up to
// kMaxApiUrlLen with the trailer; a box that only has the old key still boots
// off it, and the first store of a new URL retires it.
//
// No Arduino headers, no heap, no String. Compiles for Xtensa and the host.

#ifndef CRUSADERS_BRIDGELOGIC_CREDENTIALSTORE_H
#define CRUSADERS_BRIDGELOGIC_CREDENTIALSTORE_H

#include <stddef.h>
#include <stdint.h>

#include "hal/Store.h"

namespace bridgelogic {

/// The longest API base URL the box will hold: "a LAN address, maybe a name,
/// plus a port", with room for a DNS name rather than an IP.
inline constexpr size_t kMaxApiUrlLen = 120U;

/// Store keys. Short ASCII, inside hal::kStoreMaxKeyLen.
inline constexpr char kKeyApiBase[] = "api_base";
/// The pre-trailer, 32-byte-capped URL record. Read, never written.
inline constexpr char kKeyApiUrlLegacy[] = "api_url";

static_assert(kMaxApiUrlLen + 1U <= hal::kStoreMaxValueLen, "a URL plus its trailer must fit a record");

// --- checked text records ------------------------------------------------

/// CRC-8 (polynomial 0x07) over `len` bytes. The trailer every record here ends
/// with; exposed so the fakes' torn-write tests can assert what a mongrel
/// record fails on.
uint8_t crc8(const uint8_t* data, size_t len);

/// Writes `text` under `key` with the trailer. False when the text is longer
/// than the record can hold — refused, never truncated — or the store refused.
bool putCheckedText(hal::IStore& store, const char* key, const char* text);

/// Reads `key` into `out` (capacity `cap`, NUL-terminated). False, with `out`
/// empty, when absent, when the trailer does not match (a torn write reads as
/// no record), or when the text would not fit `cap`.
bool getCheckedText(hal::IStore& store, const char* key, char* out, size_t cap);

// --- the API base URL -----------------------------------------------------

/// Reads the URL: the checked `api_base` record, else the legacy `api_url`
/// one. False with `out` empty when neither is there.
bool loadApiUrl(hal::IStore& store, char* out, size_t cap);

/// Writes the URL under `api_base` and retires the legacy record. False when
/// the URL is empty, longer than kMaxApiUrlLen, or the store refused — refused
/// loudly rather than truncated: half a URL is a request to somewhere else.
bool storeApiUrl(hal::IStore& store, const char* url);

} // namespace bridgelogic

#endif // CRUSADERS_BRIDGELOGIC_CREDENTIALSTORE_H
