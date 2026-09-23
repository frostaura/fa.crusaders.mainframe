using System.Data.Common;
using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security.DeviceAuth;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.Tokens;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// A club with courts, boxes, bookings and a light-state row — the fixture the control board
/// suites start from.
///
/// <para>
/// Its own rather than <see cref="DoorClub"/>'s because the board's questions are about
/// COURTS and relays, where the doors fixture is about gates: this one seeds several courts,
/// several boxes, a relay mapping and the projection row, and every method takes the instants
/// the test wants rather than "now". A fixture that could only build the present cannot test
/// staleness, and staleness is most of what this board is for.
/// </para>
/// </summary>
public sealed record ControlBoardClub(Guid TenantId, string Slug, Guid AdminUserId, Guid MemberUserId)
{
    /// <summary>The signing key <see cref="TestWebAppFactory"/> boots the app with.</summary>
    public const string Secret = "test-only-signing-key-not-used-in-any-real-environment";

    /// <summary>
    /// A club on the board's own numbers: UTC so a club day is testable, a 60-second
    /// heartbeat so the silent band (60 s) and the offline threshold (180 s) are far apart,
    /// and a five-second keep-alive so a stream test is seconds rather than half a minute.
    /// </summary>
    public const string DefaultSettings =
        """
        {"slice_minutes":15,"day_start_minute":0,"day_end_minute":1440,"slice_price_credits":8,
         "timezone":"UTC","heartbeat_seconds":60,"sse_keepalive_seconds":5,
         "control_board_resync_seconds":30,"control_board_stale_multiplier":2,
         "realtime_poll_seconds_control_board":10,"realtime_fallback_after_failures":3,
         "realtime_fallback_window_seconds":120}
        """;

    public static async Task<ControlBoardClub> SeedAsync(
        TestWebAppFactory factory, string slugPrefix, string settingsJson = DefaultSettings)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        // The PREFIX is truncated and the random half never is — DoorClub's reasoning, which
        // this tier's shared database makes load-bearing rather than tidy.
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

        var admin = Person(db, tenant.Id, $"{slug}-a", "Board Admin", isAdmin: true, photo: null);
        var member = Person(db, tenant.Id, $"{slug}-m", "Priya Naidoo", isAdmin: false, photo: "/media/priya.jpg");

        await db.SaveChangesAsync();
        return new ControlBoardClub(tenant.Id, slug, admin, member);
    }

    private static Guid Person(
        MainframeDbContext db, Guid tenantId, string handle, string name, bool isAdmin, string? photo)
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
            PhotoUrl = photo,
            Status = MembershipStatus.Active,
        });
        return user.Id;
    }

    /// <summary>One court. <paramref name="isActive"/> false is a soft-deleted court, which still shows.</summary>
    public async Task<Guid> AddCourtAsync(
        TestWebAppFactory factory, int number, string? name = null, bool isActive = true)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var court = new Court
        {
            TenantId = TenantId,
            CourtNumber = number,
            Name = name ?? $"Court {number}",
            SlicePriceCredits = 8m,
            IsActive = isActive,
        };
        db.Courts.Add(court);
        await db.SaveChangesAsync();
        return court.Id;
    }

    /// <summary>
    /// A court box. <paramref name="courtNumbers"/> IS the relay mapping — index 0 is relay A.
    /// </summary>
    public async Task<Guid> AddBoxAsync(
        TestWebAppFactory factory, string deviceCode, IEnumerable<int> courtNumbers,
        DateTimeOffset? lastSeenAt = null, bool enabled = true, DateTimeOffset? outOfServiceSince = null,
        string? firmware = "1.4.2", string? megaVersion = "1.1.0", string name = "Court box")
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var device = new Device
        {
            TenantId = TenantId,
            DeviceCode = deviceCode,
            Name = name,
            Kind = DeviceKind.CourtBox,
            Hardware = DeviceHardware.Esp8266,
            CourtNumbers = [.. courtNumbers],
            MacAddress = Guid.NewGuid().ToString("N")[..12],
            Enabled = enabled,
            OutOfServiceSince = outOfServiceSince?.ToUniversalTime(),
            LastSeenAt = lastSeenAt?.ToUniversalTime(),
            RunningVersion = firmware,
            MegaVersion = megaVersion,
        };
        db.Devices.Add(device);
        await db.SaveChangesAsync();
        return device.Id;
    }

    /// <summary>
    /// The projection row, written directly. Directly rather than through
    /// <c>CourtLightStateService</c> because a test needs a board that died an hour ago with
    /// the lights on, and there is no sequence of live calls that produces one.
    /// </summary>
    public async Task SetLightsAsync(
        TestWebAppFactory factory, Guid courtId, LightState state, DateTimeOffset lastEventAt,
        DateTimeOffset? onSince = null, DateTimeOffset? onUntil = null,
        LightCause cause = LightCause.Unknown, Guid? causedByUserId = null,
        Guid? deviceId = null, int? relay = null, Guid? bookingId = null)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        db.CourtLightStates.Add(new CourtLightState
        {
            TenantId = TenantId,
            CourtId = courtId,
            State = state,
            OnSince = onSince?.ToUniversalTime(),
            OnUntil = onUntil?.ToUniversalTime(),
            BookingId = bookingId,
            Cause = cause,
            CausedByUserId = causedByUserId,
            DeviceId = deviceId,
            Relay = relay,
            LastEventAt = lastEventAt.ToUniversalTime(),
            UpdatedAt = lastEventAt.ToUniversalTime(),
        });
        await db.SaveChangesAsync();
    }

    /// <summary>A booking, as the booking service leaves one.</summary>
    public async Task<Guid> AddBookingAsync(
        TestWebAppFactory factory, Guid courtId, DateTimeOffset startsAt, DateTimeOffset endsAt,
        Guid? userId = null, BookingStatus status = BookingStatus.Booked, string? blockLabel = null,
        decimal amountCredits = 36m, DateTimeOffset? checkedInAt = null, bool walkUp = false)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var starts = startsAt.ToUniversalTime();
        var booking = new Booking
        {
            TenantId = TenantId,
            CourtId = courtId,
            UserId = userId,
            BookedByUserId = userId,
            PaidByUserId = userId,
            ActorUserId = userId ?? AdminUserId,
            StartsAt = starts,
            EndsAt = endsAt.ToUniversalTime(),
            SliceMinutes = 15,
            SliceCount = 1,
            AmountChargedCredits = amountCredits,
            Status = status,
            BlockLabel = blockLabel,
            CheckedInAt = checkedInAt?.ToUniversalTime(),

            // A walk-up is charged at the instant it starts, because both come from one
            // `now` in CreateWalkUpAsync. That equality is the only thing on the row that
            // tells the two apart — see ControlBoardView.KindOf.
            ChargedAt = walkUp ? starts : DateTimeOffset.UtcNow.AddDays(-1),
        };
        db.Bookings.Add(booking);
        await db.SaveChangesAsync();
        return booking.Id;
    }

    /// <summary>One open (or resolved) fault against a board, for the tile's counts.</summary>
    public async Task AddErrorAsync(
        TestWebAppFactory factory, Guid deviceId, string code, DeviceErrorSeverity severity,
        bool resolved = false)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var now = DateTimeOffset.UtcNow;
        db.DeviceErrors.Add(new DeviceError
        {
            TenantId = TenantId,
            DeviceId = deviceId,
            Source = DeviceErrorSource.Device,
            Code = code,
            Severity = severity,
            FirstSeenAt = now,
            LastSeenAt = now,
            Fingerprint = $"{deviceId:N}:{code}:{Guid.NewGuid():N}"[..64],
            ResolvedAt = resolved ? now : null,
        });
        await db.SaveChangesAsync();
    }

    public HttpClient AdminClient(TestWebAppFactory factory) => ClientFor(factory, AdminUserId, "admin");

    public HttpClient MemberClient(TestWebAppFactory factory) => ClientFor(factory, MemberUserId, null);

    public HttpClient ClientFor(TestWebAppFactory factory, Guid userId, string? role)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", TokenFor(userId, role));
        return client;
    }

    /// <summary>A token this club's routes accept. Block body for the lizard reason in <c>memory/gotchas.md</c>.</summary>
    public string TokenFor(Guid userId, string? role, string purpose = "access")
    {
        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, userId.ToString()),
            new(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString()),
            new("tenant_id", TenantId.ToString()),
            new("tenant_slug", Slug),
            new("purpose", purpose),
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

/// <summary>
/// Counts the SQL statements a block of work issues, so "no N+1" is a number a test can pin
/// rather than a claim in a doc comment.
///
/// <para>
/// There was no counting interceptor in this project when the control board was built. It
/// lives here rather than in a shared file because it is the only surface that currently
/// asserts a query budget; the first second caller moves it.
/// </para>
/// </summary>
public sealed class CountingCommandInterceptor : DbCommandInterceptor
{
    private int _count;

    public int Count => Volatile.Read(ref _count);

    public void Reset() => Volatile.Write(ref _count, 0);

    public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
        DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result,
        CancellationToken cancellationToken = default)
    {
        Interlocked.Increment(ref _count);
        return base.ReaderExecutingAsync(command, eventData, result, cancellationToken);
    }
}

/// <summary>
/// <c>GET /api/v1/admin/control-board</c> — GOAL item 10's one read.
///
/// <para>
/// The claims under test are the ones a wall screen is wrong about silently. <b>A light state
/// carries its own doubt</b>: an unqualified "ON" beside a box that has not spoken for six
/// minutes is how a club leaves a court lit all night, so <c>stale</c> and <c>as_of</c> are on
/// the wire beside <c>state</c> and both halves of that conditional are asserted. <b>A court
/// the club soft-deleted still appears</b>, because it can still carry a paid booking and
/// dropping it loses a member's money from the only screen that would have shown it. <b>The
/// offline threshold is the EFFECTIVE heartbeat</b>, so the board and the devices console
/// cannot disagree about the same box. And <b>the read is flat</b>: a board refreshing every
/// few seconds on a league night is the exact shape that melts a club's database when it is a
/// query per court.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class ControlBoardHttpTests
{
    private readonly PostgresFixture _pg;

    public ControlBoardHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string BoardPath = "/api/v1/admin/control-board";

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    private static JsonElement CourtNumbered(JsonElement body, int number)
        => body.GetProperty("courts").EnumerateArray()
            .Single(c => c.GetProperty("court_number").GetInt32() == number);

    // ---- who may read it -------------------------------------------------------------

    /// <summary>The board names every member playing tonight. It is not a member's page.</summary>
    [SkippableFact]
    public async Task A_member_may_not_read_the_control_board()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ControlBoardClub.SeedAsync(factory, "cbrole");

        var response = await club.MemberClient(factory).GetAsync(BoardPath);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    /// <summary>
    /// A caller with no credential gets nothing — and which refusal depends on whether a club
    /// could be identified at all, which is this application's documented order rather than
    /// this endpoint's choice.
    ///
    /// <para>
    /// <b>Both halves are asserted because only the second one is about the control board.</b>
    /// A request carrying no tenant is refused <c>400 tenant_unresolved</c> by the resolution
    /// middleware, which runs before authentication — so a test that asserted 401 for it would
    /// pass or fail on the middleware's behaviour and say nothing about whether this route is
    /// protected. The half that proves the route is the one where the club IS resolved, from
    /// the host subdomain, and there is still no credential.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task An_unauthenticated_request_is_refused()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ControlBoardClub.SeedAsync(factory, "cbanon");

        var noTenant = await factory.CreateClient().GetAsync(BoardPath);
        Assert.Equal(HttpStatusCode.BadRequest, noTenant.StatusCode);

        var anonymous = factory.CreateClient();
        anonymous.DefaultRequestHeaders.Host = $"{club.Slug}.crusaders.test";
        var refused = await anonymous.GetAsync(BoardPath);

        Assert.Equal(HttpStatusCode.Unauthorized, refused.StatusCode);
    }

    /// <summary>
    /// Loading, empty and failed are three states. A club with no courts answers a whole
    /// envelope with an empty list — never a 404, never a bare <c>[]</c>, because a page that
    /// cannot tell "no courts" from "the read failed" renders the same emptiness for both.
    /// </summary>
    [SkippableFact]
    public async Task A_club_with_no_courts_answers_an_empty_list_inside_a_whole_envelope()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ControlBoardClub.SeedAsync(factory, "cbempty");

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(BoardPath);

        Assert.Empty(body.GetProperty("courts").EnumerateArray());
        Assert.Equal("UTC", body.GetProperty("timezone").GetString());
        Assert.Equal(15, body.GetProperty("slice_minutes").GetInt32());
        Assert.True(body.TryGetProperty("generated_at", out _));
        Assert.True(body.TryGetProperty("club_day", out _));
    }

    // ---- the courts on it ------------------------------------------------------------

    /// <summary>
    /// A soft-deleted court still carries tonight's paid booking. Dropping it from the board
    /// is how the club loses the one screen that would have shown it (D2-B34's argument,
    /// applied to this surface).
    /// </summary>
    [SkippableFact]
    public async Task An_inactive_court_is_on_the_board_carrying_its_booking()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ControlBoardClub.SeedAsync(factory, "cbinact");
        var courtId = await club.AddCourtAsync(factory, 1, isActive: false);
        var now = DateTimeOffset.UtcNow;
        await club.AddBookingAsync(factory, courtId, now.AddMinutes(-5), now.AddMinutes(10), club.MemberUserId);

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(BoardPath);
        var court = CourtNumbered(body, 1);

        Assert.False(court.GetProperty("is_active").GetBoolean());
        Assert.Equal("Priya Naidoo",
            court.GetProperty("current").GetProperty("booked_by").GetProperty("name").GetString());
    }

    /// <summary>The club's day, and the club's zone — never the reader's.</summary>
    [SkippableFact]
    public async Task The_day_and_the_zone_are_the_clubs_own()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ControlBoardClub.SeedAsync(
            factory, "cbtz",
            """{"slice_minutes":15,"timezone":"Pacific/Auckland","heartbeat_seconds":60}""");
        await club.AddCourtAsync(factory, 1);

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(BoardPath);

        var zone = TimeZoneInfo.FindSystemTimeZoneById("Pacific/Auckland");
        var expected = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, zone).DateTime);
        Assert.Equal("Pacific/Auckland", body.GetProperty("timezone").GetString());
        Assert.Equal(expected.ToString("yyyy-MM-dd"), body.GetProperty("club_day").GetString());
    }

    /// <summary>
    /// A zone this platform has never heard of renders as UTC and SAYS UTC. A page printing a
    /// club's own label beside instants that are not in it is worse than one that says UTC.
    /// </summary>
    [SkippableFact]
    public async Task A_zone_the_platform_cannot_name_reads_as_utc()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ControlBoardClub.SeedAsync(
            factory, "cbbadtz",
            """{"slice_minutes":15,"timezone":"Middle/Earth","heartbeat_seconds":60}""");
        await club.AddCourtAsync(factory, 1);

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(BoardPath);

        Assert.Equal("UTC", body.GetProperty("timezone").GetString());
    }

    // ---- the lights block ------------------------------------------------------------

    /// <summary>
    /// A grant that ran out while the box was silent reads as zero seconds left, never as a
    /// negative countdown. A screen counting downwards past zero is a screen nobody believes.
    /// </summary>
    [SkippableFact]
    public async Task Seconds_remaining_on_an_expired_grant_is_zero_and_never_negative()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ControlBoardClub.SeedAsync(factory, "cbexp");
        var courtId = await club.AddCourtAsync(factory, 1);
        var now = DateTimeOffset.UtcNow;
        await club.SetLightsAsync(
            factory, courtId, LightState.On, now.AddMinutes(-40),
            onSince: now.AddMinutes(-70), onUntil: now.AddMinutes(-10), cause: LightCause.Member,
            causedByUserId: club.MemberUserId);

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(BoardPath);
        var lights = CourtNumbered(body, 1).GetProperty("lights");

        Assert.Equal("on", lights.GetProperty("state").GetString());
        Assert.Equal(0, lights.GetProperty("seconds_remaining").GetInt32());
    }

    /// <summary>
    /// Both halves of the conditional, and the BAND rather than the exact boundary. The stale
    /// window is <c>control_board_stale_multiplier × effective heartbeat</c> — 120 s on this
    /// fixture.
    ///
    /// <para>
    /// <b>The edge court sits well inside the window, not one second inside it, and that is a
    /// correction.</b> It was at 119 s of 120, which made the assertion a race against the
    /// HTTP round trip: the server computes staleness against its own clock at read time, so a
    /// loaded machine that took over a second to answer turned a court the fixture placed
    /// inside the window into one outside it. A test that fails when the build agent is busy
    /// teaches everybody to re-run it, which is how a real failure gets re-run too.
    /// </para>
    ///
    /// <para>
    /// What is lost is the strictly-greater-versus-greater-or-equal distinction at exactly one
    /// window, which is not assertable over a network round trip at all. What is kept is the
    /// claim that matters on the glass: inside the window is not stale, past it is, and the
    /// qualifier travels with the state.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task Staleness_turns_on_just_past_the_window_and_not_at_it()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ControlBoardClub.SeedAsync(factory, "cbstale");
        var fresh = await club.AddCourtAsync(factory, 1);
        var edge = await club.AddCourtAsync(factory, 2);
        var gone = await club.AddCourtAsync(factory, 3);
        var now = DateTimeOffset.UtcNow;

        await club.SetLightsAsync(factory, fresh, LightState.On, now.AddSeconds(-5), onUntil: now.AddMinutes(30));
        // Well inside the window — 100 s of 120, which leaves twenty seconds for the round
        // trip. See the summary for why this is not 119.
        await club.SetLightsAsync(factory, edge, LightState.On, now.AddSeconds(-100), onUntil: now.AddMinutes(30));
        await club.SetLightsAsync(factory, gone, LightState.On, now.AddMinutes(-6), onUntil: now.AddMinutes(30));

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(BoardPath);

        Assert.False(CourtNumbered(body, 1).GetProperty("lights").GetProperty("stale").GetBoolean());
        Assert.False(CourtNumbered(body, 2).GetProperty("lights").GetProperty("stale").GetBoolean());

        var lit = CourtNumbered(body, 3).GetProperty("lights");
        Assert.True(lit.GetProperty("stale").GetBoolean());

        // "ON — but the box has not reported since 18:41" needs both, so both are on the wire.
        Assert.Equal("on", lit.GetProperty("state").GetString());
        Assert.True(lit.TryGetProperty("as_of", out var asOf));
        Assert.NotEqual(JsonValueKind.Null, asOf.ValueKind);
    }

    /// <summary>
    /// A board that went dark leaves <c>unknown</c>, and the board says unknown. Writing "off"
    /// would be the server claiming to have seen something it did not.
    /// </summary>
    [SkippableFact]
    public async Task A_dark_board_leaves_unknown_rather_than_off()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ControlBoardClub.SeedAsync(factory, "cbunk");
        var courtId = await club.AddCourtAsync(factory, 1);
        await club.SetLightsAsync(
            factory, courtId, LightState.Unknown, DateTimeOffset.UtcNow.AddMinutes(-20),
            cause: LightCause.Member, causedByUserId: club.MemberUserId);

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(BoardPath);
        var lights = CourtNumbered(body, 1).GetProperty("lights");

        Assert.Equal("unknown", lights.GetProperty("state").GetString());
        Assert.Equal(JsonValueKind.Null, lights.GetProperty("seconds_remaining").ValueKind);

        // The cause is deliberately kept: "was on for Priya Naidoo — the box has not reported
        // since 18:41" is more use than "we know nothing".
        Assert.Equal("member", lights.GetProperty("turned_on_by").GetProperty("kind").GetString());
    }

    /// <summary>
    /// A court nothing has ever happened on has no projection row at all, and that is
    /// <c>unknown</c> too — not <c>off</c>, which would be a claim.
    /// </summary>
    [SkippableFact]
    public async Task A_court_with_no_projection_row_reads_unknown()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ControlBoardClub.SeedAsync(factory, "cbnorow");
        await club.AddCourtAsync(factory, 1);

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(BoardPath);
        var lights = CourtNumbered(body, 1).GetProperty("lights");

        Assert.Equal("unknown", lights.GetProperty("state").GetString());
        Assert.Equal(JsonValueKind.Null, lights.GetProperty("as_of").ValueKind);
        Assert.Equal("unknown", lights.GetProperty("turned_on_by").GetProperty("kind").GetString());
    }

    /// <summary>A member who switched off before a power dip: off, and no countdown.</summary>
    [SkippableFact]
    public async Task Lights_switched_off_carry_no_countdown()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ControlBoardClub.SeedAsync(factory, "cboff");
        var courtId = await club.AddCourtAsync(factory, 1);
        var now = DateTimeOffset.UtcNow;
        await club.SetLightsAsync(
            factory, courtId, LightState.Off, now.AddMinutes(-3), onUntil: now.AddMinutes(-3),
            cause: LightCause.Member, causedByUserId: club.MemberUserId);

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(BoardPath);
        var lights = CourtNumbered(body, 1).GetProperty("lights");

        Assert.Equal("off", lights.GetProperty("state").GetString());
        Assert.Equal(JsonValueKind.Null, lights.GetProperty("seconds_remaining").ValueKind);
        Assert.Equal(JsonValueKind.Null, lights.GetProperty("since").ValueKind);
    }

    /// <summary>"Lights on by" is the member, with the photo the grid already shows.</summary>
    [SkippableFact]
    public async Task Turned_on_by_names_the_member_who_scanned()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ControlBoardClub.SeedAsync(factory, "cbwho");
        var courtId = await club.AddCourtAsync(factory, 1);
        var now = DateTimeOffset.UtcNow;
        await club.SetLightsAsync(
            factory, courtId, LightState.On, now.AddSeconds(-30), onSince: now.AddSeconds(-30),
            onUntil: now.AddMinutes(29), cause: LightCause.Member, causedByUserId: club.MemberUserId);

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(BoardPath);
        var by = CourtNumbered(body, 1).GetProperty("lights").GetProperty("turned_on_by");

        Assert.Equal("member", by.GetProperty("kind").GetString());
        Assert.Equal(club.MemberUserId, by.GetProperty("user_id").GetGuid());
        Assert.Equal("Priya Naidoo", by.GetProperty("name").GetString());
        Assert.Equal("/media/priya.jpg", by.GetProperty("photo_url").GetString());
    }

    /// <summary>
    /// A restore after a power dip says so and names nobody. Nobody scanned; inventing a
    /// member here would put a name against an act no person performed.
    /// </summary>
    [SkippableFact]
    public async Task A_restore_after_a_power_dip_names_nobody_and_says_what_it_was()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ControlBoardClub.SeedAsync(factory, "cbrestore");
        var courtId = await club.AddCourtAsync(factory, 1);
        var now = DateTimeOffset.UtcNow;
        await club.SetLightsAsync(
            factory, courtId, LightState.On, now.AddSeconds(-10), onSince: now.AddMinutes(-20),
            onUntil: now.AddMinutes(25), cause: LightCause.RestoreAfterPowerDip);

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(BoardPath);
        var by = CourtNumbered(body, 1).GetProperty("lights").GetProperty("turned_on_by");

        Assert.Equal("restore_after_power_dip", by.GetProperty("kind").GetString());
        Assert.Equal(JsonValueKind.Null, by.GetProperty("user_id").ValueKind);
        Assert.Equal(JsonValueKind.Null, by.GetProperty("name").ValueKind);
    }

    // ---- the device block ------------------------------------------------------------

    /// <summary>A court no box drives is <c>unlinked</c> — a distinct state from offline.</summary>
    [SkippableFact]
    public async Task A_court_no_box_drives_is_unlinked()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ControlBoardClub.SeedAsync(factory, "cbunlink");
        await club.AddCourtAsync(factory, 1);
        await club.AddBoxAsync(factory, "box-cb0001", [2], lastSeenAt: DateTimeOffset.UtcNow);
        await club.AddCourtAsync(factory, 2);

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(BoardPath);
        var device = CourtNumbered(body, 1).GetProperty("device");

        Assert.Equal("unlinked", device.GetProperty("link").GetString());
        Assert.Equal(JsonValueKind.Null, device.GetProperty("device_id").ValueKind);
        Assert.Equal(JsonValueKind.Null, device.GetProperty("relay").ValueKind);

        // Still a club number, and still on the wire: the tile says what "offline" would mean
        // for this club even when no board is there to be offline.
        Assert.Equal(180, device.GetProperty("offline_after_seconds").GetInt32());
    }

    /// <summary>
    /// Out of service outranks talking. A board an admin shut is out of service even while it
    /// is heartbeating, because the club's decision is the fact and the heartbeat is not.
    /// </summary>
    [SkippableFact]
    public async Task A_board_taken_out_of_service_says_so_even_while_it_talks()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ControlBoardClub.SeedAsync(factory, "cboos");
        await club.AddCourtAsync(factory, 1);
        var now = DateTimeOffset.UtcNow;
        await club.AddBoxAsync(
            factory, "box-cb0002", [1], lastSeenAt: now, enabled: false, outOfServiceSince: now.AddHours(-2));

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(BoardPath);

        Assert.Equal("out_of_service", CourtNumbered(body, 1).GetProperty("device").GetProperty("link").GetString());
    }

    /// <summary>
    /// The three live bands. Silent is the one that had no name before this board: past one
    /// heartbeat, not yet offline, and the one an admin most wants to see.
    /// </summary>
    [SkippableFact]
    public async Task Online_silent_and_offline_are_three_bands_not_two()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ControlBoardClub.SeedAsync(factory, "cbbands");
        await club.AddCourtAsync(factory, 1);
        await club.AddCourtAsync(factory, 2);
        await club.AddCourtAsync(factory, 3);
        var now = DateTimeOffset.UtcNow;

        await club.AddBoxAsync(factory, "box-cb0003", [1], lastSeenAt: now.AddSeconds(-10));
        await club.AddBoxAsync(factory, "box-cb0004", [2], lastSeenAt: now.AddSeconds(-90));
        await club.AddBoxAsync(factory, "box-cb0005", [3], lastSeenAt: now.AddSeconds(-400));

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(BoardPath);

        Assert.Equal("online", CourtNumbered(body, 1).GetProperty("device").GetProperty("link").GetString());
        Assert.Equal("silent", CourtNumbered(body, 2).GetProperty("device").GetProperty("link").GetString());
        Assert.Equal("offline", CourtNumbered(body, 3).GetProperty("device").GetProperty("link").GetString());
    }

    /// <summary>A box that has never called in is offline, not online with a null.</summary>
    [SkippableFact]
    public async Task A_box_that_has_never_called_in_is_offline()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ControlBoardClub.SeedAsync(factory, "cbnever");
        await club.AddCourtAsync(factory, 1);
        await club.AddBoxAsync(factory, "box-cb0006", [1], lastSeenAt: null);

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(BoardPath);
        var device = CourtNumbered(body, 1).GetProperty("device");

        Assert.Equal("offline", device.GetProperty("link").GetString());
        Assert.Equal(JsonValueKind.Null, device.GetProperty("silent_seconds").ValueKind);
    }

    /// <summary>
    /// D2-B29. A club that asked for a 600-second heartbeat gets boxes running at 300, so the
    /// board's threshold is derived from 300 — otherwise the board and the devices console
    /// disagree about the same silent box and neither is obviously wrong.
    /// </summary>
    [SkippableFact]
    public async Task The_threshold_comes_from_the_effective_heartbeat_not_the_configured_one()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ControlBoardClub.SeedAsync(
            factory, "cbeff",
            """{"slice_minutes":15,"timezone":"UTC","heartbeat_seconds":600}""");
        await club.AddCourtAsync(factory, 1);
        await club.AddBoxAsync(factory, "box-cb0007", [1], lastSeenAt: DateTimeOffset.UtcNow.AddSeconds(-1000));

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(BoardPath);
        var device = CourtNumbered(body, 1).GetProperty("device");

        // 300 (the firmware's clamp) x 3 missed beats = 900, not 600 x 3 = 1800.
        Assert.Equal(900, device.GetProperty("offline_after_seconds").GetInt32());
        Assert.Equal("offline", device.GetProperty("link").GetString());
    }

    /// <summary>
    /// Two boxes on one club, each answering for its own courts, and the relay LETTER is the
    /// court's position in that box's own list. Index 0 is relay A.
    /// </summary>
    [SkippableFact]
    public async Task Two_boxes_each_answer_for_their_own_courts_with_their_own_relay_letters()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ControlBoardClub.SeedAsync(factory, "cbtwo");
        foreach (var n in new[] { 1, 2, 3, 4, 5 }) await club.AddCourtAsync(factory, n);
        var now = DateTimeOffset.UtcNow;

        await club.AddBoxAsync(factory, "box-cb0008", [1, 2, 3], lastSeenAt: now, firmware: "1.4.2");
        await club.AddBoxAsync(factory, "box-cb0009", [5, 4], lastSeenAt: now.AddSeconds(-400), firmware: "1.3.0");

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(BoardPath);

        Assert.Equal("A", CourtNumbered(body, 1).GetProperty("device").GetProperty("relay").GetString());
        Assert.Equal("B", CourtNumbered(body, 2).GetProperty("device").GetProperty("relay").GetString());
        Assert.Equal("C", CourtNumbered(body, 3).GetProperty("device").GetProperty("relay").GetString());

        // The second box lists 5 first, so court 5 is on ITS relay A and court 4 on B. A
        // position, never the court number.
        Assert.Equal("A", CourtNumbered(body, 5).GetProperty("device").GetProperty("relay").GetString());
        Assert.Equal("B", CourtNumbered(body, 4).GetProperty("device").GetProperty("relay").GetString());

        Assert.Equal("box-cb0008", CourtNumbered(body, 1).GetProperty("device").GetProperty("device_code").GetString());
        Assert.Equal("1.3.0", CourtNumbered(body, 4).GetProperty("device").GetProperty("firmware").GetString());
        Assert.Equal("online", CourtNumbered(body, 1).GetProperty("device").GetProperty("link").GetString());
        Assert.Equal("offline", CourtNumbered(body, 4).GetProperty("device").GetProperty("link").GetString());
    }

    /// <summary>Open faults, by severity, for the board that owns the court — resolved ones are not open.</summary>
    [SkippableFact]
    public async Task Open_faults_are_counted_by_severity_and_a_resolved_one_is_not_one()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ControlBoardClub.SeedAsync(factory, "cberr");
        await club.AddCourtAsync(factory, 1);
        await club.AddCourtAsync(factory, 2);
        var boxA = await club.AddBoxAsync(factory, "box-cb0010", [1], lastSeenAt: DateTimeOffset.UtcNow);
        await club.AddBoxAsync(factory, "box-cb0011", [2], lastSeenAt: DateTimeOffset.UtcNow);

        await club.AddErrorAsync(factory, boxA, "scanner_timeout", DeviceErrorSeverity.Error);
        await club.AddErrorAsync(factory, boxA, "bridge_desync", DeviceErrorSeverity.Error);
        await club.AddErrorAsync(factory, boxA, "lcd_slow", DeviceErrorSeverity.Warning);
        await club.AddErrorAsync(factory, boxA, "relay_stuck", DeviceErrorSeverity.Critical, resolved: true);

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(BoardPath);
        var open = CourtNumbered(body, 1).GetProperty("device").GetProperty("open_errors");

        Assert.Equal(0, open.GetProperty("critical").GetInt32());
        Assert.Equal(2, open.GetProperty("error").GetInt32());
        Assert.Equal(1, open.GetProperty("warning").GetInt32());

        // The other board's court is not charged with this board's faults.
        var other = CourtNumbered(body, 2).GetProperty("device").GetProperty("open_errors");
        Assert.Equal(0, other.GetProperty("error").GetInt32());
    }

    // ---- current and next ------------------------------------------------------------

    /// <summary>The slot being played and the one after it, picked out of one day's bookings.</summary>
    [SkippableFact]
    public async Task The_current_slot_and_the_next_one_come_from_one_days_bookings()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ControlBoardClub.SeedAsync(factory, "cbslots");
        var courtId = await club.AddCourtAsync(factory, 1);
        var now = DateTimeOffset.UtcNow;

        var current = await club.AddBookingAsync(
            factory, courtId, now.AddMinutes(-4), now.AddMinutes(11), club.MemberUserId,
            checkedInAt: now.AddMinutes(-3), amountCredits: 36m);
        var next = await club.AddBookingAsync(
            factory, courtId, now.AddMinutes(41), now.AddMinutes(56), club.AdminUserId);
        // A later one, to prove "next" is the EARLIEST future slot rather than the last row read.
        await club.AddBookingAsync(factory, courtId, now.AddMinutes(90), now.AddMinutes(105), club.AdminUserId);

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(BoardPath);
        var court = CourtNumbered(body, 1);

        var cur = court.GetProperty("current");
        Assert.Equal(current, cur.GetProperty("booking_id").GetGuid());
        Assert.Equal("booked", cur.GetProperty("status").GetString());
        Assert.Equal("booking", cur.GetProperty("kind").GetString());
        Assert.Equal(36m, cur.GetProperty("amount_credits").GetDecimal());
        Assert.NotEqual(JsonValueKind.Null, cur.GetProperty("checked_in_at").ValueKind);

        var nxt = court.GetProperty("next");
        Assert.Equal(next, nxt.GetProperty("booking_id").GetGuid());
        Assert.InRange(nxt.GetProperty("minutes_until").GetInt32(), 39, 42);
    }

    /// <summary>A cancelled booking reserves nothing and is on nobody's tile.</summary>
    [SkippableFact]
    public async Task A_cancelled_booking_is_neither_current_nor_next()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ControlBoardClub.SeedAsync(factory, "cbcanc");
        var courtId = await club.AddCourtAsync(factory, 1);
        var now = DateTimeOffset.UtcNow;

        await club.AddBookingAsync(
            factory, courtId, now.AddMinutes(-4), now.AddMinutes(11), club.MemberUserId,
            status: BookingStatus.Cancelled);
        await club.AddBookingAsync(
            factory, courtId, now.AddMinutes(20), now.AddMinutes(35), club.MemberUserId,
            status: BookingStatus.Cancelled);

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(BoardPath);
        var court = CourtNumbered(body, 1);

        Assert.Equal(JsonValueKind.Null, court.GetProperty("current").ValueKind);
        Assert.Equal(JsonValueKind.Null, court.GetProperty("next").ValueKind);
    }

    /// <summary>An admin block is a block, carries its label, and nobody booked it.</summary>
    [SkippableFact]
    public async Task An_admin_block_reads_as_a_block_with_its_label_and_no_member()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ControlBoardClub.SeedAsync(factory, "cbblock");
        var courtId = await club.AddCourtAsync(factory, 1);
        var now = DateTimeOffset.UtcNow;
        await club.AddBookingAsync(
            factory, courtId, now.AddMinutes(-4), now.AddMinutes(11), userId: null,
            status: BookingStatus.AdminBlock, blockLabel: "League night", amountCredits: 0m);

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(BoardPath);
        var cur = CourtNumbered(body, 1).GetProperty("current");

        Assert.Equal("block", cur.GetProperty("kind").GetString());
        Assert.Equal("admin_block", cur.GetProperty("status").GetString());
        Assert.Equal("League night", cur.GetProperty("label").GetString());
        Assert.Equal(JsonValueKind.Null, cur.GetProperty("booked_by").ValueKind);
    }

    /// <summary>
    /// A walk-up is told apart from a booking. It is charged at the instant it starts —
    /// one <c>now</c> serves both fields in <c>CreateWalkUpAsync</c> — and that equality is
    /// the only discriminator the row carries.
    /// </summary>
    [SkippableFact]
    public async Task A_walk_up_is_told_apart_from_a_booking()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ControlBoardClub.SeedAsync(factory, "cbwalk");
        var walkCourt = await club.AddCourtAsync(factory, 1);
        var bookedCourt = await club.AddCourtAsync(factory, 2);
        var now = TestHost.UtcNowStorable();

        await club.AddBookingAsync(
            factory, walkCourt, now.AddMinutes(-4), now.AddMinutes(11), club.MemberUserId, walkUp: true);
        await club.AddBookingAsync(
            factory, bookedCourt, now.AddMinutes(-4), now.AddMinutes(11), club.MemberUserId);

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(BoardPath);

        Assert.Equal("walk_up", CourtNumbered(body, 1).GetProperty("current").GetProperty("kind").GetString());
        Assert.Equal("booking", CourtNumbered(body, 2).GetProperty("current").GetProperty("kind").GetString());
    }

    // ---- the page's own numbers ------------------------------------------------------

    /// <summary>
    /// The page needs ONE read to know how to behave. A page that has to make a second request
    /// to learn how often to make requests is a page that gets one of them wrong.
    /// </summary>
    [SkippableFact]
    public async Task The_board_carries_the_pages_own_poll_and_resync_numbers()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ControlBoardClub.SeedAsync(factory, "cbrt");
        await club.AddCourtAsync(factory, 1);

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(BoardPath);
        var realtime = body.GetProperty("realtime");

        Assert.Equal(10, realtime.GetProperty("poll_seconds").GetInt32());
        Assert.Equal(30, realtime.GetProperty("resync_seconds").GetInt32());
        Assert.Equal(3, realtime.GetProperty("fallback_after_failures").GetInt32());
        Assert.Equal(120, realtime.GetProperty("fallback_window_seconds").GetInt32());
    }

    // ---- tenancy ---------------------------------------------------------------------

    /// <summary>
    /// A club's board never carries another club's court, box, booking or fault. Both clubs
    /// live in one database, which is the only arrangement under which this assertion means
    /// anything.
    /// </summary>
    [SkippableFact]
    public async Task A_clubs_board_never_carries_another_clubs_courts()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var mine = await ControlBoardClub.SeedAsync(factory, "cbmine");
        var theirs = await ControlBoardClub.SeedAsync(factory, "cbtheirs");

        var myCourt = await mine.AddCourtAsync(factory, 1, "My court");
        var theirCourt = await theirs.AddCourtAsync(factory, 1, "Their court");
        var now = DateTimeOffset.UtcNow;
        await theirs.AddBoxAsync(factory, "box-cb0012", [1], lastSeenAt: now);
        await theirs.AddBookingAsync(factory, theirCourt, now.AddMinutes(-4), now.AddMinutes(11), theirs.MemberUserId);
        await theirs.SetLightsAsync(factory, theirCourt, LightState.On, now, onUntil: now.AddMinutes(11));

        var body = await mine.AdminClient(factory).GetFromJsonAsync<JsonElement>(BoardPath);

        var court = Assert.Single(body.GetProperty("courts").EnumerateArray());
        Assert.Equal(myCourt, court.GetProperty("court_id").GetGuid());
        Assert.Equal("My court", court.GetProperty("name").GetString());
        Assert.Equal("unlinked", court.GetProperty("device").GetProperty("link").GetString());
        Assert.Equal("unknown", court.GetProperty("lights").GetProperty("state").GetString());
        Assert.Equal(JsonValueKind.Null, court.GetProperty("current").ValueKind);

        // And the whole document never mentions them, by any route.
        var raw = JsonSerializer.Serialize(body);
        Assert.DoesNotContain("Their court", raw, StringComparison.Ordinal);
        Assert.DoesNotContain("box-cb0012", raw, StringComparison.Ordinal);
    }

    // ---- the query budget ------------------------------------------------------------

    /// <summary>
    /// Flat, and FLAT AS THE CLUB GROWS. The exact number is pinned because a silent extra
    /// round trip on a wall screen refreshing every ten seconds is a cost nobody notices until
    /// a league night; the invariance across court counts is the assertion that actually
    /// catches an N+1, because that is the defect where the number grows with the club.
    /// </summary>
    [SkippableFact]
    public async Task The_board_is_a_flat_read_that_does_not_grow_with_the_club()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ControlBoardClub.SeedAsync(factory, "cbqueries");
        var now = DateTimeOffset.UtcNow;

        var small = await CountBoardQueriesAsync(club, 2, factory, now);
        var large = await CountBoardQueriesAsync(club, 8, factory, now);

        Assert.Equal(small, large);

        // Six reads for the board — courts, light states, today's bookings, the people on
        // them, the boards, the open-fault counts — plus the settings document, which is its
        // own uncached SELECT on every request in this codebase.
        Assert.Equal(7, large);
    }

    /// <summary>
    /// Grows the club to <paramref name="courts"/> courts, each with its own box, booking and
    /// light state, then counts the statements one board read issues.
    /// </summary>
    private async Task<int> CountBoardQueriesAsync(
        ControlBoardClub club, int courts, TestWebAppFactory factory, DateTimeOffset now)
    {
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var existing = await db.Courts.IgnoreQueryFilters().CountAsync(c => c.TenantId == club.TenantId);
            for (var n = existing + 1; n <= courts; n++)
            {
                var courtId = await club.AddCourtAsync(factory, n);
                await club.AddBoxAsync(factory, $"box-q{n:D6}", [n], lastSeenAt: now);
                await club.AddBookingAsync(
                    factory, courtId, now.AddMinutes(-4), now.AddMinutes(11), club.MemberUserId);
                await club.SetLightsAsync(
                    factory, courtId, LightState.On, now, onUntil: now.AddMinutes(11),
                    cause: LightCause.Member, causedByUserId: club.MemberUserId);
            }
        }

        var counter = new CountingCommandInterceptor();
        var options = new DbContextOptionsBuilder<MainframeDbContext>()
            .UseNpgsql(_pg.ConnectionString)
            .AddInterceptors(counter)
            .Options;

        var tenant = new TenantContext();
        tenant.Set(club.TenantId, club.Slug);
        await using var counted = new MainframeDbContext(options, tenant);

        // Warm the connection and the model OUTSIDE the measurement: the first query on a
        // fresh context pays for whatever Npgsql does on connect, and a budget that included
        // it would be a different number on the first run of the day.
        await counted.Courts.AsNoTracking().CountAsync();
        counter.Reset();

        var reader = new ControlBoardReader(counted, tenant, new TenantSettingsAccessor(counted, tenant));
        await reader.BuildAsync(CancellationToken.None);
        return counter.Count;
    }
}
