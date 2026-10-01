using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// P13's <c>MinutesReplaceCredits</c> (<c>docs/specs/minutes-and-packages.md</c> §2.4): it REFUSES
/// to run on money history, in both directions, and on an empty ledger it goes up, down and up
/// again with the money columns typed as the contract says.
///
/// <para>
/// <b>Its own database, not the class fixture's</b>, for the reason
/// <see cref="GroupsReplaceClassMigrationTests"/> gives: migrating a shared database down would
/// pull the schema out from under every other test in the class.
/// </para>
///
/// <para>
/// One case per refusal source, because each is its own <c>IF EXISTS</c> and deleting any one of
/// them must turn a case red (the contract's mutation check "the migration refusal removed").
/// </para>
/// </summary>
public sealed class MinutesReplaceCreditsMigrationTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Before = "20261001070503_AddScheduleEarlierRules";
    private const string Target = "20261001203424_MinutesReplaceCredits";

    /// <summary>Rows at the schema BEFORE the migration, each of which alone must stop it.</summary>
    public static TheoryData<string, string> MoneyHistory => new()
    {
        {
            "ledger_entries",
            """INSERT INTO ledger_entries ("Id","TenantId","UserId","Type","AmountCredits","ActorUserId","CreatedAt") VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 0, 10, gen_random_uuid(), now())"""
        },
        {
            "pending_topups",
            """INSERT INTO pending_topups ("Id","TenantId","UserId","AmountZar","IdempotencyKey","Status","CreatedAt") VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 100, 'tu_b0', 0, now())"""
        },
        {
            "device_pay_fors",
            """INSERT INTO device_pay_fors ("Id","TenantId","DeviceId","Nonce","BookingId","PayerUserId","CourtNumber","AmountCredits","AmountLabel","BalanceAfterCredits","GrantedSeconds","Paid","CreatedAt") VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), '0123456789abcdef', gen_random_uuid(), gen_random_uuid(), 1, 8, '8', 0, 0, true, now())"""
        },
    };

    [SkippableTheory]
    [MemberData(nameof(MoneyHistory))]
    public async Task Up_refuses_while_any_money_history_exists(string table, string seedSql)
    {
        Skip.IfNot(pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await WithScratchDatabaseAsync(async conn =>
        {
            await MigrateToAsync(conn, Before);
            await ExecAsync(conn, seedSql);

            var refused = await Assert.ThrowsAsync<PostgresException>(() => MigrateToAsync(conn, Target));
            Assert.Contains("pre-launch reset required", refused.MessageText);
            Assert.Contains($"({table})", refused.MessageText);
            Assert.Equal(Before, await LatestAsync(conn));
            // Nothing half-applied: the old column is still there.
            Assert.Equal("1", await ScalarAsync(conn,
                "SELECT count(*) FROM information_schema.columns WHERE table_name='ledger_entries' AND column_name='AmountCredits'"));
        });
    }

    /// <summary>A charged booking or a non-zero seat is money history too (§12.4), even with no ledger row.</summary>
    [SkippableTheory]
    [InlineData("bookings", "UPDATE bookings SET \"AmountChargedCredits\" = 8")]
    [InlineData("booking_participants", "UPDATE booking_participants SET \"ConsentedCredits\" = 4")]
    public async Task Up_refuses_on_a_charged_booking_or_a_non_zero_seat(string table, string chargeSql)
    {
        Skip.IfNot(pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await WithScratchDatabaseAsync(async conn =>
        {
            await MigrateToAsync(conn, Before);
            await ExecAsync(conn, BookingWithSeatSql);
            await ExecAsync(conn, chargeSql);

            var refused = await Assert.ThrowsAsync<PostgresException>(() => MigrateToAsync(conn, Target));
            Assert.Contains($"({table})", refused.MessageText);
            Assert.Equal(Before, await LatestAsync(conn));
        });
    }

    [SkippableFact]
    public async Task On_an_empty_ledger_it_goes_up_down_and_up_with_whole_minute_columns()
    {
        Skip.IfNot(pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await WithScratchDatabaseAsync(async conn =>
        {
            await MigrateToAsync(conn, Before);
            // An uncharged booking with a zero seat survives the move (a block is all a reset club keeps).
            await ExecAsync(conn, BookingWithSeatSql);

            await MigrateToAsync(conn, Target);
            Assert.Equal(
                "booking_participants.ConsentedMinutes:integer,booking_participants.ShareMinutes:integer,"
                + "bookings.AmountChargedMinutes:integer,device_pay_fors.AmountMinutes:integer,"
                + "device_pay_fors.BalanceAfterMinutes:integer,ledger_entries.AmountMinutes:integer",
                await ColumnsAsync(conn, "Minutes"));
            Assert.Equal("", await ColumnsAsync(conn, "Credits"));
            Assert.Equal("1", await ScalarAsync(conn, "SELECT count(*) FROM bookings WHERE \"AmountChargedMinutes\" = 0"));
            Assert.Equal("1", await ScalarAsync(conn, "SELECT count(*) FROM information_schema.tables WHERE table_name='minute_packages'"));

            // Down refuses on money history in the NEW shape too.
            await ExecAsync(conn, """INSERT INTO ledger_entries ("Id","TenantId","UserId","Type","AmountMinutes","ActorUserId","CreatedAt") VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 0, 10, gen_random_uuid(), now())""");
            var refused = await Assert.ThrowsAsync<PostgresException>(() => MigrateToAsync(conn, Before));
            Assert.Contains("(ledger_entries)", refused.MessageText);
            await ExecAsync(conn, "DELETE FROM ledger_entries");

            await MigrateToAsync(conn, Before);
            Assert.Equal("", await ColumnsAsync(conn, "Minutes"));
            Assert.Equal("1", await ScalarAsync(conn,
                "SELECT count(*) FROM information_schema.columns WHERE table_name='courts' AND column_name='SlicePriceCredits'"));

            await MigrateToAsync(conn, Target);
            Assert.Equal(Target, await LatestAsync(conn));
        });
    }

    // ---- plumbing -------------------------------------------------------------------------

    /// <summary>One uncharged booking and its organiser's seat at the schema before (the tables carry no foreign keys).</summary>
    private const string BookingWithSeatSql = """
        DO $$
        DECLARE b uuid := gen_random_uuid(); t uuid := gen_random_uuid(); u uuid := gen_random_uuid();
        BEGIN
            INSERT INTO bookings ("Id","TenantId","CourtId","UserId","ActorUserId","StartsAt","EndsAt","SliceMinutes","SliceCount",
                                  "AmountChargedCredits","Status","CancellationPenaltyWaived","CreatedAt")
                VALUES (b, t, gen_random_uuid(), u, u, now(), now() + interval '15 minutes', 15, 1, 0, 0, false, now());
            INSERT INTO booking_participants ("Id","TenantId","BookingId","Seat","UserId","Status","ShareCredits","ConsentedCredits",
                                              "ShareWeight","InvitedAt","NudgeCount","ReminderCount","CreatedAt","UpdatedAt","Version")
                VALUES (gen_random_uuid(), t, b, 1, u, 1, 0, 0, 1, now(), 0, 0, now(), now(), 0);
        END
        $$;
        """;

    private async Task WithScratchDatabaseAsync(Func<string, Task> body)
    {
        var admin = new NpgsqlConnectionStringBuilder(pg.ConnectionString) { Database = "postgres" }.ConnectionString;
        var name = $"p13_migration_{Guid.NewGuid():N}";
        await ExecAsync(admin, $"CREATE DATABASE \"{name}\"");
        var conn = new NpgsqlConnectionStringBuilder(pg.ConnectionString) { Database = name }.ConnectionString;
        try
        {
            await body(conn);
        }
        finally
        {
            // This database's pool only: ClearAllPools would close every parallel class's connections.
            NpgsqlConnection.ClearPool(new NpgsqlConnection(conn));
            await ExecAsync(admin, $"DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)");
        }
    }

    private static async Task<string> ColumnsAsync(string conn, string suffix) => await ScalarAsync(conn,
        $"SELECT coalesce(string_agg(table_name || '.' || column_name || ':' || data_type, ',' ORDER BY table_name, column_name), '') " +
        $"FROM information_schema.columns WHERE table_schema = 'public' AND column_name IN " +
        $"('Amount{suffix}','AmountCharged{suffix}','Share{suffix}','Consented{suffix}','BalanceAfter{suffix}') " +
        "AND table_name IN ('ledger_entries','bookings','booking_participants','device_pay_fors')");

    private static Task<string> LatestAsync(string conn)
        => ScalarAsync(conn, "SELECT max(\"MigrationId\") FROM \"__EFMigrationsHistory\"");

    private static MainframeDbContext Context(string conn)
    {
        var tenant = new TenantContext();
        tenant.Set(Guid.Empty, "p13");
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
