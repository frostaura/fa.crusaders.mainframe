using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 3, A-8: below-zero figures disagreed. The desk's confirm step said the booking
/// "takes to −80.00" — what the member may SPEND, the balance less the shares they hold for
/// partners — and the other admins' email said "Balance after: -30.00 credits", the raw ledger
/// balance, with an ASCII hyphen. The overdraft is decided on spendable, so the email now leads
/// with that figure, labelled, with a real minus sign; where a hold makes the two differ it names
/// the hold and the balance too, and the change record carries both figures before and after.
/// </summary>
public sealed class R3OverdraftFigureHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    /// <summary>
    /// The organiser owes Sam a 16-credit return that is waiting (PlayersRefute3HttpTests' fixture):
    /// balance 10, of which all 10 are set aside — spendable −6.
    /// </summary>
    private static async Task WaitingReturnAsync(PlayersClub club, TestWebAppFactory f)
    {
        var bookingId = await club.InsertBookingAsync(f, DateTimeOffset.UtcNow.AddDays(-10));
        await club.WriteAsync(f, db => db.Bookings.IgnoreQueryFilters().First(b => b.Id == bookingId).Status = BookingStatus.Completed);
        await club.InsertSeatAsync(f, bookingId, 1, club.Organiser, ParticipantStatus.Accepted, 16);
        var seat = await club.InsertSeatAsync(f, bookingId, 2, club.Sam, ParticipantStatus.Accepted, 16);
        await club.WriteAsync(f, db =>
        {
            db.Bookings.IgnoreQueryFilters().First(b => b.Id == bookingId).ShareDeadlineAt = DateTimeOffset.UtcNow.AddDays(-8);
            db.BookingParticipants.IgnoreQueryFilters().First(p => p.Id == seat).ConsentedMinutes = 16;
            foreach (var posting in ShareLedger.Pair(new Booking { Id = bookingId }, new ShareMove(seat, club.Sam, club.Organiser, 16, 1), club.Sam))
            {
                db.LedgerEntries.Add(new LedgerEntry
                {
                    TenantId = club.TenantId, UserId = posting.UserId, Type = posting.Type, AmountMinutes = posting.AmountMinutes,
                    ActorUserId = posting.ActorUserId, RelatedBookingId = bookingId, ExternalReference = posting.ExternalReference,
                });
            }
        });
        await club.CreditAsync(f, club.Organiser, 32);
        await club.CreditAsync(f, club.Organiser, -16);
        await club.CreditAsync(f, club.Sam, 16);
        await club.WriteAsync(f, db => db.BookingParticipants.IgnoreQueryFilters().First(p => p.Id == seat).Status = ParticipantStatus.Removed);
        await club.InClubAsync(f, sp => sp.GetRequiredService<ShareLedger>().ReconcileAsync(bookingId, default));
        await club.CreditAsync(f, club.Organiser, 10);
    }

    [SkippableFact]
    public async Task The_overdraft_notice_and_record_state_what_the_member_can_spend_the_figure_the_desk_confirmed()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = pg.SharedHost;
        var club = await PlayersClub.SeedAsync(f, "r3odfig");
        await WaitingReturnAsync(club, f);
        var desk = club.Client(f, club.Admin, admin: true);
        var startsAt = PlayersClub.Tomorrow(8).AddDays(1);

        var quote = await (await desk.GetAsync(
            $"/api/v1/admin/bookings/quote?userId={club.Organiser}&courtId={club.CourtId}&startsAt={Uri.EscapeDataString(startsAt.ToString("o"))}&slices=1"))
            .Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(10, quote.GetProperty("balance_minutes").GetInt32());
        Assert.Equal(-6, quote.GetProperty("spendable_minutes").GetInt32());
        Assert.Equal(8, quote.GetProperty("price_minutes").GetInt32());   // PlayersClub's slice is 8 minutes, and costs 8

        var booked = await desk.PostAsJsonAsync("/api/v1/admin/bookings/", new
        {
            courtId = club.CourtId, userId = club.Organiser, startsAt, sliceCount = 1, allowNegativeBalance = true,
        });
        Assert.True(booked.StatusCode == HttpStatusCode.OK, await booked.Content.ReadAsStringAsync());

        // The notice carries the hold, so the mail can say what the member may spend after: −14.
        var notice = await PlayersClub.ReadAsync(f, db => db.AdminNotifications.IgnoreQueryFilters().AsNoTracking()
            .SingleAsync(n => n.TenantId == club.TenantId && n.Kind == AdminEventCatalogue.OverdraftAuthorised));
        var payload = JsonSerializer.Deserialize<OverdraftPayload>(notice.PayloadJson, AdminEventCatalogue.Json)!;
        Assert.Equal(2, payload.BalanceAfterMinutes);
        Assert.Equal(16, payload.HeldMinutes);
        var spendableAfter = quote.GetProperty("spendable_minutes").GetInt32() - quote.GetProperty("price_minutes").GetInt32();
        Assert.Equal(-14, spendableAfter);

        var mail = EmailTemplates.AdminOverdraftAuthorised(EmailCatalogue.Riverside, "x@test.local", new OverdraftNotice(
            payload.ActorName, payload.MemberName, payload.Self, payload.CourtName, payload.StartsAtLocal,
            payload.AmountMinutes, payload.BalanceAfterMinutes, "https://club.test/admin/changes") { HeldMinutes = payload.HeldMinutes });
        var text = MailText.Unwrap(mail.PlainBody);
        Assert.Contains("Can spend after", text, StringComparison.Ordinal);
        Assert.Contains(MoneyFormat.Minutes(-14), text, StringComparison.Ordinal);
        Assert.Contains("Held for partners", text, StringComparison.Ordinal);
        Assert.DoesNotContain("-14", text, StringComparison.Ordinal);

        // The change record carries both figures, before and after.
        var row = await PlayersClub.ReadAsync(f, db => db.AdminChangeLogs.IgnoreQueryFilters().AsNoTracking()
            .SingleAsync(c => c.TenantId == club.TenantId && c.Action == AdminChangeActions.BookingOverdraftAuthorised));
        var before = JsonDocument.Parse(row.BeforeJson!).RootElement;
        var after = JsonDocument.Parse(row.AfterJson!).RootElement;
        Assert.Equal(-6, before.GetProperty("spendable_minutes").GetInt32());
        Assert.Equal(-14, after.GetProperty("spendable_minutes").GetInt32());
        Assert.Equal(10, before.GetProperty("balance_minutes").GetInt32());
        Assert.Equal(2, after.GetProperty("balance_minutes").GetInt32());
    }
}
