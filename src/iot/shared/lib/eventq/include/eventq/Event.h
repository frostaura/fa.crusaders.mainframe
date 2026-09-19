// Crusaders Mainframe — one thing that happened at a court, in a form that
// survives a flat battery.
//
// WHY EVENTS ARE QUEUED AT ALL
// ----------------------------
// The court box is on club WiFi behind a consumer router. The link goes away —
// for a reboot, a power cut, an ISP outage, or because somebody unplugged the
// access point to plug in a vacuum cleaner. During that time members still turn
// up, still scan, and the lights still have to work.
//
// So the box does not ask the API for permission at the moment of the scan. It
// decides locally from the roster cache and records WHAT IT DID, and the queue
// is the record. The API learns about it when the link comes back.
//
// That inverts the usual worry. The question is not "did the request succeed"
// but "will the club eventually learn that court C was lit for 45 minutes at
// 18:40". An event that is dropped is a game nobody was charged for.
//
// WHY THE PAYLOAD IS FIXED-WIDTH AND NOT JSON
// -------------------------------------------
// It has to be written to flash, byte-for-byte, by a device with no allocator.
// A fixed record can be checksummed, versioned and read back without a parser;
// a JSON string cannot be updated in place and cannot be validated after a torn
// write. JSON is what devapi renders at upload time, from this.
//
// WHY EVERY EVENT CARRIES A DEVICE-LOCAL SEQUENCE NUMBER
// ------------------------------------------------------
// It is the idempotency key. The box may well upload an event, lose the link
// before reading the response, and upload it again — that is the normal shape
// of an unreliable network, not an error. `(device_id, seq)` lets the API
// recognise the second copy as the same event, which is the only thing standing
// between a retry and a double charge.
//
// WHY THERE IS NO WALL-CLOCK TIME
// -------------------------------
// The box has no RTC. `millis()` since boot is the only clock it owns, and it
// resets to zero every time the power blinks. So an event records its uptime,
// and the upload carries the box's current uptime alongside it: the API
// subtracts to get "this happened N seconds ago" and stamps it against the
// server clock, which is the only clock in the system anyone can be held to.
//
// No Arduino headers, no heap, no String. Compiles for AVR, Xtensa and the host.

#ifndef CRUSADERS_EVENTQ_EVENT_H
#define CRUSADERS_EVENTQ_EVENT_H

#include <stddef.h>
#include <stdint.h>

namespace eventq {

/// What happened. Values are ON THE WIRE and in flash — appending is safe,
/// renumbering is not.
enum class Kind : uint8_t {
  /// A member identified and the box lit a court. The one that costs money.
  Activation = 1U,
  /// A court's lights went out: the timer expired, or somebody pressed off.
  Release = 2U,
  /// A scan the box could not match to anybody in its roster cache.
  UnknownScan = 3U,
  /// The Mega reported a fault — a dropped frame, a decode error, an overrun.
  Fault = 4U,
  /// The box started up. Carries nothing but its own existence, which is what
  /// makes an unexplained gap in the sequence explainable.
  Boot = 5U,
  /// A door gate released its lock from its OWN roster, because the API could
  /// not be asked. Queued for offline opens only: an open the API itself
  /// decided is already in the API's audit trail, and queueing it too would
  /// file every online open twice.
  ///
  /// `court` is kNoCourt — a door is not on a court — and `durationMs` is how
  /// long the lock was released for. It never touches attendance: walking
  /// through a door is not playing a booking.
  GateOpen = 6U,
};

/// How a member identified themselves, mirroring the API's `method` field.
enum class Method : uint8_t {
  None = 0U,
  Qr = 1U,
  Pin = 2U,
  Biometric = 3U,
};

/// Longest identifier an event carries: a member reference or a scan payload,
/// truncated to fit. 32 is the store's value limit and comfortably holds the
/// membership numbers in use.
inline constexpr size_t kMaxSubjectLen = 32U;

/// One event, as it sits in flash.
///
/// Deliberately trivially copyable and free of pointers: it is written with a
/// byte-for-byte copy and read back the same way. A member that needed
/// construction would need a parser, and a parser is a thing that can disagree
/// with the writer after a firmware update.
struct Event {
  /// Device-local, monotonic, never reused. Zero means "unset" and is not a
  /// legal queued value — see EventQueue::push.
  uint32_t seq = 0U;

  /// Milliseconds since this boot, taken when the event happened.
  uint32_t uptimeMs = 0U;

  /// How long the court was granted, for Activation. Zero elsewhere.
  uint32_t durationMs = 0U;

  Kind kind = Kind::Boot;

  /// 0-3 for courts A-D. 0xFF when the event is not about one court.
  uint8_t court = kNoCourt;

  Method method = Method::None;

  /// Length of `subject`, excluding the terminator.
  uint8_t subjectLen = 0U;

  /// Member reference or scan payload. NOT NUL-terminated on the wire — read
  /// `subjectLen` bytes. Padded with zeroes so two equal events have equal
  /// bytes, which is what lets the checksum be over the whole record.
  char subject[kMaxSubjectLen] = {};

  static constexpr uint8_t kNoCourt = 0xFFU;

  /// Copies at most kMaxSubjectLen bytes and reports whether it had to truncate.
  /// Truncation is visible rather than silent: a membership number cut short is
  /// a charge posted against the wrong member, so the caller has to decide.
  bool setSubject(const char* text);

  bool subjectEquals(const char* text) const;
};

/// The name the API knows each kind by. Never null; unknown values render as
/// "unknown" rather than reading off the end of a table.
const char* kindName(Kind kind);

/// The name the API knows each method by, or nullptr for Method::None — the
/// field is omitted rather than sent as "none".
const char* methodName(Method method);

} // namespace eventq

#endif // CRUSADERS_EVENTQ_EVENT_H
