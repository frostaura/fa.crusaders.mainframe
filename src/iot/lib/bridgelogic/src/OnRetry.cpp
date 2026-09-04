#include "bridgelogic/OnRetry.h"

#include <string.h>

namespace bridgelogic {

bool isReceiveError(proto::Verb verb, const char* name, const char* detail) {
  if (name == nullptr || detail == nullptr) {
    return false;
  }
  if (verb == proto::Verb::Err) {
    return strcmp(name, proto::errorName(proto::DecodeError::BadCrc)) == 0;
  }
  if (verb == proto::Verb::Evt) {
    return strcmp(name, proto::errorName(proto::DecodeError::Overrun)) == 0 && strcmp(detail, "RX") == 0;
  }
  return false;
}

void OnRetry::sent(const proto::Frame& on, uint32_t nowMs) {
  if (on.verb() != proto::Verb::On) {
    return;
  }
  frame_ = on;
  window_.arm(nowMs, kRetryWindowMs);
}

bool OnRetry::shouldResend(uint32_t nowMs, proto::Frame& out) {
  if (!window_.isArmed() || window_.expired(nowMs)) {
    clear();
    return false;
  }
  out = frame_;
  clear();
  if (retries_ < UINT16_MAX) {
    ++retries_;
  }
  return true;
}

void OnRetry::clear() {
  window_.disarm();
  frame_ = proto::Frame();
}

} // namespace bridgelogic
