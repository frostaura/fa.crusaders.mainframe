// Crusaders Mainframe — surviving a firmware that does not work.
//
// WHAT ROLLBACK CANNOT BE HERE, SAID FIRST
// ----------------------------------------
// A proper rollback keeps the previous image and boots it again. The ESP8266
// does that with two OTA slots, and this board does not have room: a 4M part
// carrying a 1 MB sketch and 2 MB of LittleFS has no second slot, and the
// filesystem is not optional — it holds the device credential.
//
// So there is no reverting. What this buys instead is the thing that actually
// bricks a fleet: **it stops the box taking the same broken update again.** A
// bad image that boots, fails to work, and is offered the same update on the
// next heartbeat would otherwise reflash itself forever, and every box in the
// club would do it at once because they all heartbeat against the same manifest.
//
// HOW IT KNOWS AN UPDATE WENT BADLY
// ---------------------------------
// "Booted" is not "working". A firmware that panics in setup() reboots before it
// can report anything, and a firmware that comes up but cannot authenticate is
// worse than one that does not come up at all — it looks alive and does nothing.
//
// So the marker is cleared by evidence, not by time: a **successful, accepted
// API call**. Nothing else counts. Until that happens the update is pending, and
// a box that reboots kMaxAttempts times with it still pending declares the
// version bad, refuses to install it again, and says so on the next heartbeat it
// manages to make.
//
// WHY THE FAILING VERSION IS REMEMBERED AND NOT JUST A COUNTER
// ------------------------------------------------------------
// A counter alone would block the NEXT update too — including the fix. Recording
// which version failed means the box refuses that build and takes the one after
// it, which is exactly the sequence a real incident produces.
//
// No Arduino headers, no heap, no String. Compiles for AVR, Xtensa and the host.

#ifndef CRUSADERS_OTACORE_BOOTGUARD_H
#define CRUSADERS_OTACORE_BOOTGUARD_H

#include <stddef.h>
#include <stdint.h>

#include "hal/Store.h"

#include "otacore/Version.h"

namespace ota {

/// Boots allowed with an update still unproven before it is declared bad.
///
/// Three, not one: a box can reboot for reasons that are not the firmware's
/// fault — a brownout when four relay coils energise at once is the obvious one
/// on this hardware — and condemning a good build for somebody else's power
/// supply would be worse than the problem.
inline constexpr uint8_t kMaxAttempts = 3U;

/// Longest version string kept. "65535.65535.65535" plus a terminator.
inline constexpr size_t kMaxVersionLen = 18U;

inline constexpr char kKeyPending[] = "ota_pend";
inline constexpr char kKeyBad[] = "ota_bad";

/// What the guard thinks of the firmware currently running.
enum class BootState : uint8_t {
  /// Nothing was updated; this is just a boot.
  Settled = 0U,
  /// An update was installed and has not yet proved itself.
  Proving = 1U,
  /// An update was installed, has been rebooted through kMaxAttempts times, and
  /// has never once made a successful API call.
  Failed = 2U,
};

class BootGuard {
public:
  explicit BootGuard(hal::IStore* store) : store_(store) {}

  /// Reads the marker and counts this boot against it. Call once, at boot,
  /// before anything else touches the store.
  BootState begin();

  /// Records that an update to `version` is about to be installed. Written
  /// BEFORE the flash, because an update that is interrupted mid-write leaves a
  /// box that may not boot at all — and the marker is the only thing that will
  /// tell the next working firmware what happened.
  void arm(const char* version);

  /// The evidence that clears the marker: an API call the server accepted.
  /// Idempotent and cheap to call on every accepted response.
  void confirm();

  /// True when `version` is the build already known to be bad. The one thing
  /// that stops a fleet reflashing itself in a loop.
  bool isKnownBad(const char* version) const;

  /// The bad version, or "" if none. Reported on the heartbeat so the club finds
  /// out from the admin screen rather than from a dark court.
  const char* badVersion() const { return bad_; }

  BootState state() const { return state_; }

  uint8_t attempts() const { return attempts_; }

private:
  void writePending(const char* version, uint8_t attempts);
  void clearPending();

  hal::IStore* store_;
  BootState state_ = BootState::Settled;
  uint8_t attempts_ = 0U;
  char pending_[kMaxVersionLen] = {};
  char bad_[kMaxVersionLen] = {};
};

} // namespace ota

#endif // CRUSADERS_OTACORE_BOOTGUARD_H
