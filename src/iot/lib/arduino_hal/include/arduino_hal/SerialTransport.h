// Crusaders Mainframe — hal::ITransport on the Mega/ESP link.
//
// Mega Serial3 (TX 14 / RX 15) at one end, the ESP8266's Serial at the other,
// 9600 8N1, routed by the DIP block. The wiring cannot change, so neither can
// the baud: 9600 is 960 bytes a second, and a 40-byte frame occupies the link
// for ~42 ms. "The buffer was full" is an ordinary Tuesday on this link.
//
// WHY writable() IS availableForWrite() AND NOT A CONSTANT
// --------------------------------------------------------
// Arduino's Serial.write() BLOCKS when the TX ring is full: it spins until the
// UART drains. At 9600 baud that is tens of milliseconds during which the relay
// auto-off timer does not run — the one mechanism that still works when the
// bridge, the WiFi and the backend are all gone. So the caller asks first, and
// the port answers with the real free space rather than a guess.
//
// connected() is honest about what a UART can know: there is no carrier on this
// link, so the only detectable failure is the port never having been opened.
// The peer being absent, resetting or mid-OTA is indistinguishable from the peer
// being quiet, which is why the protocol has `!PING`/`!PONG` and why the Mega's
// timer does not depend on the answer either way.

#ifndef CRUSADERS_ARDUINO_HAL_SERIALTRANSPORT_H
#define CRUSADERS_ARDUINO_HAL_SERIALTRANSPORT_H

#include <Arduino.h>

#include <stddef.h>
#include <stdint.h>

#include "hal/Transport.h"

namespace arduino_hal {

class SerialTransport final : public hal::ITransport {
public:
  /// `port` must outlive this object: Serial3 on the Mega, Serial on the ESP.
  explicit SerialTransport(HardwareSerial& port);

  /// Open the UART at the link's fixed 9600 baud.
  void begin();

  bool connected() override;

  size_t writable() override;

  size_t write(const uint8_t* data, size_t len) override;

  bool read(uint8_t& out) override;

private:
  HardwareSerial& port_;
  bool open_;
};

} // namespace arduino_hal

#endif // CRUSADERS_ARDUINO_HAL_SERIALTRANSPORT_H
