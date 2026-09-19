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
[Collection(HttpTestCollection.Name)]
public sealed class DeviceGateHttpTests
{
    private readonly PostgresFixture _pg;

    public DeviceGateHttpTests(PostgresFixture pg) => _pg = pg;

    private const string HeartbeatPath = "/api/v1/device/heartbeat";
    private const string GatePath = "/api/v1/device/gate";
    private const string EventsPath = "/api/v1/device/events";
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private sealed record Club(Guid TenantId, string Slug, string Key, Guid MemberId, Guid CourtId);

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

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
        await db.Database.MigrateAsync();

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
            MemberClass = MemberClass.Regular,
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

    // ---- Registration and the heartbeat --------------------------------------

    /// <summary>
    /// A board that says it is a gate becomes one, and gets a gate's answer: no court
    /// numbers, no relay config, no button map, and a <c>gate</c> block with the release the
    /// club configured. Every absence here is as much of the contract as the presences.
    /// </summary>
    [SkippableFact]
    public async Task A_board_that_calls_itself_a_gate_registers_as_one_and_gets_a_gates_heartbeat()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", DefaultSettings);
        var mac = NewMac();
        var client = factory.CreateClient();

        var json = await BodyAsync(await client.SendAsync(Heartbeat(club.Key, mac, DeviceKinds.Gate)));

        Assert.Equal(club.Slug, json.GetProperty("tenant_slug").GetString());
        Assert.Equal($"gate-{mac[^6..]}", json.GetProperty("device_code").GetString());
        Assert.Equal(DeviceKinds.Gate, json.GetProperty("kind").GetString());
        Assert.Equal(45, json.GetProperty("heartbeat_seconds").GetInt32());
        Assert.Equal(3, json.GetProperty("gate").GetProperty("unlock_seconds").GetInt32());
        Assert.Empty(json.GetProperty("roster").EnumerateArray());

        // Present, and null: a firmware that read an absent key as an empty string and a
        // null one as an error would diverge on exactly the gate nobody has named yet.
        Assert.Equal(JsonValueKind.Null, json.GetProperty("gate_key").ValueKind);

        Assert.False(json.TryGetProperty("court_numbers", out _));
        Assert.False(json.TryGetProperty("config", out _));
        Assert.False(json.TryGetProperty("button_map", out _));

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var device = await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == mac);
        Assert.Equal(DeviceKind.Gate, device.Kind);
        Assert.Equal(DeviceHardware.Esp32, device.Hardware);
        Assert.Empty(device.CourtNumbers);
        Assert.True(device.AutoRegistered);
    }

    /// <summary>
    /// The court box's heartbeat is byte-for-byte the behaviour it was: no <c>kind</c> sent,
    /// and everything it has always been answered. The hint is additive, and this is what
    /// says so — every board in the field today takes this path.
    /// </summary>
    [SkippableTheory]
    [InlineData(null)]
    [InlineData("court_box")]
    public async Task A_board_that_says_nothing_or_says_court_box_is_a_court_box(string? kind)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", DefaultSettings);
        var mac = NewMac();
        var client = factory.CreateClient();

        var json = await BodyAsync(await client.SendAsync(Heartbeat(club.Key, mac, kind)));

        Assert.Equal($"box-{mac[^6..]}", json.GetProperty("device_code").GetString());
        Assert.Equal(new[] { 1 }, json.GetProperty("court_numbers").EnumerateArray().Select(e => e.GetInt32()));
        Assert.Equal(15, json.GetProperty("config").GetProperty("slice_minutes").GetInt32());

        // A court box is not told a kind, so a firmware that started reading the field would
        // find nothing rather than something wrong.
        Assert.False(json.TryGetProperty("kind", out _));
        Assert.False(json.TryGetProperty("gate", out _));
    }

    /// <summary>
    /// A kind this server does not have is a 400 rather than a silent court box. Refused
    /// before the MAC is resolved, so the answer does not depend on whether the board has a
    /// row yet — a firmware that discovers its own bug only after somebody deletes its row
    /// discovers it at the worst possible moment.
    /// </summary>
    [SkippableTheory]
    [InlineData("turnstile")]
    [InlineData("Gate")]
    [InlineData("courtbox")]
    public async Task A_kind_this_server_does_not_have_is_refused(string kind)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", DefaultSettings);
        var client = factory.CreateClient();
        var mac = NewMac();

        var unknown = await client.SendAsync(Heartbeat(club.Key, mac, kind));
        Assert.Equal(HttpStatusCode.BadRequest, unknown.StatusCode);
        Assert.Equal(DeviceEndpoints.KindUnknown, (await BodyAsync(unknown)).GetProperty("error").GetString());

        // …and it is still refused once the board HAS a row, which is the half an
        // "ignore the hint on a known MAC" reading would have got wrong.
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Heartbeat(club.Key, mac))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.SendAsync(Heartbeat(club.Key, mac, kind))).StatusCode);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        Assert.Equal(1, await db.Devices.IgnoreQueryFilters().CountAsync(d => d.MacAddress == mac));
    }

    /// <summary>
    /// <b>A board cannot re-kind itself.</b> Once the row exists its kind is authoritative
    /// and the hint is ignored outright, in both directions. A gate that could turn its row
    /// into a court box would hand itself the club's courts; a box that could turn itself
    /// into a gate would drop off the settlement model's map of which courts have a working
    /// door, and start waiving no-show penalties on them.
    /// </summary>
    [SkippableFact]
    public async Task A_board_cannot_re_kind_a_row_that_already_exists()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", DefaultSettings);
        var client = factory.CreateClient();

        var boxMac = NewMac();
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Heartbeat(club.Key, boxMac))).StatusCode);
        var stillABox = await BodyAsync(await client.SendAsync(Heartbeat(club.Key, boxMac, DeviceKinds.Gate)));
        Assert.True(stillABox.TryGetProperty("court_numbers", out _));
        Assert.False(stillABox.TryGetProperty("kind", out _));

        var gateMac = await GateAsync(factory, club, client);
        var stillAGate = await BodyAsync(await client.SendAsync(Heartbeat(club.Key, gateMac, DeviceKinds.CourtBox)));
        Assert.Equal(DeviceKinds.Gate, stillAGate.GetProperty("kind").GetString());
        Assert.False(stillAGate.TryGetProperty("court_numbers", out _));

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        Assert.Equal(DeviceKind.CourtBox, (await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == boxMac)).Kind);
        Assert.Equal(DeviceKind.Gate, (await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == gateMac)).Kind);
    }

    /// <summary>
    /// The roster a gate is pushed is the CLUB's bookings on any court, and it carries the
    /// booking's own activation code on relay 0.
    /// </summary>
    [SkippableFact]
    public async Task A_gates_roster_carries_the_clubs_bookings_on_relay_zero()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", DefaultSettings);
        var client = factory.CreateClient();
        var mac = await GateAsync(factory, club, client, "front-door");

        await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(20));

        var json = await BodyAsync(await client.SendAsync(Heartbeat(club.Key, mac, DeviceKinds.Gate)));
        var roster = json.GetProperty("roster").EnumerateArray().Select(e => e.GetString()!).ToList();

        var entry = Assert.Single(roster);
        Assert.Matches(DeviceProtocolCorpusTests.RosterEntryPattern, entry);
        Assert.Equal("0", entry.Split('|')[1]);
        Assert.Equal("front-door", json.GetProperty("gate_key").GetString());

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        Assert.NotNull(await db.AccessCodes.IgnoreQueryFilters()
            .FirstOrDefaultAsync(c => c.TenantId == club.TenantId && c.Code == entry.Split('|')[0]));
    }

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

    // ---- The scan ------------------------------------------------------------

    /// <summary>
    /// The happy path over the wire, and the audit row that is the entire record a door
    /// leaves behind — there is no ledger entry and no booking to reconstruct it from.
    /// </summary>
    [SkippableFact]
    public async Task An_active_member_opens_the_door_and_the_open_is_audited()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", DefaultSettings);
        var client = factory.CreateClient();
        var mac = await GateAsync(factory, club, client, "front-door");
        var token = await IdentCodeAsync(factory, club.TenantId, club.MemberId);

        var response = await client.SendAsync(Scan(club.Key, mac, token));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var json = await BodyAsync(response);
        Assert.True(json.GetProperty("opened").GetBoolean());
        Assert.Equal(GateAccess.Ok, json.GetProperty("reason").GetString());
        Assert.Equal(3, json.GetProperty("unlock_seconds").GetInt32());

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var audit = Assert.Single(await db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == club.TenantId && a.Action == DeviceGateEndpoint.OpenedAction).ToListAsync());

        Assert.Equal(club.MemberId, audit.SubjectUserId);
        Assert.Equal(Guid.Empty, audit.ActorUserId);
        Assert.Contains("front-door", audit.DetailsJson!, StringComparison.Ordinal);

        // The token is deliberately NOT in the details: a live access code in a trail an
        // admin can read is a credential in a log.
        Assert.DoesNotContain(token, audit.DetailsJson!, StringComparison.Ordinal);

        // A door moves no money and stamps no attendance, over HTTP as in the unit tests.
        Assert.Empty(await db.LedgerEntries.IgnoreQueryFilters().Where(l => l.TenantId == club.TenantId).ToListAsync());
    }

    /// <summary>
    /// <b>Every refusal is a 200.</b> The firmware falls back to its cached roster on
    /// anything that is not a clean 200, because that means the server could not be reached
    /// or could not answer — so a 403 for a suspended member would make the gate treat a
    /// decision the server definitely made as an outage, second-guess it against a roster
    /// fetched minutes ago, and let in whoever the club had just suspended.
    /// </summary>
    [SkippableFact]
    public async Task Every_refusal_is_a_200_the_firmware_can_act_on_and_is_audited_by_reason()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", DefaultSettings);
        var client = factory.CreateClient();
        var mac = await GateAsync(factory, club, client, "side-door");
        var token = await IdentCodeAsync(factory, club.TenantId, club.MemberId);

        // not_recognised
        await AssertRefusedAsync(client, Scan(club.Key, mac, "ZZZZZZZZZZZZ"), GateAccess.NotRecognised);

        // method_not_supported
        await AssertRefusedAsync(client, Scan(club.Key, mac, token, "pin"), GateAccess.MethodNotSupported);

        // not_a_gate — the same scan at a court box's MAC
        var boxMac = NewMac();
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Heartbeat(club.Key, boxMac))).StatusCode);
        await AssertRefusedAsync(client, Scan(club.Key, boxMac, token), GateAccess.NotAGate);

        // member_not_active — the control above proves the same token opens the door while
        // the membership is Active, so this varies exactly one field.
        Assert.True((await BodyAsync(await client.SendAsync(Scan(club.Key, mac, token)))).GetProperty("opened").GetBoolean());
        await SuspendAsync(factory, club);
        await AssertRefusedAsync(client, Scan(club.Key, mac, token), GateAccess.MemberNotActive);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var actions = await db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == club.TenantId && a.Action.StartsWith(DeviceGateEndpoint.DeniedActionPrefix))
            .Select(a => a.Action).ToListAsync();

        Assert.Contains($"{DeviceGateEndpoint.DeniedActionPrefix}{GateAccess.NotRecognised}", actions);
        Assert.Contains($"{DeviceGateEndpoint.DeniedActionPrefix}{GateAccess.MethodNotSupported}", actions);
        Assert.Contains($"{DeviceGateEndpoint.DeniedActionPrefix}{GateAccess.NotAGate}", actions);
        Assert.Contains($"{DeviceGateEndpoint.DeniedActionPrefix}{GateAccess.MemberNotActive}", actions);
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

    /// <summary>
    /// The board identity failures are the same three shapes as every other device route —
    /// a malformed MAC is a 400, an unknown one a 404, a disabled board a 403 — and they are
    /// deliberately NOT the 200 a decision gets, because none of them is a decision.
    /// </summary>
    [SkippableFact]
    public async Task The_board_identity_failures_keep_their_own_shapes()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", DefaultSettings);
        var client = factory.CreateClient();
        var mac = await GateAsync(factory, club, client);
        var token = await IdentCodeAsync(factory, club.TenantId, club.MemberId);

        Assert.Equal(HttpStatusCode.BadRequest, (await client.SendAsync(Scan(club.Key, "not-a-mac", token))).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.SendAsync(Scan(club.Key, NewMac(), token))).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.SendAsync(Scan(DeviceApiKey.Generate(), mac, token))).StatusCode);

        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var device = await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == mac);
            device.Enabled = false;
            await db.SaveChangesAsync();
        }

        Assert.Equal(HttpStatusCode.Forbidden, (await client.SendAsync(Scan(club.Key, mac, token))).StatusCode);
    }

    /// <summary>
    /// <b>Tenant B's code at tenant A's gate is <c>not_recognised</c>.</b> The code is real,
    /// live, and in the same database — everything but the tenant matches — so the refusal
    /// is the query filter and not an empty table. Cross-tenant leakage here is somebody
    /// walking into another club's building.
    /// </summary>
    [SkippableFact]
    public async Task Another_clubs_code_does_not_open_this_clubs_door()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var alpha = await ClubAsync(factory, "alpha", DefaultSettings);
        var bravo = await ClubAsync(factory, "bravo", DefaultSettings);
        var client = factory.CreateClient();

        var alphaGate = await GateAsync(factory, alpha, client);
        var bravoGate = await GateAsync(factory, bravo, client);
        var bravoToken = await IdentCodeAsync(factory, bravo.TenantId, bravo.MemberId);

        // The control: it works at its own club. Without this the assertion below would hold
        // against an implementation that refuses everybody.
        Assert.True((await BodyAsync(await client.SendAsync(Scan(bravo.Key, bravoGate, bravoToken))))
            .GetProperty("opened").GetBoolean());

        await AssertRefusedAsync(client, Scan(alpha.Key, alphaGate, bravoToken), GateAccess.NotRecognised);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        Assert.Equal(bravo.TenantId,
            (await db.AccessCodes.IgnoreQueryFilters().SingleAsync(c => c.Code == bravoToken)).TenantId);

        // And nobody was named in alpha's audit row, because nothing resolved.
        var denial = await db.AuditLogs.IgnoreQueryFilters()
            .SingleAsync(a => a.TenantId == alpha.TenantId && a.Action.StartsWith(DeviceGateEndpoint.DeniedActionPrefix));
        Assert.Null(denial.SubjectUserId);
    }

    /// <summary>
    /// And tenant B's bookings never reach tenant A's gate roster — the same P0 class from
    /// the other direction, and the one that would push another club's live access codes to
    /// a board in this club's doorway.
    /// </summary>
    [SkippableFact]
    public async Task Another_clubs_bookings_never_reach_this_clubs_gate_roster()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var alpha = await ClubAsync(factory, "alpha", DefaultSettings);
        var bravo = await ClubAsync(factory, "bravo", DefaultSettings);
        var client = factory.CreateClient();

        var alphaGate = await GateAsync(factory, alpha, client);
        var bravoGate = await GateAsync(factory, bravo, client);

        await BookAsync(factory, bravo, DateTimeOffset.UtcNow.AddMinutes(20));

        var atAlpha = await BodyAsync(await client.SendAsync(Heartbeat(alpha.Key, alphaGate, DeviceKinds.Gate)));
        Assert.Empty(atAlpha.GetProperty("roster").EnumerateArray());

        // Bravo's own gate has it, so the emptiness above is the filter rather than a
        // booking that was never pushed to anybody.
        var atBravo = await BodyAsync(await client.SendAsync(Heartbeat(bravo.Key, bravoGate, DeviceKinds.Gate)));
        Assert.Single(atBravo.GetProperty("roster").EnumerateArray());
    }

    /// <summary>
    /// The <c>booking_window</c> policy over the wire, and the one field that moves between
    /// the two halves is the club's policy string.
    /// </summary>
    [SkippableFact]
    public async Task The_booking_window_policy_refuses_a_member_with_nothing_booked()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate",
            """{"slice_minutes":15,"day_start_minute":0,"day_end_minute":1440,"grace_window_minutes":5,"timezone":"UTC","gate_access_policy":"booking_window","gate_early_entry_minutes":30}""");
        var client = factory.CreateClient();
        var mac = await GateAsync(factory, club, client);
        var token = await IdentCodeAsync(factory, club.TenantId, club.MemberId);

        await AssertRefusedAsync(client, Scan(club.Key, mac, token), GateAccess.NoBooking);

        // Twenty minutes out is inside a thirty-minute entry window.
        await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(20));
        Assert.True((await BodyAsync(await client.SendAsync(Scan(club.Key, mac, token)))).GetProperty("opened").GetBoolean());
    }

    /// <summary>
    /// The release is the club's setting, from the settings document through the decision to
    /// the wire. The same club with one number changed answers a different number.
    /// </summary>
    [SkippableFact]
    public async Task The_release_on_the_wire_is_the_clubs_setting()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate",
            """{"slice_minutes":15,"day_start_minute":0,"day_end_minute":1440,"timezone":"UTC","gate_unlock_seconds":12}""");
        var client = factory.CreateClient();
        var mac = await GateAsync(factory, club, client);
        var token = await IdentCodeAsync(factory, club.TenantId, club.MemberId);

        Assert.Equal(12, (await BodyAsync(await client.SendAsync(Scan(club.Key, mac, token))))
            .GetProperty("unlock_seconds").GetInt32());

        // …and the heartbeat tells the gate the same number, so what it does offline matches
        // what it would have been told online.
        Assert.Equal(12, (await BodyAsync(await client.SendAsync(Heartbeat(club.Key, mac, DeviceKinds.Gate))))
            .GetProperty("gate").GetProperty("unlock_seconds").GetInt32());
    }

    // ---- What a gate may not do on the court-box routes -----------------------

    /// <summary>
    /// <b>A door sells no court time and checks nobody in.</b> All four court-box paths
    /// refuse a gate row by name.
    ///
    /// <para>
    /// Every one of them already refused a gate by accident, because a gate has no court
    /// numbers: the activation path fails its relay-index check against an empty list and the
    /// walk-up fails <c>court_not_on_device</c>. Both are wrong sentences, and both stop being
    /// refusals at all the moment anybody puts a court number on a gate row — which is a
    /// single PATCH away. The rule is "a door never sells court time and never checks anyone
    /// in", and a rule enforced by the emptiness of an unrelated list is not enforced.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_gate_cannot_activate_a_court_or_sell_a_walk_up()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", DefaultSettings);
        var client = factory.CreateClient();
        var mac = await GateAsync(factory, club, client);
        var token = await IdentCodeAsync(factory, club.TenantId, club.MemberId);
        var booking = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(2));

        var activate = await client.SendAsync(Signed(club.Key, "/api/v1/device/activate",
            new JsonObject { ["mac"] = mac, ["method"] = "qr", ["token"] = token }));
        Assert.Equal(HttpStatusCode.OK, activate.StatusCode);
        var activated = await BodyAsync(activate);
        Assert.False(activated.GetProperty("activated").GetBoolean());
        Assert.Equal(GateAccess.NotACourtBox, activated.GetProperty("reason").GetString());
        Assert.Equal(0, activated.GetProperty("granted_seconds").GetInt32());

        var walkup = await client.SendAsync(Signed(club.Key, "/api/v1/device/walkup",
            new JsonObject
            {
                ["mac"] = mac,
                ["minutes"] = 30,
                ["method"] = "qr",
                ["token"] = token,
                ["court"] = 1,
                ["nonce"] = Guid.NewGuid().ToString("N")[..16],
            }));
        Assert.Equal(HttpStatusCode.BadRequest, walkup.StatusCode);
        Assert.Equal(GateAccess.NotACourtBox, (await BodyAsync(walkup)).GetProperty("error").GetString());

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        Assert.Null((await db.Bookings.IgnoreQueryFilters().SingleAsync(b => b.Id == booking.Id)).CheckedInAt);
        Assert.Empty(await db.LedgerEntries.IgnoreQueryFilters().Where(l => l.TenantId == club.TenantId).ToListAsync());
    }

    /// <summary>
    /// An <c>activation</c> uploaded BY A GATE ROW is receipted and acknowledged — never
    /// 4xx'd, because an event a board cannot change is a board retrying for ever — and
    /// settles nothing: no <c>CheckedInAt</c>, no ledger row, and an audit row naming why.
    /// </summary>
    [SkippableFact]
    public async Task An_activation_uploaded_by_a_gate_is_recorded_and_settles_nothing()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", DefaultSettings);
        var client = factory.CreateClient();
        var mac = await GateAsync(factory, club, client);
        var booking = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(-5));
        var bookingCode = await BookingCodeAsync(factory, club, booking);

        var upload = await client.SendAsync(Signed(club.Key, EventsPath, new JsonObject
        {
            ["mac"] = mac,
            ["uptime_ms"] = 120000,
            ["events"] = new JsonArray(new JsonObject
            {
                ["seq"] = 1,
                ["uptime_ms"] = 60000,
                ["kind"] = "activation",
                ["court"] = 0,
                ["method"] = "qr",
                ["subject"] = bookingCode,
                ["duration_ms"] = 2700000,
            }),
        }));

        Assert.Equal(HttpStatusCode.OK, upload.StatusCode);
        Assert.Equal(1, (await BodyAsync(upload)).GetProperty("accepted_through").GetInt64());

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        Assert.Null((await db.Bookings.IgnoreQueryFilters().SingleAsync(b => b.Id == booking.Id)).CheckedInAt);
        Assert.Empty(await db.LedgerEntries.IgnoreQueryFilters().Where(l => l.TenantId == club.TenantId).ToListAsync());

        var actions = await db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == club.TenantId).Select(a => a.Action).ToListAsync();
        Assert.Contains($"device.activation_{GateAccess.NotACourtBox}", actions);
    }

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

    /// <summary>
    /// An offline open: receipted, audited, and named. The subject is resolved at the scan's
    /// own time rather than the upload's, so a code that has since expired still identifies
    /// the member who held it up — the audit row is the ONLY record a door leaves, so an
    /// anonymous one answers nothing anybody will ask.
    /// </summary>
    [SkippableFact]
    public async Task An_offline_gate_open_is_receipted_and_names_the_member_without_checking_them_in()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", DefaultSettings);
        var client = factory.CreateClient();
        var mac = await GateAsync(factory, club, client);

        // A booking that ended an hour ago, and a code that died with it. Judged at the
        // upload clock it resolves to nobody; judged at the scan it names the member.
        var booking = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(-105));
        var bookingCode = await BookingCodeAsync(factory, club, booking);

        var upload = await client.SendAsync(Signed(club.Key, EventsPath, new JsonObject
        {
            ["mac"] = mac,
            ["uptime_ms"] = 3_600_000,
            ["events"] = new JsonArray(new JsonObject
            {
                ["seq"] = 9,
                ["uptime_ms"] = 600_000,      // an hour before the upload
                ["kind"] = DeviceEventEndpoints.GateOpenKind,
                ["court"] = -1,
                ["method"] = "qr",
                ["subject"] = bookingCode,
                ["duration_ms"] = 3000,
            }),
        }));

        Assert.Equal(HttpStatusCode.OK, upload.StatusCode);
        Assert.Equal(9, (await BodyAsync(upload)).GetProperty("accepted_through").GetInt64());

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        var receipt = Assert.Single(await db.DeviceEventReceipts.IgnoreQueryFilters()
            .Where(r => r.TenantId == club.TenantId).ToListAsync());
        Assert.Equal(DeviceEventEndpoints.GateOpenKind, receipt.Kind);

        // -1 is the wire's "no relay", and a gate_open receipt must carry no booking either:
        // a later `release` pairs on (device, relay, booking) and would otherwise re-price a
        // court from a doorway.
        Assert.Null(receipt.Court);
        Assert.Null(receipt.BookingId);

        var audit = Assert.Single(await db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == club.TenantId && a.Action == $"device.{DeviceEventEndpoints.GateOpenKind}")
            .ToListAsync());
        Assert.Equal(club.MemberId, audit.SubjectUserId);

        // One row, not two: the outcome is `ok`, so there is no device.gate_open_<code> row.
        Assert.Empty(await db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == club.TenantId && a.Action.StartsWith("device.gate_open_")).ToListAsync());

        // And nothing was settled.
        Assert.Null((await db.Bookings.IgnoreQueryFilters().SingleAsync(b => b.Id == booking.Id)).CheckedInAt);
        Assert.Empty(await db.LedgerEntries.IgnoreQueryFilters().Where(l => l.TenantId == club.TenantId).ToListAsync());
    }

    /// <summary>
    /// <b>The mirror of <c>not_a_court_box</c>, and it was missing.</b> A <c>gate_open</c>
    /// uploaded by a COURT BOX row is receipted and acknowledged like any other event the
    /// board cannot change, but its outcome is <c>not_a_gate</c> and its audit row names
    /// nobody.
    ///
    /// <para>
    /// The activation and release kinds have been guarded by the board's kind since the gate
    /// landed; <c>gate_open</c> had no such guard, so a court box — or anything else holding
    /// the club key with a box's MAC — could post an arbitrary access code and have the server
    /// write <c>device.gate_open</c> naming whoever that code identified. Nothing settles on
    /// that row, so no money moved; what it produced was a door-opening record, attributed to
    /// a member, for a door that does not exist.
    /// </para>
    ///
    /// <para>
    /// Both boards are driven here with the SAME event and the SAME code, which is what makes
    /// the assertion discriminate: one names the member and one does not, so a fix that simply
    /// stopped naming anybody would fail the gate half.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_gate_open_uploaded_by_a_court_box_names_nobody_and_says_not_a_gate()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", DefaultSettings);
        var client = factory.CreateClient();

        var gateMac = await GateAsync(factory, club, client);
        var boxMac = NewMac();
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Heartbeat(club.Key, boxMac))).StatusCode);

        var booking = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(-5));
        var bookingCode = await BookingCodeAsync(factory, club, booking);

        var atGate = await client.SendAsync(Signed(club.Key, EventsPath, GateOpenBatch(gateMac, bookingCode, 11)));
        var atBox = await client.SendAsync(Signed(club.Key, EventsPath, GateOpenBatch(boxMac, bookingCode, 12)));

        // Acknowledged on both, because an event a board cannot change is a board retrying
        // for ever — the refusal is in the outcome, never in the status.
        Assert.Equal(HttpStatusCode.OK, atGate.StatusCode);
        Assert.Equal(HttpStatusCode.OK, atBox.StatusCode);
        Assert.Equal(12, (await BodyAsync(atBox)).GetProperty("accepted_through").GetInt64());

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var (gateId, boxId) = await IdsAsync(factory, gateMac, boxMac);

        var rows = await db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == club.TenantId && a.Action.StartsWith("device.gate_open"))
            .ToListAsync();

        // The gate's open is the control: same code, same instant, and it DOES name the member.
        var fromGate = Assert.Single(rows, a =>
            a.Action == $"device.{DeviceEventEndpoints.GateOpenKind}" && Names(a, gateId));
        Assert.Equal(club.MemberId, fromGate.SubjectUserId);

        var fromBox = Assert.Single(rows, a =>
            a.Action == $"device.{DeviceEventEndpoints.GateOpenKind}" && Names(a, boxId));
        Assert.Null(fromBox.SubjectUserId);

        // …and the refusal is named, exactly as an activation from a gate is.
        var refusal = Assert.Single(rows, a =>
            a.Action == $"device.{DeviceEventEndpoints.GateOpenKind}_{GateAccess.NotAGate}");
        Assert.True(Names(refusal, boxId), "the not_a_gate row must belong to the court box");
        Assert.Null(refusal.SubjectUserId);

        // A receipt each, and nothing settled by either.
        Assert.Equal(2, await db.DeviceEventReceipts.IgnoreQueryFilters().CountAsync(r => r.TenantId == club.TenantId));
        Assert.Null((await db.Bookings.IgnoreQueryFilters().SingleAsync(b => b.Id == booking.Id)).CheckedInAt);
        Assert.Empty(await db.LedgerEntries.IgnoreQueryFilters().Where(l => l.TenantId == club.TenantId).ToListAsync());
    }

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

    /// <summary>A gate_open whose token resolves to nobody is still recorded — the door still opened.</summary>
    [SkippableFact]
    public async Task An_offline_gate_open_with_an_unresolvable_token_is_still_recorded()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", DefaultSettings);
        var client = factory.CreateClient();
        var mac = await GateAsync(factory, club, client);

        var upload = await client.SendAsync(Signed(club.Key, EventsPath, new JsonObject
        {
            ["mac"] = mac,
            ["uptime_ms"] = 120000,
            ["events"] = new JsonArray(new JsonObject
            {
                ["seq"] = 3,
                ["uptime_ms"] = 60000,
                ["kind"] = DeviceEventEndpoints.GateOpenKind,
                ["court"] = -1,
                ["method"] = "qr",
                ["subject"] = "ZZZZZZZZZZZZ",
                ["duration_ms"] = 3000,
            }),
        }));

        Assert.Equal(HttpStatusCode.OK, upload.StatusCode);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var audit = Assert.Single(await db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == club.TenantId && a.Action == $"device.{DeviceEventEndpoints.GateOpenKind}")
            .ToListAsync());
        Assert.Null(audit.SubjectUserId);
    }

    // ---- The admin surface ----------------------------------------------------

    /// <summary>
    /// <c>gate_key</c> is settable on a gate, trimmed, cleared by an empty string, refused on
    /// a court box, and refused past the column's width. <c>court_numbers</c> and
    /// <c>button_map</c> are refused on a gate rather than silently dropped, which is what
    /// they were before: a PATCH that reports success while changing nothing leaves the admin
    /// believing the courts are assigned and the row saying otherwise.
    /// </summary>
    [SkippableFact]
    public async Task The_admin_patch_holds_each_kind_to_its_own_fields()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", DefaultSettings);
        var deviceClient = factory.CreateClient();
        var gateMac = await GateAsync(factory, club, deviceClient);
        var boxMac = NewMac();
        Assert.Equal(HttpStatusCode.OK, (await deviceClient.SendAsync(Heartbeat(club.Key, boxMac))).StatusCode);

        var (gateId, boxId) = await IdsAsync(factory, gateMac, boxMac);
        var admin = await AdminClientAsync(factory, club);

        // Trimmed on the way in.
        var named = await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{gateId}", new { gate_key = "  front-door  " });
        Assert.Equal(HttpStatusCode.OK, named.StatusCode);
        Assert.Equal("front-door", (await BodyAsync(named)).GetProperty("gate_key").GetString());

        // An empty string clears it; there is no third value to distinguish.
        var cleared = await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{gateId}", new { gate_key = "" });
        Assert.Equal(JsonValueKind.Null, (await BodyAsync(cleared)).GetProperty("gate_key").ValueKind);

        // Past the column's width, refused rather than truncated.
        var tooLong = await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{gateId}",
            new { gate_key = new string('d', Device.GateKeyMaxLength + 1) });
        Assert.Equal(HttpStatusCode.BadRequest, tooLong.StatusCode);
        Assert.Equal(AdminDeviceEndpoints.GateKeyTooLong, (await BodyAsync(tooLong)).GetProperty("error").GetString());

        // A door's name on a court box.
        var wrongKind = await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{boxId}", new { gate_key = "front-door" });
        Assert.Equal(HttpStatusCode.BadRequest, wrongKind.StatusCode);
        Assert.Equal(AdminDeviceEndpoints.GateKeyNotAGate, (await BodyAsync(wrongKind)).GetProperty("error").GetString());

        // Court fields on a door — including an explicit null button_map, which on a box is
        // the real instruction "run the club's map" and on a gate is as wrong as a list.
        foreach (var body in new object[]
        {
            new { court_numbers = new[] { 1 } },
            new { button_map = new[] { "court:A", "court:B", "court:C", "court:D", "minutes:15", "minutes:30", "minutes:45", "minutes:60" } },
            new { button_map = (string[]?)null },
        })
        {
            var refused = await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{gateId}", body);
            Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
            Assert.Equal(AdminDeviceEndpoints.CourtFieldsOnAGate, (await BodyAsync(refused)).GetProperty("error").GetString());
        }

        // The name and the switch still work on a gate; refusing the court fields must not
        // have refused the row.
        var renamed = await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{gateId}", new { name = "Front door", enabled = false });
        Assert.Equal(HttpStatusCode.OK, renamed.StatusCode);
        Assert.Equal("Front door", (await BodyAsync(renamed)).GetProperty("name").GetString());
    }

    /// <summary>
    /// <c>kind</c> is not editable at all. A row that could change kind would keep a court
    /// list it can no longer use, or acquire one it never had; deleting the row and letting
    /// the board re-register is the reset.
    /// </summary>
    [SkippableFact]
    public async Task A_patch_cannot_change_a_boards_kind()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", DefaultSettings);
        var deviceClient = factory.CreateClient();
        var gateMac = await GateAsync(factory, club, deviceClient);
        var (gateId, _) = await IdsAsync(factory, gateMac, gateMac);
        var admin = await AdminClientAsync(factory, club);

        var response = await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{gateId}", new { kind = "CourtBox", name = "Nice try" });

        // The unknown field is ignored by the binder, so the PATCH succeeds — and the kind
        // is exactly what it was. Asserting the ROW rather than the status is the point: a
        // 200 here does not mean nothing changed.
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("Gate", (await BodyAsync(response)).GetProperty("kind").GetString());

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        Assert.Equal(DeviceKind.Gate, (await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == gateMac)).Kind);
    }

    private static async Task<(Guid Gate, Guid Box)> IdsAsync(TestWebAppFactory factory, string gateMac, string boxMac)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var gate = await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == gateMac);
        var box = await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == boxMac);
        return (gate.Id, box.Id);
    }

    /// <summary>An admin JWT for this club, minted the way <c>AdminSettingsHttpTests</c> does.</summary>
    private static async Task<HttpClient> AdminClientAsync(TestWebAppFactory factory, Club club)
    {
        Guid adminId;
        using (var scope = factory.Services.CreateScope())
        {
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
                MemberClass = MemberClass.Regular,
            });
            await db.SaveChangesAsync();
            adminId = admin.Id;
        }

        var token = new System.IdentityModel.Tokens.Jwt.JwtSecurityToken(
            issuer: "crusaders.mainframe",
            audience: "crusaders.mainframe.app",
            claims:
            [
                new System.Security.Claims.Claim(
                    System.IdentityModel.Tokens.Jwt.JwtRegisteredClaimNames.Sub, adminId.ToString()),
                new System.Security.Claims.Claim("tenant_id", club.TenantId.ToString()),
                new System.Security.Claims.Claim("tenant_slug", club.Slug),
                new System.Security.Claims.Claim("purpose", "access"),
                new System.Security.Claims.Claim(System.Security.Claims.ClaimTypes.Role, "admin"),
            ],
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
