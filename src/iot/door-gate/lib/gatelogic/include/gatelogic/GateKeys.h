// Crusaders Mainframe — the gate's device keys (docs/specs/device-api.md §6).
//
// v2's *Regenerate key* stranded every door until it was reflashed (DG-1b). A
// 2.0.0 gate holds at most two keys — the current and the previous — learns a
// new one from `key_next`, persists it before using it, and authenticates the
// next request with it. On a 401 it retries THAT request once with the other
// key it holds, and keeps both: it never erases a key on a 401, because a 401
// is as likely to be a server restored from an old backup as a retired key.
// Whichever key last succeeded is the one tried first, so a board whose server
// went back to the old key does not pay two calls on every request.
//
// The compiled `DEVICE_API_KEY` is `k0`, the first-boot default only.
//
// No heap, no Arduino headers, valid C++11.

#ifndef CRUSADERS_GATELOGIC_GATEKEYS_H
#define CRUSADERS_GATELOGIC_GATEKEYS_H

#include <stddef.h>
#include <stdint.h>

#include "devapi/DeviceClient.h"
#include "devnet/Net.h"
#include "gatelogic/GateStore.h"

namespace gatelogic {

class GateKeys {
public:
  /// `compiledKey` is `k0`. A persisted ring, when one validates, wins: it is
  /// what the server has been told this board holds.
  void begin(const char* compiledKey, IBlobStore* store);

  /// The `Authorization` header for the key tried first.
  const char* header() const { return header_; }

  /// A 401 arrived: switch to the other held key for one retry. False when
  /// there is no other key, which leaves the header as it was.
  bool switchForRetry();

  /// The retry with the other key failed too: go back to the one tried first,
  /// so the next request starts where the last one did.
  void retryFailed();

  /// `key_next`'s object, from an accepted heartbeat. Persisted before it is
  /// used; a refusal (corpus reason) changes nothing.
  devnet::Refusal adopt(const char* object, size_t len);

  /// A key restored at the setup portal: it becomes current, the previous key
  /// is kept. Validated with the `provision/` `keys` rules.
  bool adoptLocal(const char* id, const char* key);

  const devnet::KeyRing& ring() const { return ring_; }

  /// Which key the last success used: false = current.
  bool onPrevious() const { return onPrevious_; }

private:
  void render();
  bool persist();

  devnet::KeyRing ring_;
  IBlobStore* store_ = nullptr;
  const char* compiled_ = "";
  bool onPrevious_ = false;
  char header_[devapi::kAuthorizationBufSize] = {};
};

} // namespace gatelogic

#endif // CRUSADERS_GATELOGIC_GATEKEYS_H
