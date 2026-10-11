// Unity tests for the Mega-side logic: the independent relay auto-off timer,
// button debouncing, scanner line assembly, the authorisation window, and the
// CourtBox that wires them to the serial protocol.
//
// The auto-off timer is the reason this suite exists. In the system this
// replaces there is no timer in the device at all — the off command is
// scheduled by a VBA macro on a Windows PC — so "the relay opens by itself" is
// a NEW property, and a property nothing else in the stack can compensate for
// if it is wrong. Every behavioural assertion about it is therefore run at
// several clock bases, including bases chosen so the 49.7-day uint32 wrap lands
// in the middle of the scenario.

#include <stdint.h>
#include <string.h>
#include <unity.h>

#include "court/Session.h"
#include "courtlogic/AuthWindow.h"
#include "courtlogic/ButtonPanel.h"
#include "courtlogic/CourtBox.h"
#include "courtlogic/DisplayHoldoff.h"
#include "courtlogic/RelayGuard.h"
#include "courtlogic/ScanAssembler.h"
#include "fakes/FakeButtons.h"
#include "fakes/FakeClock.h"
#include "fakes/FakeDisplay.h"
#include "fakes/FakeRelay.h"
#include "fakes/FakeScanner.h"
#include "fakes/FakeTransport.h"
#include "protocol/Codec.h"

namespace {

// The same matrix the timebase suite uses, for the same reason: a regression
// that reintroduces a naive comparison fails many of these, not one.
constexpr uint32_t kBaseZero = 0U;
constexpr uint32_t kBaseMid = 1234567U;
constexpr uint32_t kBaseWrapSoon = 0xFFFFF000U; // wraps 4096 ms in
constexpr uint32_t kBaseWrapNow = 0xFFFFFFFFU;  // wraps on the very next ms

constexpr uint32_t kBases[] = {kBaseZero, kBaseMid, kBaseWrapSoon, kBaseWrapNow};
constexpr size_t kBaseCount = sizeof(kBases) / sizeof(kBases[0]);

constexpr uint8_t kCourtA = 0U;
constexpr uint8_t kCourtB = 1U;
constexpr uint8_t kCourtC = 2U;

/// `text`, space-padded to the panel's width, in a rotating scratch buffer.
///
/// The width is DERIVED rather than typed out. Six assertions in this file
/// pinned sixteen columns as a literal and all six went red the day the panel's
/// real geometry was adopted — which proved nothing about the box and only that
/// somebody had counted spaces. Four buffers so a single assertion can compare
/// two padded rows.
const char* padded(const char* text) {
  static char bufs[4][hal::kDisplayCols + 1U];
  static uint8_t next = 0U;
  char* out = bufs[next];
  next = static_cast<uint8_t>((next + 1U) % 4U);

  uint8_t i = 0U;
  while (i < hal::kDisplayCols && text[i] != '\0') {
    out[i] = text[i];
    ++i;
  }
  while (i < hal::kDisplayCols) {
    out[i] = ' ';
    ++i;
  }
  out[hal::kDisplayCols] = '\0';
  return out;
}

/// True when the transport's transcript contains a line starting with `prefix`.
/// Prefix rather than equality because a frame carries a checksum, and pinning
/// checksums into these assertions would make them tests of proto::encode()
/// dressed up as tests of the Mega.
bool sentLineStarting(const fakes::FakeTransport& tx, const char* prefix) {
  for (uint8_t i = 0U; i < tx.lineCount(); ++i) {
    if (strncmp(tx.line(i), prefix, strlen(prefix)) == 0) {
      return true;
    }
  }
  return false;
}

uint8_t countLinesStarting(const fakes::FakeTransport& tx, const char* prefix) {
  uint8_t hits = 0U;
  for (uint8_t i = 0U; i < tx.lineCount(); ++i) {
    if (strncmp(tx.line(i), prefix, strlen(prefix)) == 0) {
      ++hits;
    }
  }
  return hits;
}

/// Encode a downlink frame and hand it to the box exactly as the bridge would.
void feedFrame(fakes::FakeTransport& tx, const proto::Frame& frame) {
  char buf[proto::kMaxFrameLen];
  const size_t len = proto::encode(frame, buf, sizeof(buf));
  TEST_ASSERT_TRUE(len > 0U);
  for (size_t i = 0U; i < len; ++i) {
    TEST_ASSERT_TRUE(tx.feedByte(static_cast<uint8_t>(buf[i])));
  }
}

/// A whole court box behind fakes. Declared as one aggregate so the ports and
/// the class that uses them cannot go out of scope in the wrong order.
struct Box {
  fakes::FakeRelay relay;
  fakes::FakeDisplay display;
  fakes::FakeScanner scanner;
  fakes::FakeButtons buttons;
  fakes::FakeTransport bridge;
  fakes::FakeClock clock;
  courtlogic::CourtBox box;

  explicit Box(uint32_t startMs)
      : relay(), display(), scanner(), buttons(), bridge(), clock(startMs),
        box(courtlogic::CourtPorts{relay, display, scanner, buttons, bridge, clock}) {
    box.begin();
  }

  /// Move the clock and run one pass, then let the peer consume the TX buffer.
  ///
  /// The drain matters: fakes::FakeTransport's ring is 64 bytes to match the
  /// AVR HardwareSerial one, so a test that never drains is a test of the
  /// overrun path whether it meant to be or not. The captured transcript
  /// survives a drain, which is what the assertions read.
  void step(uint32_t nowMs) {
    clock.setNow(nowMs);
    box.poll();
    bridge.drainTx();
  }
};

// --- Hardening wave (closing re-review 2026-09-04) --------------------------

void feedRaw(fakes::FakeTransport& tx, const char* text) {
  for (size_t i = 0U; text[i] != '\0'; ++i) {
    TEST_ASSERT_TRUE(tx.feedByte(static_cast<uint8_t>(text[i])));
  }
}

void test_box_refuses_the_legacy_dialect_so_a_bare_a_lights_nothing(void) {
  // THE #11 PIN. The production Mega is built with LegacyDialect::Refuse (the
  // CourtBox default): a lone `A` between two terminators — which the legacy
  // table read as `!ON,A,5400` — is BADFRAME, and no relay moves. The line it
  // arrives on carries the ESP's boot banner at every ESP reset.
  for (size_t i = 0U; i < kBaseCount; ++i) {
    Box b(kBases[i]);
    feedRaw(b.bridge, "A\n");
    b.step(kBases[i] + 1U);
    TEST_ASSERT_EQUAL_UINT8(0U, b.box.relays().mask());
    TEST_ASSERT_FALSE(b.relay.isOn(kCourtA));
    TEST_ASSERT_EQUAL_UINT8(1U, countLinesStarting(b.bridge, "!EVT,BADFRAME"));
    TEST_ASSERT_EQUAL_UINT16(1U, b.box.rxErrors());
    // The legacy two-line prompt armed the buttons as a side effect; refused
    // too, so garbage cannot open the window either.
    feedRaw(b.bridge, "HELLO|WORLD\n");
    b.step(kBases[i] + 2U);
    TEST_ASSERT_FALSE(b.box.auth().allows(kBases[i] + 3U));
    TEST_ASSERT_EQUAL_UINT8(2U, countLinesStarting(b.bridge, "!EVT,BADFRAME"));
    // A v2 frame on the same decoder still works: the dialect, not the
    // link, is what was refused.
    feedFrame(b.bridge, proto::Frame::on(proto::Court::A, 60U));
    b.step(kBases[i] + 3U);
    TEST_ASSERT_TRUE(b.relay.isOn(kCourtA));
  }
}

void test_box_accepts_the_legacy_dialect_only_when_told_to(void) {
  // The bench and the simulator opt in, and the corpus keeps the dialect
  // honest there. This is what a real box would have done with the same byte.
  fakes::FakeRelay relay;
  fakes::FakeDisplay display;
  fakes::FakeScanner scanner;
  fakes::FakeButtons buttons;
  fakes::FakeTransport bridge;
  fakes::FakeClock clock(kBaseMid);
  courtlogic::CourtBox box(courtlogic::CourtPorts{relay, display, scanner, buttons, bridge, clock},
                           proto::LegacyDialect::Accept);
  box.begin();
  feedRaw(bridge, "A\n");
  clock.setNow(kBaseMid + 1U);
  box.poll();
  TEST_ASSERT_TRUE(relay.isOn(kCourtA));
  TEST_ASSERT_EQUAL_UINT16(0U, box.rxErrors());
}

void test_display_holdoff_abandons_then_skips_then_tries_again(void) {
  // THE #3 PIN, the host-testable half. After a bus timeout the driver skips
  // the next kHoldoffWrites writes and then tries the panel again, so a dead
  // display costs one bounded stall per holdoff and a recovered one starts
  // rendering without a power cycle. The AVR-specific half — the timeout
  // itself and the watchdog — is in arduino_hal and is a bench check.
  courtlogic::DisplayHoldoff holdoff;
  TEST_ASSERT_TRUE(holdoff.allow());
  TEST_ASSERT_FALSE(holdoff.holding());
  holdoff.noteTimeout();
  TEST_ASSERT_TRUE(holdoff.holding());
  TEST_ASSERT_EQUAL_UINT16(1U, holdoff.timeouts());
  for (uint8_t i = 0U; i < courtlogic::kHoldoffWrites; ++i) {
    TEST_ASSERT_FALSE(holdoff.allow());
  }
  TEST_ASSERT_TRUE(holdoff.allow()); // the retry
  TEST_ASSERT_FALSE(holdoff.holding());
  TEST_ASSERT_TRUE(holdoff.allow()); // and it keeps rendering while the bus is fine
  holdoff.noteTimeout();
  holdoff.noteTimeout(); // a second timeout inside a holdoff restarts it, never stacks
  TEST_ASSERT_EQUAL_UINT16(3U, holdoff.timeouts());
  for (uint8_t i = 0U; i < courtlogic::kHoldoffWrites; ++i) {
    TEST_ASSERT_FALSE(holdoff.allow());
  }
  TEST_ASSERT_TRUE(holdoff.allow());
}

void test_display_holdoff_asks_for_exactly_one_resync_per_abandoned_write(void) {
  // REVIEW 3, FINDING 12. The bus timeout bounds the STALL; it does not recover
  // the DISPLAY. An abandoned write can take an En edge with it, and the
  // HD44780 then pairs every later nibble wrongly — from that write on, every
  // screen is garbage on a bus that is now perfectly healthy, for the rest of
  // the evening. Only the 4-bit reset sequence clears it, and it was reachable
  // only through the library's init(), called once in setup().
  courtlogic::DisplayHoldoff holdoff;
  // Nothing has gone wrong: no re-sync is owed and none is invented.
  TEST_ASSERT_FALSE(holdoff.resyncPending());
  TEST_ASSERT_FALSE(holdoff.takeResync());
  TEST_ASSERT_TRUE(holdoff.allow());
  TEST_ASSERT_FALSE(holdoff.takeResync());

  holdoff.noteTimeout();
  TEST_ASSERT_TRUE(holdoff.resyncPending());
  // It survives the whole holdoff run — the driver cannot act on it until a
  // write is allowed through again.
  for (uint8_t i = 0U; i < courtlogic::kHoldoffWrites; ++i) {
    TEST_ASSERT_FALSE(holdoff.allow());
    TEST_ASSERT_TRUE(holdoff.resyncPending());
  }
  TEST_ASSERT_TRUE(holdoff.allow());
  TEST_ASSERT_TRUE(holdoff.takeResync());
  // Exactly once, however many writes follow: the controller is back in phase.
  TEST_ASSERT_FALSE(holdoff.takeResync());
  TEST_ASSERT_FALSE(holdoff.resyncPending());
  TEST_ASSERT_TRUE(holdoff.allow());
  TEST_ASSERT_FALSE(holdoff.takeResync());

  // Two timeouts inside one holdoff still owe one re-sync, not two.
  holdoff.noteTimeout();
  holdoff.noteTimeout();
  for (uint8_t i = 0U; i < courtlogic::kHoldoffWrites; ++i) {
    TEST_ASSERT_FALSE(holdoff.allow());
  }
  TEST_ASSERT_TRUE(holdoff.allow());
  TEST_ASSERT_TRUE(holdoff.takeResync());
  TEST_ASSERT_FALSE(holdoff.takeResync());
}

} // namespace

// --- RelayGuard: the safety property ---------------------------------------

void test_relay_guard_drives_the_active_low_level(void) {
  fakes::FakeRelay relay;
  courtlogic::RelayGuard guard(relay);

  TEST_ASSERT_EQUAL_UINT8(hal::toDigital(hal::PinLevel::kHigh), relay.digitalLevel(kCourtA));
  TEST_ASSERT_TRUE(guard.on(kCourtA, 900U, kBaseMid));
  // LOW energises the coil. Asserted through the fake's electrical channel so
  // an edit to relayLevelFor() fails here rather than at a court.
  TEST_ASSERT_EQUAL_UINT8(hal::toDigital(hal::PinLevel::kLow), relay.digitalLevel(kCourtA));
  TEST_ASSERT_EQUAL_UINT8(1U, guard.mask());
}

/// Mega 2.1.0: the club fitted NORMALLY-OPEN SOLID-STATE relays, which close
/// on a HIGH input. The same RelayGuard, over a fake of THAT board, must drive
/// HIGH for on and LOW for off — through hal::relayLevelFor(), the one mapping
/// the Arduino driver also calls with the polarity its build flag names.
void test_relay_guard_drives_the_active_high_level_for_the_solid_state_relays(void) {
  fakes::FakeRelay relay(hal::RelayPolarity::kActiveHigh);
  courtlogic::RelayGuard guard(relay);

  TEST_ASSERT_EQUAL_UINT8(hal::toDigital(hal::PinLevel::kLow), relay.digitalLevel(kCourtA));
  TEST_ASSERT_TRUE(guard.on(kCourtA, 900U, kBaseMid));
  TEST_ASSERT_EQUAL_UINT8(hal::toDigital(hal::PinLevel::kHigh), relay.digitalLevel(kCourtA));
  TEST_ASSERT_EQUAL_UINT8(hal::toDigital(hal::PinLevel::kLow), relay.digitalLevel(kCourtB));
  TEST_ASSERT_TRUE(guard.off(kCourtA));
  TEST_ASSERT_EQUAL_UINT8(hal::toDigital(hal::PinLevel::kLow), relay.digitalLevel(kCourtA));

  // court_mega is built with RELAY_ACTIVE_LOW=0, which is THIS polarity...
  TEST_ASSERT_TRUE(hal::relayPolarityFor(false) == hal::RelayPolarity::kActiveHigh);
  TEST_ASSERT_TRUE(hal::relayPolarityFor(true) == hal::RelayPolarity::kActiveLow);
  // ...and BOOT SAFETY, the host-checkable half of it. ArduinoRelay::begin()
  // writes the RELEASED level while the pin is still an input, then makes it an
  // output. An AVR resets with PORT=0 (LOW), so for the solid-state relays the
  // released level IS the reset state: writing it first leaves the pullup off
  // and pinMode() latches off. For the coil board released is HIGH, and the
  // same order is what stops pinMode() latching the reset LOW = all courts on.
  TEST_ASSERT_TRUE(hal::relayLevelFor(false, hal::RelayPolarity::kActiveHigh) == hal::PinLevel::kLow);
  TEST_ASSERT_TRUE(hal::relayLevelFor(false, hal::RelayPolarity::kActiveLow) == hal::PinLevel::kHigh);
}

void test_relay_guard_releases_at_the_deadline_at_every_base(void) {
  for (size_t i = 0; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    fakes::FakeRelay relay;
    courtlogic::RelayGuard guard(relay);

    TEST_ASSERT_TRUE(guard.on(kCourtA, 900U, base));

    TEST_ASSERT_EQUAL_UINT8(0U, guard.tick(base + 899999U));
    TEST_ASSERT_TRUE(relay.isOn(kCourtA));

    TEST_ASSERT_EQUAL_UINT8(1U, guard.tick(base + 900000U));
    TEST_ASSERT_FALSE(relay.isOn(kCourtA));
    TEST_ASSERT_EQUAL_UINT16(1U, guard.autoOffCount());

    // Idempotent: the deadline is disarmed on release, so a later pass does not
    // re-report an auto-off that already happened.
    TEST_ASSERT_EQUAL_UINT8(0U, guard.tick(base + 900001U));
    TEST_ASSERT_EQUAL_UINT16(1U, guard.autoOffCount());
  }
}

// The regression test for the deleted sketch's bug, which failed in BOTH
// directions across the wrap on adjacent lines.
//
//   (a) a deadline computed just before the wrap, checked just after it. The
//       naive `now >= expiresAt` says "not yet" for another ~49.7 days, so the
//       relay is NEVER released and a court burns for seven weeks.
//   (b) a deadline that wrapped past zero, checked before the wrap. The naive
//       comparison says "already passed", so the lights cut out mid-game.
//
// Both are asserted against the guard, and the naive answer is asserted beside
// each so neither can be quietly reintroduced.
void test_relay_guard_releases_across_the_millis_wrap(void) {
  const uint32_t base = 0xFFFFF000U; // 4096 ms before the wrap

  // --- direction (a): the severe one ---------------------------------------
  {
    fakes::FakeRelay relay;
    courtlogic::RelayGuard guard(relay);

    const uint32_t preWrapDeadline = base + 2000U; // 0xFFFFF7D0, still pre-wrap
    const uint32_t afterWrap = 0x00000100U;        // 2.8 s later in real time
    TEST_ASSERT_TRUE(guard.on(kCourtA, 2U, base));

    TEST_ASSERT_EQUAL_UINT8(1U, guard.tick(afterWrap));
    TEST_ASSERT_FALSE(relay.isOn(kCourtA));

    // What a naive comparison would have said: not yet, for seven more weeks.
    TEST_ASSERT_FALSE(afterWrap >= preWrapDeadline);
  }

  // --- direction (b): the early cut-out ------------------------------------
  {
    fakes::FakeRelay relay;
    courtlogic::RelayGuard guard(relay);

    const uint32_t wrappedDeadline = 0x00000F40U; // base + 8000, having wrapped
    const uint32_t stillPreWrap = 0xFFFFF800U;    // 2 s into an 8 s session
    TEST_ASSERT_TRUE(guard.on(kCourtA, 8U, base));

    TEST_ASSERT_EQUAL_UINT8(0U, guard.tick(stillPreWrap));
    TEST_ASSERT_TRUE(relay.isOn(kCourtA));
    TEST_ASSERT_EQUAL_UINT8(0U, guard.tick(0x00000100U));
    TEST_ASSERT_TRUE(relay.isOn(kCourtA));

    TEST_ASSERT_EQUAL_UINT8(1U, guard.tick(wrappedDeadline));
    TEST_ASSERT_FALSE(relay.isOn(kCourtA));

    // What a naive comparison would have said 6 seconds early: already over.
    TEST_ASSERT_TRUE(stillPreWrap >= wrappedDeadline);
  }
}

void test_relay_guard_caps_a_longer_request_at_ninety_minutes(void) {
  fakes::FakeRelay relay;
  courtlogic::RelayGuard guard(relay);

  TEST_ASSERT_TRUE(guard.on(kCourtA, 100000U, kBaseMid));
  TEST_ASSERT_EQUAL_UINT16(5400U, guard.remainingSeconds(kCourtA, kBaseMid));

  TEST_ASSERT_EQUAL_UINT8(0U, guard.tick(kBaseMid + courtlogic::kRelayHardCapMs - 1U));
  TEST_ASSERT_TRUE(relay.isOn(kCourtA));
  TEST_ASSERT_EQUAL_UINT8(1U, guard.tick(kBaseMid + courtlogic::kRelayHardCapMs));
  TEST_ASSERT_FALSE(relay.isOn(kCourtA));
}

// The clamp saturates on the SECONDS. Clamping after the multiply would let
// 4294968 seconds wrap to 296 ms — and, worse, other values wrap UP past the
// cap, which is the failure the cap exists to prevent.
void test_relay_guard_saturates_rather_than_wrapping_the_conversion(void) {
  fakes::FakeRelay relay;
  courtlogic::RelayGuard guard(relay);

  TEST_ASSERT_TRUE(guard.on(kCourtA, 4294968U, kBaseMid));
  TEST_ASSERT_EQUAL_UINT16(5400U, guard.remainingSeconds(kCourtA, kBaseMid));

  TEST_ASSERT_TRUE(guard.on(kCourtB, UINT32_MAX, kBaseMid));
  TEST_ASSERT_EQUAL_UINT16(5400U, guard.remainingSeconds(kCourtB, kBaseMid));
}

void test_relay_guard_zero_seconds_is_not_an_indefinite_on(void) {
  fakes::FakeRelay relay;
  courtlogic::RelayGuard guard(relay);

  TEST_ASSERT_TRUE(guard.on(kCourtA, 0U, kBaseWrapSoon));
  TEST_ASSERT_TRUE(relay.isOn(kCourtA));
  TEST_ASSERT_EQUAL_UINT8(1U, guard.tick(kBaseWrapSoon + courtlogic::kRelayMinMs));
  TEST_ASSERT_FALSE(relay.isOn(kCourtA));
}

void test_relay_guard_off_disarms_the_timer(void) {
  fakes::FakeRelay relay;
  courtlogic::RelayGuard guard(relay);

  TEST_ASSERT_TRUE(guard.on(kCourtA, 60U, kBaseMid));
  TEST_ASSERT_TRUE(guard.off(kCourtA));
  TEST_ASSERT_FALSE(relay.isOn(kCourtA));

  // No phantom AUTOOFF once the deadline that was armed goes by.
  TEST_ASSERT_EQUAL_UINT8(0U, guard.tick(kBaseMid + 60000U));
  TEST_ASSERT_EQUAL_UINT16(0U, guard.autoOffCount());
}

void test_relay_guard_extend_is_refused_on_an_open_relay(void) {
  fakes::FakeRelay relay;
  courtlogic::RelayGuard guard(relay);

  // Nothing is on: an EXT must not turn the lights on by itself, or a dropped
  // OFF becomes lights that come back by themselves.
  TEST_ASSERT_FALSE(guard.extend(kCourtA, 600U, kBaseMid));
  TEST_ASSERT_FALSE(relay.isOn(kCourtA));
  TEST_ASSERT_EQUAL_UINT16(0U, relay.transitions(kCourtA));
}

void test_relay_guard_extend_moves_the_deadline_and_is_capped(void) {
  fakes::FakeRelay relay;
  courtlogic::RelayGuard guard(relay);

  TEST_ASSERT_TRUE(guard.on(kCourtA, 60U, kBaseWrapSoon));
  TEST_ASSERT_TRUE(guard.extend(kCourtA, 120U, kBaseWrapSoon + 30000U));

  // The original 60 s deadline has passed; the extension is what holds it on.
  TEST_ASSERT_EQUAL_UINT8(0U, guard.tick(kBaseWrapSoon + 60000U));
  TEST_ASSERT_TRUE(relay.isOn(kCourtA));
  TEST_ASSERT_EQUAL_UINT8(1U, guard.tick(kBaseWrapSoon + 150000U));

  TEST_ASSERT_TRUE(guard.on(kCourtB, 60U, kBaseMid));
  TEST_ASSERT_TRUE(guard.extend(kCourtB, 999999U, kBaseMid));
  TEST_ASSERT_EQUAL_UINT16(5400U, guard.remainingSeconds(kCourtB, kBaseMid));
}

void test_relay_guard_all_off_disarms_every_timer(void) {
  fakes::FakeRelay relay;
  courtlogic::RelayGuard guard(relay);

  for (uint8_t c = 0U; c < hal::kRelayChannelCount; ++c) {
    TEST_ASSERT_TRUE(guard.on(c, 60U, kBaseMid));
  }
  TEST_ASSERT_EQUAL_UINT8(0x0FU, guard.mask());

  guard.allOff();
  TEST_ASSERT_EQUAL_UINT8(0U, guard.mask());
  TEST_ASSERT_FALSE(relay.anyOn());
  TEST_ASSERT_EQUAL_UINT8(0U, guard.tick(kBaseMid + 60000U));
}

void test_relay_guard_remaining_seconds_rounds_down(void) {
  fakes::FakeRelay relay;
  courtlogic::RelayGuard guard(relay);

  TEST_ASSERT_TRUE(guard.on(kCourtA, 10U, kBaseWrapNow));
  // 1 ms after arming, 9999 ms are left: nine whole seconds, not ten. `!STATE`
  // must never advertise a second the relay will not serve.
  TEST_ASSERT_EQUAL_UINT16(9U, guard.remainingSeconds(kCourtA, kBaseWrapNow + 1U));
  TEST_ASSERT_EQUAL_UINT16(0U, guard.remainingSeconds(kCourtA, kBaseWrapNow + 10000U));
  TEST_ASSERT_EQUAL_UINT16(0U, guard.remainingSeconds(kCourtB, kBaseWrapNow));
}

void test_relay_guard_ignores_channels_that_do_not_exist(void) {
  fakes::FakeRelay relay;
  courtlogic::RelayGuard guard(relay);

  TEST_ASSERT_FALSE(guard.on(hal::kRelayChannelCount, 60U, kBaseMid));
  TEST_ASSERT_FALSE(guard.off(hal::kRelayChannelCount));
  TEST_ASSERT_FALSE(guard.extend(hal::kRelayChannelCount, 60U, kBaseMid));
  // Never clamped to a neighbour: that would drive a real, wrong court.
  TEST_ASSERT_EQUAL_UINT8(0U, guard.mask());
  TEST_ASSERT_EQUAL_UINT16(0U, relay.badChannelCalls());
}

// --- ButtonPanel -----------------------------------------------------------

void test_button_press_needs_the_whole_window_after_the_chatter_stops(void) {
  fakes::FakeButtons buttons;
  courtlogic::ButtonPanel panel(buttons);

  // An oscilloscope trace: the contact chatters for three milliseconds and is
  // then solidly closed. The window restarts on every edge, so the press is
  // reported 80 ms after the LAST edge, not after the first.
  TEST_ASSERT_TRUE(buttons.script(
      0U, "LHLHLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL"));

  for (uint32_t t = 0U; t < 84U; ++t) {
    TEST_ASSERT_EQUAL_UINT8(0U, panel.poll(t));
  }
  TEST_ASSERT_EQUAL_UINT8(courtlogic::buttonBit(0U), panel.poll(84U));
  TEST_ASSERT_TRUE(panel.isPressed(0U));
  TEST_ASSERT_FALSE(buttons.scriptExhausted(0U));

  // Exactly one press, not one per pass while it is held.
  TEST_ASSERT_EQUAL_UINT8(0U, panel.poll(200U));
}

void test_button_bounce_that_never_settles_is_never_a_press(void) {
  fakes::FakeButtons buttons;
  courtlogic::ButtonPanel panel(buttons);

  uint32_t now = kBaseMid;
  for (uint8_t i = 0U; i < 20U; ++i) {
    // Flip the level every 40 ms — half the window — forever. One extra !BTN
    // frame here is one extra court-hour billed to a member.
    if ((i % 2U) == 0U) {
      buttons.press(0U);
    } else {
      buttons.release(0U);
    }
    TEST_ASSERT_EQUAL_UINT8(0U, panel.poll(now));
    now += 40U;
  }
  TEST_ASSERT_FALSE(panel.isPressed(0U));
}

void test_button_debounce_survives_the_millis_wrap(void) {
  for (size_t i = 0; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    fakes::FakeButtons buttons;
    courtlogic::ButtonPanel panel(buttons);

    buttons.press(2U);
    TEST_ASSERT_EQUAL_UINT8(0U, panel.poll(base));
    TEST_ASSERT_EQUAL_UINT8(0U, panel.poll(base + courtlogic::kDebounceMs - 1U));
    TEST_ASSERT_EQUAL_UINT8(courtlogic::buttonBit(2U), panel.poll(base + courtlogic::kDebounceMs));
  }
}

void test_two_buttons_settling_on_one_pass_are_both_reported(void) {
  fakes::FakeButtons buttons;
  courtlogic::ButtonPanel panel(buttons);

  // A court button and a duration button pressed together: how an impatient
  // member uses this panel. Reporting one would look like a debounce fault.
  buttons.press(1U);
  buttons.press(hal::kDurationButtonBase + 2U);
  TEST_ASSERT_EQUAL_UINT8(0U, panel.poll(kBaseWrapSoon));

  const uint8_t expected =
      static_cast<uint8_t>(courtlogic::buttonBit(1U) | courtlogic::buttonBit(hal::kDurationButtonBase + 2U));
  TEST_ASSERT_EQUAL_UINT8(expected, panel.poll(kBaseWrapSoon + courtlogic::kDebounceMs));
}

void test_button_release_then_press_is_a_second_press(void) {
  fakes::FakeButtons buttons;
  courtlogic::ButtonPanel panel(buttons);

  buttons.press(0U);
  TEST_ASSERT_EQUAL_UINT8(0U, panel.poll(0U));
  TEST_ASSERT_EQUAL_UINT8(1U, panel.poll(80U));

  buttons.release(0U);
  TEST_ASSERT_EQUAL_UINT8(0U, panel.poll(100U));
  TEST_ASSERT_EQUAL_UINT8(0U, panel.poll(180U));
  TEST_ASSERT_FALSE(panel.isPressed(0U));

  buttons.press(0U);
  TEST_ASSERT_EQUAL_UINT8(0U, panel.poll(200U));
  TEST_ASSERT_EQUAL_UINT8(1U, panel.poll(280U));
}

// --- ScanAssembler ---------------------------------------------------------

void feedText(courtlogic::ScanAssembler& scan, const char* text, bool expectComplete) {
  bool complete = false;
  for (size_t i = 0U; text[i] != '\0'; ++i) {
    complete = scan.feed(static_cast<uint8_t>(text[i])) || complete;
  }
  TEST_ASSERT_EQUAL(expectComplete, complete);
}

void test_scan_assembles_a_code_across_fragments(void) {
  courtlogic::ScanAssembler scan;

  // 9600 baud across many passes of the main loop: a code arrives in pieces and
  // no decision may be made until the terminator does.
  feedText(scan, "MEM-", false);
  feedText(scan, "0042", false);
  feedText(scan, "\n", true);
  TEST_ASSERT_EQUAL_STRING("MEM-0042", scan.code());
  TEST_ASSERT_EQUAL_UINT8(8U, scan.length());
}

void test_scan_crlf_is_one_terminator(void) {
  courtlogic::ScanAssembler scan;

  feedText(scan, "ABC\r", true);
  TEST_ASSERT_EQUAL_STRING("ABC", scan.code());
  // The '\n' of the CRLF must not end a second, empty line.
  TEST_ASSERT_FALSE(scan.feed(static_cast<uint8_t>('\n')));
  TEST_ASSERT_EQUAL_STRING("ABC", scan.code());

  feedText(scan, "DEF\r\n", true);
  TEST_ASSERT_EQUAL_STRING("DEF", scan.code());
}

void test_scan_blank_lines_are_not_events(void) {
  courtlogic::ScanAssembler scan;

  TEST_ASSERT_FALSE(scan.feed(static_cast<uint8_t>('\n')));
  TEST_ASSERT_FALSE(scan.feed(static_cast<uint8_t>('\n')));
  TEST_ASSERT_EQUAL_STRING("", scan.code());
  TEST_ASSERT_EQUAL_UINT16(0U, scan.rejectedLines());
}

void test_scan_refuses_an_over_long_code_rather_than_truncating(void) {
  courtlogic::ScanAssembler scan;

  // A truncated member code does not fail: it identifies a DIFFERENT member,
  // and the ledger debit follows it.
  for (uint8_t i = 0U; i < courtlogic::kMaxScanLen + 4U; ++i) {
    TEST_ASSERT_FALSE(scan.feed(static_cast<uint8_t>('X')));
  }
  TEST_ASSERT_FALSE(scan.feed(static_cast<uint8_t>('\n')));
  TEST_ASSERT_EQUAL_STRING("", scan.code());
  TEST_ASSERT_EQUAL(courtlogic::ScanReject::TooLong, scan.lastReject());
  TEST_ASSERT_EQUAL_UINT16(1U, scan.rejectedLines());

  // The next line is clean again.
  feedText(scan, "OK1\n", true);
  TEST_ASSERT_EQUAL_STRING("OK1", scan.code());
}

void test_scan_a_control_byte_poisons_the_line(void) {
  courtlogic::ScanAssembler scan;

  // hal/Scanner.h delivers NUL like any other byte and leaves the meaning to
  // this layer. The meaning is "the payload is corrupt".
  feedText(scan, "ME", false);
  TEST_ASSERT_FALSE(scan.feed(0x00U));
  feedText(scan, "M1\n", false);
  TEST_ASSERT_EQUAL_STRING("", scan.code());
  TEST_ASSERT_EQUAL(courtlogic::ScanReject::Corrupt, scan.lastReject());
}

void test_scan_reset_abandons_a_partial_line(void) {
  courtlogic::ScanAssembler scan;

  feedText(scan, "HALF", false);
  scan.reset();
  // Finishing the abandoned line with the next member's bytes would be worse
  // than losing both.
  feedText(scan, "REST\n", true);
  TEST_ASSERT_EQUAL_STRING("REST", scan.code());
}

// --- AuthWindow ------------------------------------------------------------

void test_auth_window_allows_only_while_armed(void) {
  for (size_t i = 0; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    courtlogic::AuthWindow auth;

    TEST_ASSERT_FALSE(auth.allows(base));
    auth.arm(base, 30U);
    TEST_ASSERT_TRUE(auth.allows(base));
    TEST_ASSERT_TRUE(auth.allows(base + 29999U));
    TEST_ASSERT_FALSE(auth.allows(base + 30000U));
  }
}

void test_auth_lapse_is_an_edge_not_a_level(void) {
  courtlogic::AuthWindow auth;
  auth.arm(kBaseWrapSoon, 30U);

  TEST_ASSERT_FALSE(auth.lapsed(kBaseWrapSoon + 29999U));
  // One !EVT,AUTHEXPIRED, not one per pass of a loop that runs thousands of
  // times a second on a 9600 baud link.
  TEST_ASSERT_TRUE(auth.lapsed(kBaseWrapSoon + 30000U));
  TEST_ASSERT_FALSE(auth.lapsed(kBaseWrapSoon + 30001U));
  TEST_ASSERT_FALSE(auth.lapsed(kBaseWrapSoon + 90000U));
}

void test_auth_zero_disarms_and_disarm_is_silent(void) {
  courtlogic::AuthWindow auth;

  auth.arm(kBaseMid, 30U);
  auth.arm(kBaseMid, 0U);
  TEST_ASSERT_FALSE(auth.allows(kBaseMid));
  // The bridge asked for this, so there is nothing to report back to it.
  TEST_ASSERT_FALSE(auth.lapsed(kBaseMid + 60000U));

  auth.arm(kBaseMid, 30U);
  auth.disarm();
  TEST_ASSERT_FALSE(auth.lapsed(kBaseMid + 60000U));
}

void test_auth_rearming_replaces_rather_than_accumulates(void) {
  courtlogic::AuthWindow auth;

  auth.arm(kBaseMid, 30U);
  auth.arm(kBaseMid + 10000U, 30U);
  // A second scan is a fresh 30 seconds, not 60.
  TEST_ASSERT_TRUE(auth.allows(kBaseMid + 39999U));
  TEST_ASSERT_FALSE(auth.allows(kBaseMid + 40000U));
}

void test_auth_saturates_an_absurd_window(void) {
  courtlogic::AuthWindow auth;

  auth.arm(kBaseMid, UINT32_MAX);
  TEST_ASSERT_TRUE(auth.allows(kBaseMid + courtlogic::kAuthMaxMs - 1U));
  TEST_ASSERT_FALSE(auth.allows(kBaseMid + courtlogic::kAuthMaxMs));
}

// --- CourtBox --------------------------------------------------------------

void test_box_on_frame_lights_the_court_and_publishes_state(void) {
  Box b(kBaseMid);

  feedFrame(b.bridge, proto::Frame::on(proto::Court::A, 900U));
  b.step(kBaseMid + 1U);

  TEST_ASSERT_TRUE(b.relay.isOn(kCourtA));
  TEST_ASSERT_EQUAL_UINT8(hal::toDigital(hal::PinLevel::kLow), b.relay.digitalLevel(kCourtA));
  TEST_ASSERT_TRUE(sentLineStarting(b.bridge, "!STATE,1,900,0,0,0"));
}

void test_box_auto_off_emits_the_event_across_the_wrap(void) {
  Box b(kBaseWrapSoon);

  feedFrame(b.bridge, proto::Frame::on(proto::Court::B, 8U));
  b.step(kBaseWrapSoon);
  TEST_ASSERT_TRUE(b.relay.isOn(kCourtB));

  // Straddle the wrap: the deadline was computed before it and is checked after.
  b.step(0x00000100U);
  TEST_ASSERT_TRUE(b.relay.isOn(kCourtB));

  b.step(0x00000F40U);
  TEST_ASSERT_FALSE(b.relay.isOn(kCourtB));
  TEST_ASSERT_TRUE(sentLineStarting(b.bridge, "!EVT,AUTOOFF,B"));
  TEST_ASSERT_TRUE(sentLineStarting(b.bridge, "!STATE,0,"));
}

void test_box_a_dead_bridge_still_loses_the_lights(void) {
  Box b(kBaseMid);

  feedFrame(b.bridge, proto::Frame::on(proto::Court::A, 5U));
  b.step(kBaseMid);
  TEST_ASSERT_TRUE(b.relay.isOn(kCourtA));

  // The ESP is gone: unplugged, mid-OTA, crashed. Nothing arrives, nothing can
  // be sent, and the court must still go dark on schedule. This is the whole
  // reason the timer is on this side of the link.
  b.bridge.setConnected(false);
  b.step(kBaseMid + 5000U);

  TEST_ASSERT_FALSE(b.relay.isOn(kCourtA));
  TEST_ASSERT_EQUAL_UINT16(1U, b.box.relays().autoOffCount());
  TEST_ASSERT_TRUE(b.box.droppedTxFrames() > 0U);
}

/// The first key a member presses at a dark panel. A DURATION key is the only
/// press that can buy anything, and outside the window it is dropped — never
/// queued for the next member's scan — and counted (Mega 2.1.0: duration keys
/// only; court keys are forwarded, see below).
constexpr uint8_t kFirstDurationKey = hal::kDurationButtonBase;

void test_box_drops_presses_outside_the_auth_window(void) {
  for (size_t i = 0; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    Box b(base);

    uint32_t at = base;
    for (uint8_t key = hal::kDurationButtonBase; key < hal::kButtonCount; ++key) {
      b.buttons.press(key);
      b.step(at += 10U);
      b.step(at += courtlogic::kDebounceMs);
      b.buttons.release(key);
      b.step(at += 10U);
      b.step(at += courtlogic::kDebounceMs);
    }

    TEST_ASSERT_FALSE(sentLineStarting(b.bridge, "!BTN"));
    TEST_ASSERT_EQUAL_UINT16(4U, b.box.unauthorisedPresses());
  }
}

/// Mega 2.1.0. A COURT key is forwarded with the window shut: on its own it
/// buys nothing and lights nothing, and only the bridge knows whether to answer
/// it with the court's minutes left (SCAN TO EXTEND) or SCAN YOUR CODE. It is
/// NOT an unauthorised press — the `!PONG` counter still means "a press thrown
/// away" — and the Mega paints nothing of its own yet: the bridge answers.
void test_box_a_court_key_with_the_window_shut_is_forwarded_and_not_counted(void) {
  const char* const frames[hal::kCourtButtonCount] = {"!BTN,A", "!BTN,B", "!BTN,C", "!BTN,D"};
  for (size_t i = 0; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    for (uint8_t key = 0U; key < hal::kCourtButtonCount; ++key) {
      Box b(base);
      TEST_ASSERT_FALSE(b.box.auth().allows(base));

      b.buttons.press(key);
      b.step(base + 10U);
      b.step(base + 10U + courtlogic::kDebounceMs);

      TEST_ASSERT_TRUE_MESSAGE(sentLineStarting(b.bridge, frames[key]), frames[key]);
      TEST_ASSERT_EQUAL_UINT8(1U, countLinesStarting(b.bridge, "!BTN"));
      TEST_ASSERT_EQUAL_UINT16(0U, b.box.unauthorisedPresses());
      TEST_ASSERT_EQUAL_STRING(padded(courtlogic::kIdleLine2), b.display.row(1U));
      TEST_ASSERT_EQUAL_STRING(padded("READY"), b.display.row(3U));
    }
  }
}

/// A court key and a duration key settling on the same pass, window shut: the
/// court key goes to the bridge, the duration key is dropped and counted once,
/// and the drop is answered on the glass at once.
void test_box_a_court_and_a_duration_key_together_split_with_the_window_shut(void) {
  Box b(kBaseMid);

  b.buttons.press(0U);
  b.buttons.press(kFirstDurationKey);
  b.step(kBaseMid + 10U);
  b.step(kBaseMid + 10U + courtlogic::kDebounceMs);

  TEST_ASSERT_TRUE(sentLineStarting(b.bridge, "!BTN,A"));
  TEST_ASSERT_FALSE(sentLineStarting(b.bridge, "!BTN,1"));
  TEST_ASSERT_EQUAL_UINT16(1U, b.box.unauthorisedPresses());
  TEST_ASSERT_EQUAL_STRING(padded(courtlogic::kHintLine), b.display.row(1U));
}

/// The bridge is dead, rebooting or mid-flash and paints nothing in answer to a
/// forwarded court press. The Mega waits kHintFallbackMs for it — a live
/// bridge answers within a pass — and then paints SCAN CODE FIRST itself, on
/// row 1 (the club's 16x2 shows rows 0-1 only) and on the full action row.
void test_box_the_mega_paints_its_own_hint_when_the_bridge_does_not_answer(void) {
  for (size_t i = 0; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    Box b(base);

    b.buttons.press(1U);
    b.step(base + 10U);
    const uint32_t pressedAt = base + 10U + courtlogic::kDebounceMs;
    b.step(pressedAt);
    TEST_ASSERT_TRUE(sentLineStarting(b.bridge, "!BTN,B"));

    // Silence is not answered early: the bridge still has the grace.
    b.step(pressedAt + courtlogic::kHintFallbackMs - 1U);
    TEST_ASSERT_EQUAL_STRING(padded(courtlogic::kIdleLine2), b.display.row(1U));

    b.step(pressedAt + courtlogic::kHintFallbackMs);
    TEST_ASSERT_EQUAL_STRING(padded(courtlogic::kIdleLine1), b.display.row(0U));
    TEST_ASSERT_EQUAL_STRING(padded(courtlogic::kHintLine), b.display.row(1U));
    TEST_ASSERT_EQUAL_STRING(padded("SCAN YOUR CODE FIRST"), b.display.row(3U));
    // Still not an unauthorised press: the court key was forwarded.
    TEST_ASSERT_EQUAL_UINT16(0U, b.box.unauthorisedPresses());

    // And it goes on its own, the landing rows put back.
    b.step(pressedAt + courtlogic::kHintFallbackMs + courtlogic::kHintMs);
    TEST_ASSERT_EQUAL_STRING(padded(courtlogic::kIdleLine2), b.display.row(1U));
    TEST_ASSERT_EQUAL_STRING(padded("READY"), b.display.row(3U));
  }
}

/// A bridge that DOES answer inside the grace cancels the fallback, whichever
/// verb it paints with: its words are what stays on the glass.
void test_box_a_bridge_answer_inside_the_grace_cancels_the_fallback(void) {
  for (uint8_t shape = 0U; shape < 2U; ++shape) {
    Box b(kBaseWrapSoon);
    b.buttons.press(0U);
    b.step(kBaseWrapSoon + 10U);
    const uint32_t pressedAt = kBaseWrapSoon + 10U + courtlogic::kDebounceMs;
    b.step(pressedAt);

    if (shape == 0U) {
      feedFrame(b.bridge, proto::Frame::lcd("COURT A 45 MIN", "SCAN TO EXTEND"));
    } else {
      feedFrame(b.bridge, proto::Frame::row(0U, "COURT A 45 MIN"));
      feedFrame(b.bridge, proto::Frame::row(1U, "SCAN TO EXTEND"));
      feedFrame(b.bridge, proto::Frame::show(10U, 0U));
    }
    b.step(pressedAt + 200U);
    b.step(pressedAt + 400U);
    TEST_ASSERT_EQUAL_STRING(padded("SCAN TO EXTEND"), b.display.row(1U));

    b.step(pressedAt + courtlogic::kHintFallbackMs + 500U);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(padded("SCAN TO EXTEND"), b.display.row(1U),
                                     "the Mega's fallback painted over the bridge's answer");
    TEST_ASSERT_EQUAL_UINT16(0U, b.box.screens().suppressedHints());
  }
}

/// A court key that could not be SENT — the link is down — is answered on the
/// glass at once (there is no bridge to wait for), and is not an unauthorised
/// press: the link failed, and that is counted as a dropped frame instead.
void test_box_a_court_key_the_link_cannot_carry_is_hinted_at_once(void) {
  Box b(kBaseMid);
  b.bridge.setConnected(false);

  b.buttons.press(2U);
  b.step(kBaseMid + 10U);
  b.step(kBaseMid + 10U + courtlogic::kDebounceMs);

  TEST_ASSERT_TRUE(b.box.droppedTxFrames() > 0U);
  TEST_ASSERT_EQUAL_UINT16(0U, b.box.unauthorisedPresses());
  TEST_ASSERT_EQUAL_STRING(padded(courtlogic::kHintLine), b.display.row(1U));
}

/// Mega 2.1.0. An accepted `!EXT` is followed at once by a `!STATE` carrying
/// the new deadline, so the minutes a member just paid for are on the bridge's
/// glass now rather than at the next ten-second publish. A refused one (relay
/// open) is `!ERR,BADARG` and publishes nothing.
void test_box_an_accepted_ext_publishes_state_at_once(void) {
  for (size_t i = 0; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    Box b(base);

    feedFrame(b.bridge, proto::Frame::on(proto::Court::A, 600U));
    b.step(base + 1U);
    TEST_ASSERT_EQUAL_UINT8(1U, countLinesStarting(b.bridge, "!STATE,1,600,"));

    // Two seconds later: well inside the periodic interval, mask unchanged.
    feedFrame(b.bridge, proto::Frame::ext(proto::Court::A, 1800U));
    b.step(base + 2001U);
    TEST_ASSERT_EQUAL_UINT8(1U, countLinesStarting(b.bridge, "!STATE,1,1800,0,0,0"));

    // An `!EXT` on a dark court is refused and says nothing else.
    feedFrame(b.bridge, proto::Frame::ext(proto::Court::B, 1800U));
    b.step(base + 2002U);
    TEST_ASSERT_EQUAL_UINT8(1U, countLinesStarting(b.bridge, "!ERR,BADARG"));
    TEST_ASSERT_EQUAL_UINT8(2U, countLinesStarting(b.bridge, "!STATE,1,"));
    TEST_ASSERT_FALSE(b.bridge.captureOverflowed());
  }
}

void test_box_forwards_a_press_inside_the_auth_window(void) {
  Box b(kBaseMid);

  feedFrame(b.bridge, proto::Frame::auth(30U));
  b.step(kBaseMid);

  b.buttons.press(0U);
  b.step(kBaseMid + 10U);
  b.step(kBaseMid + 10U + courtlogic::kDebounceMs);

  TEST_ASSERT_TRUE(sentLineStarting(b.bridge, "!BTN,A"));
  TEST_ASSERT_EQUAL_UINT16(0U, b.box.unauthorisedPresses());
}

void test_box_emits_authexpired_exactly_once(void) {
  Box b(kBaseWrapSoon);

  feedFrame(b.bridge, proto::Frame::auth(30U));
  b.step(kBaseWrapSoon);

  b.step(kBaseWrapSoon + 30000U);
  b.step(kBaseWrapSoon + 40000U);
  b.step(kBaseWrapSoon + 50000U);

  TEST_ASSERT_EQUAL_UINT8(1U, countLinesStarting(b.bridge, "!EVT,AUTHEXPIRED"));
}

void test_box_a_complete_scan_becomes_a_scan_frame(void) {
  Box b(kBaseMid);

  TEST_ASSERT_TRUE(b.scanner.feed("MEM-0042\r\n"));
  b.step(kBaseMid + 1U);

  TEST_ASSERT_TRUE(sentLineStarting(b.bridge, "!SCAN,MEM-0042"));
  TEST_ASSERT_EQUAL_UINT16(0U, b.box.oversizeScans());
}

void test_box_answers_a_bad_checksum_with_baderr(void) {
  Box b(kBaseMid);

  // A corrupted `a` arriving as `A` is the failure the checksum exists for. The
  // frame is dropped, never guessed at, and the relay stays open.
  TEST_ASSERT_TRUE(b.bridge.feedLine("!ON,A,900*00"));
  b.step(kBaseMid + 1U);

  TEST_ASSERT_FALSE(b.relay.isOn(kCourtA));
  TEST_ASSERT_TRUE(sentLineStarting(b.bridge, "!ERR,BADCRC"));
  TEST_ASSERT_EQUAL_UINT16(1U, b.box.rxErrors());
}

void test_box_answers_ping_with_pong(void) {
  Box b(kBaseMid);

  feedFrame(b.bridge, proto::Frame::ping());
  b.step(kBaseMid + 4000U);

  TEST_ASSERT_TRUE(sentLineStarting(b.bridge, "!PONG,"));
}

void test_box_rst_releases_everything(void) {
  Box b(kBaseMid);

  feedFrame(b.bridge, proto::Frame::on(proto::Court::A, 900U));
  feedFrame(b.bridge, proto::Frame::auth(30U));
  b.step(kBaseMid);
  TEST_ASSERT_TRUE(b.relay.isOn(kCourtA));

  feedFrame(b.bridge, proto::Frame::rst());
  b.step(kBaseMid + 10U);

  TEST_ASSERT_FALSE(b.relay.anyOn());
  TEST_ASSERT_FALSE(b.box.auth().allows(kBaseMid + 10U));
  TEST_ASSERT_EQUAL_STRING(padded(courtlogic::kIdleLine1), b.display.row(0U));
}

void test_box_repaints_a_row_padded_to_the_full_width(void) {
  Box b(kBaseMid);

  feedFrame(b.bridge, proto::Frame::lcd("COURT A 45 MIN", "PRESS START"));
  b.step(kBaseMid);
  TEST_ASSERT_EQUAL_STRING(padded("COURT A 45 MIN"), b.display.row(0U));

  // The shorter message must not leave the old tail on the glass: without
  // padding this reads "COURT A 5 MINN".
  feedFrame(b.bridge, proto::Frame::lcd("COURT A 5 MIN", "PRESS START"));
  b.step(kBaseMid + 1U);
  TEST_ASSERT_EQUAL_STRING(padded("COURT A 5 MIN"), b.display.row(0U));
  TEST_ASSERT_EQUAL_UINT16(0U, b.display.droppedChars());
}

void test_box_reports_an_overrun_on_the_pass_after_it_recovers(void) {
  Box b(kBaseMid);

  // The driver accepts the call and writes nothing, while writable() keeps
  // reporting space — a real driver does not know it is failing, so the code
  // above it cannot "handle" this by asking first.
  b.bridge.setWriteFailure(true);
  feedFrame(b.bridge, proto::Frame::ping());
  b.clock.setNow(kBaseMid + 1U);
  b.box.poll();
  TEST_ASSERT_TRUE(b.box.droppedTxFrames() > 0U);
  TEST_ASSERT_FALSE(sentLineStarting(b.bridge, "!PONG,"));

  b.bridge.setWriteFailure(false);
  b.step(kBaseMid + 2U);
  TEST_ASSERT_TRUE(sentLineStarting(b.bridge, "!EVT,OVERRUN"));
  // Whole frames or none: a fragment would fail the peer's checksum AND be
  // read as the head of the next frame.
  TEST_ASSERT_EQUAL_UINT8(0U, b.bridge.partialLineLen());
}

void test_box_samples_the_clock_once_per_pass(void) {
  Box b(kBaseMid);

  b.clock.resetReads();
  b.box.poll();
  // Two sub-steps evaluated against two different instants is the bug class
  // this assertion exists to catch.
  TEST_ASSERT_EQUAL_UINT32(1U, b.clock.reads());
}

// --- runner ----------------------------------------------------------------

void setUp(void) {
}

void tearDown(void) {
}

/// A commanded release is reported, not just performed.
///
/// applyOff opened the relay and told nobody. The bridge has always tested for
/// `!EVT,OFF,<court>` by name — handleMegaEvent looks for it alongside AUTOOFF —
/// but the Mega only ever sent AUTOOFF, so a member who finished early and
/// pressed release produced no release event at all and the session looked to
/// the club like it had run its full booked length. That is the opposite of what
/// the Mega's own timer exists to record.
void test_box_a_commanded_off_reports_the_release(void) {
  Box b(kBaseMid);

  feedFrame(b.bridge, proto::Frame::on(proto::Court::C, 900U));
  b.step(kBaseMid + 1U);
  TEST_ASSERT_TRUE(b.relay.isOn(kCourtC));

  feedFrame(b.bridge, proto::Frame::off(proto::Court::C));
  b.step(kBaseMid + 2U);

  TEST_ASSERT_FALSE(b.relay.isOn(kCourtC));
  TEST_ASSERT_TRUE(sentLineStarting(b.bridge, "!EVT,OFF,C"));
}

/// A duration too large for a uint16_t must clamp, not truncate.
///
/// Frame::on took a uint16_t while the clamp inside took a uint32_t, so the
/// narrowing happened at the call site and the clamp then saw a small number and
/// passed it through. 65,536 seconds became 0 and was raised to the one-second
/// minimum: a court lit for a second on a booking of eighteen hours. Both
/// failures are short rather than long, so neither could hold a court on — but a
/// member standing in the dark is still a support call.
void test_box_a_duration_past_a_uint16_clamps_rather_than_wrapping(void) {
  Box b(kBaseMid);

  // 65,536 s + 900 s. Truncated it is 900; clamped it is the hard cap.
  feedFrame(b.bridge, proto::Frame::on(proto::Court::A, 66436U));
  b.step(kBaseMid + 1U);

  TEST_ASSERT_TRUE(b.relay.isOn(kCourtA));
  TEST_ASSERT_TRUE(sentLineStarting(b.bridge, "!STATE,1,5400,0,0,0"));
}

// --- scan feedback (review A2-14) -------------------------------------------
//
// The sketch this replaces painted "VERIFYING..." on every scan before any
// answer existed. v2 moved every scan-path LCD write onto the ESP, so with the
// bridge dead a scan produced no visible change at all and members re-scanned
// until they reported the scanner as broken. The Mega now acknowledges locally
// and lets the bridge's answer overwrite it.

void test_box_a_scan_is_acknowledged_on_the_glass_before_any_answer(void) {
  Box b(kBaseMid);

  TEST_ASSERT_TRUE(b.scanner.feed("MEM-0042\r\n"));
  b.step(kBaseMid + 1U);

  TEST_ASSERT_EQUAL_STRING(padded(courtlogic::kScanFeedbackLine1), b.display.row(0U));
  TEST_ASSERT_EQUAL_STRING(padded(courtlogic::kScanFeedbackLine2), b.display.row(1U));
  // Both inside the sixteen columns the club's 16x2 shows: the old
  // "CHECKING YOUR CODE" clipped to "CHECKING YOUR CO" there.
  TEST_ASSERT_EQUAL_STRING("CHECKING CODE", courtlogic::kScanFeedbackLine1);
  TEST_ASSERT_EQUAL_STRING("PLEASE WAIT", courtlogic::kScanFeedbackLine2);
  TEST_ASSERT_TRUE(strlen(courtlogic::kScanFeedbackLine1) <= court::kSafeSubsetCols);
  TEST_ASSERT_TRUE(strlen(courtlogic::kScanFeedbackLine2) <= court::kSafeSubsetCols);
  TEST_ASSERT_TRUE(sentLineStarting(b.bridge, "!SCAN,MEM-0042"));
}

void test_box_a_dead_bridge_still_gets_the_scan_acknowledged(void) {
  Box b(kBaseMid);

  // The ESP is gone: the frame cannot be sent. That is exactly when the member
  // most needs to see that the scanner heard them.
  b.bridge.setConnected(false);
  TEST_ASSERT_TRUE(b.scanner.feed("MEM-0042\r\n"));
  b.step(kBaseMid + 1U);

  TEST_ASSERT_TRUE(b.box.droppedTxFrames() > 0U);
  TEST_ASSERT_EQUAL_STRING(padded(courtlogic::kScanFeedbackLine1), b.display.row(0U));
}

void test_box_the_bridges_answer_replaces_the_acknowledgement_and_then_leaves(void) {
  Box b(kBaseMid);

  TEST_ASSERT_TRUE(b.scanner.feed("MEM-0042\r\n"));
  b.step(kBaseMid + 1U);

  feedFrame(b.bridge, proto::Frame::lcd("COURT A", "45 MIN"));
  b.step(kBaseMid + 800U);
  TEST_ASSERT_EQUAL_STRING(padded("COURT A"), b.display.row(0U));

  // The answer keeps its OWN hold rather than inheriting the acknowledgement's,
  // so it is still up a second before its deadline...
  b.step(kBaseMid + 800U + courtlogic::kDefaultHoldMs - 1U);
  TEST_ASSERT_EQUAL_STRING(padded("COURT A"), b.display.row(0U));

  // ...and gone a millisecond after it. It used to STAY: the bridge's repaint
  // disarmed the Mega's only timer, so every screen the bridge painted was
  // permanent. That is the whole of D1-1 and it is asserted here rather than
  // assumed.
  b.step(kBaseMid + 800U + courtlogic::kDefaultHoldMs);
  TEST_ASSERT_EQUAL_STRING(padded(courtlogic::kIdleLine1), b.display.row(0U));
  TEST_ASSERT_EQUAL_STRING(padded(courtlogic::kIdleLine2), b.display.row(1U));
}

void test_box_silence_after_a_scan_returns_to_idle_at_ten_seconds(void) {
  for (size_t i = 0; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    Box b(base);

    TEST_ASSERT_TRUE(b.scanner.feed("MEM-0042\r\n"));
    b.step(base);
    TEST_ASSERT_EQUAL_STRING(padded(courtlogic::kScanFeedbackLine1), b.display.row(0U));

    // Still waiting one millisecond before the deadline — across the wrap for
    // the two wrap bases, where a naive comparison would repaint immediately
    // or never.
    b.step(base + courtlogic::kDefaultHoldMs - 1U);
    TEST_ASSERT_EQUAL_STRING(padded(courtlogic::kScanFeedbackLine1), b.display.row(0U));

    b.step(base + courtlogic::kDefaultHoldMs);
    TEST_ASSERT_EQUAL_STRING(padded(courtlogic::kIdleLine1), b.display.row(0U));
    TEST_ASSERT_EQUAL_STRING(padded(courtlogic::kIdleLine2), b.display.row(1U));
  }
}

// --- D1-1: no screen outlives its hold, whatever painted it -----------------
//
// The regression test for the stuck screen, and it runs for EVERY verb the
// bridge can send rather than for the one that broke. That is the point of
// moving the deadline onto this half: a screen added next year inherits it
// without anybody remembering to add a timeout to it.

void test_box_a_refusal_plus_auth_zero_still_leaves_the_glass(void) {
  // The exact sequence the bridge emits for reason=not_recognised, which stood
  // on the panel for fifty seconds with every button dead behind it.
  for (size_t i = 0; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    Box b(base);

    TEST_ASSERT_TRUE(b.scanner.feed("RANDOMRECEIPT42\r\n"));
    b.step(base + 1U);

    feedFrame(b.bridge, proto::Frame::lcd("CODE NOT RECOGNISED", "THEN SCAN AGAIN"));
    feedFrame(b.bridge, proto::Frame::auth(0U));
    b.step(base + 2U);
    TEST_ASSERT_EQUAL_STRING(padded("CODE NOT RECOGNISED"), b.display.row(0U));

    // `!AUTH,0` disarms WITHOUT a lapse edge — that is documented behaviour and
    // is not what changed. What changed is that it is no longer the only thing
    // standing between a member and the landing screen.
    TEST_ASSERT_FALSE(b.box.auth().allows(base + 3U));

    b.step(base + 2U + courtlogic::kDefaultHoldMs);
    TEST_ASSERT_EQUAL_STRING(padded(courtlogic::kIdleLine1), b.display.row(0U));
  }
}

void test_box_no_screen_from_any_verb_outlives_two_minutes(void) {
  const uint32_t base = kBaseWrapSoon;
  const uint32_t ceilingMs = static_cast<uint32_t>(proto::kShowHoldMaxSeconds) * 1000UL;

  // Every downlink shape that can put words on the glass, including one asking
  // for a hold of 0xFFFFFFFF seconds and one from a bridge that only ever
  // learned `!LCD`.
  for (uint8_t shape = 0U; shape < 4U; ++shape) {
    Box b(base);
    if (shape == 0U) {
      feedFrame(b.bridge, proto::Frame::lcd("STUCK", "FOREVER"));
    } else if (shape == 1U) {
      feedFrame(b.bridge, proto::Frame::row(0U, "STUCK"));
      feedFrame(b.bridge, proto::Frame::show(0xFFFFFFFFU, 0U));
    } else if (shape == 2U) {
      feedFrame(b.bridge, proto::Frame::row(0U, "STUCK"));
      feedFrame(b.bridge, proto::Frame::show(0U, 1U));
    } else {
      feedFrame(b.bridge, proto::Frame::lcd("STUCK", "FOREVER"));
      feedFrame(b.bridge, proto::Frame::auth(0U));
    }
    b.step(base + 1U);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(padded("STUCK"), b.display.row(0U), "the overlay never appeared");

    b.step(base + 1U + ceilingMs + 1000U);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(padded(courtlogic::kIdleLine1), b.display.row(0U),
                                     "a screen outlived the two-minute ceiling");
  }
}

void test_box_a_press_re_arms_the_hold_rather_than_losing_the_screen(void) {
  Box b(kBaseMid);

  feedFrame(b.bridge, proto::Frame::auth(600U));
  feedFrame(b.bridge, proto::Frame::row(0U, "COURT A"));
  feedFrame(b.bridge, proto::Frame::row(1U, "HOW LONG?"));
  feedFrame(b.bridge, proto::Frame::show(20U, courtlogic::kShowCountdown));
  // Two passes: the Mega drains at most kBytesPerPass from the link per pass,
  // which is a real bound and not a test artefact — four frames is more than
  // sixty-four bytes, so the commit lands on the second pass exactly as it
  // would on the board.
  b.step(kBaseMid + 1U);
  b.step(kBaseMid + 2U);
  TEST_ASSERT_EQUAL_STRING(padded("COURT A"), b.display.row(0U));

  // Nineteen seconds of reading, then a press. The choice must not be taken
  // away under somebody part-way through making it.
  b.buttons.press(0U);
  b.step(kBaseMid + 19000U);
  b.step(kBaseMid + 19000U + courtlogic::kDebounceMs);
  b.buttons.release(0U);

  // The original deadline was 20 s from t=2; a screen that had not been
  // re-armed is long gone by here.
  b.step(kBaseMid + 38000U);
  TEST_ASSERT_EQUAL_STRING(padded("COURT A"), b.display.row(0U));

  b.step(kBaseMid + 19000U + courtlogic::kDebounceMs + 20001U);
  TEST_ASSERT_EQUAL_STRING(padded(courtlogic::kIdleLine1), b.display.row(0U));
}

void test_box_the_button_window_closing_does_not_take_the_screen_away(void) {
  // D1-5's second half. The authorisation window and the screen are two
  // different deadlines about two different things — one is about BUTTONS, the
  // other about WORDS — and the lapse used to repaint the landing screen over
  // whatever was there. Thirty seconds after a grant, a member reading
  // `COURT A IS ON / 45 MINUTES` had it replaced mid-sentence, and not
  // atomically: `CRUSADERS COURTS / 45 MIN` was on the glass for one I2C write.
  for (size_t i = 0; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    Box b(base);

    feedFrame(b.bridge, proto::Frame::row(0U, "COURT A IS ON"));
    feedFrame(b.bridge, proto::Frame::row(1U, "45 MINUTES"));
    b.step(base + 1U);
    feedFrame(b.bridge, proto::Frame::show(60U, 0U));
    feedFrame(b.bridge, proto::Frame::auth(5U));
    b.step(base + 2U);
    TEST_ASSERT_EQUAL_STRING(padded("COURT A IS ON"), b.display.row(0U));

    // The window lapses on its own and says so on the wire.
    b.step(base + 6000U);
    TEST_ASSERT_TRUE(sentLineStarting(b.bridge, "!EVT,AUTHEXPIRED"));
    TEST_ASSERT_FALSE(b.box.auth().allows(base + 6000U));

    // And the screen is untouched: it has fifty-four seconds of its own left.
    TEST_ASSERT_EQUAL_STRING_MESSAGE(padded("COURT A IS ON"), b.display.row(0U),
                                     "the button window took the screen away");
    TEST_ASSERT_EQUAL_STRING(padded("45 MINUTES"), b.display.row(1U));
  }
}

// --- D1-4: a press the box cannot act on says so ---------------------------

void test_box_a_dropped_press_paints_a_hint_and_is_rate_limited(void) {
  Box b(kBaseMid);

  // The window is shut: a DURATION press is correctly dropped and correctly
  // counted (a court press is forwarded instead — Mega 2.1.0).
  b.buttons.press(kFirstDurationKey);
  b.step(kBaseMid + 10U);
  b.step(kBaseMid + 10U + courtlogic::kDebounceMs);
  TEST_ASSERT_EQUAL_UINT16(1U, b.box.unauthorisedPresses());
  TEST_ASSERT_FALSE(sentLineStarting(b.bridge, "!BTN"));

  // What is new is that the member can tell the difference between a dropped
  // press and a dead box — on row 3 of the 20x4, and on row 1, which is the
  // only row besides the scan prompt a 16x2 shows.
  TEST_ASSERT_EQUAL_STRING(padded("SCAN YOUR CODE FIRST"), b.display.row(3U));
  TEST_ASSERT_EQUAL_STRING(padded(courtlogic::kHintLine), b.display.row(1U));
  TEST_ASSERT_EQUAL_STRING(padded(courtlogic::kIdleLine1), b.display.row(0U));
  TEST_ASSERT_TRUE(strlen(courtlogic::kHintLine) <= court::kSafeSubsetCols);

  // A second press inside the rate limit paints nothing more — a jammed contact
  // must not strobe the glass or flood the I2C bus at loop rate.
  b.buttons.release(kFirstDurationKey);
  b.step(kBaseMid + 200U);
  b.step(kBaseMid + 200U + courtlogic::kDebounceMs);
  b.buttons.press(kFirstDurationKey);
  b.step(kBaseMid + 400U);
  b.step(kBaseMid + 400U + courtlogic::kDebounceMs);
  TEST_ASSERT_EQUAL_UINT16(1U, b.box.screens().suppressedHints());
  TEST_ASSERT_EQUAL_UINT16(2U, b.box.unauthorisedPresses());

  // And it reverts on its own, back to the rows underneath it.
  b.buttons.release(kFirstDurationKey);
  b.step(kBaseMid + 600U);
  b.step(kBaseMid + courtlogic::kHintMs + 1200U);
  TEST_ASSERT_EQUAL_STRING(padded("READY"), b.display.row(3U));
  TEST_ASSERT_EQUAL_STRING(padded(courtlogic::kIdleLine2), b.display.row(1U));
}

// --- D1-5: a lit court is visible ------------------------------------------

void test_box_the_landing_screen_shows_what_is_burning(void) {
  Box b(kBaseMid);

  const int16_t numbers[4] = {1, 2, 3, 4};
  feedFrame(b.bridge, proto::Frame::map(numbers));
  feedFrame(b.bridge, proto::Frame::on(proto::Court::A, 2700U));
  b.step(kBaseMid + 1U);
  b.step(kBaseMid + 1100U);

  // Forty-five minutes on court A, rendered locally from the relay deadline. It
  // costs no serial traffic at all: the Mega already knows.
  TEST_ASSERT_EQUAL_STRING(padded("A 45 B -- C -- D --"), b.display.row(2U));

  b.step(kBaseMid + 61100U);
  TEST_ASSERT_EQUAL_STRING(padded("A 44 B -- C -- D --"), b.display.row(2U));

  // Thirty seconds after a grant the authorisation window lapses. It used to
  // paint the landing screen straight over the grant — and not atomically, so
  // `CRUSADERS COURTS / 45 MIN` was on the glass for one I2C write. Now the
  // grant's own hold has already taken it away and the court is still visible.
  TEST_ASSERT_EQUAL_STRING(padded(courtlogic::kIdleLine1), b.display.row(0U));
}

/// Mega 2.1.0. The landing screen LEADS with the call to action, because the
/// club's panel is a 16x2 and rows 2-3 are off-glass there: row 0 is SCAN YOUR
/// CODE, and row 1 is TO PLAY while every court is dark or the lit courts'
/// minutes left while any is lit — one court as a sentence, several as cells.
void test_box_the_landing_screen_leads_with_scan_your_code(void) {
  for (size_t i = 0; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    Box b(base);

    TEST_ASSERT_EQUAL_STRING("SCAN YOUR CODE", courtlogic::kIdleLine1);
    TEST_ASSERT_EQUAL_STRING("TO PLAY", courtlogic::kIdleLine2);
    TEST_ASSERT_EQUAL_STRING(padded("SCAN YOUR CODE"), b.display.row(0U));
    TEST_ASSERT_EQUAL_STRING(padded("TO PLAY"), b.display.row(1U));

    // One lit court: a sentence. 2700 s is 45 minutes.
    feedFrame(b.bridge, proto::Frame::on(proto::Court::B, 2700U));
    b.step(base + 1U);
    b.step(base + 1100U);
    TEST_ASSERT_EQUAL_STRING(padded("SCAN YOUR CODE"), b.display.row(0U));
    TEST_ASSERT_EQUAL_STRING(padded("COURT B 45 MIN"), b.display.row(1U));

    // Two: four-column cells, letter then minutes, rounded UP — 240 s is 4
    // minutes, and a single digit is right-aligned in its cell.
    feedFrame(b.bridge, proto::Frame::on(proto::Court::D, 240U));
    b.step(base + 1101U);
    b.step(base + 2200U);
    TEST_ASSERT_EQUAL_STRING(padded("B45 D 4"), b.display.row(1U));

    // All four fit sixteen columns.
    feedFrame(b.bridge, proto::Frame::on(proto::Court::A, 5400U));
    feedFrame(b.bridge, proto::Frame::on(proto::Court::C, 30U));
    b.step(base + 2201U);
    b.step(base + 3300U);
    TEST_ASSERT_EQUAL_STRING(padded("A90 B45 C 1 D 4"), b.display.row(1U));
    TEST_ASSERT_TRUE(strlen("A90 B45 C 1 D 4") <= court::kSafeSubsetCols);

    // Back to one, with a single-digit remainder: the pad space is closed up
    // ("COURT D 4 MIN", never "COURT D  4 MIN"). A, B and C go off.
    feedFrame(b.bridge, proto::Frame::off(proto::Court::A));
    feedFrame(b.bridge, proto::Frame::off(proto::Court::B));
    feedFrame(b.bridge, proto::Frame::off(proto::Court::C));
    b.step(base + 3301U);
    b.step(base + 4400U);
    TEST_ASSERT_EQUAL_STRING(padded("COURT D 4 MIN"), b.display.row(1U));

    // And dark again: TO PLAY.
    feedFrame(b.bridge, proto::Frame::off(proto::Court::D));
    b.step(base + 4401U);
    b.step(base + 5500U);
    TEST_ASSERT_EQUAL_STRING(padded("TO PLAY"), b.display.row(1U));
  }
}

/// An overlay's hold ending puts the LANDING rows back — summary included — not
/// whatever the overlay staged.
void test_box_the_landing_summary_returns_when_an_overlay_leaves(void) {
  Box b(kBaseMid);
  feedFrame(b.bridge, proto::Frame::on(proto::Court::C, 1800U));
  feedFrame(b.bridge, proto::Frame::lcd("HI DEAN", "BALANCE 120 MIN"));
  b.step(kBaseMid + 1U);
  TEST_ASSERT_EQUAL_STRING(padded("BALANCE 120 MIN"), b.display.row(1U));

  b.step(kBaseMid + 1U + courtlogic::kDefaultHoldMs);
  TEST_ASSERT_EQUAL_STRING(padded(courtlogic::kIdleLine1), b.display.row(0U));
  TEST_ASSERT_EQUAL_STRING(padded("COURT C 30 MIN"), b.display.row(1U));
}

void test_box_an_unmapped_relay_is_blank_not_a_dark_court(void) {
  Box b(kBaseMid);

  // Two courts only. A dash on C and D would claim the box drives them.
  const int16_t numbers[4] = {1, 2, 0, 0};
  feedFrame(b.bridge, proto::Frame::map(numbers));
  b.step(kBaseMid + 1U);
  b.step(kBaseMid + 1100U);
  TEST_ASSERT_EQUAL_STRING(padded("A -- B --"), b.display.row(2U));
}

// --- the action row is honest about the link -------------------------------

void test_box_the_action_row_says_which_thing_is_missing(void) {
  Box b(kBaseMid);
  uint32_t at = kBaseMid;

  struct Case {
    uint8_t flags;
    const char* hhmm;
    const char* expectLeft;
  };

  const Case cases[] = {
      {courtlogic::kLinkWifiUp | courtlogic::kLinkApiUp, proto::kNoClock, "READY"},
      {courtlogic::kLinkWifiUp, proto::kNoClock, "READY NO SERVER"},
      {0U, proto::kNoClock, "READY NO WIFI"},
      {courtlogic::kLinkWifiUp | courtlogic::kLinkApiUp | courtlogic::kLinkRestorePending, proto::kNoClock,
       "STARTING UP"},
  };
  for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
    feedFrame(b.bridge, proto::Frame::idle(cases[i].flags, cases[i].hhmm));
    at += 1100U;
    b.step(at);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(padded(cases[i].expectLeft), b.display.row(3U), cases[i].expectLeft);
  }
}

void test_box_an_untrusted_clock_is_blank_not_stale(void) {
  Box b(kBaseMid);

  feedFrame(b.bridge,
            proto::Frame::idle(courtlogic::kLinkWifiUp | courtlogic::kLinkApiUp | courtlogic::kLinkClockValid,
                               "1942"));
  b.step(kBaseMid + 1100U);
  TEST_ASSERT_EQUAL_STRING(padded("READY          19:42"), b.display.row(3U));

  // Advanced locally between heartbeats: the box has no RTC, but it does have
  // millis(), and a clock that only moves once a minute-and-a-half reads as a
  // frozen one.
  b.step(kBaseMid + 1100U + 180000U);
  TEST_ASSERT_EQUAL_STRING(padded("READY          19:45"), b.display.row(3U));

  // The bridge stops trusting it. Blank, never the last value it had: loading,
  // failed and empty are three different states and only one of them lies.
  feedFrame(b.bridge, proto::Frame::idle(courtlogic::kLinkWifiUp | courtlogic::kLinkApiUp, proto::kNoClock));
  b.step(kBaseMid + 1100U + 181100U);
  TEST_ASSERT_EQUAL_STRING(padded("READY"), b.display.row(3U));
}

void test_box_a_screen_is_committed_in_one_piece(void) {
  Box b(kBaseMid);
  b.display.resetCounters();

  feedFrame(b.bridge, proto::Frame::row(0U, "COURT B IS ON"));
  feedFrame(b.bridge, proto::Frame::row(1U, "45 MINUTES"));
  feedFrame(b.bridge, proto::Frame::row(2U, "Ends 20:27"));
  feedFrame(b.bridge, proto::Frame::row(3U, "ENJOY YOUR GAME"));
  b.step(kBaseMid + 1U);

  // Four staged rows and nothing on the glass yet: `!ROW` paints nothing, which
  // is what makes the commit atomic.
  TEST_ASSERT_EQUAL_UINT16(0U, b.display.printCalls());

  feedFrame(b.bridge, proto::Frame::show(10U, courtlogic::kShowCountdown));
  b.step(kBaseMid + 2U);
  TEST_ASSERT_EQUAL_STRING(padded("COURT B IS ON"), b.display.row(0U));
  TEST_ASSERT_EQUAL_STRING(padded("45 MINUTES"), b.display.row(1U));
  TEST_ASSERT_EQUAL_STRING(padded("Ends 20:27"), b.display.row(2U));
  TEST_ASSERT_EQUAL_STRING("ENJOY YOUR GAME   10", b.display.row(3U));

  // The countdown says what it MEANS in the last five seconds, which is GOAL
  // item 18's rapid-scan window made visible without a second state.
  b.step(kBaseMid + 2U + 6000U);
  TEST_ASSERT_EQUAL_STRING("READY IN 4 s       4", b.display.row(3U));
}

/// R19 (bridge side). The Mega COMMITS every staged row on `!SHOW`, and a row
/// nobody restaged keeps the previous screen's text. The bridge skipped empty
/// rows, so ONE MOMENT after CHOOSE TIME read "Press a black button" under
/// "Buying your time". An EMPTY `!ROW` survives the wire and blanks the row,
/// which is what the bridge now sends for every row it means to leave blank.
void test_box_an_empty_row_blanks_what_the_last_screen_staged(void) {
  Box b(kBaseMid);
  feedFrame(b.bridge, proto::Frame::row(0U, "COURT A"));
  feedFrame(b.bridge, proto::Frame::row(2U, "Press a black button"));
  b.step(kBaseMid + 1U);
  feedFrame(b.bridge, proto::Frame::show(20U, 0U));
  b.step(kBaseMid + 2U);
  TEST_ASSERT_EQUAL_STRING(padded("Press a black button"), b.display.row(2U));

  feedFrame(b.bridge, proto::Frame::row(0U, "ONE MOMENT"));
  b.step(kBaseMid + 3U);
  feedFrame(b.bridge, proto::Frame::show(6U, 0U));
  b.step(kBaseMid + 4U);
  // Not restaged: the old words stay. This is the Mega's contract, unchanged.
  TEST_ASSERT_EQUAL_STRING(padded("Press a black button"), b.display.row(2U));

  feedFrame(b.bridge, proto::Frame::row(0U, "ONE MOMENT"));
  feedFrame(b.bridge, proto::Frame::row(2U, ""));
  b.step(kBaseMid + 5U);
  feedFrame(b.bridge, proto::Frame::show(6U, 0U));
  b.step(kBaseMid + 6U);
  TEST_ASSERT_EQUAL_STRING(padded(""), b.display.row(2U));
}

void test_box_a_countdown_never_eats_the_action_rows_last_character(void) {
  Box b(kBaseMid);

  // The two halves of this board agree on the action row through a CONTRACT
  // rather than through a shared constant: the bridge holds row 3 to
  // court::kSafeSubsetCols and this half puts the countdown to the right of it.
  // They disagreed by one column — the clock is five characters wide and the
  // countdown is at most three — and a five-column countdown zone silently ate
  // the sixteenth character of every screen that carried one.
  const char* action = "PRESS A BUTTON!!";
  TEST_ASSERT_EQUAL_size_t(court::kSafeSubsetCols, strlen(action));

  feedFrame(b.bridge, proto::Frame::row(0U, "COURT A IS ON"));
  feedFrame(b.bridge, proto::Frame::row(3U, action));
  b.step(kBaseMid + 1U);
  feedFrame(b.bridge, proto::Frame::show(99U, courtlogic::kShowCountdown));
  b.step(kBaseMid + 2U);

  TEST_ASSERT_EQUAL_STRING("PRESS A BUTTON!!  99", b.display.row(3U));

  // And the widest count it can ever show — the two-minute ceiling — still
  // fits beside it.
  feedFrame(b.bridge, proto::Frame::row(3U, action));
  b.step(kBaseMid + 3U);
  feedFrame(b.bridge, proto::Frame::show(120U, courtlogic::kShowCountdown));
  b.step(kBaseMid + 4U);
  TEST_ASSERT_EQUAL_STRING("PRESS A BUTTON!! 120", b.display.row(3U));
}

void test_box_a_scan_pre_empts_a_screen_that_is_still_counting_down(void) {
  Box b(kBaseMid);

  feedFrame(b.bridge, proto::Frame::lcd("COURT B IS ON", "45 MINUTES"));
  b.step(kBaseMid + 1U);
  TEST_ASSERT_EQUAL_STRING(padded("COURT B IS ON"), b.display.row(0U));

  // Three seconds in, the next member scans. The countdown is INFORMATION, not
  // a gate: nothing is blocked and the answer is immediate.
  TEST_ASSERT_TRUE(b.scanner.feed("MEM-0043\r\n"));
  b.step(kBaseMid + 3000U);
  TEST_ASSERT_EQUAL_STRING(padded(courtlogic::kScanFeedbackLine1), b.display.row(0U));
  TEST_ASSERT_TRUE(sentLineStarting(b.bridge, "!SCAN,MEM-0043"));
}

void test_box_an_oversize_scan_is_reported_not_only_counted(void) {
  Box b(kBaseMid);

  // Longer than a `!SCAN` argument can carry. REFUSED, never truncated: a
  // truncated member code identifies a DIFFERENT member, and the one thing
  // worse than a scan nobody can read is a scan read as somebody else.
  char oversize[proto::kMaxArgLen + 8U];
  for (size_t i = 0U; i < sizeof(oversize) - 3U; ++i) {
    oversize[i] = '9';
  }
  oversize[sizeof(oversize) - 3U] = '\r';
  oversize[sizeof(oversize) - 2U] = '\n';
  oversize[sizeof(oversize) - 1U] = '\0';
  TEST_ASSERT_TRUE(b.scanner.feed(oversize));
  b.step(kBaseMid + 1U);

  TEST_ASSERT_EQUAL_UINT16(1U, b.box.oversizeScans());
  TEST_ASSERT_FALSE_MESSAGE(sentLineStarting(b.bridge, "!SCAN"),
                            "a code that did not fit went out truncated");
  // It was counted and nothing could read it, and the count could never even
  // move: it only ever incremented on proto::Frame::scan refusing a code, and
  // ScanAssembler's cap is the SAME constant, so the assembler refuses first
  // and feed() never completes. A scanner emitting long payloads produced no
  // frame, no count and no record of any kind.
  // The count nothing off the board could read. It does not fit `!PONG`, which
  // is at kMaxArgs exactly with the three it already carries, and a scanner
  // that has started emitting long payloads is rare enough to be event-shaped.
  TEST_ASSERT_TRUE(sentLineStarting(b.bridge, "!EVT,OVERSIZE,1"));

  // The member sees nothing, deliberately: this is a scanner fault, and
  // telling somebody holding a racquet that their code was too long sends them
  // to the desk for something they cannot fix.
  TEST_ASSERT_EQUAL_STRING(padded(courtlogic::kIdleLine1), b.display.row(0U));
}

void test_box_a_corrupt_scanner_line_is_reported_under_its_own_name(void) {
  Box b(kBaseMid);

  // A byte outside the payload set on a 9600 baud line: a cable, a connector,
  // or interference. TWO names rather than one, because OVERSIZE and SCANJUNK
  // are two different site visits — and the second is the one that explains a
  // member whose code "sometimes does not work".
  TEST_ASSERT_TRUE(b.scanner.feed("MEM-\x01\x02 0042\r\n"));
  b.step(kBaseMid + 1U);

  TEST_ASSERT_EQUAL_UINT16(1U, b.box.corruptScans());
  TEST_ASSERT_EQUAL_UINT16(0U, b.box.oversizeScans());
  TEST_ASSERT_TRUE(sentLineStarting(b.bridge, "!EVT,SCANJUNK,1"));
  TEST_ASSERT_FALSE(sentLineStarting(b.bridge, "!SCAN"));

  // The good scan after it still works: one bad line costs that line.
  TEST_ASSERT_TRUE(b.scanner.feed("MEM-0042\r\n"));
  b.step(kBaseMid + 2U);
  TEST_ASSERT_TRUE(sentLineStarting(b.bridge, "!SCAN,MEM-0042"));
  TEST_ASSERT_EQUAL_UINT16(1U, b.box.corruptScans());
}

void test_box_pong_carries_the_counters_nothing_could_read(void) {
  Box b(kBaseMid);

  // A duration press with the window shut — the one press still thrown away.
  b.buttons.press(kFirstDurationKey);
  b.step(kBaseMid + 10U);
  b.step(kBaseMid + 10U + courtlogic::kDebounceMs);
  TEST_ASSERT_EQUAL_UINT16(1U, b.box.unauthorisedPresses());

  feedRaw(b.bridge, "GARBAGE\n");
  b.step(kBaseMid + 200U);

  feedFrame(b.bridge, proto::Frame::ping());
  b.step(kBaseMid + 300U);
  TEST_ASSERT_TRUE(sentLineStarting(b.bridge, "!PONG,"));

  // version, uptime, txDropped, rxErrors, unauthorised — five arguments, at
  // kMaxArgs exactly.
  const char* pong = nullptr;
  for (uint8_t i = 0U; i < b.bridge.lineCount(); ++i) {
    if (strncmp(b.bridge.line(i), "!PONG,", 6U) == 0) {
      pong = b.bridge.line(i);
    }
  }
  TEST_ASSERT_NOT_NULL(pong);
  uint8_t commas = 0U;
  for (size_t i = 0U; pong[i] != '\0' && pong[i] != '*'; ++i) {
    if (pong[i] == ',') {
      ++commas;
    }
  }
  TEST_ASSERT_EQUAL_UINT8(5U, commas);
  TEST_ASSERT_EQUAL_UINT16(1U, b.box.rxErrors());
}

int main(int, char**) {
  UNITY_BEGIN();

  RUN_TEST(test_box_a_scan_is_acknowledged_on_the_glass_before_any_answer);
  RUN_TEST(test_box_a_court_key_with_the_window_shut_is_forwarded_and_not_counted);
  RUN_TEST(test_box_a_court_and_a_duration_key_together_split_with_the_window_shut);
  RUN_TEST(test_box_the_mega_paints_its_own_hint_when_the_bridge_does_not_answer);
  RUN_TEST(test_box_a_bridge_answer_inside_the_grace_cancels_the_fallback);
  RUN_TEST(test_box_a_court_key_the_link_cannot_carry_is_hinted_at_once);
  RUN_TEST(test_box_an_accepted_ext_publishes_state_at_once);
  RUN_TEST(test_box_the_landing_screen_leads_with_scan_your_code);
  RUN_TEST(test_box_the_landing_summary_returns_when_an_overlay_leaves);
  RUN_TEST(test_relay_guard_drives_the_active_high_level_for_the_solid_state_relays);
  RUN_TEST(test_box_a_dead_bridge_still_gets_the_scan_acknowledged);
  RUN_TEST(test_box_the_bridges_answer_replaces_the_acknowledgement_and_then_leaves);
  RUN_TEST(test_box_a_refusal_plus_auth_zero_still_leaves_the_glass);
  RUN_TEST(test_box_no_screen_from_any_verb_outlives_two_minutes);
  RUN_TEST(test_box_a_press_re_arms_the_hold_rather_than_losing_the_screen);
  RUN_TEST(test_box_the_button_window_closing_does_not_take_the_screen_away);
  RUN_TEST(test_box_a_dropped_press_paints_a_hint_and_is_rate_limited);
  RUN_TEST(test_box_the_landing_screen_shows_what_is_burning);
  RUN_TEST(test_box_an_unmapped_relay_is_blank_not_a_dark_court);
  RUN_TEST(test_box_the_action_row_says_which_thing_is_missing);
  RUN_TEST(test_box_an_untrusted_clock_is_blank_not_stale);
  RUN_TEST(test_box_a_screen_is_committed_in_one_piece);
  RUN_TEST(test_box_an_empty_row_blanks_what_the_last_screen_staged);
  RUN_TEST(test_box_a_countdown_never_eats_the_action_rows_last_character);
  RUN_TEST(test_box_a_scan_pre_empts_a_screen_that_is_still_counting_down);
  RUN_TEST(test_box_an_oversize_scan_is_reported_not_only_counted);
  RUN_TEST(test_box_a_corrupt_scanner_line_is_reported_under_its_own_name);
  RUN_TEST(test_box_pong_carries_the_counters_nothing_could_read);
  RUN_TEST(test_box_silence_after_a_scan_returns_to_idle_at_ten_seconds);

  RUN_TEST(test_relay_guard_drives_the_active_low_level);
  RUN_TEST(test_relay_guard_releases_at_the_deadline_at_every_base);
  RUN_TEST(test_relay_guard_releases_across_the_millis_wrap);
  RUN_TEST(test_relay_guard_caps_a_longer_request_at_ninety_minutes);
  RUN_TEST(test_relay_guard_saturates_rather_than_wrapping_the_conversion);
  RUN_TEST(test_relay_guard_zero_seconds_is_not_an_indefinite_on);
  RUN_TEST(test_relay_guard_off_disarms_the_timer);
  RUN_TEST(test_relay_guard_extend_is_refused_on_an_open_relay);
  RUN_TEST(test_relay_guard_extend_moves_the_deadline_and_is_capped);
  RUN_TEST(test_relay_guard_all_off_disarms_every_timer);
  RUN_TEST(test_relay_guard_remaining_seconds_rounds_down);
  RUN_TEST(test_relay_guard_ignores_channels_that_do_not_exist);

  RUN_TEST(test_button_press_needs_the_whole_window_after_the_chatter_stops);
  RUN_TEST(test_button_bounce_that_never_settles_is_never_a_press);
  RUN_TEST(test_button_debounce_survives_the_millis_wrap);
  RUN_TEST(test_two_buttons_settling_on_one_pass_are_both_reported);
  RUN_TEST(test_button_release_then_press_is_a_second_press);

  RUN_TEST(test_scan_assembles_a_code_across_fragments);
  RUN_TEST(test_scan_crlf_is_one_terminator);
  RUN_TEST(test_scan_blank_lines_are_not_events);
  RUN_TEST(test_scan_refuses_an_over_long_code_rather_than_truncating);
  RUN_TEST(test_scan_a_control_byte_poisons_the_line);
  RUN_TEST(test_scan_reset_abandons_a_partial_line);

  RUN_TEST(test_auth_window_allows_only_while_armed);
  RUN_TEST(test_auth_lapse_is_an_edge_not_a_level);
  RUN_TEST(test_auth_zero_disarms_and_disarm_is_silent);
  RUN_TEST(test_auth_rearming_replaces_rather_than_accumulates);
  RUN_TEST(test_auth_saturates_an_absurd_window);

  RUN_TEST(test_box_on_frame_lights_the_court_and_publishes_state);
  RUN_TEST(test_box_a_commanded_off_reports_the_release);
  RUN_TEST(test_box_a_duration_past_a_uint16_clamps_rather_than_wrapping);
  RUN_TEST(test_box_auto_off_emits_the_event_across_the_wrap);
  RUN_TEST(test_box_a_dead_bridge_still_loses_the_lights);
  RUN_TEST(test_box_drops_presses_outside_the_auth_window);
  RUN_TEST(test_box_forwards_a_press_inside_the_auth_window);
  RUN_TEST(test_box_emits_authexpired_exactly_once);
  RUN_TEST(test_box_a_complete_scan_becomes_a_scan_frame);
  RUN_TEST(test_box_answers_a_bad_checksum_with_baderr);
  RUN_TEST(test_box_answers_ping_with_pong);
  RUN_TEST(test_box_rst_releases_everything);
  RUN_TEST(test_box_repaints_a_row_padded_to_the_full_width);
  RUN_TEST(test_box_reports_an_overrun_on_the_pass_after_it_recovers);
  RUN_TEST(test_box_samples_the_clock_once_per_pass);
  RUN_TEST(test_box_refuses_the_legacy_dialect_so_a_bare_a_lights_nothing);
  RUN_TEST(test_box_accepts_the_legacy_dialect_only_when_told_to);
  RUN_TEST(test_display_holdoff_abandons_then_skips_then_tries_again);
  RUN_TEST(test_display_holdoff_asks_for_exactly_one_resync_per_abandoned_write);

  return UNITY_END();
}
