using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// R23's admin notice outbox against real Postgres: the claim's row locks, the dedupe index,
/// "staged in the same save as the event", the moved sends happening exactly once, the feed,
/// and every one of them across two clubs in one database.
///
/// <para>
/// <b>Every mail assertion is scoped to the club under test.</b> Every test in this class shares
/// its database, and a delivery pass claims whatever is due in it — including another test's club's notices,
/// which then land in THIS test's mail stub. Counting them would make a test's verdict depend on
/// what ran before it.
/// </para>
/// </summary>
public sealed class AdminNotificationHttpTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public AdminNotificationHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string FeedPath = "/api/v1/admin/notifications";
    private const string KindsPath = "/api/v1/admin/notifications/kinds";

    private TestWebAppFactory CreateFactory() => _pg.SharedHost;

    private static WebApplicationFactory<Program> WithMail(TestWebAppFactory factory, IEmailService mail) =>
        factory.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IEmailService>();
            s.AddSingleton(mail);
        }));

    private static bool Of(EmailMessage m, PeopleClub club) => m.To.EndsWith($"@{club.Slug}.test", StringComparison.Ordinal);

    private static async Task<List<AdminNotification>> NoticesAsync(WebApplicationFactory<Program> app, Guid tenantId, string? kind = null) =>
        await PeopleClub.ReadAsync(app, db => db.AdminNotifications.IgnoreQueryFilters().AsNoTracking()
            .Where(n => n.TenantId == tenantId && (kind == null || n.Kind == kind))
            .OrderBy(n => n.CreatedAt).ToListAsync());

    private static async Task StageAsync(WebApplicationFactory<Program> app, Guid tenantId, AdminNotice notice)
    {
        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        AdminNotices.Stage(db, tenantId, notice);
        await db.SaveChangesAsync();
    }

    private static AdminNotice Registration(string name) =>
        AdminNotices.MemberRegistered(Guid.NewGuid(), name, $"{Guid.NewGuid():N}@applicant.review.test", "N-1");

    /// <summary>A mail server slow enough that two passes are in flight together.</summary>
    private sealed class SlowMail : IEmailService
    {
        public ConcurrentBag<EmailMessage> Sent { get; } = [];

        public async Task SendAsync(EmailMessage message, CancellationToken ct = default)
        {
            await Task.Delay(40, ct);
            Sent.Add(message);
        }
    }

    // ------------------------------------------------------------------ the claim

    /// <summary>
    /// Two claims at once take disjoint rows — <c>FOR UPDATE SKIP LOCKED</c> and the lease in
    /// one statement. Without the lock both would read the same due rows and both would mail them.
    /// </summary>
    [SkippableFact]
    public async Task Two_claims_at_once_never_take_the_same_row()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var club = await PeopleClub.SeedAsync(factory, "noticeclaim");
        for (var i = 0; i < AdminNotificationDispatcher.BatchSize; i++) await StageAsync(factory, club.TenantId, Registration($"Racer {i}"));

        var dispatcher = factory.Services.GetRequiredService<AdminNotificationDispatcher>();
        var now = DateTimeOffset.UtcNow.AddSeconds(1);
        var claims = await Task.WhenAll(Enumerable.Range(0, 4).Select(_ => dispatcher.ClaimAsync(now, default)));

        var all = claims.SelectMany(c => c).ToList();
        Assert.Equal(all.Count, all.Distinct().Count());

        var ours = (await NoticesAsync(factory, club.TenantId)).Select(n => n.Id).ToHashSet();
        Assert.All(ours, id => Assert.Contains(id, all));
        Assert.All(await NoticesAsync(factory, club.TenantId), n =>
        {
            Assert.Equal(1, n.Attempts);
            Assert.NotNull(n.LockedUntil);
        });
    }

    /// <summary>
    /// The end-to-end form: two delivery passes racing, a slow mail server, twelve notices and
    /// two admins — twenty-four messages, each exactly once.
    /// </summary>
    [SkippableFact]
    public async Task Two_workers_delivering_at_once_mail_each_admin_once_per_notice()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var mail = new SlowMail();
        await using var app = WithMail(factory, mail);
        var club = await PeopleClub.SeedAsync(app, "noticerace");
        await club.AddAsync(app, "First Admin", isAdmin: true);
        await club.AddAsync(app, "Second Admin", isAdmin: true);
        for (var i = 0; i < 12; i++) await StageAsync(app, club.TenantId, Registration($"Applicant {i}"));

        var dispatcher = app.Services.GetRequiredService<AdminNotificationDispatcher>();
        var now = DateTimeOffset.UtcNow.AddSeconds(1);
        await Task.WhenAll(dispatcher.DeliverDueAsync(now, default), dispatcher.DeliverDueAsync(now, default));
        await dispatcher.DeliverDueAsync(now, default);

        var ours = mail.Sent.Where(m => Of(m, club)).ToList();
        Assert.Equal(24, ours.Count);
        Assert.Equal(24, ours.Select(m => (m.To, m.Subject)).Distinct().Count());
        Assert.All(await NoticesAsync(app, club.TenantId), n => Assert.Equal(AdminNotificationState.Sent, n.State));
    }

    // ------------------------------------------------------------------ the dedupe index

    [SkippableFact]
    public async Task The_same_dedupe_key_twice_in_one_club_is_refused_by_the_database_and_fine_in_another()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var a = await PeopleClub.SeedAsync(factory, "noticedupa");
        var b = await PeopleClub.SeedAsync(factory, "noticedupb");
        var notice = Registration("Same Person");

        await StageAsync(factory, a.TenantId, notice);
        await Assert.ThrowsAsync<DbUpdateException>(() => StageAsync(factory, a.TenantId, notice));
        await StageAsync(factory, b.TenantId, notice);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        Assert.False(await AdminNotices.RaiseAsync(db, a.TenantId, notice, DateTimeOffset.UtcNow, default));
        Assert.Single(await NoticesAsync(factory, a.TenantId));
        Assert.Single(await NoticesAsync(factory, b.TenantId));
    }

    // ------------------------------------------------------------------ the moved sends

    /// <summary>
    /// Registration over the wire: the desk's notice is committed with the application, nothing is
    /// mailed to an admin by the request itself, and two delivery passes mail each admin once.
    /// </summary>
    [SkippableFact]
    public async Task A_registration_commits_its_notice_and_the_desk_is_mailed_exactly_once()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var mail = new StubEmailService();
        await using var app = WithMail(factory, mail);
        var club = await PeopleClub.SeedAsync(app, "noticereg");
        await club.AddAsync(app, "Desk Admin", isAdmin: true);
        var applicant = $"new-{Guid.NewGuid():N}@applicant.review.test";

        using var anonymous = app.CreateClient();
        anonymous.DefaultRequestHeaders.Host = $"{club.Slug}.crusaders.test";
        var response = await TestPhotos.RegisterAsync(anonymous, applicant, $"NN-{Guid.NewGuid():N}"[..14], "Nomsa Newcomer");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var notice = Assert.Single(await NoticesAsync(app, club.TenantId, AdminEventCatalogue.MemberRegistered));
        var userId = await PeopleClub.ReadAsync(app, db => db.Users.IgnoreQueryFilters().Where(u => u.Email == applicant).Select(u => u.Id).SingleAsync());
        Assert.Equal($"member.registered:{userId:N}", notice.DedupeKey);
        Assert.Equal(userId, notice.SubjectUserId);

        await Task.Delay(300);
        Assert.DoesNotContain(mail.Sent, m => Of(m, club));

        await PeopleClub.DeliverAdminNoticesAsync(app);
        await PeopleClub.DeliverAdminNoticesAsync(app);

        var toDesk = Assert.Single(mail.Sent, m => Of(m, club));
        Assert.Equal($"desk.admin@{club.Slug}.test", toDesk.To);
        Assert.Equal("New membership application — Nomsa Newcomer", toDesk.Subject);
        Assert.Contains(applicant, toDesk.HtmlBody, StringComparison.Ordinal);
    }

    /// <summary>
    /// Eight applicants racing for one number: the seven whose save the unique index refused
    /// leave no notice behind, because the notice was in that save. One application, one notice.
    /// </summary>
    [SkippableFact]
    public async Task A_registration_that_rolls_back_leaves_no_notice()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var club = await PeopleClub.SeedAsync(factory, "noticeroll");
        var contested = $"RACE-{Guid.NewGuid():N}"[..16];

        var responses = await Task.WhenAll(Enumerable.Range(0, 8).Select(async i =>
        {
            using var client = factory.CreateClient();
            client.DefaultRequestHeaders.Host = $"{club.Slug}.crusaders.test";
            return await TestPhotos.RegisterAsync(client, $"racer-{i}-{Guid.NewGuid():N}@applicant.review.test", contested, $"Racer {i}");
        }));

        // Every applicant is answered alike since BP-14; one of them became a membership.
        Assert.All(responses, r => Assert.Equal(HttpStatusCode.OK, r.StatusCode));
        Assert.Equal(1, await PeopleClub.ReadAsync(factory, db => db.Memberships.IgnoreQueryFilters()
            .CountAsync(m => m.TenantId == club.TenantId && m.MembershipNumber == contested)));
        Assert.Single(await NoticesAsync(factory, club.TenantId, AdminEventCatalogue.MemberRegistered));
    }

    /// <summary>
    /// An admin's booking below zero stages its notice with the booking and the debit; a booking
    /// that does not overdraw stages none. The notice's balance is the one the ledger now holds.
    /// </summary>
    [SkippableFact]
    public async Task An_overdrawn_booking_is_one_notice_to_the_other_admins_and_a_covered_one_is_none()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var mail = new StubEmailService();
        await using var app = WithMail(factory, mail);
        var club = await DoorClub.SeedAsync(factory, "noticeod");
        var colleague = await AddColleagueAsync(app, club);
        using var admin = app.CreateClient();
        admin.DefaultRequestHeaders.Authorization =
            new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", club.TokenFor(club.AdminUserId, "admin"));
        var day = DateTime.UtcNow.Date.AddDays(2);

        var covered = await admin.PostAsJsonAsync("/api/v1/admin/bookings/", new
        {
            courtId = club.CourtId, userId = club.AdminUserId, startsAt = new DateTimeOffset(day.AddHours(8), TimeSpan.Zero), sliceCount = 1,
            allowNegativeBalance = true,
        });
        // The admin holds nothing, so even one slice overdraws; the member-paid control is below.
        Assert.True(covered.StatusCode == HttpStatusCode.OK, await covered.Content.ReadAsStringAsync());
        var notice = Assert.Single(await NoticesAsync(app, club.TenantId, AdminEventCatalogue.OverdraftAuthorised));
        var payload = JsonSerializer.Deserialize<OverdraftPayload>(notice.PayloadJson, AdminEventCatalogue.Json)!;
        Assert.True(payload.Self);
        Assert.Equal(-15, payload.BalanceAfterMinutes);   // one 15-minute slice, from zero
        Assert.Equal(club.AdminUserId, notice.ActorUserId);
        var balance = await PeopleClub.ReadAsync(app, db => db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.TenantId == club.TenantId && l.UserId == club.AdminUserId).SumAsync(l => l.AmountMinutes));
        Assert.Equal(balance, payload.BalanceAfterMinutes);

        // A member who can afford it: an on-behalf booking, no overdraft, no notice.
        await FundAsync(app, club, club.MemberUserId, 100);
        var onBehalf = await admin.PostAsJsonAsync("/api/v1/admin/bookings/", new
        {
            courtId = club.CourtId, userId = club.MemberUserId,
            startsAt = new DateTimeOffset(day.AddHours(9), TimeSpan.Zero), sliceCount = 1,
        });
        Assert.Equal(HttpStatusCode.OK, onBehalf.StatusCode);
        Assert.Single(await NoticesAsync(app, club.TenantId, AdminEventCatalogue.OverdraftAuthorised));

        await PeopleClub.DeliverAdminNoticesAsync(app);
        var sent = mail.Sent.Where(m => m.Subject.Contains("below zero", StringComparison.Ordinal)
            && (m.To == colleague || m.To.StartsWith(club.Slug, StringComparison.Ordinal))).ToList();
        var only = Assert.Single(sent);
        Assert.Equal(colleague, only.To);
    }

    /// <summary>A refused booking — the slot is already taken — rolls its notice back with it.</summary>
    [SkippableFact]
    public async Task A_refused_overdraft_booking_leaves_no_notice()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "noticeodx");
        var admin = club.AdminClient(factory);
        var at = new DateTimeOffset(DateTime.UtcNow.Date.AddDays(2).AddHours(10), TimeSpan.Zero);
        await FundAsync(factory, club, club.MemberUserId, 100);

        var first = await admin.PostAsJsonAsync("/api/v1/admin/bookings/", new
        {
            courtId = club.CourtId, userId = club.MemberUserId, startsAt = at, sliceCount = 1,
        });
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);

        var clash = await admin.PostAsJsonAsync("/api/v1/admin/bookings/", new
        {
            courtId = club.CourtId, userId = club.AdminUserId, startsAt = at, sliceCount = 1, allowNegativeBalance = true,
        });
        Assert.NotEqual(HttpStatusCode.OK, clash.StatusCode);
        Assert.Empty(await NoticesAsync(factory, club.TenantId, AdminEventCatalogue.OverdraftAuthorised));
    }

    private static async Task<string> AddColleagueAsync(WebApplicationFactory<Program> app, DoorClub club)
    {
        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var email = $"{club.Slug}-colleague@test.local";
        var user = new User { TenantId = club.TenantId, Email = email, PasswordHash = "x", EmailVerified = true, IsAdmin = true };
        db.Users.Add(user);
        db.Memberships.Add(new Membership
        {
            TenantId = club.TenantId, UserId = user.Id, FullName = "Colleague Admin",
            MembershipNumber = $"{club.Slug}-c", Status = MembershipStatus.Active,
        });
        await db.SaveChangesAsync();
        return email;
    }

    private static async Task FundAsync(WebApplicationFactory<Program> app, DoorClub club, Guid userId, int credits)
    {
        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        db.LedgerEntries.Add(new LedgerEntry
        {
            TenantId = club.TenantId, UserId = userId, Type = LedgerEntryType.TopUp,
            AmountMinutes = credits, ActorUserId = Guid.Empty, Reason = "fixture float",
        });
        await db.SaveChangesAsync();
    }

    // ------------------------------------------------------------------ recipients across clubs

    /// <summary>
    /// Two clubs, one database, the real tenant filter: a notice for club A mails A's admins and
    /// never B's, even though one pass delivers both clubs' notices.
    /// </summary>
    [SkippableFact]
    public async Task One_pass_mails_each_clubs_notice_to_that_clubs_admins_only()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var mail = new StubEmailService();
        await using var app = WithMail(factory, mail);
        var a = await PeopleClub.SeedAsync(app, "noticexa");
        var b = await PeopleClub.SeedAsync(app, "noticexb");
        await a.AddAsync(app, "Alpha Admin", isAdmin: true);
        await b.AddAsync(app, "Bravo Admin", isAdmin: true);
        await StageAsync(app, a.TenantId, Registration("Only For Alpha"));

        await PeopleClub.DeliverAdminNoticesAsync(app);

        var toA = Assert.Single(mail.Sent, m => Of(m, a));
        Assert.Equal("New membership application — Only For Alpha", toA.Subject);
        Assert.DoesNotContain(mail.Sent, m => Of(m, b));
    }

    // ------------------------------------------------------------------ the feed

    [SkippableFact]
    public async Task The_feed_is_this_clubs_newest_first_and_pages_by_cursor()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var a = await PeopleClub.SeedAsync(factory, "noticefa");
        var b = await PeopleClub.SeedAsync(factory, "noticefb");
        var adminA = await a.AddAsync(factory, "Alpha Admin", isAdmin: true);
        var adminB = await b.AddAsync(factory, "Bravo Admin", isAdmin: true);
        for (var i = 0; i < 3; i++)
        {
            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            AdminNotices.Stage(db, a.TenantId, Registration($"Alpha {i}"), DateTimeOffset.UtcNow.AddMinutes(i));
            await db.SaveChangesAsync();
        }
        await StageAsync(factory, b.TenantId, Registration("Bravo Secret"));

        var client = a.Client(factory, adminA, adminRole: true);
        var first = JsonDocument.Parse(await client.GetStringAsync($"{FeedPath}?limit=2")).RootElement;
        var items = first.GetProperty("items");
        Assert.Equal(2, items.GetArrayLength());
        Assert.Equal("New membership application — Alpha 2", items[0].GetProperty("headline").GetString());
        Assert.Equal("New membership application — Alpha 1", items[1].GetProperty("headline").GetString());
        Assert.Equal("member.registered", items[0].GetProperty("kind").GetString());
        Assert.Equal("New membership applications", items[0].GetProperty("title").GetString());
        Assert.Equal("/admin/members", items[0].GetProperty("link").GetString());
        Assert.Equal("pending", items[0].GetProperty("delivery").GetProperty("state").GetString());
        Assert.False(items[0].TryGetProperty("payload", out _));

        var cursor = first.GetProperty("next_cursor").GetString();
        var second = JsonDocument.Parse(await client.GetStringAsync($"{FeedPath}?limit=2&cursor={Uri.EscapeDataString(cursor!)}")).RootElement;
        var rest = second.GetProperty("items");
        Assert.Equal(1, rest.GetArrayLength());
        Assert.Equal("New membership application — Alpha 0", rest[0].GetProperty("headline").GetString());
        Assert.Equal(JsonValueKind.Null, second.GetProperty("next_cursor").ValueKind);

        // The other club's admin sees only their own; nothing of club A's reaches them.
        var other = JsonDocument.Parse(await b.Client(factory, adminB, adminRole: true).GetStringAsync(FeedPath)).RootElement;
        var theirs = other.GetProperty("items");
        Assert.Equal(1, theirs.GetArrayLength());
        Assert.Equal("New membership application — Bravo Secret", theirs[0].GetProperty("headline").GetString());

        var bad = await client.GetAsync($"{FeedPath}?cursor=not-a-cursor");
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
    }

    /// <summary>
    /// Review F3 + retention, on the Postgres bulk-delete path the in-memory suite cannot reach:
    /// a short feed retention deletes this club's old finished notices but keeps a schedule clash
    /// whose night is still ahead, and never touches another club's rows.
    /// </summary>
    [SkippableFact]
    public async Task Pruning_on_postgres_keeps_a_standing_clash_and_only_touches_its_own_club()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var a = await PeopleClub.SeedAsync(factory, "noticeprna");
        var b = await PeopleClub.SeedAsync(factory, "noticeprnb");
        var old = DateTimeOffset.UtcNow.AddDays(-(AdminNotificationSettings.MinRetentionDays + 1));
        var schedule = new BookingSchedule { TenantId = a.TenantId, Name = "League night", Label = "League" };
        Guid clash, registration, otherClub;
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var settings = await db.TenantSettings.IgnoreQueryFilters().SingleAsync(t => t.TenantId == a.TenantId);
            settings.SettingsJson = $$"""{"timezone":"UTC","admin_notification_retention_days":{{AdminNotificationSettings.MinRetentionDays}}}""";
            var rows = new[]
            {
                AdminNotices.Stage(db, a.TenantId, AdminNotices.ScheduleConflict(schedule, [DateOnly.FromDateTime(DateTime.UtcNow.AddDays(40))], 1), old),
                AdminNotices.Stage(db, a.TenantId, Registration("Pruned Applicant"), old),
                AdminNotices.Stage(db, b.TenantId, Registration("Other Club Applicant"), old),
            };
            foreach (var row in rows) row.State = AdminNotificationState.Sent;
            await db.SaveChangesAsync();
            (clash, registration, otherClub) = (rows[0].Id, rows[1].Id, rows[2].Id);
        }

        using (var scope = factory.Services.CreateScope())
        {
            scope.ServiceProvider.GetRequiredService<Crusaders.Mainframe.Api.Multitenancy.ITenantContext>().Set(a.TenantId, a.Slug);
            var view = await scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>().GetAsync(default);
            await AdminNotificationSweep.PruneAsync(scope.ServiceProvider.GetRequiredService<MainframeDbContext>(), view, DateTimeOffset.UtcNow, default);
        }

        var left = await PeopleClub.ReadAsync(factory, db => db.AdminNotifications.IgnoreQueryFilters()
            .Where(n => n.TenantId == a.TenantId || n.TenantId == b.TenantId).Select(n => n.Id).ToListAsync());
        Assert.Contains(clash, left);
        Assert.DoesNotContain(registration, left);
        Assert.Contains(otherClub, left);
    }

    /// <summary>
    /// Review (feed): <c>sent_at</c> is for a notice that was sent. A suppressed one answered the
    /// instant it was suppressed as its <c>sent_at</c>; that instant is <c>finished_at</c>.
    /// </summary>
    [SkippableFact]
    public async Task The_feed_says_sent_at_only_for_a_sent_notice_and_finished_at_for_every_finished_one()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var mail = new StubEmailService();
        await using var app = WithMail(factory, mail);
        var club = await PeopleClub.SeedAsync(app, "noticesent");
        var actor = await club.AddAsync(app, "Acting Admin", isAdmin: true);
        var reader = await club.AddAsync(app, "Reading Admin", isAdmin: true);
        var member = await club.AddAsync(app, "Owing Member", isAdmin: false);
        var payload = new OverdraftPayload(Guid.NewGuid(), "Acting Admin", "Owing Member", false, "Court 1", "Tue 29 Sep, 18:00", 8, -8);
        await StageAsync(app, club.TenantId, AdminNotices.OverdraftAuthorised(Guid.NewGuid(), actor, member, payload));
        for (var i = 0; i < 10 && (await NoticesAsync(app, club.TenantId)).Any(n => n.State == AdminNotificationState.Pending); i++)
        {
            await PeopleClub.DeliverAdminNoticesAsync(app, DateTimeOffset.UtcNow.AddSeconds(5));
        }
        await StageAsync(app, club.TenantId, AdminNotices.OverdraftAuthorised(Guid.NewGuid(), actor, member, payload with { CourtName = "Court 2" }));
        for (var i = 0; i < 10 && (await NoticesAsync(app, club.TenantId)).Any(n => n.State == AdminNotificationState.Pending); i++)
        {
            await PeopleClub.DeliverAdminNoticesAsync(app, DateTimeOffset.UtcNow.AddSeconds(5));
        }

        var items = JsonDocument.Parse(await club.Client(app, reader, adminRole: true).GetStringAsync(FeedPath))
            .RootElement.GetProperty("items").EnumerateArray()
            .ToDictionary(i => i.GetProperty("delivery").GetProperty("state").GetString()!, i => i.GetProperty("delivery").Clone());

        Assert.Equal(JsonValueKind.String, items["sent"].GetProperty("sent_at").ValueKind);
        Assert.Equal(items["sent"].GetProperty("sent_at").GetString(), items["sent"].GetProperty("finished_at").GetString());
        Assert.Equal(1, items["sent"].GetProperty("recipients").GetInt32());
        Assert.Equal(JsonValueKind.Null, items["suppressed"].GetProperty("sent_at").ValueKind);
        Assert.Equal(JsonValueKind.String, items["suppressed"].GetProperty("finished_at").ValueKind);
    }

    /// <summary>
    /// Review (cursor): a cursor whose number is not an instant — negative ticks — is the same
    /// 400 as any other malformed cursor. It was an unhandled ArgumentOutOfRangeException.
    /// </summary>
    [SkippableFact]
    public async Task A_crafted_cursor_whose_instant_cannot_exist_is_a_400_not_a_500()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var club = await PeopleClub.SeedAsync(factory, "noticecur");
        var admin = await club.AddAsync(factory, "Cursor Admin", isAdmin: true);
        var crafted = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes($"-1:{Guid.NewGuid():N}"));

        var res = await club.Client(factory, admin, adminRole: true).GetAsync($"{FeedPath}?cursor={Uri.EscapeDataString(crafted)}");

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal("cursor_invalid", JsonDocument.Parse(await res.Content.ReadAsStringAsync()).RootElement.GetProperty("error").GetString());
    }

    /// <summary>
    /// Review F4: a stored opt-out of a kind that is now non-optional is not read back, so the
    /// settings screen that saves what it read — a theme change carries the list — is not refused.
    /// </summary>
    [SkippableFact]
    public async Task Preferences_read_back_without_a_non_optional_opt_out_save_back_cleanly()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var club = await PeopleClub.SeedAsync(factory, "noticeprf");
        var admin = await club.AddAsync(factory, "Legacy Admin", isAdmin: true);
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            db.UserPreferences.Add(new UserPreferences
            {
                TenantId = club.TenantId, UserId = admin,
                AdminNotificationOptoutsJson = JsonSerializer.Serialize(new[] { AdminEventCatalogue.AdminRoleChanged, AdminEventCatalogue.DeviceOffline }),
            });
            await db.SaveChangesAsync();
        }
        var client = club.Client(factory, admin, adminRole: true);

        var read = JsonDocument.Parse(await client.GetStringAsync("/api/v1/me/preferences")).RootElement;
        var optouts = read.GetProperty("admin_notification_optouts").EnumerateArray().Select(e => e.GetString()!).ToArray();
        Assert.Equal(new[] { AdminEventCatalogue.DeviceOffline }, optouts);

        var put = await client.PutAsJsonAsync("/api/v1/me/preferences", new { theme = "dark", admin_notification_optouts = optouts });
        Assert.Equal(HttpStatusCode.OK, put.StatusCode);
    }

    /// <summary>A club's cursor is keyed on its own rows; one crafted from another club's row reveals nothing of it.</summary>
    [SkippableFact]
    public async Task A_member_cannot_read_the_feed_or_the_kinds()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var club = await PeopleClub.SeedAsync(factory, "noticemem");
        var member = await club.AddAsync(factory, "Plain Member", isAdmin: false);
        var client = club.Client(factory, member, adminRole: false);

        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync(FeedPath)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync(KindsPath)).StatusCode);
    }

    /// <summary>
    /// The toggles: every kind, whether it may be switched off, and whether this admin has — read
    /// back from the one place opt-outs are written. A security kind cannot be switched off there.
    /// </summary>
    [SkippableFact]
    public async Task The_kinds_list_reflects_the_callers_opt_outs_and_a_security_kind_cannot_be_opted_out_of()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var club = await PeopleClub.SeedAsync(factory, "noticekind");
        var admin = await club.AddAsync(factory, "Toggle Admin", isAdmin: true);
        var other = await club.AddAsync(factory, "Other Admin", isAdmin: true);
        var client = club.Client(factory, admin, adminRole: true);

        var put = await client.PutAsJsonAsync("/api/v1/me/preferences", new
        {
            admin_notification_optouts = new[] { AdminEventCatalogue.FaultSpike, AdminEventCatalogue.MemberRegistered },
        });
        Assert.Equal(HttpStatusCode.OK, put.StatusCode);

        var refused = await client.PutAsJsonAsync("/api/v1/me/preferences", new
        {
            admin_notification_optouts = new[] { AdminEventCatalogue.FaultSpike, AdminEventCatalogue.AdminRoleChanged },
        });
        Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
        var error = JsonDocument.Parse(await refused.Content.ReadAsStringAsync()).RootElement;
        Assert.Equal("notification_kind_not_optional", error.GetProperty("error").GetString());
        Assert.Equal(AdminEventCatalogue.AdminRoleChanged, error.GetProperty("kind").GetString());

        var kinds = JsonDocument.Parse(await client.GetStringAsync(KindsPath)).RootElement.GetProperty("kinds")
            .EnumerateArray().ToDictionary(k => k.GetProperty("kind").GetString()!, k => k.Clone());
        Assert.Equal(AdminEventCatalogue.All.Count, kinds.Count);
        Assert.True(kinds[AdminEventCatalogue.FaultSpike].GetProperty("opted_out").GetBoolean());
        Assert.True(kinds[AdminEventCatalogue.MemberRegistered].GetProperty("opted_out").GetBoolean());
        Assert.False(kinds[AdminEventCatalogue.DeviceOffline].GetProperty("opted_out").GetBoolean());
        Assert.False(kinds[AdminEventCatalogue.AdminRoleChanged].GetProperty("optional").GetBoolean());
        Assert.True(kinds[AdminEventCatalogue.DeviceOffline].GetProperty("optional").GetBoolean());
        Assert.False(string.IsNullOrWhiteSpace(kinds[AdminEventCatalogue.DeviceOffline].GetProperty("title").GetString()));

        // Another admin's list is their own.
        var theirs = JsonDocument.Parse(await club.Client(factory, other, adminRole: true).GetStringAsync(KindsPath))
            .RootElement.GetProperty("kinds").EnumerateArray();
        Assert.All(theirs, k => Assert.False(k.GetProperty("opted_out").GetBoolean()));
    }

    // ------------------------------------------------------------------ the settings

    [SkippableFact]
    public async Task The_notifiers_six_settings_are_read_bounded_and_written()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var club = await PeopleClub.SeedAsync(factory, "noticeset");
        var admin = club.Client(factory, await club.AddAsync(factory, "Settings Admin", isAdmin: true), adminRole: true);

        var before = JsonDocument.Parse(await admin.GetStringAsync("/api/v1/admin/settings")).RootElement;
        Assert.Equal(AdminNotificationSettings.DefaultFaultSpikeCount, before.GetProperty("fault_spike_count").GetInt32());
        Assert.Equal(AdminNotificationSettings.DefaultFaultSpikeMinutes, before.GetProperty("fault_spike_minutes").GetInt32());
        Assert.Equal(AdminNotificationSettings.DefaultApplicationReminderHours, before.GetProperty("application_reminder_hours").GetInt32());
        Assert.Equal(AdminNotificationSettings.DefaultRetentionDays, before.GetProperty("admin_notification_retention_days").GetInt32());
        Assert.Equal(AdminNotificationSettings.DefaultTopUpFailureCooldownMinutes, before.GetProperty("topup_failure_cooldown_minutes").GetInt32());
        Assert.Equal(AdminNotificationSettings.DefaultOverdraftCooldownMinutes, before.GetProperty("overdraft_cooldown_minutes").GetInt32());

        // The PUT carries the booking basics every save carries; the six ride along on it.
        Dictionary<string, object> Body() => new()
        {
            ["sliceMinutes"] = 15, ["slicePriceCredits"] = 8, ["advanceBookingDays"] = 14, ["dayStartMinute"] = 360,
            ["dayEndMinute"] = 1320, ["penaltyPct"] = 30m, ["graceWindowMinutes"] = 5, ["penaltyWindowMinutes"] = 15,
        };
        var outOfRange = Body();
        outOfRange["fault_spike_count"] = AdminNotificationSettings.MaxFaultSpikeCount + 1;
        var tooMany = await admin.PutAsJsonAsync("/api/v1/admin/settings", outOfRange);
        Assert.Equal(HttpStatusCode.BadRequest, tooMany.StatusCode);
        Assert.Contains("fault_spike_count_out_of_range", await tooMany.Content.ReadAsStringAsync(), StringComparison.Ordinal);

        // The cooldowns' floors are the reason they were constants: neither can be zeroed into a
        // mail per event, and neither can be stretched past its ceiling.
        foreach (var (key, value) in new (string, int)[]
                 {
                     ("topup_failure_cooldown_minutes", AdminNotificationSettings.MinTopUpFailureCooldownMinutes - 1),
                     ("topup_failure_cooldown_minutes", AdminNotificationSettings.MaxTopUpFailureCooldownMinutes + 1),
                     ("overdraft_cooldown_minutes", 0),
                     ("overdraft_cooldown_minutes", AdminNotificationSettings.MaxOverdraftCooldownMinutes + 1),
                 })
        {
            var bad = Body();
            bad[key] = value;
            var refused = await admin.PutAsJsonAsync("/api/v1/admin/settings", bad);
            Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
            Assert.Contains($"{key}_out_of_range", await refused.Content.ReadAsStringAsync(), StringComparison.Ordinal);
        }

        var valid = Body();
        valid["topup_failure_cooldown_minutes"] = 60;
        valid["overdraft_cooldown_minutes"] = 5;
        valid["fault_spike_count"] = 9;
        valid["fault_spike_minutes"] = 30;
        valid["application_reminder_hours"] = 48;
        valid["admin_notification_retention_days"] = 30;
        var ok = await admin.PutAsJsonAsync("/api/v1/admin/settings", valid);
        Assert.True(ok.StatusCode == HttpStatusCode.OK, await ok.Content.ReadAsStringAsync());
        var after = JsonDocument.Parse(await admin.GetStringAsync("/api/v1/admin/settings")).RootElement;
        Assert.Equal(9, after.GetProperty("fault_spike_count").GetInt32());
        Assert.Equal(30, after.GetProperty("fault_spike_minutes").GetInt32());
        Assert.Equal(48, after.GetProperty("application_reminder_hours").GetInt32());
        Assert.Equal(30, after.GetProperty("admin_notification_retention_days").GetInt32());
        Assert.Equal(60, after.GetProperty("topup_failure_cooldown_minutes").GetInt32());
        Assert.Equal(5, after.GetProperty("overdraft_cooldown_minutes").GetInt32());

        // Omitted means unchanged: a save that does not carry them leaves them where they were.
        var untouched = await admin.PutAsJsonAsync("/api/v1/admin/settings", Body());
        Assert.True(untouched.StatusCode == HttpStatusCode.OK, await untouched.Content.ReadAsStringAsync());
        var kept = JsonDocument.Parse(await admin.GetStringAsync("/api/v1/admin/settings")).RootElement;
        Assert.Equal(60, kept.GetProperty("topup_failure_cooldown_minutes").GetInt32());
        Assert.Equal(5, kept.GetProperty("overdraft_cooldown_minutes").GetInt32());
    }
}
