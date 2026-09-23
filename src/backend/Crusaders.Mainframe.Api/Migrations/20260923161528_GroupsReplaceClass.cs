using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <summary>
    /// Decision D2 (founder, 2026-09-23: "Groups instead please. Class doesn't make sense."):
    /// the two-value member class is removed and GROUPS become the one configurable concept. A
    /// group gains the two things the class carried — the top-up conversion rate
    /// (<c>CreditsPerZar</c>) and blueprint A.12's peak priority (<c>PeakPriority</c>) — plus a
    /// stable <c>SystemKey</c> for the group the system itself relies on.
    ///
    /// <para>
    /// <b>This migration moves live economics, so it moves them to exactly where they were.</b>
    /// Every <c>LeagueOrSenior</c> member joins the club's league group, which carries the rate the
    /// club's <c>credits_per_zar_league</c> setting held and peak priority; everybody else is in no
    /// new group and keeps the regular rate and no priority. Every group that already existed
    /// gets <c>PeakPriority = NULL</c> — no say — because before D2 no group had any say in peak
    /// priority; a NOT NULL <c>false</c> would have made each of them WITHHOLD it, and every league
    /// member who was also in an admin's "Coaches" group, or in a customised league group left
    /// beside the new one, would have lost the priority on deploy. The top-up rate and the peak
    /// answer for every member are therefore the same the moment after this runs as the moment
    /// before — <c>GroupsReplaceClassMigrationTests</c> pins that per member, on every branch
    /// below, including members in more than one group.
    /// </para>
    ///
    /// <para>
    /// <b>Which league group — the safety branch.</b> A club already has a group called "League
    /// members" (seeded unrestricted by <c>MemberGroupSeeder</c>) or "League" (an admin's own). If
    /// that group is still exactly as seeded — active, inheriting the court price, no caps, no
    /// windows, no description, and nobody in it who was not <c>LeagueOrSenior</c> — it IS the
    /// league group and is adopted in place. If an admin has customised it in any of those ways,
    /// adopting it would do one of two wrong things: bind the league members to rules the admin
    /// wrote for somebody else, or hand the league rate and peak priority to people an admin put
    /// there for another reason. So it is left exactly as it is and a new "League (migrated)"
    /// group is created instead, for the admin to reconcile by hand. A club with neither gets a
    /// new "League" group.
    /// </para>
    ///
    /// <para>
    /// <b>Recorded.</b> The move writes to the club's append-only change record as the system actor
    /// (<c>group.created</c> or <c>group.updated</c>, then <c>group.members_changed</c> naming every
    /// member moved), because a member asking "why am I in League?" six months from now deserves
    /// a row that answers it. Those rows cannot be removed by <see cref="Down"/> — the table's
    /// triggers forbid it, by design.
    /// </para>
    ///
    /// <para>
    /// <b>The league rate leaves <c>tenant_settings</c>.</b> Once it lives on the group, a
    /// <c>credits_per_zar_league</c> key left in the settings document would be a second, dead copy
    /// of a money number; the settings PUT now refuses it. <c>pending_topups.MemberClass</c>
    /// becomes <c>GroupId</c> — the league group's id on a row quoted at the league rate.
    /// </para>
    ///
    /// <para>
    /// <b><see cref="Down"/> rebuilds the class from membership of the ACTIVE league group</b> and
    /// puts <c>credits_per_zar_league</c> back from that group's rate. It is exact for everything
    /// this migration wrote. It is lossy only for what was done afterwards in the new model: a
    /// rate or a peak priority on any OTHER group has no class to go back to, and a pre-D2
    /// top-up row whose class was NULL comes back as 0 when it carries a quoted rate. The league
    /// group and its memberships are left in place, as an unrestricted inheriting group — which is
    /// all a group was before this migration — and its <c>IsSystemDefault</c> goes back to what it
    /// was: false on a group Up CREATED, and on an adopted group whose adoption row records it was
    /// false. Otherwise the old schema, which has no other way to delete a system group, would
    /// hold an admin's own "League" and every "League (migrated)" undeletable for ever.
    /// </para>
    /// </summary>
    public partial class GroupsReplaceClass : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(
                name: "GroupId",
                table: "pending_topups",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<decimal>(
                name: "CreditsPerZar",
                table: "member_groups",
                type: "numeric(8,4)",
                nullable: true);

            // Nullable, no default: NULL is "no say", and it is what every existing group gets.
            migrationBuilder.AddColumn<bool>(
                name: "PeakPriority",
                table: "member_groups",
                type: "boolean",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "SystemKey",
                table: "member_groups",
                type: "character varying(32)",
                maxLength: 32,
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_member_groups_TenantId_SystemKey",
                table: "member_groups",
                columns: new[] { "TenantId", "SystemKey" },
                unique: true,
                filter: "\"SystemKey\" IS NOT NULL");

            migrationBuilder.AddCheckConstraint(
                name: "ck_member_groups_credits_per_zar",
                table: "member_groups",
                sql: "\"CreditsPerZar\" IS NULL OR (\"CreditsPerZar\" > 0 AND \"CreditsPerZar\" <= 1000)");

            // The data move, per tenant. BEFORE the class columns are dropped, because it reads them.
            migrationBuilder.Sql(MoveClassIntoGroupsSql);

            migrationBuilder.DropColumn(
                name: "MemberClass",
                table: "pending_topups");

            migrationBuilder.DropColumn(
                name: "MemberClass",
                table: "memberships");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "MemberClass",
                table: "pending_topups",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "MemberClass",
                table: "memberships",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            // Back-fill BEFORE the group columns go, because it reads them.
            migrationBuilder.Sql(RebuildClassFromGroupsSql);

            migrationBuilder.DropIndex(
                name: "IX_member_groups_TenantId_SystemKey",
                table: "member_groups");

            migrationBuilder.DropCheckConstraint(
                name: "ck_member_groups_credits_per_zar",
                table: "member_groups");

            migrationBuilder.DropColumn(
                name: "GroupId",
                table: "pending_topups");

            migrationBuilder.DropColumn(
                name: "CreditsPerZar",
                table: "member_groups");

            migrationBuilder.DropColumn(
                name: "PeakPriority",
                table: "member_groups");

            migrationBuilder.DropColumn(
                name: "SystemKey",
                table: "member_groups");
        }

        /// <summary>
        /// The Up data move. <c>MemberClass = 1</c> is <c>LeagueOrSenior</c>; <c>Status = 0</c> is
        /// an active group; <c>PricingMode = 0</c> is inherit-court. The league rate falls back to
        /// 2.4 on exactly the terms <c>TenantSettingsAccessor</c> did — absent or not a JSON number
        /// — and additionally when it is outside the (0, 1000] the settings PUT has always
        /// enforced, since the new CHECK would refuse it.
        /// </summary>
        internal const string MoveClassIntoGroupsSql = """
            DO $$
            DECLARE
              t RECORD;
              cand RECORD;
              league_id uuid;
              league_name text;
              raw jsonb;
              rate numeric(8,4);
              customised boolean;
              suffix int;
              moved jsonb;
              system_actor constant uuid := '00000000-0000-0000-0000-000000000000';
              actor_name constant text := 'The club''s automatic system';
              why constant text := 'Member classes were replaced by groups (decision D2): every LeagueOrSenior member moved into the league group, which carries the league top-up rate and peak priority.';
            BEGIN
              FOR t IN SELECT "Id" FROM tenants LOOP
                league_id := NULL;

                SELECT s."SettingsJson" -> 'credits_per_zar_league' INTO raw
                  FROM tenant_settings s WHERE s."TenantId" = t."Id" LIMIT 1;
                rate := 2.4;
                IF raw IS NOT NULL AND jsonb_typeof(raw) = 'number'
                   AND (raw::text)::numeric > 0 AND (raw::text)::numeric <= 1000 THEN
                  rate := round((raw::text)::numeric, 4);
                END IF;

                SELECT g.* INTO cand
                  FROM member_groups g
                 WHERE g."TenantId" = t."Id" AND lower(g."Name") IN ('league members', 'league')
                 ORDER BY g."IsSystemDefault" DESC, (lower(g."Name") = 'league members') DESC, g."CreatedAt"
                 LIMIT 1;

                IF FOUND THEN
                  customised :=
                       cand."Status" <> 0
                    OR cand."PricingMode" <> 0
                    OR cand."PriceMultiplierBps" <> 10000
                    OR cand."FlatSlicePriceCredits" IS NOT NULL
                    OR cand."MaxSlotsPerDay" IS NOT NULL
                    OR cand."MaxMinutesPerDay" IS NOT NULL
                    OR cand."AdvanceBookingDays" IS NOT NULL
                    OR coalesce(cand."Description", '') <> ''
                    OR EXISTS (SELECT 1 FROM member_group_windows w WHERE w."GroupId" = cand."Id")
                    OR EXISTS (
                         SELECT 1 FROM member_group_members mm
                          WHERE mm."GroupId" = cand."Id"
                            AND NOT EXISTS (
                                  SELECT 1 FROM memberships ms
                                   WHERE ms."TenantId" = t."Id" AND ms."UserId" = mm."UserId"
                                     AND ms."MemberClass" = 1));
                ELSE
                  customised := NULL;
                END IF;

                IF customised IS FALSE THEN
                  -- Adopt the untouched league group in place.
                  league_id := cand."Id";
                  league_name := cand."Name";
                  UPDATE member_groups
                     SET "SystemKey" = 'league', "CreditsPerZar" = rate, "PeakPriority" = true,
                         "IsSystemDefault" = true, "UpdatedAt" = now()
                   WHERE "Id" = league_id;

                  INSERT INTO admin_change_log ("Id", "TenantId", "OccurredAt", "ActorUserId", "ActorName",
                    "Area", "Action", "SubjectKind", "SubjectId", "SubjectLabel", "Reason", "BeforeJson", "AfterJson", "RequestId")
                  VALUES (gen_random_uuid(), t."Id", now(), system_actor, actor_name,
                    'group', 'group.updated', 'group', league_id, league_name, why,
                    jsonb_build_object('credits_per_zar', NULL, 'peak_priority', NULL,
                      'is_system_default', cand."IsSystemDefault"),
                    jsonb_build_object('credits_per_zar', rate, 'peak_priority', true,
                      'is_system_default', true),
                    'migration:GroupsReplaceClass');
                ELSE
                  -- No league group, or a customised one that is left exactly as it is.
                  IF customised IS NULL THEN
                    league_name := 'League';
                  ELSE
                    league_name := 'League (migrated)';
                  END IF;
                  suffix := 1;
                  WHILE EXISTS (SELECT 1 FROM member_groups g
                                 WHERE g."TenantId" = t."Id" AND lower(g."Name") = lower(league_name)) LOOP
                    suffix := suffix + 1;
                    league_name := 'League (migrated ' || suffix || ')';
                  END LOOP;

                  league_id := gen_random_uuid();
                  INSERT INTO member_groups ("Id", "TenantId", "Name", "Description", "Status", "SortOrder",
                    "PricingMode", "PriceMultiplierBps", "FlatSlicePriceCredits", "MaxSlotsPerDay", "MaxMinutesPerDay",
                    "AdvanceBookingDays", "IsSystemDefault", "CreatedAt", "CreatedByUserId", "UpdatedAt",
                    "CreditsPerZar", "PeakPriority", "SystemKey")
                  VALUES (league_id, t."Id", league_name, NULL, 0,
                    coalesce((SELECT max(g."SortOrder") + 1 FROM member_groups g WHERE g."TenantId" = t."Id"), 0),
                    0, 10000, NULL, NULL, NULL, NULL, true, now(), system_actor, now(),
                    rate, true, 'league');

                  INSERT INTO admin_change_log ("Id", "TenantId", "OccurredAt", "ActorUserId", "ActorName",
                    "Area", "Action", "SubjectKind", "SubjectId", "SubjectLabel", "Reason", "AfterJson", "RequestId")
                  VALUES (gen_random_uuid(), t."Id", now(), system_actor, actor_name,
                    'group', 'group.created', 'group', league_id, league_name, why,
                    jsonb_build_object('name', league_name, 'status', 'active', 'pricing_mode', 'InheritCourt',
                      'multiplier_bps', 10000, 'credits_per_zar', rate, 'peak_priority', true,
                      'is_system_default', true),
                    'migration:GroupsReplaceClass');
                END IF;

                WITH ins AS (
                  INSERT INTO member_group_members ("Id", "TenantId", "GroupId", "UserId", "AddedByUserId", "AddedAt")
                  SELECT gen_random_uuid(), t."Id", league_id, ms."UserId", system_actor, now()
                    FROM memberships ms
                   WHERE ms."TenantId" = t."Id" AND ms."MemberClass" = 1
                     AND NOT EXISTS (SELECT 1 FROM member_group_members mm
                                      WHERE mm."TenantId" = t."Id" AND mm."GroupId" = league_id
                                        AND mm."UserId" = ms."UserId")
                  RETURNING "UserId"
                )
                SELECT jsonb_agg(jsonb_build_object('user_id', ins."UserId", 'name', ms."FullName") ORDER BY ms."FullName")
                  INTO moved
                  FROM ins JOIN memberships ms ON ms."UserId" = ins."UserId" AND ms."TenantId" = t."Id";

                IF moved IS NOT NULL THEN
                  INSERT INTO admin_change_log ("Id", "TenantId", "OccurredAt", "ActorUserId", "ActorName",
                    "Area", "Action", "SubjectKind", "SubjectId", "SubjectLabel", "Reason", "AfterJson", "RequestId")
                  VALUES (gen_random_uuid(), t."Id", now(), system_actor, actor_name,
                    'group', 'group.members_changed', 'group', league_id, league_name, why,
                    jsonb_build_object('added', moved, 'removed', '[]'::jsonb),
                    'migration:GroupsReplaceClass');
                END IF;

                UPDATE pending_topups SET "GroupId" = league_id
                 WHERE "TenantId" = t."Id" AND "MemberClass" = 1;

                UPDATE tenant_settings SET "SettingsJson" = "SettingsJson" - 'credits_per_zar_league'
                 WHERE "TenantId" = t."Id" AND "SettingsJson" ? 'credits_per_zar_league';
              END LOOP;
            END $$;
            """;

        /// <summary>
        /// The Down back-fill: the class from ACTIVE league-group membership, a top-up row's class
        /// from its locked group, <c>credits_per_zar_league</c> from the league group's rate, and
        /// <c>IsSystemDefault</c> back to false on every group Up created or adopted from a
        /// non-system group — read off Up's own change-log rows, the only record of what it was.
        /// </summary>
        internal const string RebuildClassFromGroupsSql = """
            UPDATE memberships ms SET "MemberClass" = 1
             WHERE EXISTS (
                   SELECT 1 FROM member_group_members mm
                     JOIN member_groups g ON g."Id" = mm."GroupId"
                    WHERE g."SystemKey" = 'league' AND g."Status" = 0
                      AND g."TenantId" = ms."TenantId" AND mm."TenantId" = ms."TenantId"
                      AND mm."UserId" = ms."UserId");

            UPDATE pending_topups p SET "MemberClass" = CASE
                     WHEN EXISTS (SELECT 1 FROM member_groups g
                                   WHERE g."Id" = p."GroupId" AND g."TenantId" = p."TenantId"
                                     AND g."SystemKey" = 'league') THEN 1
                     WHEN p."ConversionRate" IS NOT NULL THEN 0
                     ELSE NULL
                   END;

            UPDATE tenant_settings s
               SET "SettingsJson" = s."SettingsJson" || jsonb_build_object('credits_per_zar_league', g."CreditsPerZar")
              FROM member_groups g
             WHERE g."TenantId" = s."TenantId" AND g."SystemKey" = 'league' AND g."CreditsPerZar" IS NOT NULL;

            UPDATE member_groups g SET "IsSystemDefault" = false
             WHERE g."SystemKey" = 'league' AND g."IsSystemDefault"
               AND EXISTS (
                   SELECT 1 FROM admin_change_log c
                    WHERE c."TenantId" = g."TenantId" AND c."SubjectId" = g."Id"
                      AND c."RequestId" = 'migration:GroupsReplaceClass'
                      AND (c."Action" = 'group.created'
                           OR (c."Action" = 'group.updated'
                               AND c."BeforeJson" ->> 'is_system_default' = 'false')));
            """;
    }
}
