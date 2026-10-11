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
// No booking logic, no member roster, no credit balance, no HTTP. The Mega does
// not know what a member is and must not learn: it is the half that cannot be
// updated over the air, so anything that will change belongs on the ESP.
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
#include "courtlogic/RelayGuard.h"
#include "courtlogic/ScanAssembler.h"
#include "courtlogic/ScreenBuffer.h"
#include "protocol/Codec.h"
#include "protocol/Protocol.h"
#include "timebase/TimeBase.h"

namespace courtlogic {

/// `!STATE` is sent on every change AND on this interval, so a bridge that
/// rebooted and missed a change learns the truth within ten seconds without
/// having to ask.
inline constexpr uint32_t kStateIntervalMs = 10000UL;

/// Bytes drained from each input port per pass.
///
/// A bound, not a buffer size. Without it a peer that streams continuously
/// keeps drainBridge() in its loop indefinitely and the relay tick never runs —
/// which would make a flooded link a way to hold a court's lights on. 64
/// matches the AVR HardwareSerial ring, so a normal pass drains it completely
/// and the bound only bites when something is wrong.
inline constexpr uint16_t kBytesPerPass = 64U;

// The landing screen, the scan acknowledgement and every deadline that takes a
// screen away now live in courtlogic::ScreenBuffer, included above.
//
// The two lines that composed into the stuck-screen bug are DELETED here rather
// than patched: `scanFeedback_`, which any `!LCD` disarmed, and the `showIdle()`
// that the authorisation lapse painted straight over a live grant screen. A
// screen's deadline is now the screen's own, and nothing else can cancel it.

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

  /// Relays open, authorisation disarmed, decoder cleared, idle screen. This is
  /// both the power-on state and what `!RST` means, deliberately the same
  /// function: a reset that left anything behind would be a reset that behaves
  /// differently from a power cycle, which is the failure an operator reaches
  /// for `!RST` to rule out.
  void begin();

  /// One pass of the main loop. Never blocks, never delays, samples the clock
  /// once. Safe to call as fast as the CPU allows.
  void poll();

  // --- diagnostics ---------------------------------------------------------
  //
  // Counters rather than logs: an 8-bit part has nowhere to keep a log, and the
  // bridge is the thing that might be missing when they matter most.

  /// Frames that could not be put on the wire — a full TX ring, or a peer that
  /// went away mid-frame. Each one is a `!BTN`, `!SCAN` or `!EVT` the bridge
  /// will never see.
  uint16_t droppedTxFrames() const { return txDropped_; }

  /// Lines from the bridge that did not decode: bad checksum, unknown verb,
  /// over-long line. A rising count is a failing cable, not a failing peer.
  uint16_t rxErrors() const { return rxErrors_; }

  /// Debounced DURATION presses discarded because the authorisation window was
  /// shut (court presses are forwarded either way since Mega 2.1.0). The count
  /// that tells "nobody is using this court" apart from "the bridge stopped
  /// sending `!AUTH` and every press is being thrown away".
  uint16_t unauthorisedPresses() const { return unauthorised_; }

  /// Scanner lines thrown away as too long — a reader configured for a
  /// different symbology, or one appending a suffix.
  uint16_t oversizeScans() const { return oversizeScans_; }

  /// Scanner lines thrown away as corrupt: a byte outside the payload set on a
  /// 9600 baud line. A cable, a connector or interference — and the count that
  /// explains a member whose code "sometimes does not work".
  uint16_t corruptScans() const { return corruptScans_; }

  const ScreenBuffer& screens() const { return screens_; }

  uint32_t uptimeSeconds() const { return static_cast<uint32_t>(uptime_.value() / 1000ULL); }

  const RelayGuard& relays() const { return relays_; }

  const AuthWindow& auth() const { return auth_; }

private:
  // --- one pass ------------------------------------------------------------
  void drainBridge(uint32_t nowMs);
  void drainScanner(uint32_t nowMs);
  void pollButtons(uint32_t nowMs);
  void pollButtonsUnarmed(uint8_t pressed, uint32_t nowMs);
  void releaseExpired(uint32_t nowMs);
  void noteAuthLapse(uint32_t nowMs);
  void flushOverrun();
  void publishState(uint32_t nowMs);

  // --- inbound -------------------------------------------------------------
  void handleResult(const proto::Decoder::Result& result, uint32_t nowMs);
  void handleFrame(const proto::Frame& frame, uint32_t nowMs);
  void reportDecodeError(proto::DecodeError error);
  void applyOn(const proto::Frame& frame, uint32_t nowMs);
  void applyOff(const proto::Frame& frame);
  void applyExt(const proto::Frame& frame, uint32_t nowMs);
  void applyScreen(const proto::Frame& frame, uint32_t nowMs);

  // --- outbound ------------------------------------------------------------

  /// All of the frame or none of it. False means nothing reached the wire; half
  /// a frame would fail the peer's checksum AND be read as the head of the next
  /// one, so one overrun would corrupt two messages.
  bool sendFrame(const proto::Frame& frame);

  void sendCourtEvent(const char* name, proto::Court court);
  void reportScanRejects();
  void sendScanReject(const char* name, uint16_t count);

  hal::IScannerPort& scanner_;
  hal::ITransport& bridge_;
  hal::IClock& clock_;

  RelayGuard relays_;
  ScreenBuffer screens_;
  ButtonPanel panel_;
  ScanAssembler scan_;
  AuthWindow auth_;
  proto::Decoder rx_;
  tb::Uptime64 uptime_;
  tb::Deadline stateDue_;

  /// The mask `!STATE` last reported, so a change can be detected without
  /// re-deriving it from four deadlines.
  uint8_t lastMask_;

  /// A frame was dropped and the peer has not been told yet. Set on any send
  /// failure and cleared once `!EVT,OVERRUN` gets out. A flag rather than an
  /// immediate send, because the send that would report the overrun is the one
  /// that just failed — reporting it inline is either a recursion or a lie.
  bool overrunPending_;

  /// The encode scratch buffer, held rather than stacked. 192 bytes is 2.3% of
  /// the ATmega's SRAM; as a local it would sit under every call in the send
  /// path at once, and stack exhaustion on this part is silent.
  char txBuf_[proto::kMaxFrameLen];

  uint16_t txDropped_;
  uint16_t rxErrors_;
  uint16_t unauthorised_;
  uint16_t oversizeScans_;
  uint16_t corruptScans_;

  /// ScanAssembler's own reject count as of the last pass, so an INCREASE is
  /// what produces an event. The assembler counts; this is what notices.
  uint16_t lastScanRejects_;
};

} // namespace courtlogic

#endif // CRUSADERS_COURTLOGIC_COURTBOX_H
