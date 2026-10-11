// Unity tests for the recording fakes in lib/hal_fakes.
//
// WHY TEST TEST INFRASTRUCTURE
// ----------------------------
// Every future test of the relay timer, the debounce rule, the frame parser and
// the credential store asserts against these fakes. A bug in a fake does not
// fail loudly — it makes some other module's suite green while the firmware is
// wrong. So the fakes are held to the same standard as the code they stand in
// for, and each of the seven hazards they exist to reproduce is proved here:
//
//   relay      logical "on" is electrically LOW, and the two are distinguishable
//   display    text past column 16 or row 2 is dropped, and the grid shows it
//   scanner    a line can arrive in fragments across several drains
//   buttons    a contact can chatter, sample by sample
//   clock      the counter can sit on 0xFFFFFFFF and step across the wrap
//   transport  a bounded TX buffer overruns, and it is detectable
//   store      a write can tear, leaving half the old value and half the new
//
// No hardware is touched, and none is required.

#include <stdint.h>
#include <unity.h>

#include "hal/Transport.h"

#include "fakes/ByteQueue.h"
#include "fakes/FakeButtons.h"
#include "fakes/FakeClock.h"
#include "fakes/FakeDisplay.h"
#include "fakes/FakeRelay.h"
#include "fakes/FakeScanner.h"
#include "fakes/FakeStore.h"
#include "fakes/FakeTransport.h"
#include "timebase/TimeBase.h"

namespace {

uint8_t code(hal::PinLevel level) {
  return static_cast<uint8_t>(level);
}

uint8_t code(hal::StoreResult result) {
  return static_cast<uint8_t>(result);
}

uint32_t asU32(size_t value) {
  return static_cast<uint32_t>(value);
}

// A 40-character frame — about the longest the protocol emits, and two of them
// do not fit in the Mega's 64-byte UART TX ring.
const char* const kFrame40 = "!STATE,15,5400,5400,5400,5400*7F,PADPADP";

} // namespace

// --- relay -----------------------------------------------------------------

void test_relay_fake_starts_released_and_electrically_high(void) {
  fakes::FakeRelay relay;
  for (uint8_t ch = 0U; ch < hal::kRelayChannelCount; ++ch) {
    TEST_ASSERT_FALSE(relay.isOn(ch));
    TEST_ASSERT_EQUAL_UINT8(code(hal::PinLevel::kHigh), code(relay.level(ch)));
    TEST_ASSERT_EQUAL_UINT8(1U, relay.digitalLevel(ch));
  }
  TEST_ASSERT_FALSE(relay.anyOn());
}

// The one that matters. A caller that has the polarity backwards commands
// set(ch, false) meaning "lights on"; the logical channel catches that. A
// driver-side inversion changes what relayLevelFor() must produce; the
// electrical channel catches that. Both are asserted against literals so
// neither can be "fixed" by flipping the other.
void test_relay_fake_separates_logical_state_from_electrical_level(void) {
  fakes::FakeRelay relay;

  relay.set(0U, true);
  TEST_ASSERT_TRUE(relay.isOn(0U));
  TEST_ASSERT_EQUAL_UINT8(code(hal::PinLevel::kLow), code(relay.level(0U)));
  TEST_ASSERT_EQUAL_UINT8(0U, relay.digitalLevel(0U)); // LOW == lights on

  relay.set(0U, false);
  TEST_ASSERT_FALSE(relay.isOn(0U));
  TEST_ASSERT_EQUAL_UINT8(code(hal::PinLevel::kHigh), code(relay.level(0U)));
  TEST_ASSERT_EQUAL_UINT8(1U, relay.digitalLevel(0U));

  // The mapping is an inversion, not a pass-through. `digitalWrite(pin, on)`
  // is the bug this pins down: it would drive HIGH for "on".
  TEST_ASSERT_EQUAL_UINT8(0U, code(hal::relayLevelFor(true)));
  TEST_ASSERT_EQUAL_UINT8(1U, code(hal::relayLevelFor(false)));
  TEST_ASSERT_NOT_EQUAL(static_cast<uint8_t>(true), code(hal::relayLevelFor(true)));
}

// Mega 2.1.0's solid-state relays close on HIGH. The same mapping, the other
// polarity: a fake of THAT board reads HIGH for on and LOW for off, and the
// whole truth table is pinned against literals in both polarities so neither
// can be "fixed" by flipping the other.
void test_relay_level_mapping_is_pinned_for_both_polarities(void) {
  const hal::RelayPolarity low = hal::RelayPolarity::kActiveLow;
  const hal::RelayPolarity high = hal::RelayPolarity::kActiveHigh;
  TEST_ASSERT_EQUAL_UINT8(0U, code(hal::relayLevelFor(true, low)));
  TEST_ASSERT_EQUAL_UINT8(1U, code(hal::relayLevelFor(false, low)));
  TEST_ASSERT_EQUAL_UINT8(1U, code(hal::relayLevelFor(true, high)));
  TEST_ASSERT_EQUAL_UINT8(0U, code(hal::relayLevelFor(false, high)));
  // The one-argument form is the coil board's, unchanged.
  TEST_ASSERT_EQUAL_UINT8(code(hal::relayLevelFor(true, low)), code(hal::relayLevelFor(true)));
  TEST_ASSERT_EQUAL_UINT8(code(hal::relayLevelFor(false, low)), code(hal::relayLevelFor(false)));
  // RELAY_ACTIVE_LOW=1 is the coil board, 0 the solid-state relays.
  TEST_ASSERT_TRUE(hal::relayPolarityFor(true) == low);
  TEST_ASSERT_TRUE(hal::relayPolarityFor(false) == high);

  fakes::FakeRelay ssr(high);
  TEST_ASSERT_TRUE(ssr.polarity() == high);
  for (uint8_t ch = 0U; ch < hal::kRelayChannelCount; ++ch) {
    TEST_ASSERT_EQUAL_UINT8(0U, ssr.digitalLevel(ch)); // released = LOW
  }
  ssr.set(1U, true);
  TEST_ASSERT_EQUAL_UINT8(1U, ssr.digitalLevel(1U)); // HIGH == lights on
  TEST_ASSERT_EQUAL_UINT8(0U, ssr.digitalLevel(0U));
  ssr.allOff();
  TEST_ASSERT_EQUAL_UINT8(0U, ssr.digitalLevel(1U));
}

void test_relay_fake_records_call_order_and_counts_transitions(void) {
  fakes::FakeRelay relay;
  relay.set(1U, true);
  relay.set(1U, true); // redundant re-assert: recorded, but not a transition
  relay.set(2U, true);
  relay.set(1U, false);

  TEST_ASSERT_EQUAL_UINT8(4U, relay.eventCount());
  TEST_ASSERT_EQUAL_UINT8(1U, relay.event(0U).channel);
  TEST_ASSERT_TRUE(relay.event(0U).on);
  TEST_ASSERT_EQUAL_UINT8(2U, relay.event(2U).channel);
  TEST_ASSERT_FALSE(relay.event(3U).on);

  TEST_ASSERT_EQUAL_UINT16(2U, relay.transitions(1U)); // off->on, on->off
  TEST_ASSERT_EQUAL_UINT16(1U, relay.transitions(2U));
  TEST_ASSERT_EQUAL_UINT16(0U, relay.transitions(3U));
  TEST_ASSERT_FALSE(relay.overflowed());
}

// A ring buffer here would keep the LAST 32 events under the same indices, so
// event(0) would quietly start answering with a different event and assertions
// against it would still pass. The log stops and raises a flag instead.
void test_relay_fake_flags_log_overflow_instead_of_wrapping(void) {
  fakes::FakeRelay relay;
  for (uint8_t i = 0U; i < fakes::FakeRelay::kMaxEvents + 8U; ++i) {
    relay.set(0U, (i % 2U) == 0U);
  }

  TEST_ASSERT_TRUE(relay.overflowed());
  TEST_ASSERT_EQUAL_UINT8(fakes::FakeRelay::kMaxEvents, relay.eventCount());
  TEST_ASSERT_TRUE(relay.event(0U).on); // still the FIRST event, not the 9th
}

void test_relay_fake_ignores_an_out_of_range_channel_and_counts_it(void) {
  fakes::FakeRelay relay;
  relay.set(hal::kRelayChannelCount, true);
  relay.set(200U, true);

  TEST_ASSERT_EQUAL_UINT16(2U, relay.badChannelCalls());
  TEST_ASSERT_EQUAL_UINT8(0U, relay.eventCount());
  TEST_ASSERT_FALSE(relay.anyOn());
  TEST_ASSERT_FALSE(relay.isOn(hal::kRelayChannelCount));
  TEST_ASSERT_EQUAL_UINT8(code(hal::PinLevel::kHigh), code(relay.level(99U)));
}

void test_relay_fake_all_off_releases_every_channel(void) {
  fakes::FakeRelay relay;
  for (uint8_t ch = 0U; ch < hal::kRelayChannelCount; ++ch) {
    relay.set(ch, true);
  }
  TEST_ASSERT_TRUE(relay.anyOn());

  relay.allOff();

  TEST_ASSERT_FALSE(relay.anyOn());
  TEST_ASSERT_EQUAL_UINT16(1U, relay.allOffCalls());
  for (uint8_t ch = 0U; ch < hal::kRelayChannelCount; ++ch) {
    TEST_ASSERT_EQUAL_UINT8(1U, relay.digitalLevel(ch));
  }
}

// --- display ---------------------------------------------------------------

void test_display_fake_starts_blank_and_pads_rows_to_full_width(void) {
  // This shared project builds with no LCD_COLS/LCD_ROWS, so the fake takes the
  // HAL's DEFAULT geometry, 16x2, and the expectations below are written out at
  // it. The court box itself is driven as 20x4 (its [lcd] flags); rows 0-1 hold
  // the 16-column safe subset, which is what this default still models.
  TEST_ASSERT_EQUAL_UINT8(16U, hal::kDisplayCols);
  TEST_ASSERT_EQUAL_UINT8(2U, hal::kDisplayRows);

  fakes::FakeDisplay lcd;
  TEST_ASSERT_EQUAL_STRING("                ", lcd.row(0U));
  TEST_ASSERT_EQUAL_STRING("                ", lcd.row(1U));
  TEST_ASSERT_EQUAL_STRING("", lcd.row(2U));
}

void test_display_fake_writes_at_an_offset_without_disturbing_neighbours(void) {
  fakes::FakeDisplay lcd;
  lcd.print(0U, 0U, "COURT A");
  lcd.print(1U, 9U, "45 MIN");

  TEST_ASSERT_EQUAL_STRING("COURT A         ", lcd.row(0U));
  TEST_ASSERT_EQUAL_STRING("         45 MIN ", lcd.row(1U));
  TEST_ASSERT_EQUAL_CHAR('4', lcd.at(1U, 9U));
  TEST_ASSERT_EQUAL_UINT16(0U, lcd.droppedChars());
  TEST_ASSERT_EQUAL_UINT16(0U, lcd.offGridCalls());
}

// Column 16 does not exist at the default 16x2 geometry. A write past the last
// column of whatever geometry is built must be dropped, never land where nothing
// repaints it — on a smaller panel than the build assumes it would sit forever.
void test_display_fake_truncates_past_the_last_column(void) {
  fakes::FakeDisplay lcd;
  lcd.print(0U, 0U, "ABCDEFGHIJKLMNOPQRS"); // 19 chars into 16 columns

  TEST_ASSERT_EQUAL_STRING("ABCDEFGHIJKLMNOP", lcd.row(0U));
  TEST_ASSERT_EQUAL_UINT16(3U, lcd.droppedChars());

  lcd.print(1U, 14U, "LONG"); // only "LO" fits
  TEST_ASSERT_EQUAL_STRING("              LO", lcd.row(1U));
  TEST_ASSERT_EQUAL_UINT16(5U, lcd.droppedChars());

  // Starting past the last column lands nothing at all and is counted as an
  // off-grid call, not merely as truncation.
  lcd.print(1U, hal::kDisplayCols, "X");
  TEST_ASSERT_EQUAL_STRING("              LO", lcd.row(1U));
  TEST_ASSERT_EQUAL_UINT16(1U, lcd.offGridCalls());
  TEST_ASSERT_EQUAL_UINT16(6U, lcd.droppedChars());
}

// Row 2 does not exist at the default 16x2 geometry. The whole call is dropped
// rather than clamped onto row 1: a status line rendered on the wrong row reads
// as current.
void test_display_fake_drops_writes_past_the_last_row(void) {
  fakes::FakeDisplay lcd;
  lcd.print(hal::kDisplayRows, 0U, "GHOST");
  lcd.print(3U, 0U, "GHOST");
  lcd.print(0U, 0U, nullptr);

  TEST_ASSERT_EQUAL_UINT16(3U, lcd.offGridCalls());
  TEST_ASSERT_EQUAL_STRING("                ", lcd.row(0U));
  TEST_ASSERT_EQUAL_STRING("                ", lcd.row(1U));
  TEST_ASSERT_EQUAL_UINT16(0U, lcd.droppedChars());
}

// Modelling the grid rather than logging calls is what makes this visible:
// two innocent print() calls, and the glass reads "COURT A 5 MINN".
void test_display_fake_shows_the_tail_a_short_repaint_leaves_behind(void) {
  fakes::FakeDisplay lcd;
  lcd.print(0U, 0U, "COURT A 45 MIN");
  lcd.print(0U, 0U, "COURT A 5 MIN");

  TEST_ASSERT_EQUAL_STRING("COURT A 5 MINN  ", lcd.row(0U));
}

void test_display_fake_clear_blanks_every_cell(void) {
  fakes::FakeDisplay lcd;
  lcd.print(0U, 0U, "COURT A");
  lcd.print(1U, 0U, "SCAN TO START");
  lcd.clear();

  TEST_ASSERT_EQUAL_STRING("                ", lcd.row(0U));
  TEST_ASSERT_EQUAL_STRING("                ", lcd.row(1U));
  TEST_ASSERT_EQUAL_UINT16(2U, lcd.clearCalls()); // construction plus this one
  TEST_ASSERT_EQUAL_UINT16(2U, lcd.printCalls());
}

// --- scanner ---------------------------------------------------------------

void test_scanner_fake_delivers_bytes_in_order_then_reports_empty(void) {
  fakes::FakeScanner scanner;
  TEST_ASSERT_TRUE(scanner.feedLine("CRU-1234"));
  TEST_ASSERT_EQUAL_UINT16(9U, scanner.pending());

  char seen[16] = {};
  uint8_t index = 0U;
  uint8_t byte = 0U;
  while (scanner.read(byte)) {
    seen[index] = static_cast<char>(byte);
    ++index;
  }

  TEST_ASSERT_EQUAL_STRING("CRU-1234\r", seen);
  TEST_ASSERT_EQUAL_UINT16(0U, scanner.pending());
  TEST_ASSERT_EQUAL_UINT16(9U, scanner.delivered());
  TEST_ASSERT_FALSE(scanner.read(byte));
}

// The real behaviour of a 9600-baud scanner: the payload arrives across several
// passes of the main loop, and the terminator arrives last. Between the two
// drains the code under test must hold its partial line and decide nothing.
void test_scanner_fake_reproduces_a_partial_line_then_its_completion(void) {
  fakes::FakeScanner scanner;
  char assembled[32] = {};
  uint8_t length = 0U;
  uint8_t byte = 0U;
  bool complete = false;

  TEST_ASSERT_TRUE(scanner.feed("CRU-12"));
  while (scanner.read(byte)) {
    if (byte == '\r' || byte == '\n') {
      complete = true;
    } else {
      assembled[length] = static_cast<char>(byte);
      ++length;
    }
  }
  TEST_ASSERT_FALSE(complete); // no terminator yet: nothing may be acted on
  TEST_ASSERT_EQUAL_STRING("CRU-12", assembled);

  TEST_ASSERT_TRUE(scanner.feed("34\r"));
  while (scanner.read(byte)) {
    if (byte == '\r' || byte == '\n') {
      complete = true;
    } else {
      assembled[length] = static_cast<char>(byte);
      ++length;
    }
  }
  TEST_ASSERT_TRUE(complete);
  TEST_ASSERT_EQUAL_STRING("CRU-1234", assembled);
}

// The link runs beside four switching relay coils. Corruption is ordinary, and
// a NUL is a legal byte on the wire — nothing may treat it as a terminator.
void test_scanner_fake_is_byte_clean_including_nul_and_high_bytes(void) {
  fakes::FakeScanner scanner;
  TEST_ASSERT_TRUE(scanner.feedByte(0x00U));
  TEST_ASSERT_TRUE(scanner.feedByte(0xFFU));
  TEST_ASSERT_TRUE(scanner.feedByte(0x1BU));

  uint8_t byte = 0xAAU;
  TEST_ASSERT_TRUE(scanner.read(byte));
  TEST_ASSERT_EQUAL_UINT8(0x00U, byte);
  TEST_ASSERT_TRUE(scanner.read(byte));
  TEST_ASSERT_EQUAL_UINT8(0xFFU, byte);
  TEST_ASSERT_TRUE(scanner.read(byte));
  TEST_ASSERT_EQUAL_UINT8(0x1BU, byte);
  TEST_ASSERT_EQUAL_UINT16(3U, scanner.pending() + scanner.delivered());
}

void test_scanner_fake_reports_overflow_instead_of_dropping_silently(void) {
  fakes::FakeScanner scanner;
  bool accepted = true;
  for (uint16_t i = 0U; i < fakes::FakeScanner::kCapacity + 4U; ++i) {
    accepted = scanner.feedByte(static_cast<uint8_t>('x'));
  }

  TEST_ASSERT_FALSE(accepted);
  TEST_ASSERT_TRUE(scanner.overflowed());
  TEST_ASSERT_EQUAL_UINT16(fakes::FakeScanner::kCapacity, scanner.pending());
}

// The shared queue reclaims its drained prefix, so feed/drain/feed cycles far
// longer than the capacity are not a false overflow.
void test_byte_queue_compacts_across_drain_and_refill(void) {
  fakes::ByteQueue<8U> queue;
  uint8_t byte = 0U;
  for (uint16_t round = 0U; round < 20U; ++round) {
    TEST_ASSERT_TRUE(queue.push(static_cast<uint8_t>(round)));
    TEST_ASSERT_TRUE(queue.pop(byte));
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(round), byte);
  }
  TEST_ASSERT_FALSE(queue.overflowed());
  TEST_ASSERT_TRUE(queue.empty());
}

// --- buttons ---------------------------------------------------------------

void test_button_fake_idles_released_which_is_electrically_high(void) {
  fakes::FakeButtons buttons;
  for (uint8_t ch = 0U; ch < hal::kButtonCount; ++ch) {
    TEST_ASSERT_EQUAL_UINT8(code(hal::kButtonReleasedLevel), code(buttons.read(ch)));
  }
  TEST_ASSERT_EQUAL_UINT8(code(hal::PinLevel::kLow), code(hal::kButtonPressedLevel));
}

// Contact chatter, one scripted sample per read. This is the stimulus the 80 ms
// debounce rule has to survive, and the reason the port reports raw levels.
void test_button_fake_expresses_contact_bounce(void) {
  fakes::FakeButtons buttons;
  TEST_ASSERT_TRUE(buttons.script(hal::kCourtButtonBase, "HHLHLHLLLL"));

  const char* const expected = "HHLHLHLLLL";
  uint8_t edges = 0U;
  hal::PinLevel previous = hal::PinLevel::kHigh;
  for (uint8_t i = 0U; i < 10U; ++i) {
    const hal::PinLevel level = buttons.read(hal::kCourtButtonBase);
    const hal::PinLevel wanted = expected[i] == 'H' ? hal::PinLevel::kHigh : hal::PinLevel::kLow;
    TEST_ASSERT_EQUAL_UINT8(code(wanted), code(level));
    if (level != previous) {
      ++edges;
    }
    previous = level;
  }

  // Five edges in ten samples: chatter, not five presses.
  TEST_ASSERT_EQUAL_UINT8(5U, edges);
  TEST_ASSERT_EQUAL_UINT16(10U, buttons.reads(hal::kCourtButtonBase));
  TEST_ASSERT_EQUAL_UINT8(0U, buttons.scriptRemaining(hal::kCourtButtonBase));
  TEST_ASSERT_FALSE(buttons.scriptExhausted(hal::kCourtButtonBase));
}

// A button does not spring back because the test stopped describing it, so the
// last scripted level holds — but reading past the script is flagged, because a
// test asserting against a level it never wrote down is asserting nothing.
void test_button_fake_holds_the_last_level_and_flags_a_spent_script(void) {
  fakes::FakeButtons buttons;
  TEST_ASSERT_TRUE(buttons.script(3U, "HL"));

  TEST_ASSERT_EQUAL_UINT8(code(hal::PinLevel::kHigh), code(buttons.read(3U)));
  TEST_ASSERT_EQUAL_UINT8(code(hal::PinLevel::kLow), code(buttons.read(3U)));
  TEST_ASSERT_FALSE(buttons.scriptExhausted(3U));

  TEST_ASSERT_EQUAL_UINT8(code(hal::PinLevel::kLow), code(buttons.read(3U)));
  TEST_ASSERT_TRUE(buttons.scriptExhausted(3U));

  // hold() is the steady-state knob and never reports exhaustion.
  buttons.release(3U);
  TEST_ASSERT_EQUAL_UINT8(code(hal::PinLevel::kHigh), code(buttons.read(3U)));
  TEST_ASSERT_FALSE(buttons.scriptExhausted(3U));
  buttons.press(3U);
  TEST_ASSERT_EQUAL_UINT8(code(hal::PinLevel::kLow), code(buttons.read(3U)));
}

// A typo'd trace that quietly read as "released" would be a test proving
// nothing, so a bad script is refused whole.
void test_button_fake_rejects_a_bad_script_and_leaves_the_channel_alone(void) {
  fakes::FakeButtons buttons;
  TEST_ASSERT_TRUE(buttons.script(0U, "LL"));
  TEST_ASSERT_FALSE(buttons.script(0U, "LXL"));
  TEST_ASSERT_FALSE(buttons.script(hal::kButtonCount, "LL"));
  TEST_ASSERT_FALSE(buttons.script(0U, nullptr));

  TEST_ASSERT_EQUAL_UINT8(2U, buttons.scriptRemaining(0U));
  TEST_ASSERT_EQUAL_UINT8(code(hal::PinLevel::kLow), code(buttons.read(0U)));
}

// A pin that does not exist must never look pressed: a phantom press starts a
// court and spends a member's credits.
void test_button_fake_reads_an_unknown_channel_as_released(void) {
  fakes::FakeButtons buttons;
  TEST_ASSERT_EQUAL_UINT8(code(hal::kButtonReleasedLevel), code(buttons.read(hal::kButtonCount)));
  TEST_ASSERT_EQUAL_UINT8(code(hal::kButtonReleasedLevel), code(buttons.read(250U)));
  TEST_ASSERT_EQUAL_UINT16(2U, buttons.badChannelReads());
}

// --- clock -----------------------------------------------------------------

// The bug class lib/timebase exists for: a real clock cannot be parked four
// milliseconds before the 49.7-day wrap, and this one can.
void test_clock_fake_sits_at_the_wrap_and_steps_across_it(void) {
  fakes::FakeClock clock(0xFFFFFFFFU);
  TEST_ASSERT_EQUAL_UINT32(0xFFFFFFFFU, clock.nowMs());

  clock.advance(1U);
  TEST_ASSERT_EQUAL_UINT32(0U, clock.nowMs()); // wraps, never saturates

  clock.advance(9U);
  TEST_ASSERT_EQUAL_UINT32(9U, clock.nowMs());

  clock.setNow(0xFFFFF000U);
  clock.advance(0x2000U);
  TEST_ASSERT_EQUAL_UINT32(0x1000U, clock.nowMs());
}

// The fake plus tb::Deadline, which is the only sanctioned way to compare two
// readings. A 30-minute court booking armed 4 seconds before the wrap must
// expire 30 minutes later, not 49.7 days later.
void test_clock_fake_drives_a_deadline_across_the_wrap(void) {
  fakes::FakeClock clock(0xFFFFF000U);
  tb::Deadline booking;
  booking.arm(clock.nowMs(), 30U * 60U * 1000U);

  clock.advance(29U * 60U * 1000U);
  TEST_ASSERT_FALSE(booking.expired(clock.nowMs()));
  TEST_ASSERT_TRUE(clock.value() < 0xFFFFF000U); // the wrap has already happened

  clock.advance(60U * 1000U);
  TEST_ASSERT_TRUE(booking.expired(clock.nowMs()));
  TEST_ASSERT_EQUAL_UINT32(0U, booking.remaining(clock.nowMs()));
}

void test_clock_fake_counts_reads(void) {
  fakes::FakeClock clock;
  TEST_ASSERT_EQUAL_UINT32(0U, clock.reads());
  (void)clock.nowMs();
  (void)clock.nowMs();
  TEST_ASSERT_EQUAL_UINT32(2U, clock.reads());
  clock.resetReads();
  TEST_ASSERT_EQUAL_UINT32(0U, clock.reads());
  TEST_ASSERT_EQUAL_UINT32(0U, clock.value()); // resetReads() is not a time machine
}

// --- transport -------------------------------------------------------------

void test_transport_fake_captures_whole_lines_verbatim(void) {
  fakes::FakeTransport link;
  TEST_ASSERT_TRUE(hal::writeLine(link, "!PING*2E"));
  TEST_ASSERT_TRUE(hal::writeLine(link, "!BTN,A*05"));

  TEST_ASSERT_EQUAL_UINT8(2U, link.lineCount());
  TEST_ASSERT_EQUAL_STRING("!PING*2E", link.line(0U));
  TEST_ASSERT_EQUAL_STRING("!BTN,A*05", link.line(1U));
  TEST_ASSERT_EQUAL_STRING("", link.line(2U));
  TEST_ASSERT_EQUAL_UINT8(0U, link.partialLineLen());
  TEST_ASSERT_EQUAL_UINT32(19U, asU32(link.txPending()));
  TEST_ASSERT_EQUAL_STRING("!PING*2E\n!BTN,A*05\n", link.txText());
  TEST_ASSERT_FALSE(link.captureOverflowed());
  TEST_ASSERT_EQUAL_UINT16(0U, link.overruns());
}

// 64 bytes of TX ring at 9600 baud. Two 40-byte frames do not both fit, and the
// second one is truncated — which the fake reports rather than absorbing.
void test_transport_fake_tx_buffer_overruns_detectably(void) {
  fakes::FakeTransport link;
  const uint8_t* const frame = reinterpret_cast<const uint8_t*>(kFrame40);

  TEST_ASSERT_EQUAL_UINT32(64U, asU32(link.writable()));
  TEST_ASSERT_EQUAL_UINT32(40U, asU32(link.write(frame, 40U)));
  TEST_ASSERT_EQUAL_UINT32(24U, asU32(link.writable()));
  TEST_ASSERT_EQUAL_UINT16(0U, link.overruns());

  TEST_ASSERT_EQUAL_UINT32(24U, asU32(link.write(frame, 40U)));
  TEST_ASSERT_EQUAL_UINT16(1U, link.overruns());
  TEST_ASSERT_EQUAL_UINT16(1U, link.partialWrites());
  TEST_ASSERT_EQUAL_UINT32(16U, asU32(link.droppedBytes()));
  TEST_ASSERT_EQUAL_UINT32(64U, asU32(link.txPending()));
  TEST_ASSERT_EQUAL_UINT32(0U, asU32(link.writable()));

  // The peer consumes; the link recovers, and the transcript is not rewritten.
  link.drainTx();
  TEST_ASSERT_EQUAL_UINT32(64U, asU32(link.writable()));
  TEST_ASSERT_EQUAL_UINT32(40U, asU32(link.write(frame, 40U)));
}

// The all-or-nothing rule: half a frame on the wire fails the peer's checksum
// AND is then glued onto the front of the next frame, so one overrun corrupts
// two messages. writeLine() drops the frame instead.
void test_write_line_refuses_a_frame_that_will_not_fit(void) {
  fakes::FakeTransport link;
  TEST_ASSERT_TRUE(hal::writeLine(link, kFrame40));
  TEST_ASSERT_EQUAL_UINT8(1U, link.lineCount());

  TEST_ASSERT_FALSE(hal::writeLine(link, kFrame40));
  TEST_ASSERT_EQUAL_UINT8(1U, link.lineCount());
  TEST_ASSERT_EQUAL_UINT8(0U, link.partialLineLen()); // nothing half-sent
  TEST_ASSERT_EQUAL_UINT32(41U, asU32(link.txPending()));
  TEST_ASSERT_EQUAL_UINT16(0U, link.overruns()); // refused before it was offered
}

void test_transport_fake_simulates_a_partial_write(void) {
  fakes::FakeTransport link;
  link.setMaxChunk(3U);
  const uint8_t* const frame = reinterpret_cast<const uint8_t*>(kFrame40);

  TEST_ASSERT_EQUAL_UINT32(3U, asU32(link.write(frame, 10U)));
  TEST_ASSERT_EQUAL_UINT16(1U, link.partialWrites());
  TEST_ASSERT_EQUAL_UINT16(0U, link.overruns()); // room existed; the driver stalled
  TEST_ASSERT_EQUAL_UINT32(7U, asU32(link.droppedBytes()));
}

// writable() is advisory. When a port promises room and then under-accepts,
// writeLine() reports failure with a fragment already on the wire — there is no
// un-write. The fake reproduces exactly that, so the handling above it is
// tested rather than assumed.
void test_write_line_reports_failure_when_a_port_under_accepts(void) {
  fakes::FakeTransport link;
  link.setMaxChunk(4U);

  TEST_ASSERT_FALSE(hal::writeLine(link, "!OFF,A*17"));
  TEST_ASSERT_EQUAL_UINT8(0U, link.lineCount());
  TEST_ASSERT_EQUAL_UINT8(4U, link.partialLineLen()); // the fragment, visible
  TEST_ASSERT_EQUAL_STRING("!OFF", link.txText());
}

// A failing driver does not know it is failing, so writable() keeps claiming
// room. Code cannot "handle" this by asking first.
void test_transport_fake_write_failure_is_invisible_to_writable(void) {
  fakes::FakeTransport link;
  link.setWriteFailure(true);

  TEST_ASSERT_EQUAL_UINT32(64U, asU32(link.writable()));
  TEST_ASSERT_EQUAL_UINT32(0U, asU32(link.write(reinterpret_cast<const uint8_t*>("!RST*1B"), 7U)));
  TEST_ASSERT_EQUAL_UINT16(1U, link.failedWrites());
  TEST_ASSERT_EQUAL_UINT32(7U, asU32(link.droppedBytes()));
  TEST_ASSERT_FALSE(hal::writeLine(link, "!RST*1B"));
  TEST_ASSERT_EQUAL_UINT8(0U, link.lineCount());
  TEST_ASSERT_EQUAL_UINT32(0U, asU32(link.txPending()));

  link.setWriteFailure(false);
  TEST_ASSERT_TRUE(hal::writeLine(link, "!RST*1B"));
  TEST_ASSERT_EQUAL_UINT8(1U, link.lineCount());
}

// The ESP reboots on every OTA, so the Mega sees the link go away several times
// per release. Queued RX bytes survive the outage so the recovery path can be
// driven; nothing is delivered while it is down.
void test_transport_fake_disconnection_stops_both_directions(void) {
  fakes::FakeTransport link;
  TEST_ASSERT_TRUE(link.feedLine("!ON,A,900*11"));

  link.setConnected(false);
  uint8_t byte = 0U;
  TEST_ASSERT_FALSE(link.connected());
  TEST_ASSERT_EQUAL_UINT32(0U, asU32(link.writable()));
  TEST_ASSERT_EQUAL_UINT32(0U, asU32(link.write(reinterpret_cast<const uint8_t*>("!PONG"), 5U)));
  TEST_ASSERT_EQUAL_UINT16(1U, link.writesWhileDisconnected());
  TEST_ASSERT_FALSE(link.read(byte));
  TEST_ASSERT_FALSE(hal::writeLine(link, "!PONG*3C"));

  link.setConnected(true);
  TEST_ASSERT_TRUE(link.read(byte));
  TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>('!'), byte);
  TEST_ASSERT_EQUAL_UINT16(12U, link.rxPending()); // the rest of the frame
}

void test_transport_fake_rx_delivers_a_fed_frame_byte_at_a_time(void) {
  fakes::FakeTransport link;
  TEST_ASSERT_TRUE(link.feedLine("!EXT,B,600*4D"));

  char assembled[32] = {};
  uint8_t length = 0U;
  uint8_t byte = 0U;
  while (link.read(byte) && byte != static_cast<uint8_t>('\n')) {
    assembled[length] = static_cast<char>(byte);
    ++length;
  }

  TEST_ASSERT_EQUAL_STRING("!EXT,B,600*4D", assembled);
  TEST_ASSERT_EQUAL_UINT16(0U, link.rxPending());
  TEST_ASSERT_FALSE(link.rxOverflowed());
}

// --- store -----------------------------------------------------------------

void test_store_fake_round_trips_a_value(void) {
  fakes::FakeStore store;
  const uint8_t token[4] = {'A', 'B', 'C', 'D'};
  uint8_t out[8] = {};
  uint8_t outLen = 0U;

  TEST_ASSERT_EQUAL_UINT8(code(hal::StoreResult::kOk), code(store.put("tok", token, 4U)));
  TEST_ASSERT_EQUAL_UINT8(code(hal::StoreResult::kOk), code(store.get("tok", out, 8U, outLen)));
  TEST_ASSERT_EQUAL_UINT8(4U, outLen);
  TEST_ASSERT_EQUAL_UINT8_ARRAY(token, out, 4U);
  TEST_ASSERT_EQUAL_UINT8(1U, store.slotsUsed());
  TEST_ASSERT_EQUAL_UINT16(1U, store.writeCount("tok"));
}

void test_store_fake_reports_missing_keys_and_undersized_buffers(void) {
  fakes::FakeStore store;
  const uint8_t value[4] = {1U, 2U, 3U, 4U};
  uint8_t out[8] = {};
  uint8_t outLen = 9U;

  TEST_ASSERT_EQUAL_UINT8(code(hal::StoreResult::kNotFound), code(store.get("nope", out, 8U, outLen)));
  TEST_ASSERT_EQUAL_UINT8(0U, outLen); // never left holding a stale length
  TEST_ASSERT_EQUAL_UINT8(code(hal::StoreResult::kNotFound), code(store.erase("nope")));

  TEST_ASSERT_EQUAL_UINT8(code(hal::StoreResult::kOk), code(store.put("k", value, 4U)));
  TEST_ASSERT_EQUAL_UINT8(code(hal::StoreResult::kTooLarge), code(store.get("k", out, 2U, outLen)));
  TEST_ASSERT_EQUAL_UINT8(0U, outLen);
  TEST_ASSERT_EQUAL_UINT8(code(hal::StoreResult::kTooLarge),
                          code(store.put("k", value, hal::kStoreMaxValueLen + 1U)));
  TEST_ASSERT_EQUAL_UINT8(code(hal::StoreResult::kTooLarge),
                          code(store.put("a-far-too-long-key", value, 4U)));

  TEST_ASSERT_EQUAL_UINT8(code(hal::StoreResult::kOk), code(store.erase("k")));
  TEST_ASSERT_FALSE(store.exists("k"));
  TEST_ASSERT_EQUAL_UINT8(0U, store.slotsUsed());
}

void test_store_fake_failed_write_leaves_the_previous_value_intact(void) {
  fakes::FakeStore store;
  const uint8_t first[2] = {'O', 'K'};
  const uint8_t second[2] = {'N', 'O'};
  uint8_t out[4] = {};
  uint8_t outLen = 0U;

  TEST_ASSERT_EQUAL_UINT8(code(hal::StoreResult::kOk), code(store.put("id", first, 2U)));
  store.failNextWrite();
  TEST_ASSERT_EQUAL_UINT8(code(hal::StoreResult::kWriteFailed), code(store.put("id", second, 2U)));

  TEST_ASSERT_EQUAL_UINT8(code(hal::StoreResult::kOk), code(store.get("id", out, 4U, outLen)));
  TEST_ASSERT_EQUAL_UINT8_ARRAY(first, out, 2U);

  // One-shot: the next write goes through.
  TEST_ASSERT_EQUAL_UINT8(code(hal::StoreResult::kOk), code(store.put("id", second, 2U)));
  TEST_ASSERT_EQUAL_UINT8(code(hal::StoreResult::kOk), code(store.get("id", out, 4U, outLen)));
  TEST_ASSERT_EQUAL_UINT8_ARRAY(second, out, 2U);
}

// The case that decides the interface. Power goes away two bytes into the
// write: the record is half old and half new, put() says kWriteFailed, and then
// get() returns the mongrel with kOk — because nothing in EEPROM or LittleFS
// remembers that a write was interrupted. Callers must checksum.
void test_store_fake_simulates_a_torn_write(void) {
  fakes::FakeStore store;
  const uint8_t oldValue[4] = {'A', 'A', 'A', 'A'};
  const uint8_t newValue[4] = {'B', 'B', 'B', 'B'};
  const uint8_t torn[4] = {'B', 'B', 'A', 'A'};
  uint8_t out[4] = {};
  uint8_t outLen = 0U;

  TEST_ASSERT_EQUAL_UINT8(code(hal::StoreResult::kOk), code(store.put("cfg", oldValue, 4U)));

  store.tearNextWriteAfter(2U);
  TEST_ASSERT_EQUAL_UINT8(code(hal::StoreResult::kWriteFailed), code(store.put("cfg", newValue, 4U)));

  TEST_ASSERT_EQUAL_UINT8(code(hal::StoreResult::kOk), code(store.get("cfg", out, 4U, outLen)));
  TEST_ASSERT_EQUAL_UINT8(4U, outLen); // the length was never rewritten
  TEST_ASSERT_EQUAL_UINT8_ARRAY(torn, out, 4U);

  // A torn write still costs an erase cycle, so it still wears the cell.
  TEST_ASSERT_EQUAL_UINT16(2U, store.writeCount("cfg"));

  // One-shot: the retry completes.
  TEST_ASSERT_EQUAL_UINT8(code(hal::StoreResult::kOk), code(store.put("cfg", newValue, 4U)));
  TEST_ASSERT_EQUAL_UINT8(code(hal::StoreResult::kOk), code(store.get("cfg", out, 4U, outLen)));
  TEST_ASSERT_EQUAL_UINT8_ARRAY(newValue, out, 4U);
}

// A torn write that created the key leaves a short record that looks complete.
// This is why a length is not an integrity check.
void test_store_fake_torn_write_on_a_new_key_stores_only_what_landed(void) {
  fakes::FakeStore store;
  const uint8_t value[5] = {'1', '2', '3', '4', '5'};
  uint8_t out[8] = {};
  uint8_t outLen = 0U;

  store.tearNextWriteAfter(3U);
  TEST_ASSERT_EQUAL_UINT8(code(hal::StoreResult::kWriteFailed), code(store.put("new", value, 5U)));

  TEST_ASSERT_TRUE(store.exists("new"));
  TEST_ASSERT_EQUAL_UINT8(code(hal::StoreResult::kOk), code(store.get("new", out, 8U, outLen)));
  TEST_ASSERT_EQUAL_UINT8(3U, outLen);
  TEST_ASSERT_EQUAL_UINT8_ARRAY(value, out, 3U);
}

// Reported wear-out is the polite version. The silent mode is what real cells
// do: the write claims success and the cell reads back stale, so code that only
// handles kWornOut has not handled wear-out.
void test_store_fake_simulates_wear_out_both_reported_and_silent(void) {
  fakes::FakeStore store;
  const uint8_t a[1] = {'a'};
  const uint8_t b[1] = {'b'};
  uint8_t out[2] = {};
  uint8_t outLen = 0U;

  store.setWriteLimit(2U);
  TEST_ASSERT_EQUAL_UINT8(code(hal::StoreResult::kOk), code(store.put("wear", a, 1U)));
  TEST_ASSERT_EQUAL_UINT8(code(hal::StoreResult::kOk), code(store.put("wear", a, 1U)));
  TEST_ASSERT_EQUAL_UINT8(code(hal::StoreResult::kWornOut), code(store.put("wear", b, 1U)));

  TEST_ASSERT_EQUAL_UINT8(code(hal::StoreResult::kOk), code(store.get("wear", out, 2U, outLen)));
  TEST_ASSERT_EQUAL_UINT8_ARRAY(a, out, 1U);

  store.setSilentWearOut(true);
  TEST_ASSERT_EQUAL_UINT8(code(hal::StoreResult::kOk), code(store.put("wear", b, 1U)));
  TEST_ASSERT_EQUAL_UINT8(code(hal::StoreResult::kOk), code(store.get("wear", out, 2U, outLen)));
  TEST_ASSERT_EQUAL_UINT8_ARRAY(a, out, 1U); // "succeeded", and still stale
}

void test_store_fake_reports_no_space_when_every_slot_is_taken(void) {
  fakes::FakeStore store;
  const uint8_t value[1] = {'x'};
  const char* const keys[fakes::FakeStore::kSlots] = {"k0", "k1", "k2", "k3", "k4", "k5"};

  for (uint8_t i = 0U; i < fakes::FakeStore::kSlots; ++i) {
    TEST_ASSERT_EQUAL_UINT8(code(hal::StoreResult::kOk), code(store.put(keys[i], value, 1U)));
  }
  TEST_ASSERT_EQUAL_UINT8(fakes::FakeStore::kSlots, store.slotsUsed());
  TEST_ASSERT_EQUAL_UINT8(code(hal::StoreResult::kNoSpace), code(store.put("k6", value, 1U)));

  // Freeing one makes room again, and rewriting an existing key never needs any.
  TEST_ASSERT_EQUAL_UINT8(code(hal::StoreResult::kOk), code(store.put("k0", value, 1U)));
  TEST_ASSERT_EQUAL_UINT8(code(hal::StoreResult::kOk), code(store.erase("k3")));
  TEST_ASSERT_EQUAL_UINT8(code(hal::StoreResult::kOk), code(store.put("k6", value, 1U)));
}

// --- runner ----------------------------------------------------------------

void setUp(void) {
}

void tearDown(void) {
}

int main(int, char**) {
  UNITY_BEGIN();

  RUN_TEST(test_relay_fake_starts_released_and_electrically_high);
  RUN_TEST(test_relay_fake_separates_logical_state_from_electrical_level);
  RUN_TEST(test_relay_level_mapping_is_pinned_for_both_polarities);
  RUN_TEST(test_relay_fake_records_call_order_and_counts_transitions);
  RUN_TEST(test_relay_fake_flags_log_overflow_instead_of_wrapping);
  RUN_TEST(test_relay_fake_ignores_an_out_of_range_channel_and_counts_it);
  RUN_TEST(test_relay_fake_all_off_releases_every_channel);

  RUN_TEST(test_display_fake_starts_blank_and_pads_rows_to_full_width);
  RUN_TEST(test_display_fake_writes_at_an_offset_without_disturbing_neighbours);
  RUN_TEST(test_display_fake_truncates_past_the_last_column);
  RUN_TEST(test_display_fake_drops_writes_past_the_last_row);
  RUN_TEST(test_display_fake_shows_the_tail_a_short_repaint_leaves_behind);
  RUN_TEST(test_display_fake_clear_blanks_every_cell);

  RUN_TEST(test_scanner_fake_delivers_bytes_in_order_then_reports_empty);
  RUN_TEST(test_scanner_fake_reproduces_a_partial_line_then_its_completion);
  RUN_TEST(test_scanner_fake_is_byte_clean_including_nul_and_high_bytes);
  RUN_TEST(test_scanner_fake_reports_overflow_instead_of_dropping_silently);
  RUN_TEST(test_byte_queue_compacts_across_drain_and_refill);

  RUN_TEST(test_button_fake_idles_released_which_is_electrically_high);
  RUN_TEST(test_button_fake_expresses_contact_bounce);
  RUN_TEST(test_button_fake_holds_the_last_level_and_flags_a_spent_script);
  RUN_TEST(test_button_fake_rejects_a_bad_script_and_leaves_the_channel_alone);
  RUN_TEST(test_button_fake_reads_an_unknown_channel_as_released);

  RUN_TEST(test_clock_fake_sits_at_the_wrap_and_steps_across_it);
  RUN_TEST(test_clock_fake_drives_a_deadline_across_the_wrap);
  RUN_TEST(test_clock_fake_counts_reads);

  RUN_TEST(test_transport_fake_captures_whole_lines_verbatim);
  RUN_TEST(test_transport_fake_tx_buffer_overruns_detectably);
  RUN_TEST(test_write_line_refuses_a_frame_that_will_not_fit);
  RUN_TEST(test_transport_fake_simulates_a_partial_write);
  RUN_TEST(test_write_line_reports_failure_when_a_port_under_accepts);
  RUN_TEST(test_transport_fake_write_failure_is_invisible_to_writable);
  RUN_TEST(test_transport_fake_disconnection_stops_both_directions);
  RUN_TEST(test_transport_fake_rx_delivers_a_fed_frame_byte_at_a_time);

  RUN_TEST(test_store_fake_round_trips_a_value);
  RUN_TEST(test_store_fake_reports_missing_keys_and_undersized_buffers);
  RUN_TEST(test_store_fake_failed_write_leaves_the_previous_value_intact);
  RUN_TEST(test_store_fake_simulates_a_torn_write);
  RUN_TEST(test_store_fake_torn_write_on_a_new_key_stores_only_what_landed);
  RUN_TEST(test_store_fake_simulates_wear_out_both_reported_and_silent);
  RUN_TEST(test_store_fake_reports_no_space_when_every_slot_is_taken);

  return UNITY_END();
}
