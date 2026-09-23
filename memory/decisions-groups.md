---
name: crusaders-mainframe-decisions-groups
description: "D2 (2026-09-23): groups replaced the member class. The league system group carries the league top-up rate and peak priority; most restrictive wins — min rate, peak only if every group grants and at least one exists."
type: decision
last_verified: 2026-09-23
---

# Live decisions — groups are the one configurable concept (D2)

Founder, 2026-09-23: "Groups instead please. Class doesn't make sense." `Membership.MemberClass`
is gone; a group carries windows, price, caps, horizon, **`CreditsPerZar`** (top-up rate, null =
`credits_per_zar_regular`) and **`PeakPriority`**. `SystemKey = "league"` marks the group that
replaced `LeagueOrSenior`; it cannot be deleted. Resolution lives in `Services/MemberTariffs.cs`.

- **Rate = the LOWEST `CreditsPerZar` among the member's active groups that set one; else the
  regular rate.** *Why:* "most restrictive" (the plan's words), and safe under admin error — one more
  group can never make a member's money worth more. A rate-less group has no opinion, so a
  window-only group cannot drag a league member back to the regular rate.
- **Peak = at least one active group AND every active group grants it.** *Why:* "all groups grant"
  is vacuously true of none, which would give every unclassified member peak priority. Known
  cost: a league member added to a group without priority loses it — the refusal
  (`peak_hours_league_only`, code kept stable) names the group in `withheld_by_groups`.
- **`member_groups_enabled=false` does NOT switch the tariff off** — it governs windows, price
  and caps only. *Why:* no switch ever turned the class off; flipping it must not re-price members.
- **Rate lock preserved.** `pending_topups` locks `ConversionRate` AND `GroupId` at checkout; the
  ITN settles at the locked rate (`TopUpFlowTests.A_group_rate_is_locked_at_checkout_*`).
- **Migration `GroupsReplaceClass`** adopts an UNTOUCHED "League members"/"League" group in place;
  a customised one (any rule, window, description, archive, or a non-league member in it) is left
  alone and "League (migrated[ N])" is created. League rate moved out of `tenant_settings`; the
  settings PUT refuses `credits_per_zar_league` (`credits_per_zar_league_moved_to_groups`). Writes
  change-log rows as the system actor. Down rebuilds the class from ACTIVE league membership; it
  leaves the group rows and cannot delete the change-log rows (append-only by trigger).
- **Deprecated `member_class` for ONE release** on admin members list/spend, `/topup/options`,
  the stale-quote 409, and `member.*` / `credit.topped_up` webhooks, derived from the league group.
  Remove it in the release after the Groups page ships.
- **`group.archived` still does not demand a reason** — enforcing it would break the production
  Groups page, which archives with a bare `{status}`; enforce it with the P6 Groups rebuild.
- **`POST /admin/members/{id}/class` is deleted**; `PUT /admin/members/{userId}/groups` sets the
  whole set in one call, one `group.members_changed` row per group changed.
