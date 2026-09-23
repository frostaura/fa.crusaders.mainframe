using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// <c>AddUserPreferences</c> on a database nobody has touched, and back down again.
///
/// <para>
/// A database of its own rather than the collection's shared one: the shared database has
/// already been migrated by whichever test ran first, so "applies to a fresh database" would be
/// a claim about test ordering. The Down leg is here because a migration that cannot be
/// reverted is a deploy that cannot be rolled back, and nothing else in the suite runs one.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class UserPreferencesMigrationTests
{
    private readonly PostgresFixture _pg;

    public UserPreferencesMigrationTests(PostgresFixture pg) => _pg = pg;

    private const string Previous = "20260921223101_AddMemberGroups";

    [SkippableFact]
    public async Task The_preferences_migration_applies_to_a_fresh_database_and_reverts_cleanly()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        var admin = new NpgsqlConnectionStringBuilder(_pg.ConnectionString) { Database = "postgres" }.ConnectionString;
        var name = $"prefmig_{Guid.NewGuid():N}";
        await ExecAsync(admin, $"CREATE DATABASE \"{name}\"");
        try
        {
            var fresh = new NpgsqlConnectionStringBuilder(_pg.ConnectionString) { Database = name }.ConnectionString;
            await using var factory = new TestWebAppFactory { ConnectionString = fresh };
            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

            await db.Database.MigrateAsync();
            Assert.Empty(await db.Database.GetPendingMigrationsAsync());
            Assert.True(await ExistsAsync(fresh, "SELECT 1 FROM pg_constraint WHERE conname = 'ck_user_preferences_theme'"));
            Assert.True(await ExistsAsync(fresh, "SELECT 1 FROM pg_indexes WHERE indexname = 'IX_user_preferences_TenantId_UserId'"));
            Assert.True(await ExistsAsync(fresh,
                "SELECT 1 FROM information_schema.columns WHERE table_name = 'user_preferences' " +
                "AND column_name = 'AdminNotificationOptoutsJson' AND data_type = 'jsonb'"));

            await db.GetService<IMigrator>().MigrateAsync(Previous);
            Assert.False(await ExistsAsync(fresh, "SELECT 1 FROM information_schema.tables WHERE table_name = 'user_preferences'"));

            await db.Database.MigrateAsync();
            Assert.True(await ExistsAsync(fresh, "SELECT 1 FROM information_schema.tables WHERE table_name = 'user_preferences'"));
        }
        finally
        {
            NpgsqlConnection.ClearAllPools();
            await ExecAsync(admin, $"DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)");
        }
    }

    private static async Task ExecAsync(string connectionString, string sql)
    {
        await using var conn = new NpgsqlConnection(connectionString);
        await conn.OpenAsync();
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        await cmd.ExecuteNonQueryAsync();
    }

    private static async Task<bool> ExistsAsync(string connectionString, string sql)
    {
        await using var conn = new NpgsqlConnection(connectionString);
        await conn.OpenAsync();
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        return await cmd.ExecuteScalarAsync() is not null;
    }
}
