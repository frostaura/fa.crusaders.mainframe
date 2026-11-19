// Crusaders Mainframe — the QR scanner on the Pi's UART (or a USB-serial tty).
//
// The Pi counterpart of arduino_hal::SerialScanner. Bytes only: framing, the
// baud auto-detect and the idle-gap line end are courtlogic::ScanAssembler's,
// unchanged. setBaud() is how that auto-detect moves the port.
//
// The path is /dev/serial0 by default (the PL011 on GPIO 14/15 once
// `dtoverlay=disable-bt` frees it), and any tty works — a scanner on USB is
// /dev/ttyACM0 and needs no level shifter at all.

#ifndef CRUSADERS_LINUX_HAL_UARTSCANNER_H
#define CRUSADERS_LINUX_HAL_UARTSCANNER_H

#include <stdint.h>

#include "hal/Scanner.h"

namespace linux_hal {

class UartScanner final : public hal::IScannerPort {
public:
  UartScanner() = default;
  ~UartScanner() override;

  /// False when the tty cannot be opened or configured.
  bool begin(const char* path, uint32_t baud);
  bool read(uint8_t& out) override;
  void setBaud(uint32_t baud) override;

  uint32_t baud() const { return baud_; }

private:
  bool applyBaud(uint32_t baud);

  int fd_ = -1;
  uint32_t baud_ = 9600U;
  uint8_t buf_[256] = {};
  uint16_t head_ = 0U;
  uint16_t len_ = 0U;
};

} // namespace linux_hal

#endif // CRUSADERS_LINUX_HAL_UARTSCANNER_H
