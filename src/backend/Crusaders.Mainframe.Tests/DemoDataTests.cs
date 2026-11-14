using System.Net;
using System.Net.Http.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Services.Demo;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The demo club's made-up data: drawn the same from the same seed, its money reconciling the way
/// the club's own rules settle it, every page given something to show, regenerated once a day,
/// and a reset that never deletes a real club's row.
/// </summary>
public sealed class DemoDataTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public DemoDataTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private static async Task<Tenant> EnterAsync(WebApplicationFactory<Program> app, DemoClub club)
    {
        await DemoClub.SwitchAsync(club.Admin(app), "demo");
        return await club.DemoAsync(app);
    }

    [SkippableFact]
    public async Task The_money_reconciles_and_every_page_has_something_to_show()
    {
        Skip.IfNot(_pg.Available, Skipped);
        var app = _pg.SharedHost;
        var club = await DemoClub.SeedAsync(app, "recon");
        var demo = await EnterAsync(app, club);

        await PeopleClub.ReadAsync(app, async db =>
        {
            var ledger = await db.LedgerEntries.IgnoreQueryFilters().AsNoTracking().Where(l => l.TenantId == demo.Id).ToListAsync();
            var bookings = await db.Bookings.IgnoreQueryFilters().AsNoTracking().Where(b => b.TenantId == demo.Id).ToListAsync();
            var settled = await db.PendingTopups.IgnoreQueryFilters().AsNoTracking()
                .Where(p => p.TenantId == demo.Id && p.Status == TopUpStatus.Completed).ToListAsync();

            // No balance is ever below zero, at any instant, replayed in the order it happened.
            foreach (var person in ledger.GroupBy(l => l.UserId))
            {
                var running = 0;
                foreach (var row in person.OrderBy(l => l.CreatedAt).ThenByDescending(l => l.AmountMinutes))
                {
                    running += row.AmountMinutes;
                    Assert.True(running >= 0, $"{person.Key} went to {running} at {row.CreatedAt:o} ({row.Type})");
                }
            }

            // Each booking's payer owes what its terminal state says (settlement S1–S5), and shares net to nothing.
            foreach (var b in bookings.Where(b => b.UserId is not null))
            {
                var mine = ledger.Where(l => l.RelatedBookingId == b.Id && l.UserId == b.UserId && l.Type != LedgerEntryType.ShareTransfer).Sum(l => l.AmountMinutes);
                var penalty = (int)Math.Floor(b.AmountChargedMinutes * 30m / 100m);
                var lateCancel = ledger.Any(l => l.RelatedBookingId == b.Id && l.Type == LedgerEntryType.LateCancellationPenalty);
                var owed = b.Status switch
                {
                    BookingStatus.Booked or BookingStatus.Completed => b.AmountChargedMinutes,
                    BookingStatus.NoShow => penalty,
                    BookingStatus.Cancelled => lateCancel ? penalty : 0,
                    _ => 0,
                };
                Assert.Equal(-owed, mine);
                Assert.Equal(0, ledger.Where(l => l.RelatedBookingId == b.Id && l.Type == LedgerEntryType.ShareTransfer).Sum(l => l.AmountMinutes));
            }

            // Every app purchase on the ledger is a completed purchase, minute for minute.
            var topUps = ledger.Where(l => l.Type == LedgerEntryType.TopUp).ToList();
            Assert.Equal(settled.Count, topUps.Count);
            Assert.Equal(settled.Sum(p => p.Minutes), topUps.Sum(l => l.AmountMinutes));
            Assert.All(topUps, l => Assert.Equal(settled.Single(p => l.ExternalReference!.EndsWith(p.ExternalReference!)).AmountZar, l.ZarPaid));

            await AssertEveryPageHasDataAsync(db, demo, bookings);
            return true;
        });
    }

    private static async Task AssertEveryPageHasDataAsync(MainframeDbContext db, Tenant demo, List<Booking> bookings)
    {
        var now = DateTimeOffset.UtcNow;
        var memberships = await db.Memberships.IgnoreQueryFilters().Where(m => m.TenantId == demo.Id).ToListAsync();
        Assert.True(memberships.Count(m => m.Status == MembershipStatus.Active) >= 40);
        Assert.Equal(3, memberships.Count(m => m.Status == MembershipStatus.PendingApproval));
        Assert.Equal(2, memberships.Count(m => m.Status == MembershipStatus.Suspended));
        Assert.All(await db.Users.IgnoreQueryFilters().Where(u => u.TenantId == demo.Id).Select(u => u.Email).ToListAsync(),
            e => Assert.EndsWith("@" + DemoTenants.EmailDomain, e));

        Assert.True(bookings.Count(b => b.Status == BookingStatus.Completed) > 300);
        Assert.Contains(bookings, b => b.Status == BookingStatus.NoShow);
        Assert.Contains(bookings, b => b.Status == BookingStatus.Booked && b.StartsAt > now.AddDays(7));
        Assert.Contains(bookings, b => b.Status == BookingStatus.AdminBlock && b.StartsAt > now);
        Assert.Contains(bookings, b => b.Status == BookingStatus.AdminBlock && b.StartsAt < now);

        var mirror = await db.Users.IgnoreQueryFilters().SingleAsync(u => u.TenantId == demo.Id && u.DemoSourceUserId != null && !u.DemoMemberView);
        Assert.True(await db.BookingParticipants.IgnoreQueryFilters().CountAsync(p => p.UserId == mirror.Id && p.Status == ParticipantStatus.Invited) >= 3);
        Assert.True(await db.MemberNotifications.IgnoreQueryFilters().AnyAsync(n => n.UserId == mirror.Id && n.Kind == MemberEventCatalogue.Invited));

        // The member-view persona is drawn in the same pass, as a plain member with the same story.
        var persona = await db.Users.IgnoreQueryFilters().SingleAsync(u => u.TenantId == demo.Id && u.DemoSourceUserId == mirror.DemoSourceUserId && u.DemoMemberView);
        Assert.False(persona.IsAdmin);
        Assert.True(await db.BookingParticipants.IgnoreQueryFilters().CountAsync(p => p.UserId == persona.Id && p.Status == ParticipantStatus.Invited) >= 3);
        Assert.True(await db.LedgerEntries.IgnoreQueryFilters().Where(l => l.UserId == persona.Id).SumAsync(l => l.AmountMinutes) > 0);
        Assert.True(await db.MatchResults.IgnoreQueryFilters().CountAsync(r => r.TenantId == demo.Id && r.Status == MatchResultStatus.Confirmed) > 20);
        Assert.True(await db.MemberBadges.IgnoreQueryFilters().AnyAsync(b => b.TenantId == demo.Id));
        Assert.Equal(3, await db.Devices.IgnoreQueryFilters().CountAsync(d => d.TenantId == demo.Id));
        Assert.True(await db.DeviceErrors.IgnoreQueryFilters().AnyAsync(e => e.TenantId == demo.Id && e.ResolvedAt == null));
        Assert.True(await db.AuditLogs.IgnoreQueryFilters().CountAsync(a => a.TenantId == demo.Id && a.Action == "gate.opened") > 20);
        Assert.True(await db.AdminNotifications.IgnoreQueryFilters().AnyAsync(n => n.TenantId == demo.Id && n.Kind == AdminEventCatalogue.MemberRegistered));
        // BA-12: a demo club mails nobody, so none of its seeded notices may claim it emailed an admin.
        var feed = await db.AdminNotifications.IgnoreQueryFilters().Where(n => n.TenantId == demo.Id).ToListAsync();
        Assert.All(feed, n => Assert.Equal(AdminNotificationState.Suppressed, n.State));
        Assert.All(feed, n => Assert.Equal(AdminNotificationEndpoints.ReasonDemoClub, AdminNotificationEndpoints.SuppressionReason(n.LastError)));
        Assert.Equal(2, await db.BookingSchedules.IgnoreQueryFilters().CountAsync(s => s.TenantId == demo.Id));
        Assert.True(await db.LedgerEntries.IgnoreQueryFilters().AnyAsync(l => l.TenantId == demo.Id && l.Type == LedgerEntryType.AdminTopUp));
    }

    [SkippableFact]
    public async Task The_same_seed_and_instant_draw_the_same_club()
    {
        Skip.IfNot(_pg.Available, Skipped);
        var app = _pg.SharedHost;
        var now = DateTimeOffset.UtcNow;
        var seed = new DemoSeed(4242, now) { Members = 24, HistoryDays = 21, AheadDays = 7 };
        var first = await DrawAsync(app, await DemoClub.SeedAsync(app, "seed-a"), seed);
        var second = await DrawAsync(app, await DemoClub.SeedAsync(app, "seed-b"), seed);
        Assert.Equal(first, second);

        var other = await DrawAsync(app, await DemoClub.SeedAsync(app, "seed-c"), seed with { Seed = 7 });
        Assert.NotEqual(first, other);
    }

    /// <summary>Generates straight into a fresh demo club and answers what can be compared across clubs.</summary>
    private static async Task<string> DrawAsync(WebApplicationFactory<Program> app, DemoClub club, DemoSeed seed)
    {
        var demo = await EnterAsync(app, club);
        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        scope.ServiceProvider.GetRequiredService<ITenantContext>().Set(demo.Id, demo.Slug);
        await DemoWiper.WipeAsync(db, demo.Id, default);
        await DemoConfigCopier.CopyAsync(db, club.Club.TenantId, demo.Id, Guid.Empty, default);
        var summary = await scope.ServiceProvider.GetRequiredService<DemoDataGenerator>().GenerateAsync(seed, default);

        var names = await db.Memberships.OrderBy(m => m.MembershipNumber).Select(m => m.FullName + ":" + m.Status).ToListAsync();
        var statuses = await db.Bookings.GroupBy(b => b.Status).OrderBy(g => g.Key).Select(g => g.Key + "=" + g.Count()).ToListAsync();
        var money = await db.LedgerEntries.GroupBy(l => l.Type).OrderBy(g => g.Key).Select(g => g.Key + "=" + g.Sum(l => l.AmountMinutes)).ToListAsync();
        return $"{summary.Members}/{summary.Bookings}/{summary.Results}|{string.Join(",", names)}|{string.Join(",", statuses)}|{string.Join(",", money)}";
    }

    [SkippableFact]
    public async Task A_reset_never_deletes_a_real_clubs_row()
    {
        Skip.IfNot(_pg.Available, Skipped);
        var app = _pg.SharedHost;
        var club = await DemoClub.SeedAsync(app, "reset");
        var bystander = await DemoClub.SeedAsync(app, "bystander");
        var before = await CountRealRowsAsync(app, club.Club.TenantId, bystander.Club.TenantId);

        var token = (await DemoClub.SwitchAsync(club.Admin(app), "demo")).GetProperty("access_token").GetString()!;
        var demo = await club.DemoAsync(app);
        var firstDraw = demo.DemoGeneratedAt;
        for (var i = 0; i < 2; i++)
        {
            var reset = await DemoClub.Bearer(app, token).PostAsync("/api/v1/admin/demo/reset", null);
            Assert.Equal(HttpStatusCode.OK, reset.StatusCode);
        }

        // The admin's demo session survived both resets.
        Assert.Equal(HttpStatusCode.OK, (await DemoClub.Bearer(app, token).GetAsync("/api/v1/admin/mode")).StatusCode);
        Assert.True((await club.DemoAsync(app)).DemoGeneratedAt > firstDraw);

        var after = await CountRealRowsAsync(app, club.Club.TenantId, bystander.Club.TenantId);
        // Only the real club's change record grew — by the entry and the two resets.
        Assert.Equal(before["admin_change_log"] + 3, after["admin_change_log"]);
        before.Remove("admin_change_log");
        after.Remove("admin_change_log");
        Assert.Equal(before, after);

        // A reset in a live session is refused, and the wiper refuses any club that is not a demo.
        var live = await club.Admin(app).PostAsync("/api/v1/admin/demo/reset", null);
        Assert.Equal(HttpStatusCode.Conflict, live.StatusCode);
        await PeopleClub.ReadAsync(app, async db =>
        {
            await Assert.ThrowsAsync<InvalidOperationException>(() => DemoWiper.WipeAsync(db, club.Club.TenantId, default));
            return true;
        });
    }

    /// <summary>Rows of the two real clubs, table by table, over every table that carries a tenant.</summary>
    private static Task<Dictionary<string, long>> CountRealRowsAsync(WebApplicationFactory<Program> app, Guid real, Guid bystander) =>
        PeopleClub.ReadAsync(app, async db =>
        {
            var counts = new Dictionary<string, long>();
            foreach (var table in DemoWiper.TablesInDeleteOrder(db.Model))
            {
                // The table name is the model's own, never input.
                var sql = "SELECT COUNT(*) AS \"Value\" FROM \"" + table + "\" WHERE \"TenantId\" = {0} OR \"TenantId\" = {1}";
                counts[table] = await db.Database.SqlQueryRaw<long>(sql, real, bystander).SingleAsync();
            }
            counts["tenants"] = await db.Tenants.LongCountAsync(t => t.Id == real || t.Id == bystander);
            return counts;
        });

    [SkippableFact]
    public async Task Entering_redraws_stale_data_and_keeps_fresh_data()
    {
        Skip.IfNot(_pg.Available, Skipped);
        var app = _pg.SharedHost;
        var club = await DemoClub.SeedAsync(app, "stale");
        var demo = await EnterAsync(app, club);
        var people = await PeopleClub.ReadAsync(app, db => db.Users.IgnoreQueryFilters().Where(u => u.TenantId == demo.Id && u.DemoSourceUserId == null).Select(u => u.Id).ToListAsync());

        await AgeAsync(app, demo.Id, TimeSpan.FromHours(1));
        await DemoClub.SwitchAsync(club.Admin(app), "demo");
        var kept = await PeopleClub.ReadAsync(app, db => db.Users.IgnoreQueryFilters().Where(u => u.TenantId == demo.Id && u.DemoSourceUserId == null).Select(u => u.Id).ToListAsync());
        Assert.Equal(people.Order(), kept.Order());

        await AgeAsync(app, demo.Id, DemoModeService.StaleAfter + TimeSpan.FromHours(1));
        await DemoClub.SwitchAsync(club.Admin(app), "demo");
        var redrawn = await club.DemoAsync(app);
        Assert.True(redrawn.DemoGeneratedAt > DateTimeOffset.UtcNow.AddMinutes(-5));
        var now = await PeopleClub.ReadAsync(app, db => db.Users.IgnoreQueryFilters().Where(u => u.TenantId == demo.Id && u.DemoSourceUserId == null).Select(u => u.Id).ToListAsync());
        Assert.Empty(now.Intersect(people));
    }

    private static Task AgeAsync(WebApplicationFactory<Program> app, Guid demo, TimeSpan age) =>
        PeopleClub.ReadAsync(app, db => db.Tenants.Where(t => t.Id == demo)
            .ExecuteUpdateAsync(u => u.SetProperty(t => t.DemoGeneratedAt, DateTimeOffset.UtcNow - age)));

    [Fact]
    public async Task The_mail_lock_drops_demo_flows_and_made_up_addresses_and_passes_everything_else()
    {
        var stub = new StubEmailService();
        var mail = new DemoAwareEmailService(stub, NullLogger<DemoAwareEmailService>.Instance);
        var demo = Guid.NewGuid();
        DemoTenants.Register(demo);

        await Task.Run(async () =>
        {
            new TenantContext().Set(demo, "x-demo");
            await mail.SendAsync(new EmailMessage("test.crusaders@frostaura.net", "from the demo", "<p>x</p>"));
        });
        await mail.SendAsync(new EmailMessage("someone@" + DemoTenants.EmailDomain, "made up", "<p>x</p>"));
        await Task.Run(async () =>
        {
            new TenantContext().Set(Guid.NewGuid(), "real");
            await mail.SendAsync(new EmailMessage("test.crusaders@frostaura.net", "from a real club", "<p>x</p>"));
        });

        Assert.Equal(new[] { "from a real club" }, stub.Sent.Select(m => m.Subject));
    }
}
