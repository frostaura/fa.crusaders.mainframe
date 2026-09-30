---
name: crusaders-mainframe-decisions-groups
description: "D2 (2026-09-23): groups replaced the member class. The league system group carries the league rate and peak priority; min rate wins; peak is tri-state — granted if one group grants and none withholds."
type: decision
last_verified: 2026-09-23
---

# Live decisions — groups are the one configurable concept (D2)

Founder, 2026-09-23: "Groups instead please. Class doesn't make sense." `Membership.MemberClass`
is gone; a group carries windows, price, caps, horizon, **`CreditsPerZar`** (top-up rate, null =
`credits_per_zar_regular`) and **`PeakPriority`** (`bool?`: true grants, false withholds, null =
no say). `SystemKey = "league"` marks the group that replaced `LeagueOrSenior`; it cannot be
deleted or archived (409 `group_is_system_default`). Resolution lives in `Services/MemberTariffs.cs`.

- **Rate = the LOWEST `CreditsPerZar` among the member's active groups that set one; else the
  regular rate.** *Why:* "most restrictive" (the plan's words), and safe under admin error — one more
  group can never make a member's money worth more. A rate-less group has no opinion, so a
  window-only group cannot drag a league member back to the regular rate.
- **Peak = at least one active group GRANTS and none WITHHOLDS; null has no say.** *Why:* the
  first cut was two-state ("every group grants"), so every pre-D2 group was born withholding and
  the migration silently took peak from every league member also in another group (review
  D2-P1, reproduced). Tri-state mirrors the rate's null; an explicit false still beats any grant
  and is named in `withheld_by_groups` (`peak_hours_league_only`, code kept stable); no grant at
  all is "no", so an unclassified member has no priority. A deviation from the plan's literal
  "peak only if all groups grant", made by the D2 fixer — Dean may overrule.
- **`member_groups_enabled=false` does NOT switch the tariff off** — it governs windows, price
  and caps only. *Why:* no switch ever turned the class off; flipping it must not re-price members.
- **Rate lock preserved.** `pending_topups` locks `ConversionRate` AND `GroupId` at checkout; the
  ITN settles at the locked rate (`TopUpFlowTests.A_group_rate_is_locked_at_checkout_*`).
- **Migration `GroupsReplaceClass`** adopts an UNTOUCHED "League members"/"League" group in place;
  a customised one (any rule, window, description, archive, or a non-league member in it) is left
  alone and "League (migrated[ N])" is created. Every pre-existing group gets `PeakPriority` NULL.
  League rate moved out of `tenant_settings`; the
  settings PUT refuses `credits_per_zar_league` (`credits_per_zar_league_moved_to_groups`). Writes
  change-log rows as the system actor. Down rebuilds the class from ACTIVE league membership and
  restores `IsSystemDefault=false` on groups Up created or adopted from a non-system group (read
  off Up's own change-log rows); it leaves the group rows and cannot delete the change-log rows.
- **Deprecated `member_class` for ONE release** on admin members list/spend, `/topup/options`,
  the stale-quote 409, and `member.*` / `credit.topped_up` webhooks, derived from the league group.
  Remove it in the release after the Groups page ships.
- **`group.archived` still does not demand a reason** — enforcing it would break the production
  Groups page, which archives with a bare `{status}`; enforce it with the P6 Groups rebuild. The
  league group is refused outright, so no archive can re-price members today.
- **`POST /admin/members/{id}/class` is deleted**; `PUT /admin/members/{userId}/groups` sets the
  whole set in one call, one `group.members_changed` row per group changed. Every membership
  move (PUT and the per-group add/remove) also writes a `member.groups_changed` audit row with the
  member as subject and the tariff before/after. *Why:* the class endpoint's `member.class_changed`
  was the member-side answer to "who moved me to the regular rate"; group rows are keyed by group.
- **A group's price is shown on the club's REAL courts** (review round 1, F3, 2026-09-30): the
  cheapest active court as the example, plus a min/max range and a per-court list (`CourtPrices`);
  the retired club default is read only when no court is active. *Why:* "a slot costs 40 cr instead
  of 8" — every court carries its own price since the default was retired for new courts only.
