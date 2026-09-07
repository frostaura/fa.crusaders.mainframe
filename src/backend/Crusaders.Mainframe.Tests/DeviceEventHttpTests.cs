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
using Crusaders.Mainframe.Api.Security.DeviceAuth;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.IdentityModel.Tokens;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// What a court box reports, and what it buys.
///
/// <para>
/// The box decides scans locally and queues what it decided; these two endpoints are where
/// that queue drains and where the one operation that genuinely needs the network — a
/// walk-up — happens. Over real HTTP with the club's API key and the box's MAC, because a
/// body the firmware writes one field differently is a 401 or a 404 with no diagnostic and
/// a trip to the club.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class DeviceEventHttpTests
{
    private readonly PostgresFixture _pg;

    public DeviceEventHttpTests(PostgresFixture pg) => _pg = pg;

    private const string EventsPath = "/api/v1/device/events";
    private const string WalkUpPath = "/api/v1/device/walkup";
    private const string ActivatePath = "/api/v1/device/activate";
    private const string Secret = "test-only-signing-key-not-used-in-any-real-environment";

    private sealed record Box(
        Guid DeviceId, string Mac, string ApiKey, Guid TenantId, string Slug, Guid CourtId, Guid MemberId,
        IReadOnlyDictionary<int, Guid> CourtIds);

    /// <summary>Moves a seeded club clear of its own closing time; see <see cref="TestHost.DayZoneFor"/>.</summary>
    private static async Task ClearOfClosingAsync(TestWebAppFactory factory, Guid tenantId, int minutesNeeded)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await TestHost.ClearOfClosingAsync(db, tenantId, minutesNeeded);
    }

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    /// <summary>A tenant, a funded member, and a claimed box driving <paramref name="courtNumbers"/> (court 1 alone by default).</summary>
    private static async Task<Box> SeedAsync(TestWebAppFactory factory, decimal topUpCredits = 200m, int[]? courtNumbers = null)
    {
        courtNumbers ??= [1];
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var slug = $"box-{Guid.NewGuid():N}"[..20];
        var tenant = new Tenant
        {
            Slug = slug,
            DisplayName = "Box Club",
            DeviceApiKey = DeviceApiKey.Generate(),
            DeviceApiKeyRegeneratedAt = DateTimeOffset.UtcNow,
        };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings
        {
            TenantId = tenant.Id,
            SettingsJson = """{"slice_minutes":15,"day_start_minute":0,"day_end_minute":1440,"slice_price_credits":8,"grace_window_minutes":5,"timezone":"UTC","peak_hours":"16:00-19:00"}""",
        });

        var courts = courtNumbers
            .Select(n => new Court { TenantId = tenant.Id, CourtNumber = n, Name = $"Court {n}", SlicePriceCredits = 8m })
            .ToList();
        db.Courts.AddRange(courts);

        var member = new User { TenantId = tenant.Id, Email = $"{slug}@test.local", PasswordHash = "x", EmailVerified = true };
        db.Users.Add(member);
        db.Memberships.Add(new Membership
        {
            TenantId = tenant.Id,
            UserId = member.Id,
            FullName = "Walk Up",
            MembershipNumber = slug,
            Status = MembershipStatus.Active,
            MemberClass = MemberClass.Regular,
        });

        var mac = Guid.NewGuid().ToString("N")[..12];
        var device = new Device
        {
            TenantId = tenant.Id,
            DeviceCode = $"box-{mac[^6..]}",
            Name = "Court 1 box",
            Kind = DeviceKind.CourtBox,
            Hardware = DeviceHardware.Esp8266,
            MacAddress = mac,
            CourtNumbers = [.. courtNumbers],
        };
        db.Devices.Add(device);

        if (topUpCredits > 0)
        {
            db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = tenant.Id,
                UserId = member.Id,
                Type = LedgerEntryType.TopUp,
                AmountCredits = topUpCredits,
                ActorUserId = member.Id,
                Reason = "seed",
            });
        }

        await db.SaveChangesAsync();

        return new Box(device.Id, mac, tenant.DeviceApiKey!, tenant.Id, slug, courts[0].Id, member.Id,
            courts.ToDictionary(c => c.CourtNumber, c => c.Id));
    }

    /// <summary>
    /// The request a correctly-implemented firmware sends: the club's key in the
    /// Authorization header and the board's MAC in the body.
    ///
    /// <para>
    /// The MAC is spliced into the payload here rather than written at each of the sixty-odd
    /// call sites, because it is not what any of them is about — every device request
    /// carries it, exactly the way every one used to carry a signature.
    /// </para>
    /// </summary>
    private static HttpRequestMessage FromBox(Box box, string path, object payload)
    {
        var body = JsonSerializer.SerializeToNode(payload)!.AsObject();
        body["mac"] = box.Mac;

        var req = new HttpRequestMessage(HttpMethod.Post, path)
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", box.ApiKey);
        return req;
    }

    /// <summary>
    /// The QR the member's app renders: a sixty-second member-ident access code, minted the
    /// way the API mints it. Twelve characters, because the box's scanner pipeline carries
    /// twenty-four bytes and a JWT never fitted (review H2).
    /// </summary>
    private static Task<string> QrCodeAsync(TestWebAppFactory factory, Box box)
        => TestAccessCodes.MintIdentAsync(factory.Services, box.TenantId, box.Slug, box.MemberId);

    private static object Batch(params object[] events) => BatchAt(600_000, events);

    /// <summary>A batch sent at the given box uptime, so an event's own uptime says how long ago it happened.</summary>
    private static object BatchAt(long uptimeMs, params object[] events) => new { uptime_ms = uptimeMs, events };

    /// <summary>
    /// The five-field walk-up body: the court NUMBER the member selected and the box's
    /// per-purchase nonce, the same on every retry of the same purchase.
    /// </summary>
    private static object WalkUp(string? token, int minutes = 30, int court = 1, string? method = "qr", string? nonce = null) => new
    {
        minutes,
        method,
        token,
        court,
        nonce = nonce ?? Guid.NewGuid().ToString("N")[..16],
    };

    /// <summary>
    /// <c>court</c> is the RELAY INDEX the box lit (0–3), as <c>eventq::Event::court</c>
    /// carries it. Against <see cref="Batch"/>'s uptime the default puts the scan five
    /// minutes before the upload.
    /// </summary>
    private static object Activation(
        long seq, string subject = "tok-alice", int court = 0, long uptimeMs = 300_000, long durationMs = 2_700_000) => new
    {
        seq,
        uptime_ms = uptimeMs,
        kind = "activation",
        court,
        method = "qr",
        subject,
        duration_ms = durationMs,
    };

    /// <summary>
    /// The event a box queues when a relay opened again: a relay index and how long it was
    /// actually closed, and nothing else — no member, no booking. Against
    /// <see cref="Batch"/>'s uptime the defaults put the release at the upload instant.
    /// </summary>
    private static object Release(long seq, int court = 0, long heldMs = 2_700_000, long uptimeMs = 600_000) => new
    {
        seq,
        uptime_ms = uptimeMs,
        kind = "release",
        court,
        method = (string?)null,
        subject = "",
        duration_ms = heldMs,
    };

    // ---- uploading what happened ------------------------------------------

    [SkippableFact]
    public async Task A_batch_is_recorded_and_acknowledged_by_sequence_number()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        var client = factory.CreateClient();

        var response = await client.SendAsync(FromBox(box, EventsPath, Batch(Activation(1), Activation(2), Activation(3))));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        // A sequence number, not a bare 200: the box releases its queue up to this and no
        // further, so a partial success loses nothing.
        Assert.Equal(3, body.GetProperty("accepted_through").GetInt64());
        Assert.Equal(3, body.GetProperty("recorded").GetInt32());

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        Assert.Equal(3, await db.DeviceEventReceipts.IgnoreQueryFilters().CountAsync(r => r.DeviceId == box.DeviceId));
    }

    /// <summary>
    /// An upload is a liveness signal too, and it is very often the FIRST call a box makes
    /// when it reconnects — it has a queue to drain. So it has to leave the same evidence a
    /// heartbeat does: the silence it just ended, recorded as a closed <c>DeviceOutage</c>.
    /// Without it the no-show waiver settles the outage window differently depending on
    /// whether the health sweep happened to catch the box while it was still dark. The
    /// heartbeat half of this is
    /// <c>DeviceAuthHttpTests.A_heartbeat_that_ends_a_long_silence_records_the_outage_it_ended</c>.
    /// </summary>
    [SkippableFact]
    public async Task An_upload_that_ends_a_long_silence_records_the_outage_it_ended()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        var client = factory.CreateClient();

        // Twenty minutes dark, which is far past the 180-second floor under
        // offline_after_seconds, and then the box drains its queue.
        var wentQuietAt = DateTimeOffset.UtcNow.AddMinutes(-20);
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var device = await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.Id == box.DeviceId);
            device.LastSeenAt = wentQuietAt;
            await db.SaveChangesAsync();
        }

        var response = await client.SendAsync(FromBox(box, EventsPath, Batch(Activation(1))));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var outage = Assert.Single(await db.DeviceOutages.IgnoreQueryFilters()
                .Where(o => o.DeviceId == box.DeviceId).ToListAsync());
            Assert.Equal(wentQuietAt, outage.StartedAt, TimeSpan.FromSeconds(1));
            Assert.NotNull(outage.EndedAt);
        }
    }

    [SkippableFact]
    public async Task A_replayed_batch_is_acknowledged_without_being_recorded_twice()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        var client = factory.CreateClient();

        await client.SendAsync(FromBox(box, EventsPath, Batch(Activation(1), Activation(2))));

        // The box uploaded, lost the link before reading the response, and tried again.
        // That is normal traffic on an unreliable network, not an error — so it must be
        // acknowledged, and it must not double-record.
        var again = await client.SendAsync(FromBox(box, EventsPath, Batch(Activation(1), Activation(2))));
        Assert.Equal(HttpStatusCode.OK, again.StatusCode);

        var body = await again.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(2, body.GetProperty("accepted_through").GetInt64());
        Assert.Equal(0, body.GetProperty("recorded").GetInt32());

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        Assert.Equal(2, await db.DeviceEventReceipts.IgnoreQueryFilters().CountAsync(r => r.DeviceId == box.DeviceId));
    }

    [SkippableFact]
    public async Task A_batch_that_overlaps_an_earlier_one_records_only_what_is_new()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        var client = factory.CreateClient();

        await client.SendAsync(FromBox(box, EventsPath, Batch(Activation(1), Activation(2))));

        // The realistic retry: the box never saw the acknowledgement, so it re-offers what it
        // still holds — which by then includes newer events too.
        var overlapping = await client.SendAsync(
            FromBox(box, EventsPath, Batch(Activation(2), Activation(3), Activation(4))));

        var body = await overlapping.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(4, body.GetProperty("accepted_through").GetInt64());
        Assert.Equal(2, body.GetProperty("recorded").GetInt32());
    }

    [SkippableFact]
    public async Task An_oversized_batch_is_bounded_rather_than_refused()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        var client = factory.CreateClient();

        var many = Enumerable.Range(1, 100).Select(i => Activation(i)).ToArray();
        var response = await client.SendAsync(FromBox(box, EventsPath, Batch(many)));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        // A board back from a week offline arrives with a full ring. Refusing it outright
        // would strand the whole queue; one request that takes a minute times out and gets
        // retried forever. It takes what it can and the box offers the rest.
        Assert.Equal(Crusaders.Mainframe.Api.Endpoints.DeviceEventEndpoints.MaxBatch,
            body.GetProperty("accepted_through").GetInt64());
    }

    [SkippableFact]
    public async Task An_unsigned_upload_is_refused()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        await SeedAsync(factory);
        var client = factory.CreateClient();

        var response = await client.PostAsJsonAsync(EventsPath, Batch(Activation(1)));
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    // ---- buying court time at the box -------------------------------------

    [SkippableFact]
    public async Task A_walk_up_creates_a_real_booking_charges_it_and_lights_the_court()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        var client = factory.CreateClient();

        var response = await client.SendAsync(FromBox(box, WalkUpPath, WalkUp(await QrCodeAsync(factory, box), minutes: 30)));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(30, body.GetProperty("granted_minutes").GetInt32());
        Assert.Equal(16m, body.GetProperty("amount_credits").GetDecimal());
        Assert.False(body.GetProperty("replayed").GetBoolean());

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var booking = await db.Bookings.IgnoreQueryFilters().SingleAsync(b => b.UserId == box.MemberId);

        // A real booking in the member's name, visible online immediately — one money path,
        // not two — and checked in, because they are standing on the court.
        Assert.Equal(BookingStatus.Booked, booking.Status);
        Assert.NotNull(booking.ChargedAt);
        Assert.NotNull(booking.CheckedInAt);
    }

    [SkippableFact]
    public async Task A_walk_up_is_truncated_at_the_next_booking_and_charged_pro_rata()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);

        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var startsAt = DateTimeOffset.UtcNow.AddMinutes(20).AddSeconds(30);
            db.Bookings.Add(new Booking
            {
                TenantId = box.TenantId,
                CourtId = box.CourtId,
                UserId = Guid.NewGuid(),
                ActorUserId = Guid.NewGuid(),
                StartsAt = startsAt,
                EndsAt = startsAt.AddMinutes(30),
                SliceMinutes = 15,
                SliceCount = 2,
                AmountChargedCredits = 16m,
                Status = BookingStatus.Booked,
                ChargedAt = DateTimeOffset.UtcNow,
            });
            await db.SaveChangesAsync();
        }

        var client = factory.CreateClient();
        var response = await client.SendAsync(FromBox(box, WalkUpPath, WalkUp(await QrCodeAsync(factory, box), minutes: 60)));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();

        // Twenty minutes is all there is to sell, and 8 credits per 15 minutes makes that
        // 10.67 — the first fractional price in the system, and the reason this endpoint
        // exists on the server rather than on the box.
        Assert.Equal(20, body.GetProperty("granted_minutes").GetInt32());
        Assert.Equal(10.67m, body.GetProperty("amount_credits").GetDecimal());
    }

    /// <summary>
    /// The rule itself, not a consequence of it.
    ///
    /// <para>
    /// The HTTP test below refuses a PIN, but it would refuse any nonsense token — so on its
    /// own it proves "an invalid token is rejected" and not "PIN is not a global method". A
    /// mutation widening <see cref="IdentificationResolver.CanIdentifyGlobally"/> to accept
    /// everything left it green. This is the assertion that actually holds the rule.
    /// </para>
    /// </summary>
    [Theory]
    [InlineData("qr", true)]
    [InlineData("QR", true)]
    [InlineData("code", true)]      // the same code, typed rather than scanned
    [InlineData("pin", false)]
    [InlineData("biometric", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void Only_qr_identifies_a_member_without_a_booking_to_check_against(string? method, bool expected)
    {
        // A PIN is checked against the handful of members with a booking on this court, which
        // is what makes four digits usable at all. A walk-up has no booking, so the same
        // check against the whole roll is a 10,000-space oracle over a club with far fewer
        // than 10,000 members — a random four digits would frequently match somebody.
        Assert.Equal(expected, IdentificationResolver.CanIdentifyGlobally(method));
    }

    [SkippableTheory]
    [InlineData("pin")]
    [InlineData("biometric")]
    [InlineData(null)]
    public async Task A_walk_up_by_a_method_that_cannot_identify_globally_is_refused(string? method)
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        var client = factory.CreateClient();

        // A PIN is checked against the handful of members with a booking on this court,
        // which is what makes four digits usable. A walk-up has no booking, so the same
        // check against the whole roll would be a 10,000-space oracle over a club with far
        // fewer than 10,000 members — a random four digits would frequently match somebody.
        var response = await client.SendAsync(FromBox(box, WalkUpPath, WalkUp("1234", method: method)));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("not_recognised", body.GetProperty("error").GetString());
    }

    /// <summary>
    /// What a walk-up will not take: a code whose lifetime is over, a code another club
    /// minted, and the old JWT — which the box could never scan anyway, but which must not
    /// identify anybody if it somehow arrives. All three land in the same refusal, because
    /// a box that could tell them apart is an oracle for which codes are real.
    /// </summary>
    [SkippableTheory]
    [InlineData("expired")]
    [InlineData("foreign")]
    [InlineData("jwt")]
    public async Task A_walk_up_token_must_be_a_live_code_of_this_club_and_nothing_else(string kind)
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        var client = factory.CreateClient();

        var token = kind switch
        {
            "expired" => await TestAccessCodes.InsertExpiredAsync(factory.Services, box.TenantId, box.MemberId),
            "foreign" => await ForeignCodeAsync(factory),
            _ => new JwtSecurityTokenHandler().WriteToken(new JwtSecurityToken(
                issuer: "crusaders.mainframe", audience: "crusaders.mainframe.app",
                claims: [new Claim(JwtRegisteredClaimNames.Sub, box.MemberId.ToString()), new Claim("purpose", "qr_ident")],
                expires: DateTime.UtcNow.AddMinutes(1),
                signingCredentials: new SigningCredentials(
                    new SymmetricSecurityKey(Encoding.UTF8.GetBytes(Secret)), SecurityAlgorithms.HmacSha256))),
        };

        var response = await client.SendAsync(FromBox(box, WalkUpPath, WalkUp(token)));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("not_recognised", body.GetProperty("error").GetString());
    }

    /// <summary>A live code minted by a different club, for one of its own members.</summary>
    private static async Task<string> ForeignCodeAsync(TestWebAppFactory factory)
    {
        var other = await SeedAsync(factory, topUpCredits: 0m);
        return await TestAccessCodes.MintIdentAsync(factory.Services, other.TenantId, other.Slug, other.MemberId);
    }

    [SkippableFact]
    public async Task A_walk_up_the_member_cannot_afford_is_refused_with_the_numbers()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory, topUpCredits: 5m);
        var client = factory.CreateClient();

        var response = await client.SendAsync(FromBox(box, WalkUpPath, WalkUp(await QrCodeAsync(factory, box))));

        Assert.Equal(HttpStatusCode.PaymentRequired, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        // Both numbers, so the box can say "5.00 of 16.00" rather than "no".
        Assert.Equal(5m, body.GetProperty("current_credits").GetDecimal());
        Assert.Equal(16m, body.GetProperty("required_credits").GetDecimal());
    }

    [SkippableFact]
    public async Task A_walk_up_on_a_court_someone_is_already_playing_on_is_refused()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);

        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            db.Bookings.Add(new Booking
            {
                TenantId = box.TenantId,
                CourtId = box.CourtId,
                UserId = Guid.NewGuid(),
                ActorUserId = Guid.NewGuid(),
                StartsAt = DateTimeOffset.UtcNow.AddMinutes(-5),
                EndsAt = DateTimeOffset.UtcNow.AddMinutes(25),
                SliceMinutes = 15,
                SliceCount = 2,
                AmountChargedCredits = 16m,
                Status = BookingStatus.Booked,
                ChargedAt = DateTimeOffset.UtcNow,
            });
            await db.SaveChangesAsync();
        }

        var client = factory.CreateClient();
        var response = await client.SendAsync(FromBox(box, WalkUpPath, WalkUp(await QrCodeAsync(factory, box))));

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("court_in_use", body.GetProperty("error").GetString());
    }

    /// <summary>
    /// A box sells time on the courts it drives and no other. The request names the court
    /// now — it has to, one box drives four relays (review C5) — and a court outside the
    /// box's list is refused before anything is booked. A box that could name any court is
    /// a box that opens any court in the club.
    /// </summary>
    [SkippableFact]
    public async Task A_box_sells_time_on_its_own_courts_and_no_other()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);

        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            db.Courts.Add(new Court { TenantId = box.TenantId, CourtNumber = 2, Name = "Court 2", SlicePriceCredits = 8m });
            await db.SaveChangesAsync();
        }

        var client = factory.CreateClient();
        var response = await client.SendAsync(FromBox(box, WalkUpPath, WalkUp(await QrCodeAsync(factory, box), court: 2)));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("court_not_on_device", body.GetProperty("error").GetString());

        using var check = factory.Services.CreateScope();
        var db2 = check.ServiceProvider.GetRequiredService<MainframeDbContext>();
        Assert.Empty(await db2.Bookings.IgnoreQueryFilters().Where(b => b.UserId == box.MemberId).ToListAsync());
    }

    /// <summary>The court the member selected is the court booked, charged and lit — over the real wire.</summary>
    [SkippableFact]
    public async Task A_walk_up_over_signed_http_books_the_selected_court()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory, courtNumbers: [1, 2]);
        var client = factory.CreateClient();

        var response = await client.SendAsync(FromBox(box, WalkUpPath, WalkUp(await QrCodeAsync(factory, box), court: 2)));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        using var check = factory.Services.CreateScope();
        var db = check.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var booking = await db.Bookings.IgnoreQueryFilters().SingleAsync(b => b.UserId == box.MemberId);
        Assert.Equal(box.CourtIds[2], booking.CourtId);
        Assert.NotEqual(box.CourtIds[1], booking.CourtId);
        Assert.NotNull(booking.CheckedInAt);
    }

    /// <summary>
    /// The retry the firmware actually makes: the same signed body with the same nonce,
    /// after a lost response. The original grant comes back with <c>replayed: true</c> and
    /// the member is charged once (review H3).
    /// </summary>
    [SkippableFact]
    public async Task A_walk_up_retried_with_the_same_nonce_over_signed_http_is_replayed_not_resold()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        var client = factory.CreateClient();
        var code = await QrCodeAsync(factory, box);
        const string nonce = "0a1b2c3d4e5f6071";

        var first = await client.SendAsync(FromBox(box, WalkUpPath, WalkUp(code, nonce: nonce)));
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        var firstBody = await first.Content.ReadFromJsonAsync<JsonElement>();

        var again = await client.SendAsync(FromBox(box, WalkUpPath, WalkUp(code, nonce: nonce)));
        Assert.Equal(HttpStatusCode.OK, again.StatusCode);
        var againBody = await again.Content.ReadFromJsonAsync<JsonElement>();

        Assert.True(againBody.GetProperty("replayed").GetBoolean());
        Assert.Equal(firstBody.GetProperty("booking_id").GetGuid(), againBody.GetProperty("booking_id").GetGuid());
        Assert.Equal(30, againBody.GetProperty("granted_minutes").GetInt32());

        using var check = factory.Services.CreateScope();
        var db = check.ServiceProvider.GetRequiredService<MainframeDbContext>();
        Assert.Single(await db.Bookings.IgnoreQueryFilters().Where(b => b.UserId == box.MemberId).ToListAsync());
        Assert.Single(await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.UserId == box.MemberId && l.Type == LedgerEntryType.LightsPurchase).ToListAsync());
    }

    [SkippableFact]
    public async Task A_walk_up_without_a_nonce_is_refused_over_signed_http()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        var client = factory.CreateClient();

        // The old three-field body, exactly as pre-C5 firmware would send it.
        var response = await client.SendAsync(FromBox(box, WalkUpPath, new { minutes = 30, method = "qr", token = await QrCodeAsync(factory, box) }));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("nonce_required", body.GetProperty("error").GetString());
    }

    // ---- lighting a booked court from the box -------------------------------

    /// <summary>
    /// The pre-booked member's path (review C3), over the real wire: a booking-activation
    /// code on the signed device group answers the seconds the box puts on its relay timer.
    /// </summary>
    [SkippableFact]
    public async Task Activate_over_authenticated_http()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory, courtNumbers: [1, 2]);

        Guid bookingId;
        string code;
        using (var scope = factory.Services.CreateScope())
        {
            scope.ServiceProvider.GetRequiredService<Crusaders.Mainframe.Api.Multitenancy.ITenantContext>().Set(box.TenantId, box.Slug);
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var startsAt = DateTimeOffset.UtcNow.AddMinutes(1);
            var booking = new Booking
            {
                TenantId = box.TenantId,
                CourtId = box.CourtIds[2],
                UserId = box.MemberId,
                BookedByUserId = box.MemberId,
                PaidByUserId = box.MemberId,
                ActorUserId = box.MemberId,
                StartsAt = startsAt,
                EndsAt = startsAt.AddMinutes(45),
                SliceMinutes = 15,
                SliceCount = 3,
                AmountChargedCredits = 24m,
                Status = BookingStatus.Booked,
                ChargedAt = DateTimeOffset.UtcNow,
            };
            db.Bookings.Add(booking);
            await db.SaveChangesAsync();
            bookingId = booking.Id;
            code = (await scope.ServiceProvider.GetRequiredService<AccessCodeService>()
                .MintForBookingAsync(booking, TimeSpan.FromMinutes(5), default)).Code;
        }

        var client = factory.CreateClient();
        var response = await client.SendAsync(FromBox(box, ActivatePath, new { method = "qr", token = code }));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(body.GetProperty("activated").GetBoolean());
        Assert.Equal("ok", body.GetProperty("reason").GetString());
        Assert.Equal(2, body.GetProperty("court_number").GetInt32());
        Assert.Equal(bookingId, body.GetProperty("booking_id").GetGuid());
        Assert.InRange(body.GetProperty("granted_seconds").GetInt32(), 45 * 60, 46 * 60 + 1);
        Assert.False(body.TryGetProperty("starts_in_seconds", out _));
        // server_unix went with the clock the device scheme no longer keeps.
        Assert.False(body.TryGetProperty("server_unix", out _));

        using var check = factory.Services.CreateScope();
        var db2 = check.ServiceProvider.GetRequiredService<MainframeDbContext>();
        Assert.NotNull((await db2.Bookings.IgnoreQueryFilters().FirstAsync(b => b.Id == bookingId)).CheckedInAt);
    }

    [SkippableFact]
    public async Task An_unauthenticated_activation_is_refused()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        await SeedAsync(factory);
        var client = factory.CreateClient();

        var response = await client.PostAsJsonAsync(ActivatePath, new { method = "qr", token = "7Q3F9KM2XZ8B" });
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    // ---- the roster the box decides against (review C2) ----------------------

    private const string HeartbeatPath = "/api/v1/device/heartbeat";

    private sealed record Booked(Guid BookingId, string Code);

    /// <summary>
    /// A charged booking for the box's member on <paramref name="courtNumber"/>, with the
    /// BookingCharge on the ledger so a no-show sweep would have something to refund — the
    /// shape the C6 finding is about.
    /// </summary>
    private static async Task<Booked> BookAsync(
        TestWebAppFactory factory, Box box, int courtNumber, double startsInMinutes, int minutes = 45, bool mintCode = true)
    {
        using var scope = factory.Services.CreateScope();
        scope.ServiceProvider.GetRequiredService<Crusaders.Mainframe.Api.Multitenancy.ITenantContext>().Set(box.TenantId, box.Slug);
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var startsAt = DateTimeOffset.UtcNow.AddMinutes(startsInMinutes);
        var booking = new Booking
        {
            TenantId = box.TenantId,
            CourtId = box.CourtIds[courtNumber],
            UserId = box.MemberId,
            BookedByUserId = box.MemberId,
            PaidByUserId = box.MemberId,
            ActorUserId = box.MemberId,
            StartsAt = startsAt,
            EndsAt = startsAt.AddMinutes(minutes),
            SliceMinutes = 15,
            SliceCount = Math.Max(1, minutes / 15),
            AmountChargedCredits = 8m * Math.Max(1, minutes / 15),
            Status = BookingStatus.Booked,
            ChargedAt = DateTimeOffset.UtcNow,
        };
        db.Bookings.Add(booking);
        db.LedgerEntries.Add(new LedgerEntry
        {
            TenantId = box.TenantId,
            UserId = box.MemberId,
            Type = LedgerEntryType.BookingCharge,
            AmountCredits = -booking.AmountChargedCredits,
            ActorUserId = box.MemberId,
            RelatedBookingId = booking.Id,
            Reason = "seed charge",
        });
        await db.SaveChangesAsync();

        var code = mintCode
            ? (await scope.ServiceProvider.GetRequiredService<AccessCodeService>().MintForBookingAsync(booking, TimeSpan.FromMinutes(5), default)).Code
            : "";
        return new Booked(booking.Id, code);
    }

    private static async Task<Booking> BookingAsync(TestWebAppFactory factory, Guid bookingId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.Bookings.IgnoreQueryFilters().AsNoTracking().SingleAsync(b => b.Id == bookingId);
    }

    private static async Task<List<AuditLog>> AuditAsync(TestWebAppFactory factory, Guid tenantId, string action)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.AuditLogs.IgnoreQueryFilters().Where(a => a.TenantId == tenantId && a.Action == action).ToListAsync();
    }

    private static async Task<List<LedgerEntry>> LedgerAsync(TestWebAppFactory factory, Guid bookingId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.LedgerEntries.IgnoreQueryFilters().Where(l => l.RelatedBookingId == bookingId).ToListAsync();
    }

    private static async Task<JsonElement> HeartbeatAsync(TestWebAppFactory factory, Box box)
    {
        var response = await factory.CreateClient().SendAsync(FromBox(box, HeartbeatPath, new { running_version = "1.0.0" }));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    /// <summary>
    /// The heartbeat carries the roster over the real wire, in the four-field shape the
    /// firmware parses, with the relay from the box's own court list and the seconds
    /// relative to the response. The booking was written with no code; the heartbeat mints
    /// it, and the token on the wire is the code the member's phone will show.
    /// </summary>
    [SkippableFact]
    public async Task Heartbeat_carries_the_roster_over_signed_http()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory, courtNumbers: [1, 2]);
        var booked = await BookAsync(factory, box, courtNumber: 2, startsInMinutes: 5, minutes: 45, mintCode: false);

        var body = await HeartbeatAsync(factory, box);

        var roster = body.GetProperty("roster").EnumerateArray().Select(e => e.GetString()!).ToList();
        var entry = Assert.Single(roster);
        Assert.Matches(DeviceProtocolCorpusTests.RosterEntryPattern, entry);

        var fields = entry.Split('|');
        Assert.Equal(1, int.Parse(fields[1]));                                   // court 2 is relay B on this box
        Assert.InRange(long.Parse(fields[2]), (5 - 10) * 60 - 5, (5 - 10) * 60);  // cue of 10 opened five minutes ago
        Assert.InRange(long.Parse(fields[3]), 50 * 60 - 5, 50 * 60);             // ends in fifty

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var code = await db.AccessCodes.IgnoreQueryFilters().SingleAsync(c => c.BookingId == booked.BookingId);
        Assert.Equal(code.Code, fields[0]);
        Assert.Equal(AccessCodePurpose.BookingActivation, code.Purpose);
    }

    /// <summary>
    /// Seventeen bookings in the window: sixteen go, and the whole response still fits the
    /// box's buffer. The cap is what bounds the response, so this is where the byte budget
    /// is held against the live serializer rather than a hand-written vector.
    /// </summary>
    [SkippableFact]
    public async Task Heartbeat_roster_is_capped_at_sixteen_and_the_response_fits_the_boxs_buffer()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        // The literal, not the constant: this is the contract number the firmware buffer is
        // sized to (bridgelogic::kMaxRosterEntries), and a test that reads the cap off the
        // builder would follow the builder if somebody raised it.
        const int contractCap = 16;

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory, courtNumbers: [1, 2, 3, 4]);
        for (var i = 0; i < contractCap + 2; i++)
        {
            await BookAsync(factory, box, courtNumber: 1 + (i % 4), startsInMinutes: 1 + i * 5, minutes: 5);
        }

        var response = await factory.CreateClient().SendAsync(FromBox(box, HeartbeatPath, new { running_version = "1.0.0" }));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var bytes = await response.Content.ReadAsByteArrayAsync();
        Assert.True(bytes.Length <= 2048, $"heartbeat response is {bytes.Length} bytes; the box holds 2048");

        var roster = JsonDocument.Parse(bytes).RootElement.GetProperty("roster").EnumerateArray().Select(e => e.GetString()!).ToList();
        Assert.Equal(contractCap, roster.Count);
        Assert.All(roster, e => Assert.Matches(DeviceProtocolCorpusTests.RosterEntryPattern, e));
        Assert.DoesNotContain(roster, e => e.Contains('\\'));   // the serializer must not escape the separator
    }

    // ---- activation events become attendance (review C6) -----------------------

    /// <summary>
    /// The C6 headline. The box admitted a member from its roster, queued the activation,
    /// and uploaded it; the no-show sweep then runs past the grace window. Before this the
    /// upload wrote a receipt and nothing else, so the member was swept, refunded and
    /// penalised for a court they played on. Now the event is attendance: no refund, no
    /// penalty, no NoShow.
    /// </summary>
    [SkippableFact]
    public async Task Activation_event_stamps_checked_in_and_survives_no_show_sweep()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory, courtNumbers: [1, 2]);
        // Started ten minutes ago against a five-minute grace: due for the sweep unless
        // somebody checked in.
        var booked = await BookAsync(factory, box, courtNumber: 2, startsInMinutes: -10);

        var response = await factory.CreateClient().SendAsync(
            FromBox(box, EventsPath, Batch(Activation(1, subject: booked.Code, court: 1))));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(1, body.GetProperty("accepted_through").GetInt64());

        var stamped = await BookingAsync(factory, booked.BookingId);
        Assert.NotNull(stamped.CheckedInAt);

        await SweepAsync(factory);

        var after = await BookingAsync(factory, booked.BookingId);
        Assert.Equal(BookingStatus.Booked, after.Status);
        Assert.NotNull(after.CheckedInAt);

        var ledger = await LedgerAsync(factory, booked.BookingId);
        Assert.DoesNotContain(ledger, l => l.Type == LedgerEntryType.CancellationRefund);
        Assert.DoesNotContain(ledger, l => l.Type == LedgerEntryType.NoShowPenalty);
        Assert.Single(await AuditAsync(factory, box.TenantId, "court.activated"));
    }

    /// <summary>
    /// The app with email stubbed into <paramref name="mail"/>. The sweep and the reversal
    /// both send, and neither may dial SMTP for every tenant in the shared database.
    /// </summary>
    private static WebApplicationFactory<Program> Quiet(TestWebAppFactory factory, StubEmailService mail)
        => factory.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<Crusaders.Mainframe.Api.Email.IEmailService>();
            s.AddSingleton<Crusaders.Mainframe.Api.Email.IEmailService>(mail);
        }));

    /// <summary>One tick of the real no-show sweep, quietly.</summary>
    private static async Task SweepAsync(TestWebAppFactory factory)
    {
        await using var quiet = Quiet(factory, new StubEmailService());
        var worker = new NoShowWorker(quiet.Services, quiet.Services.GetRequiredService<IEventBus>(), NullLogger<NoShowWorker>.Instance);
        await worker.TickAsync(default);
    }

    private static async Task<decimal> BalanceAsync(TestWebAppFactory factory, Guid userId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.LedgerEntries.IgnoreQueryFilters().Where(l => l.UserId == userId).SumAsync(l => l.AmountCredits);
    }

    /// <summary>Whole seconds, so a value that round-trips through timestamptz compares equal to itself.</summary>
    private static DateTimeOffset WholeSeconds(DateTimeOffset t) => DateTimeOffset.FromUnixTimeSeconds(t.ToUnixTimeSeconds());

    /// <summary>
    /// A booking that started ten minutes ago against a five-minute grace, swept as a
    /// no-show: refunded in full, penalised, released. The state a box that lost WiFi at
    /// the wrong moment finds when it reconnects.
    /// </summary>
    private static async Task<(Booked Booked, Booking Swept)> SweptNoShowAsync(TestWebAppFactory factory, Box box)
    {
        var booked = await BookAsync(factory, box, courtNumber: 1, startsInMinutes: -10);
        await SweepAsync(factory);

        var swept = await BookingAsync(factory, booked.BookingId);
        Assert.Equal(BookingStatus.NoShow, swept.Status);
        Assert.Null(swept.CheckedInAt);

        var settled = await LedgerAsync(factory, booked.BookingId);
        Assert.Equal(24m, Assert.Single(settled, l => l.Type == LedgerEntryType.CancellationRefund).AmountCredits);
        Assert.True(Assert.Single(settled, l => l.Type == LedgerEntryType.NoShowPenalty).AmountCredits < 0);
        return (booked, swept);
    }

    /// <summary>
    /// The four settlement rows a reversed no-show leaves behind the charge, and the shape
    /// each must have: refund and penalty as the sweep posted them, a debit reversing the
    /// refund and a credit reversing the penalty — the same two types with the opposite
    /// sign, each carrying a reason and its own reference, never netted into one.
    /// </summary>
    private static async Task AssertReversedLedgerAsync(TestWebAppFactory factory, Guid bookingId)
    {
        var ledger = await LedgerAsync(factory, bookingId);
        Assert.Equal(5, ledger.Count);   // the seed charge, and the four settlement rows

        var refunds = ledger.Where(l => l.Type == LedgerEntryType.CancellationRefund).ToList();
        var penalties = ledger.Where(l => l.Type == LedgerEntryType.NoShowPenalty).ToList();
        Assert.Equal(2, refunds.Count);
        Assert.Equal(2, penalties.Count);
        Assert.Equal(0m, refunds.Sum(l => l.AmountCredits));
        Assert.Equal(0m, penalties.Sum(l => l.AmountCredits));

        var refundReversal = Assert.Single(refunds, l => l.AmountCredits < 0);
        var penaltyReversal = Assert.Single(penalties, l => l.AmountCredits > 0);
        Assert.Equal(BookingService.NoShowReversalReference(bookingId, "refund"), refundReversal.ExternalReference);
        Assert.Equal(BookingService.NoShowReversalReference(bookingId, "penalty"), penaltyReversal.ExternalReference);
        Assert.All(ledger, l => Assert.False(string.IsNullOrWhiteSpace(l.Reason)));
        Assert.All(ledger, l => Assert.Equal(bookingId, l.RelatedBookingId));
    }

    /// <summary>
    /// The C6 hazard in its remaining form. A box offline for longer than the grace window
    /// lit the court from its roster and queued the scan; by the time WiFi returned the
    /// sweep had settled the booking as a no-show. The uploaded scan used to resolve to
    /// "not chargeable" — the member who played kept the refund, paid the penalty, and the
    /// ledger said they never came. Late evidence now reverses the settlement: two new
    /// rows, the row <c>Booked</c> and checked in at the scan, the balance back where the
    /// charge left it. <c>EndsAt</c> is restored to the end the member paid for — the
    /// lights ran that long from the box's own timer, and a truncated end left the tail
    /// sellable at the box while the court was lit (decision 2026-09-04, review #16).
    /// </summary>
    [SkippableFact]
    public async Task Late_activation_after_the_sweep_reverses_the_no_show()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        var (booked, swept) = await SweptNoShowAsync(factory, box);

        var mail = new StubEmailService();
        await using var quiet = Quiet(factory, mail);

        // The scan happened five minutes ago, inside the slot, and is only reaching the
        // server now.
        var before = DateTimeOffset.UtcNow;
        var response = await quiet.CreateClient().SendAsync(
            FromBox(box, EventsPath, Batch(Activation(1, subject: booked.Code, court: 0))));
        var after = DateTimeOffset.UtcNow;
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(1, (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accepted_through").GetInt64());

        var reversed = await BookingAsync(factory, booked.BookingId);
        Assert.Equal(BookingStatus.Booked, reversed.Status);
        Assert.NotNull(reversed.CheckedInAt);
        Assert.InRange(reversed.CheckedInAt!.Value, before.AddMinutes(-5), after.AddMinutes(-5));
        Assert.True(reversed.EndsAt > swept.EndsAt, "the truncated end is restored");
        Assert.Equal(BookingService.OriginalEndsAt(reversed), reversed.EndsAt);
        Assert.Null(reversed.LightsOffCuedAt);   // the real lights-off is still ahead; the cue worker fires it once

        await AssertReversedLedgerAsync(factory, booked.BookingId);
        Assert.Equal(200m - 24m, await BalanceAsync(factory, box.MemberId));

        Assert.Single(await AuditAsync(factory, box.TenantId, "booking.no_show_reversed"));
        Assert.Single(await AuditAsync(factory, box.TenantId, "device.activation_reversed_no_show"));
        Assert.Empty(await AuditAsync(factory, box.TenantId, "device.activation_not_chargeable"));
        Assert.Contains(mail.Sent, m => m.Subject.StartsWith("No-show reversed", StringComparison.Ordinal));
    }

    /// <summary>
    /// The box lost the acknowledgement, or a second scan of the same session arrives
    /// later. The row is live and checked in, so the ordinary idempotent path answers —
    /// no second reversal, no fifth and sixth settlement rows.
    /// </summary>
    [SkippableFact]
    public async Task A_second_late_activation_does_not_reverse_twice()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        var (booked, _) = await SweptNoShowAsync(factory, box);

        await using var quiet = Quiet(factory, new StubEmailService());
        var client = quiet.CreateClient();

        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(
            FromBox(box, EventsPath, Batch(Activation(1, subject: booked.Code, court: 0))))).StatusCode);
        var stampedAt = (await BookingAsync(factory, booked.BookingId)).CheckedInAt;
        Assert.NotNull(stampedAt);

        var again = await client.SendAsync(FromBox(box, EventsPath, Batch(Activation(2, subject: booked.Code, court: 0))));
        Assert.Equal(HttpStatusCode.OK, again.StatusCode);
        var body = await again.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(2, body.GetProperty("accepted_through").GetInt64());
        Assert.Equal(1, body.GetProperty("recorded").GetInt32());

        var booking = await BookingAsync(factory, booked.BookingId);
        Assert.Equal(BookingStatus.Booked, booking.Status);
        Assert.Equal(stampedAt, booking.CheckedInAt);

        await AssertReversedLedgerAsync(factory, booked.BookingId);
        Assert.Equal(200m - 24m, await BalanceAsync(factory, box.MemberId));
        Assert.Single(await AuditAsync(factory, box.TenantId, "booking.no_show_reversed"));
        Assert.Single(await AuditAsync(factory, box.TenantId, "device.activation_reversed_no_show"));
        Assert.Equal(2, (await AuditAsync(factory, box.TenantId, "device.activation")).Count);
    }

    /// <summary>
    /// The mirror of the too-early case. The member scanned five minutes into their slot;
    /// the box only reconnected after the slot had ended and the roster code had expired.
    /// The scan is judged when it happened — the code was live, the cue window was open —
    /// and attendance is stamped at the scan, not at the upload.
    /// </summary>
    [SkippableFact]
    public async Task Activation_event_scanned_inside_the_cue_window_but_uploaded_late_is_stamped_at_scan_time()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        // Started an hour ago and ran forty-five minutes: over, and its code expired with it.
        var booked = await BookAsync(factory, box, courtNumber: 1, startsInMinutes: -60);

        const long batchUptime = 4_000_000;
        const long scannedMinutesAgo = 55;
        var before = DateTimeOffset.UtcNow;
        var response = await factory.CreateClient().SendAsync(FromBox(box, EventsPath,
            BatchAt(batchUptime, Activation(1, subject: booked.Code, court: 0, uptimeMs: batchUptime - scannedMinutesAgo * 60_000))));
        var after = DateTimeOffset.UtcNow;
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var booking = await BookingAsync(factory, booked.BookingId);
        Assert.NotNull(booking.CheckedInAt);
        Assert.InRange(booking.CheckedInAt!.Value, before.AddMinutes(-scannedMinutesAgo), after.AddMinutes(-scannedMinutesAgo));
        Assert.Equal(booking.CheckedInAt, booking.LightsOnCuedAt);
        Assert.Single(await AuditAsync(factory, box.TenantId, "court.activated"));
        Assert.Empty(await AuditAsync(factory, box.TenantId, "device.activation_unresolved"));
    }

    /// <summary>
    /// The other direction of the same rule. The box admitted the member half an hour
    /// before the cue window opened and uploaded the event once it had; judged at the
    /// upload the scan would pass, judged when it happened it is what it was — too early.
    /// </summary>
    [SkippableFact]
    public async Task Activation_event_scanned_ahead_of_the_cue_window_but_uploaded_inside_it_is_not_stamped()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        // Starts in five minutes: the ten-minute cue opened five minutes ago.
        var booked = await BookAsync(factory, box, courtNumber: 1, startsInMinutes: 5);

        const long batchUptime = 4_000_000;
        var response = await factory.CreateClient().SendAsync(FromBox(box, EventsPath,
            BatchAt(batchUptime, Activation(1, subject: booked.Code, court: 0, uptimeMs: batchUptime - 30 * 60_000))));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var booking = await BookingAsync(factory, booked.BookingId);
        Assert.Null(booking.CheckedInAt);
        Assert.Null(booking.LightsOnCuedAt);
        Assert.Single(await AuditAsync(factory, box.TenantId, "device.activation_too_early"));
        Assert.Empty(await AuditAsync(factory, box.TenantId, "court.activated"));
    }

    /// <summary>
    /// A box's clock is the server's clock minus how long ago its uptime says the event
    /// was. Two claims are not believed: a scan in the FUTURE (the queue outlived a reboot
    /// and carries a previous boot's uptime), and one past the thirty-day sanity bound.
    /// Both are judged at the upload instead and the claim is kept on an audit row so the
    /// desk can see the counter is broken. Anything in between — hours, a day — is the
    /// outage the queue exists for and is believed; see the twenty-hour test below.
    /// </summary>
    [SkippableTheory]
    [InlineData(600_000L, 900_000L)]                 // ahead of the upload: the queue outlived a reboot
    [InlineData(3_000_000_000L, 0L)]                 // thirty-five days behind it: past the sanity bound
    public async Task Activation_event_with_a_wild_occurred_at_is_clamped_and_audited(long batchUptime, long eventUptime)
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        var booked = await BookAsync(factory, box, courtNumber: 1, startsInMinutes: -2);

        var before = DateTimeOffset.UtcNow;
        var response = await factory.CreateClient().SendAsync(FromBox(box, EventsPath,
            BatchAt(batchUptime, Activation(1, subject: booked.Code, court: 0, uptimeMs: eventUptime))));
        var after = DateTimeOffset.UtcNow;
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var booking = await BookingAsync(factory, booked.BookingId);
        Assert.NotNull(booking.CheckedInAt);
        Assert.InRange(booking.CheckedInAt!.Value, before, after);

        var clamped = Assert.Single(await AuditAsync(factory, box.TenantId, "device.event_time_clamped"));
        Assert.Contains("occurred_at_clamped_from", clamped.DetailsJson);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var receipt = await db.DeviceEventReceipts.IgnoreQueryFilters().SingleAsync(r => r.DeviceId == box.DeviceId);
        Assert.InRange(receipt.OccurredAt, before, after);
    }

    /// <summary>
    /// The long outage — the case the six-hour clamp destroyed (closing re-review #6/#7).
    /// Router dies at 17:30, the box admits the evening from its roster, the router is
    /// fixed the next afternoon. The member's slot ended nineteen hours before the upload
    /// and was swept as a no-show; the roster code expired at slot end plus grace. Judged
    /// at the upload the code is dead and the event resolves to nothing — refunded,
    /// penalised, a no-show for a court they played on. Judged at the scan, which is
    /// what the arithmetic says and what the box's server-derived clock makes exact, the
    /// code is live and the no-show is reversed.
    /// </summary>
    [SkippableFact]
    public async Task Activation_uploaded_twenty_hours_late_for_a_booking_swept_nineteen_hours_ago_is_reversed()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        // Started 20h05m ago, ran 45 minutes: over since 19h20m ago, code dead since 19h15m ago.
        var booked = await BookAsync(factory, box, courtNumber: 1, startsInMinutes: -(20 * 60 + 5));
        await SweepAsync(factory);
        var swept = await BookingAsync(factory, booked.BookingId);
        Assert.Equal(BookingStatus.NoShow, swept.Status);

        var mail = new StubEmailService();
        await using var quiet = Quiet(factory, mail);

        // The box has been up 22 hours; the scan was 20 hours ago, five minutes into the slot.
        const long batchUptime = 22L * 3600 * 1000;
        const long scannedAgoMs = 20L * 3600 * 1000;
        var before = DateTimeOffset.UtcNow;
        var response = await quiet.CreateClient().SendAsync(FromBox(box, EventsPath,
            BatchAt(batchUptime, Activation(1, subject: booked.Code, court: 0, uptimeMs: batchUptime - scannedAgoMs))));
        var after = DateTimeOffset.UtcNow;
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var reversed = await BookingAsync(factory, booked.BookingId);
        Assert.Equal(BookingStatus.Booked, reversed.Status);
        Assert.NotNull(reversed.CheckedInAt);
        Assert.InRange(reversed.CheckedInAt!.Value, before.AddMilliseconds(-scannedAgoMs), after.AddMilliseconds(-scannedAgoMs));

        await AssertReversedLedgerAsync(factory, booked.BookingId);
        Assert.Equal(200m - 24m, await BalanceAsync(factory, box.MemberId));
        Assert.Single(await AuditAsync(factory, box.TenantId, "device.activation_reversed_no_show"));
        Assert.Empty(await AuditAsync(factory, box.TenantId, "device.activation_unresolved"));
        Assert.Empty(await AuditAsync(factory, box.TenantId, "device.event_time_clamped"));
        Assert.Contains(mail.Sent, m => m.Subject.StartsWith("No-show reversed", StringComparison.Ordinal));
    }

    /// <summary>
    /// The cue gate applies on the reversal branch too: a box that admitted a member half
    /// an hour before the window opened and then lost the link for a day is reporting a
    /// scan that broke the rule, not one that kept it.
    /// </summary>
    [SkippableFact]
    public async Task A_late_activation_scanned_ahead_of_the_cue_window_does_not_reverse_the_sweep()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        var booked = await BookAsync(factory, box, courtNumber: 1, startsInMinutes: -60);
        await SweepAsync(factory);

        // Scanned 100 minutes ago: forty minutes before a slot that started sixty ago.
        const long batchUptime = 4_000_000;
        var response = await factory.CreateClient().SendAsync(FromBox(box, EventsPath,
            BatchAt(batchUptime, Activation(1, subject: booked.Code, court: 0, uptimeMs: batchUptime - 100 * 60_000))));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var booking = await BookingAsync(factory, booked.BookingId);
        Assert.Equal(BookingStatus.NoShow, booking.Status);
        Assert.Null(booking.CheckedInAt);
        Assert.Single(await AuditAsync(factory, box.TenantId, "device.activation_too_early"));
        Assert.Empty(await AuditAsync(factory, box.TenantId, "booking.no_show_reversed"));
    }

    // ---- the resold tail (closing re-review #16) ------------------------------------

    /// <summary>
    /// A second booking on a court the first member was still playing on, so the box
    /// cannot lie about it. Written directly, at a start inside the tail the sweep released.
    /// </summary>
    private static async Task<Booked> BookOnTailAsync(
        TestWebAppFactory factory, Box box, Guid userId, double startsInMinutes, int minutes,
        BookingStatus status = BookingStatus.Booked, bool charged = true, bool mintCode = false)
    {
        using var scope = factory.Services.CreateScope();
        scope.ServiceProvider.GetRequiredService<Crusaders.Mainframe.Api.Multitenancy.ITenantContext>().Set(box.TenantId, box.Slug);
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var startsAt = DateTimeOffset.UtcNow.AddMinutes(startsInMinutes);
        var booking = new Booking
        {
            TenantId = box.TenantId,
            CourtId = box.CourtIds[1],
            UserId = userId,
            BookedByUserId = userId,
            PaidByUserId = userId,
            ActorUserId = userId,
            StartsAt = startsAt,
            EndsAt = startsAt.AddMinutes(minutes),
            SliceMinutes = 15,
            SliceCount = Math.Max(1, minutes / 15),
            AmountChargedCredits = 8m * Math.Max(1, minutes / 15),
            Status = status,
            ChargedAt = charged ? DateTimeOffset.UtcNow : null,
        };
        db.Bookings.Add(booking);
        if (charged)
        {
            db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = box.TenantId, UserId = userId, Type = LedgerEntryType.BookingCharge,
                AmountCredits = -booking.AmountChargedCredits, ActorUserId = userId, RelatedBookingId = booking.Id, Reason = "seed charge",
            });
        }
        if (status == BookingStatus.NoShow)
        {
            // As the sweep would have left it: refunded in full, penalised 30%.
            db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = box.TenantId, UserId = userId, Type = LedgerEntryType.CancellationRefund,
                AmountCredits = booking.AmountChargedCredits, ActorUserId = Guid.Empty, RelatedBookingId = booking.Id, Reason = "No-show — booking refunded",
            });
            db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = box.TenantId, UserId = userId, Type = LedgerEntryType.NoShowPenalty,
                AmountCredits = -Math.Round(booking.AmountChargedCredits * 0.3m, 2), ActorUserId = Guid.Empty, RelatedBookingId = booking.Id, Reason = "No-show penalty",
            });
        }
        await db.SaveChangesAsync();
        var code = mintCode
            ? (await scope.ServiceProvider.GetRequiredService<AccessCodeService>().MintForBookingAsync(booking, TimeSpan.FromMinutes(5), default)).Code
            : "";
        return new Booked(booking.Id, code);
    }

    /// <summary>A second funded member of the box's club.</summary>
    private static async Task<Guid> AnotherMemberAsync(TestWebAppFactory factory, Box box, decimal credits = 200m)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var other = new User { TenantId = box.TenantId, Email = $"other-{Guid.NewGuid():N}@test.local", PasswordHash = "x", EmailVerified = true };
        db.Users.Add(other);
        db.Memberships.Add(new Membership
        {
            TenantId = box.TenantId, UserId = other.Id, FullName = "Second Buyer",
            MembershipNumber = $"o-{Guid.NewGuid():N}"[..20], Status = MembershipStatus.Active, MemberClass = MemberClass.Regular,
        });
        db.LedgerEntries.Add(new LedgerEntry
        {
            TenantId = box.TenantId, UserId = other.Id, Type = LedgerEntryType.TopUp, AmountCredits = credits, ActorUserId = other.Id, Reason = "seed",
        });
        await db.SaveChangesAsync();
        return other.Id;
    }

    /// <summary>
    /// The sweep released A's tail and B bought part of it; A's late event then reverses
    /// A's no-show. B arrived to a lit court with A on it. B is displaced: cancelled with
    /// the whole charge back as its own row (reason ResoldTailRefunded), no penalty, an
    /// audit row, an email, a booking.displaced event — and A's end is restored, so the
    /// tail is not sold a second time at the box while A is still lit. A row the sweep had
    /// already settled (C) gets its penalty back instead of a second refund.
    /// </summary>
    [SkippableFact]
    public async Task A_late_activation_displaces_bookings_sold_on_the_released_tail()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        var (booked, swept) = await SweptNoShowAsync(factory, box);   // A: started -10, 45 min, tail [now, +35) released
        var buyer = await AnotherMemberAsync(factory, box);
        var b = await BookOnTailAsync(factory, box, buyer, startsInMinutes: 20, minutes: 15);                       // Booked, charged 8
        var c = await BookOnTailAsync(factory, box, buyer, startsInMinutes: 1, minutes: 15, status: BookingStatus.NoShow); // swept: refunded 8, penalised 2.40
        var buyerBefore = await BalanceAsync(factory, buyer);

        var mail = new StubEmailService();
        await using var quiet = Quiet(factory, mail);
        var response = await quiet.CreateClient().SendAsync(
            FromBox(box, EventsPath, Batch(Activation(1, subject: booked.Code, court: 0))));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var a = await BookingAsync(factory, booked.BookingId);
        Assert.Equal(BookingStatus.Booked, a.Status);
        Assert.Equal(BookingService.OriginalEndsAt(a), a.EndsAt);
        Assert.True(a.EndsAt > swept.EndsAt);

        var displacedB = await BookingAsync(factory, b.BookingId);
        Assert.Equal(BookingStatus.Cancelled, displacedB.Status);
        Assert.True(displacedB.CancellationPenaltyWaived);
        Assert.Equal(BookingService.ResoldTailRefunded, displacedB.CancellationReason);
        var refundB = Assert.Single(await LedgerAsync(factory, b.BookingId), l => l.Type == LedgerEntryType.CancellationRefund);
        Assert.Equal(8m, refundB.AmountCredits);
        Assert.Contains(BookingService.ResoldTailRefunded, refundB.Reason);
        Assert.Equal(BookingService.DisplacedReference(a.Id, b.BookingId), refundB.ExternalReference);

        var displacedC = await BookingAsync(factory, c.BookingId);
        Assert.Equal(BookingStatus.Cancelled, displacedC.Status);
        var penaltiesC = (await LedgerAsync(factory, c.BookingId)).Where(l => l.Type == LedgerEntryType.NoShowPenalty).ToList();
        Assert.Equal(2, penaltiesC.Count);
        Assert.Equal(0m, penaltiesC.Sum(l => l.AmountCredits));
        Assert.Single(await LedgerAsync(factory, c.BookingId), l => l.Type == LedgerEntryType.CancellationRefund);   // the sweep's; not a second one

        // B's charge back, C's penalty back: the buyer is where they started.
        Assert.Equal(buyerBefore + 8m + 2.40m, await BalanceAsync(factory, buyer));

        Assert.Equal(2, (await AuditAsync(factory, box.TenantId, "booking.displaced")).Count);
        var reversal = Assert.Single(await AuditAsync(factory, box.TenantId, "booking.no_show_reversed"));
        Assert.Contains(b.BookingId.ToString(), reversal.DetailsJson);
        Assert.Contains(c.BookingId.ToString(), reversal.DetailsJson);
        Assert.Equal(2, mail.Sent.Count(m => m.Subject.StartsWith("Booking refunded", StringComparison.Ordinal)));

        // A's own reversal is untouched by the displacement rows.
        await AssertReversedLedgerAsync(factory, booked.BookingId);
    }

    /// <summary>
    /// A booking on the tail that somebody DID check in on is not displaced — two people
    /// cannot both have played and the ledger is not the place to guess — and A's end is
    /// restored only up to it.
    /// </summary>
    [SkippableFact]
    public async Task A_checked_in_booking_on_the_tail_survives_and_bounds_the_restored_end()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        var (booked, _) = await SweptNoShowAsync(factory, box);
        var buyer = await AnotherMemberAsync(factory, box);
        var d = await BookOnTailAsync(factory, box, buyer, startsInMinutes: 20, minutes: 15);
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var row = await db.Bookings.IgnoreQueryFilters().SingleAsync(x => x.Id == d.BookingId);
            row.CheckedInAt = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync();
        }

        await using var quiet = Quiet(factory, new StubEmailService());
        Assert.Equal(HttpStatusCode.OK, (await quiet.CreateClient().SendAsync(
            FromBox(box, EventsPath, Batch(Activation(1, subject: booked.Code, court: 0))))).StatusCode);

        var a = await BookingAsync(factory, booked.BookingId);
        var survivor = await BookingAsync(factory, d.BookingId);
        Assert.Equal(BookingStatus.Booked, survivor.Status);
        Assert.Equal(BookingStatus.Booked, a.Status);
        Assert.Equal(survivor.StartsAt, a.EndsAt);
        Assert.Empty(await AuditAsync(factory, box.TenantId, "booking.displaced"));
        Assert.Contains(d.BookingId.ToString(), Assert.Single(await AuditAsync(factory, box.TenantId, "booking.no_show_reversed")).DetailsJson);
    }

    // ---- a cancelled booking lit from a stale roster (closing re-review #21) ---------

    private static async Task<CancellationResult.Ok> CancelAsync(
        TestWebAppFactory factory, Box box, Guid bookingId, bool waivePenalty = true)
    {
        using var scope = factory.Services.CreateScope();
        scope.ServiceProvider.GetRequiredService<Crusaders.Mainframe.Api.Multitenancy.ITenantContext>().Set(box.TenantId, box.Slug);
        var bookings = scope.ServiceProvider.GetRequiredService<BookingService>();
        var result = await bookings.CancelAsync(bookingId, Guid.NewGuid(), actorIsAdmin: true, waivePenalty, default);
        return Assert.IsType<CancellationResult.Ok>(result);
    }

    /// <summary>
    /// Book, cancel (full refund), walk in during a WiFi drop: the box's roster still
    /// carries the code and lights the court for the slot. "Nothing back once the lights
    /// have been on" — the lit time is charged pro rata as a LightsPurchase, separate from
    /// the refund, audited as activation_after_cancel, once per booking, and the member
    /// is told. The refund itself is never edited.
    ///
    /// <para>
    /// <b>The billed minutes are the sold window, not the grant</b> (settlement model I6,
    /// round-3 finding 3). The member scanned three minutes before the slot — inside the cue
    /// window, which is where the roster's own window opens — and the box granted sixty
    /// minutes on a forty-five-minute booking. Forty-five is billed. The old arithmetic took
    /// <c>min(grant, OriginalEndsAt − scan)</c> with no lower bound at <c>StartsAt</c> and no
    /// cap at the sold minutes, and billed forty-eight.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task Activation_for_a_booking_cancelled_after_its_code_was_pushed_charges_the_lit_time()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        var booked = await BookAsync(factory, box, courtNumber: 1, startsInMinutes: -2);   // 45 min, 24 credits
        await CancelAsync(factory, box, booked.BookingId);
        Assert.Equal(200m, await BalanceAsync(factory, box.MemberId));   // charged 24, refunded 24

        var mail = new StubEmailService();
        await using var quiet = Quiet(factory, mail);
        var client = quiet.CreateClient();

        // The box granted sixty minutes from a window that opened before the slot did.
        var response = await client.SendAsync(FromBox(box, EventsPath,
            Batch(Activation(1, subject: booked.Code, court: 0, durationMs: 3_600_000))));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(1, (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accepted_through").GetInt64());

        var booking = await BookingAsync(factory, booked.BookingId);
        Assert.Equal(BookingStatus.Cancelled, booking.Status);
        Assert.Null(booking.CheckedInAt);

        var ledger = await LedgerAsync(factory, booked.BookingId);
        var lit = Assert.Single(ledger, l => l.Type == LedgerEntryType.LightsPurchase);
        Assert.Equal(-24m, lit.AmountCredits);                                     // 45 sold min at 8 credits / 15 min, not 48 granted
        Assert.Equal(BookingService.CancelledLightsReference(booked.BookingId), lit.ExternalReference);
        Assert.Single(ledger, l => l.Type == LedgerEntryType.CancellationRefund);   // the refund stands, un-netted
        Assert.Equal(200m - 24m, await BalanceAsync(factory, box.MemberId));

        Assert.Single(await AuditAsync(factory, box.TenantId, "device.activation_after_cancel"));
        Assert.Single(await AuditAsync(factory, box.TenantId, "booking.cancelled_lights_charged"));
        Assert.Empty(await AuditAsync(factory, box.TenantId, "device.activation_not_chargeable"));
        Assert.Contains(mail.Sent, m => m.Subject.StartsWith("Lights charged", StringComparison.Ordinal));

        // A rescan is another event, not another charge.
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(FromBox(box, EventsPath,
            Batch(Activation(2, subject: booked.Code, court: 0, durationMs: 3_600_000))))).StatusCode);
        Assert.Single(await LedgerAsync(factory, booked.BookingId), l => l.Type == LedgerEntryType.LightsPurchase);
        Assert.Equal(200m - 24m, await BalanceAsync(factory, box.MemberId));
    }

    /// <summary>The correction is posted whatever the balance: a member who spent the refund goes negative.</summary>
    [SkippableFact]
    public async Task The_cancelled_lights_charge_is_posted_even_when_the_balance_cannot_cover_it()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory, topUpCredits: 24m);
        var booked = await BookAsync(factory, box, courtNumber: 1, startsInMinutes: -2);
        await CancelAsync(factory, box, booked.BookingId);
        using (var scope = factory.Services.CreateScope())
        {
            // The refund is spent elsewhere before the box reconnects.
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            db.LedgerEntries.Add(new LedgerEntry { TenantId = box.TenantId, UserId = box.MemberId, Type = LedgerEntryType.BookingCharge, AmountCredits = -20m, ActorUserId = box.MemberId, Reason = "elsewhere" });
            await db.SaveChangesAsync();
        }
        Assert.Equal(4m, await BalanceAsync(factory, box.MemberId));

        await using var quiet = Quiet(factory, new StubEmailService());
        Assert.Equal(HttpStatusCode.OK, (await quiet.CreateClient().SendAsync(
            FromBox(box, EventsPath, Batch(Activation(1, subject: booked.Code, court: 0, durationMs: 3_600_000))))).StatusCode);

        Assert.Equal(4m - 24m, await BalanceAsync(factory, box.MemberId));
        Assert.Single(await AuditAsync(factory, box.TenantId, "device.activation_after_cancel"));
    }

    // ---- a booking code is not a wallet (closing re-review #19) ----------------------

    /// <summary>
    /// A booking-activation code names its member, and for a while that made it a
    /// spendable identity: anyone who read a roster code — pushed in clear to every box
    /// driving that court — could buy court time on that member's credits. A booking code
    /// opens its own booking on the activation paths and nothing else; a walk-up needs the
    /// member's ident code.
    /// </summary>
    [SkippableFact]
    public async Task A_booking_code_is_refused_as_a_walk_up_buyer()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory, courtNumbers: [1, 2]);
        var booked = await BookAsync(factory, box, courtNumber: 1, startsInMinutes: 60);   // a live roster code for court 1
        var before = await BalanceAsync(factory, box.MemberId);

        var response = await factory.CreateClient().SendAsync(FromBox(box, WalkUpPath, WalkUp(booked.Code, minutes: 60, court: 2)));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("not_recognised", (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());
        Assert.Equal(before, await BalanceAsync(factory, box.MemberId));
        Assert.Empty(await AuditAsync(factory, box.TenantId, "booking.walk_up_created"));

        // ...while the same code still opens its own booking on the activation path.
        var activate = await factory.CreateClient().SendAsync(FromBox(box, ActivatePath, new { method = "qr", token = booked.Code }));
        Assert.Equal(HttpStatusCode.OK, activate.StatusCode);
        Assert.Equal("too_early", (await activate.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("reason").GetString());
    }

    /// <summary>Club B's booking code at club A's box: unknown there, whatever kind it is.</summary>
    [SkippableFact]
    public async Task Another_clubs_booking_code_is_refused_as_a_walk_up_buyer_here()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var boxA = await SeedAsync(factory);
        var boxB = await SeedAsync(factory);
        var bookedB = await BookAsync(factory, boxB, courtNumber: 1, startsInMinutes: 60);
        var before = await BalanceAsync(factory, boxB.MemberId);

        var response = await factory.CreateClient().SendAsync(FromBox(boxA, WalkUpPath, WalkUp(bookedB.Code)));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("not_recognised", (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());
        Assert.Equal(before, await BalanceAsync(factory, boxB.MemberId));
    }

    // ---- a replay grants the remainder, and nothing once over (closing re-review #20) --

    private static async Task ShiftWalkUpAsync(TestWebAppFactory factory, Guid bookingId, double startsInMinutes, double endsInMinutes, BookingStatus? status = null)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var row = await db.Bookings.IgnoreQueryFilters().SingleAsync(b => b.Id == bookingId);
        row.StartsAt = DateTimeOffset.UtcNow.AddMinutes(startsInMinutes);
        row.EndsAt = DateTimeOffset.UtcNow.AddMinutes(endsInMinutes);
        if (status is { } st) row.Status = st;
        await db.SaveChangesAsync();
    }

    /// <summary>
    /// The 17:00 purchase whose response was lost, rescanned at 17:40 with the same nonce:
    /// the box used to be told the ORIGINAL sixty minutes and drove the relay for an hour
    /// from 17:40, over whoever held the next slots. A replay grants what is left of the
    /// window; a window that has ended, or a purchase no longer Booked, is refused.
    /// </summary>
    [SkippableFact]
    public async Task A_replayed_walk_up_grants_the_remainder_and_is_refused_once_the_window_has_ended()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        // The club's day ends at local midnight, and this test buys a full hour from the
        // service's own UtcNow — so run it in a zone where that hour fits. See
        // TestHost.DayZoneFor: without it this asserts 60 granted minutes and gets whatever
        // was left of the local day, for the last hour of every day.
        await ClearOfClosingAsync(factory, box.TenantId, 60);
        var client = factory.CreateClient();
        var nonce = Guid.NewGuid().ToString("N")[..16];
        var request = WalkUp(await QrCodeAsync(factory, box), minutes: 60, court: 1, nonce: nonce);

        var first = await client.SendAsync(FromBox(box, WalkUpPath, request));
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        var firstBody = await first.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(60, firstBody.GetProperty("granted_minutes").GetInt32());
        var bookingId = firstBody.GetProperty("booking_id").GetGuid();

        // Forty minutes later.
        await ShiftWalkUpAsync(factory, bookingId, startsInMinutes: -40, endsInMinutes: 20);
        var mid = await client.SendAsync(FromBox(box, WalkUpPath, request));
        Assert.Equal(HttpStatusCode.OK, mid.StatusCode);
        var midBody = await mid.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(midBody.GetProperty("replayed").GetBoolean());
        Assert.InRange(midBody.GetProperty("granted_minutes").GetInt32(), 19, 20);

        // After the window.
        await ShiftWalkUpAsync(factory, bookingId, startsInMinutes: -70, endsInMinutes: -10);
        var over = await client.SendAsync(FromBox(box, WalkUpPath, request));
        Assert.Equal(HttpStatusCode.Conflict, over.StatusCode);
        Assert.Equal("purchase_ended", (await over.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());

        // Promoted to Completed with time nominally left: still over as a purchase.
        await ShiftWalkUpAsync(factory, bookingId, startsInMinutes: -40, endsInMinutes: 20, status: BookingStatus.Completed);
        var completed = await client.SendAsync(FromBox(box, WalkUpPath, request));
        Assert.Equal(HttpStatusCode.Conflict, completed.StatusCode);
        Assert.Equal("purchase_ended", (await completed.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());

        // Charged exactly once throughout.
        Assert.Single(await LedgerAsync(factory, bookingId));
        Assert.Equal(200m - 32m, await BalanceAsync(factory, box.MemberId));
    }

    // ---- the per-box button map on the wire (closing re-review #17) -------------------

    /// <summary>The heartbeat carries the map THIS box runs: its own override when it has one, else the club's.</summary>
    [SkippableFact]
    public async Task Heartbeat_carries_the_boxs_own_button_map_when_it_has_one()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);

        var clubMap = (await HeartbeatAsync(factory, box)).GetProperty("config").GetProperty("button_map").EnumerateArray().Select(e => e.GetString()).ToList();
        Assert.Equal(["court:A", "court:B", "court:C", "court:D", "minutes:15", "minutes:30", "minutes:45", "minutes:60"], clubMap);

        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var row = await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.Id == box.DeviceId);
            Assert.True(ButtonMap.TryParse(["court:A", "off", "none", "none", "minutes:15", "minutes:30", "none", "none"], out var own, out _));
            row.ButtonMapJson = own!.ToJson();
            await db.SaveChangesAsync();
        }

        var ownMap = (await HeartbeatAsync(factory, box)).GetProperty("config").GetProperty("button_map").EnumerateArray().Select(e => e.GetString()).ToList();
        Assert.Equal(["court:A", "off", "none", "none", "minutes:15", "minutes:30", "none", "none"], ownMap);
    }

    /// <summary>
    /// The box lost the acknowledgement and sent the same batch again. One stamp, one
    /// <c>court.activated</c> row, and the second answer accepts the same sequence number
    /// having recorded nothing new.
    /// </summary>
    [SkippableFact]
    public async Task Replayed_activation_batch_is_idempotent()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        var booked = await BookAsync(factory, box, courtNumber: 1, startsInMinutes: -2);
        var client = factory.CreateClient();

        var first = await client.SendAsync(FromBox(box, EventsPath, Batch(Activation(7, subject: booked.Code, court: 0))));
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        var stampedAt = (await BookingAsync(factory, booked.BookingId)).CheckedInAt;
        Assert.NotNull(stampedAt);

        var again = await client.SendAsync(FromBox(box, EventsPath, Batch(Activation(7, subject: booked.Code, court: 0))));
        Assert.Equal(HttpStatusCode.OK, again.StatusCode);
        var body = await again.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(7, body.GetProperty("accepted_through").GetInt64());
        Assert.Equal(0, body.GetProperty("recorded").GetInt32());

        Assert.Equal(stampedAt, (await BookingAsync(factory, booked.BookingId)).CheckedInAt);
        Assert.Single(await AuditAsync(factory, box.TenantId, "court.activated"));
        Assert.Single(await AuditAsync(factory, box.TenantId, "device.activation"));

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        Assert.Equal(1, await db.DeviceEventReceipts.IgnoreQueryFilters().CountAsync(r => r.DeviceId == box.DeviceId));
    }

    /// <summary>
    /// A token the server does not know — expired, never minted, or another club's — is
    /// still acknowledged, so the box can release its queue, and the refusal is preserved
    /// as an audit row: the evidence the box is about to discard.
    /// </summary>
    [SkippableFact]
    public async Task Activation_event_with_unknown_token_is_acked_and_audited()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        var booked = await BookAsync(factory, box, courtNumber: 1, startsInMinutes: -2);

        var response = await factory.CreateClient().SendAsync(
            FromBox(box, EventsPath, Batch(Activation(1, subject: "ZZZZZZZZZZZZ", court: 0))));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(1, body.GetProperty("accepted_through").GetInt64());
        Assert.Equal(1, body.GetProperty("recorded").GetInt32());

        Assert.Null((await BookingAsync(factory, booked.BookingId)).CheckedInAt);
        var audit = Assert.Single(await AuditAsync(factory, box.TenantId, "device.activation_unresolved"));
        Assert.Contains("ZZZZZZZZZZZZ", audit.DetailsJson);
        Assert.Empty(await AuditAsync(factory, box.TenantId, "court.activated"));
    }

    /// <summary>
    /// The box let somebody in ahead of the cue window — its clock or its cached window
    /// drifted. The cue rule is the rule: receipted and acknowledged, audited as too early,
    /// nothing stamped.
    /// </summary>
    [SkippableFact]
    public async Task Activation_event_ahead_of_cue_window_is_not_stamped()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        // Inside the forward window (120) but well ahead of the cue (10).
        var booked = await BookAsync(factory, box, courtNumber: 1, startsInMinutes: 60);

        var response = await factory.CreateClient().SendAsync(
            FromBox(box, EventsPath, Batch(Activation(1, subject: booked.Code, court: 0))));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(1, (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accepted_through").GetInt64());

        var booking = await BookingAsync(factory, booked.BookingId);
        Assert.Null(booking.CheckedInAt);
        Assert.Null(booking.LightsOnCuedAt);
        Assert.Single(await AuditAsync(factory, box.TenantId, "device.activation_too_early"));
        Assert.Empty(await AuditAsync(factory, box.TenantId, "court.activated"));
    }

    /// <summary>
    /// The relay the box lit is not wired to the booking's court: a stale or wrong court list
    /// on the box. Acknowledged, audited, not stamped — the member is standing on a court
    /// they did not book.
    /// </summary>
    [SkippableFact]
    public async Task Activation_event_on_a_relay_not_wired_to_the_bookings_court_is_not_stamped()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory, courtNumbers: [1, 2]);
        var booked = await BookAsync(factory, box, courtNumber: 2, startsInMinutes: -2);

        var response = await factory.CreateClient().SendAsync(
            FromBox(box, EventsPath, Batch(Activation(1, subject: booked.Code, court: 0))));   // relay A is court 1
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        Assert.Null((await BookingAsync(factory, booked.BookingId)).CheckedInAt);
        Assert.Single(await AuditAsync(factory, box.TenantId, "device.activation_wrong_court"));
    }

    /// <summary>
    /// Eight uploads of one batch in flight together — the retry storm a flapping link
    /// produces. Postgres refuses seven receipts on the unique index and seven stamps on the
    /// concurrency token; every request is answered 200 with the sequence accepted, and
    /// there is one receipt, one stamp and one <c>court.activated</c> row at the end.
    /// </summary>
    [SkippableFact]
    public async Task Concurrent_duplicate_activation_uploads()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        var booked = await BookAsync(factory, box, courtNumber: 1, startsInMinutes: -2);
        var client = factory.CreateClient();

        var responses = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ =>
            client.SendAsync(FromBox(box, EventsPath, Batch(Activation(3, subject: booked.Code, court: 0))))));

        Assert.All(responses, r => Assert.Equal(HttpStatusCode.OK, r.StatusCode));
        foreach (var r in responses)
        {
            Assert.Equal(3, (await r.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accepted_through").GetInt64());
        }

        Assert.NotNull((await BookingAsync(factory, booked.BookingId)).CheckedInAt);
        Assert.Single(await AuditAsync(factory, box.TenantId, "court.activated"));
        Assert.Single(await AuditAsync(factory, box.TenantId, "device.activation"));

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        Assert.Equal(1, await db.DeviceEventReceipts.IgnoreQueryFilters().CountAsync(r => r.DeviceId == box.DeviceId));
        Assert.Single(await LedgerAsync(factory, booked.BookingId));   // the seed charge, and nothing else
    }

    /// <summary>
    /// Club B's roster token, reported by club A's box. The code resolver is filtered by
    /// tenant, so at club A it is simply unknown: acknowledged, audited as unresolved, and
    /// club B's booking is untouched.
    /// </summary>
    [SkippableFact]
    public async Task Activation_event_citing_another_clubs_code_stamps_nothing()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var boxA = await SeedAsync(factory);
        var boxB = await SeedAsync(factory);
        var bookedB = await BookAsync(factory, boxB, courtNumber: 1, startsInMinutes: -2);

        var response = await factory.CreateClient().SendAsync(
            FromBox(boxA, EventsPath, Batch(Activation(1, subject: bookedB.Code, court: 0))));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(1, (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accepted_through").GetInt64());

        Assert.Null((await BookingAsync(factory, bookedB.BookingId)).CheckedInAt);
        Assert.Single(await AuditAsync(factory, boxA.TenantId, "device.activation_unresolved"));
        Assert.Empty(await AuditAsync(factory, boxB.TenantId, "court.activated"));
        Assert.Empty(await AuditAsync(factory, boxA.TenantId, "court.activated"));
    }

    // ---- the settlement model (docs/specs/settlement-model.md) ----------------------

    /// <summary>
    /// Settlement model I1 and I7. A booking cancelled inside the penalty window has already
    /// cost its member the penalty; the club keeps it. When the box then lights the court
    /// from a stale roster, the lit time is charged <b>on top of</b> that — so it has to be
    /// netted, or the booking costs more than it ever could have.
    ///
    /// <para>
    /// Round-3 finding 3: 45 sold minutes at 24 credits, a 30% penalty of 7.20 retained, and
    /// the full 24 charged again for the lights = 31.20 for a 24-credit court, with an email
    /// telling the member so. The ceiling is the price: 7.20 + 16.80.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_retained_late_cancellation_penalty_is_netted_against_the_lit_charge()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        // Starts in two minutes — inside the default fifteen-minute penalty window, and late
        // enough that a scan five minutes ago is still inside the cue window.
        var booked = await BookAsync(factory, box, courtNumber: 1, startsInMinutes: 2);
        var cancellation = await CancelAsync(factory, box, booked.BookingId, waivePenalty: false);
        Assert.Equal(24m, cancellation.RefundedCredits);
        Assert.Equal(7.20m, cancellation.PenaltyCredits);
        Assert.Equal(200m - 7.20m, await BalanceAsync(factory, box.MemberId));

        await using var quiet = Quiet(factory, new StubEmailService());
        Assert.Equal(HttpStatusCode.OK, (await quiet.CreateClient().SendAsync(FromBox(box, EventsPath,
            Batch(Activation(1, subject: booked.Code, court: 0, durationMs: 3_600_000))))).StatusCode);

        var lit = Assert.Single(await LedgerAsync(factory, booked.BookingId), l => l.Type == LedgerEntryType.LightsPurchase);
        Assert.Equal(-16.80m, lit.AmountCredits);                       // 24 gross, capped at 24 − 7.20
        Assert.Equal(200m - 24m, await BalanceAsync(factory, box.MemberId));   // the booking cost exactly its price
    }

    /// <summary>
    /// Settlement model I7. The cue gate was applied on the no-show branch and not on the
    /// cancelled one directly below it, which made the cancelled-then-lit charge the one
    /// path a box with a drifted clock could still spend a member's credits down.
    /// </summary>
    [SkippableFact]
    public async Task A_cancelled_booking_scanned_before_the_cue_window_is_not_charged()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        var booked = await BookAsync(factory, box, courtNumber: 1, startsInMinutes: 60);
        await CancelAsync(factory, box, booked.BookingId);
        Assert.Equal(200m, await BalanceAsync(factory, box.MemberId));

        // Scanned five minutes ago — sixty-five minutes before a cue window that opens ten
        // minutes before the slot.
        await using var quiet = Quiet(factory, new StubEmailService());
        Assert.Equal(HttpStatusCode.OK, (await quiet.CreateClient().SendAsync(FromBox(box, EventsPath,
            Batch(Activation(1, subject: booked.Code, court: 0))))).StatusCode);

        Assert.DoesNotContain(await LedgerAsync(factory, booked.BookingId), l => l.Type == LedgerEntryType.LightsPurchase);
        Assert.Equal(200m, await BalanceAsync(factory, box.MemberId));
        Assert.Single(await AuditAsync(factory, box.TenantId, "device.activation_too_early"));
        Assert.Empty(await AuditAsync(factory, box.TenantId, "booking.cancelled_lights_charged"));
    }

    /// <summary>
    /// Settlement model I5 — round-3 finding 16. B's booking was cancelled by the system so
    /// that A's late attendance evidence could have the court, and B was refunded and emailed
    /// to say so. B walks in anyway, the box's cached roster still carries B's code, the
    /// court lights. B must not be billed pro rata for it: that is two members charged for
    /// one court, and the second of them for a booking they never cancelled.
    /// </summary>
    [SkippableFact]
    public async Task A_displaced_bookings_own_late_scan_is_not_charged()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        var (booked, _) = await SweptNoShowAsync(factory, box);
        var buyer = await AnotherMemberAsync(factory, box);
        var b = await BookOnTailAsync(factory, box, buyer, startsInMinutes: 1, minutes: 15, mintCode: true);

        await using var quiet = Quiet(factory, new StubEmailService());
        var client = quiet.CreateClient();
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(
            FromBox(box, EventsPath, Batch(Activation(1, subject: booked.Code, court: 0))))).StatusCode);

        var displaced = await BookingAsync(factory, b.BookingId);
        Assert.Equal(BookingStatus.Cancelled, displaced.Status);
        Assert.Equal(BookingService.ResoldTailRefunded, displaced.CancellationReason);
        Assert.Equal(booked.BookingId, displaced.DisplacedByBookingId);
        var buyerAfterDisplacement = await BalanceAsync(factory, buyer);

        // The code died with the displacement, so no box gets it on its next roster either.
        Assert.False(await CodeIsLiveAsync(factory, b.Code));

        // B's own queued scan arrives.
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(
            FromBox(box, EventsPath, Batch(Activation(2, subject: b.Code, court: 0))))).StatusCode);

        Assert.DoesNotContain(await LedgerAsync(factory, b.BookingId), l => l.Type == LedgerEntryType.LightsPurchase);
        Assert.Equal(buyerAfterDisplacement, await BalanceAsync(factory, buyer));
        var collision = Assert.Single(await AuditAsync(factory, box.TenantId, "device.activation_displaced_collision"));
        Assert.Contains(booked.BookingId.ToString(), collision.DetailsJson);   // names what displaced it
        Assert.Empty(await AuditAsync(factory, box.TenantId, "booking.cancelled_lights_charged"));
    }

    /// <summary>
    /// Settlement model I10. A booking nobody was ever charged for is displaced like any
    /// other, but there is nothing to give back — and a zero-credit row is not a refund. It
    /// moves no money, burns the idempotency reference the real posting would have needed,
    /// and reads on a statement as a movement that did not happen.
    /// </summary>
    [SkippableFact]
    public async Task A_never_charged_displaced_booking_posts_no_zero_credit_row()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        var (booked, _) = await SweptNoShowAsync(factory, box);
        var buyer = await AnotherMemberAsync(factory, box);
        var b = await BookOnTailAsync(factory, box, buyer, startsInMinutes: 20, minutes: 15, charged: false);

        await using var quiet = Quiet(factory, new StubEmailService());
        Assert.Equal(HttpStatusCode.OK, (await quiet.CreateClient().SendAsync(
            FromBox(box, EventsPath, Batch(Activation(1, subject: booked.Code, court: 0))))).StatusCode);

        Assert.Equal(BookingStatus.Cancelled, (await BookingAsync(factory, b.BookingId)).Status);
        Assert.Empty(await LedgerAsync(factory, b.BookingId));
        Assert.Single(await AuditAsync(factory, box.TenantId, "booking.displaced"));
    }

    /// <summary>
    /// Settlement model I6 — the early OFF. The activation carries the <i>grant</i>; only the
    /// release carries the measurement. A member who plays five minutes of a twenty-minute
    /// grant and presses OFF is charged five, and the difference comes back.
    ///
    /// <para>
    /// The two events go up in <b>separate requests</b>, because that is how the box works:
    /// <c>drainEvents</c> uploads one event per pass, so a release is always at least one
    /// request behind the activation it belongs to and can never be settled with it.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task The_release_reduces_a_cancelled_lit_charge_to_what_the_relay_measured()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        var booked = await BookAsync(factory, box, courtNumber: 1, startsInMinutes: -10);
        await CancelAsync(factory, box, booked.BookingId);

        await using var quiet = Quiet(factory, new StubEmailService());
        var client = quiet.CreateClient();

        // Scan five minutes ago, granted twenty minutes.
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(FromBox(box, EventsPath,
            Batch(Activation(1, subject: booked.Code, court: 0, durationMs: 1_200_000))))).StatusCode);
        Assert.Equal(-10.67m, Assert.Single(await LedgerAsync(factory, booked.BookingId),
            l => l.Type == LedgerEntryType.LightsPurchase).AmountCredits);

        // The next request carries the release: the relay was closed for five minutes.
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(FromBox(box, EventsPath,
            Batch(Release(2, court: 0, heldMs: 300_000))))).StatusCode);

        var lights = (await LedgerAsync(factory, booked.BookingId)).Where(l => l.Type == LedgerEntryType.LightsPurchase).ToList();
        Assert.Equal(2, lights.Count);
        Assert.Equal(8.00m, Assert.Single(lights, l => l.AmountCredits > 0).AmountCredits);
        Assert.Equal(-2.67m, lights.Sum(l => l.AmountCredits));          // 5 min at 8 credits / 15 min
        Assert.Single(await AuditAsync(factory, box.TenantId, "booking.cancelled_lights_adjusted"));

        // A second release does not pay it back twice.
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(FromBox(box, EventsPath,
            Batch(Release(3, court: 0, heldMs: 300_000))))).StatusCode);
        Assert.Equal(-2.67m, (await LedgerAsync(factory, booked.BookingId))
            .Where(l => l.Type == LedgerEntryType.LightsPurchase).Sum(l => l.AmountCredits));
    }

    /// <summary>
    /// Settlement model I8/I9 — round-3 finding 14. A played twenty minutes offline and
    /// pressed OFF; the sweep had already released the tail and B bought part of it. The
    /// reversal displaces B on the grant, because at that instant the court is believed lit
    /// to the end of the slot and two members on one court is the worse error. The release
    /// arrives one request later and proves otherwise: A's end is narrowed to what the relay
    /// measured, and B — whose slot has not started — gets their booking back.
    /// </summary>
    [SkippableFact]
    public async Task The_release_narrows_the_reversed_window_and_reinstates_the_displaced_booking()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        var (booked, _) = await SweptNoShowAsync(factory, box);
        var buyer = await AnotherMemberAsync(factory, box);
        var buyerBefore = await BalanceAsync(factory, buyer);
        var b = await BookOnTailAsync(factory, box, buyer, startsInMinutes: 20, minutes: 15);
        Assert.Equal(buyerBefore - 8m, await BalanceAsync(factory, buyer));

        var mail = new StubEmailService();
        await using var quiet = Quiet(factory, mail);
        var client = quiet.CreateClient();

        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(
            FromBox(box, EventsPath, Batch(Activation(1, subject: booked.Code, court: 0))))).StatusCode);
        Assert.Equal(BookingStatus.Cancelled, (await BookingAsync(factory, b.BookingId)).Status);
        Assert.Equal(buyerBefore, await BalanceAsync(factory, buyer));      // refunded on the grant

        // The relay was closed for five minutes, ending at the upload instant — well before
        // B's slot. One request later, as the box sends it.
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(
            FromBox(box, EventsPath, Batch(Release(2, court: 0, heldMs: 300_000))))).StatusCode);

        var a = await BookingAsync(factory, booked.BookingId);
        var reinstated = await BookingAsync(factory, b.BookingId);
        Assert.Equal(BookingStatus.Booked, reinstated.Status);
        Assert.Null(reinstated.CancellationReason);
        Assert.Null(reinstated.DisplacedByBookingId);
        Assert.True(a.EndsAt <= reinstated.StartsAt, $"A's end {a.EndsAt} must clear B's start {reinstated.StartsAt}");

        // Charged once for a booking they get to keep.
        Assert.Equal(buyerBefore - 8m, await BalanceAsync(factory, buyer));
        var refunds = (await LedgerAsync(factory, b.BookingId)).Where(l => l.Type == LedgerEntryType.CancellationRefund).ToList();
        Assert.Equal(2, refunds.Count);
        Assert.Equal(0m, refunds.Sum(l => l.AmountCredits));

        Assert.Single(await AuditAsync(factory, box.TenantId, "booking.lit_window_narrowed"));
        Assert.Single(await AuditAsync(factory, box.TenantId, "booking.displacement_reversed"));
        Assert.Contains(mail.Sent, m => m.Subject.StartsWith("Booking reinstated", StringComparison.Ordinal));
        Assert.True(await BookingHasLiveCodeAsync(factory, b.BookingId), "a reinstated booking gets a fresh access code");
    }

    /// <summary>
    /// A release that names no session it can reconcile with corrects nothing. The pairing is
    /// by device, relay and time, and a release arriving with no activation behind it — the
    /// first event after a reboot, or one whose activation was dropped — must not be allowed
    /// to re-price whatever happened to be lit on that relay last.
    /// </summary>
    [SkippableFact]
    public async Task A_release_with_no_activation_behind_it_settles_nothing()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        var booked = await BookAsync(factory, box, courtNumber: 1, startsInMinutes: -10);
        await CancelAsync(factory, box, booked.BookingId);

        await using var quiet = Quiet(factory, new StubEmailService());
        var client = quiet.CreateClient();

        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(FromBox(box, EventsPath,
            Batch(Release(1, court: 0, heldMs: 300_000))))).StatusCode);
        Assert.Single(await AuditAsync(factory, box.TenantId, "device.release_unpaired"));
        Assert.DoesNotContain(await LedgerAsync(factory, booked.BookingId), l => l.Type == LedgerEntryType.LightsPurchase);

        // And the ordinary order still works: the activation first, the release behind it.
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(FromBox(box, EventsPath,
            Batch(Activation(2, subject: booked.Code, court: 0, durationMs: 1_200_000))))).StatusCode);
        Assert.Equal(-10.67m, Assert.Single(await LedgerAsync(factory, booked.BookingId),
            l => l.Type == LedgerEntryType.LightsPurchase).AmountCredits);

        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(FromBox(box, EventsPath,
            Batch(Release(3, court: 0, heldMs: 300_000))))).StatusCode);
        Assert.Equal(-2.67m, (await LedgerAsync(factory, booked.BookingId))
            .Where(l => l.Type == LedgerEntryType.LightsPurchase).Sum(l => l.AmountCredits));
    }

    /// <summary>
    /// Settlement model I8. The reversal displaces what the court could have reached, not the
    /// whole slot. A box that granted fifteen minutes cannot have been lighting the court an
    /// hour later, so a booking beyond the grant is nobody's collision — it used to be
    /// cancelled, refunded and emailed anyway, and the slot then sat dark and unsellable
    /// (round-3 finding 14).
    /// </summary>
    [SkippableFact]
    public async Task A_reversal_displaces_only_what_the_grant_could_have_reached()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        var (booked, _) = await SweptNoShowAsync(factory, box);        // A: −10, 45 min, tail [now, +35)
        var buyer = await AnotherMemberAsync(factory, box);
        var buyerBefore = await BalanceAsync(factory, buyer);
        var b = await BookOnTailAsync(factory, box, buyer, startsInMinutes: 20, minutes: 15);

        // The box lit the court for fifteen minutes from a scan five minutes ago: it went
        // dark around ten minutes from now, long before B's slot.
        var mail = new StubEmailService();
        await using var quiet = Quiet(factory, mail);
        Assert.Equal(HttpStatusCode.OK, (await quiet.CreateClient().SendAsync(FromBox(box, EventsPath,
            Batch(Activation(1, subject: booked.Code, court: 0, durationMs: 900_000))))).StatusCode);

        var survivor = await BookingAsync(factory, b.BookingId);
        Assert.Equal(BookingStatus.Booked, survivor.Status);
        Assert.Null(survivor.CancellationReason);
        Assert.Equal(buyerBefore - 8m, await BalanceAsync(factory, buyer));   // charged once, untouched
        Assert.Empty(await AuditAsync(factory, box.TenantId, "booking.displaced"));
        Assert.DoesNotContain(mail.Sent, m => m.Subject.StartsWith("Booking refunded", StringComparison.Ordinal));

        // A's end is the window the grant reached, not the end of the slot it was sold.
        var a = await BookingAsync(factory, booked.BookingId);
        Assert.Equal(BookingStatus.Booked, a.Status);
        Assert.True(a.EndsAt < BookingService.OriginalEndsAt(a),
            $"the restored end {a.EndsAt} must stop short of the sold end {BookingService.OriginalEndsAt(a)}");
        Assert.True(a.EndsAt <= survivor.StartsAt);
    }

    /// <summary>
    /// A release names no session, so it is paired by device, relay and time — and a pairing
    /// that does not reconcile corrects <b>nothing</b>. Without the check, a release whose
    /// activation was dropped re-prices whatever was lit on that relay last, in the member's
    /// favour or against them depending on an accident.
    /// </summary>
    [SkippableFact]
    public async Task A_release_that_does_not_reconcile_with_its_session_corrects_nothing()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        var booked = await BookAsync(factory, box, courtNumber: 1, startsInMinutes: -10);
        await CancelAsync(factory, box, booked.BookingId);

        await using var quiet = Quiet(factory, new StubEmailService());
        var client = quiet.CreateClient();

        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(FromBox(box, EventsPath,
            Batch(Activation(1, subject: booked.Code, court: 0, durationMs: 1_200_000))))).StatusCode);
        Assert.Equal(-10.67m, Assert.Single(await LedgerAsync(factory, booked.BookingId),
            l => l.Type == LedgerEntryType.LightsPurchase).AmountCredits);

        // One held minute, uploaded five minutes after the scan: the implied end is four
        // minutes adrift of the release's own time, so these two are not a pair.
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(FromBox(box, EventsPath,
            Batch(Release(2, court: 0, heldMs: 60_000))))).StatusCode);

        Assert.Single(await AuditAsync(factory, box.TenantId, "device.release_unpaired"));
        Assert.Equal(-10.67m, Assert.Single(await LedgerAsync(factory, booked.BookingId),
            l => l.Type == LedgerEntryType.LightsPurchase).AmountCredits);
        Assert.Empty(await AuditAsync(factory, box.TenantId, "booking.cancelled_lights_adjusted"));
    }

    // ---- a working box is a reporting box (finding L-F5) -----------------------------

    /// <summary>Backdates the box's last-seen, as a silence of <paramref name="minutes"/> would.</summary>
    private static async Task<DateTimeOffset> WentQuietAsync(TestWebAppFactory factory, Box box, int minutes)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var device = await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.Id == box.DeviceId);
        var quietAt = DateTimeOffset.UtcNow.AddMinutes(-minutes);
        device.LastSeenAt = quietAt;
        await db.SaveChangesAsync();
        return quietAt;
    }

    private static async Task<Device> DeviceAsync(TestWebAppFactory factory, Box box)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.Devices.IgnoreQueryFilters().AsNoTracking().SingleAsync(d => d.Id == box.DeviceId);
    }

    /// <summary>
    /// A box that is switching courts on is not silent. <c>LastSeenAt</c> moved on
    /// <c>/heartbeat</c> and <c>/events</c> only, so a box whose periodic POST had stalled
    /// while request/response still worked was alerted on as "not reporting" mid-scan, shown
    /// as "last seen 11m ago" beside a court it had just lit, and — through §6a — had that
    /// court's no-show penalties waived. Every device call is liveness now, and the silence
    /// it ended is recorded on the way past, exactly as the heartbeat records it.
    /// </summary>
    [SkippableFact]
    public async Task Lighting_a_booked_court_counts_as_the_box_reporting()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory, courtNumbers: [1, 2]);
        var booked = await BookAsync(factory, box, courtNumber: 2, startsInMinutes: 1);
        var quietAt = await WentQuietAsync(factory, box, minutes: 20);

        var response = await factory.CreateClient().SendAsync(
            FromBox(box, ActivatePath, new { method = "qr", token = booked.Code }));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        Assert.Equal(DateTimeOffset.UtcNow, (await DeviceAsync(factory, box)).LastSeenAt!.Value, TimeSpan.FromMinutes(1));

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var outage = Assert.Single(await db.DeviceOutages.IgnoreQueryFilters().Where(o => o.DeviceId == box.DeviceId).ToListAsync());
        Assert.Equal(quietAt, outage.StartedAt, TimeSpan.FromSeconds(1));
        Assert.NotNull(outage.EndedAt);
    }

    /// <summary>
    /// The same for a refusal: the box called, whatever the answer was. Driven with a token
    /// this club has never minted, so nothing else about the request could have moved the row.
    /// </summary>
    [SkippableFact]
    public async Task Even_a_refused_scan_counts_as_the_box_reporting()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        await WentQuietAsync(factory, box, minutes: 20);

        var response = await factory.CreateClient().SendAsync(
            FromBox(box, ActivatePath, new { method = "qr", token = "7Q3F9KM2XZ8B" }));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("not_recognised", (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("reason").GetString());

        Assert.Equal(DateTimeOffset.UtcNow, (await DeviceAsync(factory, box)).LastSeenAt!.Value, TimeSpan.FromMinutes(1));
    }

    /// <summary>Selling court time is the same evidence, and the same rule.</summary>
    [SkippableFact]
    public async Task Selling_a_walk_up_counts_as_the_box_reporting()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        await WentQuietAsync(factory, box, minutes: 20);

        var response = await factory.CreateClient().SendAsync(
            FromBox(box, WalkUpPath, WalkUp(await QrCodeAsync(factory, box), minutes: 30)));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        Assert.Equal(DateTimeOffset.UtcNow, (await DeviceAsync(factory, box)).LastSeenAt!.Value, TimeSpan.FromMinutes(1));
    }

    // ---- a membership the club has barred, at the box (finding K-F1) -----------------
    //
    // The critical of round 3: a suspended member walked up to the touchpad, was sold fifty
    // credits of court time and had the lights switched on, twice, while the console's own
    // suspend modal promised in those words that they could not "open a court at the box".
    // The guards existed on the pre-booked path and the roster and nowhere else, because a
    // walk-up CREATES its booking and so never met a candidate set.
    //
    // These drive every door a box can reach, over the real wire, and the theory varies the
    // MEMBERSHIP ROW alone — an Active row on the same fixture must still sell, or the tests
    // would pass just as well against a build that refused everybody.

    /// <summary>Moves the box's member into <paramref name="status"/>, changing nothing else.</summary>
    private static async Task SetMembershipAsync(TestWebAppFactory factory, Box box, MembershipStatus status)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var membership = await db.Memberships.IgnoreQueryFilters().SingleAsync(m => m.UserId == box.MemberId);
        membership.Status = status;
        await db.SaveChangesAsync();
    }

    /// <summary>
    /// Buying court time at the box, by membership state. Only an Active member may;
    /// suspended, rejected and still-awaiting-approval are all refused, and refused
    /// <b>before</b> anything is charged — the whole point is that no money moves.
    ///
    /// <para>
    /// <c>not_recognised</c> is the answer on purpose: it is the one walk-up refusal whose
    /// firmware row carries <c>recognised:false</c>, so no button window is armed for a
    /// barred member, and its screen is SEE THE DESK, which is exactly what they must do.
    /// </para>
    /// </summary>
    [SkippableTheory]
    [InlineData(MembershipStatus.Active, true)]
    [InlineData(MembershipStatus.Suspended, false)]
    [InlineData(MembershipStatus.Rejected, false)]
    [InlineData(MembershipStatus.PendingApproval, false)]
    public async Task Only_an_active_member_can_buy_court_time_at_the_box(MembershipStatus status, bool sold)
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        await SetMembershipAsync(factory, box, status);

        var response = await factory.CreateClient().SendAsync(
            FromBox(box, WalkUpPath, WalkUp(await QrCodeAsync(factory, box), minutes: 30)));

        if (sold)
        {
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Equal(184m, await BalanceAsync(factory, box.MemberId));
            return;
        }

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("not_recognised", body.GetProperty("error").GetString());

        // No booking, no debit, no lit court. A refusal that arrives after the charge is a
        // refund to write rather than a sale not made.
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        Assert.Empty(await db.Bookings.IgnoreQueryFilters().Where(b => b.UserId == box.MemberId).ToListAsync());
        Assert.Equal(200m, await BalanceAsync(factory, box.MemberId));
    }

    /// <summary>
    /// The second door. A booking-activation code names its booking outright, so
    /// <c>ForBookingCodeAsync</c> looked the row up by id and never met the candidate-set
    /// filter that drops a barred member — a suspended member's own code lit their court and
    /// charged them for it. Answered <c>no_booking</c>, the same sentence the ident-code
    /// branch has always given, because a box that named the suspension would be announcing
    /// it to whoever is standing at the court.
    /// </summary>
    [SkippableTheory]
    [InlineData(MembershipStatus.Active, true)]
    [InlineData(MembershipStatus.Suspended, false)]
    [InlineData(MembershipStatus.Rejected, false)]
    [InlineData(MembershipStatus.PendingApproval, false)]
    public async Task Only_an_active_member_can_light_a_booked_court_from_the_box(MembershipStatus status, bool lit)
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory, courtNumbers: [1, 2]);
        var booked = await BookAsync(factory, box, courtNumber: 2, startsInMinutes: 1);
        await SetMembershipAsync(factory, box, status);

        var response = await factory.CreateClient().SendAsync(
            FromBox(box, ActivatePath, new { method = "qr", token = booked.Code }));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(lit, body.GetProperty("activated").GetBoolean());
        Assert.Equal(lit ? "ok" : "no_booking", body.GetProperty("reason").GetString());

        var after = await BookingAsync(factory, booked.BookingId);
        Assert.Equal(lit, after.CheckedInAt is not null);
    }

    /// <summary>
    /// The same door with the other kind of code. A member-ident code searches the box's
    /// courts through <c>FindForUserAsync</c>, which has carried the filter all along — this
    /// pins that it still does, so a later tidy-up of the two branches cannot quietly drop
    /// one of them.
    /// </summary>
    [SkippableTheory]
    [InlineData(MembershipStatus.Active, true)]
    [InlineData(MembershipStatus.Suspended, false)]
    public async Task Only_an_active_member_can_light_a_booked_court_with_an_ident_code(MembershipStatus status, bool lit)
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory, courtNumbers: [1, 2]);
        var booked = await BookAsync(factory, box, courtNumber: 2, startsInMinutes: 1);
        await SetMembershipAsync(factory, box, status);

        var response = await factory.CreateClient().SendAsync(
            FromBox(box, ActivatePath, new { method = "qr", token = await QrCodeAsync(factory, box) }));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(lit, body.GetProperty("activated").GetBoolean());
        Assert.Equal(lit, (await BookingAsync(factory, booked.BookingId)).CheckedInAt is not null);
    }

    /// <summary>
    /// And the cached door: a barred member is off the roster the box decides against while
    /// the link is down. Suspension that held only while the API was reachable would fail in
    /// exactly the window a club most wants it to hold.
    /// </summary>
    [SkippableTheory]
    [InlineData(MembershipStatus.Active, 1)]
    [InlineData(MembershipStatus.Suspended, 0)]
    [InlineData(MembershipStatus.Rejected, 0)]
    [InlineData(MembershipStatus.PendingApproval, 0)]
    public async Task The_roster_carries_only_active_members(MembershipStatus status, int entries)
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory, courtNumbers: [1, 2]);
        await BookAsync(factory, box, courtNumber: 2, startsInMinutes: 5);
        await SetMembershipAsync(factory, box, status);

        var body = await HeartbeatAsync(factory, box);

        Assert.Equal(entries, body.GetProperty("roster").GetArrayLength());
    }

    /// <summary>
    /// The deliberate carve-out, pinned so nobody "completes" the fix by closing it.
    ///
    /// <para>
    /// <c>/events</c> is not the API deciding whether lights come on; it is a report that
    /// they already did. The roster drops a barred member from every push, so the only way
    /// one reaches this handler is a box that admitted them from a cache fetched before the
    /// club's decision — the relay has run and the member has played. Refusing the
    /// attendance would unlight nothing: it would make them a no-show, refund the court they
    /// used and waive the penalty. The money follows the lights, here as everywhere else.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_scan_the_box_had_already_admitted_offline_is_still_recorded_for_a_suspended_member()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory, courtNumbers: [1, 2]);
        var booked = await BookAsync(factory, box, courtNumber: 2, startsInMinutes: -10);
        await SetMembershipAsync(factory, box, MembershipStatus.Suspended);

        var response = await factory.CreateClient().SendAsync(
            FromBox(box, EventsPath, Batch(Activation(1, subject: booked.Code, court: 1))));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        Assert.NotNull((await BookingAsync(factory, booked.BookingId)).CheckedInAt);

        // And the sweep leaves it alone: no refund of a court that was played on, no waived
        // penalty for the club to absorb.
        await SweepAsync(factory);
        var ledger = await LedgerAsync(factory, booked.BookingId);
        Assert.DoesNotContain(ledger, l => l.Type == LedgerEntryType.CancellationRefund);
        Assert.DoesNotContain(ledger, l => l.Type == LedgerEntryType.NoShowPenalty);
    }

    private static async Task<bool> CodeIsLiveAsync(TestWebAppFactory factory, string code)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var row = await db.AccessCodes.IgnoreQueryFilters().AsNoTracking().FirstOrDefaultAsync(c => c.Code == code);
        return row is not null && row.IsLiveAt(DateTimeOffset.UtcNow);
    }

    private static async Task<bool> BookingHasLiveCodeAsync(TestWebAppFactory factory, Guid bookingId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var now = DateTimeOffset.UtcNow;
        return await db.AccessCodes.IgnoreQueryFilters().AsNoTracking()
            .AnyAsync(c => c.BookingId == bookingId && c.ExpiresAt > now);
    }
}
