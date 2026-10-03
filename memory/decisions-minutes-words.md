---
name: crusaders-mainframe-decisions-minutes-words
description: "Frontend: minutes inside words (sentences, labels, buttons, aria) are spoken long form; the compact '1 h 30 min' is only a standalone figure paired with its spoken twin. A source scan pins copy modules."
type: decision
last_verified: 2026-10-03
---

# Minutes in words vs minutes as a figure (R6 X6-2, contract §7.1)

- **Rule.** Any minutes amount that sits inside words — a sentence, a toast, a button label, a
  radio's name, an aria-label, a field echo — is written with `minutesSpoken` ("1 hour 30
  minutes", "minus 16 minutes"). The compact `minutesCompact`/`minutesSigned` form ("1 h 30
  min") is only for a standalone figure that is drawn through `<Minutes>` / `MinutesFigure`
  (aria-hidden compact + sr-only spoken) or another explicit aria pair.
  *Why:* a screen reader reads a sentence whole, so "You need 45 min more" was heard as "45 min"
  (X6-2 found it on desk sheets, quick-amount radios, Sell, booking detail, member detail,
  account menu, invites, split totals). Long words for eye and ear in prose also match the
  emails (`MoneyFormat.Minutes`, §7.2), so prose reads the same in the app and the inbox.
- **Guard.** `src/frontend/src/lib/spokenMinutes.test.ts` fails if any `lib/*Copy.ts` calls
  `minutesCompact(`/`minutesSigned(`, and asserts the named places carry no `\d (h|min|d)`.
  Non-copy callers that build sentences (players detail, splitEditor, adminActs, bookingErrors,
  deskLedger, InviteLink, AccountMenu) were swept by hand; R6 asks went to FD1 (SplitTotals,
  MinutesChip aria-label) and FD2 (TopUpStatus, topUpOpen, the shelf's saving badge/line).
- **Adjectives.** A slot length is "15-minute slots" / "1-hour slots" (`sliceLengthLine`), not
  "15 minutes slots"; other lengths say "Slots of 1 hour 30 minutes".
- **Time on court** (a duration, `playCopy.hoursAndMinutes`) follows the same split:
  `hoursAndMinutesSpoken` in every sentence and the ring's label; profile/admin tiles pair the
  compact value with an sr-only twin.
- **No-break.** `detailModel.keepAmounts` binds the long units too ("1 hour 30 minutes" never
  breaks between number and unit, R5 V5-7).
- **A saving is said one way**: `packagesCopy.savesWords` → "Saves R50.00 (8%)" (desk Sell badge,
  console preview; the console table cell drops the verb under its "Saves" header). L6-11.
