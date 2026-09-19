using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// W1.7 and W1.8 — the member's own door surface.
///
/// <para>
/// <b>P3's other half.</b> The admin log has no per-member filter because a member's door
/// history belongs to the member; these two routes are where it belongs TO them. Which makes
/// the isolation tests here the load-bearing ones, and they are deliberately doubled: another
/// club's rows must not appear (the repo's standing rule) and another MEMBER OF THIS CLUB's
/// rows must not appear either, which no tenant filter can catch because both members are
/// inside it.
/// </para>
///
/// <para>
/// <b><c>doors: false</c> means the page says nothing about doors at all.</b> A club with no
/// door controller must not be shown a screen describing a building with no controller in it,
/// which is why it is a separate field rather than an empty history.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class MeDoorHttpTests
{
    private readonly PostgresFixture _pg;

    public MeDoorHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string DoorPath = "/api/v1/me/door";
    private const string HistoryPath = "/api/v1/me/door/history";

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    private static List<JsonElement> Items(JsonElement body) => body.GetProperty("items").EnumerateArray().ToList();

    [SkippableFact]
    public async Task A_club_with_no_door_says_so_and_the_page_stays_silent()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "medoornone");

        var body = await club.MemberClient(factory).GetFromJsonAsync<JsonElement>(DoorPath);

        Assert.False(body.GetProperty("doors").GetBoolean());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("last_decision").ValueKind);
    }

    /// <summary>
    /// A board the club has switched off is refused 403 on every route it calls, so promising a
    /// member it will let them in would be false. The same rule the QR screen already applies.
    /// </summary>
    [SkippableFact]
    public async Task A_club_whose_only_door_is_out_of_service_has_no_doors()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "medoorshut");
        await club.AddDoorAsync(factory, "gate-me0001", "front-door", enabled: false);

        var body = await club.MemberClient(factory).GetFromJsonAsync<JsonElement>(DoorPath);
        Assert.False(body.GetProperty("doors").GetBoolean());
    }

    [SkippableFact]
    public async Task The_standing_facts_are_the_clubs_policy_and_this_members_membership()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "medoorfacts");
        await club.AddDoorAsync(factory, "gate-me0002", "front-door");

        var body = await club.MemberClient(factory).GetFromJsonAsync<JsonElement>(DoorPath);

        Assert.True(body.GetProperty("doors").GetBoolean());
        Assert.Equal(GateAccessPolicies.ActiveMember, body.GetProperty("policy").GetString());
        Assert.Equal("active", body.GetProperty("membership").GetString());
        Assert.False(body.GetProperty("is_club_admin").GetBoolean());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("next_booking").ValueKind);
    }

    /// <summary>
    /// The three membership states the page has different sentences for. "none" is a user with
    /// no membership row — a state <c>MembershipAccess</c> deliberately does not treat as barred,
    /// so the page must not say "suspended" about it.
    /// </summary>
    [SkippableTheory]
    [InlineData(MembershipStatus.Active, "active")]
    [InlineData(MembershipStatus.Suspended, "not_active")]
    [InlineData(MembershipStatus.PendingApproval, "not_active")]
    [InlineData(MembershipStatus.Rejected, "not_active")]
    public async Task The_membership_state_is_reported_in_three_values(MembershipStatus status, string expected)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, $"medoorms-{(int)status}");
        await club.AddDoorAsync(factory, $"gate-{Guid.NewGuid():N}"[..14], "front-door");

        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var membership = await db.Memberships.IgnoreQueryFilters().FirstAsync(m => m.UserId == club.MemberUserId);
            membership.Status = status;
            await db.SaveChangesAsync();
        }

        var body = await club.MemberClient(factory).GetFromJsonAsync<JsonElement>(DoorPath);
        Assert.Equal(expected, body.GetProperty("membership").GetString());
    }

    [SkippableFact]
    public async Task A_user_with_no_membership_row_is_none_rather_than_not_active()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "medoornomem");
        await club.AddDoorAsync(factory, "gate-me0003", "front-door");

        Guid strayId;
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var stray = new User
            {
                TenantId = club.TenantId, Email = $"{club.Slug}-stray@test.local",
                PasswordHash = "x", EmailVerified = true,
            };
            db.Users.Add(stray);
            await db.SaveChangesAsync();
            strayId = stray.Id;
        }

        var body = await club.ClientFor(factory, strayId, null).GetFromJsonAsync<JsonElement>(DoorPath);
        Assert.Equal("none", body.GetProperty("membership").GetString());
    }

    /// <summary>
    /// The window is computed by <c>BookingCodeWindow</c> — the same function the door decides
    /// with — rather than by the page, which cannot know the club's three settings and should
    /// not be shown them.
    /// </summary>
    [SkippableFact]
    public async Task The_next_booking_carries_the_window_the_door_will_actually_honour()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "medoorbook");
        await club.AddDoorAsync(factory, "gate-me0004", "front-door");

        var startsAt = DateTimeOffset.UtcNow.AddMinutes(20);
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            db.Bookings.Add(new Booking
            {
                TenantId = club.TenantId, CourtId = club.CourtId, UserId = club.MemberUserId,
                BookedByUserId = club.MemberUserId, PaidByUserId = club.MemberUserId,
                StartsAt = startsAt, EndsAt = startsAt.AddMinutes(30),
                SliceMinutes = 15, SliceCount = 2, Status = BookingStatus.Booked,
                AmountChargedCredits = 16m, ChargedAt = DateTimeOffset.UtcNow,
            });
            await db.SaveChangesAsync();
        }

        var body = await club.MemberClient(factory).GetFromJsonAsync<JsonElement>(DoorPath);
        var booking = body.GetProperty("next_booking");

        Assert.Equal(startsAt, booking.GetProperty("starts_at").GetDateTimeOffset(), TimeSpan.FromSeconds(1));
        Assert.True(booking.GetProperty("door_opens_at").GetDateTimeOffset() < startsAt);
        Assert.True(booking.GetProperty("door_closes_at").GetDateTimeOffset() > startsAt);
    }

    [SkippableFact]
    public async Task The_club_contact_is_whatever_the_club_has_set_and_null_when_it_has_set_none()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var bare = await DoorClub.SeedAsync(factory, "medoorc1");
        await bare.AddDoorAsync(factory, "gate-me0005", "front-door");

        var empty = await bare.MemberClient(factory).GetFromJsonAsync<JsonElement>(DoorPath);
        Assert.Equal(JsonValueKind.Null, empty.GetProperty("contact").GetProperty("phone").ValueKind);
        Assert.Equal(JsonValueKind.Null, empty.GetProperty("contact").GetProperty("email").ValueKind);

        var set = await DoorClub.SeedAsync(
            factory, "medoorc2",
            """{"timezone":"UTC","grace_window_minutes":5,"club_contact_phone":"+27 21 555 0100","club_contact_email":"desk@club.test"}""");
        await set.AddDoorAsync(factory, "gate-me0006", "front-door");

        var filled = await set.MemberClient(factory).GetFromJsonAsync<JsonElement>(DoorPath);
        Assert.Equal("+27 21 555 0100", filled.GetProperty("contact").GetProperty("phone").GetString());
        Assert.Equal("desk@club.test", filled.GetProperty("contact").GetProperty("email").GetString());
    }

    [SkippableFact]
    public async Task The_last_decision_is_this_members_newest_row_inside_the_fetch_window()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "medoorlast");
        var doorId = await club.AddDoorAsync(factory, "gate-me0007", "front-door");
        var now = DateTimeOffset.UtcNow;

        await club.WriteRowAsync(
            factory, doorId, $"{DeviceGateEndpoint.DeniedActionPrefix}too_early", now.AddSeconds(-60),
            subjectUserId: club.MemberUserId, reason: "too_early", gateKey: "front-door");
        await club.WriteRowAsync(
            factory, doorId, DeviceGateEndpoint.OpenedAction, now.AddSeconds(-90),
            subjectUserId: club.MemberUserId, reason: "ok", gateKey: "front-door");

        var body = await club.MemberClient(factory).GetFromJsonAsync<JsonElement>(DoorPath);
        var decision = body.GetProperty("last_decision");

        Assert.Equal("too_early", decision.GetProperty("reason").GetString());
        Assert.False(decision.GetProperty("released").GetBoolean());
        Assert.Equal("front-door", decision.GetProperty("door_name").GetString());
        Assert.False(decision.GetProperty("offline").GetBoolean());
    }

    /// <summary>
    /// Two minutes is a FETCH window (A3.2). Older than that and there is nothing to fetch —
    /// which is not an error and never the sentence "no refusals found".
    /// </summary>
    [SkippableFact]
    public async Task A_decision_older_than_the_fetch_window_is_not_returned()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "medooreold");
        var doorId = await club.AddDoorAsync(factory, "gate-me0008", "front-door");

        await club.WriteRowAsync(
            factory, doorId, DeviceGateEndpoint.OpenedAction,
            DateTimeOffset.UtcNow.AddSeconds(-(MeDoorEndpoints.LastDecisionWindowSeconds + 30)),
            subjectUserId: club.MemberUserId, reason: "ok");

        var body = await club.MemberClient(factory).GetFromJsonAsync<JsonElement>(DoorPath);
        Assert.Equal(JsonValueKind.Null, body.GetProperty("last_decision").ValueKind);
    }

    /// <summary>An open the board decided from its cache is this member's decision too, flagged.</summary>
    [SkippableFact]
    public async Task An_offline_open_is_this_members_decision_and_says_it_was_offline()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "medooroff");
        var doorId = await club.AddDoorAsync(factory, "gate-me0009", "side-door");

        await club.WriteRowAsync(
            factory, doorId, DoorTrail.OfflineOpenAction, DateTimeOffset.UtcNow.AddSeconds(-30),
            subjectUserId: club.MemberUserId, seq: 4, gateKey: "side-door");

        var decision = (await club.MemberClient(factory).GetFromJsonAsync<JsonElement>(DoorPath))
            .GetProperty("last_decision");

        Assert.True(decision.GetProperty("released").GetBoolean());
        Assert.True(decision.GetProperty("offline").GetBoolean());
    }

    /// <summary>The isolation no tenant filter can provide.</summary>
    [SkippableFact]
    public async Task Another_members_decision_at_this_club_is_never_this_members()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "medoorxmem");
        var doorId = await club.AddDoorAsync(factory, "gate-me0010", "front-door");
        var now = DateTimeOffset.UtcNow;

        // The admin was refused ten seconds ago; the member an hour ago. Same club, same door.
        await club.WriteRowAsync(
            factory, doorId, $"{DeviceGateEndpoint.DeniedActionPrefix}member_not_active", now.AddSeconds(-10),
            subjectUserId: club.AdminUserId, reason: "member_not_active");
        await club.WriteRowAsync(
            factory, doorId, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-60),
            subjectUserId: club.MemberUserId, reason: "ok");

        var body = await club.MemberClient(factory).GetFromJsonAsync<JsonElement>(DoorPath);
        Assert.Equal(JsonValueKind.Null, body.GetProperty("last_decision").ValueKind);

        var history = await club.MemberClient(factory).GetFromJsonAsync<JsonElement>(HistoryPath);
        Assert.Single(Items(history));
        Assert.Equal("ok", Items(history).Single().GetProperty("reason").GetString());
    }

    /// <summary>A row with no subject names nobody and can never be anybody's.</summary>
    [SkippableFact]
    public async Task An_unknown_scan_that_names_nobody_is_nobodys_history()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "medoorunk");
        var doorId = await club.AddDoorAsync(factory, "gate-me0011", "front-door");

        await club.WriteRowAsync(
            factory, doorId, DoorTrail.OfflineUnknownScanAction, DateTimeOffset.UtcNow.AddSeconds(-20),
            subjectUserId: null, fingerprint: "1f4c9ab2", seq: 5);

        var body = await club.MemberClient(factory).GetFromJsonAsync<JsonElement>(DoorPath);
        Assert.Equal(JsonValueKind.Null, body.GetProperty("last_decision").ValueKind);
        Assert.Empty(Items(await club.MemberClient(factory).GetFromJsonAsync<JsonElement>(HistoryPath)));
    }

    // ---- W1.8, the history ----

    [SkippableFact]
    public async Task The_history_is_this_members_own_rows_newest_first_with_the_retention_number()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "medoorhist");
        var doorId = await club.AddDoorAsync(factory, "gate-me0012", "front-door", name: "Front door");
        var now = DateTimeOffset.UtcNow;

        for (var i = 0; i < 3; i++)
        {
            await club.WriteRowAsync(
                factory, doorId, DeviceGateEndpoint.OpenedAction, now.AddHours(-(i + 1)),
                subjectUserId: club.MemberUserId, reason: "ok", gateKey: "front-door");
        }

        var body = await club.MemberClient(factory).GetFromJsonAsync<JsonElement>(HistoryPath);
        var items = Items(body);

        Assert.Equal(3, items.Count);
        Assert.True(items[0].GetProperty("at").GetDateTimeOffset() > items[2].GetProperty("at").GetDateTimeOffset());
        Assert.Equal("front-door", items[0].GetProperty("door_name").GetString());
        Assert.True(items[0].GetProperty("released").GetBoolean());
        Assert.Equal(DoorSettings.DefaultLogRetentionDays, body.GetProperty("retention_days").GetInt32());
    }

    /// <summary>
    /// A member's own history reaches exactly as far back as the club keeps door rows, and no
    /// further — the page states the number, so answering past it would make that line false.
    /// </summary>
    [SkippableFact]
    public async Task The_history_stops_at_the_clubs_retention()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(
            factory, "medoorretn",
            """{"timezone":"UTC","grace_window_minutes":5,"door_log_retention_days":7}""");
        var doorId = await club.AddDoorAsync(factory, "gate-me0013", "front-door");
        var now = DateTimeOffset.UtcNow;

        await club.WriteRowAsync(
            factory, doorId, DeviceGateEndpoint.OpenedAction, now.AddDays(-3), subjectUserId: club.MemberUserId);
        await club.WriteRowAsync(
            factory, doorId, DeviceGateEndpoint.OpenedAction, now.AddDays(-9), subjectUserId: club.MemberUserId);

        var body = await club.MemberClient(factory).GetFromJsonAsync<JsonElement>(HistoryPath);
        Assert.Single(Items(body));
        Assert.Equal(7, body.GetProperty("retention_days").GetInt32());
    }

    [SkippableFact]
    public async Task The_history_cursor_walks_the_whole_range_once()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "medoorpage");
        var doorId = await club.AddDoorAsync(factory, "gate-me0014", "front-door");
        var now = DateTimeOffset.UtcNow;

        for (var i = 0; i < 5; i++)
        {
            await club.WriteRowAsync(
                factory, doorId, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-(i + 1)),
                subjectUserId: club.MemberUserId);
        }

        var client = club.MemberClient(factory);
        var seen = new List<DateTimeOffset>();
        string? cursor = null;
        var pages = 0;

        do
        {
            var url = $"{HistoryPath}?limit=2" + (cursor is null ? "" : $"&cursor={Uri.EscapeDataString(cursor)}");
            var body = await client.GetFromJsonAsync<JsonElement>(url);
            seen.AddRange(Items(body).Select(i => i.GetProperty("at").GetDateTimeOffset()));
            cursor = body.GetProperty("next_cursor").ValueKind == JsonValueKind.Null
                ? null
                : body.GetProperty("next_cursor").GetString();
            pages++;
        }
        while (cursor is not null && pages < 10);

        Assert.Equal(5, seen.Count);
        Assert.Equal(seen.Count, seen.Distinct().Count());
    }

    [SkippableFact]
    public async Task Another_clubs_rows_never_reach_this_members_history()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var mine = await DoorClub.SeedAsync(factory, "medoormine");
        var theirs = await DoorClub.SeedAsync(factory, "medoortheirs");
        var myDoor = await mine.AddDoorAsync(factory, "gate-me0015", "mine");
        var now = DateTimeOffset.UtcNow;

        // Another club's row naming MY member id, at MY door id. Both are guids the other club
        // could hold; only the tenant filter stands between them.
        await theirs.WriteRowAsync(
            factory, myDoor, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-1), subjectUserId: mine.MemberUserId);

        var body = await mine.MemberClient(factory).GetFromJsonAsync<JsonElement>(HistoryPath);
        Assert.Empty(Items(body));

        var door = await mine.MemberClient(factory).GetFromJsonAsync<JsonElement>(DoorPath);
        Assert.Equal(JsonValueKind.Null, door.GetProperty("last_decision").ValueKind);
    }

    /// <summary>
    /// A member's own history is not the club's log: no fingerprint, no member block, no device
    /// id, no MAC, no raw details.
    /// </summary>
    [SkippableFact]
    public async Task The_member_surface_carries_nothing_of_the_trails_own_shape()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "medoorlean");
        var doorId = await club.AddDoorAsync(factory, "gate-me0016", "front-door");

        await club.WriteRowAsync(
            factory, doorId, DoorTrail.OfflineOpenAction, DateTimeOffset.UtcNow.AddSeconds(-20),
            subjectUserId: club.MemberUserId, fingerprint: "1f4c9ab2", seq: 6, deviceCode: "gate-me0016");

        var client = club.MemberClient(factory);
        var history = (await (await client.GetAsync(HistoryPath)).Content.ReadAsStringAsync());
        var door = (await (await client.GetAsync(DoorPath)).Content.ReadAsStringAsync());

        foreach (var text in new[] { history, door })
        {
            Assert.DoesNotContain("1f4c9ab2", text, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain(doorId.ToString(), text, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("gate-me0016", text, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("fingerprint", text, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("device_id", text, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("mac", text, StringComparison.OrdinalIgnoreCase);
        }
    }

    [SkippableFact]
    public async Task Both_routes_need_a_session()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        await DoorClub.SeedAsync(factory, "medoorauth");
        var anonymous = factory.CreateClient();

        // Compared against an EXISTING member route rather than a literal status. A request
        // with no token never reaches the authorization filter here — TenantResolutionMiddleware
        // refuses it first, because it cannot tell which club is being asked — and asserting
        // the literal would be pinning that middleware's answer from this file. What this route
        // has to be is no more open than /me/profile, and that is what is asserted.
        var reference = (await anonymous.GetAsync("/api/v1/me/profile")).StatusCode;
        Assert.NotEqual(HttpStatusCode.OK, reference);
        Assert.Equal(reference, (await anonymous.GetAsync(DoorPath)).StatusCode);
        Assert.Equal(reference, (await anonymous.GetAsync(HistoryPath)).StatusCode);

        // And with a real session from another club's member, this club's rows stay theirs —
        // the token carries the tenant, so there is no anonymous path to a door row at all.
    }
}
