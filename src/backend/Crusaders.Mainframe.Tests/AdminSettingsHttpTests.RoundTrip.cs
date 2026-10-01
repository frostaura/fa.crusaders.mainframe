using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.Tokens;

namespace Crusaders.Mainframe.Tests;

public abstract partial class AdminSettingsHttpTests
{
    /// <summary>Reading the settings and saving them back unchanged changes nothing; a hand-edited document is clamped on read.</summary>
    public sealed class RoundTrip(PostgresFixture pg) : AdminSettingsHttpTests(pg), IClassFixture<PostgresFixture>
    {
        /// <summary>The round trip a settings screen performs: read, show, save unchanged.</summary>
        [SkippableFact]
        public async Task Opening_the_settings_page_and_saving_it_changes_nothing()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory);
            var client = AdminClient(factory, seeded);

            var shown = await client.GetFromJsonAsync<JsonElement>(SettingsPath);

            // What the engine will actually charge and schedule with, read independently.
            using (var scope = factory.Services.CreateScope())
            {
                var tenantContext = scope.ServiceProvider.GetRequiredService<Api.Multitenancy.ITenantContext>();
                tenantContext.Set(seeded.TenantId, seeded.Slug);
                var engine = await scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>().GetAsync(default);

                // Before the fix these differed: 30 vs 15 and 50 vs 8.
                Assert.Equal(engine.SliceMinutes, shown.GetProperty("slice_minutes").GetInt32());
                // P13: slice_price_credits is no longer served (§3.9).
                Assert.False(shown.TryGetProperty("slice_price_credits", out _));
                Assert.Equal(engine.PenaltyPct, shown.GetProperty("penalty_pct").GetDecimal());
                Assert.Equal(engine.GraceWindowMinutes, shown.GetProperty("grace_window_minutes").GetInt32());
                Assert.Equal(engine.PenaltyWindowMinutes, shown.GetProperty("penalty_window_minutes").GetInt32());
                Assert.Equal(engine.AdvanceBookingDays, shown.GetProperty("advance_booking_days").GetInt32());
            }

            // The screen saves back exactly what it was shown, which is what any settings
            // form does when a person changes one field and leaves the rest alone.
            var save = await client.PutAsJsonAsync(SettingsPath, new
            {
                sliceMinutes = shown.GetProperty("slice_minutes").GetInt32(),
                advanceBookingDays = shown.GetProperty("advance_booking_days").GetInt32(),
                dayStartMinute = shown.GetProperty("day_start_minute").GetInt32(),
                dayEndMinute = shown.GetProperty("day_end_minute").GetInt32(),
                penaltyPct = shown.GetProperty("penalty_pct").GetDecimal(),
                graceWindowMinutes = shown.GetProperty("grace_window_minutes").GetInt32(),
                penaltyWindowMinutes = shown.GetProperty("penalty_window_minutes").GetInt32(),
            });
            Assert.Equal(HttpStatusCode.OK, save.StatusCode);

            using (var scope = factory.Services.CreateScope())
            {
                var tenantContext = scope.ServiceProvider.GetRequiredService<Api.Multitenancy.ITenantContext>();
                tenantContext.Set(seeded.TenantId, seeded.Slug);
                var after = await scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>().GetAsync(default);

                Assert.Equal(15, after.SliceMinutes);
            }
        }

        /// <summary>
        /// The same round-trip, for every key this wave added — the box's nine screen timeouts,
        /// the error log's three bounds and the live streams' seven.
        ///
        /// <para>
        /// <b>Nineteen more chances at exactly the defect this file is named for.</b> The GET
        /// renders these from the CLAMPED readers and the PUT validates against the SAME
        /// constants, so a drift between the two would show here as a refusal of the page's own
        /// values — an admin opening Settings and pressing Save being told their screen timeout is
        /// out of range. And a value that saved but read back differently would mean a box running
        /// a timeout the club cannot see.
        /// </para>
        ///
        /// <para>
        /// Driven through the wire's snake_case spelling, which is what these bind under: unlike
        /// the door keys, nothing ever sent them camelCase, so there is one spelling and a test
        /// that used the wrong one would silently assert that omitted-means-unchanged works.
        /// </para>
        /// </summary>
        [SkippableFact]
        public async Task Saving_the_box_and_live_settings_exactly_as_shown_changes_nothing()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory);
            var client = AdminClient(factory, seeded);

            var shown = await client.GetFromJsonAsync<JsonElement>(SettingsPath);

            string[] numbers =
            [
                "lcd_revert_seconds", "lcd_choice_seconds", "lcd_card_seconds", "lcd_hint_seconds",
                "scan_memory_seconds", "clock_trust_minutes", "device_fault_max_per_hour",
                "device_error_retention_days", "device_error_max_open_rows", "device_error_ingest_per_minute",
                "sse_keepalive_seconds", "control_board_resync_seconds", "control_board_stale_multiplier",
                "realtime_fallback_after_failures", "realtime_fallback_window_seconds",
                "realtime_poll_seconds_wallet", "realtime_poll_seconds_control_board",
            ];

            var body = new Dictionary<string, object?>
            {
                ["sliceMinutes"] = shown.GetProperty("slice_minutes").GetInt32(),
                ["advanceBookingDays"] = shown.GetProperty("advance_booking_days").GetInt32(),
                ["dayStartMinute"] = shown.GetProperty("day_start_minute").GetInt32(),
                ["dayEndMinute"] = shown.GetProperty("day_end_minute").GetInt32(),
                ["penaltyPct"] = shown.GetProperty("penalty_pct").GetDecimal(),
                ["graceWindowMinutes"] = shown.GetProperty("grace_window_minutes").GetInt32(),
                ["penaltyWindowMinutes"] = shown.GetProperty("penalty_window_minutes").GetInt32(),
                ["relay_restore_enabled"] = shown.GetProperty("relay_restore_enabled").GetBoolean(),
                ["device_fault_reporting"] = shown.GetProperty("device_fault_reporting").GetBoolean(),
            };
            foreach (var key in numbers) body[key] = shown.GetProperty(key).GetInt32();

            var save = await client.PutAsJsonAsync(SettingsPath, body);
            Assert.Equal(HttpStatusCode.OK, save.StatusCode);

            var again = await client.GetFromJsonAsync<JsonElement>(SettingsPath);
            foreach (var key in numbers)
            {
                Assert.Equal(shown.GetProperty(key).GetInt32(), again.GetProperty(key).GetInt32());
            }
            Assert.Equal(
                shown.GetProperty("relay_restore_enabled").GetBoolean(),
                again.GetProperty("relay_restore_enabled").GetBoolean());
        }

        /// <summary>
        /// A hand-edited document holding nonsense is CLAMPED on read, never a 500.
        ///
        /// <para>
        /// The settings PUT is not the only way a number reaches that column — a restored backup,
        /// a data migration and a DBA all bypass it — and this accessor is read on every heartbeat,
        /// every booking and every device event. A 500 here is every request in the club, boxes
        /// included, with no way back except an UPDATE on the JSON column.
        /// </para>
        /// </summary>
        [SkippableFact]
        public async Task A_hand_edited_settings_document_is_clamped_on_read_and_never_a_five_hundred()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(
                factory,
                """{"slice_minutes":15.5,"lcd_revert_seconds":9000,"sse_keepalive_seconds":600,"device_error_retention_days":-4}""");
            var client = AdminClient(factory, seeded);

            var shown = await client.GetFromJsonAsync<JsonElement>(SettingsPath);

            // 15.5 is not an integer, so the reader falls back to the default rather than throwing.
            Assert.Equal(15, shown.GetProperty("slice_minutes").GetInt32());

            // The three out-of-range numbers read back as their bounds — what the engine will
            // actually use — rather than as what the column says.
            Assert.Equal(BoxSettings.MaxLcdRevertSeconds, shown.GetProperty("lcd_revert_seconds").GetInt32());
            Assert.Equal(RealtimeSettings.MaxKeepaliveSeconds, shown.GetProperty("sse_keepalive_seconds").GetInt32());
            Assert.Equal(MonitoringSettings.MinRetentionDays, shown.GetProperty("device_error_retention_days").GetInt32());
        }

        /// <summary>
        /// The settings row's own audit timestamp advances when the settings change.
        ///
        /// <para>
        /// <c>TenantSettings.UpdatedAt</c> was set once, at construction, and never written
        /// again: a club could change its penalty policy every week and the column would still
        /// read the seed date. Nothing reads it today, which is exactly why nobody noticed — the
        /// first person to ask "when did this club last change the rules that take money off a
        /// member" would have been answered confidently and wrongly.
        /// </para>
        /// </summary>
        [SkippableFact]
        public async Task Saving_settings_advances_the_rows_updated_at()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory);
            var client = AdminClient(factory, seeded);

            async Task<DateTimeOffset> StampAsync()
            {
                using var scope = factory.Services.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
                var row = await db.TenantSettings.AsNoTracking().IgnoreQueryFilters()
                    .FirstAsync(t => t.TenantId == seeded.TenantId);
                return row.UpdatedAt;
            }

            var seeded_at = await StampAsync();

            var body = Baseline();
            body["graceWindowMinutes"] = 7;
            Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync(SettingsPath, body)).StatusCode);

            var afterSave = await StampAsync();
            Assert.True(afterSave > seeded_at,
                $"UpdatedAt did not advance: still {afterSave:O} after a save (seeded {seeded_at:O}).");
        }

        /// <summary>
        /// Each new number is refused past BOTH of its bounds, with its own code.
        ///
        /// <para>
        /// A shared <c>settings_invalid</c> would be a seven-row form telling an admin that
        /// something on it is wrong. The code names the field, which is what lets the page put the
        /// message beside the input.
        /// </para>
        /// </summary>
        [SkippableTheory]
        [InlineData("lcd_revert_seconds", 2, 61, "lcd_revert_seconds_out_of_range")]
        [InlineData("lcd_choice_seconds", 4, 61, "lcd_choice_seconds_out_of_range")]
        [InlineData("lcd_card_seconds", 0, 11, "lcd_card_seconds_out_of_range")]
        [InlineData("lcd_hint_seconds", 0, 11, "lcd_hint_seconds_out_of_range")]
        [InlineData("scan_memory_seconds", 4, 301, "scan_memory_seconds_out_of_range")]
        [InlineData("clock_trust_minutes", 4, 1441, "clock_trust_minutes_out_of_range")]
        [InlineData("device_fault_max_per_hour", 0, 121, "device_fault_max_per_hour_out_of_range")]
        [InlineData("device_error_retention_days", 6, 731, "device_error_retention_days_out_of_range")]
        [InlineData("device_error_max_open_rows", 19, 2001, "device_error_max_open_rows_out_of_range")]
        [InlineData("device_error_ingest_per_minute", 9, 601, "device_error_ingest_rate_out_of_range")]
        [InlineData("sse_keepalive_seconds", 4, 56, "sse_keepalive_seconds_out_of_range")]
        [InlineData("control_board_resync_seconds", 29, 3601, "control_board_resync_out_of_range")]
        [InlineData("control_board_stale_multiplier", 0, 11, "control_board_stale_multiplier_out_of_range")]
        [InlineData("realtime_fallback_after_failures", 0, 11, "realtime_fallback_after_failures_out_of_range")]
        [InlineData("realtime_fallback_window_seconds", 29, 901, "realtime_fallback_window_out_of_range")]
        [InlineData("realtime_poll_seconds_wallet", 4, 301, "realtime_poll_wallet_out_of_range")]
        [InlineData("realtime_poll_seconds_control_board", 4, 121, "realtime_poll_control_board_out_of_range")]
        public async Task Each_new_number_is_refused_past_both_of_its_bounds(
            string key, int belowMin, int aboveMax, string code)
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory);
            var client = AdminClient(factory, seeded);

            foreach (var bad in new[] { belowMin, aboveMax })
            {
                var body = new Dictionary<string, object?>
                {
                    ["sliceMinutes"] = 15,
                    ["slicePriceCredits"] = 8,
                    ["advanceBookingDays"] = 14,
                    ["dayStartMinute"] = 360,
                    ["dayEndMinute"] = 1320,
                    ["penaltyPct"] = 30m,
                    ["graceWindowMinutes"] = 5,
                    ["penaltyWindowMinutes"] = 15,
                    [key] = bad,
                };

                var res = await client.PutAsJsonAsync(SettingsPath, body);
                Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);

                var error = JsonDocument.Parse(await res.Content.ReadAsStringAsync())
                    .RootElement.GetProperty("error").GetString();
                Assert.Equal(code, error);
            }
        }
    }
}
