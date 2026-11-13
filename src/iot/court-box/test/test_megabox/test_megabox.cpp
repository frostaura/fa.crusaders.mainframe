// Unity tests for the Mega 3.0.0 application (courtlogic::CourtBox) behind the
// host fakes: the v3 link (tags, acknowledgement, duplicates, the uplink
// queue), the relay reconcile and the authorisation cap, the screens and every
// rule that takes one away, the landing and its self-healing glass, bridge
// liveness, the hardware facts and the setup gesture.
//
// 3.0.0 is the LAST Mega image, so each test here is a property the box keeps
// for its whole life, and each regression test names the finding it closes:
// every one fails on the 2.1.0 behaviour (docs/specs/device-serial-protocol.md,
// chapter v3, "What each side must do, by finding").

#include <stdint.h>
#include <string.h>
#include <unity.h>

#include "courtlogic/CourtBox.h"
#include "fwversion/Version.h"
#include "fakes/FakeButtons.h"
#include "fakes/FakeClock.h"
#include "fakes/FakeDisplay.h"
#include "fakes/FakeRelay.h"
#include "fakes/FakeScanner.h"
#include "fakes/FakeTransport.h"
#include "protocol/Codec.h"
#include "protocol/ScreenCrc.h"

namespace {

constexpr uint32_t kBases[] = {0U, 1234567U, 0xFFFFF000U, 0xFFFFFFFFU};
constexpr size_t kBaseCount = sizeof(kBases) / sizeof(kBases[0]);

constexpr uint8_t kCourtA = 0U;
constexpr uint8_t kCourtB = 1U;
constexpr uint8_t kCourtC = 2U;

/// One pass every this many milliseconds when a test lets time run.
constexpr uint32_t kPassMs = 5U;

uint16_t countLines(const fakes::FakeTransport& tx, const char* prefix) {
  uint16_t hits = 0U;
  for (uint8_t i = 0U; i < tx.lineCount(); ++i) {
    if (strncmp(tx.line(i), prefix, strlen(prefix)) == 0) {
      ++hits;
    }
  }
  return hits;
}

bool sent(const fakes::FakeTransport& tx, const char* prefix) {
  return countLines(tx, prefix) > 0U;
}

/// `prefix` with "{V}" replaced by the firmware version this build reports.
const char* withVersion(const char* prefix) {
  static char buf[64];
  const char* at = strstr(prefix, "{V}");
  if (at == nullptr) {
    return prefix;
  }
  const size_t head = static_cast<size_t>(at - prefix);
  memcpy(buf, prefix, head);
  buf[head] = '\0';
  strncat(buf, fw::kFirmwareVersion, sizeof(buf) - strlen(buf) - 1U);
  strncat(buf, at + 3, sizeof(buf) - strlen(buf) - 1U);
  return buf;
}

/// Index of the first captured line starting with `prefix`, or -1.
int indexOf(const fakes::FakeTransport& tx, const char* prefix) {
  for (uint8_t i = 0U; i < tx.lineCount(); ++i) {
    if (strncmp(tx.line(i), prefix, strlen(prefix)) == 0) {
      return i;
    }
  }
  return -1;
}

void feedFrame(fakes::FakeTransport& tx, const proto::Frame& frame) {
  char buf[proto::kMaxFrameLen];
  const size_t len = proto::encode(frame, buf, sizeof(buf));
  TEST_ASSERT_TRUE(len > 0U);
  for (size_t i = 0U; i < len; ++i) {
    TEST_ASSERT_TRUE(tx.feedByte(static_cast<uint8_t>(buf[i])));
  }
}

struct Box {
  fakes::FakeRelay relay;
  fakes::FakeDisplay display;
  fakes::FakeScanner scanner;
  fakes::FakeButtons buttons;
  fakes::FakeTransport bridge;
  fakes::FakeClock clock;
  courtlogic::CourtBox box;
  uint32_t now;

  explicit Box(uint32_t startMs, hal::RelayPolarity polarity = hal::RelayPolarity::kActiveHigh)
      : relay(polarity), display(), scanner(), buttons(), bridge(), clock(startMs),
        box(courtlogic::CourtPorts{relay, display, scanner, buttons, bridge, clock}), now(startMs) {
    box.boot(0x01U);
    bridge.drainTx();
  }

  /// One pass at `t` and the peer reads what the UART carried; the uplink
  /// queue is emptied over as many same-instant passes as it needs.
  void at(uint32_t t) {
    now = t;
    clock.setNow(t);
    box.poll();
    bridge.drainTx();
    for (uint8_t i = 0U; i < 8U && box.txQueued() > 0U; ++i) {
      box.poll();
      bridge.drainTx();
    }
  }

  void pass() { at(now + kPassMs); }

  /// Let `ms` of time run, a pass every kPassMs.
  void run(uint32_t ms) {
    const uint32_t end = now + ms;
    while (static_cast<int32_t>(end - now) > 0) {
      pass();
    }
  }

  void send(const proto::Frame& f) {
    feedFrame(bridge, f);
    pass();
  }

  /// A whole v3 screen: !RW per row in `mask`, then !CMT with the right CRC.
  void screen(uint8_t seq, const char* const rows[4], uint8_t mask, uint32_t hold, uint8_t flags) {
    uint16_t crc = proto::kCrc16Init;
    for (uint8_t r = 0U; r < 4U; ++r) {
      if ((mask & (1U << r)) != 0U) {
        // A row wider than one 24-character segment goes as two.
        char head[proto::kRwSegment + 1U];
        strncpy(head, rows[r], proto::kRwSegment);
        head[proto::kRwSegment] = '\0';
        feedFrame(bridge, proto::Frame::rw(seq, r, 0U, head));
        if (strlen(rows[r]) > proto::kRwSegment) {
          feedFrame(bridge, proto::Frame::rw(seq, r, proto::kRwSegment, rows[r] + proto::kRwSegment));
        }
        crc = proto::screenCrcRow(crc, r, rows[r]);
      }
    }
    pass();
    feedFrame(bridge, proto::Frame::cmt(seq, mask, hold, flags, crc));
    pass();
  }

  /// Hold `key` down long enough to debounce, then release it.
  void press(uint8_t key) {
    buttons.press(key);
    run(100U);
    buttons.release(key);
    run(100U);
  }

  void scan(const char* code) {
    TEST_ASSERT_TRUE(scanner.feedLine(code));
    pass();
  }

  bool glass(uint8_t row, const char* text) const { return strstr(display.row(row), text) != nullptr; }
  bool onLanding() const { return glass(0U, "SCAN YOUR QR") || glass(0U, "OUT OF SERVICE"); }
};

const char* const kVerdict[4] = {"COURT B IS YOURS", "45 MIN TO PLAY", "", ""};

// --- boot (FWM-01, FWM-12, HW-6) -------------------------------------------

void test_boot_sends_boot_then_state_before_anything_and_hw_after_the_lcd(void) {
  fakes::FakeRelay relay(hal::RelayPolarity::kActiveHigh);
  fakes::FakeDisplay display;
  fakes::FakeScanner scanner;
  fakes::FakeButtons buttons;
  fakes::FakeTransport bridge;
  fakes::FakeClock clock(1000U);
  courtlogic::CourtBox box(courtlogic::CourtPorts{relay, display, scanner, buttons, bridge, clock});
  buttons.press(0U);
  buttons.press(3U);
  box.boot(0x08U); // a watchdog reset with courts A and D held down
  bridge.drainTx();
  // Out BEFORE the first poll — i.e. before main() initialises the LCD.
  TEST_ASSERT_EQUAL_INT(0, indexOf(bridge, withVersion("!BOOT,{V},08,09")));
  TEST_ASSERT_EQUAL_INT(1, indexOf(bridge, "!STATE,0,0,0,0,0"));
  TEST_ASSERT_FALSE(sent(bridge, "!HW"));
  clock.setNow(1001U);
  box.poll();
  bridge.drainTx();
  TEST_ASSERT_TRUE(sent(bridge, "!HW,27,0,0,0,0F"));
}

void test_boot_resets_every_setting_but_rst_does_not(void) {
  Box b(5000U);
  b.send(proto::Frame::cfg(1U, "LAYOUT", 1U));
  b.send(proto::Frame::cfg(2U, "CEIL", 30U));
  TEST_ASSERT_TRUE(b.box.settings().layout() == courtlogic::Layout::Expanded);
  b.send(proto::Frame::rst());
  TEST_ASSERT_EQUAL_UINT16(30U, b.box.settings().get(courtlogic::Cfg::Ceil));
  b.box.boot(0x01U);
  TEST_ASSERT_TRUE(b.box.settings().layout() == courtlogic::Layout::Compact);
  TEST_ASSERT_EQUAL_UINT16(60U, b.box.settings().get(courtlogic::Cfg::Ceil));
}

// --- tags, ACKs, duplicates (DL-06) -----------------------------------------

void test_a_tagged_relay_frame_is_acked_and_a_retry_is_not_applied_twice(void) {
  for (size_t i = 0U; i < kBaseCount; ++i) {
    Box b(kBases[i]);
    b.send(proto::Frame::on(proto::Court::B, 600U, 7U));
    TEST_ASSERT_TRUE(sent(b.bridge, "!ACK,7,0"));
    TEST_ASSERT_TRUE(b.relay.isOn(kCourtB));
    b.run(1000U);
    // The retry of a frame whose first copy arrived: code 1, nothing changed —
    // in particular the deadline is not moved by the copy.
    const uint16_t before = b.box.relays().remainingSeconds(kCourtB, b.now);
    b.bridge.clearLines();
    b.send(proto::Frame::on(proto::Court::B, 3000U, 7U));
    TEST_ASSERT_TRUE(sent(b.bridge, "!ACK,7,1"));
    TEST_ASSERT_TRUE(b.box.relays().remainingSeconds(kCourtB, b.now) <= before);
    TEST_ASSERT_EQUAL_UINT16(1U, b.relay.transitions(kCourtB));
    // An untagged frame is v2 exactly: no ACK at all.
    b.bridge.clearLines();
    b.send(proto::Frame::off(proto::Court::B));
    TEST_ASSERT_FALSE(sent(b.bridge, "!ACK"));
    TEST_ASSERT_TRUE(sent(b.bridge, "!EVT,OFF,B"));
  }
}

void test_ext_on_a_dark_relay_is_refused_tagged_and_badarg_untagged(void) {
  Box b(1000U);
  b.send(proto::Frame::ext(proto::Court::A, 600U, 9U));
  TEST_ASSERT_TRUE(sent(b.bridge, "!ACK,9,2"));
  TEST_ASSERT_FALSE(b.relay.isOn(kCourtA));
  b.send(proto::Frame::ext(proto::Court::A, 600U));
  TEST_ASSERT_TRUE(sent(b.bridge, "!ERR,BADARG"));
}

void test_the_uplink_queue_carries_a_burst_the_uart_ring_cannot(void) {
  // 2.1.0 refused any frame that did not fit the 64-byte ring at that
  // instant: an !ACK, a !STATE and an !EVT, then !PONG, !DIAG and !HW, were
  // partly dropped. Now every frame arrives whole, in order.
  Box b(1000U);
  const int32_t want[4] = {600, 600, 600, 600};
  feedFrame(b.bridge, proto::Frame::want(3U, want));
  feedFrame(b.bridge, proto::Frame::ping());
  b.bridge.clearLines();
  b.pass();
  TEST_ASSERT_TRUE(sent(b.bridge, "!ACK,3,0"));
  TEST_ASSERT_TRUE(sent(b.bridge, "!STATE,15,"));
  TEST_ASSERT_TRUE(sent(b.bridge, withVersion("!PONG,{V},")));
  TEST_ASSERT_TRUE(sent(b.bridge, "!DIAG,"));
  TEST_ASSERT_TRUE(sent(b.bridge, "!HW,"));
  TEST_ASSERT_EQUAL_UINT16(0U, b.box.droppedTxFrames());
  TEST_ASSERT_EQUAL_UINT8(0U, b.bridge.partialLineLen());
  TEST_ASSERT_FALSE(b.bridge.captureOverflowed());
}

// --- the relay reconcile and the cap (FWM-01, DL-03, FWM-20) -----------------

void test_want_relights_after_a_mega_only_reset_and_never_opens(void) {
  Box b(1000U);
  b.send(proto::Frame::on(proto::Court::A, 3000U, 1U));
  b.send(proto::Frame::on(proto::Court::C, 3000U, 2U));
  // A Mega-only reset: every relay open, and the bridge hears !BOOT at once.
  b.bridge.clearLines();
  b.box.boot(0x02U);
  b.bridge.drainTx();
  TEST_ASSERT_EQUAL_UINT8(0U, b.box.relays().mask());
  TEST_ASSERT_TRUE(sent(b.bridge, withVersion("!BOOT,{V},02,")));
  // The bridge re-applies its snapshot (DL-03: within 5 s, no release posted).
  const int32_t want[4] = {2900, proto::kNoOpinion, 2900, proto::kNoOpinion};
  b.send(proto::Frame::want(4U, want));
  TEST_ASSERT_EQUAL_UINT8(0x05U, b.box.relays().mask());
  TEST_ASSERT_TRUE(sent(b.bridge, "!ACK,4,0"));
  TEST_ASSERT_TRUE(sent(b.bridge, "!STATE,5,"));
  // A shorter !WANT never shortens, and a '-' never opens.
  const int32_t less[4] = {10, proto::kNoOpinion, proto::kNoOpinion, proto::kNoOpinion};
  b.send(proto::Frame::want(5U, less));
  TEST_ASSERT_TRUE(b.box.relays().remainingSeconds(kCourtA, b.now) > 2800U);
  TEST_ASSERT_TRUE(b.relay.isOn(kCourtC));
}

void test_the_cap_opens_a_relay_kept_up_by_want_and_says_capoff(void) {
  Box b(1000U);
  b.send(proto::Frame::cfg(1U, "CAP", 90U));
  b.send(proto::Frame::on(proto::Court::B, 5400U, 2U));
  const int32_t want[4] = {proto::kNoOpinion, 5400, proto::kNoOpinion, proto::kNoOpinion};
  // A confused live bridge re-wanting every 30 minutes.
  for (uint8_t k = 0U; k < 3U; ++k) {
    b.at(b.now + 30UL * 60000UL - 1000U);
    b.send(proto::Frame::want(static_cast<uint8_t>(10U + k), want));
  }
  b.bridge.clearLines();
  b.at(1000U + 90UL * 60000UL + 500U);
  TEST_ASSERT_FALSE(b.relay.isOn(kCourtB));
  TEST_ASSERT_TRUE(sent(b.bridge, "!EVT,CAPOFF,B"));
  b.send(proto::Frame::want(20U, want));
  TEST_ASSERT_TRUE(sent(b.bridge, "!ACK,20,2"));
  TEST_ASSERT_FALSE(b.relay.isOn(kCourtB));
  b.send(proto::Frame::ping());
  const int diag = indexOf(b.bridge, "!DIAG,0,");
  TEST_ASSERT_TRUE(diag >= 0 && strstr(b.bridge.line(static_cast<uint8_t>(diag)), ",0,0,1*") != nullptr);
}

void test_rpol_changes_redrive_the_closed_relays_and_leave_the_rest_inputs(void) {
  Box b(1000U);
  b.send(proto::Frame::on(proto::Court::A, 600U, 1U));
  TEST_ASSERT_TRUE(b.relay.drive(kCourtA) == hal::PinDrive::kHigh);
  b.send(proto::Frame::cfg(2U, "RPOL", 1U));
  TEST_ASSERT_TRUE(sent(b.bridge, "!ACK,2,0"));
  TEST_ASSERT_TRUE(b.relay.drive(kCourtA) == hal::PinDrive::kLow);
  TEST_ASSERT_TRUE(b.relay.drive(kCourtB) == hal::PinDrive::kInput);
  TEST_ASSERT_TRUE(sent(b.bridge, "!HW,27,1,"));
  b.send(proto::Frame::cfg(3U, "RPOL", 7U));
  TEST_ASSERT_TRUE(sent(b.bridge, "!ACK,3,2"));
  TEST_ASSERT_TRUE(b.relay.drive(kCourtA) == hal::PinDrive::kLow);
}

// --- the screen ceiling (FWM-02, FWM-03, DL-08) -----------------------------

void test_a_phantom_press_every_twelve_seconds_cannot_hold_a_screen_past_the_ceiling(void) {
  for (size_t i = 0U; i < kBaseCount; ++i) {
    Box b(kBases[i]);
    b.screen(1U, kVerdict, 0x03U, 120U, 0U);
    TEST_ASSERT_TRUE(b.glass(0U, "COURT B IS YOURS"));
    TEST_ASSERT_TRUE(sent(b.bridge, "!ACK,S1,0"));
    const uint32_t start = b.now;
    uint32_t landedAt = 0U;
    // 2.1.0 re-armed the hold on every press: 10-12 minutes off landing.
    for (uint8_t k = 0U; k < 6U && landedAt == 0U; ++k) {
      b.press(kCourtA); // a court key, forwarded with the window shut
      for (uint16_t p = 0U; p < 11800U / kPassMs && landedAt == 0U; ++p) {
        b.pass();
        landedAt = b.onLanding() ? b.now - start : 0U;
      }
    }
    // Sampled after each 200 ms press too, hence the press width in the bound.
    TEST_ASSERT_TRUE(landedAt > 0U && landedAt <= 60000U + 200U + 2U * kPassMs);
    TEST_ASSERT_TRUE(sent(b.bridge, "!EVT,CEIL,"));
    TEST_ASSERT_EQUAL_UINT16(1U, b.box.screens().ceilings());
  }
}

void test_flapping_frames_every_five_seconds_still_give_way_to_landing(void) {
  // DL-08: a 2.3.0 bridge repainted its identity overlay on every WiFi edge.
  Box b(1000U);
  uint32_t offLanding = 0U;
  uint32_t longest = 0U;
  for (uint16_t k = 0U; k < 120U; ++k) { // ten minutes
    b.send(proto::Frame::lcd("CONNECTED", "SCAN TO START"));
    for (uint16_t p = 0U; p < 1000U; ++p) {
      b.pass();
      offLanding = b.onLanding() ? 0U : offLanding + kPassMs;
      longest = offLanding > longest ? offLanding : longest;
    }
  }
  TEST_ASSERT_TRUE(longest <= 60000U + 2U * kPassMs);
}

void test_a_commit_inside_the_dwell_is_busy_unless_a_member_is_there(void) {
  Box b(1000U);
  b.send(proto::Frame::cfg(1U, "CEIL", 15U));
  b.screen(1U, kVerdict, 0x03U, 120U, 0U);
  b.run(15100U);
  TEST_ASSERT_TRUE(b.onLanding());
  b.bridge.clearLines();
  b.screen(2U, kVerdict, 0x03U, 10U, 0U);
  TEST_ASSERT_TRUE(sent(b.bridge, "!ACK,S2,4"));
  TEST_ASSERT_TRUE(b.onLanding());
  // A member scans inside the dwell: the next commit is their answer.
  b.scan("1ABCDEFGHJKMNPQRSTV");
  b.screen(3U, kVerdict, 0x03U, 10U, 0U);
  TEST_ASSERT_TRUE(sent(b.bridge, "!ACK,S3,0"));
  TEST_ASSERT_TRUE(b.glass(0U, "COURT B IS YOURS"));
}

void test_after_the_lights_go_on_landing_within_afton(void) {
  Box b(1000U);
  b.screen(1U, kVerdict, 0x03U, 120U, 0U);
  b.send(proto::Frame::on(proto::Court::B, 2700U, 1U));
  b.run(14900U);
  TEST_ASSERT_FALSE(b.onLanding());
  b.run(300U);
  TEST_ASSERT_TRUE(b.onLanding());
  // And a screen committed inside the window ends by then too.
  b.send(proto::Frame::on(proto::Court::C, 2700U, 2U));
  b.run(5000U);
  b.screen(2U, kVerdict, 0x03U, 120U, 0U);
  b.run(10200U);
  TEST_ASSERT_TRUE(b.onLanding());
}

void test_a_dropped_press_ends_the_overlay_with_the_hint(void) {
  Box b(1000U);
  b.screen(1U, kVerdict, 0x03U, 60U, 0U);
  b.press(4U); // a duration key, window shut, KEYS bit clear
  TEST_ASSERT_TRUE(b.onLanding());
  TEST_ASSERT_TRUE(b.glass(1U, "SCAN CODE FIRST"));
  TEST_ASSERT_EQUAL_UINT16(1U, b.box.unauthorisedPresses());
  b.run(3100U);
  TEST_ASSERT_FALSE(b.glass(1U, "SCAN CODE FIRST"));
}

void test_a_remapped_keys_mask_changes_which_unarmed_presses_are_forwarded(void) {
  // HW-7: 2.1.0 compiled the court/duration split; the bridge now sets it.
  Box b(1000U);
  b.press(5U);
  TEST_ASSERT_FALSE(sent(b.bridge, "!BTN,2"));
  b.send(proto::Frame::cfg(1U, "KEYS", 0x20U));
  TEST_ASSERT_TRUE(sent(b.bridge, "!HW,27,0,0,0,20"));
  b.bridge.clearLines();
  b.press(5U);
  TEST_ASSERT_TRUE(sent(b.bridge, "!BTN,2"));
  b.press(0U);
  TEST_ASSERT_FALSE(sent(b.bridge, "!BTN,A"));
  // Armed, every key is forwarded whatever KEYS says.
  b.send(proto::Frame::auth(30U, 2U));
  b.press(0U);
  TEST_ASSERT_TRUE(sent(b.bridge, "!BTN,A"));
}

void test_a_forwarded_press_the_bridge_does_not_answer_gets_the_megas_own_hint(void) {
  Box b(1000U);
  b.press(kCourtA);
  TEST_ASSERT_TRUE(sent(b.bridge, "!BTN,A"));
  b.run(1500U);
  TEST_ASSERT_TRUE(b.glass(1U, "ONE MOMENT"));
}

void test_a_chained_screen_waits_for_its_outcome_instead_of_flashing_landing(void) {
  // DL-14: a greeting followed by its outcome no longer flashes the landing.
  Box b(1000U);
  const char* const greet[4] = {"HI ALEX", "BALANCE 120 MIN", "", ""};
  b.screen(1U, greet, 0x03U, 2U, 0x04U);
  b.run(2300U);
  TEST_ASSERT_TRUE(b.glass(0U, "HI ALEX"));
  b.screen(2U, kVerdict, 0x03U, 10U, 0U);
  TEST_ASSERT_TRUE(b.glass(0U, "COURT B IS YOURS"));
  // Unchained, the wait is not taken.
  b.screen(3U, greet, 0x03U, 2U, 0U);
  b.run(2100U);
  TEST_ASSERT_TRUE(b.onLanding());
}

// --- staging (FWM-06, FWM-07, DL-09) ----------------------------------------

void test_a_lost_rw_paints_nothing_and_is_answered_incomplete(void) {
  Box b(1000U);
  const char* const first[4] = {"TOO FEW MINUTES", "BALANCE 120 MIN", "", ""};
  b.screen(1U, first, 0x03U, 10U, 0U);
  b.run(10100U);
  // The next screen loses its row 1: 2.1.0 painted the old "BALANCE 120 MIN"
  // under the new verdict. Now: nothing painted, ACK code 3.
  b.bridge.clearLines();
  feedFrame(b.bridge, proto::Frame::rw(2U, 0U, 0U, kVerdict[0]));
  uint16_t crc = proto::screenCrcRow(proto::kCrc16Init, 0U, kVerdict[0]);
  crc = proto::screenCrcRow(crc, 1U, kVerdict[1]);
  feedFrame(b.bridge, proto::Frame::cmt(2U, 0x03U, 10U, 0U, crc));
  b.pass();
  TEST_ASSERT_TRUE(sent(b.bridge, "!ACK,S2,3"));
  TEST_ASSERT_TRUE(b.onLanding());
  // Staging was cleared: a commit of row 0 alone under seq 2 fails too.
  feedFrame(b.bridge, proto::Frame::cmt(2U, 0x01U, 10U, 0U, proto::screenCrcRow(proto::kCrc16Init, 0U, kVerdict[0])));
  b.pass();
  TEST_ASSERT_EQUAL_UINT16(2U, countLines(b.bridge, "!ACK,S2,3"));
  // The re-send under a new seq paints.
  b.screen(3U, kVerdict, 0x03U, 10U, 0U);
  TEST_ASSERT_TRUE(b.glass(1U, "45 MIN TO PLAY"));
}

void test_v2_show_clears_staging_so_an_unstaged_row_is_blank(void) {
  Box b(1000U);
  b.send(proto::Frame::row(0U, "TOO FEW MINUTES"));
  b.send(proto::Frame::row(1U, "BALANCE 120 MIN"));
  b.send(proto::Frame::show(5U, 0U));
  b.run(5100U);
  b.send(proto::Frame::row(0U, "COURT B IS YOURS"));
  b.send(proto::Frame::show(5U, 0U));
  TEST_ASSERT_TRUE(b.glass(0U, "COURT B IS YOURS"));
  TEST_ASSERT_FALSE(b.glass(1U, "BALANCE"));
}

void test_a_scan_mid_stage_cannot_tear_the_bridges_screen(void) {
  Box b(1000U);
  feedFrame(b.bridge, proto::Frame::rw(4U, 0U, 0U, kVerdict[0]));
  feedFrame(b.bridge, proto::Frame::rw(4U, 1U, 0U, kVerdict[1]));
  b.pass();
  b.scan("1ABCDEFGHJKMNPQRSTV");
  TEST_ASSERT_TRUE(b.glass(0U, "CHECKING CODE"));
  uint16_t crc = proto::screenCrcRow(proto::kCrc16Init, 0U, kVerdict[0]);
  crc = proto::screenCrcRow(crc, 1U, kVerdict[1]);
  b.send(proto::Frame::cmt(4U, 0x03U, 10U, 0U, crc));
  TEST_ASSERT_TRUE(b.glass(0U, "COURT B IS YOURS"));
  TEST_ASSERT_TRUE(b.glass(1U, "45 MIN TO PLAY"));
}

// --- liveness (FWM-08, DL-10) ------------------------------------------------

void test_a_dead_bridge_reads_out_of_service_within_three_periods(void) {
  for (size_t i = 0U; i < kBaseCount; ++i) {
    Box b(kBases[i]);
    b.send(proto::Frame::live(5U));
    b.send(proto::Frame::idle(0x07U, "1805"));
    TEST_ASSERT_TRUE(b.glass(1U, "READY"));
    b.run(15900U);
    TEST_ASSERT_TRUE(b.glass(0U, "SCAN YOUR QR"));
    b.run(300U);
    TEST_ASSERT_TRUE(b.glass(0U, "OUT OF SERVICE"));
    TEST_ASSERT_TRUE(b.glass(1U, "SEE THE DESK"));
    // A scan has nobody to check it.
    b.scan("1ABCDEFGHJKMNPQRSTV");
    TEST_ASSERT_TRUE(b.glass(0U, "NO CONNECTION"));
    // The first valid frame revives it, and says so.
    b.bridge.clearLines();
    b.send(proto::Frame::ping());
    TEST_ASSERT_TRUE(sent(b.bridge, "!EVT,LIVE,1"));
    TEST_ASSERT_TRUE(b.box.bridgeAlive());
  }
}

void test_a_2_3_0_bridge_that_never_sends_live_is_dead_only_after_330_seconds(void) {
  Box b(1000U);
  b.run(329000U);
  TEST_ASSERT_TRUE(b.box.bridgeAlive());
  b.run(2000U);
  TEST_ASSERT_FALSE(b.box.bridgeAlive());
}

void test_a_dead_bridge_drops_to_compact_and_discards_the_note_and_land(void) {
  Box b(1000U);
  b.send(proto::Frame::live(2U));
  b.send(proto::Frame::cfg(1U, "LAYOUT", 1U));
  const int16_t map[4] = {1, 2, 3, 4};
  b.send(proto::Frame::map(map));
  b.send(proto::Frame::note(600U, "SETUP CRUSADERS-BOX"));
  b.run(500U);
  TEST_ASSERT_TRUE(b.glass(0U, "SCAN YOUR QR CODE"));
  TEST_ASSERT_TRUE(b.glass(3U, "SETUP CRUSADERS-BOX") || b.glass(3U, "COURT 3"));
  b.run(8000U);
  TEST_ASSERT_TRUE(b.box.screens().effectiveLayout() == courtlogic::Layout::Compact);
  TEST_ASSERT_TRUE(b.glass(0U, "OUT OF SERVICE"));
  TEST_ASSERT_EQUAL_STRING("                    ", b.display.row(3U));
}

// --- the landing (Dean's screen) ----------------------------------------------

void test_the_landing_shows_the_call_to_action_and_every_courts_minutes(void) {
  Box b(1000U);
  const int16_t map[4] = {1, 2, 3, 4};
  b.send(proto::Frame::map(map));
  b.send(proto::Frame::idle(0x03U, "----"));
  b.send(proto::Frame::on(proto::Court::C, 2700U, 1U));
  b.run(15500U);
  TEST_ASSERT_TRUE(b.glass(0U, "SCAN YOUR QR"));
  // Compact, marquee on: row 1 scrolls every court and the status.
  bool sawCourt3 = false;
  for (uint16_t p = 0U; p < 4000U && !sawCourt3; ++p) {
    b.pass();
    sawCourt3 = b.glass(1U, "45 MIN") || b.glass(1U, "COURT 3");
  }
  TEST_ASSERT_TRUE(sawCourt3);
  // Expanded: one court per row.
  b.send(proto::Frame::cfg(2U, "LAYOUT", 1U));
  b.run(200U);
  TEST_ASSERT_TRUE(b.glass(0U, "SCAN YOUR QR CODE"));
  TEST_ASSERT_TRUE(b.glass(1U, "COURT 1") && b.glass(1U, "OFF"));
  TEST_ASSERT_TRUE(b.glass(3U, "COURT 3") && b.glass(3U, "ON 45 MIN"));
}

void test_land_shows_paid_time_past_the_relay_cap(void) {
  Box b(1000U);
  b.send(proto::Frame::cfg(1U, "LAYOUT", 1U));
  const int16_t map[4] = {7, 0, 0, 0};
  b.send(proto::Frame::map(map));
  b.send(proto::Frame::on(proto::Court::A, 5400U, 1U));
  const int32_t land[4] = {9000, proto::kNoOpinion, proto::kNoOpinion, proto::kNoOpinion};
  b.send(proto::Frame::land(land));
  b.run(16000U);
  TEST_ASSERT_TRUE(b.glass(1U, "COURT 7") && b.glass(1U, "150 MIN"));
}

void test_one_i2c_glitch_heals_the_call_to_action(void) {
  // DL-04 / FSF-07 / FWM-04 — Dean's stuck screen: one I2C timeout blanked the
  // landing's row 0 for good, because nothing repainted a "static" row.
  Box b(1000U);
  b.run(100U);
  TEST_ASSERT_TRUE(b.glass(0U, "SCAN YOUR QR"));
  b.display.glitch();
  TEST_ASSERT_FALSE(b.glass(0U, "SCAN YOUR QR"));
  b.pass();
  b.pass();
  TEST_ASSERT_TRUE(b.glass(0U, "SCAN YOUR QR"));
}

void test_a_silent_nibble_desync_is_corrected_within_one_reinit_period(void) {
  Box b(1000U);
  b.run(100U);
  const uint16_t before = b.display.reinitCalls();
  b.display.scramble(0U); // garbage nobody reported
  b.run(60500U);
  TEST_ASSERT_TRUE(b.display.reinitCalls() > before);
  TEST_ASSERT_TRUE(b.glass(0U, "SCAN YOUR QR"));
}

void test_a_bus_holdoff_leaves_the_glass_unknown_then_repaints_it_all(void) {
  Box b(1000U);
  b.run(100U);
  b.display.setHolding(true);
  b.display.scramble(0U);
  b.run(1000U);
  b.display.setHolding(false);
  b.pass();
  b.pass();
  TEST_ASSERT_TRUE(b.glass(0U, "SCAN YOUR QR"));
}

void test_the_paint_is_budgeted_so_a_slow_bus_never_blocks_a_pass(void) {
  // DL-02: a whole-screen synchronous paint blocked the Mega for 110-150 ms.
  Box b(1000U);
  b.display.setCellsPerPass(4U);
  b.screen(1U, kVerdict, 0x03U, 10U, 0U);
  for (uint8_t p = 0U; p < 20U; ++p) {
    b.pass();
  }
  TEST_ASSERT_TRUE(b.glass(0U, "COURT B IS YOURS"));
  TEST_ASSERT_TRUE(b.glass(1U, "45 MIN TO PLAY"));
}

void test_a_long_row_scrolls_as_a_marquee_and_is_cut_when_the_marquee_is_off(void) {
  Box b(1000U);
  const char* const rows[4] = {"COURT 3 BOOKED BY THE JUNIOR SQUAD", "SEE THE DESK", "", ""};
  b.screen(1U, rows, 0x03U, 30U, 0U);
  TEST_ASSERT_TRUE(b.glass(0U, "COURT 3 BOOKED B"));
  b.run(4000U);
  TEST_ASSERT_FALSE(b.glass(0U, "COURT 3 BOOKED B"));
  TEST_ASSERT_TRUE(b.glass(1U, "SEE THE DESK"));
  b.send(proto::Frame::cfg(1U, "MARQ", 0U));
  b.screen(2U, rows, 0x03U, 30U, 0U);
  b.run(4000U);
  TEST_ASSERT_TRUE(b.glass(0U, "COURT 3 BOOKED B"));
}

// --- the scanner (FWM-14, HW-5) ----------------------------------------------

void test_a_stray_byte_is_never_glued_onto_the_next_members_code(void) {
  Box b(1000U);
  TEST_ASSERT_TRUE(b.scanner.feed("X"));
  b.run(400U);
  b.scan("1ABCDEFGHJKMNPQRSTV");
  TEST_ASSERT_TRUE(sent(b.bridge, "!SCAN,1ABCDEFGHJKMNPQRSTV*"));
}

void test_a_suffixless_scanner_at_115200_is_found_and_its_code_scanned(void) {
  Box b(1000U);
  b.scanner.setActualBaud(115200U);
  // Three garbage bursts at 9600, landing idle: the Mega moves to 115200.
  for (uint8_t k = 0U; k < 3U; ++k) {
    TEST_ASSERT_TRUE(b.scanner.feed("1ABCDEFGHJKMNPQRSTV"));
    b.run(300U);
  }
  TEST_ASSERT_EQUAL_UINT32(115200U, b.scanner.baud());
  TEST_ASSERT_FALSE(sent(b.bridge, "!SCAN,"));
  TEST_ASSERT_TRUE(b.scanner.feed("1ABCDEFGHJKMNPQRSTV"));
  b.run(300U);
  TEST_ASSERT_TRUE(sent(b.bridge, "!SCAN,1ABCDEFGHJKMNPQRSTV*"));
  TEST_ASSERT_TRUE(sent(b.bridge, "!HW,27,0,5,0,0F"));
  // Locked: garbage no longer moves it.
  for (uint8_t k = 0U; k < 4U; ++k) {
    TEST_ASSERT_TRUE(b.scanner.feedByte(0xC3U));
    b.run(300U);
  }
  TEST_ASSERT_EQUAL_UINT32(115200U, b.scanner.baud());
}

void test_a_forced_sbaud_is_that_rate_only(void) {
  Box b(1000U);
  b.send(proto::Frame::cfg(1U, "SBAUD", 2U));
  TEST_ASSERT_EQUAL_UINT32(19200U, b.scanner.baud());
  TEST_ASSERT_TRUE(sent(b.bridge, "!HW,27,0,2,0,0F"));
}

// --- the hardware facts and the setup gesture (HW-2, HW-6, !HELD) -------------

void test_an_absent_backpack_reports_00(void) {
  Box b(1000U);
  b.display.setAnsweringAddress(0U);
  b.pass();
  TEST_ASSERT_TRUE(sent(b.bridge, "!HW,00,"));
  b.send(proto::Frame::cfg(1U, "LCDA", 0x3FU));
  TEST_ASSERT_EQUAL_UINT8(0x3FU, b.display.requestedAddress());
}

void test_holding_courts_a_and_d_inside_the_boot_window_reports_held_once(void) {
  Box b(1000U);
  b.buttons.press(0U);
  b.buttons.press(3U);
  b.run(4900U);
  TEST_ASSERT_FALSE(sent(b.bridge, "!HELD"));
  b.run(300U);
  TEST_ASSERT_TRUE(sent(b.bridge, "!HELD,09,5"));
  b.run(10000U);
  TEST_ASSERT_EQUAL_UINT16(1U, countLines(b.bridge, "!HELD"));
}

void test_a_chord_begun_after_the_boot_window_is_not_the_gesture(void) {
  Box b(1000U);
  b.run(61000U);
  b.buttons.press(0U);
  b.buttons.press(3U);
  b.run(6000U);
  TEST_ASSERT_FALSE(sent(b.bridge, "!HELD"));
}

// --- what has not changed ---------------------------------------------------

void test_a_dead_bridge_still_loses_the_lights_at_the_deadline(void) {
  for (size_t i = 0U; i < kBaseCount; ++i) {
    Box b(kBases[i]);
    b.send(proto::Frame::on(proto::Court::A, 2U, 1U));
    b.run(2100U);
    TEST_ASSERT_FALSE(b.relay.isOn(kCourtA));
    TEST_ASSERT_TRUE(sent(b.bridge, "!EVT,AUTOOFF,A"));
  }
}

void test_the_clock_is_sampled_once_per_pass(void) {
  Box b(1000U);
  const uint32_t before = b.clock.reads();
  b.clock.setNow(2000U);
  b.box.poll();
  TEST_ASSERT_EQUAL_UINT32(before + 1U, b.clock.reads());
}

void test_pong_carries_the_counters_and_is_followed_by_diag_and_hw(void) {
  Box b(1000U);
  b.press(4U);
  b.bridge.clearLines();
  b.send(proto::Frame::ping());
  const int pong = indexOf(b.bridge, withVersion("!PONG,{V},"));
  const int diag = indexOf(b.bridge, "!DIAG,");
  const int hw = indexOf(b.bridge, "!HW,");
  TEST_ASSERT_TRUE(pong >= 0 && diag == pong + 1 && hw == diag + 1);
  TEST_ASSERT_TRUE(strstr(b.bridge.line(static_cast<uint8_t>(pong)), ",0,0,1*") != nullptr);
}

void test_an_unknown_cfg_key_is_refused_and_changes_nothing(void) {
  Box b(1000U);
  b.send(proto::Frame::cfg(4U, "WIFI", 1U));
  TEST_ASSERT_TRUE(sent(b.bridge, "!ACK,4,2"));
  b.send(proto::Frame::cfg(5U, "STEP", 1U));
  TEST_ASSERT_TRUE(sent(b.bridge, "!ACK,5,0"));
  TEST_ASSERT_EQUAL_UINT16(250U, b.box.settings().get(courtlogic::Cfg::Step));
}

} // namespace

void setUp(void) {
}

void tearDown(void) {
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_boot_sends_boot_then_state_before_anything_and_hw_after_the_lcd);
  RUN_TEST(test_boot_resets_every_setting_but_rst_does_not);
  RUN_TEST(test_a_tagged_relay_frame_is_acked_and_a_retry_is_not_applied_twice);
  RUN_TEST(test_ext_on_a_dark_relay_is_refused_tagged_and_badarg_untagged);
  RUN_TEST(test_the_uplink_queue_carries_a_burst_the_uart_ring_cannot);
  RUN_TEST(test_want_relights_after_a_mega_only_reset_and_never_opens);
  RUN_TEST(test_the_cap_opens_a_relay_kept_up_by_want_and_says_capoff);
  RUN_TEST(test_rpol_changes_redrive_the_closed_relays_and_leave_the_rest_inputs);
  RUN_TEST(test_a_phantom_press_every_twelve_seconds_cannot_hold_a_screen_past_the_ceiling);
  RUN_TEST(test_flapping_frames_every_five_seconds_still_give_way_to_landing);
  RUN_TEST(test_a_commit_inside_the_dwell_is_busy_unless_a_member_is_there);
  RUN_TEST(test_after_the_lights_go_on_landing_within_afton);
  RUN_TEST(test_a_dropped_press_ends_the_overlay_with_the_hint);
  RUN_TEST(test_a_remapped_keys_mask_changes_which_unarmed_presses_are_forwarded);
  RUN_TEST(test_a_forwarded_press_the_bridge_does_not_answer_gets_the_megas_own_hint);
  RUN_TEST(test_a_chained_screen_waits_for_its_outcome_instead_of_flashing_landing);
  RUN_TEST(test_a_lost_rw_paints_nothing_and_is_answered_incomplete);
  RUN_TEST(test_v2_show_clears_staging_so_an_unstaged_row_is_blank);
  RUN_TEST(test_a_scan_mid_stage_cannot_tear_the_bridges_screen);
  RUN_TEST(test_a_dead_bridge_reads_out_of_service_within_three_periods);
  RUN_TEST(test_a_2_3_0_bridge_that_never_sends_live_is_dead_only_after_330_seconds);
  RUN_TEST(test_a_dead_bridge_drops_to_compact_and_discards_the_note_and_land);
  RUN_TEST(test_the_landing_shows_the_call_to_action_and_every_courts_minutes);
  RUN_TEST(test_land_shows_paid_time_past_the_relay_cap);
  RUN_TEST(test_one_i2c_glitch_heals_the_call_to_action);
  RUN_TEST(test_a_silent_nibble_desync_is_corrected_within_one_reinit_period);
  RUN_TEST(test_a_bus_holdoff_leaves_the_glass_unknown_then_repaints_it_all);
  RUN_TEST(test_the_paint_is_budgeted_so_a_slow_bus_never_blocks_a_pass);
  RUN_TEST(test_a_long_row_scrolls_as_a_marquee_and_is_cut_when_the_marquee_is_off);
  RUN_TEST(test_a_stray_byte_is_never_glued_onto_the_next_members_code);
  RUN_TEST(test_a_suffixless_scanner_at_115200_is_found_and_its_code_scanned);
  RUN_TEST(test_a_forced_sbaud_is_that_rate_only);
  RUN_TEST(test_an_absent_backpack_reports_00);
  RUN_TEST(test_holding_courts_a_and_d_inside_the_boot_window_reports_held_once);
  RUN_TEST(test_a_chord_begun_after_the_boot_window_is_not_the_gesture);
  RUN_TEST(test_a_dead_bridge_still_loses_the_lights_at_the_deadline);
  RUN_TEST(test_the_clock_is_sampled_once_per_pass);
  RUN_TEST(test_pong_carries_the_counters_and_is_followed_by_diag_and_hw);
  RUN_TEST(test_an_unknown_cfg_key_is_refused_and_changes_nothing);
  return UNITY_END();
}
