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
    // ---- Emails are in credits, and quote the tenant's own policy ----------

    /// <summary>
    /// "Charged R50,00" for a court that cost R31.25 at the club's 1.6 rate. Every figure in
    /// both money emails is credits, and <c>CLAUDE.md</c> calls a field that mixes the two
    /// units a money-correctness bug.
    /// </summary>
    [Fact]
    public void The_booking_confirmation_states_credits_and_never_rand()
    {
        var mail = EmailTemplates.BookingConfirmation("member@test.local", new BookingConfirmationDetails(
            CourtName: "Court 3", StartsAtLocal: "Wed 16 Sep 10:00", Duration: "15 min",
            AmountCredits: 50m, BalanceAfterCredits: 60m,
            PenaltyWindowMinutes: 15, PenaltyPct: 30m));

        Assert.Contains("50.00 credits", mail.HtmlBody);
        Assert.Contains("60.00 credits", mail.HtmlBody);
        Assert.DoesNotContain("R50", mail.HtmlBody);
        Assert.DoesNotContain("R60", mail.HtmlBody);
    }

    [Fact]
    public void The_cancellation_email_states_credits_and_never_rand()
    {
        var mail = EmailTemplates.BookingCancellation("member@test.local", "Court 4", 50m, 15m);

        Assert.Contains("50.00 credits", mail.HtmlBody);
        Assert.Contains("15.00 credits", mail.HtmlBody);
        Assert.DoesNotContain("R50", mail.HtmlBody);
        Assert.DoesNotContain("R15", mail.HtmlBody);
    }

    /// <summary>
    /// The template hardcoded "within 15 minutes … 30%" and went on saying it after the club
    /// moved to 30 minutes at 50%. Every configurable number is <c>tenant_settings.&lt;key&gt;</c>.
    /// </summary>
    [Fact]
    public void The_booking_confirmation_quotes_the_tenants_penalty_policy_not_a_literal()
    {
        var mail = EmailTemplates.BookingConfirmation("member@test.local", new BookingConfirmationDetails(
            "Court 3", "Wed 16 Sep 10:00", "15 min", 50m, 60m,
            PenaltyWindowMinutes: 30, PenaltyPct: 50m));

        Assert.Contains("within 30 minutes", mail.HtmlBody);
        Assert.Contains("50% penalty", mail.HtmlBody);
        Assert.DoesNotContain("15 minutes", mail.HtmlBody);
        Assert.DoesNotContain("30% penalty", mail.HtmlBody);
    }

    /// <summary>Money figures use one separator whatever the host's culture is.</summary>
    [Fact]
    public void Email_money_formatting_ignores_the_ambient_culture()
    {
        var previous = Thread.CurrentThread.CurrentCulture;
        try
        {
            Thread.CurrentThread.CurrentCulture = new CultureInfo("af-ZA");
            var mail = EmailTemplates.BookingCancellation("member@test.local", "Court 4", 50m, 15m);
            Assert.Contains("50.00 credits", mail.HtmlBody);
            Assert.DoesNotContain("50,00", mail.HtmlBody);
        }
        finally { Thread.CurrentThread.CurrentCulture = previous; }
    }

    /// <summary>
    /// Two templates required by <c>feature-spec.md</c> §11 since it was written, neither of
    /// which existed — so the one event where a member hands over real money, and the one
    /// where somebody else moves their balance, both sent nothing at all.
    /// </summary>
    [Fact]
    public void A_topup_confirmation_shows_the_rand_paid_the_rate_and_the_credits_received()
    {
        var mail = EmailTemplates.TopUpConfirmation(
            "member@test.local", amountZar: 100m, creditsAdded: 160m,
            conversionRate: 1.6m, balanceAfterCredits: 210m, reference: "1089250");

        Assert.Contains("R100.00", mail.HtmlBody);
        Assert.Contains("1.6 credits per R1", mail.HtmlBody);
        Assert.Contains("160.00 credits", mail.HtmlBody);
        Assert.Contains("210.00 credits", mail.HtmlBody);
        Assert.Contains("1089250", mail.HtmlBody);
    }

    [Theory]
    [InlineData(25, "Credit added")]
    [InlineData(-10, "Credit deducted")]
    public void A_credit_adjustment_email_says_which_way_the_money_went(double amount, string expectedSubject)
    {
        var mail = EmailTemplates.CreditAdjustment("member@test.local", (decimal)amount, 145m, "desk credit");

        Assert.StartsWith(expectedSubject, mail.Subject);
        Assert.Contains("145.00 credits", mail.HtmlBody);
        Assert.Contains("desk credit", mail.HtmlBody);
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
    public void An_admin_adjustment_names_the_club_as_the_counterparty(double amount, string from, string to)
    {
        var member = Guid.NewGuid();
        var admin = Guid.NewGuid();
        var row = LedgerRowMapper.Build(
            new LedgerEntry
            {
                UserId = member,
                ActorUserId = admin,
                Type = LedgerEntryType.AdminAdjustment,
                AmountCredits = (decimal)amount,
                Reason = "desk credit",
            },
            id => id == member ? "Naledi Khoza" : "Crusaders Admin");

        Assert.Equal(from, row.From);
        Assert.Equal(to, row.To);
        // Who did it is not lost — it moves to the field a statement should carry it in.
        Assert.Equal("Crusaders Admin", row.ActorName);
    }

    // ---- F12 / F16: what an adjustment endpoint will accept ---------------

    /// <summary>
    /// <c>ledger_entries.AmountCredits</c> is <c>numeric(10,2)</c>. Above it, an unvalidated
    /// insert answered a member-facing 500 with a Postgres overflow dump; below it, 0.005 was
    /// stored as 0.01 and echoed back as 0.005 — half a cent from nothing and an API response
    /// disagreeing with the ledger it had just written.
    /// </summary>
    [Theory]
    [InlineData(999999999999.0)]
    [InlineData(-999999999999.0)]
    [InlineData(0.005)]
    [InlineData(1.001)]
    public void An_adjustment_outside_what_the_column_holds_is_refused(double amount)
        => Assert.NotNull(WalletEndpoints.RefuseAmount((decimal)amount));

    [Theory]
    [InlineData(0.01)]
    [InlineData(-10.5)]
    [InlineData(99999999.99)]
    public void An_adjustment_the_column_holds_exactly_is_accepted(double amount)
        => Assert.Null(WalletEndpoints.RefuseAmount((decimal)amount));

    // ---- F6: the presets a screen may offer -------------------------------

    [Fact]
    public void Presets_are_derived_from_the_tenants_block_and_cap()
    {
        Assert.Equal([100m, 200m, 500m, 1000m], TopUpEndpoints.Presets(100m, 1000m));
        Assert.Equal([50m, 100m, 250m, 300m], TopUpEndpoints.Presets(50m, 300m));
        // Nothing above the cap, and nothing that is not a whole block.
        Assert.Equal([100m, 200m], TopUpEndpoints.Presets(100m, 200m));
        Assert.Empty(TopUpEndpoints.Presets(0m, 1000m));
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
            Guid.NewGuid(), Guid.NewGuid(), "member@test.local", 100m, "tu_x",
            "https://club.example/return", "https://club.example/notify"), default);

        Assert.Equal("http://127.0.0.1:4545/eng/process", result.RedirectUrl);

        // Unset, the environment still decides — the override is additive, not a rewrite.
        var plain = new PayFastProvider(NullLogger<PayFastProvider>.Instance);
        var live = await plain.RegisterCheckoutAsync(new RegisterCheckoutRequest(
            new PerTenantCredentials("10000100", "46f0cd694581a", "pass", "production"),
            Guid.NewGuid(), Guid.NewGuid(), "member@test.local", 100m, "tu_x",
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
        LedgerEntry E(LedgerEntryType type, decimal credits) =>
            new() { UserId = user, ActorUserId = user, Type = type, AmountCredits = credits };

        var entries = new List<LedgerEntry>
        {
            E(LedgerEntryType.AdminAdjustment, 500m),      // opening balance
            E(LedgerEntryType.AdminAdjustment, 2000m),     // desk credit
            E(LedgerEntryType.TopUp, 160m),
            E(LedgerEntryType.BookingCharge, -850m),
            E(LedgerEntryType.LightsPurchase, -100m),
            E(LedgerEntryType.CancellationRefund, 100m),
            E(LedgerEntryType.LateCancellationPenalty, -15m),
        };

        var report = ReportingEndpoints.BuildWalletReport(
            entries, DateTimeOffset.UnixEpoch, DateTimeOffset.UtcNow,
            attendedBookings: 2, minutesOnCourt: 75);

        var json = System.Text.Json.JsonSerializer.SerializeToElement(report);
        Assert.Equal(160m, json.GetProperty("top_ups_credits").GetDecimal());
        Assert.Equal(950m, json.GetProperty("spent_credits").GetDecimal());
        Assert.Equal(100m, json.GetProperty("refunds_credits").GetDecimal());
        Assert.Equal(15m, json.GetProperty("penalties_credits").GetDecimal());
        Assert.Equal(2500m, json.GetProperty("adjustments_credits").GetDecimal());
        Assert.Equal(1, json.GetProperty("penalty_count").GetInt32());
        Assert.Equal(75, json.GetProperty("minutes_on_court").GetInt32());

        // The reconciliation itself: in − out + adjustments is the balance the wallet shows.
        var net = json.GetProperty("net_movement_credits").GetDecimal();
        Assert.Equal(1795m, net);
        Assert.Equal(entries.Sum(e => e.AmountCredits), net);
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
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 500m, host.PlayerUser.Id), default);

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
        var expected = TimeZoneInfo.ConvertTimeFromUtc(startsAt.UtcDateTime, tz)
            .ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture);

        Assert.Contains(expected, charge.Reason);
        // And the UTC rendering is gone, on any tenant whose clock is not UTC.
        if (tz.BaseUtcOffset != TimeSpan.Zero)
        {
            Assert.DoesNotContain(
                startsAt.UtcDateTime.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture),
                charge.Reason);
        }
    }
}
