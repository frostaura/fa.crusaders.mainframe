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
public sealed class MeDoorHttpTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public MeDoorHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string DoorPath = "/api/v1/me/door";
    private const string HistoryPath = "/api/v1/me/door/history";

    private TestWebAppFactory CreateFactory() => _pg.SharedHost;

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
    public async Task A_club_whose_only_door_is_out_of_service_still_HAS_a_door_and_says_it_is_shut()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "medoorshut");
        await club.AddDoorAsync(factory, "gate-me0001", "front-door", enabled: false);

        var body = await club.MemberClient(factory).GetFromJsonAsync<JsonElement>(DoorPath);

        // E-H1 / B4 reverse round one's reading. `doors: false` used to mean BOTH "this club
        // has no scanners" and "every scanner is switched off", so a club that shut its doors
        // for the night handed its members the page a club with no doors at all gets: no door
        // section, no history link, and nothing said about why the building would not let them
        // in. The two facts are separate now.
        Assert.True(body.GetProperty("doors").GetBoolean());
        Assert.Equal(MeDoorEndpoints.ShutAll, body.GetProperty("doors_shut").GetString());
    }

    /// <summary>A club with no gate row at all — the case <c>doors: false</c> is now only for.</summary>
    [SkippableFact]
    public async Task A_club_with_no_gate_row_at_all_has_no_doors_and_nothing_shut()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "medoornone");

        var body = await club.MemberClient(factory).GetFromJsonAsync<JsonElement>(DoorPath);

        Assert.False(body.GetProperty("doors").GetBoolean());

        // "all of nothing" is true and is not a sentence anybody should be shown.
        Assert.Equal(MeDoorEndpoints.ShutNone, body.GetProperty("doors_shut").GetString());
    }

    /// <summary>
    /// One of two shut is <c>some</c>, so the page can say "the club has shut N of its doors"
    /// rather than either of the two absolutes (B4).
    /// </summary>
    [SkippableFact]
    public async Task One_door_shut_out_of_two_is_some_and_not_all()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "medoorsome");
        await club.AddDoorAsync(factory, "gate-me0021", "front-door");
        await club.AddDoorAsync(factory, "gate-me0022", "side-door", enabled: false);

        var body = await club.MemberClient(factory).GetFromJsonAsync<JsonElement>(DoorPath);

        Assert.True(body.GetProperty("doors").GetBoolean());
        Assert.Equal(MeDoorEndpoints.ShutSome, body.GetProperty("doors_shut").GetString());
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
                AmountChargedMinutes = 16, ChargedAt = DateTimeOffset.UtcNow,
            });
            await db.SaveChangesAsync();
        }

        var body = await club.MemberClient(factory).GetFromJsonAsync<JsonElement>(DoorPath);
        var booking = body.GetProperty("next_booking");

        Assert.Equal(startsAt, booking.GetProperty("starts_at").GetDateTimeOffset(), TimeSpan.FromSeconds(1));
        Assert.True(booking.GetProperty("door_opens_at").GetDateTimeOffset() < startsAt);
        Assert.True(booking.GetProperty("door_closes_at").GetDateTimeOffset() > startsAt);
    }

    /// <summary>
    /// <b>A booking beyond the door's own horizon is still the member's next booking</b>
    /// (Lerato's LOW).
    ///
    /// <para>
    /// It answered null for anything further off than the window the door honours, so a member
    /// with a court tomorrow was told nothing at all about when the door would open for it — on
    /// the page whose whole job is to explain that window, and while the same page's self-check
    /// was telling her there was "no window to wait for". The bound that remains is about the
    /// BOOKING, not about the door: a booking whose code has already expired is not the next one.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task The_next_booking_has_no_horizon_and_a_court_tomorrow_still_counts()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "medoorfar");
        await club.AddDoorAsync(factory, "gate-me0023", "front-door");

        // Well past DoorHorizonMinutes, whose ceiling is four hours.
        var startsAt = DateTimeOffset.UtcNow.AddHours(26);
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            db.Bookings.Add(new Booking
            {
                TenantId = club.TenantId, CourtId = club.CourtId, UserId = club.MemberUserId,
                BookedByUserId = club.MemberUserId, PaidByUserId = club.MemberUserId,
                StartsAt = startsAt, EndsAt = startsAt.AddMinutes(30),
                SliceMinutes = 15, SliceCount = 2, Status = BookingStatus.Booked,
                AmountChargedMinutes = 16, ChargedAt = DateTimeOffset.UtcNow,
            });
            await db.SaveChangesAsync();
        }

        var booking = (await club.MemberClient(factory).GetFromJsonAsync<JsonElement>(DoorPath))
            .GetProperty("next_booking");

        Assert.Equal(JsonValueKind.Object, booking.ValueKind);
        Assert.Equal(startsAt, booking.GetProperty("starts_at").GetDateTimeOffset(), TimeSpan.FromSeconds(1));

        // And the instants that answer "when will it let me in", which is the question.
        Assert.True(booking.GetProperty("door_opens_at").GetDateTimeOffset() < startsAt);
        Assert.True(booking.GetProperty("door_opens_at").GetDateTimeOffset() > DateTimeOffset.UtcNow);
    }

    /// <summary>
    /// The one bound that is still there: a booking whose window has closed is past, not next.
    /// </summary>
    [SkippableFact]
    public async Task A_booking_whose_window_has_already_closed_is_not_the_next_one()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "medoorpast");
        await club.AddDoorAsync(factory, "gate-me0024", "front-door");

        var startsAt = DateTimeOffset.UtcNow.AddHours(-4);
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            db.Bookings.Add(new Booking
            {
                TenantId = club.TenantId, CourtId = club.CourtId, UserId = club.MemberUserId,
                BookedByUserId = club.MemberUserId, PaidByUserId = club.MemberUserId,
                StartsAt = startsAt, EndsAt = startsAt.AddMinutes(30),
                SliceMinutes = 15, SliceCount = 2, Status = BookingStatus.Booked,
                AmountChargedMinutes = 16, ChargedAt = DateTimeOffset.UtcNow,
            });
            await db.SaveChangesAsync();
        }

        var body = await club.MemberClient(factory).GetFromJsonAsync<JsonElement>(DoorPath);
        Assert.Equal(JsonValueKind.Null, body.GetProperty("next_booking").ValueKind);
    }

    /// <summary>
    /// O1: the club's zone on <c>/me/door</c> too, so one formatter can render every clock in
    /// this product in the zone the clock belongs to. The member's formatter used the VIEWER's
    /// zone always, which is the wrong one for a member abroad or with a wrong phone clock.
    /// </summary>
    [SkippableFact]
    public async Task The_member_is_told_which_clock_the_clubs_times_are_in()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(
            factory, "medoortz",
            """{"timezone":"Africa/Johannesburg","grace_window_minutes":5}""");
        await club.AddDoorAsync(factory, "gate-me0025", "front-door");

        var client = club.MemberClient(factory);
        Assert.Equal(
            "Africa/Johannesburg",
            (await client.GetFromJsonAsync<JsonElement>(DoorPath)).GetProperty("timezone").GetString());
        Assert.Equal(
            "Africa/Johannesburg",
            (await client.GetFromJsonAsync<JsonElement>(HistoryPath)).GetProperty("timezone").GetString());
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

    /// <summary>
    /// The domain's own status set, lowered — not an invented one. There is no <c>expired</c>
    /// because nothing in this product can produce one.
    /// </summary>
    [SkippableTheory]
    [InlineData(MembershipStatus.Active, "active")]
    [InlineData(MembershipStatus.PendingApproval, "pending_approval")]
    [InlineData(MembershipStatus.Suspended, "suspended")]
    [InlineData(MembershipStatus.Rejected, "rejected")]
    public async Task The_membership_detail_is_the_clubs_own_recorded_status(
        MembershipStatus status, string expected)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, $"medoordet-{(int)status}");
        await club.AddDoorAsync(factory, $"gate-{Guid.NewGuid():N}"[..14], "front-door");

        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var membership = await db.Memberships.IgnoreQueryFilters().FirstAsync(m => m.UserId == club.MemberUserId);
            membership.Status = status;
            await db.SaveChangesAsync();
        }

        var body = await club.MemberClient(factory).GetFromJsonAsync<JsonElement>(DoorPath);

        Assert.Equal(expected, body.GetProperty("membership_detail").GetString());

        // The flat field stays, and stays coarser — the page branches on one and explains with
        // the other.
        Assert.Equal(
            status == MembershipStatus.Active ? "active" : "not_active",
            body.GetProperty("membership").GetString());
    }

    [SkippableFact]
    public async Task A_user_with_no_membership_row_is_none_in_both_fields()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "medoordetn");
        await club.AddDoorAsync(factory, "gate-me0017", "front-door");

        Guid strayId;
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var stray = new User
            {
                TenantId = club.TenantId, Email = $"{club.Slug}-stray2@test.local",
                PasswordHash = "x", EmailVerified = true,
            };
            db.Users.Add(stray);
            await db.SaveChangesAsync();
            strayId = stray.Id;
        }

        var body = await club.ClientFor(factory, strayId, null).GetFromJsonAsync<JsonElement>(DoorPath);
        Assert.Equal("none", body.GetProperty("membership").GetString());
        Assert.Equal("none", body.GetProperty("membership_detail").GetString());
    }

    /// <summary>
    /// The clamped value the door itself reads, never re-derived. A club with an absurd stored
    /// entry window is shown the number the door will honour, not the number in its column.
    /// </summary>
    [SkippableFact]
    public async Task The_early_entry_minutes_are_the_clamped_value_the_door_uses()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        // E-H3: the number is on the wire ONLY under booking_window, which is the one policy
        // it is the door's window under. Both clubs here run it explicitly.
        var normal = await DoorClub.SeedAsync(
            factory, "medoorent",
            """{"timezone":"UTC","grace_window_minutes":5,"gate_early_entry_minutes":45,"gate_access_policy":"booking_window"}""");
        await normal.AddDoorAsync(factory, "gate-me0018", "front-door");

        var body = await normal.MemberClient(factory).GetFromJsonAsync<JsonElement>(DoorPath);
        Assert.Equal(45, body.GetProperty("early_entry_minutes").GetInt32());

        var handEdited = await DoorClub.SeedAsync(
            factory, "medoorentx",
            """{"timezone":"UTC","grace_window_minutes":5,"gate_early_entry_minutes":99999,"gate_access_policy":"booking_window"}""");
        await handEdited.AddDoorAsync(factory, "gate-me0019", "front-door");

        var clamped = await handEdited.MemberClient(factory).GetFromJsonAsync<JsonElement>(DoorPath);
        Assert.Equal(GateAccess.MaxEarlyEntryMinutes, clamped.GetProperty("early_entry_minutes").GetInt32());
    }

    /// <summary>
    /// E-H3: under <c>active_member</c> the number is <b>null</b>, because it is not the window
    /// the door runs.
    ///
    /// <para>
    /// Lerato held a booking code for tomorrow's court and was refused <c>too_early</c>
    /// seventeen times while her page carried <c>early_entry_minutes: 30</c> and the door had
    /// in fact been working to <c>StartsAt − 130 minutes</c> — the roster reach plus the
    /// activation cue, which is what <c>DoorHorizonMinutes</c> answers under this policy. Two
    /// numbers belonging to two different rules, and the page was printing the one that was not
    /// in force.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task The_early_entry_minutes_are_null_under_the_policy_they_are_not_the_window_for()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(
            factory, "medoorentn",
            """{"timezone":"UTC","grace_window_minutes":5,"gate_early_entry_minutes":30,"gate_access_policy":"active_member"}""");
        await club.AddDoorAsync(factory, "gate-me0020", "front-door");

        var body = await club.MemberClient(factory).GetFromJsonAsync<JsonElement>(DoorPath);

        Assert.Equal("active_member", body.GetProperty("policy").GetString());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("early_entry_minutes").ValueKind);
    }

    /// <summary>
    /// A <c>too_early</c> refusal is the one a person can wait out, so it is the one that gets
    /// an instant — computed through the function the door decides with, never by the page.
    /// </summary>
    [SkippableFact]
    public async Task A_too_early_refusal_carries_the_instant_the_door_would_open()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(
            factory, "medoorearly",
            """{"timezone":"UTC","grace_window_minutes":5,"gate_early_entry_minutes":30,"roster_window_minutes":5,"activation_cue_window_minutes":0}""");
        var doorId = await club.AddDoorAsync(factory, "gate-me0020", "front-door");

        // Well outside the club's 30-minute entry window, so the door would refuse it today.
        var startsAt = DateTimeOffset.UtcNow.AddHours(5);
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            db.Bookings.Add(new Booking
            {
                TenantId = club.TenantId, CourtId = club.CourtId, UserId = club.MemberUserId,
                BookedByUserId = club.MemberUserId, PaidByUserId = club.MemberUserId,
                StartsAt = startsAt, EndsAt = startsAt.AddMinutes(30),
                SliceMinutes = 15, SliceCount = 2, Status = BookingStatus.Booked,
                AmountChargedMinutes = 16, ChargedAt = DateTimeOffset.UtcNow,
            });
            await db.SaveChangesAsync();
        }

        await club.WriteRowAsync(
            factory, doorId, $"{DeviceGateEndpoint.DeniedActionPrefix}too_early",
            DateTimeOffset.UtcNow.AddSeconds(-10), subjectUserId: club.MemberUserId, reason: "too_early",
            gateKey: "front-door");

        var decision = (await club.MemberClient(factory).GetFromJsonAsync<JsonElement>(DoorPath))
            .GetProperty("last_decision");

        Assert.Equal("too_early", decision.GetProperty("reason").GetString());
        Assert.Equal(
            startsAt.AddMinutes(-30),
            decision.GetProperty("opens_at").GetDateTimeOffset(),
            TimeSpan.FromSeconds(1));
    }

    /// <summary>
    /// Every other refusal is about the credential or the membership and is not a matter of
    /// waiting, so there is nothing to count down to and the field is null.
    /// </summary>
    [SkippableTheory]
    [InlineData("not_recognised")]
    [InlineData("member_not_active")]
    [InlineData("no_booking")]
    public async Task A_refusal_that_is_not_about_time_carries_no_instant(string reason)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(
            factory, $"medoornoc-{reason.Length}",
            """{"timezone":"UTC","grace_window_minutes":5,"gate_early_entry_minutes":30,"roster_window_minutes":5,"activation_cue_window_minutes":0}""");
        var doorId = await club.AddDoorAsync(factory, $"gate-{Guid.NewGuid():N}"[..14], "front-door");

        // The member DOES hold a future booking, so there is an instant available — and the
        // point of the test is that this reason does not get one.
        //
        // Without the booking a mutant that dropped the too_early guard entirely survived:
        // opens_at came back null either way, because there was nothing to compute. Vary the
        // fixture, not just the code (memory/decisions-method.md).
        var startsAt = DateTimeOffset.UtcNow.AddHours(5);
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            db.Bookings.Add(new Booking
            {
                TenantId = club.TenantId, CourtId = club.CourtId, UserId = club.MemberUserId,
                BookedByUserId = club.MemberUserId, PaidByUserId = club.MemberUserId,
                StartsAt = startsAt, EndsAt = startsAt.AddMinutes(30),
                SliceMinutes = 15, SliceCount = 2, Status = BookingStatus.Booked,
                AmountChargedMinutes = 16, ChargedAt = DateTimeOffset.UtcNow,
            });
            await db.SaveChangesAsync();
        }

        await club.WriteRowAsync(
            factory, doorId, $"{DeviceGateEndpoint.DeniedActionPrefix}{reason}",
            DateTimeOffset.UtcNow.AddSeconds(-10), subjectUserId: club.MemberUserId, reason: reason);

        var decision = (await club.MemberClient(factory).GetFromJsonAsync<JsonElement>(DoorPath))
            .GetProperty("last_decision");

        Assert.Equal(reason, decision.GetProperty("reason").GetString());
        Assert.Equal(JsonValueKind.Null, decision.GetProperty("opens_at").ValueKind);
    }

    /// <summary>A too_early refusal with no booking behind it has no instant to offer, and says so.</summary>
    [SkippableFact]
    public async Task A_too_early_refusal_with_no_booking_behind_it_carries_no_instant()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "medoorearn");
        var doorId = await club.AddDoorAsync(factory, "gate-me0021", "front-door");

        await club.WriteRowAsync(
            factory, doorId, $"{DeviceGateEndpoint.DeniedActionPrefix}too_early",
            DateTimeOffset.UtcNow.AddSeconds(-10), subjectUserId: club.MemberUserId, reason: "too_early");

        var decision = (await club.MemberClient(factory).GetFromJsonAsync<JsonElement>(DoorPath))
            .GetProperty("last_decision");

        Assert.Equal(JsonValueKind.Null, decision.GetProperty("opens_at").ValueKind);
    }

    /// <summary>
    /// <c>is_club_admin</c> is not decoration: under <c>booking_window</c> it is the difference
    /// between a page that says "you need a booking" and a door that opens anyway. Driven
    /// against the REAL decision at the real device route, because a flag that disagreed with
    /// the door would be the product contradicting the building.
    /// </summary>
    [SkippableFact]
    public async Task The_admin_flag_agrees_with_what_the_door_really_does_under_booking_window()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(
            factory, "medooradm",
            """{"timezone":"UTC","grace_window_minutes":5,"gate_access_policy":"booking_window"}""");

        // A board that registered itself, so the MAC on the wire is the MAC on the row.
        var mac = Guid.NewGuid().ToString("N")[..12];
        var device = factory.CreateClient();
        device.DefaultRequestHeaders.Authorization =
            new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", club.DeviceKey);
        await device.PostAsync(
            "/api/v1/device/heartbeat",
            new StringContent(
                $$"""{"mac":"{{mac}}","firmware_version":"1.0.0","uptime_ms":60000,"kind":"gate"}""",
                System.Text.Encoding.UTF8, "application/json"));

        async Task<(bool Flag, bool Opened)> AskAsync(Guid userId, string? role)
        {
            var person = club.ClientFor(factory, userId, role);
            var flag = (await person.GetFromJsonAsync<JsonElement>(DoorPath))
                .GetProperty("is_club_admin").GetBoolean();

            var minted = await (await person.PostAsync("/api/v1/me/qr/generate?kind=ident", null))
                .Content.ReadFromJsonAsync<JsonElement>();
            var token = minted.GetProperty("code").GetString();

            var scanned = await (await device.PostAsync(
                "/api/v1/device/gate",
                new StringContent(
                    $$"""{"mac":"{{mac}}","method":"qr","token":"{{token}}"}""",
                    System.Text.Encoding.UTF8, "application/json")))
                .Content.ReadFromJsonAsync<JsonElement>();

            return (flag, scanned.GetProperty("opened").GetBoolean());
        }

        // Neither of them holds a booking. Under booking_window the admin passes and the member
        // does not, and the flag has to say exactly that.
        var admin = await AskAsync(club.AdminUserId, "admin");
        Assert.True(admin.Flag);
        Assert.True(admin.Opened);

        var member = await AskAsync(club.MemberUserId, null);
        Assert.False(member.Flag);
        Assert.False(member.Opened);
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
        // The board's DISPLAY name, not the key — A12's reversal of round one's choice. A
        // member reading "front-door" while the admin log says "Front door" for the same scan
        // is one product calling one door two things.
        Assert.Equal("Front door", items[0].GetProperty("door_name").GetString());
        Assert.True(items[0].GetProperty("released").GetBoolean());
        Assert.Equal(DoorSettings.DefaultLogRetentionDays, body.GetProperty("retention_days").GetInt32());

        // O1: the list says which clock it is in, once, rather than rendering in whatever zone
        // the viewer's phone is set to.
        Assert.Equal("UTC", body.GetProperty("timezone").GetString());
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
