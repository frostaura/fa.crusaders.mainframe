using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// D2's data move, <c>GroupsReplaceClass</c>, run Up and Down on a scratch database seeded at
/// the schema BEFORE it — the only way to prove what a migration does to live rows.
///
/// <para>
/// <b>Its own database, not the collection's.</b> Migrating DOWN a shared boundary database would
/// pull the schema out from under every other test in the run, so this creates
/// <c>d2_migration_*</c>, migrates it to the previous migration, seeds four clubs in raw SQL
/// against THAT schema, and drops it at the end.
/// </para>
///
/// <para>
/// The four clubs are the four branches: an untouched seeded league group (adopted in place), a
/// customised one (left alone; "League (migrated N)" created, with the name collision a real
/// club could have), none at all ("League" created), and a customised one with no league
/// members in the club (created, empty, no membership row recorded). A fifth adopts an admin's
/// own untouched "League", which was deletable before and must be deletable again after Down.
/// </para>
///
/// <para>
/// <b>League members who are ALSO in other groups</b> — an admin's "Coaches" group in A, and the
/// customised "League members" group B's league member was already in. Every group that existed
/// before D2 had no say in peak priority, so none of them may withhold it after (review D2-P1:
/// with a non-nullable flag they were all born "withholding", and exactly these members lost the
/// priority their class gave them).
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class GroupsReplaceClassMigrationTests
{
    private const string Before = "20260923103338_AddUserPreferences";
    private const string Target = "20260923161528_GroupsReplaceClass";

    private readonly PostgresFixture _pg;

    public GroupsReplaceClassMigrationTests(PostgresFixture pg) => _pg = pg;

    private static readonly Guid TA = Guid.NewGuid(), TB = Guid.NewGuid(), TC = Guid.NewGuid(), TD = Guid.NewGuid(), TE = Guid.NewGuid();
    private static readonly Guid A1 = Guid.NewGuid(), A2 = Guid.NewGuid(), A3 = Guid.NewGuid();
    private static readonly Guid B1 = Guid.NewGuid(), C1 = Guid.NewGuid(), D1 = Guid.NewGuid(), E1 = Guid.NewGuid();
    private static readonly Guid GaLeague = Guid.NewGuid(), GaNon = Guid.NewGuid(), GaCoaches = Guid.NewGuid(), GeLeague = Guid.NewGuid();
    private static readonly Guid GbLeague = Guid.NewGuid(), GbMigrated = Guid.NewGuid(), GdLeague = Guid.NewGuid();
    private static readonly Guid PA1 = Guid.NewGuid(), PA2 = Guid.NewGuid(), PA3 = Guid.NewGuid();

    [SkippableFact]
    public async Task Up_moves_every_league_member_into_the_league_group_and_Down_rebuilds_the_class()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        var admin = new NpgsqlConnectionStringBuilder(_pg.ConnectionString) { Database = "postgres" }.ConnectionString;
        var name = $"d2_migration_{Guid.NewGuid():N}";
        await ExecAsync(admin, $"CREATE DATABASE \"{name}\"");
        var conn = new NpgsqlConnectionStringBuilder(_pg.ConnectionString) { Database = name }.ConnectionString;

        try
        {
            await MigrateToAsync(conn, Before);
            await ExecAsync(conn, SeedSql);

            await MigrateToAsync(conn, Target);
            await AssertRatesUnchangedAsync(conn);
            await AssertUpAsync(conn);

            await MigrateToAsync(conn, Before);
            await AssertDownAsync(conn);
        }
        finally
        {
            NpgsqlConnection.ClearAllPools();
            await ExecAsync(admin, $"DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)");
        }
    }

    private static async Task AssertUpAsync(string conn)
    {
        // A — the untouched seeded group is ADOPTED in place: same row, now the league group.
        Assert.Equal("league|2.8000|true|true", await ScalarAsync(conn,
            $"SELECT \"SystemKey\"||'|'||\"CreditsPerZar\"||'|'||\"PeakPriority\"||'|'||\"IsSystemDefault\" FROM member_groups WHERE \"Id\"='{GaLeague}'"));
        Assert.Equal("2", await ScalarAsync(conn, $"SELECT count(*) FROM member_group_members WHERE \"GroupId\"='{GaLeague}'"));
        Assert.Equal("1", await ScalarAsync(conn, $"SELECT count(*) FROM member_group_members WHERE \"GroupId\"='{GaLeague}' AND \"UserId\"='{A3}'"));
        Assert.Equal("0", await ScalarAsync(conn, $"SELECT count(*) FROM member_group_members WHERE \"GroupId\"='{GaLeague}' AND \"UserId\"='{A2}'"));
        Assert.Equal("0", await ScalarAsync(conn, $"SELECT count(*) FROM member_groups WHERE \"TenantId\"='{TA}' AND \"Name\" LIKE 'League (%'"));

        // Every group that existed before D2 has NO SAY in peak priority — null, not false.
        Assert.Equal("null", await ScalarAsync(conn,
            $"SELECT coalesce(\"PeakPriority\"::text,'null') FROM member_groups WHERE \"Id\"='{GaCoaches}'"));

        // B — the customised group is left EXACTLY as it was, its league member still in it; the
        // next free name is created.
        Assert.Equal("|||null", await ScalarAsync(conn,
            $"SELECT coalesce(\"SystemKey\",'')||'|'||coalesce(\"CreditsPerZar\"::text,'')||'|'||coalesce(\"Description\",'')||'|'||coalesce(\"PeakPriority\"::text,'null') FROM member_groups WHERE \"Id\"='{GbLeague}'"));
        Assert.Equal("1", await ScalarAsync(conn, $"SELECT count(*) FROM member_group_members WHERE \"GroupId\"='{GbLeague}' AND \"UserId\"='{B1}'"));
        Assert.Equal("League (migrated 2)|2.4000|true", await ScalarAsync(conn,
            $"SELECT \"Name\"||'|'||\"CreditsPerZar\"||'|'||\"PeakPriority\" FROM member_groups WHERE \"TenantId\"='{TB}' AND \"SystemKey\"='league'"));
        Assert.Equal("1", await ScalarAsync(conn,
            $"SELECT count(*) FROM member_group_members mm JOIN member_groups g ON g.\"Id\"=mm.\"GroupId\" WHERE g.\"TenantId\"='{TB}' AND g.\"SystemKey\"='league' AND mm.\"UserId\"='{B1}'"));

        // C — no league group at all: "League" is created at the club's own league rate.
        Assert.Equal("League|3.0000|true", await ScalarAsync(conn,
            $"SELECT \"Name\"||'|'||\"CreditsPerZar\"||'|'||\"PeakPriority\" FROM member_groups WHERE \"TenantId\"='{TC}' AND \"SystemKey\"='league'"));

        // D — customised by a REGULAR member in it; a club with no league members still gets
        // an (empty) league group, and no membership row is recorded for nobody.
        Assert.Equal("League (migrated)", await ScalarAsync(conn,
            $"SELECT \"Name\" FROM member_groups WHERE \"TenantId\"='{TD}' AND \"SystemKey\"='league'"));
        Assert.Equal("0", await ScalarAsync(conn,
            $"SELECT count(*) FROM admin_change_log WHERE \"TenantId\"='{TD}' AND \"Action\"='group.members_changed'"));

        // E — an admin's own untouched "League" is adopted, and the record says it became a
        // system group (it was not one), so Down can give it back as it was.
        Assert.Equal("league|true", await ScalarAsync(conn,
            $"SELECT \"SystemKey\"||'|'||\"IsSystemDefault\" FROM member_groups WHERE \"Id\"='{GeLeague}'"));
        Assert.Equal("false|true", await ScalarAsync(conn,
            $"SELECT (\"BeforeJson\"->>'is_system_default')||'|'||(\"AfterJson\"->>'is_system_default') FROM admin_change_log WHERE \"SubjectId\"='{GeLeague}' AND \"Action\"='group.updated'"));

        // Top-up rows name the league group where they were quoted at the league rate.
        Assert.Equal(GaLeague.ToString(), await ScalarAsync(conn, $"SELECT \"GroupId\" FROM pending_topups WHERE \"Id\"='{PA1}'"));
        Assert.Equal("", await ScalarAsync(conn, $"SELECT coalesce(\"GroupId\"::text,'') FROM pending_topups WHERE \"Id\"='{PA2}'"));
        Assert.Equal("", await ScalarAsync(conn, $"SELECT coalesce(\"GroupId\"::text,'') FROM pending_topups WHERE \"Id\"='{PA3}'"));

        // The league rate left the settings document; nothing else in it moved.
        Assert.Equal("0", await ScalarAsync(conn, "SELECT count(*) FROM tenant_settings WHERE \"SettingsJson\" ? 'credits_per_zar_league'"));
        Assert.Equal("1.6", await ScalarAsync(conn, $"SELECT \"SettingsJson\"->>'credits_per_zar_regular' FROM tenant_settings WHERE \"TenantId\"='{TA}'"));

        // The class columns are gone.
        Assert.Equal("0", await ScalarAsync(conn,
            "SELECT count(*) FROM information_schema.columns WHERE column_name='MemberClass' AND table_name IN ('memberships','pending_topups')"));

        // And the club's change record says what happened, as the system, naming who moved.
        Assert.Equal("group.updated,group.members_changed", await ScalarAsync(conn,
            $"SELECT string_agg(\"Action\", ',' ORDER BY \"Action\" DESC) FROM admin_change_log WHERE \"TenantId\"='{TA}' AND \"RequestId\"='migration:GroupsReplaceClass'"));
        Assert.Equal("group.members_changed,group.created", await ScalarAsync(conn,
            $"SELECT string_agg(\"Action\", ',' ORDER BY \"Action\" DESC) FROM admin_change_log WHERE \"TenantId\"='{TB}'"));
        var moved = await ScalarAsync(conn,
            $"SELECT \"AfterJson\"::text FROM admin_change_log WHERE \"TenantId\"='{TA}' AND \"Action\"='group.members_changed'");
        Assert.Contains(A3.ToString(), moved);
        Assert.Contains("Ayesha Three", moved);
        Assert.DoesNotContain(A1.ToString(), moved); // already in the group — not moved again
        Assert.Equal("00000000-0000-0000-0000-000000000000|The club's automatic system", await ScalarAsync(conn,
            $"SELECT DISTINCT \"ActorUserId\"||'|'||\"ActorName\" FROM admin_change_log WHERE \"TenantId\"='{TC}'"));
    }

    /// <summary>
    /// The point of the whole migration: every member's top-up rate and peak standing is what
    /// their class gave them, read through the same <see cref="MemberTariffs"/> the API uses.
    /// </summary>
    private static async Task AssertRatesUnchangedAsync(string conn)
    {
        var expected = new (Guid Tenant, Guid User, decimal Rate, bool Peak)[]
        {
            // A1 is also in "Coaches"; A2 (regular) too — neither answer may move.
            (TA, A1, 2.8m, true), (TA, A3, 2.8m, true), (TA, A2, 1.6m, false),
            // B1 is also in the customised "League members" group left beside the new one.
            (TB, B1, 2.4m, true), (TC, C1, 3.0m, true), (TD, D1, 1.6m, false),
            (TE, E1, 2.4m, true),
        };

        foreach (var (tenant, user, rate, peak) in expected)
        {
            await using var db = Context(conn, tenant);
            var settings = await new TenantSettingsAccessor(db, TenantOf(tenant)).GetAsync(default);
            var tariff = await MemberTariffs.ForAsync(db, user, settings, default);
            Assert.True(rate == tariff.TopUpRate, $"{user}: rate {tariff.TopUpRate}, expected {rate}");
            Assert.True(peak == tariff.PeakPriority,
                $"{user}: peak {tariff.PeakPriority}, expected {peak}, withheld by [{string.Join(",", tariff.PeakWithheldBy)}]");
        }
    }

    private static async Task AssertDownAsync(string conn)
    {
        Assert.Equal($"{A1}:1,{A2}:0,{A3}:1,{B1}:1,{C1}:1,{D1}:0,{E1}:1", await ScalarAsync(conn,
            $"SELECT string_agg(\"UserId\"||':'||\"MemberClass\", ',' ORDER BY array_position(ARRAY['{A1}','{A2}','{A3}','{B1}','{C1}','{D1}','{E1}']::uuid[], \"UserId\")) FROM memberships"));
        Assert.Equal("1|0|", await ScalarAsync(conn,
            $"SELECT (SELECT \"MemberClass\" FROM pending_topups WHERE \"Id\"='{PA1}')||'|'||(SELECT \"MemberClass\" FROM pending_topups WHERE \"Id\"='{PA2}')||'|'||coalesce((SELECT \"MemberClass\"::text FROM pending_topups WHERE \"Id\"='{PA3}'),'')"));
        Assert.Equal("2.8|2.4|3|2.4|2.4", await ScalarAsync(conn,
            $"SELECT string_agg((\"SettingsJson\"->>'credits_per_zar_league')::numeric::float8::text, '|' ORDER BY array_position(ARRAY['{TA}','{TB}','{TC}','{TD}','{TE}']::uuid[], \"TenantId\")) FROM tenant_settings"));

        // IsSystemDefault goes back to what it was (review D2-P3): the seeded group stays a
        // system group; the admin's adopted "League" and every group Up CREATED are deletable
        // again, as nothing under the old schema would otherwise let anyone remove them.
        Assert.Equal("true|true|false", await ScalarAsync(conn,
            $"SELECT (SELECT \"IsSystemDefault\"::text FROM member_groups WHERE \"Id\"='{GaLeague}')||'|'||" +
            $"(SELECT \"IsSystemDefault\"::text FROM member_groups WHERE \"Id\"='{GbLeague}')||'|'||" +
            $"(SELECT \"IsSystemDefault\"::text FROM member_groups WHERE \"Id\"='{GeLeague}')"));
        Assert.Equal("false|false|false", await ScalarAsync(conn,
            $"SELECT string_agg(\"IsSystemDefault\"::text, '|') FROM member_groups WHERE " +
            $"(\"TenantId\"='{TB}' AND \"Name\"='League (migrated 2)') OR (\"TenantId\"='{TC}' AND \"Name\"='League') " +
            $"OR (\"TenantId\"='{TD}' AND \"Name\"='League (migrated)')"));
        Assert.Equal("0", await ScalarAsync(conn,
            "SELECT count(*) FROM information_schema.columns WHERE table_name='member_groups' AND column_name IN ('SystemKey','CreditsPerZar','PeakPriority')"));
    }

    // ---- plumbing -------------------------------------------------------------------------

    private static ITenantContext TenantOf(Guid tenant)
    {
        var ctx = new TenantContext();
        ctx.Set(tenant, "d2");
        return ctx;
    }

    private static MainframeDbContext Context(string conn, Guid tenant)
        => new(new DbContextOptionsBuilder<MainframeDbContext>().UseNpgsql(conn).Options, TenantOf(tenant));

    private static async Task MigrateToAsync(string conn, string migration)
    {
        await using var db = Context(conn, Guid.Empty);
        await db.GetService<IMigrator>().MigrateAsync(migration);
    }

    private static async Task ExecAsync(string conn, string sql)
    {
        await using var c = new NpgsqlConnection(conn);
        await c.OpenAsync();
        await using var cmd = c.CreateCommand();
        cmd.CommandText = sql;
        await cmd.ExecuteNonQueryAsync();
    }

    private static async Task<string> ScalarAsync(string conn, string sql)
    {
        await using var c = new NpgsqlConnection(conn);
        await c.OpenAsync();
        await using var cmd = c.CreateCommand();
        cmd.CommandText = sql;
        return (await cmd.ExecuteScalarAsync())?.ToString() ?? "";
    }

    /// <summary>
    /// Four clubs at the pre-D2 schema. <c>MemberClass</c> 1 is LeagueOrSenior. Club A's
    /// settings carry a non-default league rate (2.8) so an adoption that ignored the setting
    /// would show; B's carry none (the 2.4 fall-back); C's carry 3.
    /// </summary>
    private static string SeedSql => $$"""
        INSERT INTO tenants ("Id","Slug","DisplayName","Status","CreatedAt") VALUES
          ('{{TA}}','d2-a-{{TA:N}}','A','active',now()), ('{{TB}}','d2-b-{{TB:N}}','B','active',now()),
          ('{{TC}}','d2-c-{{TC:N}}','C','active',now()), ('{{TD}}','d2-d-{{TD:N}}','D','active',now()),
          ('{{TE}}','d2-e-{{TE:N}}','E','active',now());
        INSERT INTO tenant_settings ("TenantId","SettingsJson","UpdatedAt") VALUES
          ('{{TA}}','{"credits_per_zar_regular":1.6,"credits_per_zar_league":2.8}',now()),
          ('{{TB}}','{"credits_per_zar_regular":1.6}',now()),
          ('{{TC}}','{"credits_per_zar_regular":1.6,"credits_per_zar_league":3}',now()),
          ('{{TD}}','{"credits_per_zar_regular":1.6,"credits_per_zar_league":2.4}',now()),
          ('{{TE}}','{"credits_per_zar_regular":1.6}',now());
        INSERT INTO users ("Id","TenantId","Email","EmailVerified","IsAdmin","IsPlatformAdmin","Status","CreatedAt") VALUES
          ('{{A1}}','{{TA}}','a1@d2.review.test',true,false,false,'active',now()),
          ('{{A2}}','{{TA}}','a2@d2.review.test',true,false,false,'active',now()),
          ('{{A3}}','{{TA}}','a3@d2.review.test',true,false,false,'active',now()),
          ('{{B1}}','{{TB}}','b1@d2.review.test',true,false,false,'active',now()),
          ('{{C1}}','{{TC}}','c1@d2.review.test',true,false,false,'active',now()),
          ('{{D1}}','{{TD}}','d1@d2.review.test',true,false,false,'active',now()),
          ('{{E1}}','{{TE}}','e1@d2.review.test',true,false,false,'active',now());
        INSERT INTO memberships ("Id","TenantId","UserId","FullName","MembershipNumber","Status","CreatedAt","MemberClass") VALUES
          (gen_random_uuid(),'{{TA}}','{{A1}}','Ayesha One','A1',1,now(),1),
          (gen_random_uuid(),'{{TA}}','{{A2}}','Ayesha Two','A2',1,now(),0),
          (gen_random_uuid(),'{{TA}}','{{A3}}','Ayesha Three','A3',1,now(),1),
          (gen_random_uuid(),'{{TB}}','{{B1}}','Bongani One','B1',1,now(),1),
          (gen_random_uuid(),'{{TC}}','{{C1}}','Chloe One','C1',1,now(),1),
          (gen_random_uuid(),'{{TD}}','{{D1}}','Dirk One','D1',1,now(),0),
          (gen_random_uuid(),'{{TE}}','{{E1}}','Esme One','E1',1,now(),1);
        INSERT INTO member_groups ("Id","TenantId","Name","Description","Status","SortOrder","PricingMode","PriceMultiplierBps","IsSystemDefault","CreatedAt","CreatedByUserId","UpdatedAt") VALUES
          ('{{GaLeague}}','{{TA}}','League members',NULL,0,0,0,10000,true,now(),'{{Guid.Empty}}',now()),
          ('{{GaNon}}','{{TA}}','Non-league members',NULL,0,1,0,10000,true,now(),'{{Guid.Empty}}',now()),
          ('{{GbLeague}}','{{TB}}','League members',NULL,0,0,0,10000,true,now(),'{{Guid.Empty}}',now()),
          ('{{GbMigrated}}','{{TB}}','League (migrated)',NULL,0,1,0,10000,false,now(),'{{Guid.Empty}}',now()),
          ('{{GdLeague}}','{{TD}}','League',NULL,0,0,0,10000,false,now(),'{{Guid.Empty}}',now()),
          ('{{GaCoaches}}','{{TA}}','Coaches',NULL,0,2,0,10000,false,now(),'{{Guid.Empty}}',now()),
          ('{{GeLeague}}','{{TE}}','League',NULL,0,0,0,10000,false,now(),'{{Guid.Empty}}',now());
        -- A's league group already holds one league member: not moved twice.
        INSERT INTO member_group_members ("Id","TenantId","GroupId","UserId","AddedByUserId","AddedAt") VALUES
          (gen_random_uuid(),'{{TA}}','{{GaLeague}}','{{A1}}','{{Guid.Empty}}',now()),
          (gen_random_uuid(),'{{TD}}','{{GdLeague}}','{{D1}}','{{Guid.Empty}}',now()),
          -- A league member AND a regular member in an admin's "Coaches" group.
          (gen_random_uuid(),'{{TA}}','{{GaCoaches}}','{{A1}}','{{Guid.Empty}}',now()),
          (gen_random_uuid(),'{{TA}}','{{GaCoaches}}','{{A2}}','{{Guid.Empty}}',now()),
          -- B's league member is ALREADY in B's customised league group.
          (gen_random_uuid(),'{{TB}}','{{GbLeague}}','{{B1}}','{{Guid.Empty}}',now());
        -- B's league group has a window: customised.
        INSERT INTO member_group_windows ("Id","TenantId","GroupId","DayOfWeek","StartMinute","EndMinute") VALUES
          (gen_random_uuid(),'{{TB}}','{{GbLeague}}',2,1080,1260);
        INSERT INTO pending_topups ("Id","TenantId","UserId","AmountZar","IdempotencyKey","Status","CreatedAt","ConversionRate","MemberClass") VALUES
          ('{{PA1}}','{{TA}}','{{A1}}',100,'tu_{{PA1:N}}',1,now(),2.8,1),
          ('{{PA2}}','{{TA}}','{{A2}}',100,'tu_{{PA2:N}}',1,now(),1.6,0),
          ('{{PA3}}','{{TA}}','{{A3}}',100,'tu_{{PA3:N}}',1,now(),NULL,NULL);
        """;
}
