// Crusaders Mainframe — hal::IScannerPort on a HardwareSerial.
//
// The QR module sits on Mega Serial2 (RX 17 / TX 16) at 9600 and emits its
// payload whenever somebody happens to present a phone. The stream is
// binary-clean: 0x00 is delivered like any other byte, because deciding that a
// NUL means the payload is corrupt is the framing layer's job
// (courtlogic::ScanAssembler), not this driver's.
//
// Arduino's Stream::read() returns an int, -1 for "nothing". That signature is
// left at this boundary and never propagated: every call site above would then
// juggle a signed int holding an unsigned byte, which is the exact conversion
// the strict gate rejects and which makes 0xFF and -1 look alike at a glance.

#ifndef CRUSADERS_ARDUINO_HAL_SERIALSCANNER_H
#define CRUSADERS_ARDUINO_HAL_SERIALSCANNER_H

#include <Arduino.h>

#include <stdint.h>

#include "hal/Scanner.h"

namespace arduino_hal {

class SerialScanner final : public hal::IScannerPort {
public:
  /// `port` must outlive this object. On the Mega it is the global Serial2.
  explicit SerialScanner(HardwareSerial& port);

  /// Open the UART at the scanner's fixed 9600 baud.
  void begin();

  bool read(uint8_t& out) override;

  void setBaud(uint32_t baud) override;

private:
  HardwareSerial& port_;
  uint32_t baud_;
};

} // namespace arduino_hal

#endif // CRUSADERS_ARDUINO_HAL_SERIALSCANNER_H
