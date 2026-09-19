---
name: crusaders-mainframe-decisions-gate-threat
description: "What the door's posture actually claims: a cleartext LAN, bearer-token codes, provisioning that hands out other members' codes on demand, and an audit trail that stopped being a credential store."
type: decision
last_verified: 2026-09-19
---

# Live decisions — the door's threat posture

Who a door opens for is [`decisions-gate-access.md`](decisions-gate-access.md). Oracle:
`docs/specs/door-gate.md` §4 and §10a, which states all of this rather than leaving a reader
to assume a door is held to a higher standard than the court box it was built from.

- **A board gets no roster until an admin has named the door** (`gate_key == null` ⇒
  `roster: []`), because anything holding the club key can invent a MAC, register a "gate" and be
  handed the club's live codes. **It narrows the surface and does not close it, and the spec
  claimed otherwise:** a `kind`-less heartbeat auto-registers a COURT BOX on the club's first four
  courts with no naming step at all and is answered with up to 16 live booking codes — each of
  which, after the window rule, opens every door in the club inside its booking's window. Whether
  boxes get the same rule is the founder's call, not engineering's, because it changes the
  court-box install story and the offline lighting path: [`questions.md`](questions.md).
- **Cleartext HTTP on the club LAN; codes are bearer tokens.** The court box's posture, unchanged,
  written down because a door is where a reader assumes otherwise. A captured roster code buys one
  booking's window at every door rather than a standing key; the device API key is worth more than
  any code, and rotating it is the club's remedy. Nothing identifies the person presenting a code,
  so `gate.opened` names *whose code it was* — not who walked through, and not attendance.
- **The audit trail is not a credential store.** The online path left the token out of
  `gate.opened` from the start; the OFFLINE path wrote it in full. `gate_open` and `unknown_scan`
  details now carry an eight-hex SHA-256 fingerprint of the normalised code instead, which keeps
  the only property worth keeping — two scans of one code still correlate — while nothing
  reversible survives. Keyed on the KIND rather than the sending row's kind, deliberately wider
  than the finding: a court box posting `gate_open` is refused `not_a_gate`, but its token is just
  as live, and a guard depending on the sender being honest about itself is not a guard. A court
  box's own `activation` events are untouched; narrowing those is a separate decision about the
  court-box trail. **`RetentionWorker` anonymises a row's SUBJECT and never touches `DetailsJson`,
  so rows written before this change still hold their tokens** — nothing rewrites them, and the
  remedy is the one the console already offers for a leaked roster.
- **Two residuals are stated rather than engineered around.** The roster is capped at 48 after
  ordering, so a club with more bookings in its window has a **49th member no door admits
  offline**; and a roster is a snapshot, so a suspension, cancellation or sweep after the push
  does not reach the board until the next heartbeat.
