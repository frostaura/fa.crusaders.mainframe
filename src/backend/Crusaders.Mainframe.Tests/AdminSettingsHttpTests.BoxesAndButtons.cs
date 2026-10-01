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
    /// <summary>The court boxes' numbers, the club's button map and the cue window.</summary>
    public sealed class BoxesAndButtons(PostgresFixture pg) : AdminSettingsHttpTests(pg), IClassFixture<PostgresFixture>
    {
        [SkippableFact]
        public async Task The_settings_response_carries_the_default_button_map()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory);
            var client = AdminClient(factory, seeded);

            var shown = await client.GetFromJsonAsync<JsonElement>(SettingsPath);
            var wire = shown.GetProperty("button_map").EnumerateArray().Select(e => e.GetString() ?? string.Empty).ToArray();

            Assert.Equal(ButtonMap.Default().ToWire(), wire);
        }

        [SkippableFact]
        public async Task A_button_map_survives_a_save_that_does_not_mention_it()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var custom = """{"button_map":["court:D","court:C","court:B","court:A","minutes:20","minutes:40","off","none"]}""";
            var seeded = await SeedAsync(factory, custom);
            var client = AdminClient(factory, seeded);

            // A screen that does not yet edit the button map saving the fields it does edit.
            // Omitted must mean unchanged, not "reset to default" — otherwise the first save
            // from the booking-settings page silently undoes the button-map page.
            var save = await client.PutAsJsonAsync(SettingsPath, new
            {
                sliceMinutes = 15,
                slicePriceCredits = 8,
                advanceBookingDays = 14,
                dayStartMinute = 360,
                dayEndMinute = 1320,
                penaltyPct = 30m,
                graceWindowMinutes = 5,
                penaltyWindowMinutes = 15,
            });
            Assert.Equal(HttpStatusCode.OK, save.StatusCode);

            using var scope = factory.Services.CreateScope();
            var tenantContext = scope.ServiceProvider.GetRequiredService<Api.Multitenancy.ITenantContext>();
            tenantContext.Set(seeded.TenantId, seeded.Slug);
            var after = await scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>().GetAsync(default);

            Assert.Equal("court:D", after.Buttons.ToWire()[0]);
            Assert.Equal("none", after.Buttons.ToWire()[7]);
        }

        [SkippableFact]
        public async Task An_invalid_button_map_is_refused_with_the_button_named()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory);
            var client = AdminClient(factory, seeded);

            var save = await client.PutAsJsonAsync(SettingsPath, new
            {
                sliceMinutes = 15,
                slicePriceCredits = 8,
                advanceBookingDays = 14,
                dayStartMinute = 360,
                dayEndMinute = 1320,
                penaltyPct = 30m,
                graceWindowMinutes = 5,
                penaltyWindowMinutes = 15,
                buttonMap = new[] { "court:A", "court:B", "court:Z", "court:D", "minutes:15", "minutes:30", "minutes:45", "minutes:60" },
            });

            Assert.Equal(HttpStatusCode.BadRequest, save.StatusCode);
            var body = await save.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("button_map_invalid", body.GetProperty("error").GetString());
            Assert.Contains("button 3", body.GetProperty("message").GetString());

            // And nothing was written: a refused save must not have applied the other fields.
            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var row = await db.TenantSettings.IgnoreQueryFilters().FirstAsync(s => s.TenantId == seeded.TenantId);
            Assert.Equal("{}", row.SettingsJson);
        }

        /// <summary>
        /// The button map is checked against every court box before it is saved. A box that
        /// drives two courts cannot honour <c>court:C</c>, and the refusal names the box so the
        /// admin knows which one — or which screen — to change.
        /// </summary>
        [SkippableFact]
        public async Task A_button_map_that_selects_a_court_a_box_does_not_drive_is_refused_naming_the_box()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory);
            var client = AdminClient(factory, seeded);

            using (var scope = factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
                db.Devices.AddRange(
                    new Device { TenantId = seeded.TenantId, DeviceCode = "court-box-1", Name = "Four courts", CourtNumbers = [1, 2, 3, 4], MacAddress = "aa0000000001" },
                    new Device { TenantId = seeded.TenantId, DeviceCode = "court-box-2", Name = "Two courts", CourtNumbers = [5, 6], MacAddress = "aa0000000002" },
                    // Revoked: decommissioned, and must not veto a map it will never receive.
                    new Device { TenantId = seeded.TenantId, DeviceCode = "court-box-old", Name = "Gone", CourtNumbers = [7], MacAddress = "aa0000000003", Enabled = false });
                await db.SaveChangesAsync();
            }

            var body = Baseline();
            body["buttonMap"] = new[] { "court:A", "court:B", "court:C", "none", "minutes:15", "minutes:30", "minutes:45", "minutes:60" };
            var save = await client.PutAsJsonAsync(SettingsPath, body);

            Assert.Equal(HttpStatusCode.BadRequest, save.StatusCode);
            var json = await save.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal(ButtonMap.SelectsCourtBeyondDeviceCourts, json.GetProperty("error").GetString());
            Assert.Equal("court-box-2", json.GetProperty("device_code").GetString());
            Assert.Equal(2, json.GetProperty("court_index").GetInt32());
            Assert.Equal(2, json.GetProperty("device_court_count").GetInt32());

            // A map both live boxes can honour is saved; the revoked one-court box is not consulted.
            body["buttonMap"] = new[] { "court:A", "court:B", "none", "none", "minutes:15", "minutes:30", "minutes:45", "minutes:60" };
            Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync(SettingsPath, body)).StatusCode);

            var engine = await EngineAsync(factory, seeded);
            Assert.Equal(["court:A", "court:B", "none", "none", "minutes:15", "minutes:30", "minutes:45", "minutes:60"], engine.Buttons.ToWire());
        }

        /// <summary>
        /// A box with its own button map is not consulted when the club's map is saved: that
        /// is what lets a four-court box and a one-court annex coexist (closing re-review
        /// #17). The invariant is per box — the annex is held to ITS map, the main box to the
        /// club's — and the club's map is refused only for a box that would actually run it.
        /// </summary>
        [SkippableFact]
        public async Task A_box_with_its_own_button_map_does_not_veto_the_clubs_map()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory);
            var client = AdminClient(factory, seeded);

            Assert.True(ButtonMap.TryParse(["court:A", "none", "none", "none", "minutes:15", "minutes:30", "minutes:45", "minutes:60"], out var annexMap, out _));
            using (var scope = factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
                db.Devices.AddRange(
                    new Device { TenantId = seeded.TenantId, DeviceCode = "court-box-1", Name = "Four courts", CourtNumbers = [1, 2, 3, 4], MacAddress = "bb0000000001" },
                    new Device { TenantId = seeded.TenantId, DeviceCode = "annex", Name = "One court, own map", CourtNumbers = [5], MacAddress = "bb0000000002", ButtonMapJson = annexMap!.ToJson() });
                await db.SaveChangesAsync();
            }

            // The club keeps all four court buttons: the annex runs its own map and is not consulted.
            var body = Baseline();
            body["buttonMap"] = new[] { "court:A", "court:B", "court:C", "court:D", "minutes:15", "minutes:30", "minutes:45", "minutes:60" };
            Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync(SettingsPath, body)).StatusCode);

            // A box running the club's map still vetoes a map it cannot honour.
            using (var scope = factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
                db.Devices.Add(new Device { TenantId = seeded.TenantId, DeviceCode = "court-box-2", Name = "Two courts, club map", CourtNumbers = [6, 7], MacAddress = "bb0000000003" });
                await db.SaveChangesAsync();
            }
            var refused = await client.PutAsJsonAsync(SettingsPath, body);
            Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
            Assert.Equal("court-box-2", (await refused.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("device_code").GetString());
        }

        /// <summary>
        /// The GET shows the engine's defaults for all six, the PUT writes what it is sent and
        /// leaves the rest alone, and the engine reads back what was written.
        /// </summary>
        [SkippableFact]
        public async Task The_device_numbers_are_readable_and_writable_and_omitted_means_unchanged()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory);
            var client = AdminClient(factory, seeded);

            var shown = await client.GetFromJsonAsync<JsonElement>(SettingsPath);
            Assert.Equal(TenantSettingsView.DefaultWalkUpMaxMinutes, shown.GetProperty("walk_up_max_minutes").GetInt32());
            Assert.Equal(TenantSettingsView.DefaultHeartbeatSeconds, shown.GetProperty("heartbeat_seconds").GetInt32());
            Assert.Equal(TenantSettingsView.DefaultActivationForwardWindowMinutes, shown.GetProperty("activation_forward_window_minutes").GetInt32());
            Assert.Equal(TenantSettingsView.DefaultActivationCueWindowMinutes, shown.GetProperty("activation_cue_window_minutes").GetInt32());
            Assert.Equal(TenantSettingsView.DefaultQrLifetimeSeconds, shown.GetProperty("qr_lifetime_seconds").GetInt32());
            Assert.Equal(TenantSettingsView.DefaultRosterWindowMinutes, shown.GetProperty("roster_window_minutes").GetInt32());

            var body = Baseline();
            body["heartbeatSeconds"] = 45;
            body["qrLifetimeSeconds"] = 90;
            body["rosterWindowMinutes"] = 240;
            body["walkUpMaxMinutes"] = 60;
            var save = await client.PutAsJsonAsync(SettingsPath, body);
            Assert.Equal(HttpStatusCode.OK, save.StatusCode);

            var after = await EngineAsync(factory, seeded);
            Assert.Equal(45, after.HeartbeatSeconds);
            Assert.Equal(90, after.QrLifetimeSeconds);
            Assert.Equal(240, after.RosterWindowMinutes);
            Assert.Equal(60, after.WalkUpMaxMinutes);

            // Omitted means unchanged, never reset.
            Assert.Equal(TenantSettingsView.DefaultActivationForwardWindowMinutes, after.ActivationForwardWindowMinutes);
            Assert.Equal(TenantSettingsView.DefaultActivationCueWindowMinutes, after.ActivationCueWindowMinutes);

            var again = await client.GetFromJsonAsync<JsonElement>(SettingsPath);
            Assert.Equal(45, again.GetProperty("heartbeat_seconds").GetInt32());
            Assert.Equal(240, again.GetProperty("roster_window_minutes").GetInt32());
        }

        [SkippableTheory]
        [InlineData("walkUpMaxMinutes", 0, "walk_up_max_minutes_out_of_range")]
        [InlineData("walkUpMaxMinutes", 91, "walk_up_max_minutes_out_of_range")]      // the relay bank's hard cap
        [InlineData("heartbeatSeconds", 5, "heartbeat_seconds_out_of_range")]
        // The firmware clamps into [15, 300]. The API used to accept up to 3600 and the page
        // said so, so an admin could set 600, read 600 back, and have the whole fleet run at
        // 300 with nothing anywhere saying otherwise (round-3 finding 22).
        [InlineData("heartbeatSeconds", 14, "heartbeat_seconds_out_of_range")]
        [InlineData("heartbeatSeconds", 301, "heartbeat_seconds_out_of_range")]
        [InlineData("heartbeatSeconds", 600, "heartbeat_seconds_out_of_range")]
        [InlineData("heartbeatSeconds", 3600, "heartbeat_seconds_out_of_range")]
        [InlineData("activationForwardWindowMinutes", 0, "activation_forward_window_minutes_out_of_range")]
        [InlineData("activationCueWindowMinutes", -1, "activation_cue_window_minutes_out_of_range")]
        [InlineData("qrLifetimeSeconds", 10, "qr_lifetime_seconds_out_of_range")]
        [InlineData("rosterWindowMinutes", 2000, "roster_window_minutes_out_of_range")]
        public async Task A_device_number_outside_its_bounds_is_refused(string field, int value, string expected)
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory);
            var client = AdminClient(factory, seeded);

            var body = Baseline();
            body[field] = value;
            var save = await client.PutAsJsonAsync(SettingsPath, body);

            Assert.Equal(HttpStatusCode.BadRequest, save.StatusCode);
            var json = await save.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal(expected, json.GetProperty("error").GetString());
        }

        /// <summary>
        /// The cue window must fit inside the forward window — and the check is against the
        /// values that will be in effect, so sending either one alone is judged against the
        /// stored (or default) other, not against nothing.
        /// </summary>
        [SkippableFact]
        public async Task A_cue_window_wider_than_the_forward_window_is_refused_however_it_arrives()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory);
            var client = AdminClient(factory, seeded);

            async Task<HttpStatusCode> PutAsync(int? cue, int? forward)
            {
                var body = Baseline();
                if (cue is not null) body["activationCueWindowMinutes"] = cue;
                if (forward is not null) body["activationForwardWindowMinutes"] = forward;
                var save = await client.PutAsJsonAsync(SettingsPath, body);
                if (save.StatusCode == HttpStatusCode.BadRequest)
                {
                    var json = await save.Content.ReadFromJsonAsync<JsonElement>();
                    Assert.Equal("activation_cue_window_exceeds_forward_window", json.GetProperty("error").GetString());
                }
                return save.StatusCode;
            }

            // Both together, inverted.
            Assert.Equal(HttpStatusCode.BadRequest, await PutAsync(cue: 30, forward: 20));

            // Cue alone, wider than the default forward (120).
            Assert.Equal(HttpStatusCode.BadRequest, await PutAsync(cue: 121, forward: null));

            // Forward stored at 60; then cue alone at 61 must be judged against the STORED 60,
            // not the default 120 — that is what "effective value" means.
            Assert.Equal(HttpStatusCode.OK, await PutAsync(cue: null, forward: 60));
            Assert.Equal(HttpStatusCode.BadRequest, await PutAsync(cue: 61, forward: null));
            Assert.Equal(HttpStatusCode.OK, await PutAsync(cue: 60, forward: null));

            // And forward alone, below the stored cue of 60.
            Assert.Equal(HttpStatusCode.BadRequest, await PutAsync(cue: null, forward: 59));

            var engine = await EngineAsync(factory, seeded);
            Assert.Equal(60, engine.ActivationCueWindowMinutes);
            Assert.Equal(60, engine.ActivationForwardWindowMinutes);
        }

        /// <summary>
        /// <c>device_alert_cooldown_minutes</c>: both spellings bind, it round-trips through the
        /// GET, omitting it leaves it alone, and the GET answers it whether or not the club has
        /// ever set one.
        ///
        /// <para>
        /// The always-present half is not decoration. The console's settings type requires this
        /// key and carries no client-side default, so a conditional projection would be a page
        /// that cannot render rather than a page that falls back — and the settings screen is
        /// where a club goes when its boards are already misbehaving.
        /// </para>
        /// </summary>
        [SkippableTheory]
        [InlineData("deviceAlertCooldownMinutes")]
        [InlineData("device_alert_cooldown_minutes")]
        public async Task The_alert_cooldown_binds_under_either_spelling_and_is_always_served(string field)
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory);
            var client = AdminClient(factory, seeded);

            // Served before anybody has set one, at the documented default.
            var before = await client.GetFromJsonAsync<JsonElement>(SettingsPath);
            Assert.Equal(
                TenantSettingsView.DefaultDeviceAlertCooldownMinutes,
                before.GetProperty("device_alert_cooldown_minutes").GetInt32());

            var body = Baseline();
            body[field] = 15;
            Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync(SettingsPath, body)).StatusCode);

            Assert.Equal(15, (await EngineAsync(factory, seeded)).DeviceAlertCooldownMinutes);
            Assert.Equal(15, (await client.GetFromJsonAsync<JsonElement>(SettingsPath))
                .GetProperty("device_alert_cooldown_minutes").GetInt32());

            // Omitted means unchanged, like every other optional key on this endpoint.
            Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync(SettingsPath, Baseline())).StatusCode);
            Assert.Equal(15, (await EngineAsync(factory, seeded)).DeviceAlertCooldownMinutes);
        }
    }
}
