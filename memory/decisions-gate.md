---
name: crusaders-mainframe-decisions-gate
description: "The door gate reuses the court box's contract with no EF migration; a board declares its kind once, a door is never attendance, and gate_access_policy is the one setting in the tree that fails closed."
type: decision
last_verified: 2026-09-19
---

# Live decisions — the door gate's shape

Behaviour oracle: `docs/specs/door-gate.md`. Shared wire corpus:
`src/contracts/device-protocol/gate/`. The device contract it is built on is
[`decisions-device.md`](decisions-device.md) and is unchanged by any of this. Who gets through
a door, and with what, is [`decisions-gate-access.md`](decisions-gate-access.md).

- **The device model held, and the bet is worth recording because it paid.** `DeviceKind` and
  `GateKey` were modelled years before there was hardware, on the argument that a second device
  kind should slot in without a redesign. It did: the whole backend needed **no EF migration**,
  because both have been columns with indexes since the device table shipped. Everything else —
  the club key, the `/api/v1/device` group, the rate limit, auto-registration, the roster element
  grammar — is the court box's, reused rather than forked.
- **A board declares its kind once, on its first heartbeat, and can never re-kind its row.**
  Absent means `court_box`, so every board in the field is untouched; an unrecognised string is a
  400 rather than a silent court box. *Why the row wins:* a gate that could turn itself into a
  court box would be handed the club's courts, and a box that could turn itself into a gate would
  drop off `DeviceOutageIndex`'s map of which courts have a working door and start waiving no-show
  penalties on them. Changing a kind means deleting the row and letting the board re-register.
- **A door is never attendance.** No `CheckedInAt`, no no-show reversal, no ledger row, ever.
  *Why:* the member may be collecting a racquet, watching someone else's league night, or arriving
  for a court they then cancel — an open licenses no inference about a court. A gate is therefore
  invisible to the settlement model and `DeviceOutageIndex` does not count one. Expect this to be
  argued with the first time somebody wants entry statistics; the answer is that `gate.opened`
  audit rows are the statistics.
- **`gate_access_policy` is the one setting in this tree that fails CLOSED.** A stored value that
  is not one of the two policies reads as `booking_window`, the narrower one — the opposite of the
  button map and the operating hours, which fall back to something permissive. *Why the
  asymmetry:* there the failure mode is a club whose courts stop over a typo, with nobody to ask;
  here the two failure modes are "a member is sent to the desk" and "the building is open to
  anyone holding a live code", and only one of those is recoverable by a person. An ABSENT key is
  still the documented default (`active_member`) — that is not a failure at all.
- **Each kind is refused by name on the other's paths**, never by the accident of an empty court
  list. The four court-box routes answer a gate `not_a_court_box`, and a `gate_open` event from a
  court-box row answers `not_a_gate` with a subject of null. *Why the last one matters although
  nothing settles on it:* the row it prevents NAMES A MEMBER as having opened a door that does not
  exist, and a false record of who was in the building is worse than a refusal.
- **Offline, a gate admits rostered bookings and nobody else.** A sixty-second `MemberIdent` code
  cannot be in a cache fetched minutes ago, so under the default policy an active member with no
  court booked gets in online and not offline. Stated rather than engineered around: the only fix
  is the club's whole membership roll on a board in a doorway, which nobody has asked for.
- **Egress is mechanical and is not ours.** Whether a door is released with no power is a property
  of the lock, not of firmware or of any build flag; getting *out* must never depend on the board,
  the relay, the API or the power. Both belong on `docs/go-live-checklist.md`, where a person
  signs them off — they are the two sentences in the spec that no test can pin.
- **The three settings bind under both key spellings** (`gateUnlockSeconds` and
  `gate_unlock_seconds`, and so on). The admin settings endpoint answers snake_case and binds
  camelCase; a client on the wrong one gets `null`, which that endpoint reads as "leave
  unchanged", so the save returns `{"saved": true}` and changes nothing. For three settings that
  decide who gets into a building, that silent write was worth removing rather than documenting.
