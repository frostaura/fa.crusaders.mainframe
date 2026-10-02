---
name: crusaders-mainframe-decisions-groups
description: "D2: groups replaced the member class. P13: a group carries a package discount (lowest wins, rand only) and peak priority (tri-state); no group sets a price or a rate any more."
type: decision
last_verified: 2026-10-02
---

# Live decisions — groups are the one configurable concept (D2)

Founder, 2026-09-23: "Groups instead please. Class doesn't make sense." `Membership.MemberClass`
is gone; a group carries windows, caps, horizon, **`PackageDiscountBps`** (P13: its say on club
package prices, null = no say, an explicit 0 is a say) and **`PeakPriority`** (`bool?`: true grants, false withholds, null =
no say). `SystemKey = "league"` marks the group that replaced `LeagueOrSenior`; it cannot be
deleted or archived (409 `group_is_system_default`). Resolution lives in `Services/MemberTariffs.cs`.

- **Package discount = the LOWEST `PackageDiscountBps` among the member's active groups that set
  one** (P13 §3.8; rand only, never minutes; ties to the club's order; League starts at none).
  *Why:* "most restrictive", and safe under admin error — one more group can never make a member's
  money worth more. The discount and its group are locked on the purchase row (decisions-topups).
  Groups set NO price: a booking costs its minutes (P13), so group and court prices are gone.
- **Peak = at least one active group GRANTS and none WITHHOLDS; null has no say.** *Why:* the
  first cut was two-state ("every group grants"), so every pre-D2 group was born withholding and
  the migration silently took peak from every league member also in another group (review
  D2-P1, reproduced). Tri-state mirrors the rate's null; an explicit false still beats any grant
  and is named in `withheld_by_groups` (`peak_hours_league_only`, code kept stable); no grant at
  all is "no", so an unclassified member has no priority. A deviation from the plan's literal
  "peak only if all groups grant", made by the D2 fixer — Dean may overrule.
- **`member_groups_enabled=false` does NOT switch the discount off** — it governs windows and
  caps only. *Why:* no switch ever turned the class off; flipping it must not re-price members.
- **Migration `GroupsReplaceClass`** adopts an UNTOUCHED "League members"/"League" group in place;
  a customised one (any rule, window, description, archive, or a non-league member in it) is left
  alone and "League (migrated[ N])" is created. Every pre-existing group gets `PeakPriority` NULL.
  The settings PUT now binds and IGNORES `credits_per_zar_league` like every retired money key
  (P13 §12.9). Writes
  change-log rows as the system actor. Down rebuilds the class from ACTIVE league membership and
  restores `IsSystemDefault=false` on groups Up created or adopted from a non-system group (read
  off Up's own change-log rows); it leaves the group rows and cannot delete the change-log rows.
- **Deprecated `member_class` for ONE release** on admin members list/spend and `member.*`
  webhooks, derived from the league group; `minutes.purchased` never carries it (P13 §12.10).
  Remove it in the release after the Groups page ships.
- **`group.archived` still does not demand a reason** — enforcing it would break the production
  Groups page, which archives with a bare `{status}`; enforce it with the P6 Groups rebuild. The
  league group is refused outright, so no archive can re-price members today.
- **`POST /admin/members/{id}/class` is deleted**; `PUT /admin/members/{userId}/groups` sets the
  whole set in one call, one `group.members_changed` row per group changed. Every membership
  move (PUT and the per-group add/remove) also writes a `member.groups_changed` audit row with the
  member as subject and the tariff before/after. *Why:* the class endpoint's `member.class_changed`
  was the member-side answer to "who moved me to the regular rate"; group rows are keyed by group.
