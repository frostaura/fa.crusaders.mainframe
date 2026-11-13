// Crusaders Mainframe — the gate's heartbeat: the one extra field it sends,
// and the one extra field it adopts.
//
// WHAT IS DIFFERENT FROM THE COURT BOX'S
// --------------------------------------
// Exactly one field each way.
//
// Outbound, `kind:"gate"`. It is a HINT and nothing more: the server honours it
// only when the MAC is unknown, so it auto-registers a Gate row rather than a
// CourtBox one. On a MAC the server already knows, the row's Kind wins and this
// field is ignored — a board cannot re-kind itself, which is what stops a
// mis-flashed image turning a court box into a door.
//
// Inbound, `gate.unlock_seconds`. The tenant's release time, clamped by the
// server to [1, 30] and clamped AGAIN here, because a board that trusted the
// server to have clamped would hold a lock open for as long as a bad answer
// said to.
//
// Everything else is the court box's, unchanged and shared: `heartbeat_seconds`
// through devlink::Cadence, the roster through devlink::applyRoster, the body's
// MAC and 64-bit uptime through devlink's own renderer's rules.
//
// No Arduino headers, no heap, no String. Compiles for Xtensa and the host.

#ifndef CRUSADERS_GATELOGIC_GATEHEARTBEAT_H
#define CRUSADERS_GATELOGIC_GATEHEARTBEAT_H

#include <stddef.h>
#include <stdint.h>

#include "gatelogic/FaultLog.h"
#include "gatelogic/GateConfig.h"
#include "gatelogic/GateReply.h"

namespace gatelogic {

/// The smallest buffer renderGateHeartbeatBody is ever given.
///
/// The court box's four keys plus `kind` is 96 bytes at this firmware's MAC and
/// version; `,"no_push":2147483647` is 21 more, `,"events_lost":2147483647` is
/// 25 and `,"caps":["codes:m1"]` 20. 192 holds all of it with 30 to spare, and
/// the renderer refuses rather than truncating if a future key ever makes that
/// untrue.
inline constexpr size_t kGateHeartbeatBodyCap = 192U;

/// THE TWO SINCE-BOOT COUNTERS THAT RIDE IN THE REQUEST.
///
/// Carried as one value rather than as two parameters because they travel
/// together everywhere — the app counts them, the API call forwards them, the
/// renderer writes them — and because two adjacent `uint32_t` arguments that
/// mean different things are two arguments a caller can swap silently.
///
/// Both are TOTALS SINCE BOOT, not deltas since the last report: the board has
/// no way to know which reports the server kept, and a delta that is lost is a
/// delta nobody can reconstruct. Both saturate at `kMaxDiagnosticCount`.
struct GateDiagnostics {
  /// Heartbeats the server accepted whose body carried no usable roster — cut
  /// short, malformed, or missing the key the contract says is always present.
  uint32_t noPush;

  /// Events the ring discarded because it was full while this board could not
  /// reach the API. `EventQueue::overflowed()`.
  uint32_t eventsLost;

  /// Whether this image speaks the single rotating member code — rendered as
  /// `"caps":["codes:m1"]`, LAST, after the two counters. Not a counter and
  /// not a diagnostic, but it travels with them because it is also something
  /// the board says about itself on every heartbeat. A brace-initialiser that
  /// names only the two counters leaves it false, which is the body every image
  /// before this one rendered, byte for byte.
  bool codesCapability;
};

/// No board has anything to report yet.
constexpr GateDiagnostics quietDiagnostics() {
  return GateDiagnostics{0U, 0U, false};
}

/// Adds one without ever wrapping. See `kMaxDiagnosticCount`.
constexpr uint32_t saturatingIncrement(uint32_t count) {
  return count >= kMaxDiagnosticCount ? kMaxDiagnosticCount : count + 1U;
}

/// Bounds a counter this class did not own — `EventQueue::overflowed()` is a
/// free-running uint32_t — into what the wire may carry.
constexpr uint32_t saturate(uint32_t count) {
  return count > kMaxDiagnosticCount ? kMaxDiagnosticCount : count;
}

/// Renders the `/api/v1/device/heartbeat` body, with `kind` last and the
/// diagnostic counters after it, each omitted when it is zero.
///
/// Returns the length written, or 0 — with `out` empty — when it would not fit
/// or `mac` is missing. Never a truncated body: a half-rendered object is a 400
/// the board cannot read, and a gate that cannot heartbeat has no roster and
/// falls back to admitting nobody.
///
/// `uptimeMs` is the 64-bit tb::Uptime64 value, not a cast of it — the same
/// 49.7-day wrap that made the court box report a two-month-old board as ten
/// days old.
///
/// WHY THE TWO COUNTERS ARE OMITTED AT ZERO, AND WHY THEY EXIST AT ALL
/// --------------------------------------------------------------------
/// Both name a loss that is otherwise COMPLETELY UNOBSERVABLE.
///
/// `no_push`: a heartbeat the board accepted whose body carried no usable
/// roster — cut short by a short read, malformed chunk framing, or missing the
/// key the contract says is always present. The roster silently does not
/// change, its age silently keeps running, and the one feedback surface on this
/// board is a lamp that has nothing to say about it. A technician standing at
/// the door cannot tell that case from a healthy one, and neither can anybody
/// reading the admin console.
///
/// `events_lost`: the event ring overwrites its oldest entry when it is full,
/// which on a door offline overnight is an evening of entries the club never
/// learns about. `EventQueue.h` has promised since it was written that "an
/// overflow is reported, never silent" — and until round G3 `overflowed()` was
/// read by NOTHING. 64 slots against a door doing 720 scans an hour is a
/// counter that moves on the first bad night.
///
/// A distinct LED pattern was considered and rejected for both: this lamp is
/// what tells a MEMBER their scan was seen, and a diagnostic blink on it is a
/// refusal nobody can interpret. So the counts ride in the request.
///
/// WHERE THEY ACTUALLY GO, SAID PROPERLY (round G4, H1). This used to say
/// "where an admin can read them off the device row", and that was not true:
/// the server LOGS both against the device code and STORES NEITHER — the gate
/// corpus's own vector says so in as many words, because a column would be an
/// EF migration for a diagnostic. So they reach a server log and the native
/// simulator's transcript, and no console anywhere shows them. That is still
/// better than a counter nothing reads, which is what this was before round
/// G3; it is not what this comment claimed. Surfacing them belongs to whoever
/// owns the admin console, and is owed rather than done.
///
/// Omitted at zero because a healthy board is the overwhelming case and the
/// contract corpus's request vector has neither field: a board that sent
/// `"no_push":0` forever would put a key in every request that nothing on the
/// wire has agreed to.
size_t renderGateHeartbeatBody(char* out, size_t cap, const char* mac, const char* firmwareVersion,
                               uint64_t uptimeMs, const GateDiagnostics& diagnostics);

/// Reads `gate.unlock_seconds` out of a heartbeat response into `unlockMs`,
/// clamped into [kMinUnlockMs, kGateConfig.unlockHardCapMs].
///
/// False, with `unlockMs` untouched, when there is no `gate` object or it
/// carries no bare integer under that key — an older API that does not send one
/// must not reset a release time a newer one configured.
///
/// The search starts at the `gate` key rather than running over the whole body,
/// so an `unlock_seconds` that appears anywhere else in a future response
/// cannot be picked up as this one.
/// What a 2.0.0 gate says about itself (door-gate.md §14, device-api.md §2,
/// §13): every field after the 1.x ones, in the contract's order. A pointer
/// left null omits its field.
struct GateDiag {
  /// `esp_reset_reason()` as a word: power_on, external, software, panic,
  /// int_wdt, task_wdt, brownout, deep_sleep, unknown.
  const char* reset = "unknown";
  uint32_t exc = 0U;
  uint32_t epc1 = 0U;
  uint32_t heap = 0U;
  uint32_t heapMin = 0U;
  uint32_t block = 0U;
  uint32_t stackMin = 0U;
  uint32_t sketchFree = 0U;
  uint32_t flashMb = 0U;
};

struct GateReport {
  const char* fwState = "committed";
  /// With rolled_back / failed only.
  const char* fwFailed = nullptr;
  const char* fwError = nullptr;
  uint32_t netVer = 0U;
  const char* netSrc = "compiled";
  /// warm / cold / none: until the first accepted heartbeat of a boot only.
  const char* restore = nullptr;
  const GateDiag* diag = nullptr;
  /// Names the board could not read in the previous answer; omitted when none.
  const Drift* drift = nullptr;
};

/// Every v3 capability this image has. The server keys every new response
/// field on it, so a 1.x gate is answered exactly as before.
inline constexpr char kGateCapsV3[] = ",\"caps\":[\"codes:m1\",\"ota:1\",\"key:1\",\"net:1\"]";

/// The 2.0.0 heartbeat request (`gate/` `gate-heartbeat-request-v3*`). 0 when
/// it does not fit `cap`, which is kGateHeartbeatRequestCap on the board.
size_t renderGateHeartbeatV3(char* out, size_t cap, const char* mac, const char* firmwareVersion,
                             uint64_t uptimeMs, const GateDiagnostics& counters, const GateReport& report);

bool adoptUnlockMs(const char* body, size_t len, uint32_t& unlockMs);

/// True when the body's `gate.unlock_seconds` was OUTSIDE the contract's
/// [1, 30] and the board's own clamp therefore changed it.
///
/// A SEPARATE PREDICATE RATHER THAN AN OUT-PARAMETER ON `adoptUnlockMs`, so the
/// adopt path keeps the signature the corpus suite and the app both call and
/// this can be proved on its own. It re-reads the body, which costs one scan of
/// at most 4 KB once per heartbeat.
///
/// WHY ANYBODY CARES. The clamp is not in dispute — the board must not trust
/// the server to have clamped, and it does not. What the clamp cannot do is say
/// that it happened: the door then runs for a number the console does not show,
/// the server believes its own, and the one feedback surface on this hardware
/// is a lamp with nothing to say about it. `GateApp` turns a true here into a
/// `unlock_clamped` fault, which is the first thing on this board that can.
///
/// False when there is no `gate` object, no `unlock_seconds`, or one inside the
/// range: nothing was changed, so there is nothing to disagree about.
bool unlockSecondsWereClamped(const char* body, size_t len);

/// The two fault-reporting settings the heartbeat may carry inside `gate`.
struct GateFaultSettings {
  bool reporting;
  uint16_t maxPerHour;
};

/// Reads `gate.device_fault_reporting` and `gate.device_fault_max_per_hour`
/// into `settings`, INDEPENDENTLY.
///
/// The caller passes the board's working values in and gets them back with
/// whatever the body actually carried applied — so an ABSENT key, or one of the
/// wrong JSON type, leaves that value alone exactly as `adoptUnlockMs` leaves a
/// release time alone. An older API that sends neither must not reset settings
/// a newer one configured, and an API that sends one must not reset the other.
///
/// `maxPerHour` is clamped into [kMinFaultMaxPerHour, kMaxFaultMaxPerHour]
/// here, before it can reach a divisor — the same reasoning as clamping
/// `unlock_seconds` in SECONDS before the multiply.
///
/// The read is bounded to the top-level `gate` object, for the reason
/// `adoptUnlockMs` is: a key of the same name anywhere else in a future
/// response, or in a nested object placed before the real one, is not this one.
///
/// Returns true when either key was present and usable.
bool adoptFaultSettings(const char* body, size_t len, GateFaultSettings& settings);

/// Clamps a release time from any source — the server's, or a build flag —
/// into what the board will actually drive the lock for.
uint32_t clampUnlockMs(uint32_t requestedMs, uint32_t hardCapMs);

/// The same clamp, applied to a wire value in SECONDS.
///
/// Clamping before the multiply rather than after it: 4,300,000 seconds times
/// 1000 wraps a uint32_t into 4,999,552 ms, which is a plausible-looking number
/// and an 83-minute release. Every number that arrives from the network is
/// bounded in its own units first.
uint32_t unlockMsFromSeconds(uint32_t seconds, uint32_t hardCapMs);

} // namespace gatelogic

#endif // CRUSADERS_GATELOGIC_GATEHEARTBEAT_H
