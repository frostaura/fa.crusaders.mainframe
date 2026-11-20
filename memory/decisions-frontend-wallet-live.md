---
name: crusaders-mainframe-decisions-frontend-wallet-live
description: "The phone's live wallet: the chip owns every movement the stream brings, a frame is the member's own only when an in-flight write makes its reason, unnamed twins never toast, stale reads and answers overtaken by a frame are dropped."
type: decision
last_verified: 2026-11-20
---

# Live decisions — the live wallet on the phone (mechanics)

The server's frame is [`decisions-wallet-frames.md`](decisions-wallet-frames.md); the words a movement is said in are
[`decisions-frontend-wallet-words.md`](decisions-frontend-wallet-words.md). Code: `lib/liveBalance.ts`,
`components/shell/MinutesChip.tsx`, `lib/movementCopy.ts`, `lib/shareMovementCopy.ts`.

- **The minutes chip shows SPENDABLE** (F1.11; `data-minutes-chip`), naming the whole and the held/owed parts —
  superseding D11 §3a's "the figure stays the whole balance" (550 shown, a 520 booking refused). It reads
  `/wallet?limit=1` (balance and held parts are top-level on any page: 735 bytes vs 55 kB). It never shows a zero while
  loading (a skeleton — a red "0 min" says broke).
- **One owner per movement: the chip** (R11 X11-1). `MinutesChip.useClubMovementToast` says every movement the stream
  brought unbidden, worded by the frame's reason; the Wallet page's `useMoneyAnnouncement` stands down while the
  provider's delta is `source: "club"` and says only what no frame told the chip (its own Refresh landing a figure the
  stream missed). *Why:* on /wallet one club adjust raised two toasts.
- **A frame is the member's own only when a write in flight makes its reason** (R18 X18-2): `api.request` hands the
  listener `(phase, write)`; `liveBalance.writeMakes` maps path → reasons (book → `booking_charge`; cancel → refund /
  penalty / mixed / `cancelled_no_refund` / share moves; seat and invite acts → share moves; desk adjust/sell →
  `admin_adjustment` / `admin_top_up`; purchase → `top_up`). A member-route write never owns a frame with `actor_name` or
  `cancelled_by: "club"`; a desk route can (an admin's own wallet). Reasonless frames keep the older window (any
  money-moving write + 3 s, the F-round rule it narrowed). *Why:* that window silenced a club adjustment 6/6, and before
  it "booking or accepting an invite" read "The club took 20 off your wallet".
- **An unnamed balance frame updates the figure and never raises a movement** (R15 X15-6): the SSE transport tags
  `onmessage` frames `"unnamed"`; `record(…, quiet)` moves the balance only. *Why:* the server sends the legacy unnamed
  twin ~1 ms beside every named frame (either order) and opens every stream with an unnamed snapshot. A bare unnamed
  frame (no `held_minutes`) keeps the held part the named frame stated.
- **A wallet read is tagged with the frames seen when it was SENT** (R17 J17-2, `framesSeen` in `useLiveBalance`): an
  answer that finds a frame arrived since is dropped (unnamed twins count). *Why:* a slow focus read overwrote a newer
  frame and toasted "went up" when it went down. **Write answers follow the same rule** (FE17x): `apply(minutes,
  { sentAt? })` drops an answer overtaken by any frame — `sentAt` is `frameMark()` at the SEND, else the mark when this
  tab's money-moving bracket opened; a dropped answer sets no `expectSelf`; no re-read (the stream's silence detector
  covers a dead stream). **The wallet page hands over only a read it SENT with no frame since**; reads it joined
  (send time unknown) are never applied, and if their figure disagrees the page reads again so rows match the card.
- **The flyout is the NET change of the figure over a burst of frames under 1 s apart** (R3 M-1: a split cancel's last
  frame read −33 while the chip rose 100). It hangs UNDER the chip from its right edge (R19 L19-2: `right-0 top-full`,
  `w-max`, wraps inside `min(14rem, 220px)`, 12px gap — centred and nowrap it ran past a 1024 / 150 % screen); it says
  held movement ("· 6 min held/freed") when spendable ≠ wallet movement, and where held minutes went: into held → "10
  min held"; out as partners' shares in the same burst → "15 min back to Sam" / "back to your partner(s)"
  (`flyoutBackNote`, the burst's `sharedOut`); only the rest is "freed". Each figure glued to its unit.
- **Precise words are lazy chunks, never the entry**: `lib/movementCopy.ts` is `import()`ed per frame (the chip says
  `walletCopy.plainMovementSentence` if the chunk cannot be had — a toast is never lost); `lib/shareMovementCopy.ts`
  through the lazily loaded `shell/shareMovement.ts`. *Why:* R14/R16 wording took the entry to 498.8 and 494.98 of
  its 500 kB budget. Never import either from `walletCopy` or any static import of `main.tsx`; `entryGraph.test.ts` does
  NOT list them, so the rule is held by review ([`decisions-frontend-bundle.md`](decisions-frontend-bundle.md)).
- **Zero movements the chip still announces**: `cancelled_no_refund` and `cancelled_share_stands`
  (`liveBalance.ts:143,149`, neutral news at `:551`). A reason this build does not know, or `mixed` without rows, is
  NEUTRAL ("Your wallet went up by …"); "the club added" only for `admin_adjustment`; green only when nothing in `parts`
  was negative. `liveBalance` keeps `parts` only when well-shaped.
- **For an older server** the chip holds a lone `cancellation_refund` (+, no share part) up to `CANCEL_MERGE_MS` (1 s) and
  merges the `share_transfer` frame that follows (R12); alone it says the old sentence.
- **Toasts** are announced by one waiting polite region ([`decisions-frontend-shell.md`](decisions-frontend-shell.md));
  a toast leaves with its page (a route change drops toasts raised >1.5 s before it; one raised with the navigation
  stays — the provider re-renders per route, so its context value is memoised).
