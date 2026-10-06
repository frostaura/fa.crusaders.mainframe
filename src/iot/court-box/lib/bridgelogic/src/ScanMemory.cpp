#include "bridgelogic/ScanMemory.h"

namespace bridgelogic {

void ScanMemory::setLimits(uint32_t scanMemoryMs, uint32_t choiceMs, uint32_t nowMs) {
  scanMemoryMs_ = scanMemoryMs;
  choiceMs_ = choiceMs;
  if (!at_.isArmed()) {
    return;
  }
  // A SHORTER bound applies to the scan already held: the server checks every
  // age against the settings it holds now, so a scan the box keeps past them
  // is one whose next press is refused as not_recognised.
  const uint32_t age = ageMs(nowMs);
  const uint32_t ceiling = ceilingMs();
  if (age >= ceiling) {
    at_.arm(nowMs, 0U);
    return;
  }
  if (at_.remaining(nowMs) > ceiling - age) {
    at_.arm(nowMs, ceiling - age);
  }
}

uint32_t ScanMemory::ceilingMs() const {
  return scanMemoryMs_ + choiceMs_ + kServerSlackMs - kServerMarginMs;
}

void ScanMemory::remember(uint32_t nowMs) {
  // The TENANT's scan memory (D19-3): the compile-time value is only where a
  // box starts, until its first heartbeat.
  at_.arm(nowMs, scanMemoryMs_);
  readMs_ = nowMs;
}

bool ScanMemory::holdForQuote(uint32_t nowMs) {
  return holdWholeChoice(nowMs);
}

bool ScanMemory::holdForPressAgain(uint32_t nowMs) {
  return holdWholeChoice(nowMs);
}

bool ScanMemory::holdWholeChoice(uint32_t nowMs) {
  // Remembered, not unexpired: the answer arrives after a blocking call, and a
  // scan that lapsed DURING it was alive when the member pressed. The loop has
  // not forgotten it yet, and the age bound below is the one that matters.
  if (!at_.isArmed()) {
    return false;
  }
  // Whole or not at all (D19-2): a countdown the scan cannot outlive is a
  // press the server refuses, or one the bridge has forgotten by then.
  const uint32_t age = ageMs(nowMs);
  const uint32_t ceiling = ceilingMs();
  if (age >= ceiling || ceiling - age < choiceMs_) {
    return false;
  }
  // Never SHORTER than it was (D19-1): a member with 25 s of scan memory left
  // keeps it, and a quote after a PRESS AGAIN hold keeps that hold.
  if (at_.remaining(nowMs) < choiceMs_) {
    at_.arm(nowMs, choiceMs_);
  }
  return true;
}

} // namespace bridgelogic
