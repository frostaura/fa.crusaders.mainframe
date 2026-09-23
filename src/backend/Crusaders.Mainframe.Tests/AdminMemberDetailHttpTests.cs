using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// R17 — the member detail and its bookings pages. Postgres-backed because the keyset cursor,
/// the tenant filter and the Guid ordering are all the database's, and the in-memory provider
/// would prove the loop runs and nothing about the order it runs in.
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class AdminMemberDetailHttpTests
{
    private readonly PostgresFixture _pg;

    public AdminMemberDetailHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    private static string DetailPath(Guid userId) => $"/api/v1/admin/members/{userId}";

    private static string BookingsPath(Guid userId, string query = "") => $"/api/v1/admin/members/{userId}/bookings{query}";

    /// <summary>A booking row, written directly so the test controls every field the detail reads.</summary>
    private static Booking BookingFor(
        DoorClub club, Guid userId, DateTimeOffset startsAt, BookingStatus status = BookingStatus.Booked,
        Guid? actor = null, DateTimeOffset? checkedInAt = null)
    {
        return new Booking
        {
            TenantId = club.TenantId,
            CourtId = club.CourtId,
            UserId = userId,
            BookedByUserId = userId,
            PaidByUserId = userId,
            ActorUserId = actor ?? userId,
            StartsAt = startsAt.ToUniversalTime(),
            EndsAt = startsAt.AddMinutes(30).ToUniversalTime(),
            SliceMinutes = 15,
            SliceCount = 2,
            AmountChargedCredits = 16m,
            Status = status,
            ChargedAt = DateTimeOffset.UtcNow,
            CheckedInAt = checkedInAt?.ToUniversalTime(),
            CancelledAt = status == BookingStatus.Cancelled ? DateTimeOffset.UtcNow : null,
        };
    }

    private static async Task SeedAsync(TestWebAppFactory factory, Action<MainframeDbContext> seed)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        seed(db);
        await db.SaveChangesAsync();
    }

    /// <summary>
    /// Everything the detail screen shows, from one read — and each figure is the live one, not
    /// a near miss: a superseded fingerprint is not counted, an archived group is not listed, a
    /// cancelled booking is not "next", and attendance is <c>CheckedInAt</c>.
    /// </summary>
    [SkippableFact]
    public async Task The_detail_is_one_read_of_who_they_are_what_they_hold_and_what_they_did()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "mdetail");
        var member = club.MemberUserId;
        var now = DateTimeOffset.UtcNow;
        var league = Guid.Empty;

        await SeedAsync(factory, db =>
        {
            var active = new MemberGroup { TenantId = club.TenantId, Name = "League", SortOrder = 1 };
            var archived = new MemberGroup
            {
                TenantId = club.TenantId, Name = "Old juniors", Status = MemberGroupStatus.Archived,
            };
            league = active.Id;
            db.MemberGroups.AddRange(active, archived);
            db.MemberGroupMembers.AddRange(
                new MemberGroupMember { TenantId = club.TenantId, GroupId = active.Id, UserId = member },
                new MemberGroupMember { TenantId = club.TenantId, GroupId = archived.Id, UserId = member });

            db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = club.TenantId, UserId = member, Type = LedgerEntryType.TopUp,
                AmountCredits = 120m, ActorUserId = Guid.Empty, Reason = "fixture",
            });

            db.WebAuthnCredentials.Add(new WebAuthnCredential
            {
                TenantId = club.TenantId, UserId = member, CredentialId = [1, 2, 3],
                PublicKey = [4], UserHandle = [5],
            });

            db.EnrolledTemplates.AddRange(
                new EnrolledTemplate { TenantId = club.TenantId, UserId = member, TemplateId = "tpl-live", FingerLabel = "Right index" },
                new EnrolledTemplate
                {
                    TenantId = club.TenantId, UserId = member, TemplateId = "tpl-gone", FingerLabel = "Left thumb",
                    SupersededAt = now.AddDays(-1),
                });

            // Six upcoming, one cancelled among them: next_bookings carries the first five live ones.
            for (var i = 1; i <= 6; i++) db.Bookings.Add(BookingFor(club, member, now.AddDays(1).AddHours(i)));
            db.Bookings.Add(BookingFor(club, member, now.AddHours(2), BookingStatus.Cancelled));

            // The trailing thirty days: one played, one swept as a no-show, one cancelled, and one
            // outside the window that must not be counted at all.
            db.Bookings.Add(BookingFor(club, member, now.AddDays(-2), BookingStatus.Completed, checkedInAt: now.AddDays(-2)));
            db.Bookings.Add(BookingFor(club, member, now.AddDays(-3), BookingStatus.NoShow));
            db.Bookings.Add(BookingFor(club, member, now.AddDays(-4), BookingStatus.Cancelled));
            db.Bookings.Add(BookingFor(club, member, now.AddDays(-40), BookingStatus.Completed, checkedInAt: now.AddDays(-40)));
        });

        var response = await club.AdminClient(factory).GetAsync(DetailPath(member));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();

        Assert.Equal(member, body.GetProperty("user_id").GetGuid());
        Assert.Equal("Door Member", body.GetProperty("full_name").GetString());
        Assert.Equal("Active", body.GetProperty("status").GetString());
        Assert.Equal("active", body.GetProperty("account_status").GetString());
        Assert.True(body.GetProperty("email_verified").GetBoolean());
        Assert.False(body.GetProperty("is_admin").GetBoolean());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("admin_source").ValueKind);
        Assert.Equal(120m, body.GetProperty("balance_credits").GetDecimal());
        Assert.Equal(1, body.GetProperty("passkey_count").GetInt32());

        var groups = body.GetProperty("groups").EnumerateArray().ToList();
        Assert.Equal(league, Assert.Single(groups).GetProperty("id").GetGuid());
        Assert.Equal("League", groups[0].GetProperty("name").GetString());

        var fingerprints = body.GetProperty("fingerprints");
        Assert.Equal(1, fingerprints.GetProperty("count").GetInt32());
        var enrolment = Assert.Single(fingerprints.GetProperty("enrolments").EnumerateArray().ToList());
        Assert.Equal("tpl-live", enrolment.GetProperty("template_id").GetString());
        Assert.Equal("Right index", enrolment.GetProperty("finger_label").GetString());

        var next = body.GetProperty("next_bookings").EnumerateArray().ToList();
        Assert.Equal(5, next.Count);
        Assert.All(next, b => Assert.Equal("booked", b.GetProperty("status").GetString()));
        Assert.Equal("Court 1", next[0].GetProperty("court_name").GetString());
        Assert.True(next.Zip(next.Skip(1)).All(p =>
            p.First.GetProperty("starts_at").GetDateTimeOffset() < p.Second.GetProperty("starts_at").GetDateTimeOffset()));

        var counts = body.GetProperty("counts_30d");
        Assert.Equal(2, counts.GetProperty("bookings").GetInt32());
        Assert.Equal(1, counts.GetProperty("no_shows").GetInt32());
        Assert.Equal(1, counts.GetProperty("sessions_played").GetInt32());
    }

    /// <summary>
    /// The club's bootstrap administrator has an account and no membership row. The detail
    /// answers for them rather than 404ing one of the people who runs the club.
    /// </summary>
    [SkippableFact]
    public async Task An_account_with_no_membership_row_still_has_a_detail()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await PeopleClub.SeedAsync(factory, "mdetboot");
        var admin = await club.AddAsync(factory, "Boot Admin", isAdmin: true, membership: null);

        var body = await club.Client(factory, admin, adminRole: true).GetFromJsonAsync<JsonElement>(DetailPath(admin));

        Assert.Equal(admin, body.GetProperty("user_id").GetGuid());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("membership_id").ValueKind);
        Assert.Equal(JsonValueKind.Null, body.GetProperty("status").ValueKind);
        Assert.True(body.GetProperty("is_admin").GetBoolean());
        Assert.Equal("granted", body.GetProperty("admin_source").GetString());
        Assert.Empty(body.GetProperty("next_bookings").EnumerateArray());
    }

    /// <summary>
    /// Another club's member id is indistinguishable from an invented one on both reads — the
    /// tenant filter is the only thing in the way, and it is enough.
    /// </summary>
    [SkippableFact]
    public async Task Another_clubs_member_is_not_found_on_either_read()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var mine = await DoorClub.SeedAsync(factory, "mdetmine");
        var theirs = await DoorClub.SeedAsync(factory, "mdettheirs");
        await SeedAsync(factory, db => db.Bookings.Add(BookingFor(theirs, theirs.MemberUserId, DateTimeOffset.UtcNow.AddDays(1))));

        var admin = mine.AdminClient(factory);
        foreach (var path in new[] { DetailPath(theirs.MemberUserId), BookingsPath(theirs.MemberUserId), DetailPath(Guid.NewGuid()) })
        {
            var response = await admin.GetAsync(path);
            Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
            var body = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("member_not_found", body.GetProperty("error").GetString());
        }
    }

    [SkippableFact]
    public async Task A_member_cannot_read_anybodys_detail_including_their_own()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "mdetrole");
        var client = club.MemberClient(factory);

        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync(DetailPath(club.MemberUserId))).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync(BookingsPath(club.MemberUserId))).StatusCode);
    }

    /// <summary>
    /// Upcoming reads soonest first, past reads most recent first, and the cursor walks each
    /// exactly once — every row seen, none twice — including a tie on the start instant, which
    /// is what the id half of the keyset is for.
    /// </summary>
    [SkippableFact]
    public async Task The_bookings_pages_walk_each_direction_once_in_order()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "mdetpage");
        var member = club.MemberUserId;
        var now = DateTimeOffset.UtcNow;
        var tie = now.AddDays(2);

        await SeedAsync(factory, db =>
        {
            for (var i = 1; i <= 5; i++) db.Bookings.Add(BookingFor(club, member, now.AddDays(1).AddHours(i)));

            // Two rows at one instant, on the one court: only possible because one is cancelled,
            // which the exclusion constraint exempts — exactly the real-world shape of a tie.
            db.Bookings.Add(BookingFor(club, member, tie, BookingStatus.Cancelled));
            db.Bookings.Add(BookingFor(club, member, tie));
            for (var i = 1; i <= 4; i++) db.Bookings.Add(BookingFor(club, member, now.AddDays(-i), BookingStatus.Completed));

            // Somebody else's booking must never appear on this member's pages.
            db.Bookings.Add(BookingFor(club, club.AdminUserId, now.AddDays(1).AddHours(12)));
        });

        var admin = club.AdminClient(factory);

        var upcoming = await WalkAsync(admin, member, "upcoming");
        Assert.Equal(7, upcoming.Count);
        Assert.Equal(upcoming.Count, upcoming.Select(r => r.Id).Distinct().Count());
        Assert.True(upcoming.Zip(upcoming.Skip(1)).All(p => p.First.StartsAt <= p.Second.StartsAt));

        var past = await WalkAsync(admin, member, "past");
        Assert.Equal(4, past.Count);
        Assert.True(past.Zip(past.Skip(1)).All(p => p.First.StartsAt > p.Second.StartsAt));
    }

    private static async Task<List<(Guid Id, DateTimeOffset StartsAt)>> WalkAsync(HttpClient admin, Guid member, string when)
    {
        var seen = new List<(Guid, DateTimeOffset)>();
        string? cursor = null;
        for (var guard = 0; guard < 20; guard++)
        {
            var query = $"?when={when}&limit=2" + (cursor is null ? "" : $"&cursor={Uri.EscapeDataString(cursor)}");
            var body = await admin.GetFromJsonAsync<JsonElement>(BookingsPath(member, query));
            Assert.Equal(when, body.GetProperty("when").GetString());
            foreach (var item in body.GetProperty("items").EnumerateArray())
            {
                seen.Add((item.GetProperty("booking_id").GetGuid(), item.GetProperty("starts_at").GetDateTimeOffset()));
            }
            var next = body.GetProperty("next_cursor");
            if (next.ValueKind == JsonValueKind.Null) return seen;
            cursor = next.GetString();
        }
        throw new InvalidOperationException("The cursor never stopped.");
    }

    /// <summary>
    /// <c>booked_by</c> names who pressed the button, not the member every row names — and
    /// <c>is_self</c> is only that comparison.
    /// </summary>
    [SkippableFact]
    public async Task A_booking_made_by_the_desk_says_so_and_one_they_made_says_self()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "mdetactor");
        var now = DateTimeOffset.UtcNow;
        await SeedAsync(factory, db =>
        {
            db.Bookings.Add(BookingFor(club, club.MemberUserId, now.AddDays(1), actor: club.AdminUserId));
            db.Bookings.Add(BookingFor(club, club.MemberUserId, now.AddDays(2)));
        });

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(BookingsPath(club.MemberUserId));
        var items = body.GetProperty("items").EnumerateArray().ToList();

        var desk = items[0].GetProperty("booked_by");
        Assert.Equal(club.AdminUserId, desk.GetProperty("user_id").GetGuid());
        Assert.Equal("Door Admin", desk.GetProperty("name").GetString());
        Assert.False(desk.GetProperty("is_self").GetBoolean());
        Assert.True(items[1].GetProperty("booked_by").GetProperty("is_self").GetBoolean());
        Assert.Equal(16m, items[1].GetProperty("charged_credits").GetDecimal());
    }

    [SkippableTheory]
    [InlineData("?when=soon", "when_invalid")]
    [InlineData("?limit=lots", "limit_invalid")]
    [InlineData("?cursor=not-a-cursor", "cursor_invalid")]
    public async Task A_bookings_request_this_server_cannot_bound_is_refused_by_name(string query, string error)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "mdetbad");

        var response = await club.AdminClient(factory).GetAsync(BookingsPath(club.MemberUserId, query));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(error, (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());
    }
}
