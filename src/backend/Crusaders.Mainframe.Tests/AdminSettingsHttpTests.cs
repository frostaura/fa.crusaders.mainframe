using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.Tokens;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The admin settings surface over real HTTP.
///
/// <para>
/// The test that matters most here is <see cref="Opening_the_settings_page_and_saving_it_changes_nothing"/>.
/// A settings screen reads a value, shows it to a person, and PUTs back whatever it was
/// shown — so any default the GET invents that the engine does not share is not a cosmetic
/// difference, it is a silent write. This endpoint answered 30 minutes and 50 credits where
/// <see cref="TenantSettingsAccessor"/> used 15 and 8, which meant that on a tenant with no
/// explicit values, opening the page and pressing save doubled every slice and repriced
/// every court. Nothing failed, nothing logged, and the club would have found out from a
/// member's bill.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class AdminSettingsHttpTests
{
    private readonly PostgresFixture _pg;

    public AdminSettingsHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Secret = "test-only-signing-key-not-used-in-any-real-environment";
    private const string SettingsPath = "/api/v1/admin/settings/";

    private sealed record Seeded(Guid TenantId, string Slug, Guid AdminUserId);

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    /// <summary>
    /// A tenant with a settings row that is deliberately EMPTY. That is the condition the
    /// defect lived in: every value falls through to a default, so the two default sets
    /// disagreeing is the whole of the behaviour.
    /// </summary>
    private static async Task<Seeded> SeedAsync(TestWebAppFactory factory, string settingsJson = "{}")
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var slug = $"cfg-{Guid.NewGuid():N}"[..20];
        var tenant = new Tenant { Slug = slug, DisplayName = "Config Club" };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings { TenantId = tenant.Id, SettingsJson = settingsJson });

        var admin = new User
        {
            TenantId = tenant.Id,
            Email = $"{slug}@test.local",
            PasswordHash = "x",
            EmailVerified = true,
            IsAdmin = true,
        };
        db.Users.Add(admin);
        db.Memberships.Add(new Membership
        {
            TenantId = tenant.Id,
            UserId = admin.Id,
            FullName = "Config Admin",
            MembershipNumber = slug,
            Status = MembershipStatus.Active,
            MemberClass = MemberClass.Regular,
        });

        await db.SaveChangesAsync();
        return new Seeded(tenant.Id, slug, admin.Id);
    }

    private static string AdminToken(Seeded s)
    {
        var token = new JwtSecurityToken(
            issuer: "crusaders.mainframe",
            audience: "crusaders.mainframe.app",
            claims:
            [
                new Claim(JwtRegisteredClaimNames.Sub, s.AdminUserId.ToString()),
                new Claim("tenant_id", s.TenantId.ToString()),
                new Claim("tenant_slug", s.Slug),
                new Claim("purpose", "access"),
                new Claim(ClaimTypes.Role, "admin"),
            ],
            notBefore: DateTime.UtcNow,
            expires: DateTime.UtcNow.AddMinutes(10),
            signingCredentials: new SigningCredentials(
                new SymmetricSecurityKey(Encoding.UTF8.GetBytes(Secret)), SecurityAlgorithms.HmacSha256));

        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    private static HttpClient AdminClient(TestWebAppFactory factory, Seeded s)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", AdminToken(s));
        return client;
    }

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
            Assert.Equal(engine.DefaultSlicePriceCredits, shown.GetProperty("slice_price_credits").GetDecimal());
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
            slicePriceCredits = shown.GetProperty("slice_price_credits").GetDecimal(),
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
            Assert.Equal(8m, after.DefaultSlicePriceCredits);
        }
    }

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
            slicePriceCredits = 8m,
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
        Assert.Equal(2.4m, shown.GetProperty("credits_per_zar_league").GetDecimal());
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
            creditsPerZarLeague = 2.8m,
            peakHours = "17:00-20:00",
            memberPerDayMaxMinutes = 90,
        });
        Assert.Equal(HttpStatusCode.OK, save.StatusCode);

        using var scope = factory.Services.CreateScope();
        var tenantContext = scope.ServiceProvider.GetRequiredService<Api.Multitenancy.ITenantContext>();
        tenantContext.Set(seeded.TenantId, seeded.Slug);
        var after = await scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>().GetAsync(default);

        Assert.Equal(2.8m, after.CreditsPerZarLeague);
        Assert.Equal("17:00-20:00", after.PeakHoursRange);
        Assert.Equal(90, after.MemberPerDayMaxMinutes);

        // Omitted means unchanged. The booking-settings form and the economics form are
        // different screens; a save from one must not revert the other.
        Assert.Equal(1.6m, after.CreditsPerZarRegular);
        Assert.Equal(2, after.RetentionYears);
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

    /// <summary>
    /// The timezone is writable, and it is the zone the schedule actually renders in.
    ///
    /// <para>
    /// It was served by GET and had no member on <c>UpdateSettingsRequest</c>, so the PUT
    /// could not carry one: a second club in another zone saw its whole booking grid in
    /// South African wall-clock time, with no correction short of an UPDATE on the
    /// <c>tenant_settings</c> JSON column. "Multi-tenancy is structural from day one" and a
    /// tenant-scoped setting that only the database can change are not compatible.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task The_timezone_is_writable_and_reaches_the_engine()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory, """{"timezone":"Africa/Johannesburg"}""");
        var client = AdminClient(factory, seeded);

        var save = await client.PutAsJsonAsync(SettingsPath, BaseSettings(tz: "Europe/London"));
        Assert.Equal(HttpStatusCode.OK, save.StatusCode);

        var read = await (await client.GetAsync(SettingsPath)).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("Europe/London", read.GetProperty("timezone").GetString());

        using var scope = factory.Services.CreateScope();
        var tenantContext = scope.ServiceProvider.GetRequiredService<Api.Multitenancy.ITenantContext>();
        tenantContext.Set(seeded.TenantId, seeded.Slug);
        Assert.Equal("Europe/London", (await scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>().GetAsync(default)).Timezone);
    }

    [SkippableTheory]
    [InlineData("Mars/Olympus_Mons")]
    [InlineData("")]
    [InlineData("   ")]
    public async Task A_timezone_the_tzdb_does_not_know_is_refused(string tz)
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory, """{"timezone":"Africa/Johannesburg"}""");
        var client = AdminClient(factory, seeded);

        var save = await client.PutAsJsonAsync(SettingsPath, BaseSettings(tz: tz));
        Assert.Equal(HttpStatusCode.BadRequest, save.StatusCode);
        Assert.Equal("timezone_invalid", (await save.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());

        // And nothing was written: a refused save must not half-apply.
        var read = await (await client.GetAsync(SettingsPath)).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("Africa/Johannesburg", read.GetProperty("timezone").GetString());
    }

    /// <summary>The eight required booking fields at their fixture values, plus an optional timezone.</summary>
    private static Dictionary<string, object> BaseSettings(string? tz = null)
    {
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
        };
        if (tz is not null) payload["timezone"] = tz;
        return payload;
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

    [SkippableTheory]
    [InlineData("19:00-16:00")]
    [InlineData("16:00")]
    [InlineData("not a time-range")]
    public async Task A_malformed_peak_window_is_refused(string range)
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = AdminClient(factory, seeded);

        // TenantSettingsAccessor.PeakHours() returns null on a malformed range and the
        // booking rule then silently stops applying — league exclusivity would just
        // quietly not happen, which nobody would notice until a member complained.
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
            peakHours = range,
        });

        Assert.Equal(HttpStatusCode.BadRequest, save.StatusCode);
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
            slicePriceCredits = 8m,
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

    // ---- The six court-box and identification numbers (WI-2) ----------------

    /// <summary>The booking-settings body every PUT needs, with the device numbers layered on top.</summary>
    private static Dictionary<string, object> Baseline() => new()
    {
        ["sliceMinutes"] = 15,
        ["slicePriceCredits"] = 8m,
        ["advanceBookingDays"] = 14,
        ["dayStartMinute"] = 360,
        ["dayEndMinute"] = 1320,
        ["penaltyPct"] = 30m,
        ["graceWindowMinutes"] = 5,
        ["penaltyWindowMinutes"] = 15,
    };

    private static async Task<TenantSettingsView> EngineAsync(TestWebAppFactory factory, Seeded seeded)
    {
        using var scope = factory.Services.CreateScope();
        scope.ServiceProvider.GetRequiredService<Api.Multitenancy.ITenantContext>().Set(seeded.TenantId, seeded.Slug);
        return await scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>().GetAsync(default);
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

    // ---- the per-weekday opening hours (R2 G-F2) ---------------------------------
    //
    // A club could not change its opening hours at all. The engine reads
    // `operating_hours`, a per-weekday map; this endpoint served only the flat
    // `day_start_minute`/`day_end_minute` pair and had no member for the map, and the
    // seeder names all seven days — so the flat pair was dead for every day of the week.
    // An admin setting "Day starts 09:00" got `200 {"saved":true}` and a success toast,
    // and Monday's grid still ran 06:00-21:45. The setting the product ENFORCES could not
    // be edited by the product.

    [SkippableFact]
    public async Task The_settings_response_carries_the_per_weekday_hours_the_engine_reads()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory, """{"operating_hours":{"sat":"07:00-20:00","mon":"06:00-22:00"}}""");
        var client = AdminClient(factory, seeded);

        var shown = await client.GetFromJsonAsync<JsonElement>(SettingsPath);
        var hours = shown.GetProperty("operating_hours");

        Assert.Equal("06:00-22:00", hours.GetProperty("mon").GetString());
        Assert.Equal("07:00-20:00", hours.GetProperty("sat").GetString());
        // A day the club has not named is absent rather than invented: it follows the flat
        // pair, and showing it as 06:00-22:00 would make the screen claim a Sunday setting
        // that does not exist.
        Assert.False(hours.TryGetProperty("sun", out _));
    }

    /// <summary>
    /// The whole point of the finding: what the settings screen writes has to be what
    /// <see cref="BookingService"/> reads. Asserted through
    /// <see cref="TenantSettingsView.HoursFor"/>, which is the exact call the booking rule
    /// makes — <c>CheckOperatingHoursRule</c> does nothing else.
    /// </summary>
    [SkippableFact]
    public async Task Saving_the_weekday_hours_changes_what_the_booking_rule_enforces()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory, """{"operating_hours":{"sat":"07:00-20:00"}}""");
        var client = AdminClient(factory, seeded);

        var before = await EngineAsync(factory, seeded);
        Assert.Equal((7 * 60, 20 * 60), before.HoursFor(DayOfWeek.Saturday));

        var body = Baseline();
        body["operatingHours"] = new Dictionary<string, string>
        {
            ["sat"] = "08:00-13:00",
            ["sun"] = "09:00-12:00",
        };
        Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync(SettingsPath, body)).StatusCode);

        var after = await EngineAsync(factory, seeded);
        Assert.Equal((8 * 60, 13 * 60), after.HoursFor(DayOfWeek.Saturday));
        Assert.Equal((9 * 60, 12 * 60), after.HoursFor(DayOfWeek.Sunday));
        // A weekday the new map does not name falls back to the flat pair, which is what
        // makes "Day starts / Day ends" an honest default rather than a dead field.
        Assert.Equal((360, 1320), after.HoursFor(DayOfWeek.Monday));

        // And the screen reads back exactly what it wrote.
        var shown = await client.GetFromJsonAsync<JsonElement>(SettingsPath);
        Assert.Equal("08:00-13:00", shown.GetProperty("operating_hours").GetProperty("sat").GetString());
    }

    [SkippableFact]
    public async Task An_empty_weekday_map_puts_every_day_back_on_the_flat_pair()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory, """{"operating_hours":{"sat":"07:00-20:00"}}""");
        var client = AdminClient(factory, seeded);

        var body = Baseline();
        body["operatingHours"] = new Dictionary<string, string>();
        Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync(SettingsPath, body)).StatusCode);

        var after = await EngineAsync(factory, seeded);
        Assert.True(after.OperatingHours.IsEmpty);
        Assert.Equal((360, 1320), after.HoursFor(DayOfWeek.Saturday));
    }

    [SkippableFact]
    public async Task A_weekday_map_survives_a_save_that_does_not_mention_it()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory, """{"operating_hours":{"sat":"07:00-20:00"}}""");
        var client = AdminClient(factory, seeded);

        // The devices screen saving a button map, for instance: omitted means unchanged,
        // never "reset to default".
        Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync(SettingsPath, Baseline())).StatusCode);

        var after = await EngineAsync(factory, seeded);
        Assert.Equal((7 * 60, 20 * 60), after.HoursFor(DayOfWeek.Saturday));
    }

    [SkippableTheory]
    [InlineData("sat", "20:00-07:00")]   // close before open is a typo, not an overnight club
    [InlineData("sat", "not a range")]
    [InlineData("sat", "07:00")]
    [InlineData("caturday", "07:00-20:00")]
    public async Task A_weekday_map_that_cannot_be_read_is_refused_with_the_day_named(string day, string range)
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory, """{"operating_hours":{"sat":"07:00-20:00"}}""");
        var client = AdminClient(factory, seeded);

        var body = Baseline();
        body["operatingHours"] = new Dictionary<string, string> { [day] = range };
        var refused = await client.PutAsJsonAsync(SettingsPath, body);

        Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
        var payload = await refused.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("operating_hours_day_invalid", payload.GetProperty("error").GetString());
        // Which row to fix. "operating hours invalid" on a seven-row form is not an answer.
        Assert.Equal(day.ToLowerInvariant(), payload.GetProperty("day").GetString());

        // And the refusal is whole: nothing was half-written.
        var after = await EngineAsync(factory, seeded);
        Assert.Equal((7 * 60, 20 * 60), after.HoursFor(DayOfWeek.Saturday));
    }
}
