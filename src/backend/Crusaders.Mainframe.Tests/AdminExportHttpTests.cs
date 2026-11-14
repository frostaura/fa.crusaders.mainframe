using System.Net;
using System.Text;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// BA-08: the members and no-shows files — admin-only, this club's rows only, PII minimal (no email,
/// phone or photo ever), formula-defused, and recorded as exports.
/// </summary>
public sealed class AdminExportHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string MembersPath = "/api/v1/admin/exports/members.csv";
    private const string NoShowsPath = "/api/v1/admin/exports/no-shows.csv";

    private static async Task<string[]> LinesAsync(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("text/csv", response.Content.Headers.ContentType?.MediaType);
        var bytes = await response.Content.ReadAsByteArrayAsync();
        Assert.True(bytes.AsSpan().StartsWith(Encoding.UTF8.GetPreamble()), "the file carries a UTF-8 BOM");
        return Encoding.UTF8.GetString(bytes[3..]).Split("\r\n", StringSplitOptions.RemoveEmptyEntries);
    }

    private static async Task SeedAsync(TestWebAppFactory factory, Action<MainframeDbContext> seed)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        seed(db);
        await db.SaveChangesAsync();
    }

    private static async Task<int> ExportsAsync(TestWebAppFactory factory, Guid tenantId, string action)
    {
        using var scope = factory.Services.CreateScope();
        return await scope.ServiceProvider.GetRequiredService<MainframeDbContext>().AuditLogs.IgnoreQueryFilters()
            .CountAsync(a => a.TenantId == tenantId && a.Action == action);
    }

    [SkippableFact]
    public async Task The_members_file_names_each_member_with_status_groups_and_balance_and_no_contact_details()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var club = await ControlBoardClub.SeedAsync(factory, "export-m");
        await SeedAsync(factory, db =>
        {
            var league = new MemberGroup { TenantId = club.TenantId, Name = "League" };
            var juniors = new MemberGroup { TenantId = club.TenantId, Name = "Juniors" };
            db.MemberGroups.AddRange(league, juniors);
            db.MemberGroupMembers.AddRange(
                new MemberGroupMember { TenantId = club.TenantId, GroupId = league.Id, UserId = club.MemberUserId, AddedByUserId = club.AdminUserId },
                new MemberGroupMember { TenantId = club.TenantId, GroupId = juniors.Id, UserId = club.MemberUserId, AddedByUserId = club.AdminUserId });
            db.LedgerEntries.AddRange(
                new LedgerEntry { TenantId = club.TenantId, UserId = club.MemberUserId, Type = LedgerEntryType.TopUp, AmountMinutes = 120, ZarPaid = 100m, ActorUserId = Guid.Empty, ExternalReference = $"pf-{Guid.NewGuid():N}" },
                new LedgerEntry { TenantId = club.TenantId, UserId = club.MemberUserId, Type = LedgerEntryType.BookingCharge, AmountMinutes = -45, ActorUserId = club.MemberUserId });
            var user = new User { TenantId = club.TenantId, Email = $"formula-{Guid.NewGuid():N}@test.local", PasswordHash = "x", EmailVerified = true };
            db.Users.Add(user);
            db.Memberships.Add(new Membership
            {
                TenantId = club.TenantId, UserId = user.Id, FullName = "=HYPERLINK(\"x\")", MembershipNumber = "Z-9",
                Status = MembershipStatus.Suspended,
            });
        });

        var lines = await LinesAsync(await club.AdminClient(factory).GetAsync(MembersPath));

        Assert.Equal(AdminExportEndpoints.MembersHeader, lines[0]);
        Assert.Equal(4, lines.Length);
        var priya = Assert.Single(lines, l => l.Contains("Priya Naidoo"));
        Assert.StartsWith($"{club.Slug}-m,Priya Naidoo,Active,Juniors; League,", priya);
        Assert.EndsWith(",75", priya);
        // A name that is a formula is kept, and defused.
        Assert.Contains(lines, l => l.StartsWith("Z-9,\"'=HYPERLINK(\"\"x\"\")\",Suspended,,", StringComparison.Ordinal));
        // PII minimal: nothing that reaches a person outside the club.
        Assert.DoesNotContain(lines, l => l.Contains('@') || l.Contains("/media/"));
        Assert.Equal(1, await ExportsAsync(factory, club.TenantId, AdminExportEndpoints.MembersExportedAction));

        var suspended = await LinesAsync(await club.AdminClient(factory).GetAsync(MembersPath + "?status=suspended"));
        Assert.Equal(2, suspended.Length);
        Assert.Equal(HttpStatusCode.BadRequest, (await club.AdminClient(factory).GetAsync(MembersPath + "?status=lapsed")).StatusCode);
    }

    [SkippableFact]
    public async Task The_no_shows_file_lists_the_ranges_no_shows_with_their_penalty_and_says_which_were_refunded()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var club = await ControlBoardClub.SeedAsync(factory, "export-n");
        var court = await club.AddCourtAsync(factory, 1, "Glass court");
        var day = new DateTimeOffset(2026, 10, 6, 18, 0, 0, TimeSpan.Zero);
        var held = await club.AddBookingAsync(factory, court, day, day.AddMinutes(45), club.MemberUserId, BookingStatus.NoShow, amountMinutes: 45);
        var refunded = await club.AddBookingAsync(factory, court, day.AddDays(1), day.AddDays(1).AddMinutes(30), club.MemberUserId, BookingStatus.NoShow, amountMinutes: 30);
        await club.AddBookingAsync(factory, court, day.AddDays(2), day.AddDays(2).AddMinutes(30), club.MemberUserId, BookingStatus.Completed, amountMinutes: 30);
        await club.AddBookingAsync(factory, court, day.AddDays(40), day.AddDays(40).AddMinutes(30), club.MemberUserId, BookingStatus.NoShow, amountMinutes: 30);
        await SeedAsync(factory, db =>
        {
            db.LedgerEntries.Add(new LedgerEntry { TenantId = club.TenantId, UserId = club.MemberUserId, Type = LedgerEntryType.NoShowPenalty, AmountMinutes = -13, RelatedBookingId = held, ActorUserId = Guid.Empty });
        });
        using (var scope = factory.Services.CreateScope())
        {
            await scope.ServiceProvider.GetRequiredService<MainframeDbContext>().Bookings.IgnoreQueryFilters()
                .Where(b => b.Id == refunded)
                .ExecuteUpdateAsync(u => u.SetProperty(b => b.OutageRefundedAt, day.AddDays(1).AddHours(2)));
        }

        var response = await club.AdminClient(factory).GetAsync(NoShowsPath + "?from=2026-10-01&to=2026-10-31");
        var lines = await LinesAsync(response);

        Assert.Equal(AdminExportEndpoints.NoShowsHeader, lines[0]);
        Assert.Equal(
            [
                $"2026-10-06,18:00,UTC,Glass court,Priya Naidoo,{club.Slug}-m,45,13,no",
                $"2026-10-07,18:00,UTC,Glass court,Priya Naidoo,{club.Slug}-m,30,0,yes",
            ],
            lines[1..]);
        Assert.Contains("no-shows-2026-10-01-2026-10-31.csv", response.Content.Headers.ContentDisposition?.ToString());
        Assert.Equal(1, await ExportsAsync(factory, club.TenantId, AdminExportEndpoints.NoShowsExportedAction));

        Assert.Equal(HttpStatusCode.BadRequest, (await club.AdminClient(factory).GetAsync(NoShowsPath + "?from=2026-10-31&to=2026-10-01")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await club.AdminClient(factory).GetAsync(NoShowsPath + "?from=2024-01-01&to=2026-10-01")).StatusCode);
    }

    [SkippableFact]
    public async Task A_member_may_not_take_either_file()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var club = await ControlBoardClub.SeedAsync(factory, "export-x");
        Assert.Equal(HttpStatusCode.Forbidden, (await club.MemberClient(factory).GetAsync(MembersPath)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await club.MemberClient(factory).GetAsync(NoShowsPath)).StatusCode);
    }

    /// <summary>Cross-tenant: each club's files hold that club's people and bookings only, and record the export in that club.</summary>
    [SkippableFact]
    public async Task Each_clubs_files_hold_only_that_clubs_rows()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var a = await ControlBoardClub.SeedAsync(factory, "export-a");
        var b = await ControlBoardClub.SeedAsync(factory, "export-b");
        var courtB = await b.AddCourtAsync(factory, 1, "B court");
        var day = new DateTimeOffset(2026, 10, 6, 18, 0, 0, TimeSpan.Zero);
        await b.AddBookingAsync(factory, courtB, day, day.AddMinutes(30), b.MemberUserId, BookingStatus.NoShow, amountMinutes: 30);

        var members = await LinesAsync(await a.AdminClient(factory).GetAsync(MembersPath));
        Assert.DoesNotContain(members, l => l.Contains(b.Slug));
        Assert.Equal(3, members.Length);
        var noShows = await LinesAsync(await a.AdminClient(factory).GetAsync(NoShowsPath + "?from=2026-10-01&to=2026-10-31"));
        Assert.Single(noShows);
        Assert.Equal(2, await ExportsAsync(factory, a.TenantId, AdminExportEndpoints.MembersExportedAction) + await ExportsAsync(factory, a.TenantId, AdminExportEndpoints.NoShowsExportedAction));
        Assert.Equal(0, await ExportsAsync(factory, b.TenantId, AdminExportEndpoints.NoShowsExportedAction));

        // Injection: club A's admin naming club B's tenant in a forged token is refused, and B's file is not served to it.
        var forged = a.ClientFor(factory, a.AdminUserId, "admin");
        forged.DefaultRequestHeaders.Authorization = new("Bearer", b.TokenFor(a.AdminUserId, "admin"));
        var refused = await forged.GetAsync(NoShowsPath + "?from=2026-10-01&to=2026-10-31");
        if (refused.StatusCode == HttpStatusCode.OK) Assert.DoesNotContain(await LinesAsync(refused), l => l.Contains("B court"));
        else Assert.True(refused.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden, $"answered {refused.StatusCode}");
    }
}
