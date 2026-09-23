// Crusaders Mainframe — where the roster's token limit meets the court box's
// serial protocol.
//
// WHY THIS FILE EXISTS AT ALL
// ---------------------------
// A roster token that does not fit a `!SCAN` argument is a booking the box
// holds and can never honour: the scanner frame refuses it before the roster
// cache is ever consulted. That has to be a compile error, not a site visit.
//
// It cannot be asserted in `roster/`, which must not depend on the protocol to
// state its own limit, nor in `protocol/`, which does not know a roster exists.
// It used to sit in `devlink/RosterSync.h` (then `bridgelogic/RosterSync.h`),
// which worked only while that header lived in the same project as the codec.
// `devlink` is device-agnostic now — a second firmware reuses it over a serial
// link this protocol knows nothing about — so a `protocol/` include there would
// drag the Mega<->ESP codec into every firmware that ever shares the roster.
//
// So the assert lives HERE, in the court box's own project, where the two
// constants genuinely meet. `RosterTokenFits.cpp` exists purely so that the
// court_bridge build (and the generated Arduino sketch, whose closure follows
// the same includes) compiles it; the native suite includes this header too, so
// a widening of `roster::kMaxTokenLen` goes red in `pio test` as well.
//
// No Arduino headers, no heap. Header-only, no runtime cost.

#ifndef CRUSADERS_BRIDGELOGIC_ROSTERTOKENFITS_H
#define CRUSADERS_BRIDGELOGIC_ROSTERTOKENFITS_H

#include "memcode/Token.h"
#include "protocol/Protocol.h"
#include "roster/Roster.h"

namespace bridgelogic {

static_assert(roster::kMaxTokenLen <= proto::kMaxArgLen,
              "a roster token must fit a !SCAN argument or the box holds bookings it can never match");

// THE SINGLE ROTATING MEMBER CODE MUST FIT THE MEGA AS IT IS. The Mega is not
// reflashed for member codes — its scanner line and the `!SCAN` frame are
// bounded by proto::kMaxArgLen, and the bridge remembers a scan in a buffer of
// the same size — so a v1 token longer than that is a code the box can never
// read. Nineteen characters against twenty-four; this is where the two meet.
static_assert(memcode::kTokenLen <= proto::kMaxArgLen,
              "a v1 member code must fit a !SCAN argument: the Mega is untouched by member codes");

} // namespace bridgelogic

#endif // CRUSADERS_BRIDGELOGIC_ROSTERTOKENFITS_H
