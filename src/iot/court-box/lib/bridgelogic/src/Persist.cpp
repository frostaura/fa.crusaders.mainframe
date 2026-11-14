// See include/bridgelogic/Persist.h and docs/specs/device-api.md §4.

#include "bridgelogic/Persist.h"

#include <stddef.h>
#include <string.h>

#include "timebase/TimeBase.h"

namespace bridgelogic {

namespace {

constexpr uint16_t kBodyLayout = 1U;
constexpr uint32_t kEventMagic = 0x43524545UL; // "CREE"

uint8_t litMaskOf(const Snapshot& s, char refs[kSnapshotRelays][9]) {
  uint8_t mask = 0U;
  for (uint8_t r = 0U; r < kSnapshotRelays; ++r) {
    refs[r][0] = '\0';
  }
  for (uint8_t i = 0U; i < s.count; ++i) {
    const SnapshotCourt& c = s.courts[i];
    if (c.lit && c.relay < kSnapshotRelays) {
      mask = static_cast<uint8_t>(mask | (1U << c.relay));
      memcpy(refs[c.relay], c.ref, sizeof(c.ref));
    }
  }
  return mask;
}

} // namespace

const char* restoreName(RestoreKind kind) {
  switch (kind) {
  case RestoreKind::Warm:
    return "warm";
  case RestoreKind::Cold:
    return "cold";
  case RestoreKind::None:
    break;
  }
  return "none";
}

// --- BodyStore ---------------------------------------------------------------------

void BodyStore::accepted(const Snapshot& snapshot, uint64_t epochMs, uint32_t nowMs) {
  char refs[kSnapshotRelays][9];
  const uint8_t mask = snapshot.valid ? litMaskOf(snapshot, refs) : litMask_;
  bool changed = !written_;
  if (snapshot.valid) {
    changed = changed || mask != litMask_;
    for (uint8_t r = 0U; r < kSnapshotRelays && !changed; ++r) {
      changed = strcmp(refs[r], refs_[r]) != 0;
    }
  }
  if (changed || tb::since(nowMs, writtenAtMs_) >= kRewriteMs) {
    dirty_ = true;
    epochMs_ = epochMs;
    if (snapshot.valid) {
      litMask_ = mask;
      memcpy(refs_, refs, sizeof(refs_));
    }
  }
}

bool BodyStore::flush(const char* body, size_t len, uint32_t nowMs) {
  if (!dirty_ || files_ == nullptr || body == nullptr || len == 0U) {
    return false;
  }
  dirty_ = false;
  BodyMeta meta;
  meta.epochMs = epochMs_;
  meta.length = static_cast<uint32_t>(len);
  const Part parts[2] = {{&meta, sizeof(meta)}, {const_cast<char*>(body), len}};
  if (!sealedWrite(*files_, kFileBody, kBodyLayout, parts, 2U)) {
    return false;
  }
  written_ = true;
  writtenAtMs_ = nowMs;
  return true;
}

size_t BodyStore::load(char* out, size_t cap, BodyMeta& meta) {
  if (files_ == nullptr || out == nullptr || cap < 2U) {
    return 0U;
  }
  const Part parts[2] = {{&meta, sizeof(meta)}, {out, cap - 1U}};
  size_t got = 0U;
  if (!sealedRead(*files_, kFileBody, kBodyLayout, parts, 2U, got) || got != meta.length || got == 0U) {
    out[0] = '\0';
    meta = BodyMeta();
    return 0U;
  }
  out[got] = '\0';
  return got;
}

RestoreKind classifyRestore(bool epochCarried, bool haveBody, uint32_t trustMinutes) {
  if (!haveBody) {
    return RestoreKind::None;
  }
  if (epochCarried) {
    return RestoreKind::Warm;
  }
  return trustMinutes == 0U ? RestoreKind::None : RestoreKind::Cold;
}

uint8_t capColdSnapshot(Snapshot& snap, uint32_t trustMinutes) {
  uint8_t provisional = 0U;
  const uint32_t cap = trustMinutes * 60UL;
  for (uint8_t i = 0U; i < snap.count; ++i) {
    SnapshotCourt& c = snap.courts[i];
    if (!c.lit || c.relay >= kSnapshotRelays) {
      continue;
    }
    if (c.seconds > cap) {
      c.seconds = cap;
    }
    if (c.seconds > 0U) {
      provisional = static_cast<uint8_t>(provisional | (1U << c.relay));
    }
  }
  return provisional;
}

uint8_t provisionalToRelease(uint8_t provisional, const Snapshot& accepted) {
  if (!accepted.valid) {
    return 0U;
  }
  uint8_t release = 0U;
  for (uint8_t i = 0U; i < accepted.count; ++i) {
    const SnapshotCourt& c = accepted.courts[i];
    if (c.relay < kSnapshotRelays && (provisional & (1U << c.relay)) != 0U && !c.lit) {
      release = static_cast<uint8_t>(release | (1U << c.relay));
    }
  }
  return release;
}

// --- the events ------------------------------------------------------------------------

namespace detail {

uint32_t sealEvent(StoredEvent& entry) {
  entry.magic = kEventMagic;
  return crc32(&entry, offsetof(StoredEvent, crc));
}

StoredEvent& eventScratch() {
  static StoredEvent scratch;
  return scratch;
}

bool eventSealed(const StoredEvent& entry) {
  return entry.magic == kEventMagic && entry.crc == crc32(&entry, offsetof(StoredEvent, crc));
}

} // namespace detail

namespace {

/// Whole, sealed entries `file` holds.
uint16_t entriesIn(IFiles& files, const char* path) {
  const uint32_t n = files.size(path) / sizeof(StoredEvent);
  return n > 0xFFFFU ? 0xFFFFU : static_cast<uint16_t>(n);
}

bool entryAt(IFiles& files, const char* path, uint16_t index, StoredEvent& out) {
  return files.read(path, static_cast<uint32_t>(index) * sizeof(StoredEvent), &out, sizeof(out)) ==
             sizeof(out) &&
         detail::eventSealed(out);
}

/// Entry `i` of the merge: the carried file's first, then the live file's.
bool mergedEntryAt(IFiles& files, uint16_t carried, uint32_t i, StoredEvent& out) {
  const bool fromCarried = i < carried;
  return entryAt(files, fromCarried ? kFileCarried : kFileEvents,
                 static_cast<uint16_t>(fromCarried ? i : i - carried), out);
}

/// Discardables among the first entries of the merge, counted no further than
/// `excess` needs.
uint32_t countDiscardables(IFiles& files, uint16_t carried, uint32_t total, uint32_t excess,
                           StoredEvent& entry) {
  uint32_t discardables = 0U;
  for (uint32_t i = 0U; i < total && excess > 0U; ++i) {
    if (mergedEntryAt(files, carried, i, entry) && eventq::isDiscardable(entry.event.kind)) {
      ++discardables;
    }
  }
  return discardables;
}

/// False when `entry` is shed: a discardable while discardables are owed,
/// else one of the oldest of the rest while those are.
bool keepEntry(const StoredEvent& entry, uint32_t& shedDiscardable, uint32_t& shedOldest) {
  uint32_t& owed = eventq::isDiscardable(entry.event.kind) ? shedDiscardable : shedOldest;
  if (owed > 0U) {
    --owed;
    return false;
  }
  return true;
}

} // namespace

void CarriedEvents::mergeLive(uint16_t carried, uint16_t live) {
  // The older carried entries, then the previous boot's, at most
  // kCarriedSlots — shedding discardables (a fault, an unknown scan) before
  // any activation or release, and then the oldest.
  StoredEvent& entry = detail::eventScratch();
  const uint32_t total = static_cast<uint32_t>(carried) + live;
  const uint32_t excess = total > kCarriedSlots ? total - kCarriedSlots : 0U;
  const uint32_t discardables = countDiscardables(*files_, carried, total, excess, entry);
  // Shed this many discardables, then this many of the oldest of the rest.
  uint32_t shedDiscardable = discardables < excess ? discardables : excess;
  uint32_t shedOldest = excess - shedDiscardable;
  if (!files_->begin(kFileCarried)) {
    return;
  }
  bool ok = true;
  for (uint32_t i = 0U; i < total && ok; ++i) {
    // A torn or damaged entry is that one entry lost, never the rest.
    if (mergedEntryAt(*files_, carried, i, entry) && keepEntry(entry, shedDiscardable, shedOldest)) {
      ok = files_->append(&entry, sizeof(entry));
    }
  }
  if (ok && files_->end(true)) {
    files_->remove(kFileEvents);
  } else {
    static_cast<void>(files_->end(false));
  }
}

void CarriedEvents::begin(IFiles* files) {
  files_ = files;
  count_ = 0U;
  head_ = 0U;
  headValid_ = false;
  if (files_ == nullptr) {
    return;
  }
  const uint16_t carried = entriesIn(*files_, kFileCarried);
  const uint16_t live = entriesIn(*files_, kFileEvents);
  if (live > 0U) {
    mergeLive(carried, live);
  }
  count_ = entriesIn(*files_, kFileCarried);
  if (count_ == 0U) {
    files_->remove(kFileCarried);
  }
  static_cast<void>(loadHead());
}

bool CarriedEvents::loadHead() {
  headValid_ = false;
  while (files_ != nullptr && head_ < count_) {
    if (entryAt(*files_, kFileCarried, head_, head_entry_)) {
      headValid_ = true;
      return true;
    }
    ++head_; // a damaged entry is skipped, never uploaded
  }
  if (files_ != nullptr && count_ > 0U) {
    // All delivered: the file goes. A power cut before this re-uploads some —
    // which the server's (device, boot_id, seq) key makes a no-op.
    files_->remove(kFileCarried);
    count_ = 0U;
    head_ = 0U;
  }
  return false;
}

bool CarriedEvents::peek(eventq::Event& out) const {
  if (!headValid_) {
    return false;
  }
  out = head_entry_.event;
  return true;
}

bool CarriedEvents::release() {
  if (empty()) {
    return false;
  }
  ++head_;
  static_cast<void>(loadHead());
  return true;
}

uint16_t CarriedEvents::releaseThrough(uint32_t throughSeq) {
  // One per call, under its own boot id: only the head was uploaded.
  if (!headValid_ || head_entry_.event.seq > throughSeq) {
    return 0U;
  }
  return release() ? 1U : 0U;
}

} // namespace bridgelogic
