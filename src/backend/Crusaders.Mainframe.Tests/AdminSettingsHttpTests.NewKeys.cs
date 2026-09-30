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
    /// <summary>Keys added later: each is served, writable, bounded and survives an unrelated save; the retired glyph set is gone.</summary>
    public sealed class NewKeys(PostgresFixture pg) : AdminSettingsHttpTests(pg), IClassFixture<PostgresFixture>
    {
        /// <summary>
        /// Every key added for GOAL items 3, 19 and 8 is served on the GET at its documented
        /// default, binds under BOTH spellings, and is unchanged by a save that does not mention
        /// it — the three properties that together make a settings key real rather than decorative.
        /// </summary>
        [SkippableTheory]
        [InlineData("memberMaxSlotsPerDay", "member_max_slots_per_day", 4, 6)]
        [InlineData("member_max_slots_per_day", "member_max_slots_per_day", 4, 6)]
        [InlineData("sameDayRelaxationWindowMinutes", "same_day_relaxation_window_minutes", 120, 45)]
        [InlineData("same_day_relaxation_window_minutes", "same_day_relaxation_window_minutes", 120, 45)]
        [InlineData("sseKeepaliveSeconds", "sse_keepalive_seconds", 25, 40)]
        [InlineData("sse_keepalive_seconds", "sse_keepalive_seconds", 25, 40)]
        [InlineData("realtimeFallbackAfterFailures", "realtime_fallback_after_failures", 3, 5)]
        [InlineData("realtimeFallbackWindowSeconds", "realtime_fallback_window_seconds", 120, 300)]
        [InlineData("realtimePollSecondsWallet", "realtime_poll_seconds_wallet", 20, 60)]
        public async Task A_new_numeric_setting_is_served_writable_and_survives_an_unrelated_save(
            string field, string wireKey, int documentedDefault, int chosen)
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory);
            var client = AdminClient(factory, seeded);

            var before = await client.GetFromJsonAsync<JsonElement>(SettingsPath);
            Assert.Equal(documentedDefault, before.GetProperty(wireKey).GetInt32());

            var body = Baseline();
            body[field] = chosen;
            Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync(SettingsPath, body)).StatusCode);

            Assert.Equal(chosen, (await client.GetFromJsonAsync<JsonElement>(SettingsPath)).GetProperty(wireKey).GetInt32());

            // Omitted means unchanged.
            Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync(SettingsPath, Baseline())).StatusCode);
            Assert.Equal(chosen, (await client.GetFromJsonAsync<JsonElement>(SettingsPath)).GetProperty(wireKey).GetInt32());
        }

        /// <summary>The three new booleans, on the same terms.</summary>
        [SkippableTheory]
        [InlineData("sameDayCapRelaxation", "same_day_cap_relaxation", true, false)]
        [InlineData("same_day_cap_relaxation", "same_day_cap_relaxation", true, false)]
        [InlineData("walkUpHonoursDayCap", "walk_up_honours_day_cap", false, true)]
        [InlineData("walk_up_honours_day_cap", "walk_up_honours_day_cap", false, true)]
        [InlineData("memberGroupsEnabled", "member_groups_enabled", true, false)]
        public async Task A_new_boolean_setting_is_served_writable_and_survives_an_unrelated_save(
            string field, string wireKey, bool documentedDefault, bool chosen)
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory);
            var client = AdminClient(factory, seeded);

            var before = await client.GetFromJsonAsync<JsonElement>(SettingsPath);
            Assert.Equal(documentedDefault, before.GetProperty(wireKey).GetBoolean());

            var body = Baseline();
            body[field] = chosen;
            Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync(SettingsPath, body)).StatusCode);
            Assert.Equal(chosen, (await client.GetFromJsonAsync<JsonElement>(SettingsPath)).GetProperty(wireKey).GetBoolean());

            Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync(SettingsPath, Baseline())).StatusCode);
            Assert.Equal(chosen, (await client.GetFromJsonAsync<JsonElement>(SettingsPath)).GetProperty(wireKey).GetBoolean());
        }

        /// <summary>
        /// The bounds. <c>sse_keepalive_seconds</c> carries the reason in its BODY rather than only
        /// a code: 55 is not a round number, it is the largest value that still sits under nginx's
        /// unset-and-therefore-60-second <c>proxy_read_timeout</c>, and an admin told only
        /// "out of range" would reasonably try 60 next and break the stream in a way that reports
        /// nothing.
        /// </summary>
        [SkippableTheory]
        [InlineData("memberMaxSlotsPerDay", -1, "member_max_slots_per_day_out_of_range")]
        [InlineData("memberMaxSlotsPerDay", 97, "member_max_slots_per_day_out_of_range")]
        [InlineData("sameDayRelaxationWindowMinutes", -1, "same_day_relaxation_window_out_of_range")]
        [InlineData("sameDayRelaxationWindowMinutes", 1441, "same_day_relaxation_window_out_of_range")]
        [InlineData("sseKeepaliveSeconds", 4, "sse_keepalive_seconds_out_of_range")]
        [InlineData("sseKeepaliveSeconds", 60, "sse_keepalive_seconds_out_of_range")]
        [InlineData("realtimeFallbackAfterFailures", 0, "realtime_fallback_after_failures_out_of_range")]
        [InlineData("realtimeFallbackAfterFailures", 11, "realtime_fallback_after_failures_out_of_range")]
        [InlineData("realtimeFallbackWindowSeconds", 29, "realtime_fallback_window_out_of_range")]
        [InlineData("realtimePollSecondsWallet", 4, "realtime_poll_wallet_out_of_range")]
        [InlineData("realtimePollSecondsWallet", 301, "realtime_poll_wallet_out_of_range")]
        public async Task A_new_number_outside_its_bounds_is_refused(string field, int value, string expected)
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory);
            var client = AdminClient(factory, seeded);

            var body = Baseline();
            body[field] = value;
            var save = await client.PutAsJsonAsync(SettingsPath, body);

            Assert.Equal(HttpStatusCode.BadRequest, save.StatusCode);
            var problem = await save.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal(expected, problem.GetProperty("error").GetString());

            if (expected == "sse_keepalive_seconds_out_of_range")
            {
                Assert.Equal(55, problem.GetProperty("max_seconds").GetInt32());
                Assert.Equal("proxy_idle_timeout_60s", problem.GetProperty("because").GetString());
            }
        }

        /// <summary>
        /// The thumbs/marks glyph choice (GOAL item 12) is retired (P10): the PWA draws no glyph on
        /// a button at rest, so the setting decided nothing. It is no longer served — here or on
        /// <c>/me/profile</c> — and a save that still carries it, under either spelling and whatever
        /// it holds, is accepted and ignored, because an older PWA sends the whole page back and
        /// refusing it would lock that club out of every other setting on the page.
        /// </summary>
        [SkippableTheory]
        [InlineData("actionGlyphs", "marks")]
        [InlineData("action_glyphs", "thumbs")]
        [InlineData("actionGlyphs", "hieroglyphs")]
        [InlineData("action_glyphs", "")]
        public async Task The_retired_glyph_set_is_not_served_and_a_save_carrying_it_is_ignored(string field, string value)
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory, """{"action_glyphs":"marks"}""");
            var client = AdminClient(factory, seeded);

            Assert.False((await client.GetFromJsonAsync<JsonElement>(SettingsPath)).TryGetProperty("action_glyphs", out _));
            Assert.False((await client.GetFromJsonAsync<JsonElement>(ProfilePath)).TryGetProperty("action_glyphs", out _));

            var body = Baseline();
            body[field] = value;
            Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync(SettingsPath, body)).StatusCode);

            // Ignored, not written: the stored document still holds what it held before the save.
            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var stored = JsonNode.Parse((await db.TenantSettings.IgnoreQueryFilters()
                .SingleAsync(t => t.TenantId == seeded.TenantId)).SettingsJson)!;
            Assert.Equal("marks", stored["action_glyphs"]!.GetValue<string>());
            Assert.False((await client.GetFromJsonAsync<JsonElement>(SettingsPath)).TryGetProperty("action_glyphs", out _));
        }
    }
}
