using System.Data.Common;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Perf round (2026-09-30), backend item 3: the booking POST composed its confirmation — the
/// member's address, the membership the receipt names, the club's identity and the PDF — before
/// it answered; only the SMTP hand-off was in the background. The composition now happens after
/// the response, in a scope of its own, with the figures the request fixed.
/// </summary>
public sealed class BookingConfirmationOffPathHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    /// <summary>
    /// The receipt's membership read is held until the test lets it go. Composed in the request,
    /// the booking cannot answer while it is held; composed after it, the booking answers, and the
    /// mail — receipt and all, with the balance the response stated — follows once released.
    /// </summary>
    [SkippableFact]
    public async Task A_booking_answers_before_its_confirmation_is_composed_and_the_mail_still_follows()
    {
        Skip.IfNot(pg.Available, Skipped);
        var gate = new ReceiptReadGate();
        var mail = new CapturingMail();
        await using var baseFactory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var f = CapturingMail.On(baseFactory, mail).WithWebHostBuilder(b => b.ConfigureServices(s =>
            s.ConfigureDbContext<MainframeDbContext>(o => o.AddInterceptors(gate))));
        var club = await PlayersClub.SeedAsync(f, "confoff");
        await club.CreditAsync(f, club.Organiser, 100);
        var olive = club.Client(f, club.Organiser);

        var answered = await olive.PostAsJsonAsync("/api/v1/bookings", new
        {
            courtId = club.CourtId, startsAt = PlayersClub.Tomorrow(9), sliceCount = 2,
        }).WaitAsync(TimeSpan.FromSeconds(20));

        Assert.Equal(HttpStatusCode.OK, answered.StatusCode);
        Assert.DoesNotContain(mail.Sent, m => m.Subject.StartsWith("Booking confirmed", StringComparison.Ordinal));

        gate.Release();
        var confirmation = await PollAsync(() => mail.Sent.FirstOrDefault(m => m.Subject.StartsWith("Booking confirmed", StringComparison.Ordinal)));
        Assert.NotNull(confirmation);
        Assert.Contains("olive.organiser@", confirmation!.To, StringComparison.Ordinal);
        var receipt = Assert.Single(confirmation.Attachments ?? []);
        var text = Encoding.Latin1.GetString(receipt.Content);
        Assert.Contains("Olive Organiser", text, StringComparison.Ordinal);
        var balance = await PlayersClub.BalanceAsync(f, club.Organiser);
        // Minutes in prose (contract §6): "Balance after: 1 hour 44 minutes", never "104.00 cr".
        Assert.Contains(MoneyFormat.Minutes(balance), text, StringComparison.Ordinal);
        Assert.DoesNotContain(" cr", text, StringComparison.Ordinal);
        Assert.Contains($"Club {club.Slug}", text, StringComparison.Ordinal);
    }

    private static async Task<T?> PollAsync<T>(Func<T?> read) where T : class
    {
        for (var i = 0; i < 200; i++)
        {
            if (read() is { } found) return found;
            await Task.Delay(50);
        }
        return null;
    }

    /// <summary>Holds the receipt's membership read (the only full-row membership read on this path).</summary>
    private sealed class ReceiptReadGate : DbCommandInterceptor
    {
        private readonly TaskCompletionSource _open = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public void Release() => _open.TrySetResult();

        public override async ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
            DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result, CancellationToken cancellationToken = default)
        {
            if (command.CommandText.Contains("FROM memberships", StringComparison.Ordinal)
                && command.CommandText.Contains("\"FullName\"", StringComparison.Ordinal))
            {
                await _open.Task.WaitAsync(TimeSpan.FromSeconds(60), cancellationToken);
            }
            return result;
        }
    }
}
