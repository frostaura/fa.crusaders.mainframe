using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// GOAL item 6 — one member's night, and the six privacy controls that make it defensible.
///
/// <para>
/// <b>Every test here skips cleanly until <c>Program.cs</c> carries
/// <c>app.MapAdminMemberTraceEndpoints();</c></b>, and the skip is decided by asking the
/// application's own routing table rather than by reading a 404 — a 404 is also the correct
/// answer to two real questions on this surface (switched off, and nobody by that id), so a test
/// that treated one as "not wired yet" would go permanently green the day somebody broke the
/// member lookup.
/// </para>
/// </summary>
public sealed class AdminMemberTraceHttpTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public AdminMemberTraceHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string Unwired = "The trace route is not registered — Program.cs needs app.MapAdminMemberTraceEndpoints().";

    /// <summary>
    /// A club on the southern hemisphere's DST, whose clocks move in September — the fixture
    /// <c>memory/decisions-method.md</c> asks for, and the one that catches a day computed at
    /// <i>now</i>'s offset instead of at midnight's own.
    /// </summary>
    private const string Santiago =
        """{"slice_minutes":15,"day_start_minute":0,"day_end_minute":1440,"grace_window_minutes":5,"timezone":"America/Santiago","heartbeat_seconds":45}""";

    /// <summary>A club west of UTC, where a club day and a UTC day are never the same window.</summary>
    private const string Chicago =
        """{"slice_minutes":15,"day_start_minute":0,"day_end_minute":1440,"grace_window_minutes":5,"timezone":"America/Chicago","heartbeat_seconds":45}""";

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    private static string Trace(Guid userId) => $"/api/v1/admin/members/{userId}/trace";

    private static string TraceCsv(Guid userId) => $"/api/v1/admin/members/{userId}/trace.csv";

    private static List<JsonElement> Events(JsonElement body)
        => body.GetProperty("events").EnumerateArray().ToList();

    /// <summary>
    /// Whether this application has the trace route at all, asked of its own endpoint table.
    ///
    /// <para>
    /// The <c>Map</c> extension lives in this lane; the one line that calls it lives in
    /// <c>Program.cs</c>, which this lane does not own. Rather than leave a suite that fails for
    /// a reason it is not about, the tests ask routing and skip — and say in the skip message
    /// exactly which line is missing.
    /// </para>
    /// </summary>
    private static bool Wired(TestWebAppFactory factory)
    {
        _ = factory.CreateClient();
        return factory.Services.GetServices<EndpointDataSource>()
            .SelectMany(s => s.Endpoints)
            .OfType<RouteEndpoint>()
            .Any(e => e.RoutePattern.RawText?.EndsWith("/trace", StringComparison.Ordinal) == true);
    }

    // ------------------------------------------------------------------ fixture helpers

    /// <summary>
    /// One <c>audit_log</c> row exactly as a live path writes it. Written here rather than in
    /// <c>DoorClub</c> because <c>DoorClub</c> writes DOOR rows and this suite needs the booking,
    /// court and settlement shapes beside them.
    /// </summary>
    private static async Task AuditAsync(
        TestWebAppFactory factory, DoorClub club, string action, DateTimeOffset at,
        Guid actorUserId, Guid? subjectUserId, object? details = null)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        db.AuditLogs.Add(new AuditLog
        {
            TenantId = club.TenantId,
            ActorUserId = actorUserId,
            SubjectUserId = subjectUserId,
            Action = action,
            DetailsJson = details is null ? null : JsonSerializer.Serialize(details),

            // .ToUniversalTime() for the reason DoorClub gives: Npgsql refuses to write a
            // DateTimeOffset carrying a non-zero offset to a `timestamp with time zone`, and a
            // club-local instant is the only way to test a club-local day boundary at all.
            CreatedAt = at.ToUniversalTime(),
        });
        await db.SaveChangesAsync();
    }

    /// <summary>One ledger movement, written straight in so its actor and instant are the test's.</summary>
    private static async Task LedgerAsync(
        TestWebAppFactory factory, DoorClub club, Guid userId, LedgerEntryType type,
        decimal amount, DateTimeOffset at, Guid actorUserId, Guid? bookingId = null, string? reason = null)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        db.LedgerEntries.Add(new LedgerEntry
        {
            TenantId = club.TenantId,
            UserId = userId,
            Type = type,
            AmountCredits = amount,
            ActorUserId = actorUserId,
            RelatedBookingId = bookingId,
            Reason = reason,
            CreatedAt = at.ToUniversalTime(),
        });
        await db.SaveChangesAsync();
    }

    /// <summary>A booked slot, so a ledger row and a receipt have a court to point at.</summary>
    private static async Task<Guid> BookingAsync(
        TestWebAppFactory factory, DoorClub club, Guid userId, DateTimeOffset startsAt, int slices = 2)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var booking = new Booking
        {
            TenantId = club.TenantId,
            CourtId = club.CourtId,
            UserId = userId,
            ActorUserId = userId,
            StartsAt = startsAt.ToUniversalTime(),
            EndsAt = startsAt.AddMinutes(15 * slices).ToUniversalTime(),
            SliceMinutes = 15,
            SliceCount = slices,
            AmountChargedCredits = 16m,
        };
        db.Bookings.Add(booking);
        await db.SaveChangesAsync();
        return booking.Id;
    }

    /// <summary>One board receipt — the only MEASUREMENT this product has of what the lights did.</summary>
    private static async Task ReceiptAsync(
        TestWebAppFactory factory, DoorClub club, Guid deviceId, Guid bookingId,
        string kind, DateTimeOffset at, long seq)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        db.DeviceEventReceipts.Add(new DeviceEventReceipt
        {
            TenantId = club.TenantId,
            DeviceId = deviceId,
            BootId = 1,
            Seq = seq,
            Kind = kind,
            OccurredAt = at.ToUniversalTime(),
            Court = 0,
            BookingId = bookingId,
        });
        await db.SaveChangesAsync();
    }

    /// <summary>This club's <c>member.trace_viewed</c> rows — the privacy record, as a test reads it.</summary>
    private static async Task<List<AdminChangeLog>> ViewsAsync(TestWebAppFactory factory, DoorClub club)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.AdminChangeLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == club.TenantId && a.Action == AdminChangeActions.MemberTraceViewed)
            .ToListAsync();
    }

    // ------------------------------------------------------------------ the night

    /// <summary>
    /// A night reads FORWARDS, with the summary the page's caption is built from.
    /// </summary>
    [SkippableFact]
    public async Task A_night_reads_forwards_and_adds_itself_up()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        Skip.IfNot(Wired(factory), Unwired);

        var club = await DoorClub.SeedAsync(factory, "trnight");
        var doorId = await club.AddDoorAsync(factory, "gate-tr00001", "side-door", name: "Side Door");
        var now = DateTimeOffset.UtcNow;

        var booking = await BookingAsync(factory, club, club.MemberUserId, now.AddMinutes(-60));
        await AuditAsync(
            factory, club, "booking.created", now.AddMinutes(-120), club.MemberUserId, club.MemberUserId,
            new { booking_id = booking, court = "Court 1" });
        await club.WriteRowAsync(
            factory, doorId, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-70),
            subjectUserId: club.MemberUserId, gateKey: "side-door", doorName: "Side Door");
        await LedgerAsync(
            factory, club, club.MemberUserId, LedgerEntryType.BookingCharge, -16m,
            now.AddMinutes(-119), club.MemberUserId, booking);

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(Trace(club.MemberUserId));
        var events = Events(body);

        Assert.Equal(3, events.Count);
        Assert.Equal(3, body.GetProperty("total").GetInt32());

        // OLDEST FIRST. A night reads forwards; everything else in this product reads backwards.
        for (var i = 1; i < events.Count; i++)
        {
            Assert.True(
                events[i].GetProperty("at").GetDateTimeOffset()
                >= events[i - 1].GetProperty("at").GetDateTimeOffset(),
                "the trace is not oldest-first");
        }

        Assert.Equal(TraceKinds.BookingMade, events[0].GetProperty("kind").GetString());
        Assert.Equal(TraceKinds.WalletSpent, events[1].GetProperty("kind").GetString());
        Assert.Equal(TraceKinds.DoorOpened, events[2].GetProperty("kind").GetString());

        var summary = body.GetProperty("summary");
        Assert.Equal(1, summary.GetProperty("doors_entered").GetInt32());
        Assert.Equal(0, summary.GetProperty("doors_refused").GetInt32());
        Assert.Equal(1, summary.GetProperty("bookings_made").GetInt32());
        Assert.Equal(16m, summary.GetProperty("credits_spent").GetDecimal());

        // She was first SEEN at the door, not at the moment she booked from her sofa.
        Assert.Equal(
            events[2].GetProperty("at").GetDateTimeOffset(),
            summary.GetProperty("first_seen_at").GetDateTimeOffset());

        // The headline is composed on the SERVER and names the door.
        Assert.Contains("Side Door", events[2].GetProperty("headline").GetString()!);
    }

    /// <summary>
    /// A night with nothing in it is a <b>200 with zeros</b>, never a 404 and never an empty
    /// body. "Nobody was here that night" is an answer; "we could not look" is a different one.
    /// </summary>
    [SkippableFact]
    public async Task A_night_with_nothing_in_it_is_an_answer()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        Skip.IfNot(Wired(factory), Unwired);

        var club = await DoorClub.SeedAsync(factory, "trempty");

        var response = await club.AdminClient(factory).GetAsync(Trace(club.MemberUserId));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Empty(Events(body));
        Assert.Equal(0, body.GetProperty("total").GetInt32());
        Assert.Equal(0, body.GetProperty("summary").GetProperty("doors_entered").GetInt32());
        Assert.Equal("Door Member", body.GetProperty("member").GetProperty("name").GetString());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("summary").GetProperty("first_seen_at").ValueKind);
    }

    /// <summary>
    /// <b>D2-B41.</b> A system row must never claim an administrator did it. The no-show sweep
    /// posts with <see cref="Guid.Empty"/> as its actor, and a member disputing a penalty is
    /// entitled to a screen that says the club's automatic check did it — which is exactly the
    /// sentence <c>ActorUserId != SubjectUserId</c> cannot produce.
    /// </summary>
    [SkippableFact]
    public async Task A_system_penalty_never_claims_an_admin_did_it()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        Skip.IfNot(Wired(factory), Unwired);

        var club = await DoorClub.SeedAsync(factory, "trsys");
        await LedgerAsync(
            factory, club, club.MemberUserId, LedgerEntryType.NoShowPenalty, -9m,
            DateTimeOffset.UtcNow.AddMinutes(-30), Guid.Empty, reason: "No-show penalty");

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(Trace(club.MemberUserId));
        var actor = Events(body).Single().GetProperty("actor");

        Assert.Equal(TraceActors.System, actor.GetProperty("kind").GetString());
        Assert.False(actor.GetProperty("is_admin").GetBoolean());
        Assert.False(actor.GetProperty("is_self").GetBoolean());
        Assert.Equal(JsonValueKind.Null, actor.GetProperty("user_id").ValueKind);
        Assert.Contains("automatic", Events(body).Single().GetProperty("headline").GetString()!);
    }

    /// <summary>
    /// And an administrator who really did act IS named as one — read from <c>users.IsAdmin</c>,
    /// which is the whole point of the predicate.
    /// </summary>
    [SkippableFact]
    public async Task An_admin_who_acted_is_named_as_an_admin()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        Skip.IfNot(Wired(factory), Unwired);

        var club = await DoorClub.SeedAsync(factory, "tradmin");
        await AuditAsync(
            factory, club, "booking.cancelled", DateTimeOffset.UtcNow.AddMinutes(-20),
            club.AdminUserId, club.MemberUserId, new { court = "Court 1" });

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(Trace(club.MemberUserId));
        var row = Events(body).Single();
        var actor = row.GetProperty("actor");

        Assert.Equal(TraceActors.Admin, actor.GetProperty("kind").GetString());
        Assert.True(actor.GetProperty("is_admin").GetBoolean());
        Assert.False(actor.GetProperty("is_self").GetBoolean());
        Assert.Equal("Door Admin", actor.GetProperty("name").GetString());

        // Somebody else cancelled it, so the WORD is different too.
        Assert.Equal(TraceKinds.BookingCancelledByClub, row.GetProperty("kind").GetString());

        // And the same row on the ADMIN's own trace, because the query reads actor OR subject.
        var mine = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(Trace(club.AdminUserId));
        Assert.Equal(1, mine.GetProperty("total").GetInt32());
        Assert.True(Events(mine).Single().GetProperty("actor").GetProperty("is_self").GetBoolean());
    }

    /// <summary>
    /// <b>D2-B27 on this surface.</b> A court box's <c>unknown_scan</c> is classified as a door
    /// refusal by <see cref="DoorTrail"/>, and it must never appear under a door headline on
    /// somebody's night.
    /// </summary>
    [SkippableFact]
    public async Task A_court_boxs_scan_never_appears_under_a_door_headline()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        Skip.IfNot(Wired(factory), Unwired);

        var club = await DoorClub.SeedAsync(factory, "trbox");
        var boxId = await club.AddCourtBoxAsync(factory, "box-tr00002");
        await club.WriteRowAsync(
            factory, boxId, DoorTrail.OfflineUnknownScanAction, DateTimeOffset.UtcNow.AddMinutes(-10),
            subjectUserId: club.MemberUserId, deviceCode: "box-tr00002");

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(Trace(club.MemberUserId));

        Assert.Empty(Events(body));
        Assert.Equal(0, body.GetProperty("summary").GetProperty("doors_refused").GetInt32());
    }

    /// <summary>
    /// The lights strand, and the one number on this surface that is MEASURED rather than
    /// inferred.
    ///
    /// <para>
    /// <c>minutes_on_court</c> is the span between a booking's first and last receipt — what the
    /// relays did — and never the booking's own length, which is the club's INTENTION. This
    /// product's settlement model rests on those being different numbers, and a summary that
    /// quietly used the second would be reporting a court somebody paid for and never walked
    /// onto as forty-five minutes of play.
    /// </para>
    ///
    /// <para>
    /// The actor on a receipt row is the BOARD. A receipt names a device and a relay index and
    /// no person at all, so a row claiming the member switched the relay would be a guess — and
    /// on this surface a guess about who did something is the failure the whole design is built
    /// against.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task The_lights_strand_is_measured_and_the_board_is_its_actor()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        Skip.IfNot(Wired(factory), Unwired);

        var club = await DoorClub.SeedAsync(factory, "trlight");
        var boxId = await club.AddCourtBoxAsync(factory, "box-tr00004");
        var now = DateTimeOffset.UtcNow;

        // A booking of two slices — thirty minutes of INTENTION — whose relay ran for forty-five.
        var booking = await BookingAsync(factory, club, club.MemberUserId, now.AddMinutes(-90));
        await ReceiptAsync(factory, club, boxId, booking, "activation", now.AddMinutes(-88), seq: 1);
        await ReceiptAsync(factory, club, boxId, booking, "release", now.AddMinutes(-43), seq: 2);

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(Trace(club.MemberUserId));
        var events = Events(body);

        Assert.Equal(2, events.Count);
        Assert.Equal(TraceKinds.LightsOn, events[0].GetProperty("kind").GetString());
        Assert.Equal(TraceKinds.LightsOff, events[1].GetProperty("kind").GetString());
        Assert.All(events, e => Assert.Equal(TraceKinds.LightsStrand, e.GetProperty("strand").GetString()));

        // The board did it, and the wire says so rather than naming the member.
        Assert.All(events, e =>
        {
            var actor = e.GetProperty("actor");
            Assert.Equal(TraceActors.Device, actor.GetProperty("kind").GetString());
            Assert.False(actor.GetProperty("is_admin").GetBoolean());
            Assert.False(actor.GetProperty("is_self").GetBoolean());
        });

        // Both rows name the court the booking was on, resolved through the booking.
        Assert.All(events, e => Assert.Equal("Court 1", e.GetProperty("court").GetProperty("name").GetString()));

        var summary = body.GetProperty("summary");
        Assert.Equal(45, summary.GetProperty("minutes_on_court").GetInt32());
        Assert.Equal(["Court 1"], summary.GetProperty("courts").EnumerateArray().Select(c => c.GetString()).ToList());

        // And she was SEEN across the whole measured span, not merely at one end of it.
        Assert.Equal(
            events[0].GetProperty("at").GetDateTimeOffset(),
            summary.GetProperty("first_seen_at").GetDateTimeOffset());
        Assert.Equal(
            events[1].GetProperty("at").GetDateTimeOffset(),
            summary.GetProperty("last_seen_at").GetDateTimeOffset());
    }

    /// <summary>
    /// A relay that came on and has NOT been reported off contributes nothing to the measured
    /// total — a session this product cannot measure the length of, where guessing it is how a
    /// measurement becomes an estimate nobody labelled.
    /// </summary>
    [SkippableFact]
    public async Task An_unfinished_session_is_not_guessed_at()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        Skip.IfNot(Wired(factory), Unwired);

        var club = await DoorClub.SeedAsync(factory, "tropen");
        var boxId = await club.AddCourtBoxAsync(factory, "box-tr00005");
        var now = DateTimeOffset.UtcNow;

        var booking = await BookingAsync(factory, club, club.MemberUserId, now.AddMinutes(-40));
        await ReceiptAsync(factory, club, boxId, booking, "activation", now.AddMinutes(-38), seq: 1);

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(Trace(club.MemberUserId));

        Assert.Single(Events(body));
        Assert.Equal(0, body.GetProperty("summary").GetProperty("minutes_on_court").GetInt32());
    }

    // ------------------------------------------------------------------ privacy

    /// <summary>
    /// <b>Every view writes one row into the table nobody can delete from</b> — and two admins
    /// looking at once leave two.
    /// </summary>
    [SkippableFact]
    public async Task Every_view_leaves_a_row_in_the_undeletable_record()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        Skip.IfNot(Wired(factory), Unwired);

        var club = await DoorClub.SeedAsync(factory, "trlook");
        var second = await SecondAdminAsync(factory, club);

        var first = club.AdminClient(factory);
        var other = club.ClientFor(factory, second, "admin");

        // Concurrent, because two admins on one member is exactly when a club wants the record.
        await Task.WhenAll(
            first.GetAsync(Trace(club.MemberUserId)),
            other.GetAsync(Trace(club.MemberUserId)));

        var views = await ViewsAsync(factory, club);
        Assert.Equal(2, views.Count);
        Assert.Equal(
            new[] { club.AdminUserId, second }.Order().ToList(),
            views.Select(v => v.ActorUserId).Order().ToList());
        Assert.All(views, v => Assert.Equal(club.MemberUserId, v.SubjectId));
        Assert.All(views, v => Assert.Equal(AdminChangeAreas.Member, v.Area));

        // The row says what was looked at, not merely that something was.
        // Parsed, not grepped: the column is jsonb and Postgres re-serialises it with its own
        // spacing, so a substring assertion on the text is a test of Npgsql's formatting.
        Assert.All(views, v =>
        {
            var after = JsonSerializer.Deserialize<JsonElement>(v.AfterJson!);
            Assert.True(after.TryGetProperty("range", out _));
            Assert.True(after.TryGetProperty("event_count", out _));
        });
    }

    /// <summary>The export leaves its own row too. An export IS a view, and a bigger one.</summary>
    [SkippableFact]
    public async Task The_export_leaves_a_row_too()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        Skip.IfNot(Wired(factory), Unwired);

        var club = await DoorClub.SeedAsync(factory, "trexp");
        var response = await club.AdminClient(factory).GetAsync(TraceCsv(club.MemberUserId));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var views = await ViewsAsync(factory, club);
        Assert.Single(views);

        var after = JsonSerializer.Deserialize<JsonElement>(views[0].AfterJson!);
        Assert.True(after.GetProperty("exported").GetBoolean());
    }

    /// <summary>
    /// The kill switch answers <b>404, not 403</b>. A 403 confirms both that the surface exists
    /// and that this member has one, which is the fact a club switching it off is trying not to
    /// publish — and it writes no view row, because nothing was viewed.
    /// </summary>
    [SkippableFact]
    public async Task The_kill_switch_answers_404_and_records_nothing()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        Skip.IfNot(Wired(factory), Unwired);

        var club = await DoorClub.SeedAsync(
            factory, "troff",
            """{"slice_minutes":15,"timezone":"UTC","heartbeat_seconds":45,"member_trace_enabled":false}""");

        var response = await club.AdminClient(factory).GetAsync(Trace(club.MemberUserId));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Empty(await ViewsAsync(factory, club));

        var csv = await club.AdminClient(factory).GetAsync(TraceCsv(club.MemberUserId));
        Assert.Equal(HttpStatusCode.NotFound, csv.StatusCode);
    }

    /// <summary>A member is not an admin, and this is the last surface that should forget it.</summary>
    [SkippableFact]
    public async Task A_member_cannot_read_anybodys_night_including_their_own()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        Skip.IfNot(Wired(factory), Unwired);

        var club = await DoorClub.SeedAsync(factory, "trrole");
        var response = await club.MemberClient(factory).GetAsync(Trace(club.MemberUserId));

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Empty(await ViewsAsync(factory, club));
    }

    /// <summary>
    /// One club's admin cannot trace another club's member.
    ///
    /// <para>
    /// The two tenants share ONE database, which is the only arrangement under which this
    /// assertion means anything: with a database per host the foreign club is empty and the test
    /// passes with every query filter deleted.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_foreign_clubs_member_is_indistinguishable_from_nobody()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        Skip.IfNot(Wired(factory), Unwired);

        var ours = await DoorClub.SeedAsync(factory, "trta");
        var theirs = await DoorClub.SeedAsync(factory, "trtb");

        await LedgerAsync(
            factory, theirs, theirs.MemberUserId, LedgerEntryType.TopUp, 100m,
            DateTimeOffset.UtcNow.AddMinutes(-10), theirs.MemberUserId);

        var foreign = await ours.AdminClient(factory).GetAsync(Trace(theirs.MemberUserId));
        var invented = await ours.AdminClient(factory).GetAsync(Trace(Guid.NewGuid()));

        Assert.Equal(HttpStatusCode.NotFound, foreign.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, invented.StatusCode);

        // Byte-identical: the difference between "not ours" and "nobody" is the leak.
        Assert.Equal(await invented.Content.ReadAsStringAsync(), await foreign.Content.ReadAsStringAsync());

        // And nothing was looked at, so nothing is recorded against either club.
        Assert.Empty(await ViewsAsync(factory, ours));
        Assert.Empty(await ViewsAsync(factory, theirs));
    }

    // ------------------------------------------------------------------ the range

    /// <summary>
    /// A club day is the CLUB'S day, computed at midnight's own offset — in a zone whose clocks
    /// move, and in a zone west of UTC.
    ///
    /// <para>
    /// A row at 23:30 club time on the named day is IN it, and the same instant is a different
    /// UTC day in both clubs. A range built at <i>now</i>'s offset rather than at the day
    /// boundary's own gets this wrong exactly twice a year, which is the failure
    /// <c>DoorClock</c> exists to prevent.
    /// </para>
    /// </summary>
    [SkippableTheory]
    [InlineData("America/Santiago", Santiago, "trdst")]
    [InlineData("America/Chicago", Chicago, "trwest")]
    public async Task A_named_day_is_the_clubs_day(string zoneId, string settings, string prefix)
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        Skip.IfNot(Wired(factory), Unwired);

        var club = await DoorClub.SeedAsync(factory, prefix, settings);
        var zone = TimeZoneInfo.FindSystemTimeZoneById(zoneId);

        // A fixed day well inside retention, rather than one relative to the wall clock — the
        // suite's own gotcha about tests whose hidden input is the clock.
        var day = DoorClock.LocalDateOf(zone, DateTimeOffset.UtcNow).AddDays(-3);
        var start = DoorClock.StartOfLocalDay(zone, day);

        await LedgerAsync(
            factory, club, club.MemberUserId, LedgerEntryType.TopUp, 50m,
            start.AddHours(23).AddMinutes(30), club.MemberUserId);
        await LedgerAsync(
            factory, club, club.MemberUserId, LedgerEntryType.TopUp, 50m,
            start.AddMinutes(-30), club.MemberUserId);

        var body = await club.AdminClient(factory)
            .GetFromJsonAsync<JsonElement>($"{Trace(club.MemberUserId)}?day={day:yyyy-MM-dd}");

        Assert.Equal(1, body.GetProperty("total").GetInt32());
        Assert.Equal(day.ToString("yyyy-MM-dd"), body.GetProperty("club_day").GetString());
        Assert.Equal(zoneId, body.GetProperty("timezone").GetString());
        Assert.Equal(start, body.GetProperty("range").GetProperty("from").GetDateTimeOffset());
    }

    /// <summary>
    /// The range is clamped to the LATER of the two horizons, and the response is honest that
    /// the shorter one has already deleted door rows inside it.
    ///
    /// <para>
    /// <b>"May", not "is".</b> D2-B38 means some door-shaped rows survive the door purge, so the
    /// only claim the data supports is a maybe — and the alternative, an empty door strand under
    /// an ordinary heading, reads as "she was not here".
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_range_past_the_door_horizon_says_the_door_strand_may_be_short()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        Skip.IfNot(Wired(factory), Unwired);

        var club = await DoorClub.SeedAsync(factory, "trret");
        var client = club.AdminClient(factory);

        var recent = await client.GetFromJsonAsync<JsonElement>($"{Trace(club.MemberUserId)}?period=today");
        Assert.False(recent.GetProperty("retention").GetProperty("door_rows_may_be_incomplete").GetBoolean());

        var from = DateTimeOffset.UtcNow.AddDays(-200).ToString("O");
        var deep = await client.GetFromJsonAsync<JsonElement>($"{Trace(club.MemberUserId)}?from={Uri.EscapeDataString(from)}");
        var retention = deep.GetProperty("retention");

        Assert.True(retention.GetProperty("door_rows_may_be_incomplete").GetBoolean());
        Assert.Equal(DoorSettings.DefaultLogRetentionDays, retention.GetProperty("door_days").GetInt32());
        Assert.True(retention.GetProperty("audit_days").GetInt32() > retention.GetProperty("door_days").GetInt32());

        // 200 days back is PAST the door horizon and well inside the audit one, so it is
        // answered in full rather than clamped — which is the whole reason the clamp is to the
        // LATER of the two and the flag exists to describe the shorter.
        Assert.True(
            deep.GetProperty("range").GetProperty("from").GetDateTimeOffset() < DateTimeOffset.UtcNow.AddDays(-199));

        // Past the audit horizon it IS clamped, and clamped rather than refused: a console
        // asking for more than a club keeps is a range to bound, not an error screen.
        var ancient = DateTimeOffset.UtcNow.AddDays(-900).ToString("O");
        var clampedBody = await client.GetFromJsonAsync<JsonElement>(
            $"{Trace(club.MemberUserId)}?from={Uri.EscapeDataString(ancient)}");
        Assert.True(
            clampedBody.GetProperty("range").GetProperty("from").GetDateTimeOffset()
            > DateTimeOffset.UtcNow.AddDays(-800));

        // A range that is not one club day does not claim to be one.
        Assert.Equal(JsonValueKind.Null, deep.GetProperty("club_day").ValueKind);
    }

    /// <summary>
    /// The range grammar is the door log's, refusals included — one spelling only, a malformed
    /// date refused by name, and a limit CLAMPED rather than refused.
    /// </summary>
    [SkippableFact]
    public async Task The_range_grammar_is_the_door_logs()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        Skip.IfNot(Wired(factory), Unwired);

        var club = await DoorClub.SeedAsync(factory, "trrange");
        var client = club.AdminClient(factory);
        var path = Trace(club.MemberUserId);

        await Refuses(client, $"{path}?period=today&day=2026-09-22", DoorPeriod.RangeConflict);
        await Refuses(client, $"{path}?day=not-a-day", DoorPeriod.DayInvalid);
        await Refuses(client, $"{path}?period=fortnight", DoorPeriod.PeriodInvalid);
        await Refuses(client, $"{path}?from=yesterday", DoorLogQuery.FromInvalid);
        await Refuses(client, $"{path}?to=whenever", DoorLogQuery.ToInvalid);
        await Refuses(client, $"{path}?cursor=notacursor", AdminMemberTraceQuery.CursorInvalid);
        await Refuses(client, $"{path}?limit=abc", AdminMemberTraceQuery.LimitInvalid);

        // A number OUT OF RANGE is clamped, because a console asking for too much is unambiguous.
        var clamped = await client.GetAsync($"{path}?limit=99999");
        Assert.Equal(HttpStatusCode.OK, clamped.StatusCode);
    }

    private static async Task Refuses(HttpClient client, string url, string error)
    {
        var response = await client.GetAsync(url);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);

        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(error, body.GetProperty("error").GetString());
    }

    /// <summary>
    /// The cursor walks FORWARDS and never repeats or skips a row — including across two strands
    /// whose rows land at the same instant.
    /// </summary>
    [SkippableFact]
    public async Task The_cursor_walks_the_night_forwards_exactly_once()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        Skip.IfNot(Wired(factory), Unwired);

        var club = await DoorClub.SeedAsync(factory, "trpage");
        var now = DateTimeOffset.UtcNow;
        for (var i = 0; i < 6; i++)
        {
            await LedgerAsync(
                factory, club, club.MemberUserId, LedgerEntryType.TopUp, 10m,
                now.AddMinutes(-60 + i), club.MemberUserId);
        }

        var client = club.AdminClient(factory);
        var seen = new List<Guid>();
        string? cursor = null;
        for (var page = 0; page < 6; page++)
        {
            var suffix = cursor is null ? "" : $"&cursor={Uri.EscapeDataString(cursor)}";
            var body = await client.GetFromJsonAsync<JsonElement>($"{Trace(club.MemberUserId)}?limit=2{suffix}");

            Assert.Equal(6, body.GetProperty("total").GetInt32());
            seen.AddRange(Events(body).Select(e => e.GetProperty("source_id").GetGuid()));

            cursor = body.GetProperty("cursor").ValueKind == JsonValueKind.Null
                ? null
                : body.GetProperty("cursor").GetString();
            if (cursor is null) break;
        }

        Assert.Equal(6, seen.Count);
        Assert.Equal(6, seen.Distinct().Count());
    }

    // ------------------------------------------------------------------ the export

    /// <summary>
    /// The file carries the column contract, and every cell is DEFUSED before it is quoted — a
    /// member's own name is club-entered text and lands in a spreadsheet a club opens without
    /// thinking about it.
    /// </summary>
    [SkippableFact]
    public async Task The_export_defuses_before_it_quotes()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        Skip.IfNot(Wired(factory), Unwired);

        var club = await DoorClub.SeedAsync(factory, "trcsv");

        // A member whose club-entered NAME is a formula. That name reaches the `subject` cell
        // whole, which is where CsvCell's rule actually bites — a payload embedded mid-sentence
        // in a headline is not a formula, because a spreadsheet only executes a cell that BEGINS
        // with one of = + - @. Pointing the fixture at the wrong cell is how this test first
        // passed while proving nothing.
        var payload = "=cmd|' /C calc'!A0, \"quoted\"";
        var hostile = await PersonAsync(factory, club, payload, isAdmin: false);
        var doorId = await club.AddDoorAsync(factory, "gate-tr00003", "front", name: "Front Door");
        await club.WriteRowAsync(
            factory, doorId, DeviceGateEndpoint.OpenedAction, DateTimeOffset.UtcNow.AddMinutes(-10),
            subjectUserId: hostile, gateKey: "front", doorName: "Front Door");

        var response = await club.AdminClient(factory).GetAsync(TraceCsv(hostile));
        var text = await response.Content.ReadAsStringAsync();

        Assert.Contains("strand,kind,headline", text);
        Assert.Equal("1", response.Headers.GetValues(AdminMemberTraceEndpoints.RowsHeader).Single());
        Assert.Contains("attachment; filename=", response.Content.Headers.GetValues("Content-Disposition").Single());

        // DEFUSED, then QUOTED — in that order. Quoting first would leave it a formula the
        // moment the reader stripped the quotes, and the value is KEPT rather than stripped, so
        // a member genuinely called "-Smith" survives the export.
        Assert.Contains("\"'" + payload.Replace("\"", "\"\""), text);
        Assert.DoesNotContain(",=cmd", text);
    }

    /// <summary>A second admin on this club, so the concurrent-view test has two people.</summary>
    private static Task<Guid> SecondAdminAsync(TestWebAppFactory factory, DoorClub club)
        => PersonAsync(factory, club, "Second Admin", isAdmin: true);

    /// <summary>One more member of this club, under a name the test chooses.</summary>
    private static async Task<Guid> PersonAsync(
        TestWebAppFactory factory, DoorClub club, string fullName, bool isAdmin)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var user = new User
        {
            TenantId = club.TenantId,
            Email = $"{Guid.NewGuid():N}@test.local",
            PasswordHash = "x",
            EmailVerified = true,
            IsAdmin = isAdmin,
        };
        db.Users.Add(user);
        db.Memberships.Add(new Membership
        {
            TenantId = club.TenantId,
            UserId = user.Id,
            FullName = fullName,
            MembershipNumber = $"{Guid.NewGuid():N}"[..8],
            Status = MembershipStatus.Active,
        });
        await db.SaveChangesAsync();
        return user.Id;
    }
}
