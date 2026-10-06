---
name: crusaders-mainframe-decisions-frontend-member-r18
description: "Member words and frames, review round 18 (lane FE18m): own movement by frame reason, busy words, rows that stack, truthful cancelled shares."
type: decision
last_verified: 2026-10-06
---

# Live decisions — member words and frames, review round 18 (lane FE18m)

Earlier: `decisions-frontend-member-r17.md`. Contracts: BE18a (booking_not_open on accept, result
reason `cancelled`, checked_in_by_* on cancelled_share_stands), BE18s (`503 service_busy`).
Tests: `liveBalanceOwnR18`, `detailR18`, `pickerR18`, `busyWordsR18`, `be18aContractR18`,
`movementClubMixedR18`, `MinutesChip.heldR18`, `pauseOptimisticR18`, `e2e/member-r18-fe18m`.

- **A frame is the member's own only when a write in flight makes its reason** (X18-2).
  `api.request` hands the listener `(phase, write)` — one `{method, path}` object per request.
  `liveBalance.writeMakes` maps path → reasons (book → booking_charge, cancel → refund/penalty/
  mixed/cancelled_no_refund/share moves, seat and invite acts → share moves, desk adjust/sell →
  admin_adjustment/admin_top_up, purchase → top_up). A member-route write never owns a frame with
  `actor_name` or `cancelled_by: "club"`; a desk route can (an admin's own wallet). *Why:* the old
  window (any money write + 3 s) silenced a club adjustment 6/6. `expectSelf` covers only reasons a
  member's own act makes; reasonless frames keep the old window.
- **Three unsure causes** (superseded in R19 by four — `error` for a plain 500 — through
  `answerReasonOf`; `unsureCauseOf` is retired, `decisions-frontend-member-r19.md`) — busy / conflict / silent; `unsureWords`
  builds all three pairs, hand-written sentences carry `…Busy`/`…Conflict` twins. Busy is "The
  club's system was too busy to take this just now … in a moment", never "didn't answer".
- **Narrow rows stack, by rem container queries** (L18-1): picker row `@container/row` 15rem, invite
  list item `@container/card` 17rem (p-3 below), invite page card p-3 under 18rem of page, game facts
  lose their box under 13rem. *Trap:* arbitrary px spacing is banned outside `components/ui`
  (theme-vocabulary) — use containers, not `p-[16px]`. *Trap:* a `//` comment between JSX children
  paints as text (it shipped once on every accept sheet) — `{/* */}` only.
- **Figures whole**: accept figures nowrap and wrap under their term; a card's time range nowrap.
- **The invite deep link is `content` width**; facts and figures pair from 44rem of `@container/invite`.
- **Cancelled booking page**: wrappers drawn only with content (`courtColumnShows`,
  `cancelPanelShows`); no admin seat hands (`adminSeatHands`). A partner's cancelled share: paid →
  stands; returned → "the N you'd paid went back"; by hand → "nothing moved in the app"; else nothing.
- **"(you)" by member too** (`isViewerSeat`, auth user id) — the organiser's own seat may have no id.
- **The picker keeps a refusal's focus on close** (`keepRefusalFocus`: focus already in
  `[data-detail-notice]` stays). jsdom never animates; the unit test fakes an exit animation.
- **The chip flyout says held movement** ("· 6 min held/freed") when spendable ≠ wallet movement.
- PauseSwitch is optimistic with rollback.
