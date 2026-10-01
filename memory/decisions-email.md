---
name: crusaders-mainframe-decisions-email
description: "Every message is sent by a CLUB, not by the platform: one identity resolver, both bodies derived from one block list so they cannot drift, the registration mail merged to match what the screen promises, and no image anywhere."
type: decision
last_verified: 2026-10-01
---

# Live decisions — what the club's mail is, and what it may claim

The voice these are written in is the product's own, held in
`src/frontend/src/lib/*Copy.ts`; the money rules the figures obey are in
[`decisions-settlement.md`](decisions-settlement.md).

- **A message is sent by a club, and the club is resolved once.** Four places had been deciding
  which club a member belongs to and they disagreed: `MemberApprovalService`'s own query,
  `PeripheralHealthWorker`'s `health.Tenant.DisplayName`, a `tenant?.DisplayName ?? "Crusaders
  Mainframe"` fallback in `BookingService`, and — on eleven templates — a literal in the markup.
  `ClubIdentityResolver` is the single source, and every template takes a `ClubIdentity` first.
  *Why it is a tenancy bug and not a polish item:* "Crusaders Mainframe" is the repository's name
  for the software, so on the second club's mail it was a **different club's name**, on the one
  surface that leaves the building.
- **The two sweeps build the identity per TENANT, never from the scoped resolver.**
  `NoShowWorker.TickAsync` and `PeripheralHealthWorker.TickAsync` both walk every tenant inside
  **one** scope, resetting `ITenantContext` as they go. A scoped, memoised resolver would sign
  every later club's mail with the first club's name and phone number. Both carry `Club` on the
  per-tick record instead (`Sweep.Club`, `Health.Club`).
- **Both bodies are derived from one list of blocks.** A template says what the message is about —
  paragraphs, a facts table, one callout, an action — and `EmailChrome` renders that as HTML and as
  text. *Why not a hand-written text half:* that is how the two drift, the figure gets corrected in
  one and not the other, and the half nobody looks at is the half that then lies about money.
  `Every_figure_the_html_states_is_stated_in_the_plain_text_too` is the guard.
- **Escaping is central, so a template cannot get it wrong.** The old markup escaped some
  interpolations and not others — `BookingConfirmation` printed a court name raw while
  `WalkUpNotStarted` encoded one. Block text is escaped once, at render.
- **There is no image, and the identity is type.** The wordmark on the crest blue (`#00498D`) with
  the tin (`#CF2E30`) as a rule beneath it — the same lockup `AuthShell` puts over the sign-in
  screen. Images are blocked by default in most clients; a masthead that has to load is one a
  member does not see.
- **Dark mode is defended against, not supported** (one light palette; clients invert): every
  cell carrying text paints its own ground as a `bgcolor` attribute **and** an inline
  `background-color`, because the clients that honour one ignore the other.
- **P13: every figure is whole minutes in words** (`EmailTemplates.Min` = `MoneyFormat.Minutes`);
  rand only where a member paid rand (purchase, desk sale), never on a minutes row. No mail says
  "credit"/"cr"/"top up" — `No_message_speaks_of_credits_or_topping_up` sweeps the catalogue.
  Templates with >6 inputs take a record (`PackagePurchaseReceipt`, `PackagePurchaseAttempt`,
  `DeskPackageSale`): the lizard gate, not taste. The receipt PDF maps U+2212 to `-` (WinAnsi
  dropped it, turning a debt into a balance); the penalty sentence quotes the floored minutes.
- **An applicant gets ONE email at registration** — the verification link — because
  `registrationCopy.ts` promises a link now and one more mail on approval; the old "pending review"
  notice made the count wrong and carried no link. `MembershipPending` is deleted (`feature-spec.md` §11).
- **The sender name is the club's.** `SMTP_FROM_NAME` is one value for the whole process, so on a
  two-club deployment every message from both arrived from the same sender — and that sender was
  the software's name. `EmailMessage.FromName` carries the club's; config stays the fallback for
  anything with no tenant behind it.
- **A club that has set no contact details is given none**, not an empty row. `club_contact_phone`
  and `club_contact_email` both default to empty, and the footer omits the line entirely — the same
  rule the sign-in refusal already keeps by staying quiet rather than printing "Call the club on
  null".
- **Every message says why the reader has it**, and there is no unsubscribe: a club cannot stop
  telling a member their money moved, and an unexplained mail reads as phishing.
