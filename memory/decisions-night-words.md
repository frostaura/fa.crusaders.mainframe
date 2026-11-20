---
name: crusaders-mainframe-decisions-night-words
description: "How the Night words and shows rows: the code holder and scanner named, kinds per view (own, organiser, partner), player acts and money never folded, the server's headline as the words, door and board labels."
type: decision
last_verified: 2026-11-20
---

# Live decisions — the Night's words, views and folding

Which rows and instants: [`decisions-night.md`](decisions-night.md). The console renders the SERVER's headline; it has no
kind→icon map, so a new kind needs only its server word and, if it is one person's act, a place in `PLAYER_ACTS`.

- **Who scanned is named** (R10–R11): every `court.lights_on` audit row records `identified_user_id`; the trace event's
  `code_holder {user_id, name}` names it, so the Night says "with Pam's code" on Olga's booking; a late check-in's
  receipt borrows `code_holder` from its server lights-on twin (the receipt stays the measurement, the twin still
  drops); `booking.no_show_reversed` carries actor + `identified_user_id`. A device-actor row says "with <subject>'s
  code, at the board" or "reported by the court's board" (R9); a board kind that reads no code (`lights.restored`) never
  falls back to `subject` (FX18).
- **Refusals** say the court and the attempt (R11 E11-4): an activate with no booking records the court the box
  reported; `detail.attempt` (activate / walkup / pay_for) words the headline, and the client's burst key carries it, so
  distinct attempts never fold. A court-box `code_used` writes `court.activation_refused` about the member
  (`DeviceFaultSink.CodeUsedAtCourtAsync`, never the code): "Was turned away at Court N — code already used"; a pay-for
  refused `code_used` is on the payer's Night (quote and confirm). An offline refusal of a GENUINE v1 code names its
  member (R11 D11-2: re-checked with `CheckEvidenceAsync` at the scan's instant, no use claimed, code never stored,
  clamped clock → unnamed; outcome `refused_offline`, "Was refused at Court 2 while its box was offline").
- **Kinds by view** (R13–R17, `TraceView` Own / Organiser / Partner): withdrawal `booking.withdrew` (partner) /
  `booking.partner_withdrew` (organiser, read through `details.organiser_user_id` — a third OR in the audit read); a share
  RETURN on a Withdrawn seat at/after `RespondedAt` says "— they withdrew from the game" and names the partner as actor
  even on pre-R13 system rows; removals and splits `booking.taken_off` / `took_player_off` / `split_changed` /
  `changed_split`; `booking.game_cancelled` (null on the canceller's own night); club seat acts — partner
  `booking.share_settled_outside` / `share_collected` / `added_to_game`, organiser `booking.partner_share_settled_outside`
  / `partner_share_collected` / `club_added_player` / `club_took_player_off`, admin's own `settled_share_outside` /
  `collected_share` / `added_player`; accept-on-behalf `booking.accepted_for_them` / `club_accepted_player` /
  `accepted_for_player`; R17 `booking.invited|invited_player|accepted|partner_accepted|declined|partner_declined`.
- **A partner's Night carries the club's settlement of the game they paid into** (R15 J15-4): `booking.no_show` /
  `no_show_reversed` on a booking they hold a seat > 1 on (started within 7 days before the window) read as
  `booking.game_no_show` / `game_no_show_reversed`, naming the organiser and scanner. `court.lights_on`,
  `lights.restored` ("Court N lights came back on after a power cut") and `court.lights_off` join
  `TraceKinds.PartnersViewActions` for an accepted seat or the box payer only (`PartnerGamesAsync`).
- **Seat check-in** (R17): `court.checked_in` (`TraceKinds.SeatCheckedInAction`) folds when `lit_court` is set or the
  same scanner has a `court.activated` for the booking; organiser view "Sam checked in at Court 1", scanner view
  "Checked in at Court 1 for Olive's booking" (`TraceFacts.SeatOfName`). A seatless pay-for payer who paid and lit:
  "Pam Payer paid for Court 2 at the court box and lit it" (`TraceFacts.PaidAndLit`); the kind stays `court.checked_in`
  (the frontend landmark list keys on it).
- **Voice:** `court.activated` and reversals speak in the night-owner's voice (`TraceFacts.ByOther` / `ForOther`);
  `TraceFacts.BySelf` → "Their check-in reached the club late — no-show reversed". `booking.displaced` → "The club
  cancelled this booking on Court 1 and refunded it — Olive's earlier booking there was checked in late" (cause = owner
  of `displaced_by_booking_id`, neutral when unknown). An OUTAGE refund reversed: "The club took back an outage refund…".
  A desk top-up with no rand taken is "gave them … at no charge". The account's own story has words (applied, approved,
  turned down, suspended, reactivated, admin rights, code reset, passkeys, passwords, `account.pin_set`,
  `pin_set_for_them`, `pin_cleared`, `fingerprint_enrolled`, `admin_inherited` → "when they signed in",
  `member.groups_changed`, `member_code.enrolled`).
- **Doors on a night use the console's rule** (`TraceKinds.DoorLabel` = `doorDisplayName`): current name by device id,
  never the "Door gate" placeholder, else "Unnamed scanner (code)"; door CSVs too.
- **Never folded:** a player's acts on a booking and the seat-act kinds (`PLAYER_ACTS` in `nightTimeline`, each keyed
  alone, like money); `account.*` rows; restores fold only with restores (`nightCopy.actorClause` takes the row).
- **Console layout:** a Night card is a grid (time column + text) that stacks under an 18rem container; rows focusable
  for paging (`[data-night-row]`); the lights row names `code_holder`.
