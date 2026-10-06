using System.IdentityModel.Tokens.Jwt;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// A real club as the demo-mode tests need it: settings a club actually runs (a timezone, opening
/// hours, slices, a penalty), four courts, an admin with a membership, a member, and a little real
/// money and a booking — the rows a demo must never touch.
/// </summary>
public sealed class DemoClub
{
    public required PeopleClub Club { get; init; }
    public required Guid AdminId { get; init; }
    public required Guid MemberId { get; init; }

    public const string Settings = """
    {
      "slice_minutes": 15, "penalty_pct": 30.0, "grace_window_minutes": 5, "penalty_window_minutes": 15,
      "advance_booking_days": 14, "member_per_day_max_minutes": 60, "peak_hours": "16:00-19:00",
      "operating_hours": { "mon": "06:00-22:00", "tue": "06:00-22:00", "wed": "06:00-22:00", "thu": "06:00-22:00",
                           "fri": "06:00-22:00", "sat": "07:00-20:00", "sun": "07:00-20:00" },
      "timezone": "Africa/Johannesburg", "currency_symbol": "R",
      "payfast": { "merchant_id": "10000100", "merchant_key": "46f0cd694581a", "passphrase": "x", "environment": "test" }
    }
    """;

    public static async Task<DemoClub> SeedAsync(WebApplicationFactory<Program> app, string prefix)
    {
        var club = await PeopleClub.SeedAsync(app, prefix);
        var admin = await club.AddAsync(app, "Ada Admin", isAdmin: true);
        var member = await club.AddAsync(app, "Mo Member", isAdmin: false);

        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var settings = await db.TenantSettings.IgnoreQueryFilters().FirstAsync(s => s.TenantId == club.TenantId);
        settings.SettingsJson = Settings;
        var courts = Enumerable.Range(1, 4).Select(n => new Court { TenantId = club.TenantId, CourtNumber = n, Name = $"Court {n}" }).ToList();
        db.Courts.AddRange(courts);
        db.LedgerEntries.Add(new LedgerEntry
        {
            TenantId = club.TenantId,
            UserId = member,
            Type = LedgerEntryType.AdminTopUp,
            AmountMinutes = 120,
            ZarPaid = 100m,
            ActorUserId = admin,
            Reason = "real club money",
            ExternalReference = $"adjust:{club.TenantId:N}:real-{Guid.NewGuid():N}",
        });
        var start = DateTimeOffset.UtcNow.AddDays(2).Storable();
        db.Bookings.Add(new Booking
        {
            TenantId = club.TenantId,
            CourtId = courts[0].Id,
            UserId = member,
            ActorUserId = member,
            StartsAt = start,
            EndsAt = start.AddMinutes(30),
            SliceMinutes = 15,
            SliceCount = 2,
            AmountChargedMinutes = 30,
        });
        await db.SaveChangesAsync();
        return new DemoClub { Club = club, AdminId = admin, MemberId = member };
    }

    public HttpClient Admin(WebApplicationFactory<Program> app) => Club.Client(app, AdminId, adminRole: true);

    public static HttpClient Bearer(WebApplicationFactory<Program> app, string token)
    {
        var client = app.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return client;
    }

    /// <summary>Switches the given client's session to <paramref name="mode"/>; answers the reply's body.</summary>
    public static async Task<JsonElement> SwitchAsync(HttpClient client, string mode)
    {
        var response = await client.PostAsJsonAsync("/api/v1/admin/mode", new { mode });
        var text = await response.Content.ReadAsStringAsync();
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException($"switch to {mode}: {(int)response.StatusCode} {text}");
        return JsonDocument.Parse(text).RootElement;
    }

    public static string SlugOf(string token) =>
        new JwtSecurityTokenHandler().ReadJwtToken(token).Claims.First(c => c.Type == "tenant_slug").Value;

    public static Guid SubjectOf(string token) =>
        Guid.Parse(new JwtSecurityTokenHandler().ReadJwtToken(token).Subject);

    public Task<Tenant> DemoAsync(WebApplicationFactory<Program> app) =>
        PeopleClub.ReadAsync(app, db => db.Tenants.AsNoTracking().FirstAsync(t => t.DemoOfTenantId == Club.TenantId));
}
