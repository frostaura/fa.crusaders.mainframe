// The QR scanner driver. See include/arduino_hal/SerialScanner.h.

#include "arduino_hal/SerialScanner.h"

#include <Arduino.h>

#include "arduino_hal/Pins.h"

namespace arduino_hal {

SerialScanner::SerialScanner(HardwareSerial& port) : port_(port) {
}

void SerialScanner::begin() {
  port_.begin(kScannerBaud);
}

bool SerialScanner::read(uint8_t& out) {
  const int value = port_.read();
  if (value < 0) {
    return false;
  }
  out = static_cast<uint8_t>(value);
  return true;
}

} // namespace arduino_hal
