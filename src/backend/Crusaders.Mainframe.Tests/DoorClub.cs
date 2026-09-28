using System.IdentityModel.Tokens.Jwt;
using System.Net.Http.Headers;
using System.Security.Claims;
using System.Text;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security.DeviceAuth;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.Tokens;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// A club with doors, an admin and a member — the fixture every Wave 1 doors suite starts
/// from.
///
/// <para>
/// Shared rather than copied into five test classes for the reason
/// <c>memory/decisions-method.md</c> records about parallel lanes: two seeds that drift are
/// two suites that disagree about what a club looks like, and the door surfaces are read
/// across each other (the log reads what the scan wrote, the member's history reads what the
/// admin's log reads). One seed is what makes a cross-surface assertion mean anything.
/// </para>
///
/// <para>
/// Every helper takes the slug prefix, because the whole Postgres-backed tier shares one
/// database: an xUnit collection fixture is created once, not once per test.
/// </para>
/// </summary>
public sealed record DoorClub(
    Guid TenantId, string Slug, string DeviceKey, Guid AdminUserId, Guid MemberUserId, Guid CourtId)
{
    /// <summary>The signing key <c>TestWebAppFactory</c> boots the app with.</summary>
    public const string Secret = "test-only-signing-key-not-used-in-any-real-environment";

    /// <summary>A club that runs doors on the documented defaults, in UTC so a day boundary is testable.</summary>
    public const string DefaultSettings =
        """{"slice_minutes":15,"day_start_minute":0,"day_end_minute":1440,"grace_window_minutes":5,"timezone":"UTC","heartbeat_seconds":45}""";

    /// <summary>
    /// The same defaults, in a club where it is the middle of the afternoon right now.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>For any test that writes a row "a few minutes ago" and asserts it counts toward
    /// TODAY.</b> On a UTC club that sentence is false for the first few minutes of every day:
    /// at 00:02 UTC, <c>now.AddMinutes(-5)</c> is 23:57 YESTERDAY, the row falls outside the
    /// day window the endpoint correctly computes, and the count comes back short. Nothing is
    /// wrong with the product — the fixture is asserting something that is only true for
    /// 99.7% of the day.
    /// </para>
    /// <para>
    /// It cost a red CI run at 00:02 on 2026-09-23 after the identical commit had passed at
    /// 23:42, which is the worst way to learn it: two failures that look like a regression in
    /// code nobody touched. The same shape is recorded for the booking caps in
    /// <c>memory/gotchas-clock.md</c>.
    /// </para>
    /// <para>
    /// Choosing a zone rather than freezing a clock keeps the test honest — it still runs
    /// against a real day window computed by real code — and it has a second benefit this
    /// repository has already paid for once: the club is no longer UTC, and
    /// <c>memory/gotchas-postgres-offsets.md</c> records that every real club is outside UTC
    /// and that UTC fixtures hide an entire class of offset defect.
    /// </para>
    /// </remarks>
    /// <param name="now">
    /// The instant to choose for. Defaults to now; a test passes one so the choice can be
    /// checked at every hour of the day rather than only at the hour the suite happens to run.
    /// </param>
    public static string DaytimeSettings(DateTimeOffset? now = null)
        => $$"""{"slice_minutes":15,"day_start_minute":0,"day_end_minute":1440,"grace_window_minutes":5,"timezone":"{{DaytimeZone(now ?? DateTimeOffset.UtcNow)}}","heartbeat_seconds":45}""";

    /// <summary>A real zone in which <paramref name="now"/> reads as mid-afternoon.</summary>
    /// <remarks>
    /// The spread covers every hour: the zones below run from UTC-7 to UTC+13, so for any
    /// instant at least one of them is between noon and 20:00 local. `DaytimeZoneTests` pins
    /// that for all 24 hours rather than trusting the arithmetic.
    /// </remarks>
    public static string DaytimeZone(DateTimeOffset now)
    {
        string[] zones =
        [
            "Africa/Johannesburg", "Europe/London", "America/Sao_Paulo", "America/Los_Angeles",
            "Asia/Kolkata", "Asia/Tokyo", "Pacific/Auckland", "UTC",
        ];
        return zones.FirstOrDefault(
            z => TimeZoneInfo.ConvertTime(now, TimeZoneInfo.FindSystemTimeZoneById(z)).Hour is >= 12 and < 20)
            ?? "UTC";
    }

    public static async Task<DoorClub> SeedAsync(
        TestWebAppFactory factory, string slugPrefix, string settingsJson = DefaultSettings)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        // The PREFIX is truncated and the random half never is.
        //
        // Cutting the whole concatenation to a fixed width — which is what the older suites in
        // this repo do — makes uniqueness depend on the caller's prefix being short. A theory
        // with a long case name left one guid character surviving, and two cases of one theory
        // then collided on IX_tenants_Slug intermittently, reading as a broken door setting
        // rather than as a fixture. Twelve hex characters is 48 bits, which is enough for a
        // database every test in the tier shares.
        var slug = $"{(slugPrefix.Length > 12 ? slugPrefix[..12] : slugPrefix)}-{Guid.NewGuid():N}"[..25];
        var tenant = new Tenant
        {
            Slug = slug,
            DisplayName = $"Club {slug}",
            DeviceApiKey = DeviceApiKey.Generate(),
            DeviceApiKeyRegeneratedAt = DateTimeOffset.UtcNow,
        };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings { TenantId = tenant.Id, SettingsJson = settingsJson });

        var court = new Court { TenantId = tenant.Id, CourtNumber = 1, Name = "Court 1", SlicePriceCredits = 8m };
        db.Courts.Add(court);

        var admin = Person(db, tenant.Id, $"{slug}-a", "Door Admin", isAdmin: true);
        var member = Person(db, tenant.Id, $"{slug}-m", "Door Member", isAdmin: false);

        await db.SaveChangesAsync();
        return new DoorClub(tenant.Id, slug, tenant.DeviceApiKey!, admin, member, court.Id);
    }

    /// <summary>An active member of this club, admin or not. Returns the user id.</summary>
    private static Guid Person(MainframeDbContext db, Guid tenantId, string handle, string name, bool isAdmin)
    {
        var user = new User
        {
            TenantId = tenantId,
            Email = $"{handle}@test.local",
            PasswordHash = "x",
            EmailVerified = true,
            IsAdmin = isAdmin,
        };
        db.Users.Add(user);
        db.Memberships.Add(new Membership
        {
            TenantId = tenantId,
            UserId = user.Id,
            FullName = name,
            MembershipNumber = handle,
            Status = MembershipStatus.Active,
        });
        return user.Id;
    }

    /// <summary>A gate row, as auto-registration would leave it plus whatever the caller names.</summary>
    public async Task<Guid> AddDoorAsync(
        TestWebAppFactory factory, string deviceCode, string? gateKey, string name = "Door gate",
        bool enabled = true, DateTimeOffset? lastSeenAt = null)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var device = new Device
        {
            TenantId = TenantId,
            DeviceCode = deviceCode,
            Name = name,
            Kind = DeviceKind.Gate,
            Hardware = DeviceHardware.Esp32,
            GateKey = gateKey,
            MacAddress = Guid.NewGuid().ToString("N")[..12],
            Enabled = enabled,
            LastSeenAt = lastSeenAt,
        };
        db.Devices.Add(device);
        await db.SaveChangesAsync();
        return device.Id;
    }

    /// <summary>A court box, for the tests that prove a box is not a door on these surfaces.</summary>
    public async Task<Guid> AddCourtBoxAsync(TestWebAppFactory factory, string deviceCode)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var device = new Device
        {
            TenantId = TenantId,
            DeviceCode = deviceCode,
            Name = "Court box",
            Kind = DeviceKind.CourtBox,
            Hardware = DeviceHardware.Esp8266,
            CourtNumbers = [1],
            MacAddress = Guid.NewGuid().ToString("N")[..12],
        };
        db.Devices.Add(device);
        await db.SaveChangesAsync();
        return device.Id;
    }

    /// <summary>
    /// One door row in the trail, written exactly as the live paths write it — the same
    /// action vocabulary, the same <c>device_id</c> in the details — so a reader tested
    /// against this fixture is tested against the rows it will really meet.
    /// </summary>
    public async Task WriteRowAsync(
        TestWebAppFactory factory, Guid deviceId, string action, DateTimeOffset at,
        Guid? subjectUserId = null, string? reason = null, string? fingerprint = null,
        long? seq = null, string? gateKey = null, string? deviceCode = null,
        DateTimeOffset? occurredAt = null, string? doorName = null)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var details = new Dictionary<string, object?>
        {
            ["device_id"] = deviceId,
            ["device_code"] = deviceCode ?? "gate-000000",
            ["gate_key"] = gateKey,
        };

        // The board's display name at the scan — written by both scan paths since round two,
        // and absent from every row older than that. Omitted rather than nulled when the caller
        // does not name one, so a fixture can reproduce an OLD row exactly: a key that is
        // present and null is a different document from one that is not there.
        if (doorName is not null) details["door_name"] = doorName;
        if (reason is not null) details["reason"] = reason;
        if (fingerprint is not null) details["subject"] = fingerprint;
        if (seq is not null) details["seq"] = seq;

        // The upload path stamps the SCAN's instant here while the row itself is written when
        // the board next called in. An offline row where the two differ is the only way to
        // test the difference, and the difference is the whole of A4.
        if (occurredAt is not null) details["occurred_at"] = occurredAt;

        db.AuditLogs.Add(new AuditLog
        {
            TenantId = TenantId,
            ActorUserId = Guid.Empty,
            SubjectUserId = subjectUserId,
            Action = action,
            DetailsJson = System.Text.Json.JsonSerializer.Serialize(details),

            // .ToUniversalTime() is not cosmetic and it belongs HERE rather than at each caller.
            //
            // Npgsql REFUSES to write a DateTimeOffset with a non-zero offset to a
            // `timestamp with time zone` — memory/gotchas-postgres-offsets.md — and a test that
            // writes a row at a CLUB-LOCAL instant is the only way to test a club-local day
            // boundary at all. The first such test died inside the fixture's own SaveChanges and
            // read as a broken endpoint. Same instant either way; it is the representation the
            // parameter has to be in.
            CreatedAt = at.ToUniversalTime(),
        });
        await db.SaveChangesAsync();
    }

    /// <summary>
    /// The <c>device.deleted</c> row an admin's delete leaves behind, written directly — for the
    /// tests that need a board to have been removed a while ago without also needing an HTTP
    /// delete at that instant. The same shape <c>DeviceRegistryService.DeleteAsync</c> writes.
    /// </summary>
    public async Task DeleteRecordAsync(
        TestWebAppFactory factory, Guid deviceId, string deviceCode, DateTimeOffset at)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        db.AuditLogs.Add(new AuditLog
        {
            TenantId = TenantId,
            ActorUserId = AdminUserId,
            SubjectUserId = null,
            Action = "device.deleted",
            DetailsJson = System.Text.Json.JsonSerializer.Serialize(
                new { device_id = deviceId, device_code = deviceCode }),
            CreatedAt = at,
        });
        await db.SaveChangesAsync();
    }

    /// <summary>
    /// One of the board's OWN rows — a registration, an admin edit, a clock correction — with
    /// its actor and the <c>changes</c> list a <c>device.updated</c> now records. The other half
    /// of <see cref="WriteRowAsync"/>, which writes scans.
    /// </summary>
    public async Task WriteEventRowAsync(
        TestWebAppFactory factory, Guid deviceId, string action, DateTimeOffset at,
        Guid actorUserId, IReadOnlyList<string> changes)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        var details = new Dictionary<string, object?> { ["device_id"] = deviceId };

        // Omitted rather than empty when the caller names none, so a fixture can reproduce a row
        // written BEFORE the list existed — which is the case DoorAuditActions.OtherChange is
        // for, and an empty array would be a different document.
        if (changes.Count > 0) details["changes"] = changes;

        db.AuditLogs.Add(new AuditLog
        {
            TenantId = TenantId,
            ActorUserId = actorUserId,
            SubjectUserId = null,
            Action = action,
            DetailsJson = System.Text.Json.JsonSerializer.Serialize(details),
            CreatedAt = at.ToUniversalTime(),
        });
        await db.SaveChangesAsync();
    }

    /// <summary>
    /// Writes <see cref="Device.ShutByUserId"/> directly — for the cross-tenant case, where the
    /// point is a guid that could not have got there through any route.
    /// </summary>
    public async Task SetShutByAsync(TestWebAppFactory factory, Guid deviceId, Guid userId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        // IgnoreQueryFilters, like AuditRowsAsync: a scope created outside a request has no
        // tenant resolved, so the global filter excludes every row and the read finds nothing.
        var device = await db.Devices.IgnoreQueryFilters().FirstAsync(d => d.Id == deviceId);
        device.Enabled = false;
        device.OutOfServiceSince = DateTimeOffset.UtcNow;
        device.ShutByUserId = userId;
        await db.SaveChangesAsync();
    }

    /// <summary>This club's audit rows for one action — the trail as a test reads it.</summary>
    public async Task<List<AuditLog>> AuditRowsAsync(TestWebAppFactory factory, string action)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == TenantId && a.Action == action)
            .ToListAsync();
    }

    public HttpClient AdminClient(TestWebAppFactory factory) => ClientFor(factory, AdminUserId, "admin");

    public HttpClient MemberClient(TestWebAppFactory factory) => ClientFor(factory, MemberUserId, null);

    /// <summary>A client carrying this club's token for one of its people.</summary>
    public HttpClient ClientFor(TestWebAppFactory factory, Guid userId, string? role)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", TokenFor(userId, role));
        return client;
    }

    /// <summary>A token this club's routes will accept. Block body for the lizard reason in <c>memory/gotchas.md</c>.</summary>
    public string TokenFor(Guid userId, string? role)
    {
        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, userId.ToString()),
            new("tenant_id", TenantId.ToString()),
            new("tenant_slug", Slug),
            new("purpose", "access"),
            // What every server-minted token carries, so a session minted after a rotation's
            // cut-off is told apart from one minted in the same second before it.
            new(Crusaders.Mainframe.Api.Security.SessionCutoff.IssuedAtMsClaim, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString()),
        };
        if (role is not null) claims.Add(new Claim(ClaimTypes.Role, role));

        var token = new JwtSecurityToken(
            issuer: "crusaders.mainframe",
            audience: "crusaders.mainframe.app",
            claims: claims,
            notBefore: DateTime.UtcNow,
            expires: DateTime.UtcNow.AddMinutes(10),
            signingCredentials: new SigningCredentials(
                new SymmetricSecurityKey(Encoding.UTF8.GetBytes(Secret)), SecurityAlgorithms.HmacSha256));

        return new JwtSecurityTokenHandler().WriteToken(token);
    }
}
