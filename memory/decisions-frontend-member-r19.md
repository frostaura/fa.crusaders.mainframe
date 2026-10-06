---
name: crusaders-mainframe-decisions-frontend-member-r19
description: "Member surfaces, review round 19 (lane FE19m): flyout under the chip, held/back notes, bell badge in its box, figures glued, read causes named."
type: decision
last_verified: 2026-10-06
---

# Live decisions — member surfaces, review round 19 (lane FE19m)

Earlier: `decisions-frontend-member-r18.md`. Tests: `MinutesChip.r19`, `NotificationBell.r19`,
`figuresWholeR19`, `gamesReadCauseR19`, `bookingDetailReadR19`, `privacyCauseR19`,
`e2e/member-r19-fe19m` (Chromium geometry for L19-2/3/8).

- **The chip's flyout hangs UNDER the chip, from its right edge** (L19-2): `right-0 top-full`,
  `w-max`, wraps inside `min(14rem, 220px)`, a 12px gap (the `flyout-rise` goes 10px up, so it
  never reaches back into the bar's row). *Why:* centred + nowrap it ran past a 1024 / 150 %
  screen, over the avatar, at y < 0. Each figure is glued to its unit.
- **The flyout says where held minutes went** (L19-4): into held → "10 min held" (shown even when
  the spendable figure did not move); out of held as partners' shares in the same burst →
  "15 min back to Sam" / "back to your partner" / "back to your partners" (`flyoutBackNote`,
  matching the toast's "went back to Sam for their share"); only the rest is "freed". The burst
  carries `sharedOut` (minutes + partner names of share rows that went OUT; an older frame without
  rows counts itself).
- **The bell's badge never leaves the bell's 44px box** (L19-8): right edge at
  `calc((100% - 44px) / 2)` from the glyph; type `min(0.75rem, 15px)`, padding `min(0.25rem, 4px)`,
  height `min(1.25rem, 22px)`. jsdom drops `min()` font sizes — the ceilings are e2e-measured.
- **Figures glued at paint, never in copy functions** (L19-3): `MinutesFigure` glues its compact
  paint; the wallet hero is drawn with it (same tones as `<Minutes>`); HeldLine, the balance
  sentence, the invite card ("· 3 players", day, "Pay by"), inbox headlines (list and pane) go
  through `keepFiguresWhole`. *Why not in copy:* tests build expected strings with the copy
  functions and the DOM normaliser folds U+00A0 only on the DOM side. A link named by glued text
  gets `aria-label` with the plain words (the inbox row). Exact `textContent` asserts normalise
  U+00A0. `<Minutes>` itself glues its paint (the root), and the money panel's deadline lines.
- **A failed read names its cause** (L19-7, X19-1.4): Upcoming/Recent games keep the read's error
  and `GamesReadFailed` says the lead then `describeFailure(error)` (busy, 429 with its seconds,
  clash, server error). The booking page's READ uses `PLAYERS_READ_REFUSAL` (read codes only):
  the write map's clash said "The page has the latest" about a page that never loaded (X19-1.2).
- **The privacy switch says why it went back** through `unsureSentence` with a full pair per
  cause (silent / busy / conflict / error — R19 X19-2's `error` for a plain 500): busy → "…too
  busy … Try again in a moment", clash → "…try again now", 500 → "the club's system hit an
  error", 429 → the rate-limit sentence. A plain 4xx keeps `saveFailed`.
- **Every write surface words a 5xx by `answerReasonOf`** (X19-2 sweep, handed over from FE19x):
  busy / conflict / error (a plain 500 — any 5xx but 502, 504, a code-less 503) / silent.
  `unsureCauseOf` is retired. Booking sheets (`SERVER_ERROR_TEXT`, `ERROR_UNSURE_TEXT`), the hold
  lift (`HOLD_LIFT_BUSY/_ERROR`), bulk cancel rows (`unsureRowWords`: busy/clash/error rows),
  the star, the reminder, a share link and the accept (`INVITE_UNSURE.error`). An error sentence
  never promises "a minute"/"a moment" — it says "tell the club committee if it keeps happening".
- **Tests read a toast as `[data-toast]` / `[data-toast-viewport]`** (X19-3 made the viewport the
  one polite region; a toast has no role). Wallet suites count `[role=status], [data-toast]` so a
  page's own status region still counts against "said once".
- **A proven write says what the answer was** (R19): `Landed.answered` / `ProvenBy` (false | the
  reason, truthy as the old flag was) reach `LOST_REPLY.proven(done, why)` and the notes built the
  same way — "…hit an error, but we checked its record: it went through"; only silence says "the
  reply didn't arrive". *Why:* after X19-2 a 500 is an answer; the proven sentence still denied it.
- **Toast gutters are pixel-capped** (B13): rem gutters + the dismiss button made a one-sentence
  toast 410px tall at 320 / 200 %. B13 measures a real toast, raised by a pushed wallet frame.
