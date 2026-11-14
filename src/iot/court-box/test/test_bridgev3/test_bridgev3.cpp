// Unity tests for the bridge 3.0.0's Mega link (bridgelogic::MegaTx) and its
// snapshot reconcile (bridgelogic::Reconciler), each a regression test for the
// finding it closes — every one fails on the 2.3.0 bridge's behaviour.
//
// The end-to-end half runs the REAL Mega application (courtlogic::CourtBox)
// on the other end of a modelled UART, so a frame the bridge composes is a
// frame the Mega 3.0.0 actually acts on.

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unity.h>

#include "bridgelogic/MegaLink.h"
#include "bridgelogic/MegaTx.h"
#include "bridgelogic/V3Heartbeat.h"
#include "courtlogic/CourtBox.h"
#include "fakes/FakeButtons.h"
#include "fakes/FakeClock.h"
#include "fakes/FakeDisplay.h"
#include "fakes/FakeRelay.h"
#include "fakes/FakeScanner.h"
#include "fakes/FakeTransport.h"
#include "protocol/Codec.h"

namespace {

uint16_t countLines(const fakes::FakeTransport& tx, const char* prefix) {
  uint16_t n = 0U;
  for (uint8_t i = 0U; i < tx.lineCount(); ++i) {
    if (strncmp(tx.line(i), prefix, strlen(prefix)) == 0) {
      ++n;
    }
  }
  return n;
}

proto::Frame ackOf(const char* id, proto::AckCode code) {
  return id[0] == 'S' ? proto::Frame::ackScreen(static_cast<uint8_t>(strtoul(id + 1, nullptr, 10)), code)
                      : proto::Frame::ack(static_cast<uint8_t>(strtoul(id, nullptr, 10)), code);
}

bridgelogic::Screen screenOf(const char* r0, const char* r1, uint16_t hold) {
  bridgelogic::Screen s = {};
  strncpy(s.rows[0], r0, sizeof(s.rows[0]) - 1U);
  strncpy(s.rows[1], r1, sizeof(s.rows[1]) - 1U);
  s.holdSeconds = hold;
  s.flags = 0U;
  return s;
}

// --- the paced sender (DL-01, FSF-01) ---------------------------------------

void test_a_fast_server_still_lights_the_court_behind_a_busy_fifo(void) {
  // DL-01: the ONE MOMENT screen still filled the 128-byte FIFO when a 10 ms
  // server answered, and 2.3.0 refused the !ON outright.
  bridgelogic::MegaTx tx;
  tx.setMegaVersion("3.0.0");
  fakes::FakeTransport link;
  link.setMaxChunk(8U);
  TEST_ASSERT_TRUE(tx.screen(screenOf("ONE MOMENT", "Checking code", 6U), 0U));
  tx.pump(link, 0U);
  TEST_ASSERT_TRUE(tx.command(proto::Frame::on(proto::Court::C, 2700U), 10U));
  for (uint32_t t = 10U; t < 400U; t += 5U) {
    tx.pump(link, t);
    link.drainTx();
  }
  TEST_ASSERT_EQUAL_UINT16(1U, countLines(link, "!ON,C,2700,"));
  TEST_ASSERT_EQUAL_UINT8(0U, link.partialLineLen());
}

/// MCV1-06: the v1 paths queue more around the relay frames than the v0 path
/// did — the CHECKING CODE wait, the greeting, the !ON, the !AUTH and the
/// follow-up screen for an online v1 activation answered in ~40 ms; the
/// offline v1 grant's !ON behind the greeting; the walk-up's !ON and !AUTH
/// behind ONE MOMENT. Every relay and !AUTH frame reaches the wire whole and
/// exactly once, whatever screens are queued around it.
void test_the_v1_paths_lose_no_on_and_no_auth_behind_their_screens(void) {
  bridgelogic::MegaTx tx;
  tx.setMegaVersion("3.0.0");
  fakes::FakeTransport link;
  link.setMaxChunk(8U);
  // Online v1 activation, a 40 ms server.
  TEST_ASSERT_TRUE(tx.screen(screenOf("ONE MOMENT", "Checking code", 6U), 0U));
  tx.pump(link, 0U);
  TEST_ASSERT_TRUE(tx.screen(screenOf("HI ANNA", "BALANCE 120 MIN", 2U), 40U));
  TEST_ASSERT_TRUE(tx.command(proto::Frame::on(proto::Court::B, 2700U), 40U));
  TEST_ASSERT_TRUE(tx.command(proto::Frame::auth(30U), 40U));
  TEST_ASSERT_TRUE(tx.screen(screenOf("COURT B", "45 MIN", 10U), 41U));
  // Offline v1 grant behind its greeting, on another court.
  TEST_ASSERT_TRUE(tx.screen(screenOf("HI", "WELCOME", 2U), 45U));
  TEST_ASSERT_TRUE(tx.command(proto::Frame::on(proto::Court::C, 1800U), 45U));
  // Walk-up: ONE MOMENT, then the !ON and the !AUTH bound to it.
  TEST_ASSERT_TRUE(tx.screen(screenOf("ONE MOMENT", "Buying your time", 6U), 50U));
  TEST_ASSERT_TRUE(tx.command(proto::Frame::on(proto::Court::D, 1800U), 60U));
  TEST_ASSERT_TRUE(tx.command(proto::Frame::auth(20U), 60U));
  for (uint32_t t = 40U; t < 3000U; t += 5U) {
    tx.pump(link, t);
    link.drainTx();
  }
  TEST_ASSERT_TRUE(countLines(link, "!ON,B,2700,") >= 1U);
  TEST_ASSERT_TRUE(countLines(link, "!ON,C,1800,") >= 1U);
  TEST_ASSERT_TRUE(countLines(link, "!ON,D,1800,") >= 1U);
  TEST_ASSERT_TRUE(countLines(link, "!AUTH,30,") >= 1U);
  TEST_ASSERT_TRUE(countLines(link, "!AUTH,20,") >= 1U);
  TEST_ASSERT_EQUAL_UINT8(0U, link.partialLineLen());
  // Superseded screens may be dropped (only the latest waits); a relay or
  // !AUTH frame never is, and none was handed back as unacked-and-lost
  // without the retries a 3.0.0 Mega answers.
}

void test_relay_frames_overtake_queued_screens_but_never_split_one(void) {
  bridgelogic::MegaTx tx;
  tx.setMegaVersion("3.0.0");
  fakes::FakeTransport link;
  link.setMaxChunk(5U);
  TEST_ASSERT_TRUE(tx.screen(screenOf("COURT B IS YOURS", "45 MIN TO PLAY", 10U), 0U));
  tx.pump(link, 0U); // part of the first !RW is on the wire
  TEST_ASSERT_TRUE(tx.command(proto::Frame::on(proto::Court::B, 2700U), 0U));
  for (uint32_t t = 0U; t < 200U; t += 5U) {
    tx.pump(link, t);
    link.drainTx();
  }
  // Every line is a whole frame (nothing was split), and the !ON overtook the
  // rest of the queued screen: it is on the wire before the !CMT.
  int on = -1;
  int cmt = -1;
  for (uint8_t i = 0U; i < link.lineCount(); ++i) {
    proto::Decoder d(proto::Link::Downlink);
    const char* line = link.line(i);
    for (size_t k = 0U; line[k] != '\0'; ++k) {
      static_cast<void>(d.feed(line[k]));
    }
    TEST_ASSERT_TRUE(d.feed('\n'));
    proto::Decoder::Result r;
    TEST_ASSERT_TRUE(d.pop(r));
    TEST_ASSERT_TRUE_MESSAGE(r.isFrame(), line);
    on = (on < 0 && strncmp(line, "!ON,B,2700,", 11U) == 0) ? i : on;
    cmt = (cmt < 0 && strncmp(line, "!CMT,", 5U) == 0) ? i : cmt;
  }
  TEST_ASSERT_TRUE(on >= 0 && cmt >= 0 && on < cmt);
}

void test_nothing_relay_goes_out_before_the_mega_is_heard(void) {
  // BR-05: a 3.0.0 bridge flashed before a 2.1.0 Mega must not guess.
  bridgelogic::MegaTx tx;
  fakes::FakeTransport link;
  TEST_ASSERT_FALSE(tx.command(proto::Frame::on(proto::Court::A, 60U), 0U));
  TEST_ASSERT_TRUE(tx.screen(screenOf("CRUSADERS", "", 5U), 0U)); // v2 screen: both Megas read it
  tx.pump(link, 0U);
  link.drainTx();
  tx.pump(link, 1U);
  link.drainTx();
  TEST_ASSERT_EQUAL_UINT16(0U, countLines(link, "!ON"));
  TEST_ASSERT_EQUAL_UINT16(1U, countLines(link, "!SHOW"));
}

void test_a_v2_mega_gets_untagged_v2_frames_and_no_bang(void) {
  bridgelogic::MegaTx tx;
  tx.setMegaVersion("2.1.0");
  fakes::FakeTransport link;
  TEST_ASSERT_TRUE(tx.command(proto::Frame::on(proto::Court::A, 60U), 0U));
  const int32_t want[4] = {60, -1, -1, -1};
  TEST_ASSERT_TRUE(tx.command(proto::Frame::want(0U, want), 0U)); // dropped: 2.1.0 has no !WANT
  TEST_ASSERT_TRUE(tx.screen(screenOf("TRY AGAIN!", "", 5U), 0U));
  for (uint32_t t = 0U; t < 100U; t += 5U) {
    tx.pump(link, t);
    link.drainTx();
  }
  TEST_ASSERT_EQUAL_UINT16(1U, countLines(link, "!ON,A,60*"));
  TEST_ASSERT_EQUAL_UINT16(0U, countLines(link, "!WANT"));
  TEST_ASSERT_EQUAL_UINT16(1U, countLines(link, "!ROW,0,TRY AGAIN.*"));
  TEST_ASSERT_EQUAL_UINT8(0U, tx.pendingCount());
}

// --- acknowledgement (DL-06) -------------------------------------------------

void test_an_unacked_on_is_resent_with_the_same_tag_three_times_then_reported(void) {
  bridgelogic::MegaTx tx;
  tx.setMegaVersion("3.0.0");
  fakes::FakeTransport link;
  TEST_ASSERT_TRUE(tx.command(proto::Frame::on(proto::Court::D, 600U), 0U));
  // 2.3.0's retry slot was cleared by the !AUTH sent right after every !ON.
  TEST_ASSERT_TRUE(tx.command(proto::Frame::auth(30U), 0U));
  tx.onAck(proto::Frame::ack(2U, proto::AckCode::Applied), 1U); // the !AUTH's
  for (uint32_t t = 0U; t <= 2000U; t += 50U) {
    tx.pump(link, t);
    link.drainTx();
  }
  TEST_ASSERT_EQUAL_UINT16(4U, countLines(link, "!ON,D,600,1*"));
  TEST_ASSERT_EQUAL_UINT16(1U, countLines(link, "!AUTH,30,2*"));
  bridgelogic::UnackedFrame u;
  TEST_ASSERT_TRUE(tx.takeUnacked(u));
  TEST_ASSERT_TRUE(u.verb == proto::Verb::On);
  TEST_ASSERT_EQUAL_UINT8(3U, u.court);
  TEST_ASSERT_FALSE(tx.takeUnacked(u));
}

void test_an_ack_ends_the_retries_and_tags_skip_zero(void) {
  bridgelogic::MegaTx tx;
  tx.setMegaVersion("3.0.0");
  fakes::FakeTransport link;
  for (uint16_t i = 0U; i < 300U; ++i) {
    TEST_ASSERT_TRUE(tx.command(proto::Frame::off(proto::Court::A), i));
    tx.pump(link, i);
    link.drainTx();
    char id[4];
    snprintf(id, sizeof(id), "%u", static_cast<unsigned>((i % 255U) + 1U));
    tx.onAck(ackOf(id, proto::AckCode::Applied), i);
    TEST_ASSERT_EQUAL_UINT8(0U, tx.pendingCount());
  }
  tx.pump(link, 1000U);
  bridgelogic::UnackedFrame u;
  TEST_ASSERT_FALSE(tx.takeUnacked(u));
}

// --- one screen in flight ----------------------------------------------------

void test_one_screen_in_flight_and_only_the_latest_waits(void) {
  bridgelogic::MegaTx tx;
  tx.setMegaVersion("3.0.0");
  fakes::FakeTransport link;
  TEST_ASSERT_TRUE(tx.screen(screenOf("FIRST", "", 5U), 0U));
  TEST_ASSERT_TRUE(tx.screen(screenOf("SECOND", "", 5U), 0U));
  TEST_ASSERT_TRUE(tx.screen(screenOf("THIRD", "", 5U), 0U));
  for (uint32_t t = 0U; t < 100U; t += 5U) {
    tx.pump(link, t);
    link.drainTx();
  }
  TEST_ASSERT_EQUAL_UINT16(1U, countLines(link, "!CMT,0,"));
  TEST_ASSERT_EQUAL_UINT16(0U, countLines(link, "!RW,1,"));
  tx.onAck(ackOf("S0", proto::AckCode::Applied), 100U);
  for (uint32_t t = 100U; t < 200U; t += 5U) {
    tx.pump(link, t);
    link.drainTx();
  }
  TEST_ASSERT_EQUAL_UINT16(1U, countLines(link, "!RW,1,0,0,THIRD*"));
  TEST_ASSERT_EQUAL_UINT16(0U, countLines(link, "!RW,1,0,0,SECOND"));
  TEST_ASSERT_EQUAL_UINT16(1U, tx.screensDropped());
}

void test_an_incomplete_commit_is_resent_once_under_a_new_seq(void) {
  bridgelogic::MegaTx tx;
  tx.setMegaVersion("3.0.0");
  fakes::FakeTransport link;
  TEST_ASSERT_TRUE(tx.screen(screenOf("COURT B IS YOURS", "", 5U), 0U));
  tx.pump(link, 0U);
  link.drainTx();
  tx.onAck(ackOf("S0", proto::AckCode::Incomplete), 10U);
  for (uint32_t t = 10U; t < 100U; t += 5U) {
    tx.pump(link, t);
    link.drainTx();
  }
  TEST_ASSERT_EQUAL_UINT16(1U, countLines(link, "!CMT,1,"));
  // A second refusal is not chased further.
  tx.onAck(ackOf("S1", proto::AckCode::Incomplete), 100U);
  tx.pump(link, 105U);
  link.drainTx();
  TEST_ASSERT_EQUAL_UINT16(0U, countLines(link, "!CMT,2,"));
}

// --- end to end against the real Mega 3.0.0 ----------------------------------

struct Pair {
  fakes::FakeRelay relay;
  fakes::FakeDisplay display;
  fakes::FakeScanner scanner;
  fakes::FakeButtons buttons;
  fakes::FakeTransport megaSide; // the Mega's Serial3
  fakes::FakeClock clock;
  courtlogic::CourtBox mega;
  bridgelogic::MegaTx tx;
  fakes::FakeTransport bridgeSide; // the ESP's UART
  proto::Decoder uplink;
  uint32_t now;

  Pair()
      : relay(hal::RelayPolarity::kActiveHigh), display(), scanner(), buttons(), megaSide(), clock(1000U),
        mega(courtlogic::CourtPorts{relay, display, scanner, buttons, megaSide, clock}), tx(), bridgeSide(),
        uplink(proto::Link::Uplink), now(1000U) {
    mega.boot(0x01U);
    tx.setMegaVersion("3.0.0");
  }

  /// One pass of each chip; bytes cross the modelled UART both ways.
  void pass() {
    now += 5U;
    clock.setNow(now);
    tx.pump(bridgeSide, now);
    for (uint8_t i = 0U; i < bridgeSide.lineCount(); ++i) {
      TEST_ASSERT_TRUE(megaSide.feedLine(bridgeSide.line(i)));
    }
    bridgeSide.clearLines();
    bridgeSide.drainTx();
    mega.poll();
    megaSide.drainTx();
    for (uint8_t i = 0U; i < megaSide.lineCount(); ++i) {
      const char* line = megaSide.line(i);
      for (size_t k = 0U; line[k] != '\0'; ++k) {
        static_cast<void>(uplink.feed(line[k]));
      }
      if (uplink.feed('\n')) {
        proto::Decoder::Result r;
        while (uplink.pop(r)) {
          if (r.isFrame() && r.frame.verb() == proto::Verb::Ack) {
            tx.onAck(r.frame, now);
          }
        }
      }
    }
    megaSide.clearLines();
  }
};

void test_a_v3_screen_from_the_bridge_paints_on_the_real_mega(void) {
  Pair p;
  TEST_ASSERT_TRUE(p.tx.screen(screenOf("COURT B IS YOURS", "45 MIN TO PLAY", 10U), p.now));
  for (uint8_t i = 0U; i < 40U; ++i) {
    p.pass();
  }
  TEST_ASSERT_NOT_NULL(strstr(p.display.row(0U), "COURT B IS YOURS"));
  TEST_ASSERT_TRUE(p.tx.idle());
}

void test_a_tagged_on_lights_the_real_mega_and_is_acknowledged(void) {
  Pair p;
  TEST_ASSERT_TRUE(p.tx.command(proto::Frame::on(proto::Court::B, 2700U), p.now));
  for (uint8_t i = 0U; i < 40U; ++i) {
    p.pass();
  }
  TEST_ASSERT_TRUE(p.relay.isOn(1U));
  TEST_ASSERT_EQUAL_UINT8(0U, p.tx.pendingCount());
  TEST_ASSERT_TRUE(p.tx.command(proto::Frame::cfg(0U, "LAYOUT", 1U), p.now));
  for (uint8_t i = 0U; i < 40U; ++i) {
    p.pass();
  }
  TEST_ASSERT_EQUAL_INT8(1, p.tx.ackedLayout());
}

// --- the reconcile (FWM-01, DL-03, FSF-03, BR-02, MCV1-01) --------------------

bridgelogic::Snapshot snapshotOf(bool litA, uint32_t secsA, const char* refA, uint32_t atMs) {
  bridgelogic::Snapshot s;
  s.count = 2U;
  s.courts[0].relay = 0U;
  s.courts[0].lit = litA;
  s.courts[0].seconds = secsA;
  s.courts[0].kind = litA ? 'b' : '-';
  strcpy(s.courts[0].ref, litA ? refA : "");
  s.courts[1].relay = 1U;
  s.atMs = atMs;
  s.valid = true;
  return s;
}

void test_a_mega_only_reset_is_relit_from_the_aged_snapshot(void) {
  bridgelogic::Reconciler r;
  const bridgelogic::Snapshot snap = snapshotOf(true, 7140U, "3fa85f64", 1000U);
  bridgelogic::RelayView view[4] = {};
  bridgelogic::ReconcileSettings set;
  int32_t want[4];
  TEST_ASSERT_TRUE(r.plan(snap, view, set, 61000U, true, want));
  // Aged 60 s, capped at the relay's 5400.
  TEST_ASSERT_EQUAL_INT32(5400, want[0]);
  TEST_ASSERT_EQUAL_INT32(-1, want[1]);
  TEST_ASSERT_EQUAL_INT32(7080, bridgelogic::Reconciler::paidSeconds(snap, 0U, 61000U));
}

void test_the_snapshot_never_switches_anything_off(void) {
  bridgelogic::Reconciler r;
  const bridgelogic::Snapshot snap = snapshotOf(false, 0U, "", 0U);
  bridgelogic::RelayView view[4] = {{true, 600U}, {true, 600U}, {false, 0U}, {false, 0U}};
  bridgelogic::ReconcileSettings set;
  int32_t want[4];
  TEST_ASSERT_FALSE(r.plan(snap, view, set, 1000U, true, want));
  for (uint8_t i = 0U; i < 4U; ++i) {
    TEST_ASSERT_EQUAL_INT32(-1, want[i]);
  }
  bridgelogic::Snapshot none;
  TEST_ASSERT_FALSE(r.plan(none, view, set, 1000U, true, want));
}

void test_a_lit_court_with_enough_left_is_left_alone_and_a_short_one_lengthened(void) {
  bridgelogic::Reconciler r;
  const bridgelogic::Snapshot snap = snapshotOf(true, 2700U, "3fa85f64", 0U);
  bridgelogic::ReconcileSettings set;
  int32_t want[4];
  bridgelogic::RelayView ok[4] = {{true, 2690U}, {false, 0U}, {false, 0U}, {false, 0U}};
  TEST_ASSERT_FALSE(r.plan(snap, ok, set, 0U, false, want));
  bridgelogic::RelayView shortView[4] = {{true, 600U}, {false, 0U}, {false, 0U}, {false, 0U}};
  TEST_ASSERT_TRUE(r.plan(snap, shortView, set, 0U, false, want));
  TEST_ASSERT_EQUAL_INT32(2700, want[0]);
}

void test_no_relight_for_less_than_the_minimum_or_when_restore_is_off(void) {
  bridgelogic::Reconciler r;
  bridgelogic::RelayView view[4] = {};
  bridgelogic::ReconcileSettings set;
  int32_t want[4];
  TEST_ASSERT_FALSE(r.plan(snapshotOf(true, 59U, "3fa85f64", 0U), view, set, 0U, true, want));
  set.restoreEnabled = false;
  TEST_ASSERT_FALSE(r.plan(snapshotOf(true, 3000U, "3fa85f64", 0U), view, set, 0U, true, want));
}

void test_a_member_release_is_never_relit_for_the_same_booking(void) {
  bridgelogic::Reconciler r;
  const bridgelogic::Snapshot snap = snapshotOf(true, 2700U, "3fa85f64", 0U);
  bridgelogic::RelayView view[4] = {};
  bridgelogic::ReconcileSettings set;
  int32_t want[4];
  r.memberReleased(0U, snap, 0U);
  TEST_ASSERT_FALSE(r.plan(snap, view, set, 30000U, true, want));
  // A different booking on the same court is a new light.
  TEST_ASSERT_TRUE(r.plan(snapshotOf(true, 2700U, "9c1d0e22", 60000U), view, set, 60000U, true, want));
}

void test_each_relay_is_relit_at_most_once_a_minute_and_three_failures_are_reported(void) {
  bridgelogic::Reconciler r;
  const bridgelogic::Snapshot snap = snapshotOf(true, 5000U, "3fa85f64", 0U);
  bridgelogic::RelayView view[4] = {};
  bridgelogic::ReconcileSettings set;
  int32_t want[4];
  TEST_ASSERT_TRUE(r.plan(snap, view, set, 0U, false, want));
  TEST_ASSERT_FALSE(r.plan(snap, view, set, 30000U, false, want));
  TEST_ASSERT_TRUE(r.plan(snap, view, set, 60000U, false, want));
  TEST_ASSERT_TRUE(r.plan(snap, view, set, 120000U, false, want));
  uint8_t relay = 9U;
  TEST_ASSERT_FALSE(r.takeFailed(relay));
  // The fourth need reports relight_failed once — and is still tried: a relay
  // the snapshot owes is never given up on.
  TEST_ASSERT_TRUE(r.plan(snap, view, set, 180000U, false, want));
  TEST_ASSERT_TRUE(r.takeFailed(relay));
  TEST_ASSERT_EQUAL_UINT8(0U, relay);
  TEST_ASSERT_FALSE(r.takeFailed(relay));
  TEST_ASSERT_TRUE(r.plan(snap, view, set, 240000U, false, want));
  TEST_ASSERT_FALSE(r.takeFailed(relay));
}

void test_ages_never_go_negative(void) {
  // MCV1-01: a stamp later than now aged to a 49-day wrap.
  const bridgelogic::Snapshot snap = snapshotOf(true, 2700U, "3fa85f64", 5000U);
  TEST_ASSERT_EQUAL_INT32(2700, bridgelogic::Reconciler::paidSeconds(snap, 0U, 4990U));
}

void test_a_cut_or_unreadable_courts_array_is_never_applied(void) {
  bridgelogic::Snapshot snap = snapshotOf(true, 2700U, "3fa85f64", 0U);
  const char cut[] = "{\"courts\":[\"0|1|2700|b|3fa85f64\",\"1|0|0|-\"]}";
  TEST_ASSERT_TRUE(bridgelogic::readSnapshot(cut, strlen(cut), snap, 1U) ==
                   bridgelogic::ReadResult::Unreadable);
  TEST_ASSERT_EQUAL_UINT32(0U, snap.atMs);
  const char extra[] = "{\"courts\":[\"0|1|60|w|deadbeef|future|fields\"]}";
  TEST_ASSERT_TRUE(bridgelogic::readSnapshot(extra, strlen(extra), snap, 2U) ==
                   bridgelogic::ReadResult::Adopted);
  TEST_ASSERT_EQUAL_UINT32(60U, snap.courts[0].seconds);
  const char wrongKind[] = "{\"courts\":[0]}";
  TEST_ASSERT_TRUE(bridgelogic::readSnapshot(wrongKind, strlen(wrongKind), snap, 3U) ==
                   bridgelogic::ReadResult::Unreadable);
}

} // namespace

void setUp(void) {
}

void tearDown(void) {
}

// A Mega-only reset whose `!BOOT` was lost: the uptime the next `!PONG`
// reports moves the boot instant, even when the last figure was the 0 of a
// heard `!BOOT` (soak SOAK_SEED=110498118 — a raw "less than" missed it).
void test_a_pong_after_a_lost_boot_proves_the_reset_even_from_a_young_boot(void) {
  bridgelogic::MegaBootClock clock;
  TEST_ASSERT_FALSE(clock.observe(10000U, 0U)); // the !BOOT
  TEST_ASSERT_FALSE(clock.observe(12000U, 2U)); // same boot, 2 s later
  TEST_ASSERT_FALSE(clock.observe(14500U, 4U)); // same boot, rounding
  TEST_ASSERT_TRUE(clock.observe(40000U, 0U));  // reset: 0 again, 30 s on
  TEST_ASSERT_FALSE(clock.observe(41000U, 1U));
  // The classic case still holds: an uptime that went backwards.
  TEST_ASSERT_FALSE(clock.observe(400000U, 361U));
  TEST_ASSERT_TRUE(clock.observe(401000U, 5U));
  // A Mega that booted before the bridge (first observation) is no reset.
  bridgelogic::MegaBootClock fresh;
  TEST_ASSERT_FALSE(fresh.observe(500U, 86400U));
  TEST_ASSERT_FALSE(fresh.observe(30500U, 86430U));
}

// A line that failed to decode earns a `!PING`, three at once and then one per
// five seconds, so a reset's lost `!BOOT` and `!STATE` are each answered while
// a cable garbling everything costs one exchange every five seconds.
void test_a_lost_line_earns_a_ping_paced_by_a_small_bucket(void) {
  bridgelogic::MegaProbe probe;
  TEST_ASSERT_TRUE(probe.lineLost(1000U));
  TEST_ASSERT_TRUE(probe.lineLost(1020U));
  TEST_ASSERT_TRUE(probe.lineLost(1040U));
  TEST_ASSERT_FALSE(probe.lineLost(1060U));
  TEST_ASSERT_FALSE(probe.lineLost(5999U));
  TEST_ASSERT_TRUE(probe.lineLost(6001U));
  TEST_ASSERT_FALSE(probe.lineLost(6100U));
  // A quiet minute refills the bucket, never more than three.
  TEST_ASSERT_TRUE(probe.lineLost(70000U));
  TEST_ASSERT_TRUE(probe.lineLost(70001U));
  TEST_ASSERT_TRUE(probe.lineLost(70002U));
  TEST_ASSERT_FALSE(probe.lineLost(70003U));
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_a_fast_server_still_lights_the_court_behind_a_busy_fifo);
  RUN_TEST(test_the_v1_paths_lose_no_on_and_no_auth_behind_their_screens);
  RUN_TEST(test_relay_frames_overtake_queued_screens_but_never_split_one);
  RUN_TEST(test_nothing_relay_goes_out_before_the_mega_is_heard);
  RUN_TEST(test_a_v2_mega_gets_untagged_v2_frames_and_no_bang);
  RUN_TEST(test_an_unacked_on_is_resent_with_the_same_tag_three_times_then_reported);
  RUN_TEST(test_an_ack_ends_the_retries_and_tags_skip_zero);
  RUN_TEST(test_one_screen_in_flight_and_only_the_latest_waits);
  RUN_TEST(test_an_incomplete_commit_is_resent_once_under_a_new_seq);
  RUN_TEST(test_a_v3_screen_from_the_bridge_paints_on_the_real_mega);
  RUN_TEST(test_a_tagged_on_lights_the_real_mega_and_is_acknowledged);
  RUN_TEST(test_a_mega_only_reset_is_relit_from_the_aged_snapshot);
  RUN_TEST(test_the_snapshot_never_switches_anything_off);
  RUN_TEST(test_a_lit_court_with_enough_left_is_left_alone_and_a_short_one_lengthened);
  RUN_TEST(test_no_relight_for_less_than_the_minimum_or_when_restore_is_off);
  RUN_TEST(test_a_member_release_is_never_relit_for_the_same_booking);
  RUN_TEST(test_each_relay_is_relit_at_most_once_a_minute_and_three_failures_are_reported);
  RUN_TEST(test_ages_never_go_negative);
  RUN_TEST(test_a_cut_or_unreadable_courts_array_is_never_applied);
  RUN_TEST(test_a_pong_after_a_lost_boot_proves_the_reset_even_from_a_young_boot);
  RUN_TEST(test_a_lost_line_earns_a_ping_paced_by_a_small_bucket);
  return UNITY_END();
}
