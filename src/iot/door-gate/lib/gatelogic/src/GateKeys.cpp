#include "gatelogic/GateKeys.h"

#include <string.h>

namespace gatelogic {

namespace {

constexpr uint16_t kKeysLayout = 1U;
constexpr char kCompiledId[] = "k0";

uint8_t gScratch[sizeof(RecordHeader) + sizeof(devnet::KeyRing)];

bool isCompiled(const char* id) {
  return strcmp(id, kCompiledId) == 0;
}

bool validKey(const char* key) {
  if (key == nullptr || strlen(key) != devnet::kKeyLen) {
    return false;
  }
  for (size_t i = 0U; i < devnet::kKeyLen; ++i) {
    const char c = key[i];
    const bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' ||
                    c == '_';
    if (!ok) {
      return false;
    }
  }
  return true;
}

bool validId(const char* id) {
  const size_t n = id == nullptr ? 0U : strlen(id);
  if (n < 2U || n > 7U || id[0] != 'k' || id[1] < '1' || id[1] > '9') {
    return false;
  }
  for (size_t i = 2U; i < n; ++i) {
    if (id[i] < '0' || id[i] > '9') {
      return false;
    }
  }
  return true;
}

} // namespace

void GateKeys::begin(const char* compiledKey, IBlobStore* store) {
  compiled_ = compiledKey == nullptr ? "" : compiledKey;
  store_ = store;
  ring_ = devnet::KeyRing();
  memcpy(ring_.currentId, kCompiledId, sizeof(kCompiledId));
  devnet::KeyRing stored;
  if (store_ != nullptr && sealedGet(*store_, kRecKeys, kKeysLayout, stored, gScratch, sizeof(gScratch)) &&
      stored.currentId[0] == 'k') {
    ring_ = stored;
  }
  onPrevious_ = false;
  render();
}

void GateKeys::render() {
  const char* id = onPrevious_ ? ring_.previousId : ring_.currentId;
  const char* key = onPrevious_ ? ring_.previousKey : ring_.currentKey;
  if (isCompiled(id)) {
    key = compiled_;
  }
  if (devapi::renderAuthorization(header_, sizeof(header_), key) == 0U) {
    header_[0] = '\0';
  }
}

bool GateKeys::switchForRetry() {
  if (!ring_.hasPrevious) {
    return false;
  }
  onPrevious_ = !onPrevious_;
  render();
  return true;
}

void GateKeys::retryFailed() {
  onPrevious_ = !onPrevious_;
  render();
}

bool GateKeys::persist() {
  return store_ == nullptr || sealedPut(*store_, kRecKeys, kKeysLayout, ring_, gScratch, sizeof(gScratch));
}

devnet::Refusal GateKeys::adopt(const char* object, size_t len) {
  // The compiled key is k0 and its text lives in the image, not the ring; the
  // shared reader keeps a previous key only when the current one has text, so
  // k0 is given a marker that `render` never sends (it sends the compiled key).
  devnet::KeyRing view = ring_;
  if (isCompiled(view.currentId) && view.currentKey[0] == '\0') {
    view.currentKey[0] = '-';
    view.currentKey[1] = '\0';
  }
  devnet::KeyRing next;
  const devnet::Refusal got = devnet::adoptKeyNext(object, len, view, next);
  if (got != devnet::Refusal::Ok) {
    return got;
  }
  const devnet::KeyRing before = ring_;
  ring_ = next;
  // PERSISTED BEFORE IT IS USED: a board that authenticated with a key it then
  // lost in a power cut would be on a key the server thinks it holds and it
  // does not.
  if (!persist()) {
    ring_ = before;
    return devnet::Refusal::Key;
  }
  onPrevious_ = false;
  render();
  return got;
}

bool GateKeys::adoptLocal(const char* id, const char* key) {
  if (!validId(id) || !validKey(key)) {
    return false;
  }
  devnet::KeyRing next;
  memcpy(next.currentId, id, strlen(id) + 1U);
  memcpy(next.currentKey, key, devnet::kKeyLen + 1U);
  next.hasPrevious = true;
  memcpy(next.previousId, ring_.currentId, sizeof(next.previousId));
  memcpy(next.previousKey, ring_.currentKey, sizeof(next.previousKey));
  const devnet::KeyRing before = ring_;
  ring_ = next;
  if (!persist()) {
    ring_ = before;
    return false;
  }
  onPrevious_ = false;
  render();
  return true;
}

} // namespace gatelogic
