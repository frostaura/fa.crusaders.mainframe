// Crusaders Mainframe — the Mega<->bridge wire, as a Unix domain socket.
//
// On the Mega + ESP8266 board the two halves talked over Serial3 at 9600. On the
// Pi they are two processes, court-io (the Mega's role) and court-brain (the
// ESP's), and the wire is /run/court-box/link.sock. The BYTES are unchanged:
// the same device-serial-protocol v3 frames, the same CRCs, the same pacing and
// acknowledgements — so a court-brain restart looks to court-io exactly like an
// ESP reset looked to the Mega, and the reverse.
//
// UnixLinkServer is court-io's end (one peer; a new connection replaces the
// old, as a re-seated cable would). UnixLinkClient is court-brain's: it dials,
// re-dials every 500 ms while court-io is away, and DISCARDS writes while
// disconnected — a UART with nobody on the other end does exactly that, and
// the bridge's sender already retries anything unacknowledged.

#ifndef CRUSADERS_LINUX_HAL_UNIXLINK_H
#define CRUSADERS_LINUX_HAL_UNIXLINK_H

#include <stddef.h>
#include <stdint.h>

#include "hal/Transport.h"

namespace linux_hal {

class UnixLinkServer final : public hal::ITransport {
public:
  UnixLinkServer() = default;
  ~UnixLinkServer() override;

  /// Binds `path` (mode 0660, so only the court-box group can drive relays).
  bool listen(const char* path);
  void acceptPending();

  bool connected() override;
  size_t writable() override;
  size_t write(const uint8_t* data, size_t len) override;
  bool read(uint8_t& out) override;

private:
  void dropPeer();
  int listenFd_ = -1;
  int peerFd_ = -1;
  uint8_t rx_[512] = {};
  size_t rxHead_ = 0U;
  size_t rxLen_ = 0U;
};

/// The byte-stream court-brain sees as `Serial`. Not a hal::ITransport on
/// purpose: the bridge reaches it through the unchanged arduino_hal::
/// SerialTransport, over the compat HardwareSerial.
class UnixLinkClient {
public:
  static constexpr size_t kTxCapacity = 256U;

  void configure(const char* path, size_t rxCapacity);
  /// Dials when due, flushes the tx buffer, fills the rx ring. Cheap; called
  /// from every available()/read()/write().
  void pump();

  int available();
  int read();
  int availableForWrite();
  size_t write(const uint8_t* data, size_t len);

  bool connected() const { return fd_ >= 0; }

private:
  void dial();
  void drop();
  const char* path_ = nullptr;
  int fd_ = -1;
  uint64_t nextDialMs_ = 0U;
  uint8_t* rx_ = nullptr;
  size_t rxCap_ = 0U;
  size_t rxHead_ = 0U;
  size_t rxLen_ = 0U;
  uint8_t tx_[kTxCapacity] = {};
  size_t txLen_ = 0U;
};

} // namespace linux_hal

#endif // CRUSADERS_LINUX_HAL_UNIXLINK_H
