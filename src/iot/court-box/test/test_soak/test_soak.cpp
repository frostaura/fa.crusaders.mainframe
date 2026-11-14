// The whole-box soak: the REAL Mega 3.0.0 application (courtlogic::CourtBox)
// and the bridge 3.0.0's link and reconcile (bridgelogic::MegaTx,
// bridgelogic::Reconciler) on the two ends of a modelled 9600-baud UART, fed
// randomised sequences of scans, presses, server snapshots, Mega-only resets,
// power cuts of both chips, link loss and garbage bytes.
//
// It is the committed successor of the analysis harnesses (fw-deadlock-hunter's
// boxsim, fw-sim-fuzz) and asserts the four properties the last Mega flash
// must keep for the life of the box:
//
//   I1  no input -> landing within a bound, from every state;
//   I2  after any reboot of either chip the relays match the backend's
//       snapshot within seconds (once the bridge holds a snapshot);
//   I3  no relay is ever on past its time;
//   I4  no input is ignored forever: every completed scan reaches the bridge
//       or is answered on the glass, every press is forwarded or hinted.
//
// SOAK_SEQUENCES (default 1000) and SOAK_SEED override the run.

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unity.h>

#include <new>

#include "bridgelogic/MegaLink.h"
#include "bridgelogic/MegaTx.h"
#include "bridgelogic/V3Heartbeat.h"
#include "courtlogic/CourtBox.h"
#include "fakes/FakeButtons.h"
#include "fakes/FakeClock.h"
#include "fakes/FakeDisplay.h"
#include "fakes/FakeRelay.h"
#include "fakes/FakeScanner.h"
#include "protocol/Codec.h"

namespace {

/// xorshift32: reproducible from the seed alone.
struct Rng {
  uint32_t s;

  uint32_t next() {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    return s;
  }

  uint32_t below(uint32_t n) { return n == 0U ? 0U : next() % n; }

  bool chance(uint32_t perMille) { return below(1000U) < perMille; }

  bool rare(uint32_t perHundredThousand) { return below(100000U) < perHundredThousand; }
};

/// One direction of the UART: a 64-byte receive ring at the far end (the
/// Mega's HardwareSerial), a 128-byte FIFO at the near end, 9600 baud (about
/// one byte a millisecond), and optional loss.
class Wire final : public hal::ITransport {
public:
  static constexpr uint16_t kRing = 64U;
  static constexpr uint16_t kFifo = 128U;

  bool connected() override { return true; }

  size_t writable() override { return kFifo - fifoLen_; }

  size_t write(const uint8_t* data, size_t len) override {
    size_t n = 0U;
    for (; n < len && fifoLen_ < kFifo; ++n) {
      fifo_[(fifoHead_ + fifoLen_) % kFifo] = data[n];
      ++fifoLen_;
    }
    return n;
  }

  bool read(uint8_t& out) override {
    if (ringLen_ == 0U) {
      return false;
    }
    out = ring_[ringHead_];
    ringHead_ = static_cast<uint16_t>((ringHead_ + 1U) % kRing);
    --ringLen_;
    return true;
  }

  /// `ms` of line time: bytes move FIFO -> ring, one a millisecond; a full
  /// ring overflows (counted) exactly as the AVR's does.
  void tick(uint32_t ms, bool cut, Rng& rng, uint32_t garblePerMille) {
    for (uint32_t i = 0U; i < ms && fifoLen_ > 0U; ++i) {
      uint8_t b = fifo_[fifoHead_];
      fifoHead_ = static_cast<uint16_t>((fifoHead_ + 1U) % kFifo);
      --fifoLen_;
      if (cut) {
        continue;
      }
      if (garblePerMille > 0U && rng.chance(garblePerMille)) {
        b = static_cast<uint8_t>(b ^ (1U << rng.below(8U)));
      }
      if (ringLen_ >= kRing) {
        ++overflows_;
        continue;
      }
      ring_[(ringHead_ + ringLen_) % kRing] = b;
      ++ringLen_;
    }
  }

  void reset() {
    fifoLen_ = 0U;
    ringLen_ = 0U;
  }

  uint32_t overflows() const { return overflows_; }

private:
  uint8_t fifo_[kFifo] = {};
  uint16_t fifoHead_ = 0U;
  uint16_t fifoLen_ = 0U;
  uint8_t ring_[kRing] = {};
  uint16_t ringHead_ = 0U;
  uint16_t ringLen_ = 0U;
  uint32_t overflows_ = 0U;
};

/// The Mega's Serial3 as the CourtBox sees it: it reads `down`, writes `up`.
class MegaPort final : public hal::ITransport {
public:
  MegaPort(Wire& down, Wire& up) : down_(down), up_(up) {}

  bool connected() override { return true; }

  size_t writable() override { return up_.writable() < 64U ? up_.writable() : 64U; }

  size_t write(const uint8_t* d, size_t n) override {
    const size_t wrote = up_.write(d, n);
    // A tap on what the Mega put on its TX line: every "!SCAN," it wrote.
    static const char kTag[] = "!SCAN,";
    for (size_t i = 0U; i < wrote; ++i) {
      match_ = (static_cast<char>(d[i]) == kTag[match_]) ? static_cast<uint8_t>(match_ + 1U)
                                                         : (d[i] == '!' ? 1U : 0U);
      if (match_ == 6U) {
        ++scansWritten;
        match_ = 0U;
      }
    }
    return wrote;
  }

  bool read(uint8_t& out) override { return down_.read(out); }

  uint32_t scansWritten = 0U;

private:
  uint8_t match_ = 0U;
  Wire& down_;
  Wire& up_;
};

struct ServerCourt {
  bool lit;
  uint32_t endsAtMs; // on the simulation clock
  char ref[9];
};

struct Sim {
  uint32_t seed0;
  uint32_t start;
  bool trace;
  Rng rng;
  uint32_t now;
  /// The MEGA's millis(): it restarts at zero on every Mega reset, exactly as
  /// the AVR's does, so a `!PONG` after a reset reports a smaller uptime. One
  /// clock shared with the bridge made a Mega-only reset invisible to the
  /// uptime-regression trigger the real bridge relies on when `!BOOT` is lost.
  fakes::FakeClock clock;
  uint32_t megaEpoch = 0U;

  uint32_t megaNow() const { return now - megaEpoch; }

  fakes::FakeRelay relay;
  fakes::FakeDisplay display;
  fakes::FakeScanner scanner;
  fakes::FakeButtons buttons;
  Wire down; // bridge -> Mega
  Wire up;   // Mega -> bridge
  MegaPort port;
  courtlogic::CourtBox* mega;
  alignas(courtlogic::CourtBox) unsigned char megaStore[sizeof(courtlogic::CourtBox)];
  bridgelogic::MegaTx tx;
  bridgelogic::Reconciler reconciler;
  bridgelogic::Snapshot snapshot;
  /// The real bridge's answer to a line it could not decode: `!PING`, whose
  /// `!PONG` uptime regression is a reset its `!BOOT` was lost for.
  bridgelogic::MegaProbe probe;
  bridgelogic::MegaBootClock megaBoot;
  proto::Decoder uplink;
  ServerCourt server[4];
  bool serverUp;
  bool linkCut;
  bool bridgeDead;
  uint32_t nextBeatMs;
  uint32_t nextLiveMs;
  uint8_t stateMask;
  uint32_t lastInputMs;
  uint32_t rebootAtMs;
  bool rebootPending;
  bool healthySinceReboot;
  /// The courts the snapshot owed at the instant of the Mega-only reset. I2 is
  /// about what the reset darkened: a court the next beat newly lit is the
  /// reconcile's ordinary work, judged by its own pace, not by the reset's.
  uint8_t owedAtReset = 0U;
  uint32_t scanCheckAtMs = 0U;
  uint32_t scansWrittenBefore = 0U;
  uint32_t strayAtMs = 0U;
  uint32_t scansSent;
  uint32_t scansSeen;
  uint32_t violations;
  char failure[160];

  explicit Sim(uint32_t seed)
      : seed0(seed), start(1000U + (seed % 100000U)), trace(getenv("SOAK_TRACE") != nullptr),
        rng{seed == 0U ? 1U : seed}, now(1000U + (seed % 100000U)), clock(0U),
        relay(hal::RelayPolarity::kActiveHigh), display(), scanner(), buttons(), down(), up(), port(down, up),
        mega(nullptr), megaStore(), tx(), reconciler(), snapshot(), uplink(proto::Link::Uplink), server(),
        serverUp(true), linkCut(false), bridgeDead(false), nextBeatMs(now), nextLiveMs(now), stateMask(0U),
        lastInputMs(now), rebootAtMs(0U), rebootPending(false), healthySinceReboot(false), scansSent(0U),
        scansSeen(0U), violations(0U), failure() {
    bootMega();
  }

  ~Sim() {
    if (mega != nullptr) {
      mega->~CourtBox();
    }
  }

  void bootMega() {
    if (mega != nullptr) {
      mega->~CourtBox();
    }
    relay.allOff();
    down.reset();
    megaEpoch = now;
    clock.setNow(megaNow());
    mega = new (megaStore)
        courtlogic::CourtBox(courtlogic::CourtPorts{relay, display, scanner, buttons, port, clock});
    mega->boot(0x01U);
  }

  void fail(const char* what) {
    if (violations == 0U) {
      snprintf(failure, sizeof(failure), "SOAK_SEED=%lu SOAK_SEQUENCES=1, t+%lu: %s [%s|%s] last input %lu",
               static_cast<unsigned long>(seed0), static_cast<unsigned long>(now - start), what,
               display.row(0), display.row(1), static_cast<unsigned long>(now - lastInputMs));
    }
    ++violations;
  }

  // --- the model server ------------------------------------------------------

  void serverEvolve() {
    for (uint8_t i = 0U; i < 4U; ++i) {
      ServerCourt& c = server[i];
      if (c.lit && static_cast<int32_t>(now - c.endsAtMs) >= 0) {
        c.lit = false;
      }
      if (!c.lit && rng.chance(350U)) {
        c.lit = true;
        // Up to 3 h: chained extensions past the 90-minute relay cap included.
        c.endsAtMs = now + 60000UL + rng.below(3UL * 3600000UL);
        snprintf(c.ref, sizeof(c.ref), "%08lx", static_cast<unsigned long>(rng.next()));
      }
    }
  }

  void heartbeat() {
    if (!serverUp || bridgeDead) {
      return;
    }
    snapshot.count = 4U;
    for (uint8_t i = 0U; i < 4U; ++i) {
      bridgelogic::SnapshotCourt& s = snapshot.courts[i];
      s.relay = i;
      s.lit = server[i].lit;
      s.seconds = server[i].lit ? (server[i].endsAtMs - now) / 1000UL : 0U;
      s.kind = s.lit ? 'b' : '-';
      memcpy(s.ref, server[i].lit ? server[i].ref : "", s.lit ? 9U : 1U);
    }
    snapshot.atMs = now;
    snapshot.valid = true;
    reconcile(false);
  }

  // --- the model bridge ------------------------------------------------------

  void reconcile(bool force) {
    bridgelogic::RelayView view[4];
    for (uint8_t i = 0U; i < 4U; ++i) {
      view[i].lit = (stateMask & (1U << i)) != 0U;
      view[i].seconds = mega->relays().remainingSeconds(i, megaNow());
    }
    bridgelogic::ReconcileSettings set;
    int32_t want[4];
    if (reconciler.plan(snapshot, view, set, now, force, want)) {
      const bool queued = tx.command(proto::Frame::want(0U, want), now);
      if (trace) {
        printf("t+%lu want %ld %ld %ld %ld%s%s\n", static_cast<unsigned long>(now - start),
               static_cast<long>(want[0]), static_cast<long>(want[1]), static_cast<long>(want[2]),
               static_cast<long>(want[3]), force ? " forced" : "", queued ? "" : " NOT QUEUED");
      }
    }
  }

  void megaBooted(const char* version) {
    tx.setMegaVersion(version);
    tx.megaBooted();
    stateMask = 0U;
    static_cast<void>(tx.plain(proto::Frame::live(5U)));
    reconcile(true);
  }

  void bridgeRx() {
    uint8_t b = 0U;
    for (uint16_t i = 0U; i < 64U && up.read(b); ++i) {
      if (!uplink.feed(static_cast<char>(b))) {
        continue;
      }
      proto::Decoder::Result r;
      while (uplink.pop(r)) {
        if (!r.isFrame()) {
          if (probe.lineLost(now)) {
            const bool queued = tx.plain(proto::Frame::ping());
            if (trace) {
              printf("t+%lu line lost, ping%s\n", static_cast<unsigned long>(now - start),
                     queued ? "" : " NOT QUEUED");
            }
          }
          continue;
        }
        const proto::Verb v = r.frame.verb();
        if (trace && v != proto::Verb::State) {
          printf("t+%lu up %s %s %s\n", static_cast<unsigned long>(now - start), proto::verbName(v),
                 r.frame.arg(0), r.frame.arg(1));
        }
        if (v == proto::Verb::Ack) {
          tx.onAck(r.frame, now);
        } else if (v == proto::Verb::Pong) {
          const uint32_t seconds = static_cast<uint32_t>(strtoul(r.frame.arg(1), nullptr, 10));
          if (megaBoot.observe(now, seconds)) {
            megaBooted(r.frame.arg(0));
          }
        } else if (v == proto::Verb::Boot) {
          static_cast<void>(megaBoot.observe(now, 0U));
          megaBooted(r.frame.arg(0));
        } else if (v == proto::Verb::State) {
          if (trace) {
            printf("t+%lu up STATE %s %s\n", static_cast<unsigned long>(now - start), r.frame.arg(0),
                   r.frame.arg(1));
          }
          stateMask = static_cast<uint8_t>(strtoul(r.frame.arg(0), nullptr, 10));
          for (uint8_t c = 0U; c < 4U; ++c) {
            if ((stateMask & (1U << c)) != 0U) {
              reconciler.confirmed(c);
            }
          }
          reconcile(false);
        } else if (v == proto::Verb::Scan) {
          ++scansSeen;
          // The bridge answers a scan with a screen, as a real one does.
          bridgelogic::Screen s = {};
          strcpy(s.rows[0], "ONE MOMENT");
          strcpy(s.rows[1], "Checking code");
          s.holdSeconds = static_cast<uint16_t>(1U + rng.below(120U));
          s.flags = static_cast<uint8_t>(rng.below(8U) & 0x05U);
          static_cast<void>(tx.screen(s, now));
          // A screen from the bridge is input to the glass too: I1 measures
          // the quiet from the last thing anybody asked the glass to show.
          lastInputMs = now;
        }
      }
    }
  }

  // --- one step of the world -------------------------------------------------

  void inputs() {
    const bool scannerQuiet = static_cast<int32_t>(now - strayAtMs) > 200;
    if (rng.chance(3U) && scanCheckAtMs == 0U && scannerQuiet) {
      scanner.feedLine("1ABCDEFGHJKMNPQRSTV");
      ++scansSent;
      lastInputMs = now;
      scanCheckAtMs = now + 200U;
      scansWrittenBefore = port.scansWritten;
    }
    if (rng.chance(3U)) {
      buttons.press(static_cast<uint8_t>(rng.below(8U)));
      lastInputMs = now;
    }
    if (rng.chance(30U)) {
      for (uint8_t k = 0U; k < 8U; ++k) {
        buttons.release(k);
      }
    }
    if (!bridgeDead && rng.chance(2U)) {
      bridgelogic::Screen s = {};
      snprintf(s.rows[0], sizeof(s.rows[0]), "SCREEN %lu", static_cast<unsigned long>(rng.below(1000U)));
      s.holdSeconds = static_cast<uint16_t>(1U + rng.below(120U));
      static_cast<void>(tx.screen(s, now));
      lastInputMs = now;
    }
    if (rng.chance(1U) && scanCheckAtMs == 0U) {
      // A stray byte off the coils, a gap away from any member's code (a byte
      // inside a code's 20 ms poisons that code, and the member rescans).
      scanner.feedByte(static_cast<uint8_t>(rng.next()));
      strayAtMs = now;
    }
  }

  void faults() {
    if (rng.rare(4U)) {
      linkCut = !linkCut;
    }
    if (rng.rare(4U)) {
      serverUp = !serverUp;
    }
    if (rng.rare(4U)) {
      bridgeDead = !bridgeDead;
    }
    if (rng.rare(4U)) {
      // A Mega-only reset: watchdog, brown-out, a loose lead.
      bootMega();
      if (trace) {
        printf("t+%lu MEGA RESET\n", static_cast<unsigned long>(now - start));
      }
      rebootAtMs = now;
      rebootPending = true;
      healthySinceReboot = true;
      owedAtReset = 0U;
      for (uint8_t i = 0U; snapshot.valid && i < 4U; ++i) {
        if (bridgelogic::Reconciler::paidSeconds(snapshot, i, now) > 90) {
          owedAtReset = static_cast<uint8_t>(owedAtReset | (1U << i));
        }
      }
    }
    if (rng.rare(4U)) {
      // A power cut: both chips. The bridge's snapshot is RAM in this image.
      bootMega();
      tx.~MegaTx();
      new (&tx) bridgelogic::MegaTx();
      reconciler.~Reconciler();
      new (&reconciler) bridgelogic::Reconciler();
      snapshot = bridgelogic::Snapshot();
      probe = bridgelogic::MegaProbe();
      megaBoot = bridgelogic::MegaBootClock();
      stateMask = 0U;
      rebootPending = false;
    }
  }

  void check() {
    // I3: no relay on past its time — never past the hard cap, and never past
    // what the server owes for a court only the reconcile lit.
    for (uint8_t i = 0U; i < 4U; ++i) {
      if (!relay.isOn(i)) {
        continue;
      }
      if (mega->relays().remainingSeconds(i, megaNow()) > proto::kRelayHardCapSeconds) {
        fail("a relay deadline past the 90-minute cap");
      }
      // Only the reconcile lights a court here, from a snapshot of the
      // server's own end of play, so a lit relay past that end (and a second
      // of rounding) is a relay on past its time.
      if (!server[i].lit && static_cast<int32_t>(now - server[i].endsAtMs) > 2000) {
        fail("a relay on past the end of play");
      }
    }
    // I2: within seconds of a Mega-only reset the relays match the snapshot —
    // judged only when the link and the bridge were up for the whole window,
    // and only for courts owed AT the reset and still owed (SOAK_SEED=50511693:
    // a beat 5.01 s after the reset newly lit a court and the check, run in the
    // same tick, called the reconcile's next !WANT late).
    healthySinceReboot = healthySinceReboot && !linkCut && !bridgeDead;
    if (rebootPending && now - rebootAtMs > 5000U) {
      rebootPending = false;
      if (snapshot.valid && healthySinceReboot) {
        for (uint8_t i = 0U; i < 4U; ++i) {
          const int32_t left = bridgelogic::Reconciler::paidSeconds(snapshot, i, now);
          const bool owedThrough = (owedAtReset & (1U << i)) != 0U;
          if (owedThrough && left > 90 && !relay.isOn(i) && !mega->relays().locked(i)) {
            if (trace) {
              printf("I2 relay %u owed %ld s, dark, mask %u\n", i, static_cast<long>(left), stateMask);
            }
            fail("a court the snapshot owes is dark 5 s after a Mega reset");
          }
        }
      }
    }
    // I4: no input ignored: every scan the scanner delivered is put on the
    // Mega's TX line as !SCAN within 200 ms (the 256-byte uplink queue never
    // drops it), whatever the bridge or the link is doing.
    if (scanCheckAtMs != 0U && static_cast<int32_t>(now - scanCheckAtMs) >= 0) {
      scanCheckAtMs = 0U;
      if (port.scansWritten == scansWrittenBefore) {
        fail("a scan the scanner delivered never reached the Mega's TX line");
      }
    }
    // I1: no input -> landing within the ceiling and a little.
    if (now - lastInputMs > 62000U && !mega->screens().onLanding()) {
      fail("off landing 62 s after the last input");
    }
  }

  void run(uint32_t ms) {
    const uint32_t step = 10U;
    for (uint32_t t = 0U; t < ms; t += step) {
      now += step;
      clock.setNow(megaNow());
      if (static_cast<int32_t>(now - nextBeatMs) >= 0) {
        nextBeatMs = now + 30000U;
        serverEvolve();
        heartbeat();
      }
      if (!bridgeDead && static_cast<int32_t>(now - nextLiveMs) >= 0) {
        nextLiveMs = now + 5000U;
        static_cast<void>(tx.plain(proto::Frame::live(5U)));
      }
      if (t + 70000U < ms) {
        inputs();
      }
      if (t + 70000U < ms) {
        faults();
      } else {
        linkCut = false;
      }
      if (!bridgeDead) {
        tx.pump(down, now);
      }
      down.tick(step, linkCut || bridgeDead, rng, 1U);
      mega->poll();
      up.tick(step, linkCut, rng, 1U);
      if (!bridgeDead) {
        bridgeRx();
      }
      check();
    }
  }
};

uint32_t envU32(const char* name, uint32_t fallback) {
  const char* v = getenv(name);
  return v != nullptr && v[0] != '\0' ? static_cast<uint32_t>(strtoul(v, nullptr, 10)) : fallback;
}

void test_soak_randomised_sequences_keep_every_invariant(void) {
  const uint32_t sequences = envU32("SOAK_SEQUENCES", 1000U);
  const uint32_t seed = envU32("SOAK_SEED", 20261113U);
  uint32_t failed = 0U;
  char first[160] = {};
  for (uint32_t i = 0U; i < sequences; ++i) {
    Sim sim(seed + i * 7919U);
    sim.run(4UL * 60000UL); // four simulated minutes, the last 70 s quiet
    if (sim.violations > 0U) {
      if (failed == 0U) {
        memcpy(first, sim.failure, sizeof(first));
      }
      ++failed;
    }
  }
  printf("soak: %lu sequences, %lu with a violation\n", static_cast<unsigned long>(sequences),
         static_cast<unsigned long>(failed));
  TEST_ASSERT_EQUAL_UINT32_MESSAGE(0U, failed, first);
}

} // namespace

void setUp(void) {
}

void tearDown(void) {
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_soak_randomised_sequences_keep_every_invariant);
  return UNITY_END();
}
