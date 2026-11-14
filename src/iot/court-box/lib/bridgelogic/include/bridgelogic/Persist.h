// Crusaders Mainframe — what bridge 3.1.0 brings back after a power cut with
// no network (docs/specs/device-api.md §4; BR-06, BR-07, FSF-09, BD-4).
//
// THE LAST ACCEPTED ANSWER, WHOLE
// -------------------------------
// The snapshot, the court map, the button map, the display and hardware
// settings, the roster and the member-code sync all arrive in ONE heartbeat
// answer, so the bridge keeps that answer — the bytes, up to 4 KB — and on a
// boot with the server down it runs them through exactly the readers a live
// answer goes through. One adoption path, so a restored box can never read its
// own flash differently from the wire. Written at most once a minute, and at
// once when the snapshot's lit courts change (LittleFS spreads the wear: about
// 6 MB a day across a 2 MB partition is decades of erase cycles).
//
// WARM AND COLD
// -------------
//   * WARM (watchdog, exception, software restart, an OTA): the ESP8266's RTC
//     user memory survives, and the bridge keeps an epoch there — milliseconds
//     that carry on across the reset — so the answer is aged exactly and every
//     window, seconds-left and step continues (`restore: warm`).
//   * COLD (power-on): nothing measured the outage. The answer is adopted as
//     of boot, but the roster is trusted only for
//     `device_power_restore_trust_minutes`, member codes wait for the first
//     beat (the step clock cannot be re-derived), and every court the snapshot
//     owes is lit PROVISIONALLY for at most the trust window; the first
//     accepted snapshot confirms each one or, where it says dark, the bridge
//     switches its own provisional light off (cause `reconcile`) — the one case
//     the box switches a light off on the server's word (`restore: cold`).
//   * NONE: nothing whole in flash, or a cold boot with trust 0.
//
// EVERY UNDELIVERED EVENT
// -----------------------
// The live queue is written out (one sealed entry per event) whenever it
// changes, at the top of loop(). At boot, the previous boot's entries join the
// CARRIED list and are uploaded first, one per call, under their OWN boot id
// and seq: the server deduplicates on (device, boot_id, seq), so a re-upload
// of one whose receipt was lost in the cut is a no-op, and re-queuing it under
// the new boot would duplicate and misdate it. A member who played is never a
// no-show because the club's power and network failed together.
//
// No heap, no Arduino headers, valid C++11.

#ifndef CRUSADERS_BRIDGELOGIC_PERSIST_H
#define CRUSADERS_BRIDGELOGIC_PERSIST_H

#include <stddef.h>
#include <stdint.h>

#include "bridgelogic/Records.h"
#include "bridgelogic/V3Heartbeat.h"
#include "eventq/Event.h"

namespace bridgelogic {

enum class RestoreKind : uint8_t { None = 0U, Warm = 1U, Cold = 2U };

/// `warm` / `cold` / `none`, the heartbeat's `restore`.
const char* restoreName(RestoreKind kind);

// --- the last accepted answer --------------------------------------------------

struct BodyMeta {
  /// The warm epoch (ms) at the instant the answer was received.
  uint64_t epochMs = 0U;
  uint32_t length = 0U;
  uint32_t reserved = 0U;
};

class BodyStore {
public:
  static constexpr uint32_t kRewriteMs = 60000UL;

  void begin(IFiles* files) { files_ = files; }

  /// An accepted, complete answer is in `body`. Marks it for the next loop
  /// top: at once when the snapshot's lit courts changed, else once a minute.
  void accepted(const Snapshot& snapshot, uint64_t epochMs, uint32_t nowMs);

  /// Top of loop(): writes `body` when due. `body` must still be the answer
  /// `accepted` was told about (the caller holds it until then).
  bool flush(const char* body, size_t len, uint32_t nowMs);

  bool due() const { return dirty_; }

  /// The stored answer into `out` (NUL-terminated); its length, 0 if none whole.
  size_t load(char* out, size_t cap, BodyMeta& meta);

private:
  IFiles* files_ = nullptr;
  bool dirty_ = false;
  bool written_ = false;
  uint32_t writtenAtMs_ = 0U;
  uint64_t epochMs_ = 0U;
  /// The lit relays and their refs at the last write, for "changed".
  uint8_t litMask_ = 0U;
  char refs_[kSnapshotRelays][9] = {};
};

/// How a boot restores: warm when the epoch survived, cold on a power-on when
/// the trust window is open, else none.
RestoreKind classifyRestore(bool epochCarried, bool haveBody, uint32_t trustMinutes);

/// A cold restore's snapshot: every lit court capped at the trust window, and
/// the relays it lit marked provisional (bit per relay).
uint8_t capColdSnapshot(Snapshot& snap, uint32_t trustMinutes);

/// The first accepted snapshot after a cold restore: the provisional relays it
/// says are dark — the bridge switches those off itself, cause `reconcile`.
uint8_t provisionalToRelease(uint8_t provisional, const Snapshot& accepted);

// --- the undelivered events ----------------------------------------------------

/// One event on flash, sealed by itself so a torn tail costs one entry.
struct StoredEvent {
  uint32_t magic = 0U;
  uint32_t bootId = 0U;
  /// The queuing boot's uptime when this entry was written.
  uint64_t savedUptimeMs = 0U;
  eventq::Event event;
  uint32_t crc = 0U;
};

inline constexpr uint16_t kCarriedSlots = 64U;

/// The previous boots' undelivered events, uploaded before this boot's.
class CarriedEvents {
public:
  /// At boot: the previous boot's live file joins the carried list (oldest
  /// discardable dropped first past kCarriedSlots) and is removed.
  void begin(IFiles* files);

  // The drain's queue interface (bridgelogic::pumpEventDrain).
  bool empty() const { return head_ >= count_; }

  uint16_t size() const { return empty() ? 0U : static_cast<uint16_t>(count_ - head_); }

  bool peek(eventq::Event& out) const;
  bool release();
  uint16_t releaseThrough(uint32_t throughSeq);

  /// The head's boot id and batch uptime, for its upload.
  uint32_t headBootId() const { return headValid_ ? head_entry_.bootId : 0U; }

  uint64_t headUptimeMs() const { return headValid_ ? head_entry_.savedUptimeMs : 0U; }

private:
  bool loadHead();
  void mergeLive(uint16_t carried, uint16_t live);

  IFiles* files_ = nullptr;
  uint16_t count_ = 0U;
  uint16_t head_ = 0U;
  bool headValid_ = false;
  StoredEvent head_entry_;
};

/// Writes this boot's live queue (`Queue` is an eventq::EventQueue) out as
/// sealed entries; removes the file when the queue is empty.
template <class Queue>
bool writeLiveEvents(IFiles& files, const Queue& queue, uint32_t bootId, uint64_t uptimeMs);

namespace detail {
uint32_t sealEvent(StoredEvent& entry);
bool eventSealed(const StoredEvent& entry);
} // namespace detail

template <class Queue>
bool writeLiveEvents(IFiles& files, const Queue& queue, uint32_t bootId, uint64_t uptimeMs) {
  if (queue.size() == 0U) {
    files.remove(kFileEvents);
    return true;
  }
  if (!files.begin(kFileEvents)) {
    return false;
  }
  static StoredEvent entry; // one loop, never re-entered; never a frame (ESPR-1)
  for (uint16_t i = 0U; i < queue.size(); ++i) {
    entry = StoredEvent();
    if (!queue.at(i, entry.event)) {
      break;
    }
    entry.bootId = bootId;
    entry.savedUptimeMs = uptimeMs;
    entry.crc = detail::sealEvent(entry);
    if (!files.append(&entry, sizeof(entry))) {
      static_cast<void>(files.end(false));
      return false;
    }
  }
  return files.end(true);
}

} // namespace bridgelogic

#endif // CRUSADERS_BRIDGELOGIC_PERSIST_H
