// Crusaders Mainframe — native device simulator: the composition root.
//
// WHAT THIS IS FOR
// ----------------
// The .NET integration tests need something on the other end of the court box's
// serial protocol. The cheap option is a stub in the test project, and the
// trouble with a stub is that it only ever agrees with itself: both ends are
// then written from one reading of the spec, so a misreading passes.
//
// This binary is the alternative. It is the SAME courtlogic::CourtBox, the SAME
// lib/protocol codec and the SAME relay auto-off timer that the ATmega runs,
// with posix_hal in place of arduino_hal and a TCP socket in place of Serial3.
// If the firmware's decoder rejects a frame, so does this; if the firmware
// releases a relay at 90 minutes, so does this. That is what makes it evidence
// rather than a second opinion.
//
// WHY THE CLOCK CAN START NEAR THE WRAP
// -------------------------------------
// --start-ms sets what the clock reads at launch. --start-ms 4294963200 puts
// the 49.7-day millis() rollover four seconds after startup, so a boundary test
// can assert "the court still goes dark across the wrap" in one run instead of
// in seven weeks. The rollover is the bug class that burned a court for weeks in
// the system this replaces, so being able to reach it on demand is the point.
//
// WHAT THIS DELIBERATELY DOES NOT SIMULATE
// ----------------------------------------
//   * The ESP8266 half. This is a MEGA simulator: it speaks the downlink side
//     of the serial protocol and expects a bridge — or a test — on the socket.
//     Simulating the bridge as well would mean simulating WiFi and an HTTP
//     client, and the parts of that worth testing — every request body and
//     every response reading — are already covered by lib/bridgelogic's corpus
//     tests.
//   * Torn writes. posix_hal::FileStore cannot produce one; a local filesystem
//     write of 32 bytes either happens or does not. fakes::FakeStore is where
//     that case is exercised.
//   * Electrical failure. Nothing here models a welded contact or a lamp that
//     did not strike, because the real board cannot detect those either — it
//     has no readback, which is a hardware fact and not a simulator gap.

#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "courtlogic/CourtBox.h"
#include "posix_hal/ConsoleButtons.h"
#include "posix_hal/ConsoleDisplay.h"
#include "posix_hal/ConsoleRelay.h"
#include "posix_hal/ConsoleScanner.h"
#include "posix_hal/FileStore.h"
#include "posix_hal/PosixClock.h"
#include "posix_hal/StdinLines.h"
#include "posix_hal/TcpTransport.h"
#include "protocol/Protocol.h"

// The Mega's relay polarity, from the same build flag court_mega is built
// with, so the transcript's pin level is the fitted relays' (see platformio.ini).
#ifndef RELAY_ACTIVE_LOW
#error "RELAY_ACTIVE_LOW is not defined — the simulator takes the Mega's value from platformio.ini"
#endif

namespace {

/// 0 asks the kernel for a free port, which is how a harness runs several
/// simulators at once without picking numbers by hand. The bound port is
/// printed on the first line of stdout for exactly that reason.
constexpr uint16_t kDefaultPort = 0U;

constexpr char kDefaultStoreDir[] = ".simstore";

/// Idle between passes. The firmware's loop must never sleep — a delay there
/// stops the relay auto-off timer — but this process is sharing a CPU with a
/// test suite, and a millisecond is two orders of magnitude finer than the
/// shortest deadline in the protocol.
constexpr long kIdleNs = 1000000L;

/// Set from a signal handler, so it must be sig_atomic_t and nothing else may
/// happen in the handler itself: opening relays takes a socket write, and doing
/// that from a signal context is undefined behaviour on a good day.
volatile sig_atomic_t gStopRequested = 0;

void onSignal(int) {
  gStopRequested = 1;
}

struct Options {
  uint16_t port = kDefaultPort;
  uint32_t startMs = 0U;
  const char* storeDir = kDefaultStoreDir;
  /// See --bind-all. Off by default and it must stay that way.
  bool bindAll = false;
};

bool parseOptions(int argc, char** argv, Options& out) {
  for (int i = 1; i < argc; ++i) {
    const bool hasValue = (i + 1) < argc;
    if (strcmp(argv[i], "--port") == 0 && hasValue) {
      out.port = static_cast<uint16_t>(strtoul(argv[i + 1], nullptr, 10));
      ++i;
    } else if (strcmp(argv[i], "--bind-all") == 0) {
      // Containers only. The container's loopback is its own, so a port mapping
      // cannot reach a simulator bound to it; the container network is the
      // boundary instead. On a developer machine or a club LAN this makes a
      // relay controller anything can talk to.
      out.bindAll = true;
    } else if (strcmp(argv[i], "--start-ms") == 0 && hasValue) {
      out.startMs = static_cast<uint32_t>(strtoul(argv[i + 1], nullptr, 10));
      ++i;
    } else if (strcmp(argv[i], "--store") == 0 && hasValue) {
      out.storeDir = argv[i + 1];
      ++i;
    } else {
      return false;
    }
  }
  return true;
}

void usage() {
  printf("usage: simulator [--port N] [--bind-all] [--start-ms MS] [--store DIR]\n"
         "  --port      TCP port on 127.0.0.1 for the bridge link (0 = pick one)\n"
         "  --bind-all  listen on every interface. CONTAINERS ONLY -- a simulated\n"
         "              relay controller on a LAN is one anything can switch on.\n"
         "  --start-ms  what the millis() clock reads at launch; 4294963200\n"
         "              puts the 49.7-day rollover four seconds from now\n"
         "  --store     directory for the persisted key/value store\n"
         "console: 'scan <code>', 'btn <A-D|1-4>', 'quit'\n");
}

/// The console's own vocabulary. Deliberately not the wire protocol: a person
/// driving this by hand wants "scan MEM-0042", and a harness that wants to send
/// a real frame has the socket for it.
void handleCommand(const char* line, posix_hal::ConsoleScanner& scanner, posix_hal::ConsoleButtons& buttons) {
  if (strcmp(line, "quit") == 0) {
    gStopRequested = 1;
    return;
  }
  if (strncmp(line, "scan ", 5U) == 0) {
    scanner.feedLine(line + 5);
    return;
  }
  if (strncmp(line, "btn ", 4U) == 0) {
    const char key = line[4];
    proto::Key parsed = proto::Key::CourtA;
    if (proto::keyFromChar(key, parsed)) {
      buttons.press(static_cast<uint8_t>(parsed));
    } else {
      printf("[sim] not a button: %c (expected A-D or 1-4)\n", key);
    }
    return;
  }
  printf("[sim] unknown command: %s\n", line);
}

void idle() {
  timespec ts;
  ts.tv_sec = 0;
  ts.tv_nsec = kIdleNs;
  static_cast<void>(nanosleep(&ts, nullptr));
}

} // namespace

int main(int argc, char** argv) {
  Options options;
  if (!parseOptions(argc, argv, options)) {
    usage();
    return 2;
  }

  // Ports first, then the box that borrows them; same order as the firmware's
  // composition root, and for the same reason.
  posix_hal::PosixClock clock(options.startMs);
  posix_hal::ConsoleRelay relay(hal::relayPolarityFor(RELAY_ACTIVE_LOW != 0));
  posix_hal::ConsoleDisplay display;
  posix_hal::ConsoleScanner scanner;
  posix_hal::ConsoleButtons buttons(clock);
  posix_hal::TcpTransport bridge;
  posix_hal::FileStore store;
  posix_hal::StdinLines console;

  if (!bridge.listen(options.port, options.bindAll)) {
    fprintf(stderr, "[sim] cannot listen on 127.0.0.1:%u\n", static_cast<unsigned>(options.port));
    return 1;
  }
  if (!store.begin(options.storeDir)) {
    fprintf(stderr, "[sim] cannot use store directory %s\n", options.storeDir);
    return 1;
  }
  static_cast<void>(console.begin());

  // First line of stdout, always, so a harness can read the port back when it
  // asked for 0.
  printf("[sim] listening on 127.0.0.1:%u\n", static_cast<unsigned>(bridge.boundPort()));
  printf("[sim] clock starts at %lu ms\n", static_cast<unsigned long>(options.startMs));
  static_cast<void>(fflush(stdout));

  static_cast<void>(signal(SIGINT, onSignal));
  static_cast<void>(signal(SIGTERM, onSignal));

  // LegacyDialect::Accept, explicitly: the simulator is the bench, and the one
  // place a legacy-dialect bridge is still met. The production Mega refuses it.
  courtlogic::CourtBox box(courtlogic::CourtPorts{relay, display, scanner, buttons, bridge, clock},
                           proto::LegacyDialect::Accept);
  box.boot(0x01U); // a power-on reset, as the Mega reports it in !BOOT

  while (gStopRequested == 0) {
    bridge.acceptPending();
    box.poll();
    while (console.poll()) {
      handleCommand(console.line(), scanner, buttons);
    }
    idle();
  }

  // Dark on the way out. A simulator that left its "relays" believing they were
  // closed would hand the next run a state the hardware cannot be in, and it is
  // the one habit this whole system is built around.
  relay.allOff();
  printf("[sim] stopped\n");
  return 0;
}
