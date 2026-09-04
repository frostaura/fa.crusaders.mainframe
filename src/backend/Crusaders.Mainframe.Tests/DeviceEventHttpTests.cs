using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security.DeviceAuth;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.Tokens;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// What a court box reports, and what it buys.
///
/// <para>
/// The box decides scans locally and queues what it decided; these two endpoints are where
/// that queue drains and where the one operation that genuinely needs the network — a
/// walk-up — happens. Over real HTTP with real signing, because a signature the firmware
/// builds one byte differently is a 401 with no diagnostic and a trip to the club.
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

    private sealed record Box(Guid DeviceId, byte[] Key, Guid TenantId, string Slug, Guid CourtId, Guid MemberId, IReadOnlyDictionary<int, Guid> CourtIds);

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    /// <summary>A tenant, a funded member, and a claimed box driving <paramref name="courtNumbers"/> (court 1 alone by default).</summary>
    private static async Task<Box> SeedAsync(TestWebAppFactory factory, decimal topUpCredits = 200m, int[]? courtNumbers = null)
    {
        courtNumbers ??= [1];
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var slug = $"box-{Guid.NewGuid():N}"[..20];
        var tenant = new Tenant { Slug = slug, DisplayName = "Box Club" };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings
        {
            TenantId = tenant.Id,
            SettingsJson = """{"slice_minutes":15,"slice_price_credits":8,"grace_window_minutes":5,"timezone":"UTC","peak_hours":"16:00-19:00"}""",
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

        var device = new Device
        {
            TenantId = tenant.Id,
            DeviceCode = "court-box-1",
            Name = "Court 1 box",
            Kind = DeviceKind.CourtBox,
            Hardware = DeviceHardware.Esp8266,
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

        var keys = scope.ServiceProvider.GetRequiredService<IDeviceKeyDeriver>();
        return new Box(device.Id, keys.Derive(tenant.Id, device.Id, device.KeyVersion), tenant.Id, slug, courts[0].Id, member.Id,
            courts.ToDictionary(c => c.CourtNumber, c => c.Id));
    }

    private static HttpRequestMessage Signed(Box box, string path, object payload)
    {
        var body = JsonSerializer.Serialize(payload);
        var bytes = Encoding.UTF8.GetBytes(body);
        var ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var nonce = Guid.NewGuid().ToString("N");

        var canonical = DeviceRequestSigner.CanonicalString("POST", path, ts, nonce, bytes);
        var req = new HttpRequestMessage(HttpMethod.Post, path) { Content = new ByteArrayContent(bytes) };
        req.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        req.Headers.Add(DeviceRequestSigner.DeviceIdHeader, box.DeviceId.ToString());
        req.Headers.Add(DeviceRequestSigner.TimestampHeader, ts.ToString());
        req.Headers.Add(DeviceRequestSigner.NonceHeader, nonce);
        req.Headers.Add(DeviceRequestSigner.SignatureHeader, DeviceRequestSigner.Sign(box.Key, canonical));
        return req;
    }

    /// <summary>
    /// The QR the member's app renders: a sixty-second member-ident access code, minted the
    /// way the API mints it. Twelve characters, because the box's scanner pipeline carries
    /// twenty-four bytes and a JWT never fitted (review H2).
    /// </summary>
    private static Task<string> QrCodeAsync(TestWebAppFactory factory, Box box)
        => TestAccessCodes.MintIdentAsync(factory.Services, box.TenantId, box.Slug, box.MemberId);

    private static object Batch(params object[] events) => new { uptime_ms = 600_000, events };

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

    private static object Activation(long seq, string subject = "tok-alice") => new
    {
        seq,
        uptime_ms = 300_000,
        kind = "activation",
        court = 0,
        method = "qr",
        subject,
        duration_ms = 2_700_000,
    };

    // ---- uploading what happened ------------------------------------------

    [SkippableFact]
    public async Task A_batch_is_recorded_and_acknowledged_by_sequence_number()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        var client = factory.CreateClient();

        var response = await client.SendAsync(Signed(box, EventsPath, Batch(Activation(1), Activation(2), Activation(3))));
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

    [SkippableFact]
    public async Task A_replayed_batch_is_acknowledged_without_being_recorded_twice()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        var client = factory.CreateClient();

        await client.SendAsync(Signed(box, EventsPath, Batch(Activation(1), Activation(2))));

        // The box uploaded, lost the link before reading the response, and tried again.
        // That is normal traffic on an unreliable network, not an error — so it must be
        // acknowledged, and it must not double-record.
        var again = await client.SendAsync(Signed(box, EventsPath, Batch(Activation(1), Activation(2))));
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

        await client.SendAsync(Signed(box, EventsPath, Batch(Activation(1), Activation(2))));

        // The realistic retry: the box never saw the acknowledgement, so it re-offers what it
        // still holds — which by then includes newer events too.
        var overlapping = await client.SendAsync(
            Signed(box, EventsPath, Batch(Activation(2), Activation(3), Activation(4))));

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
        var response = await client.SendAsync(Signed(box, EventsPath, Batch(many)));
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

        var response = await client.SendAsync(Signed(box, WalkUpPath, WalkUp(await QrCodeAsync(factory, box), minutes: 30)));

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
        var response = await client.SendAsync(Signed(box, WalkUpPath, WalkUp(await QrCodeAsync(factory, box), minutes: 60)));

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
        var response = await client.SendAsync(Signed(box, WalkUpPath, WalkUp("1234", method: method)));

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

        var response = await client.SendAsync(Signed(box, WalkUpPath, WalkUp(token)));
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

        var response = await client.SendAsync(Signed(box, WalkUpPath, WalkUp(await QrCodeAsync(factory, box))));

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
        var response = await client.SendAsync(Signed(box, WalkUpPath, WalkUp(await QrCodeAsync(factory, box))));

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
        var response = await client.SendAsync(Signed(box, WalkUpPath, WalkUp(await QrCodeAsync(factory, box), court: 2)));

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

        var response = await client.SendAsync(Signed(box, WalkUpPath, WalkUp(await QrCodeAsync(factory, box), court: 2)));
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

        var first = await client.SendAsync(Signed(box, WalkUpPath, WalkUp(code, nonce: nonce)));
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        var firstBody = await first.Content.ReadFromJsonAsync<JsonElement>();

        var again = await client.SendAsync(Signed(box, WalkUpPath, WalkUp(code, nonce: nonce)));
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
        var response = await client.SendAsync(Signed(box, WalkUpPath, new { minutes = 30, method = "qr", token = await QrCodeAsync(factory, box) }));

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
    public async Task Activate_over_signed_http()
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
        var response = await client.SendAsync(Signed(box, ActivatePath, new { method = "qr", token = code }));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(body.GetProperty("activated").GetBoolean());
        Assert.Equal("ok", body.GetProperty("reason").GetString());
        Assert.Equal(2, body.GetProperty("court_number").GetInt32());
        Assert.Equal(bookingId, body.GetProperty("booking_id").GetGuid());
        Assert.InRange(body.GetProperty("granted_seconds").GetInt32(), 45 * 60, 46 * 60 + 1);
        Assert.False(body.TryGetProperty("starts_in_seconds", out _));
        Assert.True(body.GetProperty("server_unix").GetInt64() > 0);

        using var check = factory.Services.CreateScope();
        var db2 = check.ServiceProvider.GetRequiredService<MainframeDbContext>();
        Assert.NotNull((await db2.Bookings.IgnoreQueryFilters().FirstAsync(b => b.Id == bookingId)).CheckedInAt);
    }

    [SkippableFact]
    public async Task An_unsigned_activation_is_refused()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        await SeedAsync(factory);
        var client = factory.CreateClient();

        var response = await client.PostAsJsonAsync(ActivatePath, new { method = "qr", token = "7Q3F9KM2XZ8B" });
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }
}
