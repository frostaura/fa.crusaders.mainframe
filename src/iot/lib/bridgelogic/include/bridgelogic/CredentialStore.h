// Crusaders Mainframe — what the ESP keeps in flash that is not the device key:
// the WiFi credential and the API base URL.
//
// WHY THE WIFI CREDENTIAL IS IN THE STORE
// ---------------------------------------
// It was a pair of compile-time macros from a gitignored secrets.h. That is
// fine for a board flashed over USB from the machine holding the header, and
// fatal for the OTA path: CI builds the signed release on a runner where the
// header cannot exist, so the first over-the-air release would have put an
// image with an EMPTY SSID on every box in the club, and no box would ever
// have joined a network again (review #1 — critical). A credential that has
// to survive a firmware update has to live in the part of flash a firmware
// update does not touch.
//
// So: a build that carries secrets.h joins with it and, once it has actually
// joined, writes it here; every later boot — and every CI image — reads it
// from here. A box provisioned once at the bench works on every release after.
//
// WHY THERE IS A `!WIFI` LINE
// ---------------------------
// A box whose stored credential is wrong (the club rotated the password) needs
// a way to be told the new one that does not require a machine holding
// secrets.h. With DIP 5 and 6 on, the ESP's UART is on the USB socket instead
// of the Mega, and a technician with a serial monitor at 9600 can type
//
//     !WIFI,<ssid>,<password>
//
// The line is taken from the same byte stream as the Mega link. That is safe
// by construction: the Mega only ever emits frames from its fixed verb table,
// none of which is WIFI, and no plausible corruption of one produces this
// prefix. An optional `*CC` XOR checksum (the v2 frame rule) is verified when
// present; `,` `*` `%` inside either value are written `%2C` `%2A` `%25`.
//
// WHY EVERY RECORD CARRIES AN INTEGRITY BYTE
// ------------------------------------------
// hal/Store.h makes it the caller's job: a torn write hands back a value that
// is half new and half old with kOk, and a half-old passphrase is a box that
// cannot join and cannot say why. A CRC-8 trailer turns that into "absent".
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

/// IEEE 802.11 limits. An SSID is up to 32 octets; a WPA2 passphrase is 8–63
/// characters, and an open network has none.
inline constexpr size_t kMaxSsidLen = 32U;
inline constexpr size_t kMaxWifiPasswordLen = 63U;

/// The longest API base URL the box will hold. The same bound as the OTA URL
/// (ota::kMaxUrlLen): both are "a LAN address, maybe a name, plus a port".
inline constexpr size_t kMaxApiUrlLen = 120U;

/// Store keys. Short ASCII, inside hal::kStoreMaxKeyLen.
inline constexpr char kKeyWifiSsid[] = "wifi_ssid";
inline constexpr char kKeyWifiPassword[] = "wifi_pass";
inline constexpr char kKeyApiBase[] = "api_base";
/// The pre-trailer, 32-byte-capped URL record. Read, never written.
inline constexpr char kKeyApiUrlLegacy[] = "api_url";

static_assert(kMaxWifiPasswordLen + 1U <= hal::kStoreMaxValueLen,
              "a passphrase plus its trailer must fit a record");
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

// --- the WiFi credential --------------------------------------------------

struct WifiCredential {
  char ssid[kMaxSsidLen + 1U] = {};
  char password[kMaxWifiPasswordLen + 1U] = {};

  bool present() const { return ssid[0] != '\0'; }

  /// Sets both fields. False — with the credential CLEARED — when either is
  /// over its limit: a truncated SSID is a different network.
  bool set(const char* newSsid, const char* newPassword);

  bool equals(const WifiCredential& other) const;
};

/// Where the credential the box joins with came from.
enum class WifiSource : uint8_t {
  /// Neither a compiled-in nor a stored credential. The box cannot join.
  None = 0U,
  /// secrets.h was present at build time. The bench / first-flash path.
  CompiledIn = 1U,
  /// Read from the store. The OTA path, and every boot after the first join.
  Stored = 2U,
};

/// The boot rule. A compiled-in credential wins when there is one — it is the
/// technician's most recent statement of intent, and the way a rotated
/// password reaches the store — otherwise the stored one, otherwise nothing.
WifiSource chooseWifiCredential(const WifiCredential& compiledIn, const WifiCredential& stored,
                                WifiCredential& out);

/// True when a credential the box has just JOINED with should be written:
/// it differs from what the store holds. Persisting on join rather than at
/// boot is deliberate — a typo in secrets.h must not overwrite a credential
/// that works.
bool shouldPersistWifi(const WifiCredential& joined, const WifiCredential& stored);

bool loadWifiCredential(hal::IStore& store, WifiCredential& out);
bool storeWifiCredential(hal::IStore& store, const WifiCredential& credential);

// --- the API base URL -----------------------------------------------------

/// Reads the URL: the checked `api_base` record, else the legacy `api_url`
/// one. False with `out` empty when neither is there.
bool loadApiUrl(hal::IStore& store, char* out, size_t cap);

/// Writes the URL under `api_base` and retires the legacy record. False when
/// the URL is empty, longer than kMaxApiUrlLen, or the store refused — refused
/// loudly rather than truncated: half a URL is a request to somewhere else.
bool storeApiUrl(hal::IStore& store, const char* url);

// --- the `!WIFI` provisioning line ----------------------------------------

/// Parses `!WIFI,<ssid>,<password>` with an optional `*CC` trailer. Values are
/// %-unescaped. False on anything else, including a trailer that does not
/// verify and a value over its limit.
bool parseWifiLine(const char* line, size_t n, WifiCredential& out);

/// Watches a byte stream for a complete `!WIFI,...` line. Anything else is
/// discarded byte by byte — nothing that is not this one line is ever held.
class WifiLineAssembler {
public:
  /// The longest line accepted: the prefix, both values fully %-escaped, the
  /// trailer. Longer lines are discarded to the terminator.
  static constexpr size_t kMaxLineLen = 6U + (kMaxSsidLen * 3U) + 1U + (kMaxWifiPasswordLen * 3U) + 3U;

  /// Feed one byte. True when a complete line is ready in line()/length().
  bool feed(char c);

  const char* line() const { return line_; }

  size_t length() const { return len_; }

  void reset();

private:
  char line_[kMaxLineLen + 1U] = {};
  size_t len_ = 0U;
  bool discarding_ = false;
  bool ready_ = false;
};

} // namespace bridgelogic

#endif // CRUSADERS_BRIDGELOGIC_CREDENTIALSTORE_H
