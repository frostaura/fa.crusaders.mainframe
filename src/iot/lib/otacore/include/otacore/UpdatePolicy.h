// Crusaders Mainframe — whether to take the update the heartbeat is offering.
//
// WHY THE DECISION IS ITS OWN THING
// ---------------------------------
// The install is platform code — the ESP8266 core's Updater, with a BearSSL
// public key checking the image's signature. That cannot run on the host, and it
// is not where the interesting mistakes are. The interesting mistakes are all
// decisions: taking a downgrade, taking a build already known to break, taking an
// image that will not fit and bricking the box discovering it, or reflashing the
// same broken firmware in a loop across every board in the club at once.
//
// So the decision lives here, where `pio test -e native` drives it, and main.cpp
// does nothing but obey it.
//
// SIGNING: WHAT WAS PLANNED AND WHAT IS BUILT
// -------------------------------------------
// The plan called for **Ed25519**, on the correct reasoning that an HMAC keyed
// with the device key would let one compromised box forge firmware for the whole
// fleet — the update must be signed by a key no box holds.
//
// It is built with **RSA-2048/SHA-256** instead, because that is the ESP8266
// Arduino core's supported signed-update path (`Updater::installSignature` with
// `BearSSL::PublicKey` and `BearSSL::SigningVerifier`), and BearSSL — the TLS
// stack already linked into this image — has no Ed25519. The alternative was
// vendoring a curve implementation into a court-lighting controller, which is a
// worse trade than a larger signature.
//
// **The security property the plan asked for is unchanged**: the signing key is
// asymmetric and lives only where releases are built, so a stolen board yields
// nothing that can sign firmware for any other board. What differs is the
// algorithm and a few hundred bytes per image.
//
// No Arduino headers, no heap, no String. Compiles for AVR, Xtensa and the host.

#ifndef CRUSADERS_OTACORE_UPDATEPOLICY_H
#define CRUSADERS_OTACORE_UPDATEPOLICY_H

#include <stddef.h>
#include <stdint.h>

#include "otacore/BootGuard.h"
#include "otacore/Version.h"

namespace ota {

/// Longest update URL the box will accept. Long enough for a LAN address with a
/// path; short enough to sit in a stack buffer on a part with 80 KB of RAM.
inline constexpr size_t kMaxUrlLen = 120U;

/// What the heartbeat's `ota` object offered.
struct Manifest {
  char version[kMaxVersionLen] = {};
  char url[kMaxUrlLen + 1U] = {};
  uint32_t sizeBytes = 0U;
  bool present = false;
};

/// Why the box will or will not take it. Every refusal is distinct because each
/// one means something different to whoever is reading the admin screen.
enum class Decision : uint8_t {
  /// Fetch and install.
  Install = 0U,
  /// No `ota` object in the heartbeat. The ordinary case.
  NothingOffered = 1U,
  /// The offer is the version already running, or an older one. Downgrades are
  /// refused rather than treated as updates: a box that took whatever it was
  /// offered would flap between two versions if a manifest were ever rolled back.
  NotNewer = 2U,
  /// This exact build has already been installed, failed to prove itself, and
  /// been condemned. The one refusal that stops a fleet reflashing in a loop.
  KnownBad = 3U,
  /// The image will not fit in the space the platform reports as free. Refused
  /// BEFORE the download, because discovering it halfway leaves a half-written
  /// sketch on a board in a locked cupboard.
  WillNotFit = 4U,
  /// The manifest is malformed — no version, no URL, or a size of zero.
  Unusable = 5U,
  /// A court is lit, an extension is owed, or a member is at the panel. The
  /// install blocks for the whole download and then reboots, and the reboot
  /// loses the per-court booking ends `!EXT` needs. Retried on the next
  /// heartbeat, which is how it eventually installs on a quiet box.
  Deferred = 6U,
  /// This exact manifest has already failed to install kInstallAttempts times
  /// in a row. Almost always a signature the box cannot verify — a release
  /// signed with a private key that does not match the compiled-in public one
  /// — which no number of retries fixes, and which costs a ~400 KB download
  /// and a screen full of UPDATING / UPDATE FAILED on every heartbeat until
  /// somebody notices.
  InstallFailed = 7U,
};

/// How many times one manifest is allowed to fail before it is skipped.
///
/// Not one: an interrupted download on a flapping link is a transient and
/// deserves another go. Not unbounded: a signature mismatch fails identically
/// every time, and the loop it produces (review 3, finding 5) paints
/// UPDATING / DO NOT POWER OFF over a live session at every heartbeat — 15 to
/// 300 seconds apart — for as long as the release stands. Three bounds the
/// damage to three downloads while leaving a genuine transient two retries.
inline constexpr uint8_t kInstallAttempts = 3U;

/// Remembers the manifest that is failing to install, so the fleet stops
/// reflashing it.
///
/// Keyed on the whole offer — version, URL and size — rather than the version
/// alone: re-signing a release and re-uploading it under the same version is
/// exactly the repair an operator makes after a key mismatch, and it must
/// clear the memory. Any change to any of the three is a different offer and
/// gets a fresh set of attempts.
///
/// RAM-only, deliberately. A reboot gives the offer one more chance, which is
/// the right trade for a box whose LittleFS holds the device credential and
/// whose flash cells are not free: the loop this closes is a per-heartbeat
/// loop, not a per-boot one.
class InstallMemo {
public:
  /// An install of `manifest` was attempted and failed.
  void failed(const Manifest& manifest);

  /// True when `manifest` has run out of attempts.
  bool exhausted(const Manifest& manifest) const;

  /// The version currently being skipped, or "" when none is. What a heartbeat
  /// would report if the API had a field for it.
  const char* skippedVersion() const;

private:
  bool matches(const Manifest& manifest) const;

  char version_[kMaxVersionLen] = {};
  char url_[kMaxUrlLen + 1U] = {};
  uint32_t sizeBytes_ = 0U;
  uint8_t failures_ = 0U;
};

/// Reads the `ota` object out of a heartbeat response. `present` is false when
/// there is no offer, which is not an error and is what most heartbeats carry.
Manifest parseManifest(const char* body, size_t len);

/// What the box is doing that an install must not interrupt, and what it has
/// already learned about this offer. Both default to "nothing", so a host test
/// that cares about neither passes nothing.
struct InstallGate {
  /// bridgelogic::anyCourtBusy — a court held, an `!EXT` owed, or an armed
  /// button window.
  bool courtsBusy = false;
  /// The memo, or null when the caller keeps none.
  const InstallMemo* memo = nullptr;
};

/// The decision. `freeSketchSpace` is what the platform says is available; pass
/// 0 on a host test to skip the size check.
Decision decide(const Manifest& manifest, const char* runningVersion, const BootGuard& guard,
                uint32_t freeSketchSpace, const InstallGate& gate = InstallGate{});

/// A one-line reason for the admin screen and the heartbeat report. Never null.
const char* describe(Decision decision);

} // namespace ota

#endif // CRUSADERS_OTACORE_UPDATEPOLICY_H
