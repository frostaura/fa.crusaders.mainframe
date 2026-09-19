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

    /// <summary>
    /// <b>The barred-member filter, on real Postgres, on BOTH roster builders.</b>
    ///
    /// <para>
    /// Both builders carry the same inline membership subquery —
    /// <c>!db.Memberships.Any(m =&gt; m.UserId == b.UserId &amp;&amp; m.Status != Active)</c> — written out
    /// longhand rather than as the captured <c>MembershipAccess</c> expression, because a
    /// captured expression does not translate inside a subquery. That is a provider-shaped
    /// workaround, and every test that exercised it ran against the EF <b>in-memory</b>
    /// provider, which evaluates the whole predicate in C# and would have been perfectly happy
    /// with the captured form too. So the one thing the longhand exists for — that Npgsql can
    /// translate it — was pinned nowhere.
    /// </para>
    ///
    /// <para>
    /// A filter that throws, or that silently degrades to a client evaluation, is a suspension
    /// that holds only while the gate can reach the API — and the window in which a club most
    /// wants it to hold is the one where nobody is watching. Driven through the real heartbeat
    /// route, with the member Active first, so an empty roster cannot be an empty fixture.
    /// </para>
    /// </summary>
    [SkippableTheory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task A_barred_members_booking_is_filtered_out_on_real_postgres(bool gate)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", DefaultSettings);
        var client = factory.CreateClient();

        var mac = gate
            ? await GateAsync(factory, club, client, "front-door")
            : await CourtBoxAsync(club, client);

        await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(20));

        // The control: while the membership is Active the code is pushed, so the assertion
        // below is the filter and not an empty club.
        var kind = gate ? DeviceKinds.Gate : null;
        var whileActive = await RosterAsync(client, club, mac, kind);
        Assert.Single(whileActive);

        await SuspendAsync(factory, club);

        Assert.Empty(await RosterAsync(client, club, mac, kind));

        // …and the code itself still exists. The roster dropped it; nothing revoked it, which
        // is what keeps a court box deciding offline from a roster fetched beforehand honest.
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        Assert.NotNull(await db.AccessCodes.IgnoreQueryFilters()
            .FirstOrDefaultAsync(c => c.TenantId == club.TenantId && c.Code == whileActive[0].Split('|')[0]));
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

    /// <summary>
    /// <b>A hand-edited settings column emptied every door's cache in the club, silently.</b>
    ///
    /// <para>
    /// G2's B1 clamped the three numbers the online decision reads and left both roster
    /// builders reading the window raw. <c>TenantSettingsAccessor.TryInt</c> bounds nothing on
    /// the way in, so <c>roster_window_minutes: -600</c> produced a `latestStart` ten hours in
    /// the past and matched no booking at all: a clean 200, a present-and-empty <c>roster</c>
    /// key, no error and no log — and every door in the club admitting nobody the moment its
    /// link dropped. The failure mode the clamp exists for is exactly this one, because a
    /// value the PUT would refuse still reaches the reader.
    /// </para>
    ///
    /// <para>
    /// Both builders, in one test, because they are two copies of the same arithmetic and the
    /// court box's is the one that turns lights on.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_hand_edited_roster_window_cannot_silently_empty_a_boards_cache()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", NegativeRosterWindowSettings);
        var client = factory.CreateClient();
        var gateMac = await GateAsync(factory, club, client, "front-door");
        var boxMac = await CourtBoxAsync(club, client);

        // Ten minutes out, which is inside BOTH clamped windows and outside a ten-hour
        // negative one. The two builders reach differently — a gate adds the entry window
        // (5 + 30) and a box the lights-on cue (5 + 10) — so the booking has to clear the
        // narrower of the two for this to say anything about both.
        await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(10));

        Assert.Single(await RosterAsync(client, club, gateMac, DeviceKinds.Gate));
        Assert.Single(await RosterAsync(client, club, boxMac, null));
    }

    /// <summary>
    /// <b>A board nobody has named gets no roster.</b> Online scans work from its first
    /// heartbeat, so the install stays plug-and-play; the offline fallback starts when an
    /// admin names the door.
    ///
    /// <para>
    /// Auto-registration is the whole provisioning story: anything holding the club's device
    /// key can heartbeat with a MAC it invented and a <c>kind</c> of <c>gate</c>, and a row
    /// appears. Before this, that one call was answered with the club's live access codes for
    /// every booking in the roster window — forty-eight of them, each of which opens every
    /// door in the club for the length of its booking. Naming the door is the admin's
    /// acknowledgement that the board is one of theirs, and it is the cheapest possible gate
    /// on the only call that hands out credentials.
    /// </para>
    ///
    /// <para>
    /// The same board, the same booking and the same request either side of the PATCH is what
    /// makes this discriminate: the roster is empty because the door has no name, not because
    /// there was nothing to send.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task An_unnamed_gate_is_pushed_no_roster_until_an_admin_names_the_door()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", DefaultSettings);
        var client = factory.CreateClient();
        var mac = await GateAsync(factory, club, client);
        await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(20));

        var unnamed = await BodyAsync(await client.SendAsync(Heartbeat(club.Key, mac, DeviceKinds.Gate)));

        // Present and empty, never absent: the firmware replaces its cache wholesale, and an
        // omitted key would leave whatever it already held live.
        Assert.Equal(JsonValueKind.Array, unnamed.GetProperty("roster").ValueKind);
        Assert.Empty(unnamed.GetProperty("roster").EnumerateArray());
        Assert.Equal(JsonValueKind.Null, unnamed.GetProperty("gate_key").ValueKind);

        // …and the door still works online from the first heartbeat, which is what keeps the
        // install plug-and-play. Only the OFFLINE fallback waits for the admin.
        var token = await IdentCodeAsync(factory, club.TenantId, club.MemberId);
        Assert.True((await BodyAsync(await client.SendAsync(Scan(club.Key, mac, token)))).GetProperty("opened").GetBoolean());

        var (gateId, _) = await IdsAsync(factory, mac, mac);
        var admin = await AdminClientAsync(factory, club);
        Assert.Equal(HttpStatusCode.OK,
            (await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{gateId}", new { gate_key = "front-door" })).StatusCode);

        var named = await BodyAsync(await client.SendAsync(Heartbeat(club.Key, mac, DeviceKinds.Gate)));
        Assert.Equal("front-door", named.GetProperty("gate_key").GetString());
        var entry = Assert.Single(named.GetProperty("roster").EnumerateArray().Select(e => e.GetString()!));
        Assert.Matches(DeviceProtocolCorpusTests.RosterEntryPattern, entry);
    }

    /// <summary>
    /// <b>Auto-registration is unbounded, and unbounded is a resource anybody with the club
    /// key can spend.</b>
    ///
    /// <para>
    /// Every invented MAC that heartbeats leaves a permanent row: on the Devices page, in the
    /// audit trail as <c>device.auto_registered</c>, and — until the fix beside this one — in
    /// every admin's inbox as soon as it went quiet. The rate limit is the only ceiling, which
    /// is thousands of rows an hour. Nothing deletes them but an admin, one at a time.
    /// </para>
    ///
    /// <para>
    /// So a club may hold at most <see cref="DeviceRegistryService.MaxUnacknowledgedDevices"/>
    /// boards nobody has looked at. It is deliberately a count of the UNACKNOWLEDGED rather
    /// than of all rows: a club with forty real boards is never near it, and the way out is
    /// the thing an admin was going to do anyway — open the page and edit or delete the rows
    /// that appeared. A cap on the total would eventually stop a real installation.
    /// </para>
    ///
    /// <para>
    /// <b>409 and not 403.</b> A 403 on this route group means one thing and one thing only —
    /// this board is out of service — and the firmware acts on that word: it commits an empty
    /// roster and stops falling back. A registration refusal answered 403 would take every
    /// door in the club out of service the moment somebody flooded the registry, which is a
    /// far worse outcome than the flood. `DeviceForbiddenMeansOutOfServiceTests` pins the
    /// converse; this pins the case that would have broken it.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_club_cannot_be_filled_with_boards_nobody_has_acknowledged()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", DefaultSettings);
        var client = factory.CreateClient();

        var macs = new List<string>();
        for (var i = 0; i < DeviceRegistryService.MaxUnacknowledgedDevices; i++)
        {
            var mac = NewMac();
            macs.Add(mac);
            Assert.Equal(HttpStatusCode.OK,
                (await client.SendAsync(Heartbeat(club.Key, mac, i % 2 == 0 ? DeviceKinds.Gate : null))).StatusCode);
        }

        // The one after the cap is refused — and the refusal is 409, never 403.
        var flooded = await client.SendAsync(Heartbeat(club.Key, NewMac(), DeviceKinds.Gate));
        Assert.Equal(HttpStatusCode.Conflict, flooded.StatusCode);
        Assert.Equal(
            DeviceRegistryService.TooManyUnacknowledgedDevices,
            (await BodyAsync(flooded)).GetProperty("error").GetString());

        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Assert.Equal(
                DeviceRegistryService.MaxUnacknowledgedDevices,
                await db.Devices.IgnoreQueryFilters().CountAsync(d => d.TenantId == club.TenantId));
        }

        // The boards that DID register are unaffected: the cap is on creating a row, never on
        // serving one. A club at its limit must not have its installed doors stop working.
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Heartbeat(club.Key, macs[0], DeviceKinds.Gate))).StatusCode);

        // The probe: ONE admin edit, which is what clears AutoRegistered, and the next board
        // registers. The way out is the thing the admin was going to do anyway.
        var admin = await AdminClientAsync(factory, club);
        Guid firstId;
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            firstId = (await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == macs[0])).Id;
        }
        Assert.Equal(HttpStatusCode.OK,
            (await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{firstId}", new { gate_key = "front-door" })).StatusCode);

        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Heartbeat(club.Key, NewMac(), DeviceKinds.Gate))).StatusCode);
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
    /// <b>A board an admin has taken out of service is 403 on the heartbeat as well as on the
    /// scan</b>, which is what makes 403 authoritative for a gate: the firmware treats it as
    /// "the club has withdrawn this board" and denies the scan outright rather than falling
    /// back to its roster, and a 403 on the heartbeat commits an empty roster.
    ///
    /// <para>
    /// It is worth its own pin because it is the one refusal a gate must NOT recover from.
    /// Every other failure — a timeout, a 401, a 404, a 5xx, a malformed 200 — means the
    /// server could not be reached or could not answer, and the board is right to fall back.
    /// A 403 is the club speaking.
    /// </para>
    ///
    /// <para>
    /// <b>And the residual is real, so it is stated rather than implied:</b> this only reaches
    /// a board that can still reach us. A gate that has been cut off entirely never hears the
    /// 403 and goes on admitting whatever its cached roster still carries, for up to the six
    /// hours until that roster goes stale. Taking a door out of service is not the same as
    /// locking it.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_gate_taken_out_of_service_is_refused_on_the_heartbeat_too()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", DefaultSettings);
        var client = factory.CreateClient();
        var mac = await GateAsync(factory, club, client, "front-door");
        var token = await IdentCodeAsync(factory, club.TenantId, club.MemberId);

        // The control: in service, both routes answer.
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Heartbeat(club.Key, mac, DeviceKinds.Gate))).StatusCode);
        Assert.True((await BodyAsync(await client.SendAsync(Scan(club.Key, mac, token)))).GetProperty("opened").GetBoolean());

        var (gateId, _) = await IdsAsync(factory, mac, mac);
        var admin = await AdminClientAsync(factory, club);
        Assert.Equal(HttpStatusCode.OK,
            (await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{gateId}", new { enabled = false })).StatusCode);

        Assert.Equal(HttpStatusCode.Forbidden, (await client.SendAsync(Heartbeat(club.Key, mac, DeviceKinds.Gate))).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.SendAsync(Scan(club.Key, mac, token))).StatusCode);

        // Not re-registered around the switch: the row is still there and still disabled, so
        // the board cannot get back in by pretending to be new.
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var row = await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == mac);
        Assert.False(row.Enabled);
        Assert.NotNull(row.OutOfServiceSince);
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

        // BOTH doors are named, and that is now part of the fixture rather than decoration:
        // an unnamed gate is pushed an empty roster whatever the club has booked, so a pair of
        // unnamed gates would make this pass for the wrong reason — the emptiness at alpha has
        // to be the tenant filter and not the naming rule.
        var alphaGate = await GateAsync(factory, alpha, client, "alpha-front");
        var bravoGate = await GateAsync(factory, bravo, client, "bravo-front");

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
    /// <b>Club admins always pass</b>, over the wire, holding an ordinary Active membership
    /// and nothing booked.
    ///
    /// <para>
    /// The exemption used to be keyed on having NO membership row, and no production path
    /// creates such an account — registration writes one and an admin promoted from the member
    /// roll keeps theirs. So the day a club switched to <c>booking_window</c> its own staff
    /// were locked out of the building, and the test that claimed otherwise passed only
    /// because it deleted the row first.
    /// </para>
    ///
    /// <para>
    /// The ordinary member on the same club, same policy, same instant is the probe: one
    /// field differs between the two scans and it is <c>IsAdmin</c>.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_club_admin_with_a_membership_and_no_booking_still_opens_the_door()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", BookingWindowSettings);
        var client = factory.CreateClient();
        var mac = await GateAsync(factory, club, client);

        var adminId = await AdminUserAsync(factory, club);
        var adminToken = await IdentCodeAsync(factory, club.TenantId, adminId);
        var memberToken = await IdentCodeAsync(factory, club.TenantId, club.MemberId);

        // The ordinary member, with the same Active membership and nothing booked, is out.
        await AssertRefusedAsync(client, Scan(club.Key, mac, memberToken), GateAccess.NoBooking);

        var opened = await BodyAsync(await client.SendAsync(Scan(club.Key, mac, adminToken)));
        Assert.True(opened.GetProperty("opened").GetBoolean(),
            "a club admin must not be locked out of the building by the booking_window policy");
        Assert.Equal(GateAccess.Ok, opened.GetProperty("reason").GetString());
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
            MemberClass = MemberClass.Regular,
        });
        await db.SaveChangesAsync();
        return admin.Id;
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

    /// <summary>
    /// <b><c>too_early</c> on the wire</b>, as a 200 like every other refusal, with a zero
    /// release — and the audit row that names it.
    ///
    /// <para>
    /// The same booking code, the same door, and the only thing that moves between the two
    /// halves is the booking's distance from now.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_booking_code_presented_too_early_is_refused_as_a_200_and_audited()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", BookingWindowSettings);
        var client = factory.CreateClient();
        var mac = await GateAsync(factory, club, client, "front-door");

        // Six hours out, against a thirty-minute entry window.
        var early = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddHours(6));
        await AssertRefusedAsync(
            client, Scan(club.Key, mac, await BookingCodeAsync(factory, club, early)), GateAccess.TooEarly);

        // Twenty minutes out is inside it, and the same member's own booking code opens the
        // door — so the refusal above is the window and not the code.
        var due = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(20));
        Assert.True((await BodyAsync(await client.SendAsync(
            Scan(club.Key, mac, await BookingCodeAsync(factory, club, due))))).GetProperty("opened").GetBoolean());

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var denial = Assert.Single(await db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == club.TenantId
                        && a.Action == $"{DeviceGateEndpoint.DeniedActionPrefix}{GateAccess.TooEarly}")
            .ToListAsync());

        // Named, because a refusal that says who was turned away is the whole value of the row.
        Assert.Equal(club.MemberId, denial.SubjectUserId);
    }

    /// <summary>
    /// <b>The window the phone shows a booking code in and the window the door accepts it in
    /// are the same window</b>, driven here through both real routes.
    ///
    /// <para>
    /// <c>POST /me/qr/generate?kind=auto</c> is the member's screen and
    /// <c>POST /device/gate</c> is the door. Under the default policy they must agree: a door
    /// narrower than the screen refuses a code the product has just handed somebody, and a
    /// door wider than the screen is the standing building key this whole rule exists to end.
    /// They were two independent rearrangements of one predicate in two files.
    /// </para>
    ///
    /// <para>
    /// <b>This fails if either side changes alone</b>, which is the point of driving both
    /// rather than asserting the shared function twice. Widen the door and the far booking
    /// opens it while the phone still says <c>ident</c>; narrow it and the near booking is
    /// refused while the phone is showing its code. Move the phone's horizon and the two
    /// <c>kind</c> assertions go the other way.
    /// </para>
    ///
    /// <para>
    /// The horizon is <c>roster_window_minutes + activation_cue_window_minutes</c> = 130
    /// minutes here, and the two bookings sit ten minutes either side of it. The margin is
    /// deliberately not tighter: the minute-precision of each edge is carried by
    /// <c>DeviceGateTests.A_booking_code_opens_a_door_only_inside_its_own_bookings_window</c>
    /// against a threaded clock, and what this test is for is the AGREEMENT between two
    /// routes that each read <c>UtcNow</c> for themselves. They also have to be short enough
    /// not to overlap: one court, and the exclusion constraint is real here.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task The_door_accepts_a_booking_code_exactly_while_the_phone_would_show_it()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", SharedHorizonSettings);
        var device = factory.CreateClient();
        var mac = await GateAsync(factory, club, device, "front-door");
        var phone = MemberClient(factory, club);

        // Beyond the horizon: the phone will not show this booking's code at all.
        var far = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(140), minutes: 15);
        var farCode = await BookingCodeAsync(factory, club, far);

        var outOfReach = await GenerateAsync(phone);
        Assert.Equal("ident", outOfReach.GetProperty("kind").GetString());
        Assert.NotEqual(farCode, outOfReach.GetProperty("code").GetString());

        // …and the door agrees, to the same minute.
        await AssertRefusedAsync(device, Scan(club.Key, mac, farCode), GateAccess.TooEarly);

        // Inside it: the phone shows that booking's own code…
        var near = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(120), minutes: 15);
        var nearCode = await BookingCodeAsync(factory, club, near);

        var inReach = await GenerateAsync(phone);
        Assert.Equal("booking", inReach.GetProperty("kind").GetString());
        Assert.Equal(near.Id, inReach.GetProperty("booking_id").GetGuid());
        Assert.Equal(nearCode, inReach.GetProperty("code").GetString());

        // …and the door opens for exactly that code.
        Assert.True((await BodyAsync(await device.SendAsync(Scan(club.Key, mac, nearCode))))
            .GetProperty("opened").GetBoolean());
    }

    /// <summary>
    /// <b>The TOP edge, through both routes: the door is never narrower than the phone.</b>
    ///
    /// <para>
    /// The test above is the bottom edge; this is the other end, and the two are not
    /// symmetric. The phone stops offering a booking's code at <c>EndsAt</c>; the door goes on
    /// accepting it until the code itself expires, which is <c>EndsAt</c> plus the grace
    /// window. A member whose court has just finished is therefore still holding a code that
    /// works on the way out and back in — and, critically, so is a member the no-show sweep is
    /// about to write off, since the grace window is precisely how long the product waits
    /// before deciding somebody did not come.
    /// </para>
    ///
    /// <para>
    /// Narrower would be the product refusing a credential it minted and has not yet expired.
    /// The DIRECTION is what is asserted rather than the exact gap, because the gap is the
    /// club's own <c>grace_window_minutes</c>.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task The_door_still_opens_on_a_code_the_phone_has_stopped_offering()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", SharedHorizonSettings);
        var device = factory.CreateClient();
        var mac = await GateAsync(factory, club, device, "front-door");
        var phone = MemberClient(factory, club);

        // A court that ended two minutes ago, against a five-minute grace window.
        var over = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(-17), minutes: 15);
        var code = await BookingCodeAsync(factory, club, over);

        // The phone has moved on: it offers an ident code, not this booking's.
        var screen = await GenerateAsync(phone);
        Assert.Equal("ident", screen.GetProperty("kind").GetString());
        Assert.NotEqual(code, screen.GetProperty("code").GetString());

        // The door has not. The code the club minted is still live, so it still opens.
        Assert.True((await BodyAsync(await device.SendAsync(Scan(club.Key, mac, code))))
            .GetProperty("opened").GetBoolean());
    }

    /// <summary>
    /// The default policy with the two horizon inputs stated rather than defaulted, because
    /// this is the one test whose arithmetic they decide: 120 + 10 = 130 minutes, against a
    /// thirty-minute entry window that the max leaves behind.
    /// </summary>
    private const string SharedHorizonSettings =
        """{"slice_minutes":15,"day_start_minute":0,"day_end_minute":1440,"grace_window_minutes":5,"timezone":"UTC","roster_window_minutes":120,"activation_cue_window_minutes":10,"gate_early_entry_minutes":30,"gate_access_policy":"active_member"}""";

    /// <summary>
    /// <b>The member's page cannot tell the truth about doors without being told.</b>
    ///
    /// <para>
    /// The Court Code screen says what the code in the member's hand will do, and since the
    /// gate shipped it has been wrong: a booking code also opens the club door, from
    /// `StartsAt − H` until shortly after the booking ends, and the page said nothing about
    /// it. The page cannot work that out for itself either — `H` is
    /// `max(gate_early_entry, min(roster + cue, 240))` under one policy and something else
    /// under the other, and the three settings behind it are not on a member's API surface
    /// and should not be. So the server, which already computes it for the door, says it.
    /// </para>
    ///
    /// <para>
    /// <c>doors</c> is separate from the two instants because it answers a different question:
    /// whether this club has doors at all. A club with none must have a page that says nothing
    /// about them rather than one saying "it opens the door" about a building with no
    /// controller in it.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task The_member_screen_is_told_what_its_code_does_at_a_door()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", SharedHorizonSettings);
        var device = factory.CreateClient();
        var phone = MemberClient(factory, club);

        // No gate row yet: the club has no doors, and the page must say nothing about them.
        var noDoors = await GenerateAsync(phone);
        Assert.False(noDoors.GetProperty("doors").GetBoolean());
        Assert.Equal(JsonValueKind.Null, noDoors.GetProperty("door_opens_at").ValueKind);
        Assert.Equal(JsonValueKind.Null, noDoors.GetProperty("door_closes_at").ValueKind);

        var mac = await GateAsync(factory, club, device, "front-door");

        // Still an ident code — no booking in reach — so the door instants stay null, because
        // a sixty-second ident code has no booking window of its own.
        var ident = await GenerateAsync(phone);
        Assert.Equal("ident", ident.GetProperty("kind").GetString());
        Assert.True(ident.GetProperty("doors").GetBoolean());
        Assert.Equal(JsonValueKind.Null, ident.GetProperty("door_opens_at").ValueKind);
        Assert.Equal(JsonValueKind.Null, ident.GetProperty("door_closes_at").ValueKind);

        // Now a booking inside the phone's horizon: the code becomes that booking's own, and
        // the two instants are the door's window for it.
        var booking = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(60));
        var screen = await GenerateAsync(phone);
        Assert.Equal("booking", screen.GetProperty("kind").GetString());
        Assert.True(screen.GetProperty("doors").GetBoolean());

        using var scope = factory.Services.CreateScope();

        // The tenant has to be set by hand: outside a request nothing has resolved one, and
        // the global query filter would then read every table as the empty tenant's — so the
        // code would resolve to nothing and the probe below would pass for the wrong reason.
        scope.ServiceProvider.GetRequiredService<Crusaders.Mainframe.Api.Multitenancy.ITenantContext>()
            .Set(club.TenantId, club.Slug);

        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var codes = scope.ServiceProvider.GetRequiredService<AccessCodeService>();
        var row = await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == mac);
        var live = await scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>().GetAsync(default);

        // Opens at StartsAt − H, and H is the DOOR's horizon: 130 minutes at these settings,
        // not the thirty-minute entry window. Asserted against the shared function over the
        // club's own live settings rather than against a literal, so the page and the door
        // cannot drift even in the test.
        var horizon = BookingCodeWindow.DoorHorizonMinutes(live);
        Assert.Equal(130, horizon);
        Assert.NotEqual(horizon, BookingCodeWindow.EntryWindowMinutes(live));

        Assert.Equal(
            booking.StartsAt.AddMinutes(-horizon),
            screen.GetProperty("door_opens_at").GetDateTimeOffset());

        // Closes when the CODE dies, which is the door's real upper edge — the slot's end plus
        // the grace window — and is deliberately later than the booking's own end.
        var closes = screen.GetProperty("door_closes_at").GetDateTimeOffset();
        Assert.Equal(booking.EndsAt.AddMinutes(live.GraceWindowMinutes), closes);
        Assert.True(closes > booking.EndsAt);

        // The probe: the code the page is showing really does open the door at
        // door_opens_at + a minute, and really does not a minute before it. One field, two
        // instants, and the door is asked rather than the arithmetic re-stated.
        var code = screen.GetProperty("code").GetString()!;
        var opensAt = screen.GetProperty("door_opens_at").GetDateTimeOffset();

        Assert.True((await GateAccess.DecideAsync(
            db, codes, new GateContext(row, live, "qr", code, opensAt.AddMinutes(1)), default)).Opened);
        Assert.Equal(GateAccess.TooEarly, (await GateAccess.DecideAsync(
            db, codes, new GateContext(row, live, "qr", code, opensAt.AddMinutes(-1)), default)).Reason);
    }

    /// <summary>
    /// A club whose only door is out of service has no doors as far as the member's page is
    /// concerned. The page's promise is "this will let you in", and a board the club has
    /// switched off will not — it is refused `403` on every route it calls.
    /// </summary>
    [SkippableFact]
    public async Task A_club_whose_only_door_is_out_of_service_has_no_doors_on_the_member_screen()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", DefaultSettings);
        var device = factory.CreateClient();
        var phone = MemberClient(factory, club);
        var mac = await GateAsync(factory, club, device, "front-door");

        Assert.True((await GenerateAsync(phone)).GetProperty("doors").GetBoolean());

        var (gateId, _) = await IdsAsync(factory, mac, mac);
        var admin = await AdminClientAsync(factory, club);
        Assert.Equal(HttpStatusCode.OK,
            (await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{gateId}", new { enabled = false })).StatusCode);

        Assert.False((await GenerateAsync(phone)).GetProperty("doors").GetBoolean());

        // The probe: a COURT BOX is not a door. A club with boxes and no gates has no doors.
        await CourtBoxAsync(club, device);
        Assert.False((await GenerateAsync(phone)).GetProperty("doors").GetBoolean());
    }

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

    /// <summary>
    /// The four-hour ceiling over the wire, at a club whose own phone horizon is two days.
    ///
    /// <para>
    /// <c>roster_window_minutes</c> and <c>activation_cue_window_minutes</c> are both at the
    /// maximum the settings PUT allows, which is a settings document an admin can produce
    /// through the console without touching the database. Before the clamp that summed to
    /// 2880 minutes and every booking code in the building was a forty-eight-hour door key,
    /// while <c>GateAccess.MaxEarlyEntryMinutes</c>, this spec and the console all said four
    /// hours.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task The_door_reaches_four_hours_however_wide_the_clubs_own_horizon_is()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", TwoDayHorizonSettings);
        var client = factory.CreateClient();
        var mac = await GateAsync(factory, club, client, "front-door");

        var beyond = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(250), minutes: 15);
        await AssertRefusedAsync(
            client, Scan(club.Key, mac, await BookingCodeAsync(factory, club, beyond)), GateAccess.TooEarly);

        // …and inside the ceiling the same club's door opens, so the refusal above is the
        // ceiling and not a door that has stopped working.
        var inside = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(230), minutes: 15);
        Assert.True((await BodyAsync(await client.SendAsync(
            Scan(club.Key, mac, await BookingCodeAsync(factory, club, inside))))).GetProperty("opened").GetBoolean());
    }

    /// <summary>The widest horizon the settings PUT will accept: a day of roster and a day of cue.</summary>
    private const string TwoDayHorizonSettings =
        """{"slice_minutes":15,"day_start_minute":0,"day_end_minute":1440,"grace_window_minutes":5,"timezone":"UTC","roster_window_minutes":1440,"activation_cue_window_minutes":1440,"activation_forward_window_minutes":1440,"gate_early_entry_minutes":30,"gate_access_policy":"active_member"}""";

    /// <summary>
    /// <b>The member walking back in for their next court, on the code from their last one.</b>
    ///
    /// <para>
    /// Over real Postgres rather than only against the in-memory provider, and that is not
    /// ceremony: the entitlement query bounds a booking by the slot it was SOLD —
    /// <c>StartsAt + SliceMinutes × SliceCount</c>, because the no-show sweep truncates
    /// <c>EndsAt</c> — and an expression the in-memory provider evaluates in C# is an
    /// expression Npgsql still has to translate to SQL. A query that throws at a door is
    /// indistinguishable from a door that does not work.
    /// </para>
    ///
    /// <para>
    /// The club runs a generous grace window, which is what keeps the earlier booking's code
    /// alive past its own slot: the row lives until <c>EndsAt</c> plus grace. That is the
    /// real shape of the complaint — a phone still showing the 17:00 QR at 18:50.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_spent_booking_code_opens_the_door_for_a_member_whose_next_court_is_due()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", SharedHorizonSettings);
        var client = factory.CreateClient();
        var mac = await GateAsync(factory, club, client, "front-door");

        // A court that ended ten minutes ago and has been promoted to `Completed` — which is
        // what `LightsCueWorker` does to an attended-and-over booking, so this is the shape a
        // member who PLAYED is left holding — and the next one starting in twenty. One court,
        // so they must not overlap: the exclusion constraint is real here. The code outlives
        // the promotion because nothing revokes one.
        var now = DateTimeOffset.UtcNow;
        var spentBooking = await BookAsync(factory, club, now.AddMinutes(-70), minutes: 60);
        var spent = await BookingCodeAsync(factory, club, spentBooking);

        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var row = await db.AccessCodes.IgnoreQueryFilters().SingleAsync(c => c.Code == spent);
            Assert.True(row.IsLiveAt(now), "the fixture must present a LIVE code, or this tests plain expiry");

            var played = await db.Bookings.IgnoreQueryFilters().SingleAsync(b => b.Id == spentBooking.Id);
            played.Status = BookingStatus.Completed;
            await db.SaveChangesAsync();
        }

        // Without the next booking the code is exactly as dead as it was.
        await AssertRefusedAsync(client, Scan(club.Key, mac, spent), GateAccess.NotRecognised);

        await BookAsync(factory, club, now.AddMinutes(20), minutes: 45);

        Assert.True((await BodyAsync(await client.SendAsync(Scan(club.Key, mac, spent))))
            .GetProperty("opened").GetBoolean());
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
    /// <b>The offline trail must not carry the code itself.</b>
    ///
    /// <para>
    /// §5 leaves the token out of <c>gate.opened</c> on purpose — a live access code in a
    /// trail an admin can read is a credential in a log — and the OFFLINE path wrote it in
    /// full, under <c>subject</c>, for a <c>gate_open</c> and an <c>unknown_scan</c> alike.
    /// Those are the bytes the member held up at the door: they open every door in the club
    /// for the length of that booking's window, and <c>RetentionWorker</c> anonymises a row's
    /// SUBJECT while never touching its <c>DetailsJson</c>, so they stayed readable for as
    /// long as the row did.
    /// </para>
    ///
    /// <para>
    /// A fingerprint rather than nothing, because the field was worth something: two scans of
    /// one code still correlate, so "the same badge tried the side door eleven times" remains
    /// answerable. The identity lives on <c>SubjectUserId</c>, which is asserted here too so
    /// the fix cannot be read as having thrown the identity away with the token.
    /// </para>
    /// </summary>
    [SkippableTheory]
    [InlineData(DeviceEventEndpoints.GateOpenKind)]
    [InlineData(DeviceEventEndpoints.UnknownScanKind)]
    public async Task An_offline_door_event_fingerprints_the_token_instead_of_logging_it(string kind)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", DefaultSettings);
        var client = factory.CreateClient();
        var mac = await GateAsync(factory, club, client);

        var booking = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(-105));
        var token = await BookingCodeAsync(factory, club, booking);

        // The same code twice, so the correlation property is asserted rather than assumed.
        var upload = await client.SendAsync(Signed(club.Key, EventsPath, new JsonObject
        {
            ["mac"] = mac,
            ["uptime_ms"] = 3_600_000,
            ["events"] = new JsonArray(
                DoorEvent(11, kind, token), DoorEvent(12, kind, token)),
        }));
        Assert.Equal(HttpStatusCode.OK, upload.StatusCode);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var rows = await db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == club.TenantId && a.Action == $"device.{kind}")
            .ToListAsync();
        Assert.Equal(2, rows.Count);

        var fingerprints = new List<string>();
        foreach (var row in rows)
        {
            Assert.DoesNotContain(token, row.DetailsJson, StringComparison.OrdinalIgnoreCase);

            var subject = JsonDocument.Parse(row.DetailsJson!).RootElement.GetProperty("subject").GetString()!;
            Assert.Equal(8, subject.Length);
            Assert.DoesNotContain(subject, token, StringComparison.OrdinalIgnoreCase);
            fingerprints.Add(subject);
        }

        // Two scans of one code still correlate, which is the only reason to keep the field.
        Assert.Equal(fingerprints[0], fingerprints[1]);

        // …and a DIFFERENT code fingerprints differently, so the field still discriminates.
        var other = await BookingCodeAsync(
            factory, club, await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(-200)));
        await client.SendAsync(Signed(club.Key, EventsPath, new JsonObject
        {
            ["mac"] = mac,
            ["uptime_ms"] = 3_600_000,
            ["events"] = new JsonArray(DoorEvent(13, kind, other)),
        }));

        var third = await db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == club.TenantId && a.Action == $"device.{kind}")
            .OrderBy(a => a.CreatedAt).ToListAsync();
        Assert.Equal(3, third.Count);
        Assert.DoesNotContain(
            JsonDocument.Parse(third[^1].DetailsJson!).RootElement.GetProperty("subject").GetString(),
            fingerprints);

        // The identity was not thrown away with the token: a resolvable gate_open still names
        // its member on the row itself.
        if (kind == DeviceEventEndpoints.GateOpenKind) Assert.Equal(club.MemberId, rows[0].SubjectUserId);
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

    /// <summary>
    /// <b>The fingerprint guard was keyed on the RAW <c>kind</c>, and every other decision on
    /// this route was keyed on the trimmed one.</b> A single space is the whole exploit.
    ///
    /// <para>
    /// <c>AuditKind</c> trims, so <c>" gate_open "</c> is stored, receipted and audited as
    /// <c>device.gate_open</c> — indistinguishable in the trail from an honest one. The
    /// subject guard did not: <c>e.Kind is not (GateOpenKind or UnknownScanKind)</c> is false
    /// for the padded spelling, so the branch fell through and wrote <b>the live access code
    /// in full</b> into <c>DetailsJson</c>. That is the exact credential-in-a-log the G2 fix
    /// removed, available to anything holding the club key by adding one character.
    /// </para>
    ///
    /// <para>
    /// The dispatch switch was keyed on the raw value too, which makes the same spelling a
    /// SECOND bypass: <c>GateOpenKind when device.Kind != Gate</c> never matched
    /// <c>" gate_open "</c>, so a COURT BOX could post a door open, skip the
    /// <c>not_a_gate</c> refusal that exists to stop a false record of who was in the
    /// building, and land in the <c>_ => null</c> arm with the token beside it.
    /// </para>
    ///
    /// <para>
    /// Upper case is the same hole by a different route — a scanner or a firmware branch that
    /// shouts — and it has a second cost the padding does not: it fragments the trail, because
    /// <c>device.GATE_OPEN</c> is a row the console's activity query does not find.
    /// </para>
    /// </summary>
    [SkippableTheory]
    [InlineData(" gate_open ")]
    [InlineData("GATE_OPEN")]
    [InlineData("Gate_Open")]
    [InlineData("\tunknown_scan\n")]
    [InlineData("UNKNOWN_SCAN")]
    public async Task A_door_event_kind_is_normalised_before_anything_is_decided_from_it(string spelling)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", DefaultSettings);
        var client = factory.CreateClient();
        var mac = await GateAsync(factory, club, client);

        var booking = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(-105));
        var token = await BookingCodeAsync(factory, club, booking);
        var canonical = spelling.Trim().ToLowerInvariant();

        var upload = await client.SendAsync(Signed(club.Key, EventsPath, new JsonObject
        {
            ["mac"] = mac,
            ["uptime_ms"] = 3_600_000,
            ["events"] = new JsonArray(DoorEvent(21, spelling, token)),
        }));
        Assert.Equal(HttpStatusCode.OK, upload.StatusCode);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        // The receipt and the audit row carry the canonical spelling, so the trail is one
        // stream rather than one per way of writing the word.
        var receipt = Assert.Single(await db.DeviceEventReceipts.IgnoreQueryFilters()
            .Where(r => r.TenantId == club.TenantId).ToListAsync());
        Assert.Equal(canonical, receipt.Kind);

        var row = Assert.Single(await db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == club.TenantId && a.Action == $"device.{canonical}").ToListAsync());

        // And the token is nowhere in it.
        Assert.DoesNotContain(token, row.DetailsJson, StringComparison.OrdinalIgnoreCase);
        var subject = JsonDocument.Parse(row.DetailsJson!).RootElement.GetProperty("subject").GetString()!;
        Assert.Equal(8, subject.Length);
    }

    /// <summary>
    /// The second half of the same bypass, stated as the refusal it defeats: a COURT BOX
    /// posting a door open must be told <c>not_a_gate</c> whatever spelling it uses.
    ///
    /// <para>
    /// The guard exists because the row this writes NAMES A MEMBER, and a false record of who
    /// was in the building is a worse artefact than a refusal. A guard a sender can step
    /// around by shouting is not a guard.
    /// </para>
    /// </summary>
    [SkippableTheory]
    [InlineData(" gate_open ")]
    [InlineData("GATE_OPEN")]
    public async Task A_court_box_cannot_post_a_door_open_by_respelling_the_kind(string spelling)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", DefaultSettings);
        var client = factory.CreateClient();
        var boxMac = await CourtBoxAsync(club, client);

        var booking = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(-105));
        var token = await BookingCodeAsync(factory, club, booking);

        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Signed(club.Key, EventsPath, new JsonObject
        {
            ["mac"] = boxMac,
            ["uptime_ms"] = 3_600_000,
            ["events"] = new JsonArray(DoorEvent(31, spelling, token)),
        }))).StatusCode);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var rows = await db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == club.TenantId && a.Action.StartsWith("device.gate_open")).ToListAsync();

        // The refusal is recorded, and the row names nobody.
        Assert.Contains(rows, a => a.Action == $"device.{DeviceEventEndpoints.GateOpenKind}_{GateAccess.NotAGate}");
        Assert.All(rows, a => Assert.Null(a.SubjectUserId));
        Assert.All(rows, a => Assert.DoesNotContain(token, a.DetailsJson, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>
    /// <b>A court box's own <c>activation</c> token is a door key too, and the trail wrote it
    /// in full.</b>
    ///
    /// <para>
    /// The G2 fix narrowed the fingerprint to the two DOOR kinds and said so in as many words:
    /// a court box's activation token "is the roster token for a booking the receipt already
    /// names, and narrowing it is a separate decision about the court-box trail". That
    /// reasoning was true when it was written and stopped being true the moment the gate
    /// shipped — since D2, that same roster token opens <b>every door in the club</b> for the
    /// length of its booking's window. The receipt naming the booking does not make the bytes
    /// less live.
    /// </para>
    ///
    /// <para>
    /// So the fingerprint is now unconditional. Resolution still uses the raw subject, in
    /// memory, where it never reaches a row: this asserts the activation was really applied —
    /// <c>CheckedInAt</c> stamped — so the fix cannot be read as having broken attendance to
    /// hide a token.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_court_boxs_activation_event_fingerprints_its_token_as_well()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", DefaultSettings);
        var client = factory.CreateClient();
        var boxMac = await CourtBoxAsync(club, client);

        var booking = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(-5));
        var token = await BookingCodeAsync(factory, club, booking);

        var activation = DoorEvent(41, DeviceEventEndpoints.ActivationKind, token);
        activation["court"] = 0;            // relay A, which this box drives for court 1
        activation["uptime_ms"] = 3_599_000; // a second before the upload, so the scan is inside the cue window

        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Signed(club.Key, EventsPath, new JsonObject
        {
            ["mac"] = boxMac,
            ["uptime_ms"] = 3_600_000,
            ["events"] = new JsonArray(activation),
        }))).StatusCode);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        // The control: the activation really was applied, so this is a fingerprint over a
        // token the handler resolved rather than one it failed to.
        Assert.NotNull((await db.Bookings.IgnoreQueryFilters().SingleAsync(b => b.Id == booking.Id)).CheckedInAt);

        var rows = await db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == club.TenantId && a.Action.StartsWith("device.activation")).ToListAsync();
        Assert.NotEmpty(rows);
        Assert.All(rows, a => Assert.DoesNotContain(token, a.DetailsJson, StringComparison.OrdinalIgnoreCase));
        Assert.All(rows, a => Assert.Equal(
            8, JsonDocument.Parse(a.DetailsJson!).RootElement.GetProperty("subject").GetString()!.Length));
    }

    /// <summary>
    /// A kind this server has never heard of is recorded as it was normalised — it is
    /// evidence, and the board cannot edit what it has queued — but its subject is
    /// fingerprinted like every other, because "we do not recognise this word" is not a reason
    /// to write a live credential into the trail.
    /// </summary>
    [SkippableFact]
    public async Task An_unknown_kind_is_recorded_as_normalised_and_still_fingerprinted()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", DefaultSettings);
        var client = factory.CreateClient();
        var mac = await GateAsync(factory, club, client);

        var booking = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(-105));
        var token = await BookingCodeAsync(factory, club, booking);

        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Signed(club.Key, EventsPath, new JsonObject
        {
            ["mac"] = mac,
            ["uptime_ms"] = 3_600_000,
            ["events"] = new JsonArray(DoorEvent(51, "  Turnstile_Spun  ", token)),
        }))).StatusCode);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        var receipt = Assert.Single(await db.DeviceEventReceipts.IgnoreQueryFilters()
            .Where(r => r.TenantId == club.TenantId).ToListAsync());
        Assert.Equal("turnstile_spun", receipt.Kind);

        var row = Assert.Single(await db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == club.TenantId && a.Action == "device.turnstile_spun").ToListAsync());
        Assert.DoesNotContain(token, row.DetailsJson, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(
            8, JsonDocument.Parse(row.DetailsJson!).RootElement.GetProperty("subject").GetString()!.Length);
    }

    /// <summary>
    /// <b>One malformed event must not pin the board's queue for ever.</b>
    ///
    /// <para>
    /// A JSON null in <c>kind</c> went straight into <c>e.Kind.Length</c> and answered 500; a
    /// kind of 200 characters overflowed <c>AuditLog.Action</c> (128) and answered 500 from
    /// the save. Either one is permanent: the firmware drains only up to
    /// <c>accepted_through</c> and re-posts the rest, so a malformed event at the head of a
    /// ring stops every event behind it from ever arriving — including the activations the
    /// no-show sweep is waiting on, which is real money. A board cannot edit what it has
    /// already queued, so the only exit is a receipt.
    /// </para>
    ///
    /// <para>
    /// The second event in each batch is a good one, and the assertion that it was recorded is
    /// what says the batch got PAST the bad one rather than merely surviving it.
    /// </para>
    /// </summary>
    [SkippableTheory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("gate_open_but_very_much_longer_than_the_column_will_take_and_then_some_more_again")]
    public async Task A_malformed_event_kind_is_receipted_rather_than_five_hundred(string? kind)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", DefaultSettings);
        var client = factory.CreateClient();
        var mac = await GateAsync(factory, club, client);

        var booking = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(-105));
        var token = await BookingCodeAsync(factory, club, booking);

        var bad = DoorEvent(21, DeviceEventEndpoints.GateOpenKind, token);
        bad["kind"] = kind is null ? null : JsonValue.Create(kind);

        var upload = await client.SendAsync(Signed(club.Key, EventsPath, new JsonObject
        {
            ["mac"] = mac,
            ["uptime_ms"] = 3_600_000,
            ["events"] = new JsonArray(bad, DoorEvent(22, DeviceEventEndpoints.GateOpenKind, token)),
        }));

        Assert.Equal(HttpStatusCode.OK, upload.StatusCode);

        // Acknowledged THROUGH the good event behind it: this is the assertion that says the
        // queue drains rather than stalls.
        var body = await BodyAsync(upload);
        Assert.Equal(22, body.GetProperty("accepted_through").GetInt64());
        Assert.Equal(2, body.GetProperty("recorded").GetInt32());

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        var receipt = await db.DeviceEventReceipts.IgnoreQueryFilters()
            .SingleAsync(r => r.TenantId == club.TenantId && r.Seq == 21);
        Assert.True(receipt.Kind.Length <= DeviceEventEndpoints.MaxKindLength);
        Assert.False(string.IsNullOrEmpty(receipt.Kind));

        // Its own audit row, so the desk can see a board is sending rubbish rather than
        // inferring it from a gap in the sequence numbers.
        var malformed = await db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == club.TenantId && a.Action.EndsWith($"_{DeviceEventEndpoints.Malformed}"))
            .ToListAsync();
        Assert.Single(malformed);
        Assert.All(malformed, a => Assert.True(a.Action.Length <= 128));
    }

    /// <summary>
    /// <b>A diagnostic counter must not be able to take a door out of service, and one could.</b>
    ///
    /// <para>
    /// Both counters are SINCE-BOOT TOTALS — the board cannot know which report the server
    /// kept, so a counter reset on send loses the whole count on any lost response — and both
    /// SATURATE at <c>INT32_MAX</c> rather than wrapping. <c>no_push</c> bound as
    /// <c>int?</c>, so the very first value past that saturation point was a <b>400 for the
    /// whole heartbeat</b>: no <c>gate</c> block, no <c>roster</c>, nothing. A door that had
    /// been up long enough to saturate a counter then lost its cache at the next stale
    /// deadline, and the field's own contract vector says in as many words that this must
    /// never happen. Binding is now 64-bit and an out-of-range value is IGNORED.
    /// </para>
    ///
    /// <para>
    /// The values below are the real shape of the problem: the saturation point, one past it,
    /// <c>long.MaxValue</c> for a board or proxy that does something else entirely, and
    /// negatives, which are not counters.
    /// </para>
    /// </summary>
    [SkippableTheory]
    [InlineData(4L, null)]
    [InlineData(0L, 0L)]
    [InlineData(-1L, -7L)]
    [InlineData(2147483647L, 2147483647L)]
    [InlineData(2147483648L, 2147483648L)]
    [InlineData(long.MaxValue, long.MinValue)]
    [InlineData(null, 12L)]
    public async Task The_boards_diagnostic_counters_are_accepted_and_change_nothing(long? noPush, long? eventsLost)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", DefaultSettings);
        var client = factory.CreateClient();
        var mac = NewMac();

        var body = new JsonObject
        {
            ["mac"] = mac,
            ["firmware_version"] = "1.0.0",
            ["uptime_ms"] = 60000,
            ["kind"] = DeviceKinds.Gate,
        };
        if (noPush is { } n) body["no_push"] = n;
        if (eventsLost is { } e) body["events_lost"] = e;

        var response = await client.SendAsync(Signed(club.Key, HeartbeatPath, body));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var json = await BodyAsync(response);

        // The whole answer is intact, which is the point: a door that cannot read its roster
        // is a door that admits nobody at the next stale deadline.
        Assert.Equal(DeviceKinds.Gate, json.GetProperty("kind").GetString());
        Assert.Equal(3, json.GetProperty("gate").GetProperty("unlock_seconds").GetInt32());
        Assert.Equal(JsonValueKind.Array, json.GetProperty("roster").ValueKind);

        // And neither counter comes back or is stored: they are logged and nothing else.
        Assert.False(json.TryGetProperty("no_push", out _));
        Assert.False(json.TryGetProperty("events_lost", out _));
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
    /// <b><c>gate_key</c> is two-valued, and both values are pinned here.</b> An explicit
    /// <c>null</c> — and an absent key, which binds to the same thing — means "leave the
    /// door's name alone"; <c>""</c> clears it. There is no third state, because a door either
    /// has a name or has not.
    ///
    /// <para>
    /// The clearing half has been pinned since the field shipped and the LEAVING-ALONE half
    /// had not been, which is the half a client gets wrong for free: send <c>null</c> meaning
    /// "clear it" and the API answers 200 having changed nothing, and nothing anywhere says
    /// so. Pinning both sides is what makes the console's choice of <c>""</c> a contract
    /// rather than a coincidence.
    /// </para>
    ///
    /// <para>
    /// The name is changed by a PATCH that also carries <c>name</c>, so the request is one the
    /// server definitely acted on — a null <c>gate_key</c> surviving an otherwise empty PATCH
    /// would prove nothing.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_null_gate_key_leaves_the_door_named_and_an_empty_string_clears_it()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", DefaultSettings);
        var deviceClient = factory.CreateClient();
        var gateMac = await GateAsync(factory, club, deviceClient, "front-door");
        var (gateId, _) = await IdsAsync(factory, gateMac, gateMac);
        var admin = await AdminClientAsync(factory, club);

        // An explicit null, on a PATCH that definitely did something else.
        var renamed = await admin.PatchAsJsonAsync(
            $"/api/v1/admin/devices/{gateId}", new { name = "Front door", gate_key = (string?)null });
        Assert.Equal(HttpStatusCode.OK, renamed.StatusCode);

        var body = await BodyAsync(renamed);
        Assert.Equal("Front door", body.GetProperty("name").GetString());
        Assert.Equal("front-door", body.GetProperty("gate_key").GetString());

        // An absent key is the same instruction.
        var untouched = await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{gateId}", new { name = "Side door" });
        Assert.Equal("front-door", (await BodyAsync(untouched)).GetProperty("gate_key").GetString());

        // …and the empty string is the one that clears it, which is what the console sends.
        var cleared = await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{gateId}", new { gate_key = "" });
        Assert.Equal(JsonValueKind.Null, (await BodyAsync(cleared)).GetProperty("gate_key").ValueKind);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        Assert.Null((await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == gateMac)).GateKey);
    }

    /// <summary>
    /// <b>The silent no-op the spec itself argues against, on the PATCH this time.</b>
    ///
    /// <para>
    /// §8's settings PUT binds both spellings for exactly this reason: the endpoint answers
    /// snake_case and .NET binds camelCase, so the cost of a client picking the wrong one is
    /// not an error — it is <c>null</c>, which <c>gate_key</c> reads as "omitted, leave
    /// unchanged", so the request answers <c>200</c> with the door's old name in the body and
    /// nothing anywhere says the write was dropped. That argument was made in this document
    /// and then not applied to the one field on the PATCH that carries it.
    /// </para>
    ///
    /// <para>
    /// Both refusals still fire under either spelling, because a spelling is not a way round a
    /// rule: a camelCase <c>gateKey</c> on a court box is still <c>gate_key_not_a_gate</c>,
    /// and one past 64 characters is still <c>gate_key_too_long</c>.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task The_admin_patch_binds_gate_key_under_either_spelling()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", DefaultSettings);
        var deviceClient = factory.CreateClient();
        var gateMac = await GateAsync(factory, club, deviceClient, "front-door");
        var boxMac = await CourtBoxAsync(club, deviceClient);
        var (gateId, boxId) = await IdsAsync(factory, gateMac, boxMac);
        var admin = await AdminClientAsync(factory, club);

        var camel = await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{gateId}", new { gateKey = "side-door" });
        Assert.Equal(HttpStatusCode.OK, camel.StatusCode);
        Assert.Equal("side-door", (await BodyAsync(camel)).GetProperty("gate_key").GetString());

        // The empty string clears under the camelCase spelling too — the console's own
        // gesture must not depend on which of the two it happens to send.
        var cleared = await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{gateId}", new { gateKey = "" });
        Assert.Equal(JsonValueKind.Null, (await BodyAsync(cleared)).GetProperty("gate_key").ValueKind);

        // Absent under BOTH spellings still means "leave it alone".
        await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{gateId}", new { gateKey = "back-door" });
        var untouched = await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{gateId}", new { name = "Back door" });
        Assert.Equal("back-door", (await BodyAsync(untouched)).GetProperty("gate_key").GetString());

        // And neither refusal can be stepped around by respelling the field.
        var onABox = await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{boxId}", new { gateKey = "front-door" });
        Assert.Equal(HttpStatusCode.BadRequest, onABox.StatusCode);
        Assert.Equal(
            AdminDeviceEndpoints.GateKeyNotAGate, (await BodyAsync(onABox)).GetProperty("error").GetString());

        var tooLong = await admin.PatchAsJsonAsync(
            $"/api/v1/admin/devices/{gateId}", new { gateKey = new string('g', Device.GateKeyMaxLength + 1) });
        Assert.Equal(HttpStatusCode.BadRequest, tooLong.StatusCode);
        Assert.Equal(
            AdminDeviceEndpoints.GateKeyTooLong, (await BodyAsync(tooLong)).GetProperty("error").GetString());

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        Assert.Equal("back-door", (await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == gateMac)).GateKey);
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

    // ---- The trail's reader (B5) ---------------------------------------------

    /// <summary>
    /// <b>The door's trail had no reader, and the trail is the ENTIRE record a door leaves.</b>
    ///
    /// <para>
    /// §5 argues at length that the audit row matters more than a court box's equivalent
    /// because there is no ledger entry, no booking and no receipt to reconstruct an open
    /// from — and then no API route read <c>audit_log</c> at all. "Nobody could get in through
    /// the side door all Tuesday" was a question the spec promised an answer to and the
    /// product could only answer with a database client.
    /// </para>
    ///
    /// <para>
    /// One test over one board's whole day, because the value of this route is that the
    /// ONLINE and OFFLINE halves of a door's life appear in one list: an open, a refusal with
    /// its reason, and an open the board decided for itself while the link was down. The
    /// ordering is newest-first and is asserted rather than assumed, because a console that
    /// pages this will show the first page and nothing else.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_doors_activity_is_readable_and_carries_both_halves_of_its_day()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", DefaultSettings);
        var client = factory.CreateClient();
        var mac = await GateAsync(factory, club, client, "front-door");

        // Online: one open, and one refusal with a reason.
        var ident = await IdentCodeAsync(factory, club.TenantId, club.MemberId);
        Assert.True((await BodyAsync(await client.SendAsync(Scan(club.Key, mac, ident)))).GetProperty("opened").GetBoolean());
        Assert.False((await BodyAsync(await client.SendAsync(Scan(club.Key, mac, "ZZZZZZZZZZZZ")))).GetProperty("opened").GetBoolean());

        // Offline: an open the board decided from its cache while the link was down.
        var booking = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(-105));
        var bookingCode = await BookingCodeAsync(factory, club, booking);
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Signed(club.Key, EventsPath, new JsonObject
        {
            ["mac"] = mac,
            ["uptime_ms"] = 3_600_000,
            ["events"] = new JsonArray(DoorEvent(61, DeviceEventEndpoints.GateOpenKind, bookingCode)),
        }))).StatusCode);

        var (gateId, _) = await IdsAsync(factory, mac, mac);
        var admin = await AdminClientAsync(factory, club);

        var response = await admin.GetAsync($"/api/v1/admin/devices/{gateId}/activity");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await BodyAsync(response);
        var items = body.GetProperty("items").EnumerateArray().ToList();

        // Newest first: the offline upload is the last thing that happened.
        var times = items.Select(i => i.GetProperty("at").GetDateTimeOffset()).ToList();
        Assert.Equal(times.OrderByDescending(t => t), times);

        var open = Assert.Single(items, i => i.GetProperty("action").GetString() == DeviceGateEndpoint.OpenedAction);
        Assert.Equal(GateAccess.Ok, open.GetProperty("reason").GetString());
        Assert.False(open.GetProperty("offline").GetBoolean());
        Assert.Equal(club.MemberId, open.GetProperty("member").GetProperty("id").GetGuid());
        Assert.Equal("Gate Member", open.GetProperty("member").GetProperty("name").GetString());

        // An unreadable code names nobody, which is the whole of what the desk learns from it.
        var denied = Assert.Single(
            items, i => i.GetProperty("action").GetString() == $"{DeviceGateEndpoint.DeniedActionPrefix}{GateAccess.NotRecognised}");
        Assert.Equal(GateAccess.NotRecognised, denied.GetProperty("reason").GetString());
        Assert.Equal(JsonValueKind.Null, denied.GetProperty("member").ValueKind);
        Assert.False(denied.GetProperty("offline").GetBoolean());

        var offline = Assert.Single(
            items, i => i.GetProperty("action").GetString() == $"device.{DeviceEventEndpoints.GateOpenKind}");
        Assert.True(offline.GetProperty("offline").GetBoolean());
        Assert.Equal(club.MemberId, offline.GetProperty("member").GetProperty("id").GetGuid());
        Assert.Matches("^[0-9a-f]{8}$", offline.GetProperty("fingerprint").GetString());

        // The online rows carry no fingerprint, because the online path never stored the
        // token in any form — see §5.
        Assert.Equal(JsonValueKind.Null, open.GetProperty("fingerprint").ValueKind);

        // The row the board's own registration wrote is here too — this is the BOARD's trail,
        // not a door-opens-only feed, and "when did this door first call in" is the same
        // question. It is in `events` and NOT in `items`, which is the C4 / B1 rule: a console
        // renders a row it has no chip for through whatever branch is last, so a registration
        // or an admin edit left among the scans was painted as a green "Refused".
        Assert.DoesNotContain(items, i => i.GetProperty("action").GetString() == "device.auto_registered");
        var events = body.GetProperty("events").EnumerateArray().ToList();
        var registered = Assert.Single(
            events, e => e.GetProperty("action").GetString() == "device.auto_registered");
        Assert.Equal(DoorAuditActions.RegisteredKind, registered.GetProperty("kind").GetString());
    }

    /// <summary>
    /// <b>The route must not become a second way to read a token.</b>
    ///
    /// <para>
    /// Two separate hazards. <c>DetailsJson</c> is never returned raw — it carries the club's
    /// device id, the gate key and, for a court box, the relay and booking — and the
    /// <c>fingerprint</c> field is validated to BE a fingerprint rather than trusted to be
    /// one. That second half is not theoretical: rows written before the fingerprint existed
    /// hold the live access code in <c>subject</c> in full, `RetentionWorker` never touches
    /// `DetailsJson`, and a reader that simply forwarded the field would have published every
    /// one of them to the console the day it shipped.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task The_activity_route_returns_no_raw_details_and_no_legacy_token()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", DefaultSettings);
        var client = factory.CreateClient();
        var mac = await GateAsync(factory, club, client, "front-door");
        var (gateId, _) = await IdsAsync(factory, mac, mac);

        // Two rows exactly as the product wrote them before G2's B4, injected directly
        // because no code path produces them any more. The first is the token in full. The
        // second is the probe the first cannot be: twelve LOWERCASE HEX characters — the shape
        // of a MAC address, which is a plausible thing for some other writer to have put in
        // this field — which passes a character check and fails a length one. Without both,
        // half the guard is untested and a mutant that drops the length check survives.
        const string LegacyToken = "7Q3F9KM2XZ8B";
        const string HexShapedSubject = "0a1b2c3d4e5f";
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            foreach (var subject in new[] { LegacyToken, HexShapedSubject })
            {
                db.AuditLogs.Add(new AuditLog
                {
                    TenantId = club.TenantId,
                    ActorUserId = Guid.Empty,
                    Action = $"device.{DeviceEventEndpoints.UnknownScanKind}",
                    DetailsJson = JsonSerializer.Serialize(new
                    {
                        device_id = gateId,
                        device_code = "gate-legacy",
                        seq = 4L,
                        kind = DeviceEventEndpoints.UnknownScanKind,
                        subject,
                    }),
                });
            }
            await db.SaveChangesAsync();
        }

        var admin = await AdminClientAsync(factory, club);
        var raw = await (await admin.GetAsync($"/api/v1/admin/devices/{gateId}/activity")).Content.ReadAsStringAsync();

        Assert.DoesNotContain(LegacyToken, raw, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(HexShapedSubject, raw, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("details", raw, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("gate_key", raw, StringComparison.OrdinalIgnoreCase);

        // Both rows are still listed — they are evidence — with their fingerprint field null,
        // because what they hold is not one.
        var legacy = JsonDocument.Parse(raw).RootElement.GetProperty("items").EnumerateArray()
            .Where(i => i.GetProperty("action").GetString() == $"device.{DeviceEventEndpoints.UnknownScanKind}")
            .ToList();
        Assert.Equal(2, legacy.Count);
        Assert.All(legacy, i => Assert.Equal(JsonValueKind.Null, i.GetProperty("fingerprint").ValueKind));
        Assert.All(legacy, i => Assert.True(i.GetProperty("offline").GetBoolean()));
    }

    /// <summary>
    /// <b>The cross-tenant injection this route needs, and it is not the 404 above.</b>
    ///
    /// <para>
    /// The device lookup being tenant-filtered stops an admin naming another club's board, and
    /// that is pinned separately. This pins the SECOND filter: the audit query itself. Rows are
    /// attributed to a board by a <c>device_id</c> inside a jsonb document with no foreign key
    /// behind it, so if that query ever lost its tenant filter, any row anywhere carrying this
    /// id would be served — and the id is the only thing being matched on.
    /// </para>
    ///
    /// <para>
    /// The row is injected rather than produced, because no code path writes another tenant's
    /// device id into this tenant's details and none should. That is what a cross-tenant
    /// injection test is for, and this repository requires one on every change touching a
    /// tenant-scoped table.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task Another_clubs_audit_rows_never_appear_in_this_clubs_device_activity()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var mine = await ClubAsync(factory, "gate", DefaultSettings);
        var theirs = await ClubAsync(factory, "gate", DefaultSettings);
        var client = factory.CreateClient();
        var mac = await GateAsync(factory, mine, client, "front-door");
        var (gateId, _) = await IdsAsync(factory, mac, mac);

        const string TheirAction = "device.their_private_business";
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            db.AuditLogs.Add(new AuditLog
            {
                TenantId = theirs.TenantId,
                ActorUserId = Guid.Empty,
                SubjectUserId = theirs.MemberId,
                Action = TheirAction,
                DetailsJson = JsonSerializer.Serialize(new { device_id = gateId, seq = 1L }),
            });
            await db.SaveChangesAsync();
        }

        var raw = await (await (await AdminClientAsync(factory, mine))
            .GetAsync($"/api/v1/admin/devices/{gateId}/activity")).Content.ReadAsStringAsync();

        Assert.DoesNotContain(TheirAction, raw, StringComparison.Ordinal);
        Assert.DoesNotContain(theirs.MemberId.ToString(), raw, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// The limit is clamped rather than refused, and defaults to fifty. A console asking for
    /// a million rows is a mistake to bound, not a request to fail — and a console asking for
    /// none of them is asking for nothing useful.
    /// </summary>
    [SkippableTheory]
    [InlineData(null, 50)]
    [InlineData(1, 1)]
    [InlineData(3, 3)]
    [InlineData(0, 1)]
    [InlineData(-9, 1)]
    // Fifty-nine refusals are scans; the registration row is a door EVENT and is on the other
    // array, so the scan page tops out at 59 rather than 60. See AdminDeviceActivityEndpoint.
    [InlineData(200, 59)]
    [InlineData(10_000, 59)]
    public async Task The_activity_limit_is_clamped_and_defaults_to_fifty(int? limit, int expected)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", DefaultSettings);
        var client = factory.CreateClient();
        var mac = await GateAsync(factory, club, client, "front-door");
        var (gateId, _) = await IdsAsync(factory, mac, mac);

        // Sixty rows: past the default page and short of the maximum, so both the "clamped
        // down to the page" and "clamped up to what exists" cases are real.
        for (var i = 0; i < 59; i++)
        {
            await client.SendAsync(Scan(club.Key, mac, "ZZZZZZZZZZZZ"));
        }

        var query = limit is null ? "" : $"?limit={limit}";
        var response = await (await AdminClientAsync(factory, club)).GetAsync(
            $"/api/v1/admin/devices/{gateId}/activity{query}");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(expected, (await BodyAsync(response)).GetProperty("items").GetArrayLength());
    }

    /// <summary>
    /// Another club's board is not this club's to read, and the answer is a 404 rather than a
    /// 403: whether a device id exists at all is itself a fact about the other tenant.
    /// </summary>
    [SkippableFact]
    public async Task Another_clubs_device_has_no_activity_here()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var mine = await ClubAsync(factory, "gate", DefaultSettings);
        var theirs = await ClubAsync(factory, "gate", DefaultSettings);
        var client = factory.CreateClient();

        var theirMac = await GateAsync(factory, theirs, client, "their-door");
        var (theirGateId, _) = await IdsAsync(factory, theirMac, theirMac);
        await client.SendAsync(Scan(theirs.Key, theirMac, await IdentCodeAsync(factory, theirs.TenantId, theirs.MemberId)));

        var admin = await AdminClientAsync(factory, mine);
        Assert.Equal(
            HttpStatusCode.NotFound,
            (await admin.GetAsync($"/api/v1/admin/devices/{theirGateId}/activity")).StatusCode);

        // And their admin can read it, so the refusal above is tenancy and not a broken route.
        var theirAdmin = await AdminClientAsync(factory, theirs);
        var theirs200 = await theirAdmin.GetAsync($"/api/v1/admin/devices/{theirGateId}/activity");
        Assert.Equal(HttpStatusCode.OK, theirs200.StatusCode);
        Assert.NotEmpty((await BodyAsync(theirs200)).GetProperty("items").EnumerateArray());
    }

    /// <summary>
    /// A court box has the same route and the same shape. Its trail is not a door's — it is
    /// activations, releases and the outcomes they settled — but "what has this board been
    /// doing" is one question and the console asks it from one place.
    /// </summary>
    [SkippableFact]
    public async Task A_court_boxs_activity_is_readable_on_the_same_route()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "gate", DefaultSettings);
        var client = factory.CreateClient();
        var boxMac = await CourtBoxAsync(club, client);
        var (boxId, _) = await IdsAsync(factory, boxMac, boxMac);

        var booking = await BookAsync(factory, club, DateTimeOffset.UtcNow.AddMinutes(-5));
        var token = await BookingCodeAsync(factory, club, booking);
        var activation = DoorEvent(71, DeviceEventEndpoints.ActivationKind, token);
        activation["court"] = 0;
        activation["uptime_ms"] = 3_599_000;
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Signed(club.Key, EventsPath, new JsonObject
        {
            ["mac"] = boxMac,
            ["uptime_ms"] = 3_600_000,
            ["events"] = new JsonArray(activation),
        }))).StatusCode);

        var response = await (await AdminClientAsync(factory, club)).GetAsync(
            $"/api/v1/admin/devices/{boxId}/activity");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var body = await BodyAsync(response);
        var items = body.GetProperty("items").EnumerateArray().ToList();
        var row = Assert.Single(items, i => i.GetProperty("action").GetString() == $"device.{DeviceEventEndpoints.ActivationKind}");
        Assert.True(row.GetProperty("offline").GetBoolean());
        Assert.Matches("^[0-9a-f]{8}$", row.GetProperty("fingerprint").GetString());
        Assert.Equal(ActivationOutcomeOk, row.GetProperty("reason").GetString());

        // The door split does not reach a box: `events` is present and empty, so the console
        // types one response shape, and the box's whole trail stays where its screen reads it.
        Assert.Empty(body.GetProperty("events").EnumerateArray());
        Assert.Contains(items, i => i.GetProperty("action").GetString() == "device.auto_registered");
    }

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
