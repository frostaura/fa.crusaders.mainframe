// Crusaders Mainframe — the faults a door gate has, counted rather than sent.
//
// THE PROBLEM
// -----------
// This board has ONE LED and no screen. Everything it notices about itself —
// a corrupt line off the GM65, a `/gate` call that 500ed, a queue that
// overflowed while the radio was away, a release time the server and the board
// disagree about — is visible nowhere at all. `eventq::Kind::Fault` has existed
// since the queue was written, renders as `"fault"`, and nothing has ever
// emitted one.
//
// WHY THE EVENT QUEUE AND NOT THE HEARTBEAT
// -----------------------------------------
// A fault channel carried on the heartbeat is lost on every MISSED heartbeat,
// which is precisely when faults happen: a board that cannot reach the API is a
// board whose faults are about not reaching the API. The queue survives an
// outage, it is already deduplicated on (TenantId, DeviceId, Seq), and the
// backend already lands an event kind it does not recognise as a receipt plus
// an audit row through its own fall-through — so a `fault` event arrives today
// with no backend change at all.
//
// WHY AGGREGATION IS THE RATE LIMIT, AND NOT A RATE LIMIT ON TOP OF ONE
// ---------------------------------------------------------------------
// The faults this board has are the ones that arrive in HUNDREDS. 9600 baud on
// jumper wire beside a switching relay coil produces holed lines by the dozen a
// minute; a proxy that has fallen over produces one `http_5xx` per heartbeat
// and one per drain. A queue of 64 slots filled with those is an evening of
// door entries evicted to keep a record of noise — which is round G4's H1 with
// a new cause, and `isDiscardable(Kind::Fault)` is only half an answer because
// it protects the OTHER kinds and not the ring's own churn.
//
// So a fault is COUNTED, never queued. One event per code per window carries
// the COUNT of everything that happened since the last one, in `duration_ms`.
// Four hundred errors a minute cost one event every three minutes carrying
// 1200, instead of four hundred events a minute carrying 1 each. Dropping a
// fault is then impossible rather than merely unlikely: what is dropped is a
// REPORT, and the number it would have carried is still in the next one.
//
// THE SECOND BOUND, AND WHY A COUNT NEEDS ONE
// -------------------------------------------
// A window per code bounds the RATE and not the VARIETY. A code built from
// something the outside world supplies — `boot_reason_<x>` is the shape, and a
// future one will be worse — could otherwise mint an unbounded number of codes,
// each with its own window, each queueing immediately. So at most
// `kMaxFaultCodes` distinct codes are tracked at once and a further one
// increments `fault_overflow`, which is reported under its own code with its
// own window and has a counter of its OWN rather than a slot: a board with
// eight live faults must still be able to say that there were more.
//
// THE VOCABULARY IS CLOSED, and that is a wire decision rather than tidiness.
// The backend normalises and caps `kind` at 32 characters, the subject field
// holds 32 bytes, and a code assembled at runtime from bytes this board did not
// choose is a subject somebody else writes. Every code below is a literal in
// this header.
//
// No Arduino headers, no heap, no String. Compiles for Xtensa and the host, and
// at gnu++11 for the generated sketch — so no multi-statement constexpr
// function lives here.

#ifndef CRUSADERS_GATELOGIC_FAULTLOG_H
#define CRUSADERS_GATELOGIC_FAULTLOG_H

#include <stddef.h>
#include <stdint.h>

#include "eventq/Event.h"
#include "timebase/TimeBase.h"

// --- the two settings, as build flags with the tenant's as the override ------

/// Whether this board reports faults at all, until a heartbeat says otherwise.
///
/// A build flag as well as a setting for the reason every other timing on this
/// board is one: `tools/strict_compile.sh` compiles these headers with no
/// PlatformIO flags and so does any editor, and a header that only compiles
/// under one build system is a header nobody can read in isolation.
#ifndef FAULT_REPORT
#define FAULT_REPORT 1
#endif

/// How many fault EVENTS this board may queue per code per hour, until a
/// heartbeat says otherwise.
///
/// Twenty, which is one every three minutes per code. With eight codes live
/// that is 160 events an hour against a ring of 64 that drains one per pass, so
/// the worst case is comfortably inside what a healthy link clears and is
/// aggregated rather than lost when the link is not healthy.
#ifndef FAULT_MAX_PER_HOUR
#define FAULT_MAX_PER_HOUR 20
#endif

namespace gatelogic {

// --- the closed vocabulary ---------------------------------------------------
//
// SHARED WITH THE COURT BOX, which has the same eight and none of the five
// below them. Lowercase snake, 32 characters or fewer, and a literal rather
// than anything assembled: see the header.

inline constexpr char kFaultHttp4xx[] = "http_4xx";
inline constexpr char kFaultHttp5xx[] = "http_5xx";
inline constexpr char kFaultHttpTimeout[] = "http_timeout";
inline constexpr char kFaultQueueOverflow[] = "queue_overflow";
inline constexpr char kFaultBreakerOpen[] = "api_breaker_open";
inline constexpr char kFaultHeartbeatRejected[] = "heartbeat_rejected";
inline constexpr char kFaultWdtReset[] = "wdt_reset";
inline constexpr char kFaultClockCorrected[] = "clock_corrected";

/// The ninth distinct code, and every one after it. See the header for why it
/// has a counter of its own rather than one of the tracked slots.
inline constexpr char kFaultOverflow[] = "fault_overflow";

// Gate-specific.

/// A corrupt line off the GM65 — a byte outside the roster's token alphabet, or
/// a UART overrun. Silent on this board until now: the member got a denial
/// blink and nobody anywhere could tell a noisy cable from a dead code.
inline constexpr char kFaultScannerUartError[] = "scanner_uart_error";

/// `ScanAssembler` refused a line for being longer than the token cap. Distinct
/// from the above because an over-long QR code is somebody presenting the wrong
/// thing and line noise is a cable that needs re-routing, and the fix differs.
inline constexpr char kFaultScanOversize[] = "scan_oversize";

/// A `hal::IStore` write did not complete. The only record on this board is the
/// event queue's sequence high-water mark, and a torn one renumbers the board
/// against a permanent unique index on the server — round G4's C2, which
/// `boot_id` makes survivable rather than invisible.
inline constexpr char kFaultNvsWriteFailed[] = "nvs_write_failed";

/// The adopted `gate.unlock_seconds` was outside [1, 30] and the board's own
/// clamp changed it. The server and this board disagree about what this door
/// should do, and no other surface on this hardware could say so.
inline constexpr char kFaultUnlockClamped[] = "unlock_clamped";

/// The lock stayed released past the hard cap AND past the documented overrun a
/// blocking call can add to it. See `GateApp.h`'s release-bound arithmetic: a
/// release longer than that is a board that did not get back to its own relay,
/// which is the failure the whole of that arithmetic exists to bound.
inline constexpr char kFaultRelockOverdue[] = "relock_overdue";

/// `boot_reason_<x>` from `esp_reset_reason()`, one code per reason. The
/// composition root supplies the whole string — this header cannot, because
/// `esp_reset_reason()` is an IDF call and no `lib/` but `esp32_hal/` may see
/// one.
inline constexpr char kFaultBootReasonPrefix[] = "boot_reason_";

// --- bounds -----------------------------------------------------------------

/// The backend normalises and caps `kind` at 32 characters and the event's
/// subject holds 32 bytes, so 32 is the cap at both ends of the wire.
inline constexpr size_t kMaxFaultCodeLen = 32U;

/// Distinct codes tracked at once. Eight, because the vocabulary above has
/// thirteen and no board has ever been observed with more than three live at
/// once; a ninth is counted rather than lost. A slot is 44 bytes, so the whole
/// log is under 400 bytes of a part with 40 KB of usable heap.
inline constexpr uint8_t kMaxFaultCodes = 8U;

inline constexpr uint16_t kMinFaultMaxPerHour = 1U;
inline constexpr uint16_t kMaxFaultMaxPerHour = 120U;

inline constexpr uint32_t kFaultHourMs = 3600000UL;

/// The compile-time fallbacks as values rather than macros, so the class the
/// orchestration is written against is the one the board actually builds.
inline constexpr bool kFaultReportingDefault = (FAULT_REPORT) != 0;
inline constexpr uint16_t kFaultMaxPerHourDefault = static_cast<uint16_t>(FAULT_MAX_PER_HOUR);

static_assert(kFaultMaxPerHourDefault >= kMinFaultMaxPerHour &&
                  kFaultMaxPerHourDefault <= kMaxFaultMaxPerHour,
              "FAULT_MAX_PER_HOUR is outside the range a heartbeat may set, so the board would start "
              "at a rate it can never be told to return to");

static_assert(sizeof(kFaultHeartbeatRejected) - 1U <= kMaxFaultCodeLen &&
                  sizeof(kFaultScannerUartError) - 1U <= kMaxFaultCodeLen,
              "the two longest fixed codes must fit the wire's 32-character cap");

static_assert(kMaxFaultCodeLen <= eventq::kMaxSubjectLen,
              "a fault code rides in eventq::Event::subject and may not be longer than one");

/// Aggregates faults by code and hands out at most one event at a time.
///
/// Gate-local, and that is a COMPROMISE rather than a judgement that it belongs
/// here: by `src/iot/README.md`'s own test — "would a device with different
/// hardware want this unchanged" — this belongs in `shared/lib`, and the court
/// box is building a second copy of the same wire contract. Merging the two is
/// owed and is a shared-library change neither lane could make alone.
class FaultLog {
public:
  /// Count one occurrence. Never allocates, never blocks, and does nothing at
  /// all when reporting is off — see `setReporting`.
  ///
  /// `code` must be one of the literals above, or a `boot_reason_<x>` the
  /// composition root built. A null, empty or over-long code is IGNORED rather
  /// than truncated: a truncated code is a different code, which is the same
  /// rule the scanner and the roster are held to.
  void record(const char* code, uint32_t nowMs);

  /// The same, `times` over.
  ///
  /// It exists because the ring's `overflowed()` is a since-boot TOTAL that the
  /// loop observes as a JUMP: a board back from an evening offline can have
  /// lost four hundred events between two passes, and calling `record` four
  /// hundred times to say so would be a pass spent counting. `times` of zero
  /// does nothing at all.
  void recordMany(const char* code, uint32_t nowMs, uint32_t times);

  /// Fill `out` with the next fault event whose WINDOW HAS ENDED, and free that
  /// code's slot. False when nothing is due.
  ///
  /// A code's window starts on its FIRST occurrence and the event fires at the
  /// end of it carrying the whole count — the court box's rule, and the same
  /// rule for the same reason: a fault that happened once and never again is
  /// usually noise, and one worth somebody's attention is still happening three
  /// minutes later.
  ///
  /// AT MOST ONE PER CALL, and the caller calls it once per pass: draining
  /// every due code in one go would push eight events into a 64-slot ring in
  /// one pass, which is the eviction this class exists to prevent.
  ///
  /// `seq` is left alone — `EventQueue::push` stamps it, and a sequence number
  /// chosen by a caller is a sequence number that can repeat.
  bool drain(uint32_t nowMs, eventq::Event& out);

  /// Whether this board reports faults at all.
  ///
  /// TURNING IT OFF CLEARS THE COUNTS, deliberately. The setting exists so a
  /// club with a board that is noisy for a known reason can stop it costing
  /// event slots; a count that kept rising while reporting was off would be
  /// dumped as one enormous number the moment somebody turned it back on, and
  /// nobody could date any part of it.
  void setReporting(bool on);

  bool reporting() const { return reporting_; }

  /// Clamped into [kMinFaultMaxPerHour, kMaxFaultMaxPerHour], because the board
  /// must not depend on the server having clamped — the same rule
  /// `clampUnlockMs` is held to.
  void setMaxPerHour(uint16_t perHour);

  uint16_t maxPerHour() const { return maxPerHour_; }

  /// One code may produce an event this often. `3600 / max_per_hour` seconds.
  uint32_t windowMs() const { return kFaultHourMs / static_cast<uint32_t>(maxPerHour_); }

  // --- observation, for the host suite and the simulator's console ----------

  /// Distinct codes currently holding a slot.
  uint8_t tracked() const;

  /// Occurrences counted for `code` since it was last reported. Zero for a code
  /// that has none and for one that is not tracked.
  uint32_t pending(const char* code) const;

  /// Distinct codes that arrived with every slot taken, since boot. Reported
  /// under `fault_overflow`; this is the same number before it is drained.
  uint32_t overflowPending() const { return overflow_; }

private:
  /// One tracked code.
  ///
  /// `nextAt` is a `tb::Deadline` rather than an instant for the reason the
  /// whole of timebase exists: every uint32_t is a legal `millis()`, so there
  /// is no value that can mean "never". It is armed when the slot opens and
  /// disarmed when the report frees it.
  struct Slot {
    char code[kMaxFaultCodeLen + 1U];
    uint32_t count;
    tb::Deadline nextAt;
    bool used;
  };

  /// The slot holding `code`, or -1.
  int8_t find(const char* code) const;

  /// A free slot, or -1. NOTHING IS RECLAIMED: a slot is held for exactly as
  /// long as its window runs and is freed by the report at the end of it, which
  /// is what stops a stream of distinct codes evicting a code mid-window to
  /// escape its rate limit.
  int8_t claim(uint32_t nowMs);

  /// Copies `code` into slot `at`, opens it and STARTS ITS WINDOW. False when
  /// `code` does not fit.
  bool open(int8_t at, const char* code, uint32_t nowMs);

  /// The next slot whose window has ended, or -1. A plain scan from zero: a
  /// report frees the slot it reported, so no code can be selected twice until
  /// it occurs again — see the definition for the round-robin this replaced.
  int8_t nextDue(uint32_t nowMs) const;

  /// Fills `out` from a slot or from the overflow counter, and re-arms.
  void emit(const char* code, uint32_t count, uint32_t nowMs, eventq::Event& out) const;

  Slot slots_[kMaxFaultCodes] = {};
  /// Occurrences of codes that arrived with every slot taken. A counter of its
  /// own rather than a slot — see the header.
  uint32_t overflow_ = 0U;
  tb::Deadline overflowNextAt_;
  bool reporting_ = kFaultReportingDefault;
  uint16_t maxPerHour_ = kFaultMaxPerHourDefault;
};

} // namespace gatelogic

#endif // CRUSADERS_GATELOGIC_FAULTLOG_H
