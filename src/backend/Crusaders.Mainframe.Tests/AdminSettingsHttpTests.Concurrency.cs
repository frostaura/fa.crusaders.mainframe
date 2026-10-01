using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;

namespace Crusaders.Mainframe.Tests;

public abstract partial class AdminSettingsHttpTests
{
    /// <summary>
    /// Two admins with the settings page open at once (review round 4, A4-1).
    ///
    /// <para>
    /// The console sent all sixty-odd keys on every save, so saving a tab opened before a
    /// colleague's save put the colleague's old values back — recorded as the second admin's
    /// change. A save now carries only what it names, and the version the page read.
    /// </para>
    /// </summary>
    public sealed class Concurrency(PostgresFixture pg) : AdminSettingsHttpTests(pg), IClassFixture<PostgresFixture>
    {
        [SkippableFact]
        public async Task A_save_that_names_one_key_changes_only_that_key()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            var factory = CreateFactory();
            var seeded = await SeedAsync(factory, """{"slice_minutes":30,"fault_spike_minutes":16}""");
            var client = AdminClient(factory, seeded);

            var save = await client.PutAsJsonAsync(SettingsPath, new { fault_spike_count = 7 });
            Assert.Equal(HttpStatusCode.OK, save.StatusCode);
            var body = await save.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal(["fault_spike_count"], body.GetProperty("changed_keys").EnumerateArray().Select(k => k.GetString()));

            var read = await client.GetFromJsonAsync<JsonElement>(SettingsPath);
            Assert.Equal(7, read.GetProperty("fault_spike_count").GetInt32());
            Assert.Equal(16, read.GetProperty("fault_spike_minutes").GetInt32());
            Assert.Equal(30, read.GetProperty("slice_minutes").GetInt32());
        }

        [SkippableFact]
        public async Task A_save_from_a_page_opened_before_another_save_is_refused_with_the_current_values()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            var factory = CreateFactory();
            var seeded = await SeedAsync(factory, """{"fault_spike_minutes":15}""");
            var client = AdminClient(factory, seeded);

            var tabA = await client.GetFromJsonAsync<JsonElement>(SettingsPath);
            var tabB = await client.GetFromJsonAsync<JsonElement>(SettingsPath);
            var seen = tabA.GetProperty("version").GetString();
            Assert.False(string.IsNullOrEmpty(seen));
            Assert.Equal(seen, tabB.GetProperty("version").GetString());

            var first = await client.PutAsJsonAsync(SettingsPath, new { fault_spike_minutes = 16, version = seen });
            Assert.Equal(HttpStatusCode.OK, first.StatusCode);
            var firstBody = await first.Content.ReadFromJsonAsync<JsonElement>();
            var after = await client.GetFromJsonAsync<JsonElement>(SettingsPath);
            Assert.NotEqual(seen, after.GetProperty("version").GetString());
            Assert.Equal(after.GetProperty("version").GetString(), firstBody.GetProperty("version").GetString());

            // Tab B still holds 15 and the old version: its save is refused, nothing is written.
            var stale = await client.PutAsJsonAsync(SettingsPath, new { fault_spike_minutes = 15, fault_spike_count = 9, version = seen });
            Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
            var refusal = await stale.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("settings_changed", refusal.GetProperty("error").GetString());
            Assert.Equal(after.GetProperty("version").GetString(), refusal.GetProperty("version").GetString());
            Assert.Equal(16, refusal.GetProperty("settings").GetProperty("fault_spike_minutes").GetInt32());

            var final = await client.GetFromJsonAsync<JsonElement>(SettingsPath);
            Assert.Equal(16, final.GetProperty("fault_spike_minutes").GetInt32());
            Assert.NotEqual(9, final.GetProperty("fault_spike_count").GetInt32());
        }

        /// <summary>
        /// Two saves with one version at once: exactly one lands, the other is refused.
        ///
        /// <para>
        /// The interleaving is forced, not hoped for: the test holds the club's settings row
        /// from its own connection, fires both saves, waits until both are parked on a lock, and
        /// only then lets go. Without the handler's row lock both saves read the old document
        /// before either writes, and both are accepted.
        /// </para>
        /// </summary>
        [SkippableFact]
        public async Task Two_saves_racing_on_one_version_cannot_both_land()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            var factory = CreateFactory();
            var seeded = await SeedAsync(factory, """{"fault_spike_minutes":15}""");
            var client = AdminClient(factory, seeded);
            var seen = (await client.GetFromJsonAsync<JsonElement>(SettingsPath)).GetProperty("version").GetString();

            await using var holder = new NpgsqlConnection(_pg.ConnectionString);
            await holder.OpenAsync();
            await using var hold = await holder.BeginTransactionAsync();
            await using (var take = new NpgsqlCommand(
                "SELECT 1 FROM tenant_settings WHERE \"TenantId\" = @t FOR UPDATE", holder, hold))
            {
                take.Parameters.AddWithValue("t", seeded.TenantId);
                await take.ExecuteNonQueryAsync();
            }

            var saves = Enumerable.Range(0, 2)
                .Select(i => client.PutAsJsonAsync(SettingsPath, new { fault_spike_minutes = 20 + i, version = seen }))
                .ToList();
            await WaitForLockWaitersAsync(holder, 2);
            await hold.CommitAsync();

            var answers = await Task.WhenAll(saves);
            Assert.Equal(1, answers.Count(r => r.StatusCode == HttpStatusCode.OK));
            Assert.Equal(1, answers.Count(r => r.StatusCode == HttpStatusCode.Conflict));
        }

        /// <summary>
        /// Waits until <paramref name="waiters"/> lock requests are queued. <c>pg_locks</c>, not
        /// <c>pg_stat_activity</c>: the probe runs inside the holding transaction, and the
        /// activity view is snapshotted once per transaction, so it never shows a new waiter.
        /// </summary>
        private static async Task WaitForLockWaitersAsync(NpgsqlConnection probe, int waiters)
        {
            for (var i = 0; i < 300; i++)
            {
                await using var count = new NpgsqlCommand("SELECT count(*) FROM pg_locks WHERE NOT granted", probe);
                if ((long)(await count.ExecuteScalarAsync())! >= waiters) return;
                await Task.Delay(100);
            }
            throw new TimeoutException($"{waiters} saves never queued behind the held row");
        }

        /// <summary>An older console that sends no version still saves — only what it sends.</summary>
        [SkippableFact]
        public async Task A_save_without_a_version_is_not_checked()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            var factory = CreateFactory();
            var seeded = await SeedAsync(factory);
            var client = AdminClient(factory, seeded);

            await client.PutAsJsonAsync(SettingsPath, new { fault_spike_minutes = 16 });
            var save = await client.PutAsJsonAsync(SettingsPath, BaseSettings());
            Assert.Equal(HttpStatusCode.OK, save.StatusCode);
            Assert.Equal(16, (await client.GetFromJsonAsync<JsonElement>(SettingsPath)).GetProperty("fault_spike_minutes").GetInt32());
        }

        /// <summary>
        /// The opening hours sent back as shown are not a change: not on the record, not in
        /// <c>changed_keys</c>, and the version does not move.
        /// </summary>
        [SkippableFact]
        public async Task Opening_hours_saved_back_unchanged_are_not_a_change()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            var factory = CreateFactory();
            var seeded = await SeedAsync(factory,
                """{"operating_hours":{"sun":"07:00-20:00","mon":"06:00-22:00","saturday_note":"x"},"slice_price_credits":8.00}""");
            var client = AdminClient(factory, seeded);

            var shown = await client.GetFromJsonAsync<JsonElement>(SettingsPath);
            // Store the map in the form the GET renders so only its SPELLING differs from what is sent.
            await client.PutAsJsonAsync(SettingsPath, new { operatingHours = shown.GetProperty("operating_hours") });
            shown = await client.GetFromJsonAsync<JsonElement>(SettingsPath);

            var save = await client.PutAsJsonAsync(SettingsPath, new
            {
                operatingHours = shown.GetProperty("operating_hours"),
                slicePriceCredits = 8,
                version = shown.GetProperty("version").GetString(),
            });
            Assert.Equal(HttpStatusCode.OK, save.StatusCode);
            var body = await save.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Empty(body.GetProperty("changed_keys").EnumerateArray());
            Assert.Equal(shown.GetProperty("version").GetString(), body.GetProperty("version").GetString());

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var rows = await db.AdminChangeLogs.IgnoreQueryFilters()
                .CountAsync(r => r.TenantId == seeded.TenantId);
            Assert.Equal(1, rows);
        }

        /// <summary>A day start sent alone is checked against the end in force, not against nothing.</summary>
        [SkippableFact]
        public async Task A_day_start_sent_alone_is_checked_against_the_stored_end()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            var factory = CreateFactory();
            var seeded = await SeedAsync(factory, """{"day_start_minute":360,"day_end_minute":1200}""");
            var client = AdminClient(factory, seeded);

            var late = await client.PutAsJsonAsync(SettingsPath, new { dayStartMinute = 1260 });
            Assert.Equal(HttpStatusCode.BadRequest, late.StatusCode);
            Assert.Equal("operating_hours_invalid",
                (await late.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());

            var early = await client.PutAsJsonAsync(SettingsPath, new { dayStartMinute = 420 });
            Assert.Equal(HttpStatusCode.OK, early.StatusCode);
            var read = await client.GetFromJsonAsync<JsonElement>(SettingsPath);
            Assert.Equal(420, read.GetProperty("day_start_minute").GetInt32());
            Assert.Equal(1200, read.GetProperty("day_end_minute").GetInt32());
        }

        /// <summary>A booking horizon sent alone is checked against the schedule horizon in force.</summary>
        [SkippableFact]
        public async Task Advance_days_sent_alone_are_checked_against_the_stored_schedule_horizon()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            var factory = CreateFactory();
            var seeded = await SeedAsync(factory, """{"schedule_materialisation_days":30}""");
            var client = AdminClient(factory, seeded);

            var save = await client.PutAsJsonAsync(SettingsPath, new { advanceBookingDays = 45 });
            Assert.Equal(HttpStatusCode.BadRequest, save.StatusCode);
            Assert.Equal("advance_days_exceed_schedule_horizon",
                (await save.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());
        }
    }
}
