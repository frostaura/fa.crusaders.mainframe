// Crusaders Mainframe — hal::IStore on ordinary files.
//
// One file per key under a directory, the same shape as the ESP8266's
// LittleFsStore, so a scenario that works against the simulator works against
// the board. Deliberately NOT an in-memory map: a store that forgot everything
// when the process exited could not reproduce "the box was power-cycled and
// carried on where it left off", which is the whole point of persisting
// anything.
//
// No integrity check inside the driver, for the same reason as the two device
// stores: hal/Store.h puts that obligation on the caller, and a simulator that
// verified for them would be more forgiving than the hardware.
//
// HONEST LIMIT: this cannot reproduce a torn write. A local filesystem write of
// 32 bytes either happens or does not, whereas an EEPROM cell being programmed
// when the breaker trips leaves half a record behind. fakes::FakeStore's
// tearNextWriteAfter() is the only thing in this repo that produces that case,
// which is why the recovery path is proven in the host suite and not here.

#ifndef CRUSADERS_POSIX_HAL_FILESTORE_H
#define CRUSADERS_POSIX_HAL_FILESTORE_H

#include <stdint.h>

#include "hal/Store.h"

namespace posix_hal {

/// Longest directory path accepted, terminator included.
inline constexpr uint16_t kStorePathMax = 256U;

class FileStore final : public hal::IStore {
public:
  FileStore();

  /// Create `dir` if needed and use it. False when the path is too long or the
  /// directory cannot be created — the simulator reports it rather than running
  /// with a store that silently loses every write.
  bool begin(const char* dir);

  hal::StoreResult put(const char* key, const uint8_t* value, uint8_t len) override;

  hal::StoreResult get(const char* key, uint8_t* out, uint8_t cap, uint8_t& outLen) override;

  hal::StoreResult erase(const char* key) override;

private:
  bool pathFor(const char* key, char* out, uint16_t cap) const;

  char dir_[kStorePathMax];
  bool ready_;
};

} // namespace posix_hal

#endif // CRUSADERS_POSIX_HAL_FILESTORE_H
