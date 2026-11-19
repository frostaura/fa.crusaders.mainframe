// court-pi compat — the Arduino core on Linux, and court-brain's main().
#include "Arduino.h"

#include <errno.h>
#include <signal.h>
#include <sys/random.h>
#include <time.h>
#include <unistd.h>

#include "compat/BrainConfig.h"
#include "linux_hal/Service.h"
#include "linux_hal/UnixLink.h"

// The bridge's own entry points (court-box/src/court_bridge/main.cpp).
void setup();
void loop();

namespace {

uint64_t monoUs() {
  timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return static_cast<uint64_t>(ts.tv_sec) * 1000000ULL + static_cast<uint64_t>(ts.tv_nsec) / 1000ULL;
}

const uint64_t kOriginUs = monoUs();

linux_hal::UnixLinkClient gLink;
size_t gRxCapacity = 256U;
bool gLinkConfigured = false;

volatile sig_atomic_t gStop = 0;

void onSignal(int) {
  gStop = 1;
}

void sleepUs(uint64_t us) {
  timespec ts;
  ts.tv_sec = static_cast<time_t>(us / 1000000ULL);
  ts.tv_nsec = static_cast<long>(us % 1000000ULL) * 1000L;
  while (nanosleep(&ts, &ts) != 0 && errno == EINTR) {
  }
}

} // namespace

uint32_t millis() {
  return static_cast<uint32_t>((monoUs() - kOriginUs) / 1000ULL);
}

uint32_t micros() {
  return static_cast<uint32_t>(monoUs() - kOriginUs);
}

void delay(uint32_t ms) {
  sleepUs(static_cast<uint64_t>(ms) * 1000ULL);
  linux_hal::kickWatchdog();
}

void delayMicroseconds(unsigned int us) {
  sleepUs(us);
}

void yield() {
  linux_hal::kickWatchdog();
}

namespace compat {

uint32_t randomWord() {
  uint32_t word = 0U;
  if (getrandom(&word, sizeof(word), 0) != static_cast<ssize_t>(sizeof(word))) {
    word = static_cast<uint32_t>(monoUs() * 2654435761ULL);
  }
  return word;
}

} // namespace compat

HardwareSerial Serial;

void HardwareSerial::begin(unsigned long baud) {
  static_cast<void>(baud); // a socket has no baud; the bridge's own pacing remains
  gLink.configure(compat::config().link, gRxCapacity);
  gLinkConfigured = true;
}

size_t HardwareSerial::setRxBufferSize(size_t size) {
  gRxCapacity = size;
  return size;
}

int HardwareSerial::available() {
  return gLinkConfigured ? gLink.available() : 0;
}

int HardwareSerial::availableForWrite() {
  return gLinkConfigured ? gLink.availableForWrite() : 0;
}

int HardwareSerial::read() {
  return gLinkConfigured ? gLink.read() : -1;
}

size_t HardwareSerial::write(const uint8_t* data, size_t len) {
  return gLinkConfigured ? gLink.write(data, len) : 0U;
}

size_t HardwareSerial::println(const char* text) {
  return static_cast<size_t>(fprintf(stderr, "%s\n", text != nullptr ? text : ""));
}

size_t HardwareSerial::print(const char* text) {
  return static_cast<size_t>(fprintf(stderr, "%s", text != nullptr ? text : ""));
}

int main() {
  if (!compat::loadConfig()) {
    return 2;
  }
  static_cast<void>(signal(SIGINT, onSignal));
  static_cast<void>(signal(SIGTERM, onSignal));
  static_cast<void>(signal(SIGPIPE, SIG_IGN));
  static_cast<void>(signal(SIGCHLD, SIG_IGN)); // nmcli children reap themselves
  static_cast<void>(linux_hal::ensureDir(compat::config().run));
  static_cast<void>(linux_hal::ensureDir(compat::config().data));

  setup();
  linux_hal::notify("READY=1");
  fprintf(stderr, "[court-brain] up: link %s, data %s, identity %s\n", compat::config().link,
          compat::config().data, compat::config().macSet ? "COURT_BRAIN_MAC" : compat::config().iface);
  while (gStop == 0) {
    linux_hal::kickWatchdog();
    loop();
    // The ESP's loop() spins; on the Pi one millisecond between passes keeps
    // court-brain off the CPU court-io shares, and is far finer than anything
    // the bridge times (its shortest deadline is the 1.5 s button answer).
    sleepUs(1000U);
  }
  linux_hal::notify("STOPPING=1");
  return 0;
}
