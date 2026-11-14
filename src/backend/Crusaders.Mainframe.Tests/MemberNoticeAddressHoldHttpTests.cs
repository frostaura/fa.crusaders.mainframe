using System.Net;
using System.Net.Http.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Browser lane BM-01: a member notice for an approved member whose address is not confirmed was
/// finished "sent" to nobody, so an invite was lost even when they verified a minute later. It is
/// now held, released the moment the address is confirmed, and given up on — said so — only after
/// <see cref="MemberNoticeHold.MaxHold"/>. A suspended recipient is suppressed with its reason.
/// </summary>
public sealed class MemberNoticeAddressHoldHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private static Task<List<AdminNotification>> SamsOutboxAsync(WebApplicationFactory<Program> f, PlayersClub club) =>
        PlayersClub.ReadAsync(f, db => db.AdminNotifications.IgnoreQueryFilters()
            .Where(n => n.TenantId == club.TenantId && n.Audience == NotificationAudience.Member && n.RecipientUserId == club.Sam)
            .ToListAsync());

    private static async Task DeliverAsync(WebApplicationFactory<Program> f, DateTimeOffset at)
    {
        for (var i = 0; i < 50 && await PeopleClub.DeliverAdminNoticesAsync(f, at) > 0; i++) { }
    }

    /// <summary>The organiser invites Sam to a game; returns the club with Sam's account in the given state.</summary>
    private static async Task<PlayersClub> InvitedAsync(WebApplicationFactory<Program> f, string prefix, bool verified, int daysAhead = 3)
    {
        var club = await PlayersClub.SeedAsync(f, prefix);
        await PurchaseKit.WriteAsync(f, async db =>
        {
            var sam = await db.Users.IgnoreQueryFilters().SingleAsync(u => u.Id == club.Sam);
            sam.EmailVerified = verified;
        });
        await club.CreditAsync(f, club.Organiser, 100);
        var bookingId = await club.InsertBookingAsync(f, DateTimeOffset.UtcNow.AddDays(daysAhead).Storable());
        (await club.Client(f, club.Organiser).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players",
            new { players = new object[] { new { userId = club.Sam } } })).EnsureSuccessStatusCode();
        return club;
    }

    [SkippableFact]
    public async Task An_invite_to_an_unverified_member_waits_and_is_mailed_the_moment_they_verify()
    {
        Skip.IfNot(pg.Available, Skipped);
        var mail = new CapturingMail();
        var f = CapturingMail.On(pg.SharedHost, mail);
        var club = await InvitedAsync(f, "hold-ok", verified: false);
        var now = DateTimeOffset.UtcNow;

        await DeliverAsync(f, now);
        Assert.DoesNotContain(mail.Sent, m => m.To.StartsWith("sam.partner@", StringComparison.Ordinal));
        var held = Assert.Single(await SamsOutboxAsync(f, club), n => n.Kind == MemberEventCatalogue.Invited);
        Assert.Equal(AdminNotificationState.Pending, held.State);
        Assert.Equal(MemberNoticeHold.AwaitingAddress, held.LastError);
        Assert.True(held.DueAt > now.AddHours(5), $"held until {held.DueAt:O}");

        // Sam clicks the verification link.
        const string token = "hold-ok-verification-token";
        await PurchaseKit.WriteAsync(f, db =>
        {
            db.AuthTokens.Add(new AuthToken
            {
                TenantId = club.TenantId,
                UserId = club.Sam,
                Kind = TokenKind.EmailVerification,
                TokenHash = TokenHashing.Hash(token),
                ExpiresAt = DateTimeOffset.UtcNow.AddDays(1),
            });
            return Task.CompletedTask;
        });
        Assert.Equal(HttpStatusCode.OK, (await club.Client(f, club.Sam).PostAsync($"/api/v1/auth/verify-email/{token}", null)).StatusCode);

        await DeliverAsync(f, DateTimeOffset.UtcNow);
        Assert.Contains(mail.Sent, m => m.To.StartsWith("sam.partner@", StringComparison.Ordinal));
        var sent = Assert.Single(await SamsOutboxAsync(f, club), n => n.Kind == MemberEventCatalogue.Invited);
        Assert.Equal((AdminNotificationState.Sent, 1, null), (sent.State, sent.RecipientCount, sent.LastError));
    }

    [SkippableFact]
    public async Task A_notice_for_an_address_never_confirmed_is_given_up_on_by_name()
    {
        Skip.IfNot(pg.Available, Skipped);
        var mail = new CapturingMail();
        var f = CapturingMail.On(pg.SharedHost, mail);
        // A game far enough out that the invite is still open when the cap is reached: a game that
        // has already passed is dropped by the release judgement first (invite_closed), as it should be.
        var club = await InvitedAsync(f, "hold-cap", verified: false, daysAhead: 30);

        await DeliverAsync(f, DateTimeOffset.UtcNow);
        await DeliverAsync(f, DateTimeOffset.UtcNow.Add(MemberNoticeHold.MaxHold).AddHours(1));

        var row = Assert.Single(await SamsOutboxAsync(f, club), n => n.Kind == MemberEventCatalogue.Invited);
        Assert.Equal((AdminNotificationState.Suppressed, MemberNoticeHold.RecipientUnverified), (row.State, row.LastError));
        Assert.DoesNotContain(mail.Sent, m => m.To.StartsWith("sam.partner@", StringComparison.Ordinal));
    }

    [SkippableFact]
    public async Task A_notice_for_a_suspended_member_is_suppressed_not_sent_to_nobody()
    {
        Skip.IfNot(pg.Available, Skipped);
        var mail = new CapturingMail();
        var f = CapturingMail.On(pg.SharedHost, mail);
        var club = await InvitedAsync(f, "hold-susp", verified: true);
        await PurchaseKit.WriteAsync(f, async db =>
            (await db.Users.IgnoreQueryFilters().SingleAsync(u => u.Id == club.Sam)).Status = "suspended");

        await DeliverAsync(f, DateTimeOffset.UtcNow);

        var row = Assert.Single(await SamsOutboxAsync(f, club), n => n.Kind == MemberEventCatalogue.Invited);
        Assert.Equal((AdminNotificationState.Suppressed, MemberNoticeHold.RecipientInactive, 0), (row.State, row.LastError, row.RecipientCount));
    }
}
