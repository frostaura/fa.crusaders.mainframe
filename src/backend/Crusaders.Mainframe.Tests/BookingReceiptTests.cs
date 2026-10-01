using System.Globalization;
using System.Text;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The receipt that rides on a booking confirmation.
/// </summary>
/// <remarks>
/// <para>
/// <c>docs/specs/feature-spec.md</c> §11 lists "Booking confirmation + receipt PDF attached"
/// among the required emails. The confirmation shipped single-part HTML with no attachment of
/// any kind — <c>EmailMessage</c> had nowhere to put one — so a member had nothing to forward
/// to a treasurer and nothing to keep against a disputed charge, against an invariant that says
/// disputes are settled by replaying the ledger.
/// </para>
/// <para>
/// The receipt is money-adjacent, so these assertions are about the numbers on it. The PDF is
/// written uncompressed on purpose, which is what lets a test read the amount out of the bytes
/// rather than assert that some bytes exist.
/// </para>
/// </remarks>
public sealed class BookingReceiptTests
{
    /// <summary>The page content, as text. Uncompressed streams are readable; that is the point.</summary>
    private static string TextOf(byte[] pdf) => Encoding.Latin1.GetString(pdf);

    [Fact]
    public void A_receipt_is_a_pdf_a_reader_will_open()
    {
        var pdf = ReceiptPdf.ForBooking(
            "Crusaders Squash Club", "Erin AgentE", "b1", "Court 1",
            "Sat 05 Sep 12:45", "15 min", 50, 450, "Thu 01 Jan 1970 00:00");

        var text = TextOf(pdf);
        Assert.StartsWith("%PDF-1.4", text, StringComparison.Ordinal);
        Assert.EndsWith("%%EOF\n", text, StringComparison.Ordinal);
        // A reader refuses the file outright if the cross-reference table is missing or its
        // byte offsets are wrong, and a startxref pointing at the wrong place is the single
        // most common way a hand-written PDF fails to open at all.
        Assert.Contains("xref", text, StringComparison.Ordinal);
        var startxref = text.LastIndexOf("startxref", StringComparison.Ordinal);
        var offset = int.Parse(text[(startxref + 9)..].Trim().Split('\n')[0]);
        Assert.Equal("xref", text.Substring(offset, 4));
        Assert.Contains("/Type /Catalog", text, StringComparison.Ordinal);
        Assert.Contains("/Type /Page ", text, StringComparison.Ordinal);
    }

    [Fact]
    public void A_receipt_states_the_amount_in_minutes_and_names_the_booking()
    {
        var pdf = ReceiptPdf.ForBooking(
            "Crusaders Squash Club", "Erin AgentE", "0f2b-booking-ref", "Court 1",
            "Sat 05 Sep 12:45", "45 min", 45, 1530, "Thu 01 Jan 1970 00:00");

        var text = TextOf(pdf);
        Assert.Contains("Crusaders Squash Club", text, StringComparison.Ordinal);
        Assert.Contains("Erin AgentE", text, StringComparison.Ordinal);
        // The reference has to be the one the ledger row carries, or the receipt cannot settle
        // the dispute it exists for.
        Assert.Contains("0f2b-booking-ref", text, StringComparison.Ordinal);
        Assert.Contains("Court 1", text, StringComparison.Ordinal);
        Assert.Contains("Sat 05 Sep 12:45", text, StringComparison.Ordinal);

        // Minutes, in words, whole — never rand, never a decimal, never "cr" (contract §6):
        // "Charged: 45 minutes", and a balance past a day written in days.
        Assert.Contains("(Charged) Tj", text, StringComparison.Ordinal);
        Assert.Contains("(45 minutes) Tj", text, StringComparison.Ordinal);
        Assert.Contains("(1 day 1 hour 30 minutes) Tj", text, StringComparison.Ordinal);
        Assert.Contains("Minutes are its unit of account.", text, StringComparison.Ordinal);
        Assert.DoesNotContain("R45", text, StringComparison.Ordinal);
        Assert.DoesNotContain(".00", text, StringComparison.Ordinal);
        Assert.DoesNotContain(" cr", text, StringComparison.Ordinal);
        Assert.DoesNotContain("redit", text, StringComparison.Ordinal);
    }

    /// <summary>
    /// A balance below zero keeps its sign on the receipt. The prose formatter writes a real
    /// minus (U+2212), which the receipt's WinAnsi text cannot carry and its escaper drops — so
    /// "−45 minutes" would have printed as "45 minutes", a debt reading as money in hand on the
    /// one document a member keeps. It prints as an ASCII minus instead.
    /// </summary>
    [Theory]
    [InlineData(-45, "-45 minutes")]
    [InlineData(-90, "-1 hour 30 minutes")]
    public void A_receipt_keeps_the_sign_of_a_balance_below_zero(int balanceAfter, string expected)
    {
        var pdf = ReceiptPdf.ForBooking(
            "Crusaders Squash Club", "Erin AgentE", "b1", "Court 1",
            "Sat 05 Sep 12:45", "1 h", 60, balanceAfter, "Thu 01 Jan 1970 00:00");

        var text = TextOf(pdf);
        Assert.Contains($"({expected}) Tj", text, StringComparison.Ordinal);
        Assert.Contains("(1 hour) Tj", text, StringComparison.Ordinal);
    }

    [Fact]
    public void A_court_name_with_a_bracket_in_it_does_not_break_the_file()
    {
        // An unescaped parenthesis closes a PDF literal early and produces a file no reader can
        // parse. Court names are admin-entered and a member's own name is on the page too.
        var pdf = ReceiptPdf.ForBooking(
            "Club (Pty) Ltd", @"O'Brien \ Smith", "b1", "Court 1 (old hall)",
            "Sat 05 Sep 12:45", "15 min", 50, 450, "Thu 01 Jan 1970 00:00");

        var text = TextOf(pdf);
        Assert.Contains(@"Court 1 \(old hall\)", text, StringComparison.Ordinal);
        Assert.Contains(@"Club \(Pty\) Ltd", text, StringComparison.Ordinal);
        Assert.Contains(@"O'Brien \\ Smith", text, StringComparison.Ordinal);
        Assert.EndsWith("%%EOF\n", text, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Booking_a_court_emails_a_confirmation_with_the_receipt_attached()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 200, host.PlayerUser.Id), default);
        var result = await booking.CreateAsync(
            host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id,
            TestHost.BookableSlot(2), sliceCount: 1, default);
        var ok = Assert.IsType<BookingResult.Ok>(result);

        // The confirmation is dispatched on a background task so SMTP latency cannot block the
        // booking response, so wait for it rather than asserting straight after the call.
        var confirmation = await Poll(() => host.EmailService.Sent
            .FirstOrDefault(m => m.Subject.StartsWith("Booking confirmed", StringComparison.Ordinal)));

        Assert.NotNull(confirmation);
        var receipt = Assert.Single(confirmation!.Attachments ?? []);
        Assert.Equal("application/pdf", receipt.ContentType);
        Assert.EndsWith(".pdf", receipt.FileName, StringComparison.Ordinal);

        var text = TextOf(receipt.Content);
        Assert.StartsWith("%PDF", text, StringComparison.Ordinal);
        // What the member was actually charged — the booking's own minutes, SliceMinutes ×
        // SliceCount, read off the row rather than restated — and what they have left: the two
        // numbers the email quotes, on the document they will keep, in the same words.
        var charged = ok.Booking.AmountChargedMinutes;
        Assert.Equal(ok.Booking.SliceMinutes * ok.Booking.SliceCount, charged);
        Assert.Contains($"({MoneyFormat.Minutes(charged)}) Tj", text, StringComparison.Ordinal);
        Assert.Contains($"({MoneyFormat.Minutes(ok.BalanceAfterMinutes)}) Tj", text, StringComparison.Ordinal);
        Assert.Contains($"Charged: {MoneyFormat.Minutes(charged)}", MailText.Unwrap(confirmation.PlainBody));
        Assert.Contains(ok.Booking.Id.ToString(), text, StringComparison.Ordinal);
    }

    /// <summary>Waits for a background send, rather than racing it.</summary>
    private static async Task<T?> Poll<T>(Func<T?> read, int timeoutMs = 5000) where T : class
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow < deadline)
        {
            var value = read();
            if (value is not null) return value;
            await Task.Delay(25);
        }
        return read();
    }

    // ---- R3 K-F8: one clock per document ----------------------------------

    /// <summary>
    /// Every receipt carried <c>Issued Sun 06 Sep 2026 20:51 UTC</c> two lines above
    /// <c>Starts Sun 06 Sep 22:51</c> — two times two hours apart for one booking, on the
    /// artefact a member keeps against a disputed charge. <c>reporting.md</c>'s implementation
    /// notes say reports honour <c>tenant_settings.timezone</c>, and "Starts" already did.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>Three zones, because one zone cannot tell the rule from a constant.</b> The pin this
    /// replaces ran only against Africa/Johannesburg and compared the stamp with
    /// <c>DateTimeOffset.UtcNow.UtcDateTime.AddHours(2)</c> — a hardcoded shift that reads no
    /// setting at all — and that mutant passed it five tests to nil. So it proved "not UTC",
    /// which is not the rule; the rule is "the clock <c>tenant_settings.timezone</c> names".
    /// </para>
    /// <para>
    /// Kathmandu is the one that settles it: at +05:45 it is neither UTC nor a whole number of
    /// hours from it, so nothing that adds a constant number of hours can render its wall
    /// clock. New York is WEST of UTC, where a sign error passes every eastern fixture. And
    /// each case also asserts the two WRONG renderings are absent — UTC, and the +02:00 the
    /// old pin was accidentally measuring — which is what makes the mutant fail rather than
    /// merely fail to be proven.
    /// </para>
    /// </remarks>
    [Theory]
    [InlineData("Africa/Johannesburg")]
    [InlineData("Asia/Kathmandu")]
    [InlineData("America/New_York")]
    public async Task A_receipt_stamps_issued_in_the_clock_the_club_configured(string timezone)
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        // The fixture runs the club at UTC, which is the one timezone in which this defect is
        // invisible — the same reason A_booking_charges_comment_is_in_the_clubs_wall_clock
        // moves it.
        var settingsRow = await db.TenantSettings.FirstAsync(x => x.TenantId == host.Tenant.Id);
        settingsRow.SettingsJson = settingsRow.SettingsJson.Replace("\"timezone\":\"UTC\"", $"\"timezone\":\"{timezone}\"");
        await db.SaveChangesAsync();

        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var bookings = scope.ServiceProvider.GetRequiredService<BookingService>();
        await ledger.PostAsync(new LedgerPosting(host.LeaguePlayerUser.Id, LedgerEntryType.TopUp, 200, host.LeaguePlayerUser.Id), default);

        // Peak hours are evaluated in the CLUB's clock, so a UTC-chosen slot can land inside
        // 16:00-19:00 local — and a league/senior member is exempt from that rule anyway, which
        // is why this books as one rather than as the Regular player.
        var clubTz = TimeZoneInfo.FindSystemTimeZoneById(timezone);
        var startsAt = TestHost.BookableSlotFrom(TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, clubTz), 2);

        var before = DateTimeOffset.UtcNow;
        Assert.IsType<BookingResult.Ok>(await bookings.CreateAsync(
            host.Courts[0].Id, host.LeaguePlayerUser.Id, host.LeaguePlayerUser.Id, startsAt, sliceCount: 1, default));
        var after = DateTimeOffset.UtcNow;

        var confirmation = await Poll(() => host.EmailService.Sent
            .FirstOrDefault(m => m.Subject.StartsWith("Booking confirmed", StringComparison.Ordinal)));
        Assert.NotNull(confirmation);
        var text = TextOf(Assert.Single(confirmation!.Attachments ?? []).Content);

        // The stamp the club's OWN clock produces. One of the two instants, because the minute
        // can tick between the call and the assertion.
        Assert.True(
            text.Contains(StampIn(before, clubTz.GetUtcOffset(before)), StringComparison.Ordinal) ||
            text.Contains(StampIn(after, clubTz.GetUtcOffset(after)), StringComparison.Ordinal),
            $"the Issued stamp is not the wall clock of {timezone}");

        // And every clock that is NOT the club's is absent — including the literal that
        // labelled the old one.
        Assert.DoesNotContain("UTC", text, StringComparison.Ordinal);
        foreach (var wrong in new[] { TimeSpan.Zero, TimeSpan.FromHours(2) })
        {
            if (wrong == clubTz.GetUtcOffset(before)) { continue; }
            Assert.DoesNotContain(StampIn(before, wrong), text, StringComparison.Ordinal);
            Assert.DoesNotContain(StampIn(after, wrong), text, StringComparison.Ordinal);
        }
    }

    /// <summary>The receipt's "Issued" rendering of an instant at a given offset.</summary>
    private static string StampIn(DateTimeOffset at, TimeSpan offset) =>
        at.ToOffset(offset).ToString(Crusaders.Mainframe.Api.Services.ClubDate.WithYear, CultureInfo.InvariantCulture);
}
