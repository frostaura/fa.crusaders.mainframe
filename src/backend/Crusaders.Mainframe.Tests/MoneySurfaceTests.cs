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
            conversionRate: 1.6m, balanceAfterCredits: 210m, reference: "1089250",
            // A club on the default symbol. What happens when it is NOT the default is
            // CurrencySymbolTests' — this case is here to hold the shape of the mail itself.
            currencySymbol: CurrencySymbol.Default);

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

    // ---- R3 K-F4: a walk-up confirmation may not promise a refund ----------

    /// <summary>
    /// The confirmation for court time bought at the box said, verbatim, <i>"cancelling within
    /// 15 minutes of the start, or not turning the lights on, incurs a 30% penalty"</i> — under
    /// a heading "You're booked" and a "Starts" time for a court whose lights were already on.
    ///
    /// <para>
    /// Both halves are false for a walk-up. The session has started, and cancelling returns
    /// <b>nothing</b>, not 70%: <c>settlement-model.md</c> S4, and the server's own quote for
    /// exactly these bookings answers <c>refundCredits 0 / checkedIn true</c>. A member who
    /// acted on that sentence would be asking the club for 35 credits that were never coming.
    /// </para>
    /// </summary>
    [Fact]
    public void A_walk_up_confirmation_does_not_offer_a_refund_the_server_will_not_pay()
    {
        var walkUp = EmailTemplates.BookingConfirmation("member@test.local", new BookingConfirmationDetails(
            "Court 2", "Sun 06 Sep 22:51", "15 min", 50m, 100m,
            PenaltyWindowMinutes: 15, PenaltyPct: 30m, IsWalkUp: true));

        Assert.DoesNotContain("30% penalty", walkUp.HtmlBody);
        Assert.DoesNotContain("cancelling within", walkUp.HtmlBody);
        Assert.DoesNotContain("You're booked", walkUp.HtmlBody);
        Assert.Contains("not refunded once the lights have been on", walkUp.HtmlBody);
        Assert.Contains("You're on court", walkUp.HtmlBody);
        // "Starts" is wrong on a session that already has; the same figure, correctly labelled.
        Assert.Contains(">Started<", walkUp.HtmlBody);

        // And an ordinary reservation keeps the heads-up it is entitled to — the flag defaults
        // to false, so nothing that is not a walk-up loses it.
        var reservation = EmailTemplates.BookingConfirmation("member@test.local", new BookingConfirmationDetails(
            "Court 2", "Sun 06 Sep 22:51", "15 min", 50m, 100m,
            PenaltyWindowMinutes: 15, PenaltyPct: 30m));
        Assert.Contains("30% penalty", reservation.HtmlBody);
        Assert.Contains(">Starts<", reservation.HtmlBody);
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
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 200m, host.PlayerUser.Id), default);

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
        Assert.DoesNotContain("30% penalty", mail!.HtmlBody);
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
            "member@test.local", "Court 4", 50m, null,
            new ClubCancellation("Court double-booked by the desk", PenaltyWaived: true));

        Assert.Contains("The club cancelled your booking", byClub.HtmlBody);
        Assert.Contains("Court double-booked by the desk", byClub.HtmlBody);
        Assert.Contains("waived", byClub.HtmlBody);
        Assert.Contains("50.00 credits", byClub.HtmlBody);
        Assert.Contains("club", byClub.Subject);

        // A member cancelling their own court is a different event and keeps its own mail —
        // no actor, because there is nobody to name.
        var self = EmailTemplates.BookingCancellation("member@test.local", "Court 4", 50m, 15m);
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

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 200m, host.PlayerUser.Id), default);
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
        Assert.Equal(0m, ok.PenaltyCredits);

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

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 200m, host.PlayerUser.Id), default);
        var created = Assert.IsType<BookingResult.Ok>(await bookings.CreateAsync(
            host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id,
            TestHost.BookableSlot(2), sliceCount: 1, default));

        // Left where it was booked: two hours out, against a 15-minute penalty window. This
        // is the whole variable — the test above is the same call inside the window.
        var cancelled = await bookings.CancelAsync(
            created.Booking.Id, host.AdminUser.Id, actorIsAdmin: true, waivePenalty: true, default, reason);
        var ok = Assert.IsType<CancellationResult.Ok>(cancelled);

        // Nothing was waived because nothing was owed. The refund is the whole price.
        Assert.Equal(0m, ok.PenaltyCredits);
        Assert.Equal(created.Booking.AmountChargedCredits, ok.RefundedCredits);

        var audit = await db.AuditLogs
            .Where(a => a.Action == "booking.cancelled")
            .OrderByDescending(a => a.CreatedAt)
            .FirstAsync();
        using var details = System.Text.Json.JsonDocument.Parse(audit.DetailsJson!);
        var auditWaived = details.RootElement.GetProperty("waived").GetBoolean();
        var auditReason = details.RootElement.GetProperty("waive_reason");

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

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 200m, host.PlayerUser.Id), default);
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
        Assert.True(quote!.PenaltyCredits > 0m);

        // …and the member scans in at the box before Confirm is pressed.
        row.CheckedInAt = TestHost.Storable(DateTimeOffset.UtcNow);
        await db.SaveChangesAsync();

        var cancelled = await bookings.CancelAsync(
            row.Id, host.AdminUser.Id, actorIsAdmin: true, waivePenalty: true, default, reason);
        var ok = Assert.IsType<CancellationResult.Ok>(cancelled);

        // The lights have been on: no refund, no penalty, and therefore nothing waived.
        Assert.Equal(0m, ok.RefundedCredits);
        Assert.Equal(0m, ok.PenaltyCredits);

        var audit = await db.AuditLogs
            .Where(a => a.Action == "booking.cancelled")
            .OrderByDescending(a => a.CreatedAt)
            .FirstAsync();
        using var details = System.Text.Json.JsonDocument.Parse(audit.DetailsJson!);
        Assert.False(details.RootElement.GetProperty("waived").GetBoolean());
        // The club's only record of why it cancelled a court a member was standing on.
        Assert.Equal(reason, details.RootElement.GetProperty("waive_reason").GetString());

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
