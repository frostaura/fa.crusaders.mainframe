// Crusaders Mainframe — when a board broadcasts, and how often.
//
// WHY THE INTERVAL DEPENDS ON THE STATE
// -------------------------------------
// An unclaimed board is being looked for: an admin is standing at the cupboard
// with a phone, and five seconds is the difference between "the board is there"
// and "the board is broken". A claimed board is only saying where it is in case
// the API lost it, and sixty seconds of that on a club LAN is already more
// broadcast traffic than it will ever need.
//
// An announce goes out IMMEDIATELY on link-up. The steady state is layer 1 of
// the discovery stack — a claimed box remembers the API's address and never
// needs this — so the case that matters is a box that just got a DHCP lease,
// and making it wait a full interval is the difference between the admin
// refreshing the list once and refreshing it four times.
//
// WHY NOTHING HERE COMPARES CLOCK READINGS DIRECTLY
// -------------------------------------------------
// millis() wraps to zero after ~49.71 days, which for a box in an electrical
// cupboard is the normal case. `now >= next` is false for 49 days after the
// wrap, which in the firmware this replaces meant a relay that was never
// released. Every comparison here goes through tb::Deadline, and CI greps for
// the raw form.
//
// No Arduino headers, no heap.

#ifndef CRUSADERS_DISCOVERY_ANNOUNCER_H
#define CRUSADERS_DISCOVERY_ANNOUNCER_H

#include <stdint.h>

#include "timebase/TimeBase.h"

namespace discovery {

/// Every 5s while unclaimed — somebody is waiting for it.
inline constexpr uint32_t kUnclaimedIntervalMs = 5000U;

/// Every 60s while claimed — nobody is, and the remembered address covers the
/// steady state anyway.
inline constexpr uint32_t kClaimedIntervalMs = 60000U;

enum class State : uint8_t {
  /// Booted, no link. Nothing is broadcast because there is nowhere to send it.
  Unclaimed = 0,
  /// Link up and unclaimed: broadcasting at kUnclaimedIntervalMs.
  Announcing,
  /// Claimed. Broadcasting at kClaimedIntervalMs while the link is up, and
  /// still claimed while it is down — being claimed is a fact about the board,
  /// not about the network.
  Claimed,
};

/// The announce timer. Says WHEN to broadcast; the caller builds the packet,
/// because only the caller knows the uptime and whether the Mega has answered.
class Announcer {
public:
  Announcer();

  State state() const { return state_; }

  /// True while an announce is actually scheduled. False between link-down and
  /// the next link-up, including while claimed.
  bool isAnnouncing() const { return next_.isArmed(); }

  /// The link came up, or came back. Due immediately.
  void linkUp(uint32_t nowMs);

  /// The link went away. The state is kept; only the schedule stops.
  void linkDown();

  /// The claim completed. Due immediately as well: until the API sees an
  /// ANNOUNCE carrying st=claimed it keeps offering, and the board keeps
  /// answering an offer it no longer needs.
  void claimed(uint32_t nowMs);

  /// True on the pass that an announce is due, once per interval. The caller
  /// broadcasts when it returns true and does nothing when it does not.
  bool due(uint32_t nowMs);

  uint32_t intervalMs() const;

  /// Milliseconds until the next announce; 0 when due or not scheduled.
  uint32_t remainingMs(uint32_t nowMs) const { return next_.remaining(nowMs); }

  /// Announces handed out. Diagnostics — the discovery status endpoint reports
  /// it, which is how "the API is not on host networking" tells itself apart
  /// from "the board is silent".
  uint32_t announceCount() const { return announces_; }

private:
  tb::Deadline next_;
  State state_;
  uint32_t announces_;
};

} // namespace discovery

#endif // CRUSADERS_DISCOVERY_ANNOUNCER_H
