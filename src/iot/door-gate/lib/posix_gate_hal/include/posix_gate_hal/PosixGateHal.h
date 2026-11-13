// Crusaders Mainframe — the door gate's HOST drivers, for the native simulator.
//
// WHAT THIS IS AND WHAT IT IS NOT
// -------------------------------
// `esp32_hal` is the same six classes against an ESP32. This is the same six
// against a POSIX host, so `src/simulator/main.cpp` can run the REAL
// `gatelogic` — the same GateApp loop, the same GateApi, the same GateFlow
// status table, the same ResponseBody framing and de-chunking, the same
// UnlockTimer and LockDriver — with no board attached and a REAL socket to a
// REAL API on the other end.
//
// The court box's simulator has said for as long as it has existed why that is
// worth having: a stub in the test project only ever agrees with itself,
// because both ends are written from one reading of the spec, so a misreading
// passes. The door's harness had exactly that shape until this existed — a
// Python script played the whole board — and the class of defect it cannot see
// is the class round G3 found on the court side and round G1 found in this
// project's own `loop()`.
//
// NOTHING HERE DECIDES ANYTHING, and that rule is the whole value of the
// binary. Each class is the thinnest possible bridge between one pure port and
// one host facility. A driver that grew an `if` about a member, a booking or a
// door would be a decision the host suite cannot reach and the firmware does
// not make.
//
// WHY THE GATE'S PORTS ARE NOT IN shared/lib/posix_hal
// ----------------------------------------------------
// `shared/lib/posix_hal` implements the ports in `shared/lib/hal` — the clock,
// the store, the relay, the display, the buttons, the scanner, the transport —
// and both simulators use it for exactly those. The five ports below are
// `gatelogic`'s own (`IPinOut`, `IScannerBytes`, `ILink`, `IWatchdog`,
// `IHttpPort`, `IDecisionLog`), and shared code may never include a device
// project's headers. So the clock, the store and the console line reader come
// from there; these come from here.
//
// THIS DIRECTORY MAY NEVER REACH A BOARD. It is in `FORBIDDEN_LIBS` in
// `src/iot/tools/arduino_export.py` and in all three purity-exclusion lists
// (the Makefile's `lint-iot`, `ci.yml`'s purity step, `strict_compile.sh`),
// because it includes POSIX headers by design.

#ifndef CRUSADERS_POSIX_GATE_HAL_POSIXGATEHAL_H
#define CRUSADERS_POSIX_GATE_HAL_POSIXGATEHAL_H

#include <stddef.h>
#include <stdint.h>

#include "hal/Clock.h"
#include "hal/PinLevel.h"

#include "gatelogic/GateFlow.h"
#include "gatelogic/GateHeartbeat.h"
#include "gatelogic/GatePorts.h"
#include "gatelogic/GateStore.h"
#include "gatelogic/HttpPort.h"
#include "gatelogic/PinOut.h"

namespace posix_gate_hal {

/// One output pin, printed as the thing it drives.
///
/// The simulator has no coil and no lamp, so the only thing this can do is SAY
/// what the driver put on the pin — and it prints BOTH halves, the logical
/// state and the electrical level, for the same reason `posix_hal::ConsoleRelay`
/// does: the transcript is one of the very few places a person ever reads the
/// polarity mapping back.
///
/// `onLevel` is computed by the composition root from the REAL
/// `gatelogic::lockPinLevel` / `gatelogic::ledPinLevel`, never written out
/// here, so a change to either polarity function shows up in this transcript
/// rather than being restated somewhere it can disagree.
///
/// A transition is printed ONCE. `LockDriver::set` is idempotent and writes the
/// level on every call by design — the only thing that could have changed the
/// pin is something nobody here can see — and echoing every identical write
/// would bury the two lines that matter under a pass-rate stream.
class ConsolePinOut final : public gatelogic::IPinOut {
public:
  /// `label` is printed in brackets ("relay", "led"). `onLevel` is the
  /// electrical level that means the thing is ON.
  ConsolePinOut(const char* label, hal::PinLevel onLevel, hal::IClock& clock);

  void write(hal::PinLevel level) override;
  void driveOutput() override;

  hal::PinLevel readBack() const override { return level_; }

  /// Whether the pin is currently driving. Before this, a write lands in the
  /// output register and drives nothing — which is the boot-safety property
  /// `gatelogic/PinOut.h` exists for, and the transcript says which side of it
  /// each line is on.
  bool driving() const { return driving_; }

private:
  void report();

  const char* label_;
  hal::PinLevel onLevel_;
  hal::IClock& clock_;
  hal::PinLevel level_ = hal::PinLevel::kLow;
  bool driving_ = false;
  bool announced_ = false;
  bool wasOn_ = false;
};

/// `gatelogic::IScannerBytes` fed from the simulator's console.
///
/// A scan is a line somebody types or a harness pipes in. The bytes go into a
/// queue and come out ONE AT A TIME, exactly as they arrive from a 9600 baud
/// module, so the real `ScanAssembler` does the same line assembly here as on
/// the board — including a line split across two passes of the loop.
///
/// Byte-clean: `feedByte(0x00)` is delivered like any other value, because
/// `hal/Scanner.h` requires it and because a NUL in the payload is exactly the
/// corruption a TTL line beside a switching relay coil produces.
///
/// It carries the UART ERROR SIGNAL too, which is the whole reason this is not
/// `posix_hal::ConsoleScanner`: `IScannerBytes` adds `takeRxError()`, and an
/// overrun is the silent failure that hands a holed line up as somebody else's
/// token. `injectRxError()` is how the console provokes it.
class ConsoleScanner final : public gatelogic::IScannerBytes {
public:
  /// Room for several codes and their terminators.
  static constexpr uint16_t kCapacity = 512U;

  ConsoleScanner();

  bool read(uint8_t& out) override;

  bool takeRxError() override;

  /// Queue one byte. The OLDEST is dropped when the buffer is full — a
  /// simulator that stopped accepting input would look like a hung device — and
  /// the drop is counted.
  bool feedByte(uint8_t value);

  /// Queue a NUL-terminated string followed by '\n', which is what presenting a
  /// phone to the module looks like.
  void feedLine(const char* text);

  /// Raise the driver's error flag, as a receive-FIFO overrun does. Collapsed
  /// to a flag and cleared by reading, exactly as `Esp32Scanner` does.
  void injectRxError() { rxError_ = true; }

  uint32_t droppedBytes() const { return dropped_; }

private:
  uint8_t buf_[kCapacity];
  uint16_t head_;
  uint16_t len_;
  uint32_t dropped_;
  bool rxError_;
};

/// `gatelogic::ILink` — the radio, as the console says it is.
///
/// The simulator's socket is always there, so "the radio went away" has to be
/// SAID rather than sensed. It is the one input that decides between asking the
/// API and asking the cached roster, and the harness needs to drive it: a
/// door's offline behaviour is not reachable any other way without unplugging
/// something.
class ConsoleLink final : public gatelogic::ILink {
public:
  explicit ConsoleLink(hal::IClock& clock) : clock_(clock) {}

  bool up() override { return up_; }

  /// Prints the edge, so the transcript carries the input every decision below
  /// it was made against.
  void set(bool up);

private:
  hal::IClock& clock_;
  bool up_ = true;
  bool announced_ = false;
};

/// The task watchdog, as a REPORTER rather than a resetter.
///
/// A host process has no TWDT, and faking one that killed the simulator would
/// make an unrelated stall look like a crash with no transcript. What matters
/// is the RELATION the board is built on — the countdown never runs longer than
/// one worst-case blocking call — so this measures the gap between kicks and
/// prints a line the moment one exceeds the configured period. On the board
/// that line is a reset.
///
/// It is the simulator's own instrument and decides nothing: `GateApp` calls
/// `kick()` and gets the same nothing back that `esp_task_wdt_reset()` gives
/// it.
class ConsoleWatchdog final : public gatelogic::IWatchdog {
public:
  ConsoleWatchdog(uint8_t seconds, hal::IClock& clock) : clock_(clock), periodMs_(seconds * 1000UL) {}

  void kick() override;

  /// The longest interval between two kicks so far, in milliseconds. What the
  /// TWDT would have been counting.
  uint32_t worstGapMs() const { return worstGapMs_; }

  /// Intervals that exceeded the period. Non-zero means this firmware would
  /// have reset on real hardware.
  uint32_t breaches() const { return breaches_; }

private:
  hal::IClock& clock_;
  uint32_t periodMs_;
  uint32_t lastKickMs_ = 0U;
  uint32_t worstGapMs_ = 0U;
  uint32_t breaches_ = 0U;
  bool seeded_ = false;
};

/// `gatelogic::IHttpPort` over a real BSD socket.
///
/// AS THIN AS `Esp32HttpPort`, AND BOUNDED BY THE SAME THREE NUMBERS. The TCP
/// connect is bounded by `gatelogic::kHttpConnectTimeoutMs`, the status line
/// and headers by `kHttpResponseTimeoutMs`, and the body by
/// `kHttpBodyBudgetMs` — sampled AFTER the headers return, as an absolute
/// deadline, through the REAL `gatelogic::readBody`. Their sum is
/// `kWorstBlockingCallMs`, which is the number the watchdog period, the release
/// overrun bound and the scanner buffer are all derived from, so a measurement
/// taken here is a measurement of the board's own budget.
///
/// THE FRAMING IS AN INPUT, NOT A GUESS, and it is decided by the same
/// `gatelogic::frameFromHeaders` the ESP32 port calls, from the same two facts:
/// a `Content-Length` if there is one, and whether `Transfer-Encoding` names
/// the chunked coding. That is the round-G3 critical, and asking for HTTP/1.0
/// with `Connection: close` — which this port does, exactly as `useHTTP10(true)`
/// + `setReuse(false)` does on the board — is the belt half of it.
///
/// WHAT IS DELIBERATELY NOT REPRODUCED. `HTTPClient`'s own header loop is an
/// INTER-BYTE timeout a dribbling peer resets for ever, and there is no way to
/// interrupt it from inside the ESP32 driver. This port's header phase takes an
/// ABSOLUTE deadline instead, because a host socket can have one. So the
/// simulator is very slightly SAFER than the board on that one path, and the
/// difference is stated rather than glossed: the unbounded-header case remains
/// the watchdog's, on the hardware, and is the one precondition on the release
/// overrun bound in `gatelogic/GateApp.h`.
class SocketHttpPort final : public gatelogic::IHttpPort {
public:
  /// `baseUrl` and `authorization` outlive every call and are held by pointer,
  /// exactly as on the board. `baseUrl` must satisfy
  /// `gatelogic::isValidApiBaseUrl`; the composition root checks it, because
  /// the board checks it at COMPILE time and a simulator that accepted a URL
  /// the firmware would refuse would be testing a different firmware.
  SocketHttpPort(const char* baseUrl, const char* authorization, hal::IClock& clock)
      : baseUrl_(baseUrl), authorization_(authorization), clock_(clock) {}

  gatelogic::HttpOutcome post(const char* path, const char* body, char* out, size_t outCap) override;

  /// READ THE HEADERS THE WAY THE BOARD DOES: an INTER-BYTE timeout, re-armed
  /// on every byte, rather than the absolute deadline this port uses by
  /// default.
  ///
  /// It makes the simulator WORSE, deliberately, and that is round G4's A4.
  /// `HTTPClient::setTimeout` is inter-byte and `POST()` cannot be interrupted,
  /// so a peer sending one header byte every three seconds holds one blocking
  /// call open for ever on the hardware — past `kWorstBlockingCallMs`, past the
  /// watchdog, which then resets the part. This port's absolute deadline means
  /// the simulator could never show that, so the one unbounded path in the
  /// firmware was the one path no test vehicle could reach.
  ///
  /// OFF by default, because every other scenario wants the simulator bounded.
  /// `--board-header-timeout` turns it on.
  void useBoardHeaderTimeout(bool on) { boardHeaderTimeout_ = on; }

  /// Calls made, and the longest one in milliseconds. The simulator prints
  /// these; the worst-case measurement in `test/e2e-device/gate_sim.py` reads
  /// them back.
  uint32_t calls() const { return calls_; }

  uint32_t worstCallMs() const { return worstCallMs_; }

private:
  const char* baseUrl_;
  const char* authorization_;
  hal::IClock& clock_;
  uint32_t calls_ = 0U;
  uint32_t worstCallMs_ = 0U;
  bool boardHeaderTimeout_ = false;
};

/// `gatelogic::IDecisionLog` as one line per decision on stdout.
///
/// The reason the port exists at all is in `gatelogic/GatePorts.h`: a refusal
/// reason reaches no surface on the hardware, so a harness watching a relay can
/// prove that a door did not open and nothing about WHY. This prints the reason
/// the board acted on, what the lock was actually given, whether the decision
/// was the API's or the cached roster's, and whether the board has just been
/// told it is out of service.
class ConsoleDecisionLog final : public gatelogic::IDecisionLog {
public:
  void decided(const gatelogic::ScanDecision& decision, const char* token, uint32_t grantedMs,
               uint32_t nowMs) override;

  uint32_t count() const { return count_; }

private:
  uint32_t count_ = 0U;
};

// --- gate 2.0.0 -------------------------------------------------------------

/// Flash records as files, one per key, in the simulator's store directory.
/// Each write lands in a temporary file renamed over the old one, so a killed
/// simulator leaves the previous record or the new one, never half of either —
/// which is what NVS guarantees the board.
class FileBlobs final : public gatelogic::IBlobStore {
public:
  bool begin(const char* dir);
  bool put(const char* key, const void* data, size_t len) override;
  size_t get(const char* key, void* out, size_t cap) override;
  void erase(const char* key) override;

private:
  bool path(const char* key, char* out, size_t cap) const;
  char dir_[256] = {};
};

/// The RTC counter: CLOCK_MONOTONIC, which keeps counting across simulator
/// processes exactly as the ESP32's RTC keeps counting across a warm reset.
class MonotonicRtc final : public gatelogic::IWarmClock {
public:
  uint64_t nowUs() override;
};

/// The radio, on the console: a join is announced (the SSID, never the
/// password) and the link stays as `wifi up|down` left it.
class ConsoleRadio final : public gatelogic::IRadio {
public:
  void join(const char* ssid, const char* psk) override;
  uint32_t joins() const { return joins_; }

private:
  uint32_t joins_ = 0U;
};

/// A restart request: announced, and the simulator exits with kRestartExit so
/// a harness can start the next boot (with --warm, as the board's RTC would).
class ConsoleSystem final : public gatelogic::ISystem {
public:
  static constexpr int kRestartExit = 75;
  void restart() override;
  bool requested() const { return requested_; }

private:
  bool requested_ = false;
};

/// What a simulator honestly knows about its own health: nothing it could
/// measure the way the board does, so fixed, plausible values that say so.
class SimDiag final : public gatelogic::IDiagSource {
public:
  explicit SimDiag(bool warm) : warm_(warm) {}
  void read(gatelogic::GateDiag& out) override;

private:
  bool warm_;
};

} // namespace posix_gate_hal

#endif // CRUSADERS_POSIX_GATE_HAL_POSIXGATEHAL_H
