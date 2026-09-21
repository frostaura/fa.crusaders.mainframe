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
            MemberClass = MemberClass.Regular,
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
