// Crusaders Mainframe — the door gate's real drivers.
//
// THE ONLY PLACE IN THIS PROJECT'S lib/ ALLOWED TO INCLUDE ARDUINO HEADERS.
// Everything else under lib/ compiles for the host test runner, which is what
// lets `pio test -e native` prove every decision with no board attached. CI
// greps for the rule over every project's lib/ at once and excludes exactly
// three directory names — arduino_hal, posix_hal and this one.
//
// Nothing here decides anything. Each class is the thinnest possible bridge
// between one pure port and one ESP32 peripheral: a clock read, a pin, a UART,
// an NVS namespace, an HTTP POST, a watchdog. A driver that grew an `if` about
// a member, a booking or a door would be a decision no host test could reach.
//
// One header for all six, unlike the court box's directory of them. There are
// six short classes, they are all constructed in the same twenty lines of
// main.cpp, and splitting them would be six files of #include guards around an
// average of fifteen lines of body.

#ifndef CRUSADERS_ESP32_HAL_ESP32HAL_H
#define CRUSADERS_ESP32_HAL_ESP32HAL_H

#include <stddef.h>
#include <stdint.h>

#include "hal/Clock.h"
#include "hal/PinLevel.h"
#include "hal/Store.h"

#include "gatelogic/GatePorts.h"
#include "gatelogic/HttpPort.h"
#include "gatelogic/PinOut.h"

namespace esp32_hal {

/// hal::IClock on millis().
///
/// Nothing here wraps or corrects anything: millis() rolls over at 2^32 and
/// this port hands that value up unaltered, because tb::reached() and
/// tb::Deadline are correct across the wrap and a second correction layer here
/// would be a second implementation that can disagree with them.
class Esp32Clock final : public hal::IClock {
public:
  uint32_t nowMs() override;
};

/// One GPIO, as an output — with the level written before the pin drives it.
///
/// See gatelogic/PinOut.h for why those are two calls. In short: a GPIO leaves
/// reset as an input, and `pinMode(OUTPUT)` starts driving whatever is already
/// in the output register, which on a cold boot is LOW. On Carl's wiring LOW is
/// "locked", but on a board wired the other way it is "released" — and a door
/// that clicks open on every reset, including the 3am watchdog ones, is a
/// security hole nobody is awake to see.
class Esp32PinOut final : public gatelogic::IPinOut {
public:
  explicit Esp32PinOut(uint8_t pin) : pin_(pin) {}

  void write(hal::PinLevel level) override;
  void driveOutput() override;

  hal::PinLevel readBack() const override { return level_; }

private:
  uint8_t pin_;
  hal::PinLevel level_ = hal::PinLevel::kLow;
};

/// gatelogic::IScannerBytes on Serial2.
///
/// Byte at a time and never blocking, for the reason hal/Scanner.h gives: the
/// same loop that would be blocked also runs the release deadline and feeds the
/// watchdog. The scanner only ever talks — TX is wired and unused — so nothing
/// here writes to the port.
///
/// TWO THINGS begin() DOES THAT ARE NOT "OPEN THE PORT", AND BOTH MUST HAPPEN
/// BEFORE IT
/// -------------------------------------------------------------------------
/// `setRxBufferSize` and `onReceiveError` are both ignored once the driver has
/// been installed, so the order in the body is load-bearing rather than
/// stylistic.
///
///   * the buffer, because the core's default is 256 bytes — 267 ms of
///     line-rate data at 9600 baud — and the loop can be inside a blocking HTTP
///     call for `kWorstBlockingCallMs`. A member holding a phone at the reader
///     produces a repeated line every few hundred milliseconds throughout, so
///     the default overruns in ordinary service;
///   * the error callback, because an overrun is SILENT. The driver drops what
///     did not fit and hands up the rest, in order and printable, with a hole
///     in the middle. The assembler trims it, finds it inside the token cap and
///     emits it as a token nobody scanned.
class Esp32Scanner final : public gatelogic::IScannerBytes {
public:
  /// Opens Serial2 at `baud`, 8N1, on the configured pins, with the receive
  /// buffer sized and the error callback installed first.
  void begin(uint32_t baud, uint8_t rxPin, uint8_t txPin);

  bool read(uint8_t& out) override;

  bool takeRxError() override;
};

/// hal::IStore on NVS, through Preferences.
///
/// ONE record: the event queue's sequence high-water mark. The API deduplicates
/// events on `(tenant, device, seq)` with a permanent unique index, so a board
/// that restarted its numbering at 1 after a power cut would have every event
/// up to its previous high-water silently discarded as a duplicate — and for a
/// door that is an evening of entries the club never learns about.
///
/// NVS rather than a filesystem because that is one record in a partition the
/// bootloader already creates, against a whole LittleFS image for ten bytes.
class Esp32NvsStore final : public hal::IStore {
public:
  /// Opens the namespace read/write. False when NVS itself will not initialise,
  /// which is a board that cannot remember its sequence across a power cut —
  /// worth reporting rather than discovering at the first put().
  bool begin();

  hal::StoreResult put(const char* key, const uint8_t* value, uint8_t len) override;
  hal::StoreResult get(const char* key, uint8_t* out, uint8_t cap, uint8_t& outLen) override;
  hal::StoreResult erase(const char* key) override;

private:
  bool ready_ = false;
};

/// gatelogic::IHttpPort on HTTPClient.
///
/// Blocking, bounded by a deadline, and reading the response into the caller's
/// buffer rather than a String.
///
/// IT USED TO SAY THAT AND CALL `http.getString()`, which heap-allocates the
/// WHOLE body — sized by whatever the peer chooses to send — before any of the
/// caller's bounds are applied, and then truncated it into `out` and handed the
/// result up with a 200 on it. The ESP32's heap is shared with the network
/// stack, and `{"opened":true,` cut after the comma is a door that opens. The
/// body is read a byte at a time into the caller's buffer now, through
/// `gatelogic::readBody`, which is pure and host-tested; a body that does not
/// fit or does not arrive is reported as status 0 — a transport failure, which
/// sends a scan to the roster — and never as a short body.
class Esp32HttpPort final : public gatelogic::IHttpPort {
public:
  /// `baseUrl` and `authorization` are compiled-in and outlive every call; they
  /// are held by pointer rather than copied for that reason.
  ///
  /// The two timeouts are SEPARATE because the core applies them separately —
  /// one bounds the TCP connect, the other bounds waiting for bytes — and a
  /// call can spend both. `gatelogic::kWorstBlockingCallMs` is their sum.
  ///
  /// The CLOCK is here because the body phase takes an absolute deadline
  /// computed from the instant the whole call started: `setTimeout` is an
  /// inter-byte timeout and a peer that dribbles resets it on every byte, so a
  /// body read bounded by it is not bounded at all.
  ///
  /// WHAT IS STILL NOT BOUNDED: HTTPClient's own header loop, inside `POST()`,
  /// uses that same inter-byte timeout and cannot be interrupted from here. A
  /// peer that dribbles HEADERS can hold one call past kWorstBlockingCallMs.
  /// That case is the watchdog's, deliberately, and it is the one precondition
  /// on the release-overrun bound in `gatelogic/GateApp.h`.
  Esp32HttpPort(const char* baseUrl, const char* authorization, hal::IClock& clock)
      : baseUrl_(baseUrl), authorization_(authorization), clock_(clock) {}

  uint16_t post(const char* path, const char* body, char* out, size_t outCap) override;

private:
  const char* baseUrl_;
  const char* authorization_;
  hal::IClock& clock_;
};

/// gatelogic::ILink on WiFi.status().
class Esp32Link final : public gatelogic::ILink {
public:
  bool up() override;
};

/// The ESP32 task watchdog, on the loop task.
///
/// What it is behind: this board's only safety-critical loop obligation is that
/// the release deadline is checked every pass. Anything that stops loop()
/// returning — a driver spinning on a peripheral, a network call that never
/// gives up — stops the lock being taken back, with the door open. A reset
/// re-runs setup(), which asserts LOCKED before the pin is an output.
class Esp32Watchdog final : public gatelogic::IWatchdog {
public:
  /// Configure the TWDT for `seconds` and subscribe the loop task.
  ///
  /// RETURNS WHETHER IT ACTUALLY TOOK. The Arduino core initialises the TWDT
  /// itself, at `CONFIG_ESP_TASK_WDT_TIMEOUT_S` (5 s), before setup() runs —
  /// so this call is a RECONFIGURATION, not an initialisation. IDF 4.4's
  /// `esp_task_wdt_init` documents exactly that ("if the TWDT is already
  /// initialized ... this function will update the TWDT's timeout period and
  /// panic configurations instead") and returns ESP_OK, which is what makes
  /// `GateConfig.h`'s watchdog assert a statement about the real timeout rather
  /// than about an intention. The return value is checked rather than assumed
  /// because "the watchdog is eight seconds" was assumed once already and the
  /// effective value was five.
  ///
  /// RETRIED, kMaxArmAttempts times, before it gives up. The TWDT is shared
  /// state the core set up on another task's schedule, and a single refusal is
  /// not evidence that it will refuse again — a board that accepted one and ran
  /// for a season under the core's five seconds is a board whose watchdog
  /// assert was about an intention.
  ///
  /// False means the board is running under a watchdog it did not choose. It is
  /// reported on the boot log line AND, for as long as it is false, by the
  /// lamp's 4 Hz fault blink — the boot log has scrolled past by the time
  /// anybody is standing at the door. The DOOR is unaffected: refusing to open
  /// for a missing watchdog would be a door that admits nobody, which is far
  /// worse than one running on five seconds instead of twelve.
  bool begin(uint8_t seconds);

  /// How many times begin() asks before reporting failure.
  static constexpr uint8_t kMaxArmAttempts = 3U;

  /// Restart the countdown. From the orchestration and never from inside a
  /// driver, where it would hide the stall it exists to end.
  void kick() override;
};

} // namespace esp32_hal

#endif // CRUSADERS_ESP32_HAL_ESP32HAL_H
