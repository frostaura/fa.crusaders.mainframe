using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// <c>feature-spec.md</c> §8, third admin action: "Book on behalf of any member (charges
/// that member's credit; <b>if insufficient, admin can override and create a negative
/// balance, logged</b>)."
///
/// <para>
/// The override did not exist. <c>BookingService.CreateAsync</c> checked
/// <c>balance &lt; totalCost</c> unconditionally, outside the <c>if (!isAdminActor)</c>
/// block that guards the other admin bypasses, so a club desk could not book for the one
/// member the promise exists for — the one who is short. The sentence had been in the spec
/// long enough to be believed; a false claim in a spec is worse than an open finding.
/// </para>
///
/// <para>
/// What these pin is the shape of the override, not just its existence: it is asked for by
/// name (an admin does not get it for being an admin), it is an admin's alone — on their own
/// wallet too since decision R19 — it is audited with the actor, the member and the balance it left behind, and
/// it changes nothing about the money model. <c>settlement-model.md</c> S1 still says
/// <c>Owed(b) = P</c> and I1 still bounds it at <c>[0, P]</c>: the debit is the same
/// <c>BookingCharge</c> of the same price. What moves is the wallet, which is a sum over the
/// ledger and has never been constrained to be non-negative.
/// </para>
/// </summary>
public class AdminOverdraftBookingTests
{
    // TestHost fixture: slice_minutes 15, court price 8 credits, penalty_pct 30,
    // penalty_window_minutes 15.
    private const decimal SlicePriceCredits = 8m;

    /// <summary>Seeds the member with less than one slice costs, and hands back the pieces every test needs.</summary>
    private static async Task<(BookingService Bookings, LedgerService Ledger, MainframeDbContext Db)> ArrangeAsync(
        TestHost host, IServiceScope scope, decimal seedCredits)
    {
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        if (seedCredits != 0m)
        {
            await ledger.PostAsync(
                new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, seedCredits, host.PlayerUser.Id), default);
        }

        return (scope.ServiceProvider.GetRequiredService<BookingService>(), ledger, db);
    }

    /// <summary>
    /// The override is not implied by being an admin. Without it, the desk gets exactly the
    /// refusal a member would — which is what makes the override a decision somebody took
    /// rather than a rule that quietly stopped applying to admins.
    /// </summary>
    [Fact]
    public async Task Without_the_override_an_admin_booking_for_a_short_member_is_still_refused()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var (bookings, ledger, db) = await ArrangeAsync(host, scope, seedCredits: 3m);

        var result = await bookings.CreateAsync(
            host.Courts[0].Id,
            new BookingPayer(host.PlayerUser.Id, host.AdminUser.Id, ActorIsAdmin: true),
            TestHost.BookableSlot(2), sliceCount: 1, default);

        var refusal = Assert.IsType<BookingResult.InsufficientBalance>(result);
        Assert.Equal(3m, refusal.CurrentCredits);
        Assert.Equal(SlicePriceCredits, refusal.RequiredCredits);

        // Nothing moved and nothing was reserved: a refusal that left a row behind would be
        // a court sold for no money.
        Assert.Equal(3m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
        Assert.Empty(await db.Bookings.IgnoreQueryFilters().ToListAsync());
    }

    /// <summary>
    /// The promise itself: asked for by name, the booking is made and the member's balance
    /// goes below zero by exactly the shortfall.
    /// </summary>
    [Fact]
    public async Task The_override_books_the_court_and_leaves_the_member_the_shortfall_in_the_red()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var (bookings, ledger, db) = await ArrangeAsync(host, scope, seedCredits: 3m);

        var result = await bookings.CreateAsync(
            host.Courts[0].Id,
            new BookingPayer(host.PlayerUser.Id, host.AdminUser.Id, AllowNegativeBalance: true, ActorIsAdmin: true),
            TestHost.BookableSlot(2), sliceCount: 1, default);

        var ok = Assert.IsType<BookingResult.Ok>(result);
        Assert.Equal(BookingStatus.Booked, ok.Booking.Status);
        Assert.Equal(host.PlayerUser.Id, ok.Booking.UserId);
        Assert.Equal(host.AdminUser.Id, ok.Booking.ActorUserId);

        // 3 − 8 = −5, and the figure the response quotes is the figure the ledger holds.
        Assert.Equal(-5m, ok.BalanceAfterCredits);
        Assert.Equal(-5m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));

        // settlement-model.md S1: Owed(b) = P, posted as ONE BookingCharge at the quoted
        // price. An override that discounted the court, or split the debit, would satisfy
        // "the balance went negative" and break the money model.
        var rows = await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.RelatedBookingId == ok.Booking.Id).ToListAsync();
        var charge = Assert.Single(rows);
        Assert.Equal(LedgerEntryType.BookingCharge, charge.Type);
        Assert.Equal(-SlicePriceCredits, charge.AmountCredits);
        Assert.Equal(host.PlayerUser.Id, charge.UserId);
        Assert.Equal(host.AdminUser.Id, charge.ActorUserId);
        Assert.Equal(SlicePriceCredits, ok.Booking.AmountChargedCredits);
    }

    /// <summary>
    /// <b>Flipped deliberately by decision R19 (2026-09-23, "admin god mode").</b> This test was
    /// <c>The_override_cannot_be_turned_on_the_actors_own_wallet</c> and pinned the old third
    /// condition, <c>actorId != userId</c>. The club decided its admins may book themselves
    /// into the red — the court is not free, it is the same <c>BookingCharge</c> at the same
    /// price and the admin owes it — so an admin asking for the override by name on their own
    /// wallet now gets it, and the undeletable change record says so (see the next test).
    /// </summary>
    [Fact]
    public async Task An_admin_may_overdraw_their_own_wallet_when_they_ask_for_it_by_name()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var (bookings, ledger, db) = await ArrangeAsync(host, scope, seedCredits: 0m);

        var result = await bookings.CreateAsync(
            host.Courts[0].Id,
            new BookingPayer(host.AdminUser.Id, host.AdminUser.Id, AllowNegativeBalance: true, ActorIsAdmin: true),
            TestHost.BookableSlot(2), sliceCount: 1, default);

        var ok = Assert.IsType<BookingResult.Ok>(result);
        Assert.Equal(host.AdminUser.Id, ok.Booking.UserId);
        Assert.Equal(-SlicePriceCredits, ok.BalanceAfterCredits);
        Assert.Equal(-SlicePriceCredits, await ledger.GetBalanceAsync(host.AdminUser.Id, default));

        // Still one BookingCharge at the full price: god mode moves the wallet, never the price.
        var charge = Assert.Single(await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.RelatedBookingId == ok.Booking.Id).ToListAsync());
        Assert.Equal(-SlicePriceCredits, charge.AmountCredits);
    }

    /// <summary>
    /// The half of the old rule R19 keeps: the override is an ADMIN's. A payer built with the
    /// flag but without the role — which is what the member route could produce if the field
    /// ever reached it — is refused on their own wallet exactly as before.
    /// </summary>
    [Fact]
    public async Task Without_the_admin_role_the_override_does_nothing_even_on_your_own_wallet()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var (bookings, ledger, _) = await ArrangeAsync(host, scope, seedCredits: 3m);

        var result = await bookings.CreateAsync(
            host.Courts[0].Id,
            new BookingPayer(host.PlayerUser.Id, host.PlayerUser.Id, AllowNegativeBalance: true),
            TestHost.BookableSlot(2), sliceCount: 1, default);

        Assert.IsType<BookingResult.InsufficientBalance>(result);
        Assert.Equal(3m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
    }

    /// <summary>
    /// R19's "all audited", in the table nobody can delete from. An admin's overdraft of their
    /// own wallet is the one most worth hiding, so it is written to <c>admin_change_log</c>
    /// with both balances and <c>self: true</c> — and it is NOT recorded as an on-behalf
    /// booking, because it was not one.
    /// </summary>
    [Fact]
    public async Task A_self_overdraft_is_written_to_the_change_record_with_both_balances()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var (bookings, _, db) = await ArrangeAsync(host, scope, seedCredits: 0m);

        var ok = Assert.IsType<BookingResult.Ok>(await bookings.CreateAsync(
            host.Courts[0].Id,
            new BookingPayer(host.AdminUser.Id, host.AdminUser.Id, AllowNegativeBalance: true, ActorIsAdmin: true),
            TestHost.BookableSlot(2), sliceCount: 1, default));

        var rows = await db.AdminChangeLogs.IgnoreQueryFilters().ToListAsync();
        var row = Assert.Single(rows);
        Assert.Equal(AdminChangeActions.BookingOverdraftAuthorised, row.Action);
        Assert.Equal(AdminChangeAreas.Booking, row.Area);
        Assert.Equal(host.AdminUser.Id, row.ActorUserId);
        Assert.Equal(host.AdminUser.Id, row.SubjectId);

        using var before = JsonDocument.Parse(row.BeforeJson!);
        using var after = JsonDocument.Parse(row.AfterJson!);
        Assert.Equal(0m, before.RootElement.GetProperty("balance_credits").GetDecimal());
        Assert.Equal(-SlicePriceCredits, after.RootElement.GetProperty("balance_credits").GetDecimal());
        Assert.True(after.RootElement.GetProperty("self").GetBoolean());
        Assert.Equal(ok.Booking.Id, after.RootElement.GetProperty("booking_id").GetGuid());
    }

    /// <summary>
    /// A desk booking for somebody else writes <c>booking.booked_on_behalf</c>, and when it
    /// overdrew them, <c>booking.overdraft_authorised</c> beside it — two decisions, two rows.
    /// A member's own booking writes neither: the change record is for admin decisions.
    /// </summary>
    [Fact]
    public async Task An_on_behalf_overdraft_writes_both_rows_and_a_members_own_booking_writes_none()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var (bookings, _, db) = await ArrangeAsync(host, scope, seedCredits: 3m);

        Assert.IsType<BookingResult.Ok>(await bookings.CreateAsync(
            host.Courts[0].Id,
            new BookingPayer(host.PlayerUser.Id, host.AdminUser.Id, AllowNegativeBalance: true, ActorIsAdmin: true),
            TestHost.BookableSlot(2), sliceCount: 1, default));

        var actions = (await db.AdminChangeLogs.IgnoreQueryFilters().ToListAsync()).Select(r => r.Action).ToList();
        Assert.Equal(2, actions.Count);
        Assert.Contains(AdminChangeActions.BookingBookedOnBehalf, actions);
        Assert.Contains(AdminChangeActions.BookingOverdraftAuthorised, actions);

        // The member's own booking, funded: nothing new in the change record.
        await host.NewScope().ServiceProvider.GetRequiredService<LedgerService>().PostAsync(
            new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id), default);
        // The OTHER court: BookableSlot(2) and BookableSlot(3) both step out of peak to the
        // same 19:xx when the suite runs between 13:00 and 16:00 UTC, and on one court the
        // second booking was then refused slot_taken — red every afternoon, green otherwise.
        Assert.IsType<BookingResult.Ok>(await bookings.CreateAsync(
            host.Courts[1].Id, new BookingPayer(host.PlayerUser.Id, host.PlayerUser.Id),
            TestHost.BookableSlot(3), sliceCount: 1, default));
        Assert.Equal(2, await db.AdminChangeLogs.IgnoreQueryFilters().CountAsync());
    }

    /// <summary>
    /// An item of a batch does not write its own <c>booking.booked_on_behalf</c> — the batch
    /// writes one <c>bookings.bulk_booked</c> for its whole list — and an item that did not
    /// overdraw writes nothing at all.
    /// </summary>
    [Fact]
    public async Task A_batch_item_that_did_not_overdraw_writes_no_change_record_row_of_its_own()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var (bookings, _, db) = await ArrangeAsync(host, scope, seedCredits: 200m);

        Assert.IsType<BookingResult.Ok>(await bookings.CreateAsync(
            host.Courts[0].Id,
            new BookingPayer(host.PlayerUser.Id, host.AdminUser.Id, ActorIsAdmin: true, PartOfBatch: true),
            TestHost.BookableSlot(2), sliceCount: 1, default));

        Assert.Empty(await db.AdminChangeLogs.IgnoreQueryFilters().ToListAsync());
    }

    /// <summary>
    /// "logged" is the load-bearing word in §8, and a log that does not say how deep the
    /// overdraft went cannot be reviewed without replaying every ledger row that has landed
    /// since. The audited balance is asserted against the ledger rather than against a
    /// literal, so the two cannot drift apart.
    /// </summary>
    [Fact]
    public async Task The_override_is_audited_with_the_actor_the_member_and_the_balance_it_left()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var (bookings, ledger, db) = await ArrangeAsync(host, scope, seedCredits: 3m);

        var ok = Assert.IsType<BookingResult.Ok>(await bookings.CreateAsync(
            host.Courts[0].Id,
            new BookingPayer(host.PlayerUser.Id, host.AdminUser.Id, AllowNegativeBalance: true, ActorIsAdmin: true),
            TestHost.BookableSlot(2), sliceCount: 1, default));

        var audit = Assert.Single(await db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.Action.StartsWith("booking.created")).ToListAsync());

        // A distinct action, not the ordinary on-behalf one: an overdraft is the thing a
        // club reviews at month end, and it has to be findable without parsing every row.
        Assert.Equal("booking.created_on_behalf_overdrawn", audit.Action);
        Assert.Equal(host.AdminUser.Id, audit.ActorUserId);
        Assert.Equal(host.PlayerUser.Id, audit.SubjectUserId);

        using var details = JsonDocument.Parse(audit.DetailsJson!);
        Assert.True(details.RootElement.GetProperty("overdrawn").GetBoolean());
        Assert.Equal(3m, details.RootElement.GetProperty("balance_before_credits").GetDecimal());
        Assert.Equal(
            await ledger.GetBalanceAsync(host.PlayerUser.Id, default),
            details.RootElement.GetProperty("balance_after_credits").GetDecimal());
        Assert.Equal(ok.Booking.Id, details.RootElement.GetProperty("booking_id").GetGuid());
    }

    /// <summary>
    /// The audit names the OUTCOME, not the request. A desk that ticks the override for a
    /// member who turns out to be able to afford the court has done an ordinary on-behalf
    /// booking, and a trail that called it an overdraft would send a reviewer looking for
    /// money that never went missing.
    /// </summary>
    [Fact]
    public async Task An_override_that_was_not_needed_is_not_recorded_as_an_overdraft()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var (bookings, ledger, db) = await ArrangeAsync(host, scope, seedCredits: 200m);

        Assert.IsType<BookingResult.Ok>(await bookings.CreateAsync(
            host.Courts[0].Id,
            new BookingPayer(host.PlayerUser.Id, host.AdminUser.Id, AllowNegativeBalance: true, ActorIsAdmin: true),
            TestHost.BookableSlot(2), sliceCount: 1, default));

        var audit = Assert.Single(await db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.Action.StartsWith("booking.created")).ToListAsync());
        Assert.Equal("booking.created_on_behalf", audit.Action);

        using var details = JsonDocument.Parse(audit.DetailsJson!);
        Assert.False(details.RootElement.GetProperty("overdrawn").GetBoolean());
        Assert.Equal(200m - SlicePriceCredits, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
    }

    /// <summary>
    /// The overdraft is a wallet state, not a different kind of booking. Cancelling one
    /// outside the penalty window walks the member back to exactly where they started —
    /// <c>settlement-model.md</c> S2, <c>Owed(b) = 0</c> — which is the property that says
    /// the override did not smuggle a second money path into the model.
    /// </summary>
    [Fact]
    public async Task Cancelling_an_overdrawn_booking_returns_the_member_to_where_they_started()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var (bookings, ledger, db) = await ArrangeAsync(host, scope, seedCredits: 3m);

        // Far enough out to be outside the 15-minute penalty window.
        var ok = Assert.IsType<BookingResult.Ok>(await bookings.CreateAsync(
            host.Courts[0].Id,
            new BookingPayer(host.PlayerUser.Id, host.AdminUser.Id, AllowNegativeBalance: true, ActorIsAdmin: true),
            TestHost.BookableSlot(5), sliceCount: 1, default));
        Assert.Equal(-5m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));

        var cancelled = await bookings.CancelAsync(
            ok.Booking.Id, host.AdminUser.Id, actorIsAdmin: true, waivePenalty: false, default);

        var done = Assert.IsType<CancellationResult.Ok>(cancelled);
        Assert.Equal(SlicePriceCredits, done.RefundedCredits);
        Assert.Equal(0m, done.PenaltyCredits);
        Assert.Equal(3m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));

        // I11: the refund is its own row, not an edit of the charge.
        var rows = await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.RelatedBookingId == ok.Booking.Id).ToListAsync();
        Assert.Equal(2, rows.Count);
    }

    /// <summary>
    /// The member's own confirmation. Left alone, the email states "Balance after: −5,00
    /// credits" and nothing else — a negative number with no account of itself, on the one
    /// artifact a member reconciles a bank statement against.
    /// </summary>
    [Fact]
    public void The_confirmation_email_explains_a_negative_balance_and_says_nothing_when_it_is_positive()
    {
        var club = new Crusaders.Mainframe.Api.Email.ClubIdentity(
            "Riverside Racquet Club", "+27 31 555 0188", "desk@riverside.review.test");
        var overdrawn = EmailTemplates.BookingConfirmation(club, "naledi@example.test", new BookingConfirmationDetails(
            "Court 1", "Sat 06 Sep 09:00", "15 min", 8m, -5m, 15, 30m));
        var ordinary = EmailTemplates.BookingConfirmation(club, "naledi@example.test", new BookingConfirmationDetails(
            "Court 1", "Sat 06 Sep 09:00", "15 min", 8m, 192m, 15, 30m));

        // Both bodies: the explanation is worth nothing in the half the member is not shown.
        foreach (var body in new[] { overdrawn.HtmlBody, MailText.Unwrap(overdrawn.PlainBody) })
        {
            Assert.Contains("The club made this booking for you", body);
            Assert.Contains("Top up to clear it", body);
        }
        Assert.DoesNotContain("The club made this booking for you", ordinary.HtmlBody);
        Assert.DoesNotContain("The club made this booking for you", MailText.Unwrap(ordinary.PlainBody));
    }

    /// <summary>
    /// R19 lets an admin overdraw their OWN wallet, and "the club made this booking for you"
    /// is then false. The negative balance still gets its explanation; the clause about who
    /// made the booking goes.
    /// </summary>
    [Fact]
    public void An_admins_own_overdraft_email_does_not_claim_the_club_made_the_booking()
    {
        var club = new Crusaders.Mainframe.Api.Email.ClubIdentity(
            "Riverside Racquet Club", "+27 31 555 0188", "desk@riverside.review.test");
        var own = EmailTemplates.BookingConfirmation(club, "desk@example.test", new BookingConfirmationDetails(
            "Court 1", "Sat 06 Sep 09:00", "15 min", 8m, -8m, 15, 30m, MadeByClub: false));

        foreach (var body in new[] { own.HtmlBody, MailText.Unwrap(own.PlainBody) })
        {
            Assert.DoesNotContain("The club made this booking for you", body);
            Assert.Contains("This booking takes your balance to", body);
            Assert.Contains("Top up to clear it", body);
        }
    }
}
