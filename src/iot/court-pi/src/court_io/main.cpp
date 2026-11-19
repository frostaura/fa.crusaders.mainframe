// Crusaders Mainframe — court-io: the Mega's half of the court box, on a Pi.
//
// WHAT THIS IS
// ------------
// The SAME courtlogic::CourtBox the ATmega2560 runs — relay guard and its
// independent 90-minute cap, button panel and debounce, scan assembler with
// baud auto-detect, the landing screen and every screen deadline, the self-
// healing glass, the v3 serial protocol — composed with linux_hal in place of
// arduino_hal. Nothing in courtlogic/ or protocol/ is changed or forked; this
// file is the Pi's composition root, as court_mega/main.cpp is the Mega's.
//
// WHY IT IS ITS OWN PROCESS
// -------------------------
// The court box's founding rule is that the half holding the relays must keep
// working when the half holding the network does not. On the Mega + ESP that
// was two chips. On the Pi it is two processes with no shared memory, joined
// only by the protocol on a Unix socket: court-brain can crash, hang in an HTTP
// call or be restarted mid-game and court-io still times every court out, still
// paints the landing and still answers the panel. Behind court-io itself:
//   * systemd WatchdogSec=2 — a pass of this loop that does not return kills
//     and restarts it (the Mega's 2 s WDT), and ExecStopPost runs
//     `court-io --release`, which drives every relay line to an input first;
//   * the SoC hardware watchdog (RuntimeWatchdogSec=15 in system.conf) — a hung
//     kernel resets the board, and from reset the SoC pulls every relay GPIO
//     down;
//   * the external pull-down on every relay buffer input — a Pi with no
//     software running at all holds every court dark.
//
// MODES
// -----
//   court-io                 the box: GPIO, I2C LCD, UART scanner
//   court-io --bench         console ports (posix_hal) — the box on a laptop:
//                            'scan <code>', 'btn <A-D|1-4>', 'quit' on stdin
//   court-io --release       every relay line an input, then exit (ExecStopPost)

#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include "hal/Relay.h"

#include "courtlogic/CourtBox.h"
#include "linux_hal/GpioButtons.h"
#include "linux_hal/GpioChip.h"
#include "linux_hal/GpioRelay.h"
#include "linux_hal/I2cLcd.h"
#include "linux_hal/PiPins.h"
#include "linux_hal/Service.h"
#include "linux_hal/UartScanner.h"
#include "linux_hal/UnixLink.h"
#include "posix_hal/ConsoleButtons.h"
#include "posix_hal/ConsoleDisplay.h"
#include "posix_hal/ConsoleRelay.h"
#include "posix_hal/ConsoleScanner.h"
#include "posix_hal/PosixClock.h"
#include "posix_hal/StdinLines.h"
#include "protocol/Protocol.h"

#ifndef RELAY_ACTIVE_LOW
#error "RELAY_ACTIVE_LOW is not defined — CMakeLists.txt sets the Mega's value (0 = active HIGH)"
#endif

namespace {

/// MCUSR bits the bridge decodes from !BOOT (court_mega reports the AVR's own).
constexpr uint8_t kPowerOnReset = 0x01U;
constexpr uint8_t kWatchdogReset = 0x08U;

/// The scanner's boot baud; ScanAssembler auto-detects from here (HW-5).
constexpr uint32_t kScannerBaud = 9600U;

volatile sig_atomic_t gStop = 0;

void onSignal(int) {
  gStop = 1;
}

struct Options {
  const char* chip = nullptr;
  const char* i2c = linux_hal::kDefaultI2cBus;
  const char* scanner = linux_hal::kDefaultScannerTty;
  const char* link = linux_hal::kDefaultLinkSocket;
  const char* runDir = "/run/court-box";
  bool bench = false;
  bool release = false;
};

void usage() {
  printf("usage: court-io [--bench | --release] [--gpiochip PATH] [--i2c PATH]\n"
         "                [--scanner TTY] [--link SOCKET] [--run-dir DIR]\n");
}

bool parse(int argc, char** argv, Options& o) {
  for (int i = 1; i < argc; ++i) {
    const bool more = i + 1 < argc;
    if (strcmp(argv[i], "--bench") == 0) {
      o.bench = true;
    } else if (strcmp(argv[i], "--release") == 0) {
      o.release = true;
    } else if (strcmp(argv[i], "--gpiochip") == 0 && more) {
      o.chip = argv[++i];
    } else if (strcmp(argv[i], "--i2c") == 0 && more) {
      o.i2c = argv[++i];
    } else if (strcmp(argv[i], "--scanner") == 0 && more) {
      o.scanner = argv[++i];
    } else if (strcmp(argv[i], "--link") == 0 && more) {
      o.link = argv[++i];
    } else if (strcmp(argv[i], "--run-dir") == 0 && more) {
      o.runDir = argv[++i];
    } else {
      return false;
    }
  }
  return true;
}

void idle() {
  // The Mega's loop never sleeps; this one shares a CPU with court-brain and the
  // kernel. One millisecond is two orders of magnitude finer than the shortest
  // deadline in the protocol and far finer than the 20 ms button debounce.
  timespec ts = {0, 1000000L};
  static_cast<void>(nanosleep(&ts, nullptr));
}

uint8_t resetCause(const Options& o) {
  char marker[192];
  snprintf(marker, sizeof(marker), "%s/court-io.started", o.runDir);
  static_cast<void>(linux_hal::ensureDir(o.runDir));
  return linux_hal::bootCause(marker) == linux_hal::BootCause::PowerOn ? kPowerOnReset : kWatchdogReset;
}

/// The serve loop, shared by the box and the bench.
void serve(courtlogic::CourtBox& box, linux_hal::UnixLinkServer& link, hal::IRelayPort& relay,
           posix_hal::StdinLines* console, posix_hal::ConsoleScanner* scanner,
           posix_hal::ConsoleButtons* buttons) {
  linux_hal::notify("READY=1");
  while (gStop == 0) {
    linux_hal::kickWatchdog();
    link.acceptPending();
    box.poll();
    while (console != nullptr && console->poll()) {
      const char* line = console->line();
      if (strcmp(line, "quit") == 0) {
        gStop = 1;
      } else if (strncmp(line, "scan ", 5U) == 0 && scanner != nullptr) {
        scanner->feedLine(line + 5);
      } else if (strncmp(line, "btn ", 4U) == 0 && buttons != nullptr) {
        proto::Key key = proto::Key::CourtA;
        if (proto::keyFromChar(line[4], key)) {
          buttons->press(static_cast<uint8_t>(key));
        }
      }
    }
    idle();
  }
  relay.allOff(); // dark on the way out, before anything else
  linux_hal::notify("STOPPING=1");
}

courtlogic::CourtBox* gBox = nullptr;

void sampleButtonsWhilePainting(void*) {
  if (gBox != nullptr) {
    gBox->sampleButtons();
  }
}

int runBench(const Options& o) {
  posix_hal::PosixClock clock(0U);
  posix_hal::ConsoleRelay relay(hal::relayPolarityFor(RELAY_ACTIVE_LOW != 0));
  posix_hal::ConsoleDisplay display;
  posix_hal::ConsoleScanner scanner;
  posix_hal::ConsoleButtons buttons(clock);
  linux_hal::UnixLinkServer link;
  posix_hal::StdinLines console;
  static_cast<void>(linux_hal::ensureDir(o.runDir));
  if (!link.listen(o.link)) {
    fprintf(stderr, "[court-io] cannot listen on %s\n", o.link);
    return 1;
  }
  static_cast<void>(console.begin());
  printf("[court-io] bench: link %s — 'scan <code>', 'btn <A-D|1-4>', 'quit'\n", o.link);
  fflush(stdout);
  courtlogic::CourtBox box(courtlogic::CourtPorts{relay, display, scanner, buttons, link, clock},
                           proto::LegacyDialect::Refuse);
  box.boot(resetCause(o));
  serve(box, link, relay, &console, &scanner, &buttons);
  return 0;
}

int runBox(const Options& o) {
  char label[40] = {};
  const int chip = linux_hal::openPiGpioChip(o.chip, label, sizeof(label));
  if (chip < 0) {
    fprintf(stderr, "[court-io] no Raspberry Pi GPIO chip found (pass --gpiochip)\n");
    return 1;
  }
  posix_hal::PosixClock clock(0U);
  linux_hal::GpioRelay relay(hal::relayPolarityFor(RELAY_ACTIVE_LOW != 0));
  // Relays FIRST, released, before anything else can fail: the order of
  // court_mega's setup() and for the same reason.
  if (!relay.begin(chip)) {
    fprintf(stderr, "[court-io] cannot claim the relay lines on %s — refusing to run\n", label);
    return 1;
  }
  linux_hal::GpioButtons buttons(clock);
  if (!buttons.begin(chip)) {
    fprintf(stderr, "[court-io] cannot claim the button lines on %s — refusing to run\n", label);
    return 1;
  }
  linux_hal::UartScanner scanner;
  if (!scanner.begin(o.scanner, kScannerBaud)) {
    // Not fatal: a box with no scanner still times courts out and still takes
    // PINs from nobody. The bridge reports the silence.
    fprintf(stderr, "[court-io] scanner %s not available — continuing without it\n", o.scanner);
  }
  linux_hal::I2cLcd display;
  display.setIdleHook(sampleButtonsWhilePainting, nullptr);
  linux_hal::UnixLinkServer link;
  static_cast<void>(linux_hal::ensureDir(o.runDir));
  if (!link.listen(o.link)) {
    fprintf(stderr, "[court-io] cannot listen on %s\n", o.link);
    return 1;
  }
  courtlogic::CourtBox box(courtlogic::CourtPorts{relay, display, scanner, buttons, link, clock},
                           proto::LegacyDialect::Refuse);
  gBox = &box;
  box.boot(resetCause(o));
  if (!display.begin(o.i2c)) {
    fprintf(stderr, "[court-io] I2C bus %s not available — the glass stays dark\n", o.i2c);
  }
  printf("[court-io] up: gpio %s, lcd 0x%02x, scanner %s, link %s\n", label, display.address(), o.scanner,
         o.link);
  fflush(stdout);
  serve(box, link, relay, nullptr, nullptr, nullptr);
  gBox = nullptr;
  return 0; // serve() left every relay an input; systemd's ExecStopPost re-asserts it
}

int runRelease(const Options& o) {
  const int chip = linux_hal::openPiGpioChip(o.chip, nullptr, 0U);
  if (chip < 0) {
    return 1;
  }
  return linux_hal::GpioRelay::releaseAll(chip) ? 0 : 1;
}

} // namespace

int main(int argc, char** argv) {
  Options o;
  if (!parse(argc, argv, o)) {
    usage();
    return 2;
  }
  if (o.release) {
    return runRelease(o);
  }
  static_cast<void>(signal(SIGINT, onSignal));
  static_cast<void>(signal(SIGTERM, onSignal));
  static_cast<void>(signal(SIGPIPE, SIG_IGN));
  return o.bench ? runBench(o) : runBox(o);
}
