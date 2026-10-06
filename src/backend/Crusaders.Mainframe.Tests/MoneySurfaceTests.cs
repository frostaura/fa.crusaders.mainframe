using System.Globalization;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Payments;
using Crusaders.Mainframe.Api.Payments.PayFast;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The money surfaces a member actually reads: the emails, the ledger row shapes, the
/// wallet report and the utilisation figures. Each of these was wrong in a way that only
/// showed up on a screen, which is why none of them had a test.
/// </summary>
public class MoneySurfaceTests
{
    /// <summary>
    /// The club these direct-to-template tests render for. Not Crusaders: a template that
    /// hardcoded the first club's name would be indistinguishable from one that resolved it.
    /// </summary>
    private static readonly ClubIdentity Club =
        new("Riverside Racquet Club", "+27 31 555 0188", "desk@riverside.review.test");

    // ---- Emails are in minutes, and quote the tenant's own policy ----------

    /// <summary>
    /// "Charged R50,00" for a court the member had not paid R50 for. Every figure in both
    /// booking emails is minutes, in prose and whole — never a decimal, never "credits", never
    /// a currency sign — and <c>CLAUDE.md</c> calls a field that mixes the two units a
    /// money-correctness bug. Varied across the three shapes the formatter has: under an hour,
    /// hours and minutes, and days from 24 h.
    /// </summary>
    [Theory]
    [InlineData(45, 90, "45 minutes", "1 hour 30 minutes")]
    [InlineData(90, 1500, "1 hour 30 minutes", "1 day 1 hour")]
    [InlineData(60, -45, "1 hour", "−45 minutes")]
    public void The_booking_confirmation_states_minutes_and_never_rand(int charged, int after, string chargedText, string afterText)
    {
        var mail = EmailTemplates.BookingConfirmation(Club, "member@test.local", new BookingConfirmationDetails(
            CourtName: "Court 3", StartsAtLocal: "Wed 16 Sep 10:00", Duration: "45 min",
            AmountMinutes: charged, BalanceAfterMinutes: after,
            PenaltyWindowMinutes: 15, PenaltyPct: 30m));

        foreach (var body in new[] { mail.HtmlBody, MailText.Unwrap(mail.PlainBody) })
        {
            Assert.Contains(chargedText, body);
            Assert.Contains(afterText, body);
            Assert.DoesNotContain("credit", body, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain(".00", body);
            Assert.DoesNotContain($"R{charged}", body);
        }
    }

    /// <summary>
    /// J6-6: a late cancel's preview line said "15 minutes back on your balance." while the
    /// member was 11 better off — the gross leg with the penalty beside it unmentioned, in the
    /// one line an inbox shows. The preview names both legs, as the no-show mail's does.
    /// </summary>
    [Fact]
    public void A_late_cancellations_preview_names_the_penalty_beside_the_refund()
    {
        var late = EmailTemplates.BookingCancellation(Club, "member@test.local", "Court 4", 15, 4);
        var free = EmailTemplates.BookingCancellation(Club, "member@test.local", "Court 4", 15, null);

        Assert.DoesNotContain("15 minutes back on your balance", late.HtmlBody);
        Assert.Contains("Refunded 15 minutes, less a late-cancellation penalty of 4 minutes.", late.HtmlBody);
        Assert.Contains("15 minutes back on your balance.", free.HtmlBody);
    }

    [Fact]
    public void The_cancellation_email_states_minutes_and_never_rand()
    {
        var mail = EmailTemplates.BookingCancellation(Club, "member@test.local", "Court 4", 90, 27);

        Assert.Contains("1 hour 30 minutes", mail.HtmlBody);
        Assert.Contains("27 minutes", mail.HtmlBody);
        Assert.DoesNotContain("credit", mail.HtmlBody, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("R90", mail.HtmlBody);
        Assert.DoesNotContain("R27", mail.HtmlBody);
    }

    /// <summary>
    /// The template hardcoded "within 15 minutes … 30%" and went on saying it after the club
    /// moved to 30 minutes at 50%. Every configurable number is <c>tenant_settings.&lt;key&gt;</c>.
    /// </summary>
    [Fact]
    public void The_booking_confirmation_quotes_the_tenants_penalty_policy_not_a_literal()
    {
        var mail = EmailTemplates.BookingConfirmation(Club, "member@test.local", new BookingConfirmationDetails(
            "Court 3", "Wed 16 Sep 10:00", "1 h 30 min", 90, 60,
            PenaltyWindowMinutes: 30, PenaltyPct: 50m));

        // Both bodies, because the plain-text half is the one nobody looks at and therefore
        // the one that would go on quoting the old policy unnoticed.
        foreach (var body in new[] { mail.HtmlBody, MailText.Unwrap(mail.PlainBody) })
        {
            Assert.Contains("30 minutes before the start", body);
            // Contract §6: "{penalty_pct}% of the booking's minutes ({Min(penalty)})" — 50% of 90.
            Assert.Contains("50% of the booking", body);
            Assert.Contains("minutes (45 minutes)", body);
            Assert.DoesNotContain("15 minutes", body);
            Assert.DoesNotContain("30% of the booking", body);
        }
        Assert.Contains("50% of the booking's minutes (45 minutes)", MailText.Unwrap(mail.PlainBody));
    }

    /// <summary>
    /// The figure the penalty sentence quotes is the one the server would charge: rounded DOWN
    /// to a whole minute, in the member's favour (contract §1.2). 30% of 45 is 13.5 — the mail
    /// says 13, and a mutant rounding to nearest or up says 14.
    /// </summary>
    [Theory]
    [InlineData(45, 30, 13)]
    [InlineData(50, 30, 15)]
    [InlineData(1, 99, 0)]
    [InlineData(90, 33.4, 30)]
    [InlineData(0, 30, 0)]
    [InlineData(60, 0, 0)]
    public void The_quoted_penalty_rounds_down_to_a_whole_minute(int charged, double pct, int expected)
    {
        Assert.Equal(expected, EmailTemplates.PenaltyOf(charged, (decimal)pct));

        var mail = EmailTemplates.BookingConfirmation(Club, "member@test.local", new BookingConfirmationDetails(
            "Court 3", "Wed 16 Sep 10:00", "45 min", charged, 100, PenaltyWindowMinutes: 15, PenaltyPct: (decimal)pct));
        Assert.Contains($"of the booking's minutes ({MoneyFormat.Minutes(expected)})", MailText.Unwrap(mail.PlainBody));
    }

    /// <summary>
    /// <b>A ledger reason is a money surface, and it was the last one still formatting a
    /// figure in the host's own culture.</b>
    /// </summary>
    /// <remarks>
    /// <para>
    /// <c>ReduceLitChargeAsync</c> built its reason with a bare <c>{back:0.00}</c>. That takes
    /// <see cref="CultureInfo.CurrentCulture"/>, and the club is in Durban North — so on the
    /// club's own <c>en-ZA</c> locale, which is the DEFAULT case and not an exotic one, the
    /// figure rendered "8,00". Every other credit figure in this system goes through the
    /// invariant formatter, so one booking could show "8,00 credits" on the line the lights
    /// were refunded on and "8.00 credits" on the charge directly above it, in the same wallet
    /// history, for the same court.
    /// </para>
    /// <para>
    /// Driven through <c>SettleReleaseAsync</c> rather than asserted against the formatter,
    /// because the formatter was never the thing that was wrong: the call site was. A test of
    /// <c>MoneyFormat.Credits</c> would have passed on the broken code.
    /// </para>
    /// <para>
    /// <b>The ambient culture is BUILT here, not named.</b> This first asked for
    /// <c>en-ZA</c>, because that is the club's own locale and it is the case the defect was
    /// found in. That made the test depend on a platform's opinion of a locale rather than on
    /// the only property it actually needs — a comma where the invariant culture puts a point.
    /// CLDR moved <c>en-ZA</c>'s decimal separator from a comma to a point, so a host with
    /// newer ICU renders the two identically, and the pair of assertions below became a
    /// contradiction that no code could satisfy: the same string both required and forbidden.
    /// It passed on macOS and failed on the Linux CI runner, which is the worst possible
    /// shape for a test, because the platform that disagrees is the one nobody is watching.
    /// A culture assembled from the invariant one with a single field changed says what is
    /// meant, cannot drift with the CLDR, and is identical on every host.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task A_ledger_reason_states_its_figure_in_the_invariant_culture()
    {
        var previous = Thread.CurrentThread.CurrentCulture;
        try
        {
            // A comma decimal separator — the property the club's own locale had when this was
            // found, stated directly instead of hoping a named locale still carries it.
            var commaDecimal = (CultureInfo)CultureInfo.InvariantCulture.Clone();
            commaDecimal.NumberFormat.NumberDecimalSeparator = ",";
            Thread.CurrentThread.CurrentCulture = commaDecimal;

            await using var host = await TestHost.CreateAsync();
            using var scope = host.NewScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
            var bookings = scope.ServiceProvider.GetRequiredService<BookingService>();

            await ledger.PostAsync(new LedgerPosting(
                host.PlayerUser.Id, LedgerEntryType.TopUp, 500, host.PlayerUser.Id), default);
            var created = Assert.IsType<BookingResult.Ok>(await bookings.CreateAsync(
                host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id,
                TestHost.BookableSlot(2), sliceCount: 1, default));
            await bookings.CancelAsync(created.Booking.Id, host.PlayerUser.Id, actorIsAdmin: false,
                waivePenalty: false, default);

            // The court was lit anyway, on the cancelled booking's code, and charged for the
            // whole grant. This is the row the release is about to reduce.
            var booking = await db.Bookings.FirstAsync(b => b.Id == created.Booking.Id);
            await ledger.PostAsync(new LedgerPosting(
                host.PlayerUser.Id, LedgerEntryType.LightsPurchase, -booking.AmountChargedMinutes,
                host.PlayerUser.Id, RelatedBookingId: booking.Id,
                Reason: "Lights on a cancelled booking"), default);

            // …and the relay says it was closed for one slice-minute, not the whole window.
            var settled = await bookings.SettleReleaseAsync(
                booking, litMinutes: 1, DateTimeOffset.UtcNow, host.PlayerUser.Id, default);
            Assert.Equal("charge_reduced", settled.Code);

            var reason = (await db.LedgerEntries
                .Where(l => l.RelatedBookingId == booking.Id
                            && l.Type == LedgerEntryType.LightsPurchase
                            && l.AmountMinutes > 0)
                .OrderByDescending(l => l.CreatedAt)
                .FirstAsync()).Reason;

            Assert.NotNull(reason);
            // Since P13 the figure is whole minutes in prose — there is no decimal separator
            // left to get wrong, and that is asserted rather than assumed: no comma figure, no
            // ".00", and the minutes the release returned, in MoneyFormat's words.
            Assert.True(settled.AmountMinutes > 0);
            Assert.Contains($"{MoneyFormat.Minutes(settled.AmountMinutes)} returned", reason!);
            Assert.DoesNotContain(settled.AmountMinutes.ToString("0.00", commaDecimal), reason!);
            Assert.DoesNotContain(".00", reason!);
            Assert.DoesNotContain("credit", reason!, StringComparison.OrdinalIgnoreCase);
        }
        finally { Thread.CurrentThread.CurrentCulture = previous; }
    }

    /// <summary>Money figures use one separator whatever the host's culture is.</summary>
    [Fact]
    public void Email_money_formatting_ignores_the_ambient_culture()
    {
        var previous = Thread.CurrentThread.CurrentCulture;
        try
        {
            Thread.CurrentThread.CurrentCulture = new CultureInfo("af-ZA");
            var mail = EmailTemplates.BookingCancellation(Club, "member@test.local", "Court 4", 1815, 15);
            Assert.Contains("1 day 6 hours 15 minutes", mail.HtmlBody);
            Assert.DoesNotContain("1,815", mail.HtmlBody);
            Assert.DoesNotContain(",00", mail.HtmlBody);
        }
        finally { Thread.CurrentThread.CurrentCulture = previous; }
    }

    /// <summary>
    /// The purchase confirmation (contract §6): the package, the minutes added, the list price,
    /// the discount line with the group it came from, the amount paid, the PayFast reference and
    /// the balance after — rand in the club's symbol, minutes in words, never mixed.
    /// </summary>
    [Fact]
    public void A_purchase_confirmation_shows_the_package_the_discount_the_rand_paid_and_the_minutes()
    {
        var mail = EmailTemplates.PurchaseConfirmation(Club, "member@test.local", new PackagePurchaseReceipt(
            PackageName: "5 hours", Minutes: 300, ListPriceZar: 550m, DiscountBps: 1000, DiscountGroupName: "League",
            AmountZar: 495m, BalanceAfterMinutes: 1530, Reference: "1089250",
            // A club on the default symbol. What happens when it is NOT the default is
            // CurrencySymbolTests' — this case is here to hold the shape of the mail itself.
            CurrencySymbol: CurrencySymbol.Default));

        foreach (var body in new[] { mail.HtmlBody, MailText.Unwrap(mail.PlainBody) })
        {
            Assert.Contains("5 hours", body);
            Assert.Contains("R550.00", body);
            Assert.Contains("10% off — League", body);
            Assert.Contains("R495.00", body);
            Assert.Contains("1089250", body);
            Assert.Contains("1 day 1 hour 30 minutes", body);
            Assert.DoesNotContain("credit", body, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("top up", body, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("top-up", body, StringComparison.OrdinalIgnoreCase);
        }
        Assert.Contains("5 hours", mail.Subject);
    }

    /// <summary>
    /// The discount line appears ONLY when a discount was applied — a member who paid list price
    /// is not shown "0% off" — and a fractional discount keeps its fraction ("12.5% off").
    /// </summary>
    [Theory]
    [InlineData(0, null, null)]
    [InlineData(1250, "Seniors", "12.5% off — Seniors")]
    [InlineData(10000, null, "100% off")]
    public void A_purchase_confirmation_shows_a_discount_line_only_when_there_was_one(int bps, string? group, string? expected)
    {
        var mail = EmailTemplates.PurchaseConfirmation(Club, "member@test.local", new PackagePurchaseReceipt(
            "1 hour", 60, 120m, bps, group, 120m * (10000 - bps) / 10000, 60, "pf-1", "R"));
        var text = MailText.Unwrap(mail.PlainBody);

        if (expected is null)
        {
            Assert.DoesNotContain("Discount", text);
            Assert.DoesNotContain("% off", text);
        }
        else
        {
            Assert.Contains($"Discount: {expected}", text);
        }
    }

    [Theory]
    [InlineData(45, "Minutes added — 45 minutes", "+45 minutes")]
    [InlineData(-90, "Minutes taken off — 1 hour 30 minutes", "−1 hour 30 minutes")]
    [InlineData(2880, "Minutes added — 2 days", "+2 days")]
    public void A_minutes_adjustment_email_says_which_way_the_minutes_went(int amount, string expectedSubject, string signed)
    {
        var mail = EmailTemplates.MinutesAdjusted(Club, "member@test.local", amount, 145, "lights failed on court 2");

        Assert.Equal(expectedSubject, mail.Subject);
        Assert.Contains(signed, MailText.Unwrap(mail.PlainBody));
        Assert.Contains("2 hours 25 minutes", mail.HtmlBody);
        Assert.Contains("lights failed on court 2", mail.HtmlBody);
        Assert.DoesNotContain("credit", mail.HtmlBody, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// A desk sale names the package, the minutes added, the money RECEIVED (which may differ
    /// from the shelf price, contract §3.7) and the balance after.
    /// </summary>
    [Fact]
    public void A_package_sold_at_the_desk_states_what_was_received_and_what_it_bought()
    {
        var mail = EmailTemplates.PackageSoldAtDesk(Club, "member@test.local", new DeskPackageSale("10 hours", 600, 900m, 645, "R"));

        foreach (var body in new[] { mail.HtmlBody, MailText.Unwrap(mail.PlainBody) })
        {
            Assert.Contains("10 hours", body);
            Assert.Contains("R900.00", body);
            Assert.Contains("10 hours 45 minutes", body);
            Assert.DoesNotContain("R600", body);
            Assert.DoesNotContain("credit", body, StringComparison.OrdinalIgnoreCase);
        }
        Assert.Contains("10 hours", mail.Subject);
    }

    // ---- F19: an adjustment is club money, not the admin's own -------------

    /// <summary>
    /// A negative adjustment rendered "Naledi Khoza → Crusaders Admin −10.00 cr" on the
    /// member's own statement, which reads as money handed to a person. Booking charges on
    /// the same statement correctly say "Club treasury".
    /// </summary>
    [Theory]
    [InlineData(-10, "Naledi Khoza", LedgerRowMapper.Treasury)]
    [InlineData(25, LedgerRowMapper.Treasury, "Naledi Khoza")]
    public void An_admin_adjustment_names_the_club_as_the_counterparty(int amount, string from, string to)
    {
        var member = Guid.NewGuid();
        var admin = Guid.NewGuid();
        var row = LedgerRowMapper.Build(
            new LedgerEntry
            {
                UserId = member,
                ActorUserId = admin,
                Type = LedgerEntryType.AdminAdjustment,
                AmountMinutes = amount,
                Reason = "desk credit",
            },
            id => id == member ? "Naledi Khoza" : "Crusaders Admin");

        Assert.Equal(from, row.From);
        Assert.Equal(to, row.To);
        // Who did it is not lost — it moves to the field a statement should carry it in.
        Assert.Equal("Crusaders Admin", row.ActorName);
    }

    // ---- F2: the process URL is configurable ------------------------------

    /// <summary>
    /// The redirect was a hardcoded sandbox/live constant reading no configuration, so a
    /// stack pointing at the mountebank imposter was ignored and the browser leg could only
    /// ever be driven by hand.
    /// </summary>
    [Fact]
    public async Task The_process_url_can_be_pointed_at_a_stand_in_gateway()
    {
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                [PayFastProvider.ProcessUrlConfigKey] = "http://127.0.0.1:4545/eng/process",
            }).Build();

        var provider = new PayFastProvider(NullLogger<PayFastProvider>.Instance, config);
        var result = await provider.RegisterCheckoutAsync(new RegisterCheckoutRequest(
            new PerTenantCredentials("10000100", "46f0cd694581a", "pass", "test"),
            Guid.NewGuid(), Guid.NewGuid(), "member@test.local", 100, "tu_x",
            "https://club.example/return", "https://club.example/notify"), default);

        Assert.Equal("http://127.0.0.1:4545/eng/process", result.RedirectUrl);

        // Unset, the environment still decides — the override is additive, not a rewrite.
        var plain = new PayFastProvider(NullLogger<PayFastProvider>.Instance);
        var live = await plain.RegisterCheckoutAsync(new RegisterCheckoutRequest(
            new PerTenantCredentials("10000100", "46f0cd694581a", "pass", "production"),
            Guid.NewGuid(), Guid.NewGuid(), "member@test.local", 100, "tu_x",
            "https://club.example/return", "https://club.example/notify"), default);
        Assert.Equal(PayFastProvider.Live, live.RedirectUrl);
    }

    // ---- B-F9: the member's report reconciles to their balance ------------

    /// <summary>
    /// The report showed top-ups, spend, refunds and a penalty count and nothing else, so a
    /// member with 2,500 credits of admin adjustments read "0 in, 950 out, 100 back" beside
    /// a header saying 1,635. Every bucket a movement can land in is reported, and their sum
    /// is what the balance moved by.
    /// </summary>
    [Fact]
    public void The_wallet_report_accounts_for_every_movement_in_the_window()
    {
        var user = Guid.NewGuid();
        LedgerEntry E(LedgerEntryType type, int credits) =>
            new() { UserId = user, ActorUserId = user, Type = type, AmountMinutes = credits };

        var entries = new List<LedgerEntry>
        {
            E(LedgerEntryType.AdminAdjustment, 500),      // opening balance
            E(LedgerEntryType.AdminAdjustment, 2000),     // desk credit
            E(LedgerEntryType.TopUp, 160),
            E(LedgerEntryType.BookingCharge, -850),
            E(LedgerEntryType.LightsPurchase, -100),
            E(LedgerEntryType.CancellationRefund, 100),
            E(LedgerEntryType.LateCancellationPenalty, -15),
        };

        var report = ReportingEndpoints.BuildWalletReport(
            entries, DateTimeOffset.UnixEpoch, DateTimeOffset.UtcNow,
            attendedBookings: 2, minutesOnCourt: 75);

        var json = System.Text.Json.JsonSerializer.SerializeToElement(report);
        Assert.Equal(160m, json.GetProperty("top_ups_minutes").GetDecimal());
        Assert.Equal(950m, json.GetProperty("spent_minutes").GetDecimal());
        Assert.Equal(100m, json.GetProperty("refunds_minutes").GetDecimal());
        Assert.Equal(15m, json.GetProperty("penalties_minutes").GetDecimal());
        Assert.Equal(2500m, json.GetProperty("adjustments_minutes").GetDecimal());
        Assert.Equal(1, json.GetProperty("penalty_count").GetInt32());
        Assert.Equal(75, json.GetProperty("minutes_on_court").GetInt32());

        // The reconciliation itself: in − out + adjustments is the balance the wallet shows.
        var net = json.GetProperty("net_movement_minutes").GetDecimal();
        Assert.Equal(1795, net);
        Assert.Equal(entries.Sum(e => e.AmountMinutes), net);
    }

    // ---- F10 / B-F7: ledger comments in the club's wall clock -------------

    /// <summary>
    /// The comment is the one line a member reads when disputing a charge, and it named a
    /// slot two hours from the one they booked — "Booking Court 3 2026-09-16 08:00" for a
    /// 10:00 court, while the email and the wallet's own Time column both said 10:00.
    /// </summary>
    [Fact]
    public async Task A_booking_charges_comment_is_in_the_clubs_wall_clock()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        // TestHost's fixture runs the club at UTC, which is the one timezone in which this
        // defect is invisible. Move it to the club's own — the seeder's default, and what
        // Crusaders actually runs on — or the assertion below proves nothing.
        var settingsRow = await db.TenantSettings.FirstAsync(s => s.TenantId == host.Tenant.Id);
        settingsRow.SettingsJson = settingsRow.SettingsJson.Replace("\"timezone\":\"UTC\"", "\"timezone\":\"Africa/Johannesburg\"");
        await db.SaveChangesAsync();

        var bookings = scope.ServiceProvider.GetRequiredService<BookingService>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 500, host.PlayerUser.Id), default);

        // The slot is chosen in the CLUB's clock, not in UTC.
        //
        // `BookableSlot()` steps clear of 15:00-19:00 in whatever offset it is handed, and
        // its default is UTC — which is right for every other test, because the fixture's
        // club runs at UTC. This test has just moved the club to Africa/Johannesburg, and
        // `peak_hours` is evaluated in the club's local time: 16:00-19:00 SAST is
        // 14:00-17:00 UTC, so a UTC-chosen 14:30 slot is peak here and a Regular member is
        // refused it. That made this test fail for roughly two hours of every day and pass
        // for the other twenty-two, which is worse than failing outright.
        var clubTz = TimeZoneInfo.FindSystemTimeZoneById("Africa/Johannesburg");
        var startsAt = TestHost.BookableSlotFrom(TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, clubTz), 2);
        var result = await bookings.CreateAsync(
            host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, startsAt, sliceCount: 1, default);
        Assert.IsType<BookingResult.Ok>(result);

        var charge = await db.LedgerEntries.FirstAsync(l => l.Type == LedgerEntryType.BookingCharge);

        var settings = await scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>().GetAsync(default);
        var tz = TimeZoneInfo.FindSystemTimeZoneById(settings.Timezone);
        Assert.Equal(clubTz.Id, tz.Id);
        // In the club's own date words since review round 1 (lane F4): "Booking Court 1 · Thu 1 Oct, 10:00".
        var expected = TimeZoneInfo.ConvertTimeFromUtc(startsAt.UtcDateTime, tz)
            .ToString(ClubDate.Format, CultureInfo.InvariantCulture);

        Assert.Contains(expected, charge.Reason);
        Assert.Contains(" · ", charge.Reason);
        // And the UTC rendering is gone, on any tenant whose clock is not UTC.
        if (tz.BaseUtcOffset != TimeSpan.Zero)
        {
            Assert.DoesNotContain(
                startsAt.UtcDateTime.ToString(ClubDate.Format, CultureInfo.InvariantCulture),
                charge.Reason);
        }
    }

    // ---- R3 K-F4: a walk-up confirmation may not promise a refund ----------

    /// <summary>
    /// The confirmation for court time bought at the box said, verbatim, <i>"cancelling within
    /// 15 minutes of the start, or not turning the lights on, incurs a 30% penalty"</i> — under
    /// a heading "You're booked" and a "Starts" time for a court whose lights were already on.
    ///
    /// <para>
    /// Both halves are false for a walk-up. The session has started, and cancelling returns
    /// <b>nothing</b>, not 70%: <c>settlement-model.md</c> S4, and the server's own quote for
    /// exactly these bookings answers <c>refundMinutes 0 / checkedIn true</c>. A member who
    /// acted on that sentence would be asking the club for 35 credits that were never coming.
    /// </para>
    /// </summary>
    [Fact]
    public void A_walk_up_confirmation_does_not_offer_a_refund_the_server_will_not_pay()
    {
        var walkUp = EmailTemplates.BookingConfirmation(Club, "member@test.local", new BookingConfirmationDetails(
            "Court 2", "Sun 06 Sep 22:51", "15 min", 50, 100,
            PenaltyWindowMinutes: 15, PenaltyPct: 30m, IsWalkUp: true));

        // The text part as well as the HTML: a promise the server will not keep is no less
        // false for being in the half a plain-text client renders.
        foreach (var body in new[] { walkUp.HtmlBody, MailText.Unwrap(walkUp.PlainBody) })
        {
            Assert.DoesNotContain("30% of the booking", body);
            Assert.DoesNotContain("Cancel more than", body);
            Assert.DoesNotContain("You&#39;re booked", body);
            Assert.DoesNotContain("You're booked", body);
            Assert.Contains("not refunded once the lights have been on", body);
        }
        Assert.Contains("You&#39;re on court", walkUp.HtmlBody);
        Assert.Contains("You're on court", walkUp.PlainBody!);
        // "Starts" is wrong on a session that already has; the same figure, correctly labelled.
        Assert.Contains(">Started</th>", walkUp.HtmlBody);
        Assert.Contains("Started: Sun 06 Sep 22:51", walkUp.PlainBody!);

        // And an ordinary reservation keeps the heads-up it is entitled to — the flag defaults
        // to false, so nothing that is not a walk-up loses it.
        var reservation = EmailTemplates.BookingConfirmation(Club, "member@test.local", new BookingConfirmationDetails(
            "Court 2", "Sun 06 Sep 22:51", "15 min", 50, 100,
            PenaltyWindowMinutes: 15, PenaltyPct: 30m));
        Assert.Contains("30% of the booking&#39;s minutes (15 minutes)", reservation.HtmlBody);
        Assert.Contains(">Starts</th>", reservation.HtmlBody);
    }

    /// <summary>
    /// The same, through the path that actually sends it: a walk-up bought at the box. The
    /// template can only be right if <c>BookingService</c> tells it which kind of booking this
    /// is, and the flag is set from <c>NewBooking.IsWalkUp</c> — the same field that decides
    /// whether the charge posts as a <see cref="LedgerEntryType.LightsPurchase"/>.
    ///
    /// <para>
    /// A walk-up never sends it from inside the commit, so this exercises the shape production
    /// runs rather than one beside it. The deferral is the fix for a false sentence: mailed
    /// from inside the commit, "it has already started… not
    /// refunded once the lights have been on" went out before the activation that lights the
    /// court, and was untrue on the refusal path. Both halves are asserted here — that nothing
    /// is sent until the caller says the court is lit, and that the same mail is sent when it
    /// does.
    /// </para>
    /// </summary>
    [Fact]
    public async Task Buying_court_time_at_the_box_emails_the_walk_up_terms_and_not_the_penalty()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var bookings = scope.ServiceProvider.GetRequiredService<BookingService>();

        // A walk-up is sold from UtcNow and truncated at the club's closing time, so move the
        // club rather than the purchase — see TestHost.ClearOfClosingAsync.
        await TestHost.ClearOfClosingAsync(db, host.Tenant.Id, 15);
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 200, host.PlayerUser.Id), default);

        var result = await bookings.CreateWalkUpAsync(
            host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, 15, $"walkup:test:{Guid.NewGuid():N}", default);
        var ok = Assert.IsType<BookingResult.Ok>(result);

        // Held, not lost. Nothing is in flight yet — the send has not been reached, let alone
        // queued — so this needs no wait to be sound.
        Assert.NotNull(ok.SendConfirmationAsync);
        Assert.DoesNotContain(host.EmailService.Sent, m => m.Subject.StartsWith("Court time started", StringComparison.Ordinal));

        await ok.SendConfirmationAsync!(default);

        var mail = await PollMail(host, m => m.Subject.StartsWith("Court time started", StringComparison.Ordinal));
        Assert.NotNull(mail);
        Assert.DoesNotContain("30% of the booking", mail!.HtmlBody);
        Assert.Contains("not refunded once the lights have been on", mail.HtmlBody);
    }

    // ---- R3 K-F7: an admin cancellation says who did it, and why -----------

    /// <summary>
    /// A booking the club cancelled on a member's behalf arrived as a mail indistinguishable
    /// from one the member sent themselves — no actor, no reason, no mention that the penalty
    /// had been waived — while the audit row beside it carried all three. Email is the only
    /// channel the member has; the grid just shows the slot free again.
    /// </summary>
    [Fact]
    public void A_club_cancellation_names_the_club_the_reason_and_the_waiver()
    {
        var byClub = EmailTemplates.BookingCancellation(
            Club, "member@test.local", "Court 4", 50, null,
            new ClubCancellation("Court double-booked by the desk", PenaltyWaived: true));

        Assert.Contains("The club cancelled your booking", byClub.HtmlBody);
        Assert.Contains("Court double-booked by the desk", byClub.HtmlBody);
        Assert.Contains("waived", byClub.HtmlBody);
        Assert.Contains("50 minutes", byClub.HtmlBody);
        Assert.Contains("club", byClub.Subject);

        // A member cancelling their own court is a different event and keeps its own mail —
        // no actor, because there is nobody to name.
        var self = EmailTemplates.BookingCancellation(Club, "member@test.local", "Court 4", 50, 15);
        Assert.DoesNotContain("The club cancelled", self.HtmlBody);
        Assert.DoesNotContain("waived", self.HtmlBody);
        Assert.Equal("Booking cancelled — Court 4", self.Subject);
    }

    /// <summary>
    /// And through the path that sends it, inside the penalty window — where there is a
    /// penalty to waive, and the two stories agreed even before they came from one value.
    ///
    /// <para>
    /// <b>This case alone proves nothing about the general rule.</b> It used to carry a
    /// sentence saying the reason reaching the member is the reason the audit row records,
    /// "one value, quoted twice" — and that was false: the audit row recorded the admin's
    /// TICK while the mail recorded the OUTCOME, and the reason was gated differently again.
    /// The two agreed here only because inside the window with a penalty on the row, tick
    /// and outcome are the same thing. A refuter drove the case where they are not, on a
    /// live stack, and got <c>{"waived": true, "waive_reason": null}</c> in the club's report
    /// beside a mail printing the reason and mentioning no waiver.
    /// <see cref="A_waiver_that_did_not_happen_is_absent_from_both_records_and_the_reason_still_travels"/>
    /// is that case, and it is the one that holds the rule up.
    /// </para>
    /// </summary>
    [Fact]
    public async Task An_admin_cancelling_for_a_member_emails_them_the_actor_and_the_reason()
    {
        const string reason = "Court double-booked by the desk";

        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var bookings = scope.ServiceProvider.GetRequiredService<BookingService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 200, host.PlayerUser.Id), default);
        var created = Assert.IsType<BookingResult.Ok>(await bookings.CreateAsync(
            host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id,
            TestHost.BookableSlot(2), sliceCount: 1, default));

        // Pull the slot inside the penalty window, which is the only state in which there is a
        // penalty to waive at all.
        var row = await db.Bookings.FirstAsync(b => b.Id == created.Booking.Id);
        var length = row.EndsAt - row.StartsAt;
        row.StartsAt = TestHost.Storable(DateTimeOffset.UtcNow.AddMinutes(5));
        row.EndsAt = row.StartsAt + length;
        await db.SaveChangesAsync();

        var cancelled = await bookings.CancelAsync(
            row.Id, host.AdminUser.Id, actorIsAdmin: true, waivePenalty: true, default, reason);
        var ok = Assert.IsType<CancellationResult.Ok>(cancelled);
        Assert.Equal(0, ok.PenaltyMinutes);

        var mail = await PollMail(host, m => m.Subject.Contains("club", StringComparison.Ordinal));
        Assert.NotNull(mail);
        Assert.Contains("The club cancelled your booking", mail!.HtmlBody);
        Assert.Contains(reason, mail.HtmlBody);
        Assert.Contains("waived", mail.HtmlBody);
    }

    /// <summary>
    /// An admin ticking "waive the penalty" on a cancellation that carries no penalty waives
    /// nothing — and the club's report and the member's mail must both say so, in the same
    /// words, because they are the same value. <b>The reason is a different fact and is
    /// recorded anyway</b>, in both records, because the club still cancelled the court.
    ///
    /// <para>
    /// The refuted case, pinned. Outside the penalty window <c>SettleCancellation</c> charges
    /// nothing whether the box is ticked or not, so the tick is a request that was never
    /// needed. The audit row used to record it anyway as <c>waived: true</c> — the club's own
    /// month-end waiver report counting a waiver that never happened — while suppressing the
    /// reason, and the mail did the exact opposite. No money differs in either version, which
    /// is precisely why nothing caught it: the defect is in the records, and the records are
    /// what a disputed cancellation is settled from.
    /// </para>
    ///
    /// <para>
    /// <b>The over-correction is pinned here too, and it is the second half of this test.</b>
    /// Agreeing the two records by gating the REASON on the derived waiver as well deleted
    /// the desk's own words from both at once — a club cancellation whose mail carried no
    /// "Reason given by the club" line at all, against a §11 bullet that promises one. So
    /// this asserts the pair in opposite directions: no waiver anywhere, reason everywhere.
    /// </para>
    ///
    /// <para>
    /// This particular shape — the tick outside the window — is not reachable from the
    /// console, since the waive control renders only on a penalty-bearing quote, so it drives
    /// the service directly the way the refuter drove the raw API.
    /// <see cref="A_scan_in_between_the_quote_and_the_confirm_still_records_the_club_s_reason"/>
    /// is the same collapse reached from the console, and that one a member can cause.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_waiver_that_did_not_happen_is_absent_from_both_records_and_the_reason_still_travels()
    {
        const string reason = "Court double-booked by the desk";

        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var bookings = scope.ServiceProvider.GetRequiredService<BookingService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 200, host.PlayerUser.Id), default);
        var created = Assert.IsType<BookingResult.Ok>(await bookings.CreateAsync(
            host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id,
            TestHost.BookableSlot(2), sliceCount: 1, default));

        // Left where it was booked: two hours out, against a 15-minute penalty window. This
        // is the whole variable — the test above is the same call inside the window.
        var cancelled = await bookings.CancelAsync(
            created.Booking.Id, host.AdminUser.Id, actorIsAdmin: true, waivePenalty: true, default, reason);
        var ok = Assert.IsType<CancellationResult.Ok>(cancelled);

        // Nothing was waived because nothing was owed. The refund is the whole price.
        Assert.Equal(0, ok.PenaltyMinutes);
        Assert.Equal(created.Booking.AmountChargedMinutes, ok.RefundedMinutes);

        var audit = await db.AuditLogs
            .Where(a => a.Action == "booking.cancelled")
            .OrderByDescending(a => a.CreatedAt)
            .FirstAsync();
        using var details = System.Text.Json.JsonDocument.Parse(audit.DetailsJson!);
        var auditWaived = details.RootElement.GetProperty("waived").GetBoolean();
        // R17 E17-7: the desk's words are the cancellation's `reason`; `waive_reason` only when a penalty was waived.
        var auditReason = details.RootElement.GetProperty("reason");
        Assert.Equal(System.Text.Json.JsonValueKind.Null, details.RootElement.GetProperty("waive_reason").ValueKind);

        // The club's report: no waiver — and the reason the desk typed, kept, because the
        // club did cancel this court and this row is the only place that survives.
        Assert.False(auditWaived);
        Assert.Equal(reason, auditReason.GetString());

        var mail = await PollMail(host, m => m.Subject.Contains("club", StringComparison.Ordinal));
        Assert.NotNull(mail);
        Assert.Contains("The club cancelled your booking", mail!.HtmlBody);

        // And the member's mail says exactly what the audit row says. Asserted as the SAME
        // two facts rather than as two independent strings, because "they agree" is the rule
        // and a pair of literals would go on passing while they drifted apart again.
        Assert.Equal(auditWaived, mail.HtmlBody.Contains("was waived", StringComparison.Ordinal));
        Assert.Equal(
            auditReason.ValueKind is not System.Text.Json.JsonValueKind.Null,
            mail.HtmlBody.Contains(reason, StringComparison.Ordinal));

        // Stated once more as literals, so a reader can see which way round the agreement
        // fell without re-deriving it: nothing waived, nothing said about a waiver — and the
        // reason present on both sides, under the words §11 promises it in.
        Assert.DoesNotContain("was waived", mail.HtmlBody);
        Assert.Contains("Reason given by the club", mail.HtmlBody);
        Assert.Contains(reason, mail.HtmlBody);
    }

    /// <summary>
    /// The console-reachable collapse, and the one a MEMBER can cause: a scan-in landing
    /// between the cancellation quote and the confirm.
    ///
    /// <para>
    /// The desk opens the modal on a booking inside the penalty window, so the quote carries
    /// a penalty and the waive control renders; the admin ticks it and types why. Before they
    /// press Confirm the member scans in at the box. <c>SettleCancellation</c> now returns
    /// <c>(0, 0)</c> whichever way it is asked — the lights have been on — so nothing is
    /// refunded, nothing is charged and <c>waived</c> derives <b>false</b>, which is right:
    /// the club gave nothing up. The reason is a different fact and must survive it.
    /// </para>
    ///
    /// <para>
    /// Gated on the waiver it did not survive, and the loss was total rather than partial.
    /// <c>Booking.CancellationReason</c> is not a second copy of the desk's words: it is the
    /// displacement marker the resale path writes <c>ResoldTailRefunded</c> into and the money
    /// path reads back as a discriminator (<c>settlement-model.md</c> I5 / S8), and this
    /// cancellation path never writes it. So the audit row is the only record there is, and
    /// the mail was the member's only notice. A club that cancelled a court mid-session then
    /// held no answer to "why?" at all.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_scan_in_between_the_quote_and_the_confirm_still_records_the_club_s_reason()
    {
        // No apostrophe in the reason on purpose: the template HTML-encodes it (an admin's
        // free text lands in somebody else's mail), so a literal assertion on the raw string
        // would fail on the encoding rather than on the rule this test is about.
        const string reason = "Roof leak over court 1 — duty manager pulled it";

        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var bookings = scope.ServiceProvider.GetRequiredService<BookingService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 200, host.PlayerUser.Id), default);
        var created = Assert.IsType<BookingResult.Ok>(await bookings.CreateAsync(
            host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id,
            TestHost.BookableSlot(2), sliceCount: 1, default));

        // Inside the penalty window, which is the state the console requires before it will
        // render the waive control at all — this is what the desk was quoted.
        var row = await db.Bookings.FirstAsync(b => b.Id == created.Booking.Id);
        var length = row.EndsAt - row.StartsAt;
        row.StartsAt = TestHost.Storable(DateTimeOffset.UtcNow.AddMinutes(5));
        row.EndsAt = row.StartsAt + length;
        await db.SaveChangesAsync();

        var quote = await bookings.QuoteCancellationAsync(row.Id, host.AdminUser.Id, actorIsAdmin: true, default);
        Assert.NotNull(quote);
        // The precondition for the whole race: the desk saw a penalty, so it saw the control.
        Assert.True(quote!.PenaltyMinutes > 0);

        // …and the member scans in at the box before Confirm is pressed.
        row.CheckedInAt = TestHost.Storable(DateTimeOffset.UtcNow);
        await db.SaveChangesAsync();

        var cancelled = await bookings.CancelAsync(
            row.Id, host.AdminUser.Id, actorIsAdmin: true, waivePenalty: true, default, reason);
        var ok = Assert.IsType<CancellationResult.Ok>(cancelled);

        // The lights have been on: no refund, no penalty, and therefore nothing waived.
        Assert.Equal(0, ok.RefundedMinutes);
        Assert.Equal(0, ok.PenaltyMinutes);

        var audit = await db.AuditLogs
            .Where(a => a.Action == "booking.cancelled")
            .OrderByDescending(a => a.CreatedAt)
            .FirstAsync();
        using var details = System.Text.Json.JsonDocument.Parse(audit.DetailsJson!);
        Assert.False(details.RootElement.GetProperty("waived").GetBoolean());
        // The club's only record of why it cancelled a court a member was standing on (R17 E17-7: as `reason`;
        // nothing was waived, so no `waive_reason`).
        Assert.Equal(reason, details.RootElement.GetProperty("reason").GetString());
        Assert.Equal(System.Text.Json.JsonValueKind.Null, details.RootElement.GetProperty("waive_reason").ValueKind);

        var mail = await PollMail(host, m => m.Subject.Contains("club", StringComparison.Ordinal));
        Assert.NotNull(mail);
        Assert.Contains("Reason given by the club", mail!.HtmlBody);
        Assert.Contains(reason, mail.HtmlBody);
        Assert.DoesNotContain("was waived", mail.HtmlBody);
    }

    /// <summary>Waits for a background send rather than racing it.</summary>
    private static async Task<Api.Email.EmailMessage?> PollMail(
        TestHost host, Func<Api.Email.EmailMessage, bool> match, int timeoutMs = 5000)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow < deadline)
        {
            var found = host.EmailService.Sent.FirstOrDefault(match);
            if (found is not null) return found;
            await Task.Delay(25);
        }
        return host.EmailService.Sent.FirstOrDefault(match);
    }
}
