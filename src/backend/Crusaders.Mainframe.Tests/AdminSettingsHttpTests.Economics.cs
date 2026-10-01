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
    /// <summary>The money keys: the economics bounds, and the money keys P13 retired (bound and ignored).</summary>
    public sealed class Economics(PostgresFixture pg) : AdminSettingsHttpTests(pg), IClassFixture<PostgresFixture>
    {
        /// <summary>The retired money keys (P13 §3.9): no longer served, bound and ignored on the PUT.</summary>
        private static readonly string[] RetiredKeys =
            ["slice_price_credits", "credits_per_zar_regular", "credits_per_zar_league", "topup_block_zar", "topup_max_zar_per_member"];

        /// <summary>
        /// P13 §3.9: the slice price, the regular conversion rate, the top-up block and the cap are
        /// gone — a booking costs its length in minutes and packages have no cap — so the settings
        /// GET no longer serves them. The keys that stay (the penalty, the share lapse, the
        /// failure cooldown) still round-trip.
        /// </summary>
        [SkippableFact]
        public async Task The_retired_money_keys_are_not_served_and_the_rest_still_round_trip()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory, """{"slice_price_credits": 8, "credits_per_zar_regular": 1.6, "topup_block_zar": 100, "topup_max_zar_per_member": 1000}""");
            var client = AdminClient(factory, seeded);

            var body = Baseline();
            body["penaltyPct"] = 25m;
            body["share_lapse_hours"] = 36;
            body["topup_failure_cooldown_minutes"] = 45;
            var save = await client.PutAsJsonAsync(SettingsPath, body);
            Assert.Equal(HttpStatusCode.OK, save.StatusCode);

            var read = await client.GetFromJsonAsync<JsonElement>(SettingsPath);
            foreach (var key in RetiredKeys) Assert.False(read.TryGetProperty(key, out _), key);
            Assert.Equal(25m, read.GetProperty("penalty_pct").GetDecimal());
            Assert.Equal(36, read.GetProperty("share_lapse_hours").GetInt32());
            Assert.Equal(45, read.GetProperty("topup_failure_cooldown_minutes").GetInt32());
        }

        /// <summary>
        /// The hygiene rule (<c>memory/decisions-backend-hygiene.md</c>): the PWA sends the whole
        /// settings page back, so an older cached PWA still carrying a retired key must not be
        /// refused on every save. Each is BOUND and IGNORED whatever it holds — a value the old
        /// validators refused included — and nothing it says reaches the stored document.
        /// The league rate is no longer refused either (§12.9): there is no rate to point anyone to.
        /// </summary>
        [SkippableTheory]
        [InlineData("slicePriceCredits", -500)]
        [InlineData("slicePriceCredits", 8.005)]
        [InlineData("creditsPerZarRegular", 0)]
        [InlineData("creditsPerZarLeague", 2.4)]
        [InlineData("CreditsPerZarLeague", 2.4)]
        [InlineData("topupBlockZar", 500)]
        [InlineData("topupMaxZarPerMember", 100)]
        public async Task A_retired_money_key_on_the_settings_PUT_is_bound_and_ignored(string key, double value)
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory);
            var client = AdminClient(factory, seeded);

            var body = Baseline();
            body.Remove("slicePriceCredits");
            body[key] = (decimal)value;
            var save = await client.PutAsJsonAsync(SettingsPath, body);
            Assert.Equal(HttpStatusCode.OK, save.StatusCode);

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var stored = await db.TenantSettings.IgnoreQueryFilters().SingleAsync(x => x.TenantId == seeded.TenantId);
            foreach (var retired in RetiredKeys) Assert.DoesNotContain($"\"{retired}\"", stored.SettingsJson);
        }

        [SkippableTheory]
        [InlineData("memberPerDayMaxMinutes", 2000, "member_per_day_max_minutes_out_of_range")]
        [InlineData("retentionYears", 0, "retention_years_out_of_range")]
        [InlineData("noShowLookbackDays", 0, "no_show_lookback_days_out_of_range")]

        // The two that take money off a member, and the only two on this PUT that had no bound
        // at all — every value was accepted and persisted, and both reach the court box in the
        // heartbeat config. A grace window of 4321 minutes (72 hours) puts no-show detection
        // beyond the end of an operating day, so `no_show_penalty` never fires; a late-cancel
        // window of 99999 (69 days) puts EVERY cancellation inside the penalty window, so a
        // member cancelling a fortnight ahead pays the 30% penalty.
        [InlineData("graceWindowMinutes", 999, "grace_window_minutes_out_of_range")]
        [InlineData("graceWindowMinutes", 4321, "grace_window_minutes_out_of_range")]
        [InlineData("graceWindowMinutes", -1, "grace_window_minutes_out_of_range")]
        [InlineData("penaltyWindowMinutes", 99999, "penalty_window_minutes_out_of_range")]
        [InlineData("penaltyWindowMinutes", -1, "penalty_window_minutes_out_of_range")]
        public async Task An_economics_value_that_would_break_the_club_is_refused(string field, double value, string expected)
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory);
            var client = AdminClient(factory, seeded);

            // Values a form should never be able to submit.
            var payload = new Dictionary<string, object>
            {
                ["sliceMinutes"] = 15,
                ["slicePriceCredits"] = 8,
                ["advanceBookingDays"] = 14,
                ["dayStartMinute"] = 360,
                ["dayEndMinute"] = 1320,
                ["penaltyPct"] = 30m,
                ["graceWindowMinutes"] = 5,
                ["penaltyWindowMinutes"] = 15,
                [field] = value,
            };

            var save = await client.PutAsJsonAsync(SettingsPath, payload);
            Assert.Equal(HttpStatusCode.BadRequest, save.StatusCode);
            var body = await save.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal(expected, body.GetProperty("error").GetString());
        }
    }
}
