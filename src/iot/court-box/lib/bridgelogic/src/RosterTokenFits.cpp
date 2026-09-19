// The translation unit that makes RosterTokenFits.h's static_assert part of the
// court box's BUILD rather than only of whatever happens to include it.
//
// A header nobody compiles asserts nothing. court_bridge links bridgelogic, so
// PlatformIO compiles this file for the ESP8266 and the Arduino exporter copies
// it into the generated sketch — which means widening roster::kMaxTokenLen past
// proto::kMaxArgLen is a red board build, not a booking that silently never
// matches. The native suite includes the header directly for the same reason.
//
// It is deliberately empty otherwise. Nothing belongs in here.

// The include is the whole file. It is not an empty translation unit — the
// header pulls in `protocol/` and `roster/`, both of which declare plenty — so
// there is nothing to add below, and anything added here would be behaviour in
// a file whose only job is to make an assertion fire.
#include "bridgelogic/RosterTokenFits.h"
