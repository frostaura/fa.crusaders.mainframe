// Crusaders Mainframe — a code opens something once.
//
// WHY A DEVICE NEEDS ITS OWN
// --------------------------
// A code is good for up to ninety seconds of a verifier's time (±1 step), and
// it is on a phone screen anybody standing behind the member can photograph.
// Online, the server's use table makes it single-use across the whole club.
// Offline, nothing does unless the device remembers, so it does: per REF, the
// highest step it has ACTED on. A presentation at that step or any earlier one
// is a replay. "Or earlier" matters — without it, the code a member showed a
// step before the one that opened the door would open it again.
//
// ONLY ACTIONS ARE RECORDED
// -------------------------
// The caller commits after it lit a court or released a lock, never after a
// refusal or an "already on" screen. A member told "too early" who scans the
// same code ten seconds later is scanning, not replaying.
//
// THE RESIDUAL, STATED
// --------------------
// The ring is bounded and evicts the entry committed longest ago. A REF evicted
// inside its own ±1 window could replay once. The capacities (16 at a court box,
// 32 at a door) make that need more distinct members acting at one device in
// ninety seconds than a squash club has doors, and the server still catches the
// duplicate when both uses are uploaded. The corpus's `replay-ring-eviction`
// scenario pins the behaviour so nobody mistakes it for a bug.
//
// No Arduino headers, no heap. Compiles for AVR, Xtensa and the host.

#ifndef CRUSADERS_MEMCODE_REPLAYRING_H
#define CRUSADERS_MEMCODE_REPLAYRING_H

#include <stdint.h>

namespace memcode {

template <uint8_t Capacity> class ReplayRing {
public:
  static_assert(Capacity >= 1U, "a ring of nothing prevents nothing");

  /// True when `ref` has been acted on at `step` or at any later step.
  bool seen(uint32_t ref, uint32_t step) const {
    for (uint8_t i = 0U; i < count_; ++i) {
      if (entries_[i].ref == ref) {
        return step <= entries_[i].step;
      }
    }
    return false;
  }

  /// Records that `ref` was acted on at `step`. An existing entry keeps the
  /// HIGHER of the two steps and becomes the newest; a new one evicts the
  /// oldest when the ring is full.
  void commit(uint32_t ref, uint32_t step) {
    uint8_t at = count_;
    for (uint8_t i = 0U; i < count_; ++i) {
      if (entries_[i].ref == ref) {
        at = i;
        break;
      }
    }
    uint32_t keep = step;
    if (at < count_) {
      if (entries_[at].step > keep) {
        keep = entries_[at].step;
      }
      removeAt(at);
    } else if (count_ == Capacity) {
      removeAt(0U);
    }
    entries_[count_].ref = ref;
    entries_[count_].step = keep;
    ++count_;
  }

  void clear() { count_ = 0U; }

  uint8_t size() const { return count_; }

  static constexpr uint8_t capacity() { return Capacity; }

private:
  struct Used {
    uint32_t ref;
    uint32_t step;
  };

  /// Oldest first: index 0 is the entry committed longest ago.
  void removeAt(uint8_t index) {
    for (uint8_t i = index; i + 1U < count_; ++i) {
      entries_[i] = entries_[i + 1U];
    }
    --count_;
  }

  Used entries_[Capacity];
  uint8_t count_ = 0U;
};

} // namespace memcode

#endif // CRUSADERS_MEMCODE_REPLAYRING_H
