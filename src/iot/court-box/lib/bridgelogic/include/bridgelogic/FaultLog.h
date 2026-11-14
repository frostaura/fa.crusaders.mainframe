// Crusaders Mainframe — what a court box is allowed to tell the club about
// itself going wrong.
//
// THE SEAM THAT WAS ALREADY THERE
// -------------------------------
// `eventq::Kind::Fault = 4` exists, renders as "fault", and is emitted by
// NOTHING. `Kind::Boot` is produced and already flows through the backend's
// fall-through into a receipt plus an audit row, so a fault event lands today
// with no backend change at all. The work is modelling and rate-limiting, not
// plumbing — which is why this is a small type and not a subsystem.
//
// WHY THE EVENTS QUEUE AND NOT THE HEARTBEAT
// ------------------------------------------
// The queue survives an outage, is deduplicated on `(tenant, device, seq)` by a
// permanent index, is ordered, and is drained one event per pass so it cannot
// starve the Mega link. A fault channel on the heartbeat is lost on every
// missed heartbeat — which is precisely when faults happen.
//
// AGGREGATION *IS* THE RATE LIMIT
// -------------------------------
// A fault is COUNTED, not queued. One event per code per window, where the
// window is 3600 / device_fault_max_per_hour seconds — twenty an hour by
// default, so one per code every three minutes. A link producing four hundred
// CRC errors a minute costs ONE event every three minutes carrying the number
// twelve hundred, rather than four hundred events a minute racing the scan
// frames on the same 9600 baud line. That is the whole answer to "a noisy fault
// must not flood", and it is why the count rides `duration_ms` rather than each
// occurrence getting a record.
//
// The first occurrence of a code STARTS its window rather than being reported
// immediately. A fault that happened once and never again is usually noise; a
// fault worth an admin's attention is one that is still happening three minutes
// later, and by then this reports how many times.
//
// NO NEW FIELD ON THE EVENT RECORD. `subject` carries the code, `duration_ms`
// the count, `court` the relay when the fault is about one. `eventq::Event` is
// written to a fixed ring on a part with no allocator, and widening it costs
// RAM on both boards for a field only one kind would use.
//
// THE VOCABULARY IS CLOSED, AND IT IS AN ENUM RATHER THAN A STRING
// ----------------------------------------------------------------
// The backend normalises and caps `kind` at 32 characters, and an open
// vocabulary is an admin panel full of strings nobody can act on. Making it a
// type rather than a convention costs nothing and means a typo is a compile
// error instead of a second row in the monitoring table that looks like the
// first one. It also keeps the tracked set to one byte per slot.
//
// No Arduino headers, no heap, no String. Compiles for Xtensa and the host.

#ifndef CRUSADERS_BRIDGELOGIC_FAULTLOG_H
#define CRUSADERS_BRIDGELOGIC_FAULTLOG_H

#include <stdint.h>

#include "eventq/Event.h"
#include "timebase/TimeBase.h"

namespace bridgelogic {

/// Distinct codes tracked at once.
///
/// A ninth does not evict an eighth: it increments `fault_overflow`, which has
/// its own slot and its own window. Losing the identity of the ninth code is
/// the right trade — the one thing an admin must not lose is the knowledge that
/// something is happening that this board cannot name.
inline constexpr uint8_t kMaxFaultCodes = 8U;

inline constexpr uint16_t kMinFaultsPerHour = 1U;
inline constexpr uint16_t kMaxFaultsPerHour = 120U;

#ifdef FAULT_MAX_PER_HOUR
inline constexpr uint16_t kDefaultFaultsPerHour = FAULT_MAX_PER_HOUR;
#else
inline constexpr uint16_t kDefaultFaultsPerHour = 20U;
#endif

/// Every fault a court box can report. Values are not on the wire — the NAME is
/// — so this may be reordered freely, unlike eventq::Kind.
enum class Fault : uint8_t {
  // The Mega link. These are the ones that measure a cable running beside four
  // switching relay coils, and the first week's numbers are expected to be
  // surprising: nothing has ever counted them off the board.
  SerialBadCrc = 0U,
  SerialBadFrame,
  SerialOverrunRx,
  SerialOverrunTx,
  SerialBadVerb,
  SerialBadArg,
  SerialNoCourt,
  MegaLinkLost,
  MegaLinkBack,

  // The relay path.
  OnNotAcked,
  ExtRefused,
  RelayCmdDropped,
  RestoreFailed,

  // The panel and the scanner.
  ScanOversize,
  /// A corrupt line off the scanner's UART. A cable, a connector or
  /// interference — and the count that explains a member whose code
  /// "sometimes does not work". The Mega reports it as `!EVT,SCANJUNK,<n>`;
  /// nothing counted it at all until it did.
  ScannerUartError,
  ButtonUnauthorised,
  LcdI2cTimeout,
  LcdResync,

  // The board itself.
  WdtReset,
  QueueOverflow,
  QueueNoPush,
  QueueEventsLost,
  StoreWriteFailed,
  ClockCorrected,

  // The API.
  RosterRejected,
  Http4xx,
  Http5xx,
  HttpTimeout,
  ApiBreakerOpen,
  HeartbeatRejected,

  // v3 (bridge 3.0.0).
  /// A tagged frame the Mega never acknowledged (three retries, DL-06).
  MegaUnacked,
  /// Three `!WANT`s and a relay still not lit as the snapshot owes (§4).
  RelightFailed,
  /// A screen dropped whole from the full Mega queue.
  ScreenDropped,
  /// A base URL from the server's `net` never earned an accepted heartbeat
  /// inside `device_net_fallback_minutes` and was abandoned (device-api.md §8).
  NetFallback,

  /// More than kMaxFaultCodes distinct codes inside one window.
  FaultOverflow,
};

inline constexpr uint8_t kFaultCount = static_cast<uint8_t>(Fault::FaultOverflow) + 1U;

/// The lowercase-snake name the API stores, never null and never longer than
/// the backend's 32-character cap.
const char* faultName(Fault fault);

/// Counts faults and yields at most one event per code per window.
class FaultLog {
public:
  FaultLog();

  /// The tenant's `device_fault_reporting`. When off, nothing is counted and
  /// nothing is yielded — a club that does not want its box talking about
  /// itself gets silence, not a queue that fills up.
  void setEnabled(bool enabled);

  /// The tenant's `device_fault_max_per_hour`, clamped into
  /// [kMinFaultsPerHour, kMaxFaultsPerHour]. Takes effect for windows armed
  /// AFTER it, never retroactively: shortening the window under a code that is
  /// mid-window would report a partial count as a whole one.
  void setMaxPerHour(uint16_t perHour);

  /// One occurrence, not about any one court.
  void note(Fault fault, uint32_t nowMs);

  /// One occurrence about `court` (0-3), or eventq::Event::kNoCourt.
  void note(Fault fault, uint8_t court, uint32_t nowMs);

  /// Add `count` occurrences at once — what a per-heartbeat diff of the Mega's
  /// `!PONG` counters produces. A diff of zero notes nothing at all, so a quiet
  /// link never opens a window.
  void noteMany(Fault fault, uint32_t count, uint8_t court, uint32_t nowMs);

  /// The next event that is due, if any. Yields AT MOST ONE per call, for the
  /// same reason the event drain uploads at most one per pass: a board coming
  /// back from an hour of trouble must not spend a loop pass emptying itself
  /// while the Mega link waits.
  ///
  /// `seq` is left at zero — the queue assigns it.
  bool next(uint32_t nowMs, eventq::Event& out);

  /// Codes seen while all kMaxFaultCodes slots were taken. Reported under
  /// `fault_overflow`; this is the counter behind it.
  uint32_t overflowed() const { return overflow_.count; }

  uint32_t windowMs() const { return windowMs_; }

  bool enabled() const { return enabled_; }

private:
  struct Slot {
    uint32_t count = 0U;
    tb::Deadline due;
    Fault fault = Fault::SerialBadCrc;
    uint8_t court = eventq::Event::kNoCourt;
    bool used = false;
  };

  Slot* slotFor(Fault fault);
  bool drain(Slot& slot, uint32_t nowMs, eventq::Event& out);

  Slot slots_[kMaxFaultCodes];
  Slot overflow_;
  uint32_t windowMs_;
  bool enabled_;
};

} // namespace bridgelogic

#endif // CRUSADERS_BRIDGELOGIC_FAULTLOG_H
