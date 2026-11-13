// Unity tests for the Mega-side units: the independent relay auto-off timer and
// (v3) its authorisation cap and drive level, button debouncing, scanner line
// assembly and its idle gap and baud auto-detect, the authorisation window,
// the `!CFG` table and the LCD address probe. The CourtBox that wires them to
// the serial protocol is test_megabox's.
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
#include "courtlogic/LcdProbe.h"
#include "courtlogic/MegaSettings.h"
#include "courtlogic/RelayGuard.h"
#include "courtlogic/ScanAssembler.h"
#include "courtlogic/ScannerBaud.h"
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
    box.boot(0x01U);
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
    for (uint8_t i = 0U; i < 8U && box.txQueued() > 0U; ++i) {
      box.poll();
      bridge.drainTx();
    }
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
  box.boot(0x01U);
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


// --- v3: RelayGuard never shortens, and the authorisation cap (FSF-12, FWM-20)

void test_relay_guard_v3_on_and_extend_never_shorten_a_lit_court(void) {
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    fakes::FakeRelay relay;
    courtlogic::RelayGuard guard(relay);
    TEST_ASSERT_TRUE(guard.on(kCourtA, 3000U, base));
    // 2.1.0 moved the deadline to now + 60 s here: a later, shorter !ON (a
    // second member's rescan of the same court) cut a paid court short.
    TEST_ASSERT_TRUE(guard.on(kCourtA, 60U, base + 1000U));
    TEST_ASSERT_EQUAL_UINT16(2999U, guard.remainingSeconds(kCourtA, base + 1000U));
    TEST_ASSERT_TRUE(guard.extend(kCourtA, 10U, base + 2000U));
    TEST_ASSERT_EQUAL_UINT16(2998U, guard.remainingSeconds(kCourtA, base + 2000U));
    // A longer one still lengthens.
    TEST_ASSERT_TRUE(guard.extend(kCourtA, 4000U, base + 2000U));
    TEST_ASSERT_EQUAL_UINT16(4000U, guard.remainingSeconds(kCourtA, base + 2000U));
  }
}

void test_relay_guard_v3_want_lights_lengthens_and_never_opens(void) {
  fakes::FakeRelay relay;
  courtlogic::RelayGuard guard(relay);
  bool closed = false;
  TEST_ASSERT_TRUE(guard.want(kCourtB, 600U, kBaseMid, closed) == courtlogic::WantResult::Satisfied);
  TEST_ASSERT_TRUE(closed);
  TEST_ASSERT_TRUE(relay.isOn(kCourtB));
  TEST_ASSERT_TRUE(guard.want(kCourtB, 60U, kBaseMid + 1000U, closed) == courtlogic::WantResult::Satisfied);
  TEST_ASSERT_FALSE(closed);
  TEST_ASSERT_EQUAL_UINT16(599U, guard.remainingSeconds(kCourtB, kBaseMid + 1000U));
  TEST_ASSERT_TRUE(guard.want(kCourtB, 1200U, kBaseMid + 1000U, closed) == courtlogic::WantResult::Satisfied);
  TEST_ASSERT_EQUAL_UINT16(1200U, guard.remainingSeconds(kCourtB, kBaseMid + 1000U));
  TEST_ASSERT_EQUAL_UINT16(1U, relay.transitions(kCourtB));
}

void test_relay_guard_v3_the_cap_opens_a_relay_the_bridge_keeps_relighting(void) {
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    fakes::FakeRelay relay;
    courtlogic::RelayGuard guard(relay);
    TEST_ASSERT_EQUAL_UINT16(90U, guard.setCapMinutes(5U)); // clamped up, never off
    TEST_ASSERT_EQUAL_UINT16(720U, guard.setCapMinutes(99999U));
    TEST_ASSERT_EQUAL_UINT16(90U, guard.setCapMinutes(90U));
    TEST_ASSERT_TRUE(guard.on(kCourtC, 5400U, base));
    // A confused live bridge extending every 80 minutes: 2.1.0 held the court
    // on for ever (FWM-20). The cap is measured from the last !ON.
    uint32_t t = base;
    for (uint8_t k = 0U; k < 1U; ++k) {
      t += 80UL * 60000UL;
      TEST_ASSERT_EQUAL_UINT8(0U, guard.tick(t));
      TEST_ASSERT_TRUE(guard.extend(kCourtC, 5400U, t));
    }
    TEST_ASSERT_EQUAL_UINT8(0U, guard.tick(base + 90UL * 60000UL - 1U));
    TEST_ASSERT_EQUAL_UINT8(0x04U, guard.tick(base + 90UL * 60000UL));
    TEST_ASSERT_EQUAL_UINT8(0x04U, guard.lastCapReleased());
    TEST_ASSERT_FALSE(relay.isOn(kCourtC));
    TEST_ASSERT_EQUAL_UINT16(1U, guard.capOffCount());
    TEST_ASSERT_EQUAL_UINT16(0U, guard.autoOffCount());
    // Locked: !WANT and !EXT refuse until the next !ON.
    bool closed = false;
    TEST_ASSERT_TRUE(guard.want(kCourtC, 600U, t, closed) == courtlogic::WantResult::Refused);
    TEST_ASSERT_FALSE(relay.isOn(kCourtC));
    TEST_ASSERT_FALSE(guard.extend(kCourtC, 600U, t));
    TEST_ASSERT_TRUE(guard.locked(kCourtC));
    TEST_ASSERT_TRUE(guard.on(kCourtC, 600U, base + 91UL * 60000UL));
    TEST_ASSERT_FALSE(guard.locked(kCourtC));
    TEST_ASSERT_TRUE(relay.isOn(kCourtC));
  }
}

void test_relay_guard_v3_a_member_grant_restarts_the_cap(void) {
  fakes::FakeRelay relay;
  courtlogic::RelayGuard guard(relay);
  static_cast<void>(guard.setCapMinutes(90U));
  TEST_ASSERT_TRUE(guard.on(kCourtA, 5400U, kBaseMid));
  // A member's paid extension at the panel IS an !ON: real play is never capped.
  TEST_ASSERT_TRUE(guard.on(kCourtA, 5400U, kBaseMid + 80UL * 60000UL));
  TEST_ASSERT_EQUAL_UINT8(0U, guard.tick(kBaseMid + 120UL * 60000UL));
  TEST_ASSERT_TRUE(relay.isOn(kCourtA));
}

// --- v3: the relay drive level is a setting, and a released relay is an input
// (HW-1)

void test_relay_drive_a_released_relay_is_an_input_for_either_module(void) {
  for (uint8_t p = 0U; p < 2U; ++p) {
    const hal::RelayPolarity polarity = p == 0U ? hal::RelayPolarity::kActiveLow : hal::RelayPolarity::kActiveHigh;
    fakes::FakeRelay relay(polarity);
    courtlogic::RelayGuard guard(relay);
    for (uint8_t c = 0U; c < hal::kRelayChannelCount; ++c) {
      TEST_ASSERT_TRUE(relay.drive(c) == hal::PinDrive::kInput);
    }
    TEST_ASSERT_TRUE(guard.on(kCourtA, 60U, kBaseMid));
    TEST_ASSERT_TRUE(relay.drive(kCourtA) ==
                     (p == 0U ? hal::PinDrive::kLow : hal::PinDrive::kHigh));
    TEST_ASSERT_TRUE(relay.drive(kCourtB) == hal::PinDrive::kInput);
    TEST_ASSERT_TRUE(guard.off(kCourtA));
    TEST_ASSERT_TRUE(relay.drive(kCourtA) == hal::PinDrive::kInput);
  }
}

void test_relay_drive_a_wrong_level_fails_dark_never_lit(void) {
  // The fitted module is ACTIVE-LOW (its idle level is HIGH) and the box is
  // told active-high: a granted court is driven HIGH — the module's own idle
  // level, so the lights stay off — and every released pin is an input, which
  // is off for this module too. 2.1.0 drove a released pin LOW: for this
  // module, every court lit all night.
  fakes::FakeRelay relay(hal::RelayPolarity::kActiveHigh);
  courtlogic::RelayGuard guard(relay);
  TEST_ASSERT_TRUE(guard.on(3U, 600U, kBaseMid));
  const hal::PinLevel moduleIdle = hal::relayLevelFor(false, hal::RelayPolarity::kActiveLow);
  TEST_ASSERT_TRUE(relay.drive(3U) == (moduleIdle == hal::PinLevel::kHigh ? hal::PinDrive::kHigh : hal::PinDrive::kLow));
  for (uint8_t c = 0U; c < 3U; ++c) {
    TEST_ASSERT_TRUE(relay.drive(c) == hal::PinDrive::kInput);
  }
  // Corrected remotely: the closed relay is re-driven at once.
  relay.setPolarity(hal::RelayPolarity::kActiveLow);
  TEST_ASSERT_TRUE(relay.drive(3U) == hal::PinDrive::kLow);
}

// --- v3: the scanner's idle gap and baud (FWM-14, HW-5) --------------------

void test_scan_gap_ends_a_suffixless_code_and_discards_a_stray_byte(void) {
  courtlogic::ScanAssembler scan;
  // A stray byte, then the gap: discarded, so the next member's code is theirs.
  TEST_ASSERT_FALSE(scan.feed(static_cast<uint8_t>('Q')));
  TEST_ASSERT_TRUE(scan.partial());
  TEST_ASSERT_FALSE(scan.gap(false));
  TEST_ASSERT_FALSE(scan.partial());
  // A suffix-less 19-character member code ends at the gap.
  const char* code = "1ABCDEFGHJKMNPQRSTV";
  for (uint8_t i = 0U; code[i] != '\0'; ++i) {
    TEST_ASSERT_FALSE(scan.feed(static_cast<uint8_t>(code[i])));
  }
  TEST_ASSERT_TRUE(scan.gap(false));
  TEST_ASSERT_EQUAL_STRING(code, scan.code());
  // Seven characters is noise, not a code.
  for (uint8_t i = 0U; i < 7U; ++i) {
    TEST_ASSERT_FALSE(scan.feed(static_cast<uint8_t>('A' + i)));
  }
  TEST_ASSERT_FALSE(scan.gap(false));
  // SSUF 1: the gap only discards.
  for (uint8_t i = 0U; code[i] != '\0'; ++i) {
    TEST_ASSERT_FALSE(scan.feed(static_cast<uint8_t>(code[i])));
  }
  TEST_ASSERT_FALSE(scan.gap(true));
  TEST_ASSERT_FALSE(scan.partial());
}

void test_scan_bytes_above_0x7e_are_garbage_and_reported_once_per_line(void) {
  courtlogic::ScanAssembler scan;
  TEST_ASSERT_FALSE(scan.feed(0xC1U));
  TEST_ASSERT_FALSE(scan.feed(0xC2U));
  TEST_ASSERT_FALSE(scan.takeGarbage());
  TEST_ASSERT_FALSE(scan.feed(static_cast<uint8_t>('\r')));
  TEST_ASSERT_TRUE(scan.takeGarbage());
  TEST_ASSERT_FALSE(scan.takeGarbage());
  TEST_ASSERT_FALSE(scan.feed(0xE9U));
  TEST_ASSERT_FALSE(scan.gap(false));
  TEST_ASSERT_TRUE(scan.takeGarbage());
}

void test_scanner_baud_walks_the_order_only_while_idle_and_locks(void) {
  courtlogic::ScannerBaud baud;
  TEST_ASSERT_EQUAL_UINT32(9600UL, baud.rate());
  TEST_ASSERT_EQUAL_UINT8(0U, baud.reported());
  TEST_ASSERT_FALSE(baud.garbage(true));
  TEST_ASSERT_FALSE(baud.garbage(true));
  // Third burst, but a member is mid-interaction: never re-baud under them.
  TEST_ASSERT_FALSE(baud.garbage(false));
  TEST_ASSERT_TRUE(baud.garbage(true));
  TEST_ASSERT_EQUAL_UINT32(115200UL, baud.rate());
  const uint32_t order[] = {57600UL, 38400UL, 19200UL, 9600UL, 115200UL};
  for (uint8_t i = 0U; i < 5U; ++i) {
    TEST_ASSERT_FALSE(baud.garbage(true));
    TEST_ASSERT_FALSE(baud.garbage(true));
    TEST_ASSERT_TRUE(baud.garbage(true));
    TEST_ASSERT_EQUAL_UINT32(order[i], baud.rate());
  }
  baud.cleanLine();
  TEST_ASSERT_EQUAL_UINT8(5U, baud.reported());
  for (uint8_t i = 0U; i < 9U; ++i) {
    TEST_ASSERT_FALSE(baud.garbage(true)); // locked until reboot or !CFG,SBAUD
  }
  baud.configure(3U);
  TEST_ASSERT_EQUAL_UINT32(38400UL, baud.rate());
  TEST_ASSERT_EQUAL_UINT8(3U, baud.reported());
  baud.configure(0U);
  TEST_ASSERT_EQUAL_UINT32(9600UL, baud.rate());
  TEST_ASSERT_EQUAL_UINT8(0U, baud.reported());
  TEST_ASSERT_EQUAL_UINT8(1U, courtlogic::baudCodeOf(9600UL));
  TEST_ASSERT_EQUAL_UINT8(0U, courtlogic::baudCodeOf(4800UL));
}

// --- v3: the !CFG table ----------------------------------------------------

void test_mega_settings_clamp_refuse_and_fall_back_to_compact(void) {
  courtlogic::MegaSettings s;
  TEST_ASSERT_TRUE(s.layout() == courtlogic::Layout::Compact);
  TEST_ASSERT_TRUE(s.apply("LAYOUT", 1U) == proto::AckCode::Applied);
  TEST_ASSERT_TRUE(s.layout() == courtlogic::Layout::Expanded);
  // Any doubt is compact: a value outside the set is refused AND falls back.
  TEST_ASSERT_TRUE(s.apply("LAYOUT", 2U) == proto::AckCode::Refused);
  TEST_ASSERT_TRUE(s.layout() == courtlogic::Layout::Compact);
  TEST_ASSERT_TRUE(s.apply("CEIL", 9999U) == proto::AckCode::Applied);
  TEST_ASSERT_EQUAL_UINT16(proto::kShowHoldMaxSeconds, s.get(courtlogic::Cfg::Ceil));
  TEST_ASSERT_TRUE(s.apply("CEIL", 1U) == proto::AckCode::Applied);
  TEST_ASSERT_EQUAL_UINT16(15U, s.get(courtlogic::Cfg::Ceil));
  TEST_ASSERT_TRUE(s.apply("NOPE", 1U) == proto::AckCode::Refused);
  TEST_ASSERT_TRUE(s.apply("RPOL", 2U) == proto::AckCode::Refused);
  TEST_ASSERT_EQUAL_UINT16(0U, s.get(courtlogic::Cfg::Rpol));
  TEST_ASSERT_TRUE(s.apply("RPOL", 1U) == proto::AckCode::Applied);
  TEST_ASSERT_TRUE(s.relayActiveLow());
  TEST_ASSERT_TRUE(s.apply("LCDA", 0x30U) == proto::AckCode::Refused); // between the two chips' ranges
  TEST_ASSERT_TRUE(s.apply("LCDA", 0x3FU) == proto::AckCode::Applied);
  TEST_ASSERT_TRUE(s.apply("LCDA", 0x20U) == proto::AckCode::Applied);
  TEST_ASSERT_TRUE(s.apply("LCDA", 0x28U) == proto::AckCode::Refused);
  TEST_ASSERT_EQUAL_UINT16(0x20U, s.get(courtlogic::Cfg::Lcda));
  TEST_ASSERT_TRUE(s.apply("SBAUD", 6U) == proto::AckCode::Refused);
  TEST_ASSERT_TRUE(s.apply("SGAP", 10U) == proto::AckCode::Applied);
  TEST_ASSERT_EQUAL_UINT16(50U, s.get(courtlogic::Cfg::Sgap));
  TEST_ASSERT_TRUE(s.apply("KEYS", 0xF0U) == proto::AckCode::Applied);
  TEST_ASSERT_EQUAL_UINT8(0xF0U, s.keys());
  TEST_ASSERT_TRUE(s.apply("CAP", 1U) == proto::AckCode::Applied);
  TEST_ASSERT_EQUAL_UINT16(90U, s.get(courtlogic::Cfg::Cap));
  s.reset();
  TEST_ASSERT_EQUAL_UINT8(0x0FU, s.keys());
  TEST_ASSERT_EQUAL_UINT16(60U, s.get(courtlogic::Cfg::Ceil));
  TEST_ASSERT_EQUAL_UINT16(150U, s.get(courtlogic::Cfg::Sgap));
  TEST_ASSERT_FALSE(s.relayActiveLow());
}

// --- v3: the LCD address probe (HW-2) --------------------------------------

namespace {

struct FakeBus {
  uint8_t answering;
  uint8_t asked[32];
  uint8_t count;
};

bool fakeBusAnswers(uint8_t address, void* context) {
  FakeBus* bus = static_cast<FakeBus*>(context);
  if (bus->count < sizeof(bus->asked)) {
    bus->asked[bus->count] = address;
    ++bus->count;
  }
  return address == bus->answering;
}

} // namespace

void test_lcd_probe_finds_a_nack_only_backpack_at_0x3f_and_reports_none_as_zero(void) {
  FakeBus bus = {0x3FU, {}, 0U};
  // 2.1.0 drove 0x27 only: a PCF8574AT backpack NACKed every write and the
  // glass stayed blank with nothing reporting it.
  TEST_ASSERT_EQUAL_UINT8(0x3FU, courtlogic::probeLcdAddress(0U, fakeBusAnswers, &bus));
  TEST_ASSERT_EQUAL_UINT8(2U, bus.count);
  TEST_ASSERT_EQUAL_UINT8(0x27U, bus.asked[0]);
  bus = FakeBus{0x3BU, {}, 0U};
  TEST_ASSERT_EQUAL_UINT8(0x3BU, courtlogic::probeLcdAddress(0U, fakeBusAnswers, &bus));
  TEST_ASSERT_EQUAL_UINT8(0x3AU, bus.asked[bus.count - 2U]);
  bus = FakeBus{0x00U, {}, 0U};
  TEST_ASSERT_EQUAL_UINT8(0U, courtlogic::probeLcdAddress(0U, fakeBusAnswers, &bus));
  TEST_ASSERT_EQUAL_UINT8(courtlogic::kLcdProbeCount, bus.count);
  // A forced address drives that address only.
  bus = FakeBus{0x27U, {}, 0U};
  TEST_ASSERT_EQUAL_UINT8(0U, courtlogic::probeLcdAddress(0x3FU, fakeBusAnswers, &bus));
  TEST_ASSERT_EQUAL_UINT8(1U, bus.count);
}

void setUp(void) {
}

void tearDown(void) {
}

int main(int, char**) {
  UNITY_BEGIN();

  RUN_TEST(test_relay_guard_drives_the_active_low_level);
  RUN_TEST(test_relay_guard_drives_the_active_high_level_for_the_solid_state_relays);
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
  RUN_TEST(test_relay_guard_v3_on_and_extend_never_shorten_a_lit_court);
  RUN_TEST(test_relay_guard_v3_want_lights_lengthens_and_never_opens);
  RUN_TEST(test_relay_guard_v3_the_cap_opens_a_relay_the_bridge_keeps_relighting);
  RUN_TEST(test_relay_guard_v3_a_member_grant_restarts_the_cap);
  RUN_TEST(test_relay_drive_a_released_relay_is_an_input_for_either_module);
  RUN_TEST(test_relay_drive_a_wrong_level_fails_dark_never_lit);

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
  RUN_TEST(test_scan_gap_ends_a_suffixless_code_and_discards_a_stray_byte);
  RUN_TEST(test_scan_bytes_above_0x7e_are_garbage_and_reported_once_per_line);
  RUN_TEST(test_scanner_baud_walks_the_order_only_while_idle_and_locks);

  RUN_TEST(test_auth_window_allows_only_while_armed);
  RUN_TEST(test_auth_lapse_is_an_edge_not_a_level);
  RUN_TEST(test_auth_zero_disarms_and_disarm_is_silent);
  RUN_TEST(test_auth_rearming_replaces_rather_than_accumulates);
  RUN_TEST(test_auth_saturates_an_absurd_window);

  RUN_TEST(test_mega_settings_clamp_refuse_and_fall_back_to_compact);
  RUN_TEST(test_lcd_probe_finds_a_nack_only_backpack_at_0x3f_and_reports_none_as_zero);

  RUN_TEST(test_box_refuses_the_legacy_dialect_so_a_bare_a_lights_nothing);
  RUN_TEST(test_box_accepts_the_legacy_dialect_only_when_told_to);
  RUN_TEST(test_display_holdoff_abandons_then_skips_then_tries_again);
  RUN_TEST(test_display_holdoff_asks_for_exactly_one_resync_per_abandoned_write);

  return UNITY_END();
}
