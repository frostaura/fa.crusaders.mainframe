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
    /// <summary>The door-gate settings: numbers, spellings and the closed set of access policies.</summary>
    public sealed class Doors(PostgresFixture pg) : AdminSettingsHttpTests(pg), IClassFixture<PostgresFixture>
    {
        // ---- The three door-gate settings ---------------------------------------

        /// <summary>
        /// The GET shows the engine's defaults, the PUT writes what it is sent and leaves the
        /// rest alone, and the engine reads back what was written — the same round trip the six
        /// device numbers get, for the three numbers that decide who gets into the building.
        /// </summary>
        [SkippableFact]
        public async Task The_gate_settings_are_readable_and_writable_and_omitted_means_unchanged()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory);
            var client = AdminClient(factory, seeded);

            var shown = await client.GetFromJsonAsync<JsonElement>(SettingsPath);
            Assert.Equal(TenantSettingsView.DefaultGateUnlockSeconds, shown.GetProperty("gate_unlock_seconds").GetInt32());
            Assert.Equal(TenantSettingsView.DefaultGateAccessPolicy, shown.GetProperty("gate_access_policy").GetString());
            Assert.Equal(TenantSettingsView.DefaultGateEarlyEntryMinutes, shown.GetProperty("gate_early_entry_minutes").GetInt32());

            var body = Baseline();
            body["gateUnlockSeconds"] = 7;
            body["gateAccessPolicy"] = "booking_window";
            var save = await client.PutAsJsonAsync(SettingsPath, body);
            Assert.Equal(HttpStatusCode.OK, save.StatusCode);

            var after = await EngineAsync(factory, seeded);
            Assert.Equal(7, after.GateUnlockSeconds);
            Assert.Equal("booking_window", after.GateAccessPolicy);

            // Omitted means unchanged, never reset — the gate block and the booking form are
            // different screens.
            Assert.Equal(TenantSettingsView.DefaultGateEarlyEntryMinutes, after.GateEarlyEntryMinutes);

            var again = await client.GetFromJsonAsync<JsonElement>(SettingsPath);
            Assert.Equal(7, again.GetProperty("gate_unlock_seconds").GetInt32());
            Assert.Equal("booking_window", again.GetProperty("gate_access_policy").GetString());
        }

        /// <summary>
        /// <b>Both spellings bind.</b> This endpoint answers snake_case and binds camelCase, and
        /// the cost of a client picking the wrong one is not an error — it is <c>null</c>, which
        /// this endpoint reads as "omitted, leave unchanged", so the save returns
        /// <c>{"saved": true}</c> and changes nothing. That is the silent write
        /// <see cref="Opening_the_settings_page_and_saving_it_changes_nothing"/> exists to
        /// prevent, and for a door it is worth removing rather than documenting.
        /// </summary>
        [SkippableTheory]
        [InlineData("gateUnlockSeconds", "gateAccessPolicy", "gateEarlyEntryMinutes")]
        [InlineData("gate_unlock_seconds", "gate_access_policy", "gate_early_entry_minutes")]
        public async Task A_gate_setting_binds_under_either_spelling(string unlock, string policy, string early)
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory);
            var client = AdminClient(factory, seeded);

            var body = Baseline();
            body[unlock] = 11;
            body[policy] = "booking_window";
            body[early] = 90;
            Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync(SettingsPath, body)).StatusCode);

            var after = await EngineAsync(factory, seeded);
            Assert.Equal(11, after.GateUnlockSeconds);
            Assert.Equal("booking_window", after.GateAccessPolicy);
            Assert.Equal(90, after.GateEarlyEntryMinutes);
        }

        /// <summary>
        /// The bounds. The unlock range is <c>GateAccess</c>'s own clamp, named once so the
        /// number an admin is refused at and the number the door is held open for cannot drift;
        /// the policy is refused rather than coerced, which is what lets the READ side treat an
        /// unrecognised stored value as corruption and narrow the door in response.
        /// </summary>
        [SkippableTheory]
        [InlineData("gateUnlockSeconds", 0, "gate_unlock_seconds_out_of_range")]
        [InlineData("gateUnlockSeconds", -1, "gate_unlock_seconds_out_of_range")]
        [InlineData("gateUnlockSeconds", 31, "gate_unlock_seconds_out_of_range")]
        [InlineData("gateUnlockSeconds", 86400, "gate_unlock_seconds_out_of_range")]
        [InlineData("gateEarlyEntryMinutes", -1, "gate_early_entry_minutes_out_of_range")]
        [InlineData("gateEarlyEntryMinutes", 241, "gate_early_entry_minutes_out_of_range")]
        [InlineData("deviceAlertCooldownMinutes", 4, "device_alert_cooldown_minutes_out_of_range")]
        [InlineData("deviceAlertCooldownMinutes", 0, "device_alert_cooldown_minutes_out_of_range")]
        [InlineData("deviceAlertCooldownMinutes", -1, "device_alert_cooldown_minutes_out_of_range")]
        [InlineData("deviceAlertCooldownMinutes", 1441, "device_alert_cooldown_minutes_out_of_range")]
        [InlineData("device_alert_cooldown_minutes", 1441, "device_alert_cooldown_minutes_out_of_range")]
        public async Task A_gate_number_outside_its_bounds_is_refused(string field, int value, string expected)
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory);
            var client = AdminClient(factory, seeded);

            var body = Baseline();
            body[field] = value;
            var save = await client.PutAsJsonAsync(SettingsPath, body);

            Assert.Equal(HttpStatusCode.BadRequest, save.StatusCode);
            Assert.Equal(expected, (await save.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());
        }

        /// <summary>
        /// The access policy is a closed set of two, matched exactly. Refused rather than
        /// coerced, and the refusal is <c>gate_access_policy_invalid</c> — the shape
        /// <c>button_map_invalid</c> already uses for a value this endpoint will not take.
        /// </summary>
        [SkippableTheory]
        [InlineData("everyone")]
        [InlineData("")]
        [InlineData("Active_Member")]
        [InlineData("ACTIVE_MEMBER")]
        [InlineData("active member")]
        [InlineData("booking-window")]
        public async Task An_access_policy_outside_the_closed_set_is_refused(string policy)
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory);
            var client = AdminClient(factory, seeded);

            var body = Baseline();
            body["gateAccessPolicy"] = policy;
            var save = await client.PutAsJsonAsync(SettingsPath, body);

            Assert.Equal(HttpStatusCode.BadRequest, save.StatusCode);
            Assert.Equal("gate_access_policy_invalid",
                (await save.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());

            // And a refused save wrote nothing at all, including the fields that were valid.
            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var row = await db.TenantSettings.IgnoreQueryFilters().FirstAsync(s => s.TenantId == seeded.TenantId);
            Assert.Equal("{}", row.SettingsJson);
        }

        /// <summary>Both policies are accepted, and surrounding whitespace is trimmed rather than refused.</summary>
        [SkippableTheory]
        [InlineData("active_member", "active_member")]
        [InlineData("booking_window", "booking_window")]
        [InlineData("  booking_window  ", "booking_window")]
        public async Task Both_access_policies_are_accepted(string sent, string stored)
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory);
            var client = AdminClient(factory, seeded);

            var body = Baseline();
            body["gateAccessPolicy"] = sent;
            Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync(SettingsPath, body)).StatusCode);
            Assert.Equal(stored, (await EngineAsync(factory, seeded)).GateAccessPolicy);
        }

        /// <summary>
        /// The door release default moved 3 -> 15 (GOAL item 2), and the page must show the number
        /// the door will actually run — not the one it used to.
        /// </summary>
        [SkippableFact]
        public async Task The_settings_page_shows_a_fifteen_second_door_release_by_default()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory);
            var client = AdminClient(factory, seeded);

            var shown = await client.GetFromJsonAsync<JsonElement>(SettingsPath);
            Assert.Equal(15, shown.GetProperty("gate_unlock_seconds").GetInt32());
        }
    }
}
