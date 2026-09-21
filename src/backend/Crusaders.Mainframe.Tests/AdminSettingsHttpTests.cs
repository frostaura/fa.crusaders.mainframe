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
            ["slicePriceCredits"] = shown.GetProperty("slice_price_credits").GetDecimal(),
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
                ["slicePriceCredits"] = 8m,
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

    /// <summary>
    /// GOAL item 12 / ruling 4: which glyph pair a confirm/decline button wears. Thumbs by
    /// default — the founder asked for them by name and the club is South African, where a
    /// thumbs-up reads as plain agreement.
    /// </summary>
    [SkippableTheory]
    [InlineData("actionGlyphs")]
    [InlineData("action_glyphs")]
    public async Task The_glyph_set_is_served_and_binds_under_either_spelling(string field)
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = AdminClient(factory, seeded);

        Assert.Equal("thumbs",
            (await client.GetFromJsonAsync<JsonElement>(SettingsPath)).GetProperty("action_glyphs").GetString());

        var body = Baseline();
        body[field] = "marks";
        Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync(SettingsPath, body)).StatusCode);

        Assert.Equal("marks",
            (await client.GetFromJsonAsync<JsonElement>(SettingsPath)).GetProperty("action_glyphs").GetString());

        // Omitted means unchanged.
        Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync(SettingsPath, Baseline())).StatusCode);
        Assert.Equal("marks",
            (await client.GetFromJsonAsync<JsonElement>(SettingsPath)).GetProperty("action_glyphs").GetString());
    }

    /// <summary>
    /// Refused rather than coerced, which is what lets the GET render the RESOLVED value
    /// honestly — the same posture gate_access_policy takes.
    /// </summary>
    [SkippableTheory]
    [InlineData("Thumbs")]
    [InlineData("emoji")]
    [InlineData("")]
    public async Task A_glyph_set_outside_the_closed_pair_is_refused(string value)
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = AdminClient(factory, seeded);

        var body = Baseline();
        body["actionGlyphs"] = value;
        var save = await client.PutAsJsonAsync(SettingsPath, body);

        Assert.Equal(HttpStatusCode.BadRequest, save.StatusCode);
        Assert.Equal("action_glyphs_invalid",
            (await save.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());
    }

    /// <summary>
    /// And a hand-edited nonsense value falls back to thumbs rather than to a button nobody can
    /// draw — unlike a door policy, this decides an ICON, so failing closed would cost a club a
    /// screen it cannot use for no safety gained.
    /// </summary>
    [SkippableFact]
    public async Task A_hand_edited_glyph_set_falls_back_rather_than_breaking_the_button()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory, """{"action_glyphs":"hieroglyphs"}""");
        var client = AdminClient(factory, seeded);

        Assert.Equal("thumbs",
            (await client.GetFromJsonAsync<JsonElement>(SettingsPath)).GetProperty("action_glyphs").GetString());
    }
}
