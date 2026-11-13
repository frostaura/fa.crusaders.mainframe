// GateApp's 2.0.0 half (docs/specs/door-gate.md §14): what survives a reset,
// the lifeline (keys, network, signed OTA), the link supervisor, the setup
// portal, the stall watchdog and the lamp's idle states. Same class as
// GateApp.cpp, a second translation unit so neither file is unreadable.

#include <stdio.h>
#include <string.h>

#include "devapi/DeviceClient.h"
#include "devapi/Json.h"
#include "devlink/EventUpload.h"
#include "gatelogic/GateApp.h"
#include "gatelogic/GateHeartbeat.h"

namespace gatelogic {

namespace {

constexpr uint16_t kSettingsLayout = 1U;
constexpr uint16_t kRosterLayout = 1U;
constexpr uint16_t kRosterAgeLayout = 1U;
constexpr uint16_t kEventsLayout = 1U;

/// Big enough for the largest sealed record (the events).
uint8_t gScratch[sizeof(RecordHeader) + sizeof(EventsRecord)];

WarmImage gWarm;
EventsRecord gEvents;
GateQueue gQueueCopy;

static_assert(sizeof(memcode::ReplayRing<kGateReplaySlots>) <= sizeof(WarmImage::uses),
              "the replay ring must fit the warm image's slot for it");

/// Whether `b` (adopted at `bAnchor`) is `a` (adopted at `aAnchor`) re-sent: the
/// same bookings with every window moved by exactly the time between the two.
/// A roster that only aged is not a change worth a flash write (§14.1).
bool sameContent(const roster::Entry* a, uint8_t aCount, uint32_t aAnchor, const roster::Entry* b, uint8_t bCount,
                 uint32_t bAnchor) {
  if (aCount != bCount) {
    return false;
  }
  const int64_t delta = static_cast<int64_t>(tb::since(bAnchor, aAnchor));
  constexpr int64_t kSlack = 2000;
  for (uint8_t i = 0U; i < aCount; ++i) {
    if (strcmp(a[i].token, b[i].token) != 0 || a[i].court != b[i].court) {
      return false;
    }
    const int64_t closes = static_cast<int64_t>(a[i].closesAtMs) - (static_cast<int64_t>(b[i].closesAtMs) + delta);
    if (closes > kSlack || closes < -kSlack) {
      return false;
    }
    const int64_t aOpens = static_cast<int64_t>(a[i].opensAtMs);
    const int64_t bOpens = static_cast<int64_t>(b[i].opensAtMs);
    const int64_t opens = aOpens - (bOpens + delta);
    const bool opensOk = (opens <= kSlack && opens >= -kSlack) || (bOpens == 0 && aOpens <= delta + kSlack);
    if (!opensOk) {
      return false;
    }
  }
  return true;
}

uint64_t ageUs(uint32_t nowMs, uint32_t anchorMs) {
  return static_cast<uint64_t>(tb::since(nowMs, anchorMs)) * 1000ULL;
}

} // namespace

// --- the two small adapters ---------------------------------------------------

void GateApp::Between::betweenCalls() {
  // Exactly what happens around any blocking call: the watchdog, and the lock
  // re-checked with a fresh clock, because the first call may have spent its
  // whole worst case.
  app_.watchdog_.kick();
  app_.pumpLock();
}

void GateApp::DownloadHooks::duringDownload() {
  app_.watchdog_.kick();
  app_.pumpLock();
  app_.ledPin_.write(ledPinLevel(app_.led_.on(app_.clock_.nowMs()), app_.ledActiveHigh_));
}

// --- boot -------------------------------------------------------------------

bool GateApp::checkFirmwareAtBoot() {
  if (blobs_ == nullptr) {
    return false;
  }
  if (ota_.begin(blobs_, firmwareVersion_) != GateOta::Boot::RollBack) {
    led_.setProbation(ota_.inProbation());
    return false;
  }
  // Three resets on probation: back to the other slot, which still holds the
  // image that was running before (§14.2), and never this version again.
  ota_.markRolledBack("probation");
  if (otaSlot_ != nullptr) {
    static_cast<void>(otaSlot_->rollBack());
  }
  ++restartsAsked_;
  if (system_ != nullptr) {
    system_->restart();
  }
  return true;
}

void GateApp::restoreState(uint32_t nowMs) {
  state_ = GateBoardState();
  restore_ = "none";
  restoreReported_ = false;
  if (!coldBoot_ && warmBytes_ != nullptr && warmClock_ != nullptr && warmBytesCap_ >= sizeof(WarmImage)) {
    restoreWarm(nowMs);
  }
  if (strcmp(restore_, "warm") != 0) {
    restoreCold(nowMs);
  }
  applyState(nowMs);
  // Sealed again at once, so a reset in the very next second is warm too.
  warmDirty_ = true;
}

void GateApp::restoreWarm(uint32_t nowMs) {
  memcpy(&gWarm, warmBytes_, sizeof(gWarm));
  if (!warmValid(gWarm)) {
    return;
  }
  const uint64_t nowUs = warmClock_->nowUs();
  if (nowUs < gWarm.rosterAtUs || nowUs < gWarm.stepAtUs) {
    // An RTC counter that went backwards is not dating anything.
    return;
  }
  state_.settings = gWarm.settings;
  state_.roster = gWarm.roster;
  state_.codes = gWarm.codes;
  state_.step = gWarm.step;
  state_.heartbeatMs = gWarm.heartbeatMs;
  // Every age CONTINUES: re-anchored so that, read from this boot's clock, each
  // image is exactly as old as the RTC says it is.
  state_.roster.anchorMs = nowMs - static_cast<uint32_t>((nowUs - gWarm.rosterAtUs) / 1000ULL);
  state_.step.anchorMs = nowMs - static_cast<uint32_t>((nowUs - gWarm.stepAtUs) / 1000ULL);
  memcpy(static_cast<void*>(&codeUses_), gWarm.uses, sizeof(codeUses_));
  restore_ = "warm";
}

void GateApp::restoreCold(uint32_t nowMs) {
  if (blobs_ == nullptr) {
    return;
  }
  GateSettings settings;
  if (sealedGet(*blobs_, kRecSettings, kSettingsLayout, settings, gScratch, sizeof(gScratch))) {
    state_.settings = settings;
    settingsWritten_ = settings;
    settingsWrittenValid_ = true;
  }
  const uint32_t trustMinutes = state_.settings.powerRestoreTrustMinutes;
  static ColdRoster cold;
  uint32_t age = 0U;
  if (trustMinutes == 0U ||
      !sealedGet(*blobs_, kRecRoster, kRosterLayout, cold, gScratch, sizeof(gScratch)) ||
      !sealedGet(*blobs_, kRecRosterAge, kRosterAgeLayout, age, gScratch, sizeof(gScratch))) {
    return;
  }
  // NOT DATABLE (§14.1): nothing measured the outage, so every window is read
  // as of the last checkpoint before the cut, and believed for the trust window
  // only. Offline member-code verification waits for the first heartbeat: the
  // step clock cannot be re-derived, so it is not restored at all.
  for (uint8_t i = 0U; i < cold.count && i < kGateRosterEntries; ++i) {
    state_.roster.entries[i] = cold.entries[i];
  }
  state_.roster.count = cold.count;
  state_.roster.loaded = true;
  state_.roster.anchorMs = nowMs - age;
  coldTrustUntil_.arm(nowMs, trustMinutes * 60000UL);
  rosterWritten_ = cold;
  rosterWrittenAnchorMs_ = state_.roster.anchorMs;
  rosterWrittenValid_ = true;
  rosterCheckpointAt_.arm(nowMs, kRosterAgeCheckpointMs);
  restore_ = "cold";
}

void GateApp::applyState(uint32_t nowMs) {
  static_cast<void>(nowMs);
  unlockMs_ = unlockMsFromSeconds(state_.settings.unlockSeconds, kGateConfig.unlockHardCapMs);
  faults_.setReporting(state_.settings.faultReporting);
  faults_.setMaxPerHour(static_cast<uint16_t>(state_.settings.faultMaxPerHour));
  heartbeatMs_ = state_.heartbeatMs;
  if (state_.roster.loaded) {
    applyRosterImage(state_.roster, roster_);
  }
  if (state_.codes.count > 0U || state_.codes.days[0].valid || state_.codes.days[1].valid) {
    applyCodeImage(state_.codes, codeKeys_);
  }
  if (state_.step.synced) {
    static_cast<void>(stepClock_.sync(state_.step.step, state_.step.stepMs, state_.step.anchorMs));
  }
}

// --- persistence --------------------------------------------------------------

void GateApp::persistDirty(uint32_t nowMs) {
  if (warmDirty_ && warmBytes_ != nullptr && warmClock_ != nullptr && warmBytesCap_ >= sizeof(WarmImage)) {
    const uint64_t nowUs = warmClock_->nowUs();
    // Cleared in place: `gWarm = WarmImage()` builds a 3.5 KB temporary on the
    // loop task's stack, which put the worst path past its 8 KB (ESPR-4).
    memset(static_cast<void*>(&gWarm), 0, sizeof(gWarm));
    gWarm.settings = state_.settings;
    gWarm.roster = state_.roster;
    gWarm.codes = state_.codes;
    gWarm.step = state_.step;
    gWarm.heartbeatMs = state_.heartbeatMs;
    const uint64_t rosterAge = ageUs(nowMs, state_.roster.anchorMs);
    const uint64_t stepAge = ageUs(nowMs, state_.step.anchorMs);
    gWarm.rosterAtUs = nowUs >= rosterAge ? nowUs - rosterAge : 0U;
    gWarm.stepAtUs = nowUs >= stepAge ? nowUs - stepAge : 0U;
    memcpy(gWarm.uses, static_cast<const void*>(&codeUses_), sizeof(codeUses_));
    sealWarm(gWarm);
    memcpy(warmBytes_, &gWarm, sizeof(gWarm));
    warmDirty_ = false;
  }
  if (blobs_ == nullptr) {
    return;
  }
  if (!settingsWrittenValid_ || memcmp(&settingsWritten_, &state_.settings, sizeof(GateSettings)) != 0) {
    if (sealedPut(*blobs_, kRecSettings, kSettingsLayout, state_.settings, gScratch, sizeof(gScratch))) {
      settingsWritten_ = state_.settings;
      settingsWrittenValid_ = true;
    } else {
      fault(kFaultNvsWriteFailed);
    }
  }
  persistColdRoster(nowMs);
  persistEvents();
}

void GateApp::persistColdRoster(uint32_t nowMs) {
  if (!state_.roster.loaded) {
    return;
  }
  const bool changed =
      !rosterWrittenValid_ || !sameContent(rosterWritten_.entries, rosterWritten_.count, rosterWrittenAnchorMs_,
                                           state_.roster.entries, state_.roster.count, state_.roster.anchorMs);
  if (changed) {
    // Static, like every record buffer here: 1.7 KB is not the loop's to spend.
    static ColdRoster cold;
    for (uint8_t i = 0U; i < state_.roster.count; ++i) {
      cold.entries[i] = state_.roster.entries[i];
    }
    cold.count = state_.roster.count;
    const uint32_t age = tb::since(nowMs, state_.roster.anchorMs);
    if (!sealedPut(*blobs_, kRecRoster, kRosterLayout, cold, gScratch, sizeof(gScratch)) ||
        !sealedPut(*blobs_, kRecRosterAge, kRosterAgeLayout, age, gScratch, sizeof(gScratch))) {
      fault(kFaultNvsWriteFailed);
      return;
    }
    rosterWritten_ = cold;
    rosterWrittenAnchorMs_ = state_.roster.anchorMs;
    rosterWrittenValid_ = true;
    rosterCheckpointAt_.arm(nowMs, kRosterAgeCheckpointMs);
    return;
  }
  if (rosterCheckpointAt_.remaining(nowMs) == 0U) {
    // The same roster, older: only its age moves, in a four-byte record, at
    // most once every ten minutes.
    const uint32_t age = tb::since(nowMs, rosterWrittenAnchorMs_);
    if (!sealedPut(*blobs_, kRecRosterAge, kRosterAgeLayout, age, gScratch, sizeof(gScratch))) {
      fault(kFaultNvsWriteFailed);
    }
    rosterCheckpointAt_.arm(nowMs, kRosterAgeCheckpointMs);
  }
}

void GateApp::persistEvents() {
  eventq::Event head;
  const bool hasHead = queue_.peek(head);
  uint32_t signature = crc32(&carriedCount_, sizeof(carriedCount_));
  const uint32_t facts[3] = {queue_.size(), queue_.lastSeq(), hasHead ? head.seq : 0U};
  signature = crc32(facts, sizeof(facts), signature);
  if (carriedCount_ > 0U) {
    signature = crc32(&carried_[0].event.seq, sizeof(uint32_t), signature);
  }
  if (signature == eventsSignature_) {
    return;
  }
  memset(static_cast<void*>(&gEvents), 0, sizeof(gEvents));
  for (uint16_t i = 0U; i < carriedCount_ && gEvents.count < kStoredEventSlots; ++i) {
    gEvents.events[gEvents.count] = carried_[i];
    ++gEvents.count;
  }
  // The queue keeps its contents private; a copy is drained instead.
  gQueueCopy = queue_;
  eventq::Event e;
  while (gQueueCopy.peek(e) && gEvents.count < kStoredEventSlots) {
    StoredEvent& stored = gEvents.events[gEvents.count];
    stored.bootId = bootId_;
    stored.savedUptimeMs = static_cast<uint32_t>(uptime_.value());
    bool online = false;
    stored.tag = replayTagged(e.seq, online) ? (online ? 2U : 1U) : 0U;
    stored.event = e;
    ++gEvents.count;
    static_cast<void>(gQueueCopy.release());
  }
  if (sealedPut(*blobs_, kRecEvents, kEventsLayout, gEvents, gScratch, sizeof(gScratch))) {
    eventsSignature_ = signature;
  } else {
    fault(kFaultNvsWriteFailed);
  }
}

void GateApp::loadCarriedEvents() {
  carriedCount_ = 0U;
  if (blobs_ == nullptr || !sealedGet(*blobs_, kRecEvents, kEventsLayout, gEvents, gScratch, sizeof(gScratch))) {
    return;
  }
  for (uint16_t i = 0U; i < gEvents.count && i < kStoredEventSlots; ++i) {
    carried_[carriedCount_] = gEvents.events[i];
    ++carriedCount_;
  }
}

bool GateApp::pumpCarried(uint32_t nowMs) {
  static_cast<void>(nowMs);
  const StoredEvent& stored = carried_[0];
  static char body[devlink::kEventBodyCap];
  // The upload's uptime on THAT boot's clock: its last-written uptime plus this
  // boot's. Nothing measured the outage between them, so the server dates the
  // event no earlier than it really happened, never later (a "future" one is
  // clamped to the upload, DeviceEventEndpoints.TimeOf).
  const uint64_t uptime = static_cast<uint64_t>(stored.savedUptimeMs) + uptime_.value();
  const bool rendered =
      devlink::renderEventBody(body, sizeof(body), mac_, stored.bootId, uptime, stored.event) != 0U &&
      (stored.tag == 0U || tagReplay(body, sizeof(body), stored.tag == 2U));
  bool moved = false;
  if (!rendered) {
    moved = true;
  } else {
    char response[kGateEventsResponseCap] = {};
    scanDeferrals_ = 0U;
    beforeBlocking();
    const uint16_t status = api_.uploadEvent(body, response, sizeof(response));
    afterBlocking();
    uint32_t through = 0U;
    if (status == 403U) {
      commitEmptyRoster();
    } else if (isSuccess(status)) {
      moved = readEventsReply(status, response, strlen(response), through) && through >= stored.event.seq;
    } else if (status != 404U && devapi::react(status) == devapi::Reaction::Rejected) {
      moved = true;
    }
  }
  if (moved) {
    for (uint16_t i = 1U; i < carriedCount_; ++i) {
      carried_[i - 1U] = carried_[i];
    }
    --carriedCount_;
  }
  armEventRetry(moved);
  return moved;
}

bool GateApp::replayTagged(uint32_t seq, bool& online) const {
  for (uint8_t i = 0U; i < kReplayTags; ++i) {
    if (replayTags_[i].seq == seq && seq != 0U) {
      online = replayTags_[i].online;
      return true;
    }
  }
  return false;
}

bool GateApp::tagReplay(char* body, size_t cap, bool online) {
  // One event per body: it ends `...}]}`. The tag goes inside that event.
  const size_t len = strlen(body);
  const char* tail = "}]}";
  if (len < 3U || strcmp(body + len - 3U, tail) != 0) {
    return false;
  }
  const char* extra = online ? ",\"reason\":\"replayed\",\"online\":true" : ",\"reason\":\"replayed\",\"online\":false";
  const size_t add = strlen(extra);
  if (len + add + 1U > cap) {
    return false;
  }
  memcpy(body + len - 3U, extra, add);
  memcpy(body + len - 3U + add, tail, 4U);
  return true;
}

// --- the heartbeat's 2.0.0 half ---------------------------------------------------

void GateApp::applySettings(const HeartbeatRead& read) {
  unlockMs_ = unlockMsFromSeconds(state_.settings.unlockSeconds, kGateConfig.unlockHardCapMs);
  // THE SERVER AND THIS BOARD DISAGREE ABOUT THIS DOOR: the board must not
  // trust the server to have clamped, and the clamp cannot say it happened.
  if (read.unlockClamped) {
    fault(kFaultUnlockClamped);
  }
  faults_.setReporting(state_.settings.faultReporting);
  faults_.setMaxPerHour(static_cast<uint16_t>(state_.settings.faultMaxPerHour));
}

void GateApp::heartbeatAccepted(uint32_t nowMs) {
  lastHeartbeatOk_ = true;
  restoreReported_ = true;
  // Probation commits on an ACCEPTED beat, not a readable one (§11.1): an
  // image whose roster reader is broken can still be replaced by the next.
  ota_.heartbeatAccepted();
  led_.setProbation(ota_.inProbation());
  if (net_ != nullptr) {
    net_->heartbeatAccepted();
  }
  stallAt_.arm(nowMs, kStallRestartMs);
  stallDue_ = false;
}

void GateApp::adoptLifeline(const HeartbeatRead& read, uint32_t nowMs) {
  if (read.keyNext.present() && keys_ != nullptr) {
    static_cast<void>(keys_->adopt(read.keyNext.at, read.keyNext.len));
  }
  if (read.net.present() && net_ != nullptr) {
    static_cast<void>(net_->adopt(read.net.at, read.net.len, nowMs));
  }
  if (read.ota.present() && otaModulus_ != nullptr && otaSlot_ != nullptr && download_ != nullptr) {
    ota_.offer(read.ota, otaModulus_, nowMs);
  }
}

GateReport GateApp::report(GateDiag& diag) const {
  GateReport r;
  const FwState state = ota_.state();
  r.fwState = fwStateName(state);
  if (state == FwState::RolledBack || state == FwState::Failed) {
    r.fwFailed = ota_.failedVersion();
    r.fwError = ota_.error();
  }
  if (net_ != nullptr) {
    r.netVer = net_->version();
    r.netSrc = netSourceName(net_->source());
  }
  r.restore = restoreReport();
  if (diag_ != nullptr) {
    diag_->read(diag);
    r.diag = &diag;
  }
  r.drift = &drift_;
  return r;
}

// --- the slow concerns -------------------------------------------------------

bool GateApp::idle(uint32_t nowMs) const {
  return !unlock_.released() && !unlock_.relocking(nowMs) && !assembler_.partial() && !anyInput_ && !setupOpen_;
}

void GateApp::restart() {
  ++restartsAsked_;
  // Whatever changed this pass reaches flash and RTC memory first.
  warmDirty_ = true;
  persistDirty(clock_.nowMs());
  if (system_ != nullptr) {
    system_->restart();
  }
}

void GateApp::pumpSupervisor(uint32_t nowMs) {
  if (net_ == nullptr) {
    return;
  }
  if (net_->tick(nowMs, state_.settings.netFallbackMinutes)) {
    fault(kFaultNetFallback);
  }
  if (radio_ == nullptr || setupOpen_) {
    return;
  }
  // DG-3: the core's own reconnect is not trusted past 30 s, because
  // Arduino-ESP32 stops trying for good after AUTH_FAIL or ASSOC_LEAVE.
  switch (supervisor_.tick(nowMs, linkUp_)) {
  case devnet::Action::ReconnectNextProfile: {
    const devnet::Profile& next = net_->profile(net_->advanceProfile());
    radio_->join(next.ssid, next.psk);
    ++rejoins_;
    break;
  }
  case devnet::Action::Restart:
    supervisorRestartDue_ = true;
    break;
  case devnet::Action::None:
    break;
  }
  if (linkUp_) {
    supervisorRestartDue_ = false;
  }
  if (supervisorRestartDue_ && idle(nowMs)) {
    supervisorRestartDue_ = false;
    restart();
  }
}

void GateApp::pumpSetup(uint32_t nowMs) {
  if (anyInput_ && tb::since(nowMs, lastInputMs_) >= kIdleAfterInputMs) {
    anyInput_ = false;
  }
  if (setupButton_ == nullptr || portal_ == nullptr || net_ == nullptr) {
    return;
  }
  if (!setupOpen_) {
    if (!gesture_.tick(nowMs, setupButton_->pressed())) {
      return;
    }
    char name[32] = {};
    const size_t macLen = mac_ == nullptr ? 0U : strlen(mac_);
    const char* last4 = macLen >= 4U ? mac_ + macLen - 4U : "0000";
    static_cast<void>(snprintf(name, sizeof(name), "CRUSADERS-SETUP-%c%c%c%c", last4[0], last4[1], last4[2], last4[3]));
    for (size_t i = 16U; name[i] != '\0'; ++i) {
      if (name[i] >= 'a' && name[i] <= 'f') {
        name[i] = static_cast<char>(name[i] - 'a' + 'A');
      }
    }
    portal_->open(name);
    setupOpen_ = true;
    setupCloseAt_.arm(nowMs, kSetupPortalMs);
    led_.setSetup(true);
    return;
  }
  if (setupCloseAt_.remaining(nowMs) == 0U) {
    // Ten minutes, whatever happened: back to the network it had.
    portal_->close();
    setupOpen_ = false;
    setupCloseAt_.disarm();
    led_.setSetup(false);
    if (radio_ != nullptr && net_->profileCount() > 0U) {
      const devnet::Profile& p = net_->profile(net_->activeProfile());
      radio_->join(p.ssid, p.psk);
    }
    return;
  }
  PortalForm form;
  if (!portal_->service(form)) {
    return;
  }
  devnet::NetSet local;
  const devnet::Refusal why = validatePortalForm(form, local);
  if (why != devnet::Refusal::Ok) {
    portal_->refuse(devnet::refusalName(why));
    return;
  }
  const bool withKey = form.key != nullptr && form.key[0] != '\0';
  if (withKey && (keys_ == nullptr || !keys_->adoptLocal(form.keyId, form.key))) {
    portal_->refuse("key");
    return;
  }
  if (!net_->adoptLocal(local)) {
    portal_->refuse("flash");
    return;
  }
  portal_->accept();
  restart();
}

void GateApp::pumpOta() {
  const uint32_t now = clock_.nowMs();
  if (ota_.inProbation() && ota_.tick(now, state_.settings.otaProbationMinutes) && idle(now)) {
    // No accepted heartbeat inside the window: back to the previous image.
    ota_.markRolledBack("probation");
    if (otaSlot_ != nullptr) {
      static_cast<void>(otaSlot_->rollBack());
    }
    restart();
    return;
  }
  if (!ota_.pending() || blocked_ || otaSlot_ == nullptr || download_ == nullptr || otaModulus_ == nullptr ||
      !idle(now)) {
    return;
  }
  led_.setDownloading(true);
  beforeBlocking();
  const bool switched = ota_.run(*download_, *otaSlot_, otaModulus_, downloadHooks_, now);
  afterBlocking();
  led_.setDownloading(false);
  if (switched) {
    restart();
  }
}

void GateApp::pumpStall(uint32_t nowMs) {
  // HW-8: the link is up and yet nothing has been accepted for six hours — a
  // radio or lwIP state no hardware watchdog trips. Restart when idle.
  if (stallDue_ && linkUp_ && idle(nowMs)) {
    stallDue_ = false;
    stallAt_.arm(nowMs, kStallRestartMs);
    restart();
  }
}

void GateApp::updateDegraded(uint32_t nowMs) {
  // DG-6: a door running on a roster it may not be able to refresh looks
  // different from a healthy one, without ever outranking a member's cue.
  const bool empty = !state_.roster.loaded || state_.roster.count == 0U;
  const bool old = state_.roster.loaded && roster_.ageMs(nowMs) > 2U * heartbeatMs_;
  degraded_ = !lastHeartbeatOk_ || empty || old;
  led_.setDegraded(degraded_);
}

} // namespace gatelogic
