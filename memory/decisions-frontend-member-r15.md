---
name: crusaders-mainframe-decisions-frontend-member-r15
description: "Member words and frames, review round 15 (lane FE15m): an unnamed balance frame is never a movement, offline only when the phone says so, one initials rule, the club's acts named as the club's."
type: decision
last_verified: 2026-10-05
---

# Live decisions — member words and frames, review round 15 (lane FE15m)

Earlier: `decisions-frontend-member-r14.md`. Contract: BE15b `removed_by` / `added_by_club`.
Tests: `liveBalanceR15`, `unreachableR15`, `setupChecklistR15`, `detailCancelR15`, `initials`,
`initialsR15`, `walletCopyR15`, `wordsR15`, `inviteAcceptR15`, `clubActsR15`,
`SellPackageSheet.r15`, `e2e/member-r15-fe15m.spec.ts`.

- **An unnamed balance frame updates the figure and never raises a movement** (X15-6/E15-2/J15-3).
  The SSE transport tags `onmessage` frames `"unnamed"`; `record(…, quiet)` moves the balance only.
  *Why:* the server sends the legacy unnamed twin ~1 ms beside every named frame (either order) and
  opens every stream with an unnamed snapshot; its reasonless diff was the second toast. A bare
  unnamed frame (no `held_minutes`) keeps the held part the named frame stated.
- **"You're offline" only when `navigator.onLine === false`** (X15-3). A read that never reached the
  club from a phone with a network is "Can't reach the club — showing what we had at …" (stale
  notice), "Can't reach the club — your code still works" (pass badge), and a nothing-kept line's
  "once you're back online" tail becomes "Try again in a moment" (`unreachableNothingKept`; every
  nothing-kept line must match `backOnlineTail`, pinned by test). `writeCause` is neutral. This
  REVERSES R8's "offline whatever onLine says" wording, not its notice (still never red).
- **The setup checklist keeps each member's last read states on the phone**
  (`crusaders.setup-checklist.kept`, X15-4); "Couldn't check" only for what was never read here.
- **D15-5 (decision): no member Cancel once `attendance.checked_in_at` is set**, whatever an older
  `can_cancel` says; 409 `already_checked_in` is worded (sheet and bulk row). Admin cancel unaffected.
- **Lost-reply cancel toast claims nothing about the screen** (X15-7): "its figures aren't in this
  message — your wallet shows what came back". *Why:* the booking page re-reads and shows the refund.
- **One initials helper, `lib/initials.ts`, mirroring `MemberDisplay.SurnameInitial`** (J15-6):
  trimmed; the surname is the last non-suffix word (Jr, Sr, Junior/Júnior, Filho, Neto, II–IV,
  accent-folded) and its first letter. A source scan keeps it the only definition.
- **A toast stands alone, so it names the day** (J15-5): `shareRowSentence({ dated: true })` from the
  chip; ledger lines under a group heading keep the court alone. Share group headings carry the
  start time (J15-8). A share line falls back to the row's own counterparty, never "a partner" /
  "the organiser" ("The club" names nobody) (J15-7/E15-9).
- **Pay-for toasts read the rows' `counterparty_name`** (E15-7) with court + day + time; "Another
  member" until BE sets the counterparty on the pay-for postings (asked of BE15a).
- **Words agree with their figures** (J15-11): `agrees()` — "20 minutes go", "1 minute goes";
  accept confirmation is what THIS press paid, total beside it; collect go-ahead says "whatever their
  balance doesn't cover" (the page cannot know it); a R0.00 desk give names no payment method.
  Cancelled Money panel names the partners whose shares went back, singular for one (J14-7).
- **The club's acts are the club's** (J15-1): `removed_by` (seat read, else the 404) → "The club
  took you off …" / "Olga took you off …"; null or absent names nobody ("You were taken off …"),
  never the organiser. `added_by_club` → "The club added you to Owen's game".
- **A share line's other person is the row's `counterparty_name` first** (C5, typed on `LedgerRow`),
  then its To / From. **BE15b's twelve new Night booking kinds are `PLAYER_ACTS`** (never folded);
  the Night has no kind→icon map, so a new kind needs only that.
- **Layout** (measured, Chromium): header avatar capped `max-h-full max-w-full` in its px button
  (L15-6); booking page one gap token `detailLayout.ts` — the teams grid takes the page's column
  gap (L15-7, was 8px off); `/wallet/buy` docked button before a pick: "Pick a package", size md (L15-8).
