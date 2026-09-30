using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security.DeviceAuth;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The door gate over real HTTP, against the real schema.
///
/// <para>
/// Pinned here rather than one layer down because HTTP is the layer the gate enters at.
/// <c>GateAccess</c> answering correctly proves nothing about whether the route is mounted
/// on the device group, whether the bearer key resolves a tenant before the handler runs, or
/// whether a refusal comes back as the 200 the firmware needs rather than the 403 it would
/// treat as an outage and second-guess from its cache. Those are the failures that reach a
/// doorway, and only these tests see them.
/// </para>
///
/// <para>
/// The in-memory provider cannot stand in: it applies no migrations and enforces no unique
/// index, and the cross-tenant cases below turn on exactly those.
/// </para>
/// </summary>
public abstract partial class DeviceGateHttpTests
{
    private readonly PostgresFixture _pg;

    protected DeviceGateHttpTests(PostgresFixture pg) => _pg = pg;

    private const string HeartbeatPath = "/api/v1/device/heartbeat";
    private const string GatePath = "/api/v1/device/gate";
    private const string EventsPath = "/api/v1/device/events";
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private sealed record Club(Guid TenantId, string Slug, string Key, Guid MemberId, Guid CourtId);

    private TestWebAppFactory CreateFactory() => _pg.SharedHost;

    /// <summary>
    /// Migrates and creates a club with a device key, one court and one active member — and
    /// no devices, because a board registering itself is part of what is under test.
    ///
    /// <para>
    /// The slug is suffixed per call because every test in this class shares one database: an
    /// xUnit collection fixture is created once, not once per test.
    /// </para>
    /// </summary>
    private static async Task<Club> ClubAsync(TestWebAppFactory factory, string slugPrefix, string settingsJson)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        // No MigrateAsync: the database is a clone of the template PostgresFixture migrated once.

        var slug = $"{slugPrefix}-{Guid.NewGuid():N}"[..24];
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

        var member = new User { TenantId = tenant.Id, Email = $"{slug}@test.local", PasswordHash = "x", EmailVerified = true };
        db.Users.Add(member);
        db.Memberships.Add(new Membership
        {
            TenantId = tenant.Id,
            UserId = member.Id,
            FullName = "Gate Member",
            MembershipNumber = slug,
            Status = MembershipStatus.Active,
        });

        await db.SaveChangesAsync();
        return new Club(tenant.Id, slug, tenant.DeviceApiKey!, member.Id, court.Id);
    }

    /// <summary>The default settings a club runs doors on: open to every active member, three seconds, thirty minutes early.</summary>
    private const string DefaultSettings =
        """{"slice_minutes":15,"day_start_minute":0,"day_end_minute":1440,"grace_window_minutes":5,"timezone":"UTC","heartbeat_seconds":45}""";

    /// <summary>A random MAC, so tests in this shared database never collide on the unique index.</summary>
    private static string NewMac() => Guid.NewGuid().ToString("N")[..12];

    private static HttpRequestMessage Signed(string key, string path, JsonObject body)
    {
        var req = new HttpRequestMessage(HttpMethod.Post, path)
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
        return req;
    }

    private static HttpRequestMessage Heartbeat(string key, string mac, string? kind = null)
    {
        var body = new JsonObject { ["mac"] = mac, ["firmware_version"] = "1.0.0", ["uptime_ms"] = 60000 };
        if (kind is not null) body["kind"] = kind;
        return Signed(key, HeartbeatPath, body);
    }

    private static HttpRequestMessage Scan(string key, string mac, string? token, string method = "qr")
    {
        var body = new JsonObject { ["mac"] = mac, ["method"] = method };
        if (token is not null) body["token"] = token;
        return Signed(key, GatePath, body);
    }

    private static async Task<JsonElement> BodyAsync(HttpResponseMessage response) =>
        JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;

    /// <summary>Registers a gate and hands back its MAC.</summary>
    private static async Task<string> GateAsync(TestWebAppFactory factory, Club club, HttpClient client, string? gateKey = null)
    {
        var mac = NewMac();
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Heartbeat(club.Key, mac, DeviceKinds.Gate))).StatusCode);

        if (gateKey is not null)
        {
            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var row = await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == mac);
            row.GateKey = gateKey;
            await db.SaveChangesAsync();
        }

        return mac;
    }

    /// <summary>A live member-ident code for <paramref name="userId"/>, written directly.</summary>
    private static async Task<string> IdentCodeAsync(TestWebAppFactory factory, Guid tenantId, Guid userId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var code = new AccessCode
        {
            TenantId = tenantId,
            Code = AccessCodeService.NewCode(),
            Purpose = AccessCodePurpose.MemberIdent,
            UserId = userId,
            ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(5),
        };
        db.AccessCodes.Add(code);
        await db.SaveChangesAsync();
        return code.Code;
    }

    private static async Task<List<string>> RosterAsync(
        HttpClient client, Club club, string mac, string? kind)
    {
        var json = await BodyAsync(await client.SendAsync(Heartbeat(club.Key, mac, kind)));
        return json.GetProperty("roster").EnumerateArray().Select(e => e.GetString()!).ToList();
    }

    /// <summary>Registers a court box the ordinary way — by heartbeating — and hands back its MAC.</summary>
    private static async Task<string> CourtBoxAsync(Club club, HttpClient client)
    {
        var mac = NewMac();
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Heartbeat(club.Key, mac))).StatusCode);
        return mac;
    }

    /// <summary>
    /// A settings document nobody could have produced through the console: a negative roster
    /// window. Everything else is the default.
    /// </summary>
    private const string NegativeRosterWindowSettings =
        """{"slice_minutes":15,"day_start_minute":0,"day_end_minute":1440,"grace_window_minutes":5,"timezone":"UTC","roster_window_minutes":-600,"activation_cue_window_minutes":10,"gate_early_entry_minutes":30}""";

    /// <summary>A charged booking for the club's member, written straight to the table.</summary>
    private static async Task<Booking> BookAsync(TestWebAppFactory factory, Club club, DateTimeOffset startsAt, int minutes = 45)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var booking = new Booking
        {
            TenantId = club.TenantId,
            CourtId = club.CourtId,
            UserId = club.MemberId,
            BookedByUserId = club.MemberId,
            PaidByUserId = club.MemberId,
            ActorUserId = club.MemberId,
            StartsAt = TestHost.Storable(startsAt),
            EndsAt = TestHost.Storable(startsAt.AddMinutes(minutes)),
            SliceMinutes = 15,
            SliceCount = Math.Max(1, minutes / 15),
            AmountChargedCredits = 8m * Math.Max(1, minutes / 15),
            Status = BookingStatus.Booked,
            ChargedAt = TestHost.UtcNowStorable(),
        };
        db.Bookings.Add(booking);
        await db.SaveChangesAsync();
        return booking;
    }

    private static async Task AssertRefusedAsync(HttpClient client, HttpRequestMessage request, string reason)
    {
        var response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var json = await BodyAsync(response);
        Assert.False(json.GetProperty("opened").GetBoolean());
        Assert.Equal(reason, json.GetProperty("reason").GetString());
        Assert.Equal(0, json.GetProperty("unlock_seconds").GetInt32());
    }

    private static async Task SuspendAsync(TestWebAppFactory factory, Club club)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var membership = await db.Memberships.IgnoreQueryFilters().SingleAsync(m => m.UserId == club.MemberId);
        membership.Status = MembershipStatus.Suspended;
        await db.SaveChangesAsync();
    }

    /// <summary>The settings a club runs its doors on under <c>booking_window</c>, thirty minutes early.</summary>
    private const string BookingWindowSettings =
        """{"slice_minutes":15,"day_start_minute":0,"day_end_minute":1440,"grace_window_minutes":5,"timezone":"UTC","gate_access_policy":"booking_window","gate_early_entry_minutes":30}""";

    /// <summary>An admin of this club, holding an ordinary Active membership like a promoted member would.</summary>
    private static async Task<Guid> AdminUserAsync(TestWebAppFactory factory, Club club)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var admin = new User
        {
            TenantId = club.TenantId,
            Email = $"admin-{Guid.NewGuid():N}@test.local",
            PasswordHash = "x",
            EmailVerified = true,
            IsAdmin = true,
        };
        db.Users.Add(admin);
        db.Memberships.Add(new Membership
        {
            TenantId = club.TenantId,
            UserId = admin.Id,
            FullName = "Gate Admin",
            MembershipNumber = $"A-{Guid.NewGuid():N}"[..12],
            Status = MembershipStatus.Active,
        });
        await db.SaveChangesAsync();
        return admin.Id;
    }

    /// <summary>
    /// The default policy with the two horizon inputs stated rather than defaulted, because
    /// this is the one test whose arithmetic they decide: 120 + 10 = 130 minutes, against a
    /// thirty-minute entry window that the max leaves behind.
    /// </summary>
    private const string SharedHorizonSettings =
        """{"slice_minutes":15,"day_start_minute":0,"day_end_minute":1440,"grace_window_minutes":5,"timezone":"UTC","roster_window_minutes":120,"activation_cue_window_minutes":10,"gate_early_entry_minutes":30,"gate_access_policy":"active_member"}""";

    /// <summary>What the member's own screen asks for: <c>POST /me/qr/generate</c>, kind auto.</summary>
    private static async Task<JsonElement> GenerateAsync(HttpClient phone)
    {
        var response = await phone.PostAsync("/api/v1/me/qr/generate", null);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await BodyAsync(response);
    }

    /// <summary>The club member's own JWT — the principal the Court Code page runs as.</summary>
    private static HttpClient MemberClient(TestWebAppFactory factory, Club club) =>
        ClientFor(factory, club, club.MemberId, role: null);

    /// <summary>The widest horizon the settings PUT will accept: a day of roster and a day of cue.</summary>
    private const string TwoDayHorizonSettings =
        """{"slice_minutes":15,"day_start_minute":0,"day_end_minute":1440,"grace_window_minutes":5,"timezone":"UTC","roster_window_minutes":1440,"activation_cue_window_minutes":1440,"activation_forward_window_minutes":1440,"gate_early_entry_minutes":30,"gate_access_policy":"active_member"}""";

    /// <summary>The booking's own activation code, minted directly.</summary>
    private static async Task<string> BookingCodeAsync(TestWebAppFactory factory, Club club, Booking booking)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var code = new AccessCode
        {
            TenantId = club.TenantId,
            Code = AccessCodeService.NewCode(),
            Purpose = AccessCodePurpose.BookingActivation,
            UserId = club.MemberId,
            BookingId = booking.Id,
            ExpiresAt = booking.EndsAt.AddMinutes(30),
        };
        db.AccessCodes.Add(code);
        await db.SaveChangesAsync();
        return code.Code;
    }

    private static JsonObject DoorEvent(long seq, string kind, string token) => new()
    {
        ["seq"] = seq,
        ["uptime_ms"] = 600_000,
        ["kind"] = kind,
        ["court"] = -1,
        ["method"] = "qr",
        ["subject"] = token,
        ["duration_ms"] = 3000,
    };

    /// <summary>Whether an audit row's details name this board. The device id is the only discriminator on the row.</summary>
    private static bool Names(AuditLog row, Guid deviceId) =>
        row.DetailsJson!.Contains(deviceId.ToString(), StringComparison.OrdinalIgnoreCase);

    /// <summary>One offline door open, as a board queues it. <c>court</c> is -1: there is no relay bank to index.</summary>
    private static JsonObject GateOpenBatch(string mac, string subject, int seq) => new()
    {
        ["mac"] = mac,
        ["uptime_ms"] = 120000,
        ["events"] = new JsonArray(new JsonObject
        {
            ["seq"] = seq,
            ["uptime_ms"] = 60000,
            ["kind"] = DeviceEventEndpoints.GateOpenKind,
            ["court"] = -1,
            ["method"] = "qr",
            ["subject"] = subject,
            ["duration_ms"] = 3000,
        }),
    };

    /// <summary>The outcome an applied activation records, as the activity route reports it.</summary>
    private const string ActivationOutcomeOk = "ok";

    private static async Task<(Guid Gate, Guid Box)> IdsAsync(TestWebAppFactory factory, string gateMac, string boxMac)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var gate = await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == gateMac);
        var box = await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == boxMac);
        return (gate.Id, box.Id);
    }

    /// <summary>An admin JWT for this club, minted the way <c>AdminSettingsHttpTests</c> does.</summary>
    private static async Task<HttpClient> AdminClientAsync(TestWebAppFactory factory, Club club) =>
        ClientFor(factory, club, await AdminUserAsync(factory, club), role: "admin");

    /// <summary>
    /// A signed client for one principal of this club. Shared by the admin console's JWT and
    /// the member's own, so the two differ by exactly the role claim — which is what lets the
    /// gate tests drive the Court Code page and the Devices page against one club.
    /// </summary>
    private static HttpClient ClientFor(TestWebAppFactory factory, Club club, Guid userId, string? role)
    {
        List<System.Security.Claims.Claim> claims =
        [
            new(System.IdentityModel.Tokens.Jwt.JwtRegisteredClaimNames.Sub, userId.ToString()),
            new("tenant_id", club.TenantId.ToString()),
            new("tenant_slug", club.Slug),
            new("purpose", "access"),
        ];
        if (role is not null) claims.Add(new(System.Security.Claims.ClaimTypes.Role, role));

        var token = new System.IdentityModel.Tokens.Jwt.JwtSecurityToken(
            issuer: "crusaders.mainframe",
            audience: "crusaders.mainframe.app",
            claims: claims,
            notBefore: DateTime.UtcNow,
            expires: DateTime.UtcNow.AddMinutes(10),
            signingCredentials: new Microsoft.IdentityModel.Tokens.SigningCredentials(
                new Microsoft.IdentityModel.Tokens.SymmetricSecurityKey(
                    Encoding.UTF8.GetBytes("test-only-signing-key-not-used-in-any-real-environment")),
                Microsoft.IdentityModel.Tokens.SecurityAlgorithms.HmacSha256));

        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue(
            "Bearer", new System.IdentityModel.Tokens.Jwt.JwtSecurityTokenHandler().WriteToken(token));
        return client;
    }
}
