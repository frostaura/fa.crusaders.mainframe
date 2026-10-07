using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// <c>DELETE /api/v1/admin/members/{userId}</c> (Dean, 2026-10-06: "should be able to delete an
/// account, not just suspend it"), against real Postgres: the erase runs under the club's admin
/// lock and deletes rows with set-based statements the in-memory provider cannot run.
///
/// <para>
/// A member with no history is removed outright; one with history is erased in place — the
/// ledger still sums for them and for the club, their future bookings are refunded through the
/// desk's own cancellation, the balance left is written off only when the admin says so, nothing
/// of theirs signs in again, and their address is free to register with.
/// </para>
/// </summary>
public sealed class MemberDeleteHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private static string Path(Guid userId) => $"/api/v1/admin/members/{userId}";

    private static Task<HttpResponseMessage> DeleteAsync(HttpClient client, Guid userId, object body) =>
        client.SendAsync(new HttpRequestMessage(HttpMethod.Delete, Path(userId)) { Content = JsonContent.Create(body) });

    private static async Task<JsonElement> JsonAsync(HttpResponseMessage response) =>
        await response.Content.ReadFromJsonAsync<JsonElement>();

    private static WebApplicationFactory<Program> Wired(TestWebAppFactory factory, CapturingMail mail, params string[] configAdmins) =>
        factory.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IEmailService>();
            s.AddSingleton<IEmailService>(mail);
            if (configAdmins.Length > 0)
            {
                s.RemoveAll<InherentAdmins>();
                s.AddSingleton(new InherentAdmins(configAdmins.ToHashSet(StringComparer.Ordinal), []));
            }
        }));

    /// <summary>An applicant who never did anything — the account a club most often wants gone.</summary>
    private static async Task<Guid> ApplicantAsync(PlayersClub club, WebApplicationFactory<Program> f, string name)
    {
        var handle = name.ToLowerInvariant().Replace(' ', '.');
        var user = new User { TenantId = club.TenantId, Email = $"{handle}@{club.Slug}.review.test", PasswordHash = "x", EmailVerified = true };
        await club.WriteAsync(f, db =>
        {
            db.Users.Add(user);
            db.Memberships.Add(new Membership
            {
                TenantId = club.TenantId, UserId = user.Id, FullName = name, MembershipNumber = $"{handle}-1",
                Status = MembershipStatus.PendingApproval, PhotoUrl = "/uploads/x/photos/nope.jpg",
            });
            db.UserPreferences.Add(new UserPreferences { TenantId = club.TenantId, UserId = user.Id });
        });
        return user.Id;
    }

    [SkippableFact]
    public async Task An_applicant_with_no_history_is_removed_outright_and_recorded()
    {
        Skip.IfNot(pg.Available, Skipped);
        var mail = new CapturingMail();
        await using var f = Wired(pg.SharedHost, mail);
        var club = await PlayersClub.SeedAsync(f, "delrm");
        var applicant = await ApplicantAsync(club, f, "Pat Applicant");

        var preview = await JsonAsync(await club.Client(f, club.Admin, admin: true).GetAsync($"{Path(applicant)}/delete-preview"));
        Assert.Equal("remove", preview.GetProperty("mode").GetString());
        Assert.False(preview.GetProperty("member_told").GetBoolean());

        var response = await DeleteAsync(club.Client(f, club.Admin, admin: true), applicant, new { reason = "duplicate application" });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("remove", (await JsonAsync(response)).GetProperty("mode").GetString());
        Assert.False(await PlayersClub.ReadAsync(f, db => db.Users.IgnoreQueryFilters().AnyAsync(u => u.Id == applicant)));
        Assert.False(await PlayersClub.ReadAsync(f, db => db.Memberships.IgnoreQueryFilters().AnyAsync(m => m.UserId == applicant)));
        Assert.False(await PlayersClub.ReadAsync(f, db => db.UserPreferences.IgnoreQueryFilters().AnyAsync(p => p.UserId == applicant)));

        var change = await PlayersClub.ReadAsync(f, db => db.AdminChangeLogs.IgnoreQueryFilters()
            .SingleAsync(c => c.SubjectId == applicant && c.Action == AdminChangeActions.MemberDeleted));
        Assert.Equal("Pat Applicant", change.SubjectLabel);
        Assert.Equal("duplicate application", change.Reason);
        Assert.True(await PlayersClub.ReadAsync(f, db => db.AuditLogs.IgnoreQueryFilters()
            .AnyAsync(a => a.SubjectUserId == applicant && a.Action == MemberDeletion.DeletedAction)));
        // Never admitted, so never mailed.
        Assert.DoesNotContain(mail.Sent, m => m.To.StartsWith("pat.applicant@", StringComparison.Ordinal));

        // Gone is gone: a second delete names nobody.
        var again = await DeleteAsync(club.Client(f, club.Admin, admin: true), applicant, new { reason = "duplicate application" });
        Assert.Equal(HttpStatusCode.NotFound, again.StatusCode);
    }

    [SkippableFact]
    public async Task A_member_with_history_is_erased_refunded_written_off_signed_out_and_their_address_freed()
    {
        Skip.IfNot(pg.Available, Skipped);
        var mail = new CapturingMail();
        await using var f = Wired(pg.SharedHost, mail);
        var club = await PlayersClub.SeedAsync(f, "delerase");
        var email = await PlayersClub.ReadAsync(f, db => db.Users.IgnoreQueryFilters().Where(u => u.Id == club.Organiser).Select(u => u.Email).FirstAsync());
        await club.CreditAsync(f, club.Organiser, 100);
        await club.InsertBookingAsync(f, DateTimeOffset.UtcNow.AddDays(-2));              // played: 68 left
        var (future, _) = await club.BookWithPlayersAsync(f, []);                            // 32 more: 36 left
        var memberClient = club.Client(f, club.Organiser);
        Assert.Equal(HttpStatusCode.OK, (await memberClient.GetAsync("/api/v1/me/preferences")).StatusCode);
        var admin = club.Client(f, club.Admin, admin: true);

        // The refund brings the balance back to 68, and that is what the club must agree to write off.
        var preview = await JsonAsync(await admin.GetAsync($"{Path(club.Organiser)}/delete-preview"));
        Assert.Equal("erase", preview.GetProperty("mode").GetString());
        Assert.Equal(68, preview.GetProperty("write_off_minutes").GetInt32());
        var refused = await DeleteAsync(admin, club.Organiser, new { reason = "left the club" });
        Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
        var refusal = await JsonAsync(refused);
        Assert.Equal("balance_write_off_required", refusal.GetProperty("error").GetString());
        Assert.Equal(68, refusal.GetProperty("balance_minutes").GetInt32());
        Assert.Equal(BookingStatus.Booked, await PlayersClub.ReadAsync(f, db => db.Bookings.IgnoreQueryFilters().Where(b => b.Id == future).Select(b => b.Status).FirstAsync()));

        var response = await DeleteAsync(admin, club.Organiser, new { reason = "left the club", confirmBalanceWriteOff = true });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await JsonAsync(response);
        Assert.Equal("erase", body.GetProperty("mode").GetString());
        Assert.Equal(1, body.GetProperty("bookings_cancelled").GetInt32());
        Assert.Equal(68, body.GetProperty("written_off_minutes").GetInt32());
        Assert.True(body.GetProperty("member_email_queued").GetBoolean());

        // The books: the future booking refunded through the cancellation, the rest written off, sum zero.
        Assert.Equal(BookingStatus.Cancelled, await PlayersClub.ReadAsync(f, db => db.Bookings.IgnoreQueryFilters().Where(b => b.Id == future).Select(b => b.Status).FirstAsync()));
        var rows = await PlayersClub.ReadAsync(f, db => db.LedgerEntries.IgnoreQueryFilters().Where(l => l.UserId == club.Organiser).ToListAsync());
        Assert.Equal(0, rows.Sum(l => l.AmountMinutes));
        Assert.Contains(rows, l => l.Type == LedgerEntryType.CancellationRefund && l.RelatedBookingId == future && l.AmountMinutes == 32);
        Assert.Contains(rows, l => l.Type == LedgerEntryType.AdminAdjustment && l.AmountMinutes == -68);
        Assert.Equal(5, rows.Count);   // float, played charge, future charge, its refund, the write-off — nothing deleted

        // The person: wiped, terminal, and on no list.
        var user = await PlayersClub.ReadAsync(f, db => db.Users.IgnoreQueryFilters().FirstAsync(u => u.Id == club.Organiser));
        var membership = await PlayersClub.ReadAsync(f, db => db.Memberships.IgnoreQueryFilters().FirstAsync(m => m.UserId == club.Organiser));
        Assert.Equal(MemberDeletion.TombstoneEmail(club.Organiser), user.Email);
        Assert.Null(user.PasswordHash);
        Assert.Equal(UserStatuses.Deleted, user.Status);
        Assert.Equal(MemberDeletion.DeletedName, membership.FullName);
        Assert.Equal(MembershipStatus.Deleted, membership.Status);
        var listed = await JsonAsync(await admin.GetAsync("/api/v1/admin/members/"));
        Assert.DoesNotContain(listed.EnumerateArray(), m => m.GetProperty("user_id").GetGuid() == club.Organiser);

        // Signed out everywhere: the session they had is refused.
        Assert.Equal(HttpStatusCode.Unauthorized, (await memberClient.GetAsync("/api/v1/me/preferences")).StatusCode);

        // Told, at the address they had — and that address is free to join with again.
        Assert.Contains(mail.Sent, m => m.To == email && m.Subject == "Your account has been deleted");
        await club.WriteAsync(f, db => db.Users.Add(new User { TenantId = club.TenantId, Email = email, PasswordHash = "x" }));

        // Asked again, the same answer, and nothing moves twice.
        var again = await DeleteAsync(admin, club.Organiser, new { reason = "left the club", confirmBalanceWriteOff = true });
        Assert.Equal(HttpStatusCode.OK, again.StatusCode);
        Assert.True((await JsonAsync(again)).GetProperty("already_deleted").GetBoolean());
        Assert.Equal(5, await PlayersClub.ReadAsync(f, db => db.LedgerEntries.IgnoreQueryFilters().CountAsync(l => l.UserId == club.Organiser)));
        Assert.Equal(1, await PlayersClub.ReadAsync(f, db => db.AdminChangeLogs.IgnoreQueryFilters()
            .CountAsync(c => c.SubjectId == club.Organiser && c.Action == AdminChangeActions.MemberDeleted)));
    }

    [SkippableFact]
    public async Task Yourself_and_a_configured_admin_cannot_be_deleted_and_nothing_changes()
    {
        Skip.IfNot(pg.Available, Skipped);
        var mail = new CapturingMail();
        await using var probe = Wired(pg.SharedHost, mail);
        var club = await PlayersClub.SeedAsync(probe, "delguard");
        var colleague = await ApplicantAsync(club, probe, "Cara Colleague");
        await club.WriteAsync(probe, db =>
        {
            db.Users.IgnoreQueryFilters().First(u => u.Id == colleague).IsAdmin = true;
            db.Memberships.IgnoreQueryFilters().First(m => m.UserId == colleague).Status = MembershipStatus.Active;
        });
        var colleagueEmail = $"cara.colleague@{club.Slug}.review.test";
        await using var f = Wired(pg.SharedHost, mail, colleagueEmail);
        var admin = club.Client(f, club.Admin, admin: true);

        var self = await DeleteAsync(admin, club.Admin, new { reason = "testing" });
        Assert.Equal(HttpStatusCode.Conflict, self.StatusCode);
        Assert.Equal("cannot_delete_self", (await JsonAsync(self)).GetProperty("error").GetString());

        var config = await DeleteAsync(admin, colleague, new { reason = "testing" });
        Assert.Equal(HttpStatusCode.Conflict, config.StatusCode);
        Assert.Equal("admin_inherited_from_config", (await JsonAsync(config)).GetProperty("error").GetString());

        var noReason = await DeleteAsync(admin, club.Sam, new { reason = " " });
        Assert.Equal(HttpStatusCode.BadRequest, noReason.StatusCode);

        Assert.Equal(3, await PlayersClub.ReadAsync(f, db => db.Users.IgnoreQueryFilters()
            .CountAsync(u => (u.Id == club.Admin || u.Id == colleague || u.Id == club.Sam) && u.Status == UserStatuses.Active)));
    }

    [SkippableFact]
    public async Task Two_admins_deleting_each_other_at_once_leave_the_club_an_administrator()
    {
        Skip.IfNot(pg.Available, Skipped);
        var mail = new CapturingMail();
        await using var f = Wired(pg.SharedHost, mail);
        var club = await PlayersClub.SeedAsync(f, "delrace");
        var other = await ApplicantAsync(club, f, "Ola Other");
        await club.WriteAsync(f, db =>
        {
            db.Users.IgnoreQueryFilters().First(u => u.Id == other).IsAdmin = true;
            db.Memberships.IgnoreQueryFilters().First(m => m.UserId == other).Status = MembershipStatus.Active;
        });

        var a = DeleteAsync(club.Client(f, club.Admin, admin: true), other, new { reason = "race" });
        var b = DeleteAsync(club.Client(f, other, admin: true), club.Admin, new { reason = "race" });
        var answers = await Task.WhenAll(a, b);

        Assert.Contains(answers, r => r.StatusCode == HttpStatusCode.OK);
        Assert.True(await PlayersClub.ReadAsync(f, db => db.Users.IgnoreQueryFilters()
            .AnyAsync(u => u.TenantId == club.TenantId && u.IsAdmin && u.Status == UserStatuses.Active)));
    }

    [SkippableFact]
    public async Task Another_clubs_member_is_not_found_and_untouched()
    {
        Skip.IfNot(pg.Available, Skipped);
        var mail = new CapturingMail();
        await using var f = Wired(pg.SharedHost, mail);
        var ours = await PlayersClub.SeedAsync(f, "delours");
        var theirs = await PlayersClub.SeedAsync(f, "deltheirs");
        var admin = ours.Client(f, ours.Admin, admin: true);

        Assert.Equal(HttpStatusCode.NotFound, (await admin.GetAsync($"{Path(theirs.Sam)}/delete-preview")).StatusCode);
        var response = await DeleteAsync(admin, theirs.Sam, new { reason = "not ours" });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal("member_not_found", (await JsonAsync(response)).GetProperty("error").GetString());
        Assert.Equal(MembershipStatus.Active, await PlayersClub.ReadAsync(f, db => db.Memberships.IgnoreQueryFilters()
            .Where(m => m.UserId == theirs.Sam).Select(m => m.Status).FirstAsync()));
    }
}
