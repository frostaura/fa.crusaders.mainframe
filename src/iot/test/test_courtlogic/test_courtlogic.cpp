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

#include "courtlogic/AuthWindow.h"
#include "courtlogic/ButtonPanel.h"
#include "courtlogic/CourtBox.h"
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

void test_box_drops_presses_outside_the_auth_window(void) {
  Box b(kBaseMid);

  b.buttons.press(0U);
  b.step(kBaseMid);
  b.step(kBaseMid + courtlogic::kDebounceMs);

  TEST_ASSERT_FALSE(sentLineStarting(b.bridge, "!BTN"));
  TEST_ASSERT_EQUAL_UINT16(1U, b.box.unauthorisedPresses());
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
  TEST_ASSERT_EQUAL_STRING(courtlogic::kIdleLine1, b.display.row(0U));
}

void test_box_repaints_a_row_padded_to_the_full_width(void) {
  Box b(kBaseMid);

  feedFrame(b.bridge, proto::Frame::lcd("COURT A 45 MIN", "PRESS START"));
  b.step(kBaseMid);
  TEST_ASSERT_EQUAL_STRING("COURT A 45 MIN  ", b.display.row(0U));

  // The shorter message must not leave the old tail on the glass: without
  // padding this reads "COURT A 5 MINN".
  feedFrame(b.bridge, proto::Frame::lcd("COURT A 5 MIN", "PRESS START"));
  b.step(kBaseMid + 1U);
  TEST_ASSERT_EQUAL_STRING("COURT A 5 MIN   ", b.display.row(0U));
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

int main(int, char**) {
  UNITY_BEGIN();

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

  return UNITY_END();
}
