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
    /// <summary>The money keys: slice price, economics bounds, the top-up cap and the league rates that moved to groups.</summary>
    public sealed class Economics(PostgresFixture pg) : AdminSettingsHttpTests(pg), IClassFixture<PostgresFixture>
    {
        /// <summary>
        /// The nine keys the engine has always read and the admin API never showed. Until
        /// now the only way to change one was to hand-edit a JSON column on a live money
        /// system — no validation, no audit trail, and a conversion rate a typo away from
        /// making every top-up worthless.
        /// </summary>
        [SkippableFact]
        public async Task The_economics_keys_are_readable_and_writable()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory);
            var client = AdminClient(factory, seeded);

            var shown = await client.GetFromJsonAsync<JsonElement>(SettingsPath);
            Assert.Equal(1.6m, shown.GetProperty("credits_per_zar_regular").GetDecimal());
            // D2: the league rate is the league GROUP's now, and the settings document no longer
            // shows a second, dead copy of it.
            Assert.False(shown.TryGetProperty("credits_per_zar_league", out _));
            Assert.Equal("16:00-19:00", shown.GetProperty("peak_hours").GetString());
            Assert.Equal(60, shown.GetProperty("member_per_day_max_minutes").GetInt32());

            var save = await client.PutAsJsonAsync(SettingsPath, new
            {
                sliceMinutes = 15,
                slicePriceCredits = 8m,
                advanceBookingDays = 14,
                dayStartMinute = 360,
                dayEndMinute = 1320,
                penaltyPct = 30m,
                graceWindowMinutes = 5,
                penaltyWindowMinutes = 15,
                creditsPerZarRegular = 1.7m,
                peakHours = "17:00-20:00",
                memberPerDayMaxMinutes = 90,
            });
            Assert.Equal(HttpStatusCode.OK, save.StatusCode);

            using var scope = factory.Services.CreateScope();
            var tenantContext = scope.ServiceProvider.GetRequiredService<Api.Multitenancy.ITenantContext>();
            tenantContext.Set(seeded.TenantId, seeded.Slug);
            var after = await scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>().GetAsync(default);

            Assert.Equal(1.7m, after.CreditsPerZarRegular);
            Assert.Equal("17:00-20:00", after.PeakHoursRange);
            Assert.Equal(90, after.MemberPerDayMaxMinutes);

            // Omitted means unchanged. The booking-settings form and the economics form are
            // different screens; a save from one must not revert the other.
            Assert.Equal(1, after.PeakAdvanceHoursForRegular);
            Assert.Equal(2, after.RetentionYears);
        }

        /// <summary>
        /// D2: a settings PUT that still carries the league rate is REFUSED, not silently ignored —
        /// an admin typing a league rate into an old screen and reading "saved" would believe the
        /// club charged it. Both spellings, and the refusal writes nothing at all.
        /// </summary>
        [SkippableTheory]
        [InlineData("creditsPerZarLeague")]
        [InlineData("CreditsPerZarLeague")]
        public async Task A_league_rate_on_the_settings_PUT_is_refused_because_it_moved_to_groups(string key)
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory);
            var client = AdminClient(factory, seeded);

            var body = new Dictionary<string, object>
            {
                ["sliceMinutes"] = 15,
                ["slicePriceCredits"] = 8m,
                ["advanceBookingDays"] = 14,
                ["dayStartMinute"] = 360,
                ["dayEndMinute"] = 1320,
                ["penaltyPct"] = 30m,
                ["graceWindowMinutes"] = 5,
                ["penaltyWindowMinutes"] = 15,
                ["creditsPerZarRegular"] = 1.9m,
                [key] = 2.8m,
            };
            var res = await client.PutAsJsonAsync(SettingsPath, body);

            Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
            var error = await res.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("credits_per_zar_league_moved_to_groups", error.GetProperty("error").GetString());

            using var scope = factory.Services.CreateScope();
            scope.ServiceProvider.GetRequiredService<Api.Multitenancy.ITenantContext>().Set(seeded.TenantId, seeded.Slug);
            var after = await scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>().GetAsync(default);
            Assert.Equal(1.6m, after.CreditsPerZarRegular);
        }

        [SkippableTheory]
        [InlineData("creditsPerZarRegular", 0, "credits_per_zar_regular_out_of_range")]
        [InlineData("creditsPerZarRegular", -1, "credits_per_zar_regular_out_of_range")]
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

            // A conversion rate of zero makes every top-up worthless; a negative one credits
            // the member for paying. These are values a form should never be able to submit.
            var payload = new Dictionary<string, object>
            {
                ["sliceMinutes"] = 15,
                ["slicePriceCredits"] = 8m,
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

        [SkippableFact]
        public async Task A_top_up_cap_below_the_block_size_is_refused()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory);
            var client = AdminClient(factory, seeded);

            // No top-up would ever be legal, which reads to a member as the payment page
            // being broken rather than as a setting being wrong.
            var save = await client.PutAsJsonAsync(SettingsPath, new
            {
                sliceMinutes = 15,
                slicePriceCredits = 8m,
                advanceBookingDays = 14,
                dayStartMinute = 360,
                dayEndMinute = 1320,
                penaltyPct = 30m,
                graceWindowMinutes = 5,
                penaltyWindowMinutes = 15,
                topupBlockZar = 500m,
                topupMaxZarPerMember = 100m,
            });

            Assert.Equal(HttpStatusCode.BadRequest, save.StatusCode);
            var body = await save.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("topup_max_below_block", body.GetProperty("error").GetString());
        }

        /// <summary>
        /// <b>D2-B06.</b> <c>slice_price_credits</c> was required, written unconditionally, and
        /// validated by nothing. The court POST refuses a negative price and then falls back to
        /// this setting when one is omitted, so a club could be given a court on which every
        /// booking CREDITED the member — <c>{"saved":true}</c> and no sign anywhere.
        /// </summary>
        [SkippableTheory]
        [InlineData(-500, "slice_price_credits_out_of_range")]
        [InlineData(-0.01, "slice_price_credits_out_of_range")]
        [InlineData(100_000_000, "slice_price_credits_out_of_range")]
        public async Task A_slice_price_outside_its_bounds_is_refused(decimal price, string expected)
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory);
            var client = AdminClient(factory, seeded);

            var body = Baseline();
            body["slicePriceCredits"] = price;
            var save = await client.PutAsJsonAsync(SettingsPath, body);

            Assert.Equal(HttpStatusCode.BadRequest, save.StatusCode);
            Assert.Equal(expected, (await save.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());

            // And nothing was half-written: the club still prices a court the way it did.
            Assert.Equal(8m, (await EngineAsync(factory, seeded)).DefaultSlicePriceCredits);
        }

        /// <summary>
        /// Half a cent is not a price. The ledger column is <c>numeric(10,2)</c>, so the database
        /// rounds it and every figure quoted back to the member then disagrees with the row —
        /// the same failure the admin credit adjustment already refuses <c>amount_not_whole_cents</c> for.
        /// </summary>
        [SkippableFact]
        public async Task A_slice_price_that_is_not_whole_cents_is_refused()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory);
            var client = AdminClient(factory, seeded);

            var body = Baseline();
            body["slicePriceCredits"] = 8.005m;
            var save = await client.PutAsJsonAsync(SettingsPath, body);

            Assert.Equal(HttpStatusCode.BadRequest, save.StatusCode);
            Assert.Equal("slice_price_credits_not_whole_cents",
                (await save.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());
        }
    }
}
