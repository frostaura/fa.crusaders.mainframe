---
name: crusaders-mainframe-decisions-backend-r19
description: "Backend round 19 (lane BE19): a device body naming two boards files its malformed_body fault against no board, listing every board it named."
type: decision
last_verified: 2026-10-06
---

# Live decisions: device bodies, review round 19 (lane BE19)

- **A body naming two boards is filed against neither (D19-4).** `DeviceBody.FileAsync` collects every
  distinct board MAC the request named (`DeviceBody.BoardsNamed`: the limiter's charged MAC, every `"mac"`
  in the raw text including nested ones, every top-level `mac` in any case, read as far as the bytes parse;
  non-MAC values skipped; at most 4). One → filed against that registered board, detail unchanged. Two or
  more → filed against no board (the club's folded `malformed_body` row) with
  `"<route>: <detail> (boards named: <mac>, <mac>)"` — stored lowercase hex.
  **Why:** R18 D18-5 refused the body but filed it against the FIRST-named MAC, so box-then-gate blamed the
  box and gate-then-box the door for a body either may have sent; "the charged board" is no better, since the
  charged MAC is just the first `"mac"` the regex saw. Same rule for an unreadable (cut) body naming two.
- `TopLevelMacs` now tolerates a body that stops parsing (returns what it read); `NamesTwoBoards` only ever
  calls it on parsed JSON, so its D18-5 behaviour is unchanged.
- Console: the two-board detail is not in `deviceFaultCopy.ts`'s `BODY_FAULT` table, so it renders as the raw
  detail (as R18's `TwoBoardsDetail` already did). A cut body naming two boards no longer maps to the
  "dropped" explanation line for the same reason.
- Tests: `R19DeviceBodyHttpTests` (8 two-board shapes red before the fix; 4 one-board controls).
