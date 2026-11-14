// Crusaders Mainframe — the ATmega2560's whole behaviour, above the ports.
//
// WHY THE MEGA'S APPLICATION IS A CLASS IN lib/ AND NOT CODE IN main.cpp
// ----------------------------------------------------------------------
// `pio test -e native` builds lib/ and test/ and nothing else: src/ is
// explicitly filtered out (build_src_filter = -<*>). Behaviour written in
// main.cpp is therefore behaviour no host test can reach — and the behaviour in
// question includes the relay auto-off timer, the authorisation window and
// every frame that turns a court's lights on.
//
// So main.cpp stays what lib/README.md says it is: the only composition root.
// It chooses an ArduinoRelay over a ConsoleRelay and hands the choice here.
// Everything that decides WHAT to do lives in this class, where a FakeClock can
// be put four milliseconds before the 49.7-day wrap and stepped across it.
//
// The simulator gets the same class behind posix_hal, which is what makes it a
// real implementation of the device protocol rather than a second, agreeable
// stub the .NET tests would be testing against themselves.
//
// WHY poll() SAMPLES THE CLOCK EXACTLY ONCE
// -----------------------------------------
// Every sub-step gets the same `now`. Re-reading millis() partway through means
// the button debounce and the relay deadline are evaluated against different
// instants, and the resulting bugs are the kind that only appear when a pass
// happens to straddle a millisecond boundary. fakes::FakeClock counts reads
// precisely so a test can assert this.
//
// WHAT IS DELIBERATELY NOT HERE
// -----------------------------
// No booking logic, no member roster, no minute balance, no HTTP. The Mega does
// not know what a member is and must not learn: it is the half that is never
// reflashed, so anything that will change belongs on the ESP.
//
// No Arduino headers, no heap, no String/std::string/std::vector. This links
// into 8 KB of SRAM, so the encode buffer is a member rather than a local —
// see txBuf_.

#ifndef CRUSADERS_COURTLOGIC_COURTBOX_H
#define CRUSADERS_COURTLOGIC_COURTBOX_H

#include <stddef.h>
#include <stdint.h>

#include "hal/Button.h"
#include "hal/Clock.h"
#include "hal/Display.h"
#include "hal/Relay.h"
#include "hal/Scanner.h"
#include "hal/Transport.h"

#include "courtlogic/AuthWindow.h"
#include "courtlogic/ButtonPanel.h"
#include "courtlogic/MegaSettings.h"
#include "courtlogic/RelayGuard.h"
#include "courtlogic/ScanAssembler.h"
#include "courtlogic/ScannerBaud.h"
#include "courtlogic/ScreenBuffer.h"
#include "protocol/Codec.h"
#include "protocol/Protocol.h"
#include "timebase/TimeBase.h"

namespace courtlogic {

/// `!STATE` is sent on every change AND on this interval, so a bridge that
/// rebooted and missed a change learns the truth within ten seconds without
/// having to ask.
inline constexpr uint32_t kStateIntervalMs = 10000UL;

/// Bytes drained from the bridge link per drain. The Mega drains twice a pass
/// (before and after the budgeted paint), so at 9600 baud fewer than ten bytes
/// ever wait and the 64-byte ring cannot overflow (v3 "The paced sender, and
/// the Mega's pass budget").
inline constexpr uint16_t kBytesPerPass = 64U;

/// Before the bridge has sent any `!LIVE`, it is dead after this much silence:
/// longer than the widest heartbeat cadence, because a 2.3.0 bridge pings once
/// per heartbeat and sends nothing else on a quiet link.
inline constexpr uint32_t kLegacyLivenessMs = 330000UL;

/// The setup gesture's window and the hold that reports it (`!HELD`).
inline constexpr uint32_t kHeldBootWindowMs = 60000UL;
inline constexpr uint32_t kHeldReportSeconds = 5UL;

/// A repeated tag inside this window is a retry whose first copy arrived.
inline constexpr uint32_t kDuplicateWindowMs = 5000UL;

/// The uplink queue. A burst — an `!ACK`, a `!STATE` and an `!EVT` after one
/// `!WANT`, then `!PONG`, `!DIAG` and `!HW` — is larger than the 64-byte UART
/// ring, so frames are queued whole and drained as the ring has room.
inline constexpr uint16_t kTxQueueBytes = 256U;

/// Every port the Mega has, gathered into one argument.
///
/// A struct rather than six constructor parameters, for two reasons. Six is the
/// complexity gate's parameter limit exactly, so the next port to be added
/// would push the constructor over it and force this change anyway. And a
/// designated-initialiser list at the composition root reads as a wiring
/// diagram — one line per peripheral, each labelled — where a six-argument call
/// reads as six anonymous references whose order the reader has to go and look
/// up.
struct CourtPorts {
  hal::IRelayPort& relay;
  hal::IDisplayPort& display;
  hal::IScannerPort& scanner;
  hal::IButtonPort& buttons;
  hal::ITransport& bridge;
  hal::IClock& clock;
};

class CourtBox {
public:
  /// `legacy` is which dialect the downlink decoder honours. The default is
  /// REFUSE: a production Mega takes only checksummed `!` frames, because the
  /// legacy `A` is the one message that closes a relay without a checksum and
  /// the link it arrives on carries the ESP's boot banner at every reset. The
  /// simulator and a bench pairing with the original bridge opt in explicitly.
  explicit CourtBox(const CourtPorts& ports, proto::LegacyDialect legacy = proto::LegacyDialect::Refuse);

  /// Relays open, authorisation disarmed, decoder cleared, landing screen —
  /// what `!RST` means. Settings are NOT reset: they reset only at a Mega
  /// restart, and the bridge re-sends them then.
  void begin();

  /// The Mega's first act after a reset (v3, FWM-01/FWM-12): settings to their
  /// boot defaults, `begin()`, then `!BOOT,<version>,<cause>,<held>` and
  /// `!STATE` queued BEFORE the caller initialises the LCD (whose driver
  /// spends a hundred milliseconds in delays), so the bridge can re-apply its
  /// snapshot within seconds of a Mega-only reset. `resetCause` is MCUSR as
  /// saved before the core cleared it. `!HW` follows on the first poll(),
  /// i.e. once the LCD has been initialised.
  void boot(uint8_t resetCause);

  /// One pass of the main loop. Never blocks, never delays, samples the clock
  /// once. Safe to call as fast as the CPU allows.
  void poll();

  /// Look at the buttons between passes (DL-15): the debounce rule applied to
  /// one more sample, any press it completes latched for the next poll(). The
  /// LCD driver calls this between bus transactions so a pass spent painting
  /// the glass is not a pass in which a tap can come and go unseen. Touches
  /// the button panel and the clock and nothing else, so it is safe from
  /// inside poll()'s own paint.
  void sampleButtons();

  // --- diagnostics ---------------------------------------------------------
  //
  // Counters rather than logs: an 8-bit part has nowhere to keep a log, and the
  // bridge is the thing that might be missing when they matter most.

  /// Frames that could not be queued for the wire (the uplink queue full).
  uint16_t droppedTxFrames() const { return txDropped_; }

  /// Lines from the bridge that did not decode.
  uint16_t rxErrors() const { return rxErrors_; }

  /// Debounced presses discarded because the window was shut and the key's
  /// `KEYS` bit is clear (HW-7).
  uint16_t unauthorisedPresses() const { return unauthorised_; }

  uint16_t oversizeScans() const { return oversizeScans_; }

  uint16_t corruptScans() const { return corruptScans_; }

  const ScreenBuffer& screens() const { return screens_; }

  const MegaSettings& settings() const { return settings_; }

  const ScannerBaud& scannerBaud() const { return baud_; }

  /// The Mega's verdict on the bridge (v3 liveness).
  bool bridgeAlive() const { return bridgeAlive_; }

  uint32_t uptimeSeconds() const { return static_cast<uint32_t>(uptime_.value() / 1000ULL); }

  const RelayGuard& relays() const { return relays_; }

  const AuthWindow& auth() const { return auth_; }

  /// Bytes waiting in the uplink queue.
  uint16_t txQueued() const { return txCount_; }

private:
  // --- one pass ------------------------------------------------------------
  void drainBridge(uint32_t nowMs);
  void drainScanner(uint32_t nowMs);
  void completeScan(uint32_t nowMs);
  void expireScanLine(uint32_t nowMs);
  void pollButtons(uint32_t nowMs);
  void releaseExpired(uint32_t nowMs);
  void watchBridge(uint32_t nowMs);
  void watchHeld(uint32_t nowMs);
  void noteAuthLapse(uint32_t nowMs);
  void reportHardware();
  void publishState(uint32_t nowMs);
  void flushTx();

  // --- inbound -------------------------------------------------------------
  void handleResult(const proto::Decoder::Result& result, uint32_t nowMs);
  void handleFrame(const proto::Frame& frame, uint32_t nowMs);
  void handleV3Frame(const proto::Frame& frame, uint32_t nowMs);
  void reportDecodeError(proto::DecodeError error);
  void applyOn(const proto::Frame& frame, uint32_t nowMs);
  void applyOff(const proto::Frame& frame, uint32_t nowMs);
  void applyExt(const proto::Frame& frame, uint32_t nowMs);
  void applyAuth(const proto::Frame& frame, uint32_t nowMs);
  void applyScreen(const proto::Frame& frame, uint32_t nowMs);
  void applyV3Screen(const proto::Frame& frame, uint32_t nowMs);
  void applyWant(const proto::Frame& frame, uint32_t nowMs);
  void applyCfg(const proto::Frame& frame);
  void applySideEffects(Cfg key);
  void answerPing();
  /// A tagged frame for `slot` (relay 0-3, or kAuthSlot): true when it is a
  /// repeat of the tag last applied there, already answered `!ACK,<tag>,1`.
  bool duplicate(uint8_t slot, uint8_t tag, uint32_t nowMs);
  void remember(uint8_t slot, uint8_t tag, uint32_t nowMs);
  void ack(uint8_t tag, proto::AckCode code);
  bool courtOf(const proto::Frame& frame, uint8_t& channel);

  // --- outbound ------------------------------------------------------------

  /// The whole encoded frame into the uplink queue, or nothing (counted).
  bool sendFrame(const proto::Frame& frame);
  void sendCourtEvent(const char* name, uint8_t channel);
  void reportScanRejects();
  void sendScanReject(const char* name, uint16_t count);

  hal::IScannerPort& scanner_;
  hal::IButtonPort& buttons_;
  hal::ITransport& bridge_;
  hal::IClock& clock_;
  hal::IRelayPort& relayPort_;
  hal::IDisplayPort& display_;

  MegaSettings settings_;
  RelayGuard relays_;
  ScreenBuffer screens_;
  ButtonPanel panel_;
  ScanAssembler scan_;
  ScannerBaud baud_;
  AuthWindow auth_;
  proto::Decoder rx_;
  tb::Uptime64 uptime_;
  tb::Deadline stateDue_;

  uint8_t lastMask_;
  bool stateNow_;

  /// The encode scratch buffer, held rather than stacked: 192 bytes is 2.3% of
  /// the ATmega's SRAM and stack exhaustion on this part is silent.
  char txBuf_[proto::kMaxFrameLen];
  uint8_t txQueue_[kTxQueueBytes];
  uint16_t txHead_;
  uint16_t txCount_;

  uint16_t txDropped_;
  uint16_t rxErrors_;
  uint16_t unauthorised_;
  uint16_t oversizeScans_;
  uint16_t corruptScans_;
  uint16_t lastScanRejects_;
  uint32_t lastScanByteMs_;

  // Bridge liveness (v3).
  uint32_t lastRxMs_;
  uint8_t livePeriodS_;
  bool liveSeen_;
  bool bridgeAlive_;

  // Duplicate detection: the last tag applied per relay and for `!AUTH`.
  static constexpr uint8_t kAuthSlot = 4U;
  uint8_t lastTag_[5];
  uint32_t lastTagAtMs_[5];

  // The setup gesture: a chord held from inside the boot window.
  uint32_t bootMs_;
  uint32_t heldSinceMs_;
  uint8_t heldMask_;
  bool heldSent_;

  // What `!HW` last said, so a change re-sends it.
  uint8_t hwSent_[5];
  bool hwDue_;
};

} // namespace courtlogic

#endif // CRUSADERS_COURTLOGIC_COURTBOX_H
