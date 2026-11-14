#include "gatelogic/GateNet.h"

#include <stdio.h>
#include <string.h>

#include "devapi/Json.h"
#include "timebase/TimeBase.h"

namespace gatelogic {

namespace {

constexpr uint16_t kNetLayout = 1U;

uint8_t gScratch[sizeof(RecordHeader) + sizeof(NetRecord)];

void copyText(char* out, size_t cap, const char* in) {
  const size_t n = in == nullptr ? 0U : strlen(in);
  if (n + 1U > cap) {
    out[0] = '\0';
    return;
  }
  memcpy(out, in == nullptr ? "" : in, n + 1U);
}

bool sameProfile(const devnet::Profile& a, const devnet::Profile& b) {
  return strcmp(a.ssid, b.ssid) == 0 && strcmp(a.psk, b.psk) == 0;
}

} // namespace

const char* netSourceName(NetSource source) {
  switch (source) {
  case NetSource::Server:
    return "server";
  case NetSource::Compiled:
    break;
  }
  return "compiled";
}

void GateNet::begin(const char* ssid, const char* psk, const char* baseUrl, IBlobStore* store) {
  store_ = store;
  copyText(compiled_.ssid, sizeof(compiled_.ssid), ssid);
  copyText(compiled_.psk, sizeof(compiled_.psk), psk);
  copyText(compiledBase_, sizeof(compiledBase_), baseUrl);
  record_ = NetRecord();
  NetRecord stored;
  if (store_ != nullptr && sealedGet(*store_, kRecNet, kNetLayout, stored, gScratch, sizeof(gScratch))) {
    record_ = stored;
  }
  active_ = 0U;
  rebuild();
}

void GateNet::rebuild() {
  // The base: the current set's, unless it was abandoned; else the previous
  // set's; else the compiled one.
  const char* base = compiledBase_;
  if (record_.hasPrevious && record_.previous.hasBase) {
    base = record_.previous.base;
  }
  if (record_.hasCurrent && record_.current.hasBase) {
    base = record_.current.base;
  }
  copyText(base_, sizeof(base_), base);

  profileCount_ = 0U;
  // New first, then the previous set, then the compiled defaults (§8).
  if (record_.hasCurrent) {
    addProfiles(record_.current);
  }
  if (record_.hasPrevious) {
    addProfiles(record_.previous);
  }
  addProfile(compiled_);
  if (active_ >= profileCount_) {
    active_ = 0U;
  }
}

void GateNet::addProfiles(const devnet::NetSet& set) {
  for (uint8_t w = 0U; w < devnet::kProfiles; ++w) {
    if (set.hasWifi[w]) {
      addProfile(set.wifi[w]);
    }
  }
}

void GateNet::addProfile(const devnet::Profile& profile) {
  for (uint8_t i = 0U; i < profileCount_; ++i) {
    if (sameProfile(profiles_[i], profile)) {
      return;
    }
  }
  if (profileCount_ < kMaxProfiles) {
    profiles_[profileCount_] = profile;
    ++profileCount_;
  }
}

uint8_t GateNet::advanceProfile() {
  active_ = static_cast<uint8_t>((active_ + 1U) % (profileCount_ == 0U ? 1U : profileCount_));
  return active_;
}

bool GateNet::persist() {
  return store_ == nullptr || sealedPut(*store_, kRecNet, kNetLayout, record_, gScratch, sizeof(gScratch));
}

uint32_t GateNet::version() const {
  return record_.hasCurrent && record_.source == static_cast<uint8_t>(NetSource::Server) ? record_.current.ver
                                                                                         : 0U;
}

devnet::NetResult GateNet::adopt(const char* object, size_t len, uint32_t nowMs) {
  devnet::NetSet staged;
  devnet::NetResult result = devnet::adoptNet(object, len, version(), staged);
  if (!result.adopted()) {
    return result;
  }
  if (staged.ver == record_.abandonedVer) {
    result.reason = devnet::Refusal::NotNewer;
    return result;
  }
  // Absent base: the one in use carries over. Absent profiles: as sent.
  if (!staged.hasBase) {
    copyText(staged.base, sizeof(staged.base), base_);
    staged.hasBase = true;
  }
  // Static: the record is two whole network sets, and the copy kept for a
  // failed persist() put this over the 8 KB loop task's frame budget.
  static NetRecord before;
  before = record_;
  if (record_.hasCurrent) {
    record_.previous = record_.current;
    record_.hasPrevious = true;
  }
  record_.current = staged;
  record_.hasCurrent = true;
  record_.source = static_cast<uint8_t>(NetSource::Server);
  record_.baseUnproven = strcmp(staged.base, base_) != 0;
  if (!persist()) {
    record_ = before;
    result.reason = devnet::Refusal::NetEmpty;
    return result;
  }
  adoptedAtMs_ = nowMs;
  active_ = 0U;
  rebuild();
  return result;
}

void GateNet::heartbeatAccepted() {
  if (record_.baseUnproven) {
    record_.baseUnproven = false;
    static_cast<void>(persist());
  }
}

bool GateNet::tick(uint32_t nowMs, uint32_t fallbackMinutes) {
  if (!record_.baseUnproven) {
    return false;
  }
  if (tb::since(nowMs, adoptedAtMs_) < fallbackMinutes * 60000UL) {
    return false;
  }
  // ABANDONED. The previous base again, and this version never again. The
  // WiFi profiles stay as they are: they are tried in order by the supervisor.
  record_.abandonedVer = record_.current.ver;
  record_.current.hasBase = false;
  record_.current.ver = record_.hasPrevious ? record_.previous.ver : 0U;
  record_.baseUnproven = false;
  static_cast<void>(persist());
  rebuild();
  return true;
}

} // namespace gatelogic
