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
}
