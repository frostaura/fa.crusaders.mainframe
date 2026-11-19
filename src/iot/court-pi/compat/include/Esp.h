// Crusaders Mainframe — court-pi compat: the ESP8266 core's ESP object on Linux.
//
//   ESP.getResetInfoPtr()  power_on on the first start since the Pi powered up,
//                          software on every restart after (a marker in /run).
//   ESP.restart()          exit(0); systemd's Restart=always is the reboot.
//   ESP rtc memory         a file in /run: kept across a process restart, wiped
//                          by a power cycle — RTC memory's own semantics.
//   heap / stack / flash   MemAvailable, RLIMIT_STACK and the data partition,
//                          clamped to 32 bits: the server's floors (device-api.md
//                          §13) are for an 80 KB chip and never fire on a Pi.

#ifndef CRUSADERS_COURT_PI_COMPAT_ESP_H
#define CRUSADERS_COURT_PI_COMPAT_ESP_H

#include <stddef.h>
#include <stdint.h>

// The reset reasons of the ESP8266 SDK's rst_info, by their SDK values.
enum rst_reason {
  REASON_DEFAULT_RST = 0,
  REASON_WDT_RST = 1,
  REASON_EXCEPTION_RST = 2,
  REASON_SOFT_WDT_RST = 3,
  REASON_SOFT_RESTART = 4,
  REASON_DEEP_SLEEP_AWAKE = 5,
  REASON_EXT_SYS_RST = 6
};

struct rst_info {
  uint32_t reason;
  uint32_t exccause;
  uint32_t epc1;
  uint32_t epc2;
  uint32_t epc3;
  uint32_t excvaddr;
  uint32_t depc;
};

class EspClass {
public:
  const rst_info* getResetInfoPtr();
  [[noreturn]] void restart();
  uint32_t getFreeHeap();
  uint32_t getMaxFreeBlockSize();
  uint32_t getFreeContStack();
  uint32_t getFreeSketchSpace();
  uint32_t getFlashChipRealSize();
  bool rtcUserMemoryRead(uint32_t offset, uint32_t* data, size_t size);
  bool rtcUserMemoryWrite(uint32_t offset, uint32_t* data, size_t size);
};

extern EspClass ESP;

#endif // CRUSADERS_COURT_PI_COMPAT_ESP_H
