---
name: crusaders-mainframe-decisions-share-causes
description: "Why a share moved and who moved it, decided off the record: share_cause by the act on the seat, the acting person as every share row's actor, the seat acts on the audit trail, paid by hand, and stands only to a partner who paid."
type: decision
last_verified: 2026-11-20
---

# Live decisions — why a share moved, and who moved it

The money rules are [`decisions-players.md`](decisions-players.md); the frame that carries the cause is
[`decisions-wallet-frames.md`](decisions-wallet-frames.md). Nothing here is a stored ledger column: the cause is decided
off the receipts and the audit record, because storing it was a schema change nobody asked for.

- **The causes** (`WalletShareCauses`, `LedgerService.cs:678-724`): `share_paid`, `club_collected`, `attended`,
  `share_returned`, `organiser_removed`, `split_changed`, `club_settled`, `player_added`, `share_back`,
  `booking_cancelled`, `club_removed`, `outage_refund`, `no_show`, `displaced` (five alias `Email.ShareActs`).
- **Decided by the act, read off the seat** (R14): `ShareLedger.CauseOf` reads `SeatFacts` (seat status + the
  `players.removed` record), never the caller's options, so a return that waited for cover and posts on a later sweep
  keeps its cause — the caller is gone by then. `share_returned` = the partner WITHDREW, only (the frontend keys on it);
  `organiser_removed` needs the `players.removed` row (a pre-R14 removal is `share_back`); `split_changed` needs a
  `players.split_changed` row for the seat NEWER than its last share movement (else a later desk adjustment read as the
  organiser's split); settle-outside is `club_settled`; an add that lowers an equal/ratio split is `player_added` (R16);
  anything else is `share_back`, actor null.
- **The club refunded the session** (R10 E10-7): `ShareLedger.ClubRefundOf` — outage, displaced, no-show (never after a
  reversal; a collect or removal keeps its own words) — sets `club_refund` on the `players.share_moved` payload and
  mail. A no-show return names the penalty part (`kept_minutes` = paid before the return − returned); a zero penalty
  keeps the club-refund words.
- **The acting person is every share row's actor** (R14 `ShareLedger.ActorOf`): the caller's
  `ReconcileOptions.ActorUserId`, else derived — the scanner (attended), the `booking.cancelled` record's actor (club,
  member or late cancel), the withdrawing partner, the organiser (removal, split change — both now pass
  `ReconcileOptions(organiserId)`), the removal record's actor; null = system; it **never defaults to the booker**.
  Derived actors never make a receipt born read (`OwnActionBy` unchanged). Accept, decline and accept-on-behalf
  reconciles carry NO actor: a waiting return of another seat retried there would be misattributed (R16).
- **A late check-in's reversal is the scanner's** (R14 E14-3): its audit row, both legs and the re-collected shares;
  `SettledLegsAsync` finds earlier reversal legs by their `noshow-reversal:{id}:` reference, not by the system actor.
  Displacement rows it causes stay the system's.
- **Actor truth on every surface** (R16 E16-7): ledger `actor_name` is null only for the owner's own act and the system,
  else the actor (a share moved by another member too); `actorName` says "Automatic" for `Guid.Empty`; CSV `done_by` is
  never blank (You / The club / Automatic / the player); pay-for legs name each other. The member's own wallet rows say
  "The club" for an admin actor (`LedgerRowMapper.Build(memberView)`); admin surfaces keep the name.
- **Share rows say direction and cause, read back off the record** (R15, `ShareRowCauses`): the newest act at or before
  the row (+2 s same-save slack) on THAT seat (a seat act never explains another seat) or its booking; collections are
  `club_collected` (its record), `attended` (after `NoShowReversedAt`) or `share_paid`; an unexplained return is
  `share_back`. The Night ("Paid Olive 16 minutes for their share of Court 1 — the club collected it") and the CSV use it.
- **The seat acts are on the record**, subject the partner, actor the admin or organiser, organiser in details
  (`PlayersService.SeatAuditFor`): `players.removed` (`participant_id`, `organiser_user_id`, `by_club`, in the removal's
  save), `players.split_changed` per partner whose share moved (`share_minutes`, `previous_share_minutes`; an add's carry
  `because: "player_added"`, `joined`, `by_club`, in the add's save), `players.game_cancelled` per live partner beside
  the "game is off" notice (detached when the notice dedupes), `players.withdrew` (actor = subject = partner,
  `paid_minutes`), `players.settled_outside`, `players.share_collected` (`collected_minutes`, in the money's own save),
  `players.added_by_club`, `players.accepted_by_club`, and since R17 `players.invited` (organiser-made adds only),
  `players.accepted` (a fresh self-accept) and `players.declined`.
- **Cause before effect** (R15 E15-4): `ShareSweep.SettleBookingAsync` raises the partners' `players.game_cancelled`
  record and notice BEFORE `ReconcileAsync`, saved before any share row it explains.
- **"Your share stands" only to a partner who paid one** (R17 E17-2): on a started game the club cancels, the
  `cancelled_share_stands` frame, the inbox ending and the mail's "stands" go only to a live seat with `PaidAsync > 0`;
  paid 0 reads "it had started, but you had paid no share, so nothing moves" (`GameCancelledPayload.PaidNoShare`).
- **A cancelled game asks nobody for anything** (R17): `ShareLedger.UnpaidAsync` treats a Cancelled booking as closed even
  with `evenIfClosed`, and `PlayerNotices.NeedsConsent(booking, seat)` is false on one (no single-argument overload, so
  no caller can forget the booking). Reconcile's own `IsClosed` is NOT changed: a cancelled court lit after all still
  collects partners' shares through Owed.
- **Paid by hand says what came back** (R17 E17-3): `PlayerNotices.SettledOutsideAsync(…, paidInApp)` — partner "— the
  N minutes you paid in the app go back to you", organiser "— … go back to them"; "nothing moves in the app" only when
  nothing was paid in the app. Every server string says "paid by hand" (`AdminChangeActions.cs:350`).
