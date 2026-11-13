// See include/courtlogic/MegaSettings.h.

#include "courtlogic/MegaSettings.h"

namespace courtlogic {

namespace {

bool sameName(const char* a, const char* b) {
  uint8_t i = 0U;
  for (; a[i] != '\0' && a[i] == b[i]; ++i) {
  }
  return a[i] == b[i];
}

} // namespace

MegaSettings::MegaSettings() : values_(), lastApplied_(Cfg::Count) {
  reset();
}

void MegaSettings::reset() {
  for (uint8_t i = 0U; i < kCfgCount; ++i) {
    values_[i] = kCfgKeys[i].boot;
  }
}

proto::AckCode MegaSettings::apply(const char* key, uint32_t value) {
  for (uint8_t i = 0U; i < kCfgCount; ++i) {
    const CfgKey& k = kCfgKeys[i];
    if (!sameName(k.name, key)) {
      continue;
    }
    const bool inSet = i == static_cast<uint8_t>(Cfg::Lcda) ? lcdAddressAllowed(value)
                                                             : (value >= k.min && value <= k.max);
    if (k.enumerated && !inSet) {
      if (i == static_cast<uint8_t>(Cfg::Layout)) {
        values_[i] = 0U;
      }
      return proto::AckCode::Refused;
    }
    values_[i] = value < k.min ? k.min : (value > k.max ? k.max : static_cast<uint16_t>(value));
    lastApplied_ = static_cast<Cfg>(i);
    return proto::AckCode::Applied;
  }
  return proto::AckCode::Refused;
}

} // namespace courtlogic
