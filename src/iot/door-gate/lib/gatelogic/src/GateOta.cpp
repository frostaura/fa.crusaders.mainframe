#include "gatelogic/GateOta.h"

#include <string.h>

#include "devcrypto/Sha256.h"
#include "timebase/TimeBase.h"

namespace gatelogic {

namespace {

constexpr uint16_t kOtaLayout = 1U;

uint8_t gScratch[sizeof(RecordHeader) + sizeof(OtaRecord)];

void copyText(char* out, size_t cap, const char* in) {
  const size_t n = in == nullptr ? 0U : strlen(in);
  if (n + 1U > cap) {
    out[0] = '\0';
    return;
  }
  memcpy(out, in == nullptr ? "" : in, n + 1U);
}

/// Hashes and writes every chunk as it arrives, and counts it.
class StagingSink final : public IChunkSink {
public:
  StagingSink(IOtaSlot& slot, GateOta::Hooks& hooks, uint32_t limit) : slot_(slot), hooks_(hooks), limit_(limit) {}

  bool chunk(const uint8_t* data, size_t len) override {
    hooks_.duringDownload();
    if (len == 0U) {
      // A wait for the next bytes: the watchdog and the lock, nothing else.
      return true;
    }
    if (static_cast<uint64_t>(bytes_) + len > limit_) {
      overrun_ = true;
      return false;
    }
    hash_.update(data, len);
    bytes_ += static_cast<uint32_t>(len);
    if (!slot_.write(data, len)) {
      writeFailed_ = true;
      return false;
    }
    return true;
  }

  uint32_t bytes() const { return bytes_; }
  bool overrun() const { return overrun_; }
  bool writeFailed() const { return writeFailed_; }
  void digest(uint8_t out[32]) { hash_.finish(out); }

private:
  IOtaSlot& slot_;
  GateOta::Hooks& hooks_;
  uint32_t limit_;
  dc::Sha256 hash_;
  uint32_t bytes_ = 0U;
  bool overrun_ = false;
  bool writeFailed_ = false;
};

} // namespace

const char* fwStateName(FwState state) {
  switch (state) {
  case FwState::Probation:
    return "probation";
  case FwState::Downloading:
    return "downloading";
  case FwState::RolledBack:
    return "rolled_back";
  case FwState::Failed:
    return "failed";
  case FwState::Committed:
    break;
  }
  return "committed";
}

bool GateOta::persist() {
  return store_ == nullptr || sealedPut(*store_, kRecOta, kOtaLayout, record_, gScratch, sizeof(gScratch));
}

GateOta::Boot GateOta::begin(IBlobStore* store, const char* runningVersion) {
  store_ = store;
  copyText(running_, sizeof(running_), runningVersion);
  record_ = OtaRecord();
  OtaRecord stored;
  if (store_ != nullptr && sealedGet(*store_, kRecOta, kOtaLayout, stored, gScratch, sizeof(gScratch))) {
    record_ = stored;
  }
  pending_ = false;
  probationStarted_ = false;
  retryArmed_ = false;
  if (record_.state != static_cast<uint8_t>(FwState::Probation)) {
    return Boot::Normal;
  }
  if (strcmp(record_.version, running_) != 0) {
    // The image on probation is not the one running: the switch never took, or
    // the bootloader rolled back by itself. Either way it is over for that
    // version.
    char version[devota::kVersionCap] = {};
    copyText(version, sizeof(version), record_.version);
    fail(version, "probation", true);
    record_.state = static_cast<uint8_t>(FwState::RolledBack);
    static_cast<void>(persist());
    return Boot::Normal;
  }
  if (record_.boots < UINT8_MAX) {
    ++record_.boots;
  }
  static_cast<void>(persist());
  return devota::Probation::atBoot(record_.boots) == devota::Probation::Decision::RollBack ? Boot::RollBack
                                                                                         : Boot::Normal;
}

void GateOta::fail(const char* version, const char* why, bool neverAgain) {
  record_.state = static_cast<uint8_t>(FwState::Failed);
  copyText(record_.failedVersion, sizeof(record_.failedVersion), version);
  copyText(record_.error, sizeof(record_.error), why);
  if (neverAgain && version != nullptr && version[0] != '\0') {
    record_.failed.add(version);
  }
  record_.version[0] = '\0';
  record_.boots = 0U;
}

void GateOta::markRolledBack(const char* why) {
  char version[devota::kVersionCap] = {};
  copyText(version, sizeof(version), record_.version[0] != '\0' ? record_.version : running_);
  fail(version, why, true);
  record_.state = static_cast<uint8_t>(FwState::RolledBack);
  static_cast<void>(persist());
}

void GateOta::offer(const jv::Value& ota, const uint8_t modulus[dc::kRsa2048Bytes], uint32_t nowMs) {
  if (!ota.present() || inProbation() || pending_) {
    return;
  }
  if (retryArmed_ && tb::since(nowMs, retryAfterMs_) < kOtaRetryMs) {
    return;
  }
  retryArmed_ = false;
  devota::Offer parsed;
  const devota::Refusal grammar = devota::parseOffer(ota.at, ota.len, devota::kTargetDoorGate, parsed);
  if (grammar != devota::Refusal::Ok) {
    // An offer this board cannot read at all, or one for another target: said
    // once, so the server can stop offering it.
    if (record_.state != static_cast<uint8_t>(FwState::Failed) || strcmp(record_.error, devota::fwErrorFor(grammar)) != 0) {
      fail(parsed.version, devota::fwErrorFor(grammar), false);
      static_cast<void>(persist());
    }
    return;
  }
  const devota::Refusal version = devota::acceptVersion(running_, parsed.version, record_.failed);
  if (version != devota::Refusal::Ok) {
    // Not newer, or a version that already failed here: not an offer for this
    // board, and nothing to report — the server keys its offers on what this
    // board reported last.
    return;
  }
  char text[devota::kManifestCap] = {};
  const size_t n = devota::manifestText(parsed, text, sizeof(text));
  const devota::Refusal sig = n == 0U ? devota::Refusal::Sig : devota::verifySignature(text, n, parsed.sig, modulus);
  if (sig != devota::Refusal::Ok) {
    fail(parsed.version, devota::fwErrorFor(sig), true);
    static_cast<void>(persist());
    return;
  }
  offer_ = parsed;
  pending_ = true;
  record_.state = static_cast<uint8_t>(FwState::Downloading);
  record_.failedVersion[0] = '\0';
  record_.error[0] = '\0';
}

bool GateOta::run(IDownload& download, IOtaSlot& slot, const uint8_t modulus[dc::kRsa2048Bytes], Hooks& hooks,
                  uint32_t nowMs) {
  if (!pending_) {
    return false;
  }
  pending_ = false;
  if (offer_.size > slot.capacity() || !slot.begin(offer_.size)) {
    fail(offer_.version, "space", false);
    static_cast<void>(persist());
    retryAfterMs_ = nowMs;
    retryArmed_ = true;
    return false;
  }
  StagingSink sink(slot, hooks, offer_.size);
  const uint16_t status = download.get(offer_.path, offer_.size, sink);
  if (sink.writeFailed()) {
    slot.abort();
    fail(offer_.version, "flash", false);
    static_cast<void>(persist());
    retryAfterMs_ = nowMs;
    retryArmed_ = true;
    return false;
  }
  if (sink.overrun()) {
    // More bytes than the signed size: never a transient.
    slot.abort();
    fail(offer_.version, "size", true);
    static_cast<void>(persist());
    return false;
  }
  if (status != 200U || sink.bytes() < offer_.size) {
    // Refused, or cut short in transit: the image is not at fault, so the same
    // offer is taken again after kOtaRetryMs.
    slot.abort();
    fail(offer_.version, "http", false);
    static_cast<void>(persist());
    retryAfterMs_ = nowMs;
    retryArmed_ = true;
    return false;
  }
  uint8_t digest[32] = {};
  sink.digest(digest);
  const devota::Refusal verified = devota::verifyStaged(offer_, digest, sink.bytes(), modulus);
  if (verified != devota::Refusal::Ok) {
    slot.abort();
    // A hash or size that disagrees with a signed manifest: the bytes this
    // server serves for that version are not the bytes that were signed. It is
    // never taken again.
    fail(offer_.version, devota::fwErrorFor(verified), true);
    static_cast<void>(persist());
    return false;
  }
  if (!slot.finish() || !slot.activate()) {
    slot.abort();
    fail(offer_.version, "flash", false);
    static_cast<void>(persist());
    retryAfterMs_ = nowMs;
    retryArmed_ = true;
    return false;
  }
  record_.state = static_cast<uint8_t>(FwState::Probation);
  copyText(record_.version, sizeof(record_.version), offer_.version);
  record_.failedVersion[0] = '\0';
  record_.error[0] = '\0';
  record_.boots = 0U;
  static_cast<void>(persist());
  return true;
}

void GateOta::heartbeatAccepted() {
  if (!inProbation()) {
    return;
  }
  record_.state = static_cast<uint8_t>(FwState::Committed);
  record_.version[0] = '\0';
  record_.boots = 0U;
  static_cast<void>(persist());
  probationStarted_ = false;
}

bool GateOta::tick(uint32_t nowMs, uint32_t windowMinutes) {
  if (!inProbation()) {
    return false;
  }
  if (!probationStarted_) {
    probation_.begin(nowMs, windowMinutes * 60000UL);
    probationStarted_ = true;
  }
  return probation_.tick(nowMs, false) == devota::Probation::Decision::RollBack;
}

} // namespace gatelogic
