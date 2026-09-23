// Crusaders Mainframe — the heartbeat: the body the box sends, and the
// interval the API asks for in reply.
//
// The tenant setting `heartbeat_seconds` was served on every heartbeat and
// read by nothing; the box heartbeated every thirty seconds whatever an admin
// set, and the admin screen's default (60) did not even match the firmware's
// (30). The interval is adopted here, bounded: below kMinHeartbeatMs a fleet
// hammers the API and its own UART with 4 s blocking calls; above
// kMaxHeartbeatMs the roster ages and an OTA offer takes minutes to reach a
// box. An absent or unreadable field leaves the interval where it was.
//
// No Arduino headers, no heap.

#ifndef CRUSADERS_DEVLINK_CADENCE_H
#define CRUSADERS_DEVLINK_CADENCE_H

#include <stddef.h>
#include <stdint.h>

namespace devlink {

inline constexpr uint32_t kMinHeartbeatMs = 15000UL;
inline constexpr uint32_t kMaxHeartbeatMs = 300000UL;

/// Reads `heartbeat_seconds` out of a heartbeat response into `intervalMs`,
/// clamped into [kMinHeartbeatMs, kMaxHeartbeatMs]. False, with `intervalMs`
/// untouched, when the field is absent or not a bare integer.
bool parseHeartbeatInterval(const char* body, size_t len, uint32_t& intervalMs);

/// One relay this board believes is CLOSED, and how long it has left.
///
/// The Mega publishes `!STATE,<mask>,<remA>,<remB>,<remC>,<remD>` on every
/// change and every ten seconds, and until this field existed it reached nobody
/// outside the box: the admin console could only ever say what it BELIEVED it
/// had granted, never what the hardware was actually doing. With this it can
/// say "lights on — confirmed by the box at HH:MM".
///
/// `remainingSeconds` goes up UNCAPPED, for the same reason the restore comes
/// down uncapped: this is a report of what the board believes, not a request
/// for a duration, and narrowing it to a relay cap would make the two halves of
/// a disagreement impossible to see.
struct RelayState {
  /// 0-3. Anything else is a caller bug and is SKIPPED rather than rendered —
  /// see renderHeartbeatBody.
  uint8_t relay = 0U;
  uint32_t remainingSeconds = 0U;
};

/// Relay-state elements the body is sized for. Four is the widest bank in the
/// tree today; it sizes kHeartbeatBodyCap and bounds the render, and it is NOT
/// a claim about any particular device — this library takes a plain array and
/// the caller says how long it is.
inline constexpr uint8_t kMaxRelayStateElements = 4U;

/// What the box has to say about itself on this heartbeat. Bundled rather than
/// passed as three more arguments, the same way the gate's `GateDiagnostics`
/// is: past six parameters the complexity gate refuses the function, and a
/// renderer whose signature grows with every diagnostic is a renderer every
/// composition root has to be edited to call.
///
/// <b>Every field is omitted at its nothing value</b>, so a board with nothing
/// to report renders the body it has always rendered, byte for byte — which is
/// what keeps the contract corpus's `heartbeat-request` vector true and every
/// image already in the field valid. The same compatibility hinge as `boot_id`,
/// `no_push` and `events_lost`.
struct HeartbeatReport {
  /// How many relays this box re-energised from the last served restore. Zero
  /// normally, and OMITTED at zero — the server reads an absent field as zero,
  /// so the two say the same thing.
  ///
  /// It is how the server learns the restore LANDED. A served restore followed
  /// by a zero is the row an admin must see, because it means a court is dark
  /// that should not be.
  uint8_t restoredRelays = 0U;

  /// The relays the box believes are closed, or nullptr.
  ///
  /// THREE STATES, NOT TWO. A null pointer omits the key — "this firmware does
  /// not report relay state". A non-null pointer with a count of zero renders
  /// `[]` — "this box believes nothing is closed". A control board that could
  /// not tell those apart would show a dark court as unknown and an unknown
  /// court as dark.
  const RelayState* relayState = nullptr;
  uint8_t relayStateCount = 0U;

  /// Whether this firmware speaks the single rotating member code — the
  /// `codes:m1` capability (docs/specs/member-code.md §8). Rendered as
  /// `"caps":["codes:m1"]`, LAST, on every heartbeat, because the server keys
  /// both what it sends this device and the club's automatic cut-over on the
  /// latest heartbeat it saw. Absent at false, so a board that says nothing
  /// renders the body it always rendered.
  bool codesCapability = false;
};

/// The rendered capability suffix, exactly as the corpus pins it.
inline constexpr char kCodesCapsSuffix[] = ",\"caps\":[\"codes:m1\"]";

/// The smallest buffer renderHeartbeatBody is ever given.
///
/// THE WORST CASE, exactly: `{"mac":"` (8) + a 12-hex MAC +
/// `","firmware_version":"` (22) + a 16-character version + `","uptime_ms":`
/// (14) + 20 digits of uint64 + `,"restored_relays":` (19) + 3 digits +
/// `,"relay_state":[` (16) + four elements of `"0|4294967295"` (14 each) and
/// three commas (59) + `]` (1) + `,"caps":["codes:m1"]` (20) + `}` (1) =
/// 211 bytes, plus the NUL = 212.
///
/// 256 rather than 212 because a refusal here is not a truncated field, it is
/// NO HEARTBEAT AT ALL — and a box that cannot heartbeat has no court list and
/// refuses every scan. The margin is what a longer version string or one more
/// diagnostic would otherwise eat silently. It was 128 before the two report
/// fields existed and 224 before the capability.
inline constexpr size_t kHeartbeatBodyCap = 256U;

/// Renders the `/api/v1/device/heartbeat` body. Returns the length written, or
/// 0 — with `out` empty — when it would not fit or `mac` is missing. Never a
/// truncated body: a half-rendered object is a 400 the box cannot read, and a
/// box that cannot heartbeat has no court list and refuses every scan.
///
/// `uptimeMs` is the 64-bit tb::Uptime64 value, not a cast of it. The same
/// 49.7-day wrap that used to move the signing clock backwards would report a
/// box that had been up for two months as one that had been up for ten days.
///
/// THE SHAPE, and the ORDER IS PART OF IT because the corpus asserts bytes:
///
///     {"mac":…,"firmware_version":…,"uptime_ms":…
///      [,"restored_relays":N][,"relay_state":["0|1834",…]][,"caps":["codes:m1"]]}
///
/// <b>A DIAGNOSTIC MUST NEVER BE ABLE TO STOP A HEARTBEAT.</b> That is the
/// exact mirror of the server-side rule that made `no_push` a `long?` rather
/// than an `int?` — a counter out of range must not answer 400 for the whole
/// heartbeat and take the roster down with it. On this side the same sentence
/// means a `relayState` element whose relay is not 0-3 is SKIPPED, a
/// `relayStateCount` past kMaxRelayStateElements is TRUNCATED to it, and a
/// count with a null pointer simply omits the key. None of the three refuses
/// the body. A buffer genuinely too small still refuses, because the
/// alternative there is a half-object the server answers 400 to anyway.
size_t renderHeartbeatBody(char* out, size_t cap, const char* mac, const char* firmwareVersion,
                           uint64_t uptimeMs, const HeartbeatReport& report = HeartbeatReport());

} // namespace devlink

#endif // CRUSADERS_DEVLINK_CADENCE_H
