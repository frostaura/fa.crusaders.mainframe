using System.Reflection;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The upgrade path, on a database that has DATA in it: for every migration M, a database at the
/// schema just before M with realistic rows in every table it has reaches the latest schema.
///
/// <para>
/// <b>Why this exists.</b> On 2026-10-06 a redeploy to a test deployment failed on
/// <c>MinutesReplaceCredits</c>, which refuses on money history by design. The refusal was right;
/// the gap was that nothing ran the chain against a populated database — the suite's template is
/// migrated EMPTY (<see cref="PostgresDatabases"/>), and every other test starts at the latest schema.
/// A migration that breaks only on rows (a NOT NULL without a default, a unique index over
/// duplicates, a foreign key over orphans, a CHECK over existing values, a refusal nobody listed) was
/// therefore only discovered on deploy. Rows come from <see cref="PopulatedSchemaFiller"/>, which
/// reads the schema it is given, so a new migration is covered without editing this file.
/// </para>
///
/// <para>
/// <b>Deliberate refusals are listed, not tolerated.</b> A migration on <see cref="DeliberateRefusals"/>
/// must refuse a populated database with its documented message, leave the schema where it was, and
/// then — after the documented reset — let the chain complete. Each entry names the go-live checklist
/// section that tells an operator what to do; a refusal with no checklist section is a deploy that
/// stops with nobody told why.
/// </para>
///
/// <para>
/// <b>Two shapes.</b> The walk applies the chain one migration at a time, topping up every table
/// before each step — so every migration meets a populated pre-schema, rows of every earlier era
/// included, and a failure names the exact migration. The baselines go from a populated database to
/// the latest schema in one <c>MigrateAsync</c> call, the way a deploy does, from the first
/// production deploy's schema and from the schema before each of the last three migrations.
/// </para>
/// </summary>
public sealed class MigrationUpgradePathTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    /// <summary>A migration that refuses a populated database on purpose, and what an operator does about it.</summary>
    /// <param name="Migration">The migration id.</param>
    /// <param name="Message">A fragment of the refusal's error message.</param>
    /// <param name="ChecklistSection">A heading of <c>docs/go-live-checklist.md</c>, without its <c>#</c>s.</param>
    /// <param name="ResetSql">The reset that section documents, as it applies to the schema just before the migration.</param>
    public sealed record DeliberateRefusal(string Migration, string Message, string ChecklistSection, string ResetSql);

    /// <summary>Every migration allowed to refuse a populated database. It only ever grows by decision.</summary>
    public static readonly IReadOnlyList<DeliberateRefusal> DeliberateRefusals =
    [
        new(
            "20261001203424_MinutesReplaceCredits",
            "MinutesReplaceCredits: pre-launch reset required — money history exists",
            "2a. The money reset — minutes replace credits (P13)",
            """
            DELETE FROM ledger_entries;
            DELETE FROM pending_topups;
            DELETE FROM device_pay_fors;
            UPDATE bookings SET "AmountChargedCredits" = 0;
            UPDATE booking_participants SET "ShareCredits" = 0, "ConsentedCredits" = 0;
            """),
    ];

    /// <summary>The newest migration in place at the first production deploy (2026-09-19, commit f987f6b5).</summary>
    private const string FirstProductionDeploy = "20260907220641_AddDeviceOutOfServiceSince";

    /// <summary>Every migration in the API assembly, oldest first.</summary>
    private static readonly IReadOnlyList<string> Migrations =
    [
        .. typeof(MainframeDbContext).Assembly.GetTypes()
            .Where(t => t.IsSubclassOf(typeof(Migration)))
            .Select(t => t.GetCustomAttribute<MigrationAttribute>()?.Id)
            .OfType<string>()
            .Order(StringComparer.Ordinal),
    ];

    public static TheoryData<string> Baselines()
    {
        var data = new TheoryData<string>();
        foreach (var baseline in new[] { FirstProductionDeploy, Migrations[^4], Migrations[^3], Migrations[^2] }.Distinct())
        {
            data.Add(baseline);
        }
        return data;
    }

    [SkippableFact]
    public async Task Every_migration_applies_to_a_populated_database_at_the_schema_before_it()
    {
        Skip.IfNot(pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var db = await PostgresDatabases.CreateEmptyAsync();
        var filler = new PopulatedSchemaFiller();
        var refused = new List<string>();

        for (var i = 0; i < Migrations.Count; i++)
        {
            if (i > 0)
            {
                await filler.FillAsync(db.ConnectionString);
            }
            if (await ApplyAsync(db.ConnectionString, i > 0 ? Migrations[i - 1] : null, Migrations[i]))
            {
                refused.Add(Migrations[i]);
            }
        }

        // The filler works at the newest schema too — the next migration's pre-schema.
        await filler.FillAsync(db.ConnectionString);
        Assert.Equal(Migrations[^1], await LatestAsync(db.ConnectionString));
        Assert.Empty(await EmptyTablesAsync(db.ConnectionString));
        // An entry that no longer refuses a populated database is a stale entry.
        Assert.Equal(DeliberateRefusals.Select(r => r.Migration).Order(StringComparer.Ordinal), refused);
    }

    [SkippableTheory]
    [MemberData(nameof(Baselines))]
    public async Task A_populated_database_reaches_the_latest_schema_in_one_deploy(string baseline)
    {
        Skip.IfNot(pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");
        Assert.Contains(baseline, Migrations);

        await using var db = await PostgresDatabases.CreateEmptyAsync();
        await MigrateToAsync(db.ConnectionString, baseline);
        await new PopulatedSchemaFiller().FillAsync(db.ConnectionString);

        // One MigrateAsync to the latest, as a deploy does — split only where a deliberate refusal
        // stops it, which is exactly where an operator's reset happens.
        var at = baseline;
        foreach (var refusal in DeliberateRefusals.Where(r => string.CompareOrdinal(r.Migration, baseline) > 0))
        {
            var before = Migrations[IndexOf(refusal.Migration) - 1];
            if (before != at)
            {
                await MigrateOrExplainAsync(db.ConnectionString, before, $"from a populated {at}");
            }
            Assert.True(await ApplyAsync(db.ConnectionString, before, refusal.Migration),
                $"{refusal.Migration} should have refused a populated database");
            at = refusal.Migration;
        }
        await MigrateOrExplainAsync(db.ConnectionString, Migrations[^1], $"from a populated {at}");

        Assert.Equal(Migrations[^1], await LatestAsync(db.ConnectionString));
    }

    [Fact]
    public void Every_deliberate_refusal_names_a_real_migration_and_a_go_live_checklist_section()
    {
        var checklist = File.ReadAllLines(Path.Combine(DeploymentPostureTests.RepoRoot(), "docs", "go-live-checklist.md"));
        var headings = checklist.Where(l => l.StartsWith('#')).Select(l => l.TrimStart('#').Trim()).ToHashSet();

        Assert.NotEmpty(DeliberateRefusals);
        foreach (var refusal in DeliberateRefusals)
        {
            Assert.Contains(refusal.Migration, Migrations);
            Assert.True(headings.Contains(refusal.ChecklistSection),
                $"{refusal.Migration} names go-live checklist section \"{refusal.ChecklistSection}\", which " +
                "docs/go-live-checklist.md does not have. A deliberate refusal needs the section that tells an operator what to do.");
            Assert.False(string.IsNullOrWhiteSpace(refusal.Message));
            Assert.False(string.IsNullOrWhiteSpace(refusal.ResetSql));
        }
    }

    // ---- plumbing -------------------------------------------------------------------------

    /// <summary>
    /// Applies <paramref name="migration"/> to a database at <paramref name="before"/>. Returns true
    /// when it is a deliberate refusal that refused as documented and went through after the reset.
    /// </summary>
    private static async Task<bool> ApplyAsync(string conn, string? before, string migration)
    {
        var refusal = DeliberateRefusals.SingleOrDefault(r => r.Migration == migration);
        if (refusal is null || before is null)
        {
            await MigrateOrExplainAsync(conn, migration, $"from a populated {before ?? "empty database"}");
            return false;
        }

        var refused = await Assert.ThrowsAsync<PostgresException>(() => MigrateToAsync(conn, migration));
        Assert.Contains(refusal.Message, refused.MessageText);
        // Nothing half-applied.
        Assert.Equal(before, await LatestAsync(conn));

        await ExecAsync(conn, refusal.ResetSql);
        await MigrateOrExplainAsync(conn, migration, $"after the reset of go-live checklist §{refusal.ChecklistSection}");
        return true;
    }

    private static async Task MigrateOrExplainAsync(string conn, string target, string from)
    {
        try
        {
            await MigrateToAsync(conn, target);
        }
        catch (PostgresException e)
        {
            Assert.Fail(
                $"Migrating to {target} {from} failed: {e.SqlState} {e.MessageText}" +
                (e.Detail is null ? "" : $" ({e.Detail})") + (e.Where is null ? "" : $" at {e.Where}") +
                $". Last applied: {await LatestAsync(conn)}. A migration must apply to a database with rows in it. " +
                "If the refusal is deliberate, add it to DeliberateRefusals with the go-live checklist section " +
                "that tells an operator what to do.");
        }
    }

    private static int IndexOf(string migration)
    {
        for (var i = 0; i < Migrations.Count; i++)
        {
            if (Migrations[i] == migration)
            {
                return i;
            }
        }
        throw new InvalidOperationException($"{migration} is not a migration of this assembly.");
    }

    /// <summary>Tables with no rows — after a fill, none: the filler populates every table or fails.</summary>
    private static async Task<IReadOnlyList<string>> EmptyTablesAsync(string conn)
    {
        var tables = (await ScalarAsync(conn,
            "SELECT string_agg(table_name, ',') FROM information_schema.tables " +
            "WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name NOT LIKE '\\_\\_EF%'")).Split(',');
        var empty = new List<string>();
        foreach (var table in tables)
        {
            if (await ScalarAsync(conn, $"SELECT count(*) FROM \"{table}\"") == "0")
            {
                empty.Add(table);
            }
        }
        return empty;
    }

    private static Task<string> LatestAsync(string conn)
        => ScalarAsync(conn, "SELECT coalesce(max(\"MigrationId\"), '') FROM \"__EFMigrationsHistory\"");

    private static MainframeDbContext Context(string conn)
    {
        var tenant = new TenantContext();
        tenant.Set(Guid.Empty, "upgrade-path");
        return new(new DbContextOptionsBuilder<MainframeDbContext>().UseNpgsql(conn).Options, tenant);
    }

    private static async Task MigrateToAsync(string conn, string migration)
    {
        await using var db = Context(conn);
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
}
