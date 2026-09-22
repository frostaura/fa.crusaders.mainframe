---
name: crusaders-mainframe-decisions-email
description: "Every message is sent by a CLUB, not by the platform: one identity resolver, both bodies derived from one block list so they cannot drift, the registration mail merged to match what the screen promises, and no image anywhere."
type: decision
last_verified: 2026-09-22
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
- **Dark mode is defended against, not supported.** The product has one light palette:
  `monitoring-posture.test.ts` asserts no `dark:` utility appears, and `pwa-posture.test.ts`
  asserts the `color-scheme: light` meta that stops a dark browser painting its own chrome
  underneath. There is nothing to mirror, and clients invert instead — so every cell carrying
  text paints its own ground as a `bgcolor` attribute **and** an inline `background-color`,
  because the clients that honour one ignore the other.
- **An applicant gets ONE email at registration.** `registrationCopy.ts` promises a link now and a
  second mail once the club approves; registration sent a "pending review" notice beside the
  verification link in the same second, so the approval mail was the third and the screen's count
  was wrong the moment they opened their inbox. The pending notice also carried no link, so whoever
  opened it first was told to wait by the message whose job was to tell them to press something.
  **The screen was right and the mail was wrong**; `MembershipPending` is deleted, and
  `docs/specs/feature-spec.md` §11 records the merge.
- **The sender name is the club's.** `SMTP_FROM_NAME` is one value for the whole process, so on a
  two-club deployment every message from both arrived from the same sender — and that sender was
  the software's name. `EmailMessage.FromName` carries the club's; config stays the fallback for
  anything with no tenant behind it.
- **A club that has set no contact details is given none**, not an empty row. `club_contact_phone`
  and `club_contact_email` both default to empty, and the footer omits the line entirely — the same
  rule the sign-in refusal already keeps by staying quiet rather than printing "Call the club on
  null".
- **Every message says why the reader has it.** There is no unsubscribe and there must not be one:
  a club cannot stop telling a member their money moved. A transactional mail that explains nothing
  about itself is indistinguishable from a phishing attempt, which is the failure that matters on
  the three carrying a sign-in link or a password.
