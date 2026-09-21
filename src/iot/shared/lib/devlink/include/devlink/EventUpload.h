// Crusaders Mainframe — one queued event, as the upload endpoint's JSON.
//
// WHY THIS IS NOT IN main.cpp ANY MORE
// ------------------------------------
// It was, and `pio test -e native` cannot see main.cpp (`build_src_filter =
// -<*>`), so the one thing in it that had to be right across the 49.7-day
// millis() wrap was the one thing no test could reach. What that hid (review 3,
// finding 25): both `uptime_ms` fields were printed with `%lu` from a 32-bit
// cast, while the accumulator behind them had been 64-bit since the signing
// clock was fixed. An activation queued before the wrap and uploaded after it
// therefore went up with a stamp 49.7 days AHEAD of the batch's own uptime, and
// the API — which dates an event by subtracting its uptime from the batch's —
// dated it at upload time and filed a "the counter cannot be believed" audit
// row against a healthy box. The court usage record and any dispute about when
// the lights were on are wrong; attendance still resolves by booking, which is
// why it took three reviews to find.
//
// WHY THE STAMP IS WIDENED HERE RATHER THAN STORED WIDE
// -----------------------------------------------------
// eventq::Event is a trivially-copyable record in a fixed ring on a part with
// 40 KB of usable heap, so four more bytes per slot is 256 bytes of RAM to
// carry a value that is only ever needed at the moment it goes on the wire.
// tb::widen reconstructs it from the accumulator instead: the largest 64-bit
// uptime not after `now` whose low 32 bits are the stamp. Exact for anything
// queued less than 49.7 days ago, which is everything the API will accept — its
// own bound is 30 days.
//
// WHY NOT `%llu`
// --------------
// avr-libc has no 64-bit printf conversion at all and the ESP8266 core's is a
// build-time choice this firmware does not make. A number that silently prints
// as garbage on one target is exactly the class of defect this file exists to
// close, so the digits come from tb::formatU64 and go in as `%s`.
//
// No Arduino headers, no heap, no String. Compiles for Xtensa and the host.

#ifndef CRUSADERS_DEVLINK_EVENTUPLOAD_H
#define CRUSADERS_DEVLINK_EVENTUPLOAD_H

#include <stddef.h>
#include <stdint.h>

#include "eventq/Event.h"

namespace devlink {

/// The smallest buffer renderEventBody is ever given.
///
/// The longest body is the fixed JSON, a 12-hex MAC, two 20-digit uptimes,
/// three 10-digit numbers, a 12-character kind, an 11-character quoted method
/// — and a subject that is 32 bytes BEFORE escaping and up to six times that
/// after it (round G4, B1: a control byte becomes `\u00XX`). 32 x 6 = 192 for
/// the subject alone, against 32 when the bytes went on the wire raw, which is
/// why this number moved. About 420 bytes of it are reachable; the rest is the
/// margin a refusal would otherwise eat, because `renderEventBody` returning 0
/// makes the drain DROP the event.
inline constexpr size_t kEventBodyCap = 512U;

/// Renders the `/api/v1/device/events` body for one queued event.
///
/// `mac` names this box at the top level of the batch, as 12 lowercase hex
/// characters with no separators; a body that does not carry one — or carries
/// something that is not twelve lowercase hex — is refused rather than sent.
///
/// `bootId` IS THE THIRD FIELD OF THE IDEMPOTENCY KEY, and round G4's C2 is
/// what its absence cost. The server deduplicates on a PERMANENT unique index;
/// the ring is RAM-only so no event survives a reboot; and `seq` resumes from
/// one checkpoint record in flash, written in blocks of 64. Erase or tear that
/// record and the board renumbers from 1 — so every event of the next evening
/// is silently receipted as a duplicate and discarded, INCLUDING the `boot`
/// event the firmware queues precisely so an operator can see a board
/// restarted. Two boards accidentally sharing a MAC dedup each other the same
/// way. A per-boot random value makes the key (device, boot_id, seq): a
/// renumbered board collides with nothing, and a genuine retry still carries
/// the same three fields and is still deduplicated.
///
/// ZERO OMITS THE FIELD, and that is the compatibility hinge rather than a
/// convenience. The server reads an absent `boot_id` as 0, which is exactly
/// what (device, seq) always meant — so a COURT BOX, whose composition root
/// passes 0, renders the body it has always rendered, byte for byte, and every
/// image flashed before this change keeps working. The GATE always passes a
/// non-zero one.
///
/// `nowUptimeMs` is the batch's own uptime, from the 64-bit accumulator; the
/// event's stamp is widened against it. Returns the length written, or 0 —
/// with `out` empty — when it would not fit. Never a truncated body: a
/// half-rendered JSON object is a request the server rejects with no clue why,
/// and the event behind it would be dropped as a 4xx the box caused.
size_t renderEventBody(char* out, size_t cap, const char* mac, uint32_t bootId, uint64_t nowUptimeMs,
                       const eventq::Event& event);

} // namespace devlink

#endif // CRUSADERS_DEVLINK_EVENTUPLOAD_H
