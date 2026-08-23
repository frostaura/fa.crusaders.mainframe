// The Mega/ESP link driver. See include/arduino_hal/SerialTransport.h.

#include "arduino_hal/SerialTransport.h"

#include <Arduino.h>

#include "arduino_hal/Pins.h"

namespace arduino_hal {

SerialTransport::SerialTransport(HardwareSerial& port) : port_(port), open_(false) {
}

void SerialTransport::begin() {
  port_.begin(kBridgeBaud);
  open_ = true;
}

bool SerialTransport::connected() {
  return open_;
}

size_t SerialTransport::writable() {
  if (!open_) {
    return 0U;
  }
  const int free = port_.availableForWrite();
  return free > 0 ? static_cast<size_t>(free) : 0U;
}

size_t SerialTransport::write(const uint8_t* data, size_t len) {
  if (!open_ || data == nullptr) {
    return 0U;
  }
  // Offer only what the ring can take. Serial.write() would otherwise spin
  // until the UART drains, and a blocking write here stalls the relay auto-off
  // timer for tens of milliseconds per frame.
  const size_t room = writable();
  const size_t offered = len < room ? len : room;
  return offered == 0U ? 0U : port_.write(data, offered);
}

bool SerialTransport::read(uint8_t& out) {
  if (!open_) {
    return false;
  }
  const int value = port_.read();
  if (value < 0) {
    return false;
  }
  out = static_cast<uint8_t>(value);
  return true;
}

} // namespace arduino_hal
