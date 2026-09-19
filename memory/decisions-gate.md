---
name: crusaders-mainframe-decisions-gate
description: "The door gate reuses the court box's contract with no EF migration; a board declares its kind once, event kinds are normalised once, a door is never attendance, and its trail finally has a reader."
type: decision
last_verified: 2026-09-19
---

# Live decisions — the door gate's shape

Oracle: `docs/specs/door-gate.md`; wire corpus `src/contracts/device-protocol/gate/`. The device
contract underneath is [`decisions-device.md`](decisions-device.md), unchanged by any of this;
who gets through a door is [`decisions-gate-access.md`](decisions-gate-access.md).

- **The device model held, and the bet is worth recording because it paid.** `DeviceKind` and
  `GateKey` were modelled years before there was hardware, so the whole backend needed **no EF
  migration** — both have been indexed columns since the device table shipped. Everything else is
  the court box's, reused rather than forked: the club key, the `/api/v1/device` group, the rate
  limit, auto-registration, the roster element grammar.
- **A board declares its kind once, on its first heartbeat, and can never re-kind its row.**
  Absent means `court_box`; an unrecognised string is a 400. *Why the row wins:* a gate that could
  turn itself into a court box would be handed the club's courts, and a box that could turn itself
  into a gate would drop off `DeviceOutageIndex`'s map of which courts have a working door and
  start waiving no-show penalties on them. Change a kind by deleting the row.
- **A door is never attendance.** No `CheckedInAt`, no no-show reversal, no ledger row, ever — the
  member may be collecting a racquet. A gate is invisible to the settlement model. Expect this to
  be argued with the first time somebody wants entry statistics; `gate.opened` rows are the
  statistics, readable at the activity route below.
- **`gate_access_policy` is the one setting in this tree that fails CLOSED.** A stored value that
  is not one of the two reads as `booking_window` — the opposite of the button map and the
  operating hours, where the failure mode is a club whose courts stop over a typo. Here it is "the
  building is open to anyone holding a live code". An ABSENT key is still the default.
- **Each kind is refused by name on the other's paths**, never by the accident of an empty court
  list — and the event `kind` is NORMALISED ONCE (trim + ordinal lower-case) so a respelling
  cannot step around it. `" gate_open "` did: it was audited as an honest `device.gate_open` while
  the guards, which read the raw field, saw neither the court-box refusal nor the token guard, so
  the live access code went into `DetailsJson` in full. Every kind's subject is now fingerprinted,
  the court box's `activation` included — since the door shipped, that roster token opens every
  door in the club for its booking's window.
- **Offline, a gate admits rostered bookings and nobody else**, at most 48, ordered `StartsAt`
  then `Id` with the cap applied AFTER — so the lockout is the LATEST-STARTING bookings and is the
  same set on every heartbeat. A `MemberIdent` code cannot be in a cache fetched minutes ago, so
  an active member with no court booked gets in online and not offline: the only fix is the club's
  whole roll on a board in a doorway.
- **Egress is mechanical and is not ours.** Whether a door is released with no power is a property
  of the lock, not of firmware. It belongs on `docs/go-live-checklist.md`, where a person signs it
  off — one of the two spec sentences no test can pin.
- **Both key spellings bind, on the settings PUT and on the device PATCH's `gate_key`.** They
  answer snake_case and .NET binds camelCase; the wrong one arrives as `null`, which both read as
  "leave unchanged", so the request returns `200` and changes nothing. Argued for the settings in
  G1 and **not applied to `gate_key`** until G3 — the field that names the door in every audit row
  a club will read back. snake_case wins where both arrive; every refusal fires under either.
- **The door's trail has a reader, and it did not.** `GET /admin/devices/{id}/activity` — admin
  JWT, tenant-scoped, both kinds, newest first, `limit` 1–200 clamped, 404 across tenants. Four
  spec sentences assumed one, and a door leaves no ledger entry, booking or receipt.
  `DetailsJson` is never returned and the fingerprint is **validated** to be eight lowercase hex
  rather than forwarded: rows predating G2's B4 hold the live code in `subject`.
- **`/me/qr/generate` tells the member's screen what its code does at a door** — `doors`,
  `door_opens_at`, `door_closes_at`. *Why the server:* `H` is built from three settings that do
  not belong on a member's API surface, and a page computing its own copy is how somebody is told
  their code works at a time their door refuses it. `door_closes_at` is the CODE's expiry.
