// Crusaders Mainframe — the bounded, checksummed ring of events awaiting upload.
//
// WHAT IT GUARANTEES
// ------------------
//   * An event that was accepted is delivered at least once, unless the queue
//     overflowed — and an overflow is COUNTED, by `overflowed()`.
//
//     WHETHER IT IS REPORTED IS THE FIRMWARE'S, NOT THIS CLASS'S, AND THE TWO
//     DEVICES DIFFER. This header said "an overflow is reported, never silent"
//     from the day it was written, and for as long as that sentence stood
//     `overflowed()` was read by NOTHING anywhere in the repository. The DOOR
//     GATE reads it now and sends the since-boot total as `events_lost` in its
//     heartbeat request. The COURT BOX does not: its heartbeat's wire shape has
//     no such field, nothing consumes the counter, and an overflow there is
//     visible only to a debugger — so on that device this remains a silent
//     loss, stated rather than implied. Adding the field to the court box is a
//     wire change and is not one this class may make on its own.
//
//     WHERE `events_lost` ACTUALLY GOES, SAID PROPERLY. This header used to say
//     "where an admin can see it on the device row", and that was not true: the
//     server LOGS the counter against the device code and stores nothing — the
//     gate corpus's own vector says so in as many words, because a column would
//     be an EF migration for a diagnostic. So it reaches a server LOG and the
//     native simulator's transcript, and no console anywhere shows it. Surfacing
//     it is worth doing and belongs to whoever owns the admin console; from here
//     it is owed, not done.
//   * At-least-once, NOT at-most-once. The API deduplicates on
//     (device, boot_id, seq). A queue that dropped an event to avoid a duplicate
//     would be trading a charge the club can reverse for a game it never learns
//     about.
//   * A sequence number is never reused WITHIN A BOOT, and a REBOOT is made
//     distinguishable rather than made impossible — see the boot identity note
//     below. The checkpointed high-water mark is a best-effort optimisation
//     now, not the thing deduplication rests on.
//
// WHAT IT DOES NOT GUARANTEE, SAID PLAINLY
// ----------------------------------------
// **The queued events are in RAM and do not survive a power cut.** The ring
// survives what it was built to survive — the WiFi going away, the API being
// down, a router reboot, a two-day outage — because the box stays powered
// throughout. It does not survive the breaker going off.
//
// That boundary USED to be a consequence of the store port, and this comment
// used to say so: hal::IStore capped a value at 32 bytes, an Event is 48, so
// there was no way to write one through it. **That is no longer true.** The cap
// is kStoreMaxValueLen = 128 and an Event fits with room to spare, so nothing
// about the port stops it any more (review 3's dropped lead: a residual false
// statement in a firmware comment, and this is the one that mattered — it gave
// an accepted limitation a technical reason it no longer has).
//
// What is true now is smaller and less comfortable: persisting the ring has not
// been built. It would need a record per slot plus a durable head and tail, and
// the wrong version of that is worse than none — a torn ring that replays a
// stale activation is a court charged twice. The trade is recorded and accepted
// on the go-live checklist rather than dressed up as an impossibility.
//
// What it costs when it happens: a court that was lit during an offline window
// that ended in a power cut is never reported, so the API still sees the
// booking as un-attended and the no-show sweep settles it as one.
//
// WHO PAYS FOR THAT CHANGED, AND THIS PARAGRAPH USED TO BE STALE. It used to
// cost the member — refunded less a 30% penalty for a game they played. Wrong,
// but wrong on their own ledger, and a member charged for a game they played
// complains. Since feature-spec.md §6a / settlement-model.md S5a, a booking
// whose box was unreachable at its grace deadline is refunded IN FULL with no
// penalty, so the same lost activation now makes the court free and the loss is
// the club's, silently: the ledger row looks correct and nobody raises it. That
// is the one I2 exception in the system and settlement-model.md I2 names it.
//
// It is still a recorded limitation rather than a blocker, and it is on the
// go-live checklist — but it is no longer self-correcting through a member
// complaint, so do not reason about it as if an admin will hear about it.
//
// A consequence for anyone touching this file: the API-side alert deliberately
// does NOT open by telling an admin to check the box's power. Power-cycling a
// box that is lighting courts from its cached roster is exactly what discards
// this ring.
//
// An earlier draft of this file carried a per-slot checksum and a header
// claiming torn writes read back as absent. Nothing wrote to flash, so the
// checksum guarded nothing and the claim was false. It was removed rather than
// justified after the fact, when a mutation test showed no test could tell
// whether it was there.
//
// WHAT GOES WHEN THE RING IS FULL
// -------------------------------
// Something has to. Refusing the new event is the wrong answer, and the tie is
// broken by what each choice costs: an old event is the one most likely to have
// already been uploaded on a link that came back mid-drain, while the newest is
// the game happening right now with a member standing on the court.
//
// BUT "OLDEST" ALONE WAS THE WRONG RULE, AND THAT WAS ROUND G4's H1. A ring
// fills only while the board is OFFLINE — online it drains a pass at a time —
// and offline is exactly when every refusal costs a slot. A code taped near a
// door, a member re-presenting a dead one, or line noise: each an
// `unknown_scan`, each evicting the oldest event, which on a busy evening is a
// `gate_open`. The one record nobody else has — somebody came in — was thrown
// away to keep a record of somebody who did not.
//
// So the oldest DISCARDABLE event goes first (`eventq::isDiscardable`, which is
// where the per-kind reasoning lives), and an admission is evicted only when
// the ring holds nothing else. Order among the survivors is preserved: a drain
// that handed the server an evening out of order would be one nobody could
// reconcile.
//
// `overflowed()` counts EVERY discarded event, whichever kind it was — a club
// that sees that counter move knows it lost history and can go and ask why the
// box was offline for two days, and a counter that quietly excused the losses
// it had decided were cheap would be worth nothing.
//
// WHY THE SEQUENCE NUMBER PERSISTS AND THE QUEUE'S CONTENTS NEED NOT
// ------------------------------------------------------------------
// `seq` is part of the idempotency key, and the API enforces it with a
// PERMANENT unique index: a number seen before is silently receipted as a
// duplicate, forever, not merely for a while. So a box that restarted its
// numbering at 1 would have every event up to its old high-water discarded as a
// duplicate — and under charge-at-booking that is the no-show sweep
// refunding-and-penalising members who actually played.
//
// It is therefore checkpointed to the store in blocks — see
// kSeqCheckpointStride — rather than on every push, which would wear the flash
// out. A reboot resumes from the checkpoint, which is at or AHEAD of the true
// last value: skipping sequence numbers is free, reusing one is a lost event.
//
// AND THE CHECKPOINT WAS THE WHOLE DEFENCE, WHICH IS ROUND G4's C2
// -----------------------------------------------------------------
// This file was resting a permanent server-side index on ONE record in flash,
// and calling it a guarantee. It is not one: a reflash, a wiped NVS partition,
// a torn write, or a board whose store simply does not come up, and `begin()`
// reads an absent mark, starts at 1 — correctly, because refusing to start
// would brick a door over a bookkeeping detail — and the server then discards
// the WHOLE of the next evening as duplicates. Including the `boot` event this
// queue exists to make an unexplained gap explainable with. The board sees a
// clean 200 covering everything it sent and releases its ring, so the evidence
// is gone from both ends and nothing anywhere says so.
//
// The key is (device, boot_id, seq) now. `boot_id` is a per-boot random 32-bit
// value the COMPOSITION ROOT supplies — `esp_random()` on the board, the clock
// and the pid in the simulator — and it rides at the top of the upload body
// beside the MAC. A renumbered board collides with nothing; a genuine retry
// still carries the same three fields and is still deduplicated; and two boards
// that end up sharing a MAC stop deduping each other's evidence away.
//
// It also changes what this checkpoint IS. It is no longer the thing
// correctness rests on — it is an optimisation that keeps the numbers in a long
// run monotonic, and losing it now costs a gap rather than an evening. That is
// a smaller promise honestly kept, rather than a large one that was not.
//
// ZERO MEANS "NO BOOT IDENTITY", and the server reads an absent field the same
// way, which is exactly what (device, seq) always meant. The COURT BOX passes
// zero and its wire body is byte-for-byte what it has always been — so this
// defect is still open on that device, and closing it there is a wire change to
// the http/ corpus family rather than something this file can do.
//
// THIS IS THE ONLY THING THE BRIDGE PERSISTS. The device credential, the WiFi
// details and the API base URL are compiled into the image as of firmware
// 2.0.0; this one record is what keeps hal::IStore and the ESP's LittleFS
// partition alive, and it earns it.
//
// WHY THERE IS NO ALLOCATOR AND NO std::deque
// -------------------------------------------
// This links into an ESP8266 with ~40 KB of usable heap shared with the TLS
// stack, and the same code compiles for the ATmega's 8 KB of SRAM. The ring is
// a member array whose size is a template parameter, so its cost is visible at
// the composition root and the linker can prove it fits.
//
// No Arduino headers, no heap, no String. Compiles for AVR, Xtensa and the host.

#ifndef CRUSADERS_EVENTQ_EVENTQUEUE_H
#define CRUSADERS_EVENTQ_EVENTQUEUE_H

#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "hal/Store.h"

#include "eventq/Event.h"

namespace eventq {

/// How many sequence numbers a single checkpoint reserves.
///
/// The store is flash or EEPROM with finite endurance, and a checkpoint per
/// event would write it once per scan. Reserving a block means one write per
/// 64 events, at the cost of skipping up to 63 numbers on an unclean reboot —
/// which costs nothing, because the API only cares that a number is never
/// REUSED.
///
/// A CONSEQUENCE THAT KEEPS BEING GOT WRONG ON THE API SIDE. Because of this,
/// a gap in the sequence numbers the API has receipts for is NOT evidence that
/// events were lost. A clean run of three events followed by a power cut leaves
/// the next event at seq 65 with nothing dropped, and no query over
/// DeviceEventReceipt can tell that apart from a queue that discarded 61. Three
/// documents claimed the opposite and have been corrected (settlement-model.md
/// I2, go-live-checklist.md section 8, system-blueprint.html risk 9). Detecting
/// a lost queue needs something this file does not emit — a boot record naming
/// what was discarded, or a durable ring.
inline constexpr uint32_t kSeqCheckpointStride = 64U;

/// The store key holding the high-water sequence mark.
inline constexpr char kSeqKey[] = "evq_seq";

/// Why a push did not take.
enum class PushResult : uint8_t {
  /// Queued. The only result that means the event will be uploaded.
  Ok = 0U,
  /// Queued, but the oldest un-uploaded event was discarded to make room.
  /// Still a success for the caller — the new event IS in the queue — and a
  /// loud one for the operator.
  OkOverwrote = 1U,
  /// The subject was too long to store and was refused rather than truncated.
  Rejected = 2U,
};

/// A fixed-capacity ring of events, with per-slot integrity.
///
/// `Slots` is a template parameter rather than a constructor argument so the
/// storage is inline and its size is a compile-time fact. EVENTQ_SLOTS is the
/// build flag that sets it at the composition root.
template <uint16_t Slots> class EventQueue {
public:
  static_assert(Slots >= 2U, "a ring of one cannot distinguish full from empty");

  explicit EventQueue(hal::IStore* store = nullptr) : store_(store) {}

  /// Reads the persisted sequence high-water mark and resumes past it.
  ///
  /// Called once at boot, before any push. An absent or corrupt mark starts at
  /// zero, which is correct for a box that has never run: the alternative —
  /// refusing to start — would brick a court over a bookkeeping detail.
  void begin();

  /// Stamps `event` with the next sequence number and queues it.
  ///
  /// The caller fills everything except `seq`; anything it put there is
  /// overwritten, because a sequence number chosen by a caller is a sequence
  /// number that can repeat.
  PushResult push(Event& event);

  /// The oldest queued event, without removing it. False when empty.
  ///
  /// Peek-then-release rather than pop, because an event must not leave the
  /// queue until the API has acknowledged it. Popping first and uploading
  /// after is how a queue loses exactly the events a flaky link produces.
  bool peek(Event& out) const;

  /// The event `offset` places behind the oldest, for writing the queue out
  /// to flash (bridge 3.1.0 persists every undelivered event, BR-07). False
  /// past the end.
  bool at(uint16_t offset, Event& out) const {
    if (offset >= count_) {
      return false;
    }
    out = ring_[static_cast<uint16_t>((head_ + offset) % Slots)];
    return true;
  }

  /// Discards the oldest event, which the API has now acknowledged.
  /// False when there was nothing to release.
  bool release();

  /// Discards up to `throughSeq` inclusive, for an upload that batched several.
  /// Returns how many were discarded. Stops at the first event NEWER than
  /// `throughSeq`, so an out-of-order acknowledgement cannot clear the ring.
  uint16_t releaseThrough(uint32_t throughSeq);

  uint16_t size() const { return count_; }

  bool empty() const { return count_ == 0U; }

  bool full() const { return count_ == Slots; }

  static constexpr uint16_t capacity() { return Slots; }

  /// Events discarded because the ring was full. A rising count is the club
  /// losing history — it means the box has been unable to reach the API for
  /// long enough to fill the queue.
  ///
  /// Read by the DOOR GATE, which sends it as `events_lost`; not read by the
  /// court box, whose heartbeat has no field for it. See the header.
  uint32_t overflowed() const { return overflowed_; }

  /// The last sequence number issued. Zero before the first push.
  uint32_t lastSeq() const { return nextSeq_ - 1U; }

private:
  /// No slot in the ring holds a discardable event.
  static constexpr uint16_t kNoVictim = 0xFFFFU;

  void reserveSequenceBlock(uint32_t upTo);

  /// The offset from `head_` of the oldest event the ring may evict, or
  /// kNoVictim. See `eventq::isDiscardable`.
  uint16_t oldestDiscardable() const;

  /// Removes the event at `offset` from the head, counts the loss, and closes
  /// the gap without reordering what is left.
  void evictAt(uint16_t offset);

  hal::IStore* store_;
  Event ring_[Slots];
  uint16_t head_ = 0U; ///< oldest
  uint16_t count_ = 0U;
  uint32_t nextSeq_ = 1U;
  uint32_t reservedThrough_ = 0U;
  uint32_t overflowed_ = 0U;
};

// --- implementation ---------------------------------------------------------
//
// In the header because it is a template. Kept short deliberately: everything
// that does not depend on Slots lives in EventQueue.cpp as a free function.

namespace detail {

/// Reads the persisted high-water mark. Returns 0 when absent or damaged.
uint32_t loadSeqMark(hal::IStore* store);

/// Persists a high-water mark. Best-effort: a failed write costs a duplicate
/// sequence range after an unclean reboot, which the API deduplicates, whereas
/// refusing to continue would stop the court working.
void storeSeqMark(hal::IStore* store, uint32_t value);

} // namespace detail

template <uint16_t Slots> void EventQueue<Slots>::begin() {
  head_ = 0U;
  count_ = 0U;
  overflowed_ = 0U;

  // Resume PAST the reserved block, not at it. The previous boot may have
  // issued any number inside that block, and there is no way to know which.
  const uint32_t mark = detail::loadSeqMark(store_);
  nextSeq_ = mark + 1U;
  reservedThrough_ = mark;
}

template <uint16_t Slots> void EventQueue<Slots>::reserveSequenceBlock(uint32_t upTo) {
  if (upTo <= reservedThrough_) {
    return;
  }
  // Round up to the next stride boundary so the number of writes is bounded by
  // events/stride however the queue is driven.
  const uint32_t blocks = (upTo + kSeqCheckpointStride - 1U) / kSeqCheckpointStride;
  reservedThrough_ = blocks * kSeqCheckpointStride;
  detail::storeSeqMark(store_, reservedThrough_);
}

template <uint16_t Slots> uint16_t EventQueue<Slots>::oldestDiscardable() const {
  for (uint16_t offset = 0U; offset < count_; ++offset) {
    if (isDiscardable(ring_[static_cast<uint16_t>((head_ + offset) % Slots)].kind)) {
      return offset;
    }
  }
  return kNoVictim;
}

template <uint16_t Slots> void EventQueue<Slots>::evictAt(uint16_t offset) {
  ++overflowed_;
  if (offset == 0U) {
    // The head, which is the old behaviour and the common one — a ring of
    // nothing but refusals evicts its oldest every time. No copying.
    head_ = static_cast<uint16_t>((head_ + 1U) % Slots);
    --count_;
    return;
  }
  // A slot in the middle. Everything after it moves down one, so the SURVIVORS
  // stay in the order they happened in — a drain that handed the server an
  // evening out of order would be a drain nobody could reconcile. At most
  // Slots-1 copies of a 48-byte record, on a path that only runs while a board
  // is offline with a full ring.
  for (uint16_t i = offset; i + 1U < count_; ++i) {
    ring_[static_cast<uint16_t>((head_ + i) % Slots)] =
        ring_[static_cast<uint16_t>((head_ + i + 1U) % Slots)];
  }
  --count_;
}

template <uint16_t Slots> PushResult EventQueue<Slots>::push(Event& event) {
  if (event.subjectLen > kMaxSubjectLen) {
    return PushResult::Rejected;
  }

  event.seq = nextSeq_;
  ++nextSeq_;
  reserveSequenceBlock(event.seq);

  bool overwrote = false;
  if (count_ == Slots) {
    // FULL. WHAT GOES IS DECIDED BY WHAT IT IS, then by age — see
    // `eventq::isDiscardable` for why, and round G4's H1 for what deciding by
    // age alone cost. The oldest refusal goes first; an admission is evicted
    // only when the ring holds nothing else.
    const uint16_t victim = oldestDiscardable();
    evictAt(victim == kNoVictim ? 0U : victim);
    overwrote = true;
  }

  ring_[static_cast<uint16_t>((head_ + count_) % Slots)] = event;
  ++count_;

  return overwrote ? PushResult::OkOverwrote : PushResult::Ok;
}

template <uint16_t Slots> bool EventQueue<Slots>::peek(Event& out) const {
  if (count_ == 0U) {
    return false;
  }
  out = ring_[head_];
  return true;
}

template <uint16_t Slots> bool EventQueue<Slots>::release() {
  if (count_ == 0U) {
    return false;
  }
  head_ = static_cast<uint16_t>((head_ + 1U) % Slots);
  --count_;
  return true;
}

template <uint16_t Slots> uint16_t EventQueue<Slots>::releaseThrough(uint32_t throughSeq) {
  uint16_t released = 0U;
  while (count_ > 0U && ring_[head_].seq <= throughSeq) {
    static_cast<void>(release());
    ++released;
  }
  return released;
}

} // namespace eventq

#endif // CRUSADERS_EVENTQ_EVENTQUEUE_H
