using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Regression tests for three live money defects at the courtside touchpoints.
///
/// <para>
/// <b>1. PIN and QR charged nothing.</b> Both were pure identity oracles — they returned a
/// <c>user_id</c> and did nothing else. No ledger post, no <c>CheckedInAt</c>, no event, no
/// audit row. A member identifying that way played free <i>and</i> was swept as a no-show,
/// because attendance is <c>CheckedInAt</c> and nothing set it. Only biometric ever charged.
/// </para>
///
/// <para>
/// <b>2. Insufficient balance turned the lights on anyway.</b> The charge failure was a
/// <c>LogWarning</c>, and execution fell through to stamping <c>CheckedInAt</c> and emitting
/// <c>booking.lights_on</c>. Because <c>CheckedInAt</c> was then set, the booking was
/// disqualified from <c>NoShowWorker</c> — so an unpaid, attended session settled to free
/// play with nothing left to follow up.
/// </para>
///
/// <para>
/// Charge-at-booking narrows that path without closing it: an ordinary booking arrives at
/// the court already paid for, so the refusal branch is now reached by a booking that was
/// reserved without a debit, and by a volunteer pressing "I'll pay" who cannot afford it.
/// Those are the two cases exercised below. The rule is unchanged and is what the tests
/// hold to: <b>no charge, no lights, and no attendance stamp</b>.
/// </para>
///
/// <para>
/// <b>3. Three grace windows disagreed.</b> Biometric read <c>Biometric:GraceMinutes</c>
/// from app config — a key absent from <c>appsettings.json</c>, so permanently its 5-minute
/// default. PIN and QR each hardcoded 30 minutes. The no-show sweep used the tenant's
/// <c>grace_window_minutes</c>. A member could be inside PIN's window and already swept.
/// </para>
/// </summary>
public class CourtActivationTests
{
    private sealed record Fixture(
        TestHost Host, IServiceScope Scope, CourtActivationService Activation,
        LedgerService Ledger, BookingService Bookings, MainframeDbContext Db, StubEmailService Email);

    private static async Task<Fixture> CreateAsync(decimal topUpCredits = 100m)
    {
        var host = await TestHost.CreateAsync();
        var scope = host.NewScope();

        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        if (topUpCredits > 0)
        {
            await ledger.PostAsync(
                new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, topUpCredits, host.PlayerUser.Id), default);
        }

        return new Fixture(
            host, scope,
            scope.ServiceProvider.GetRequiredService<CourtActivationService>(),
            ledger,
            scope.ServiceProvider.GetRequiredService<BookingService>(),
            scope.ServiceProvider.GetRequiredService<MainframeDbContext>(),
            host.EmailService);
    }

    /// <summary>A booking starting now, i.e. one a player is standing in front of.</summary>
    private static async Task<Booking> BookNowAsync(Fixture f)
    {
        var result = await f.Bookings.CreateAsync(
            f.Host.Courts[0].Id, f.Host.PlayerUser.Id, f.Host.PlayerUser.Id,
            DateTimeOffset.UtcNow.AddMinutes(1), 1, default);

        return Assert.IsType<BookingResult.Ok>(result).Booking;
    }

    /// <summary>
    /// A booking a player is standing in front of that carries no debit — the shape a row
    /// has if it was reserved without charging, and the only shape that can still reach the
    /// refusal branch now that <c>CreateAsync</c> charges. Written directly rather than
    /// created-then-refunded: deleting a ledger row to manufacture history is what the
    /// ledger-only rule exists to forbid, fixtures included.
    /// </summary>
    private static async Task<Booking> ReserveNowUnchargedAsync(Fixture f)
    {
        var startsAt = DateTimeOffset.UtcNow.AddMinutes(1);
        var booking = new Booking
        {
            TenantId = f.Host.Tenant.Id,
            CourtId = f.Host.Courts[0].Id,
            UserId = f.Host.PlayerUser.Id,
            BookedByUserId = f.Host.PlayerUser.Id,
            PaidByUserId = f.Host.PlayerUser.Id,
            ActorUserId = f.Host.PlayerUser.Id,
            StartsAt = startsAt,
            EndsAt = startsAt.AddMinutes(15),
            SliceMinutes = 15,
            SliceCount = 1,
            AmountChargedCredits = 8m,
            Status = BookingStatus.Booked,
            ChargedAt = null,
        };
        f.Db.Bookings.Add(booking);
        await f.Db.SaveChangesAsync();
        return booking;
    }

    private static Court CourtOf(Fixture f) => f.Host.Courts[0];

    // ---- Defect 1: every touchpoint charges -------------------------------

    /// <summary>
    /// The governing rule: identifying by PIN or QR must cost exactly what identifying by
    /// fingerprint costs. Parameterised over the method so a fourth touchpoint cannot be
    /// added without answering this question.
    /// </summary>
    [Theory]
    [InlineData("biometric")]
    [InlineData("pin")]
    [InlineData("qr")]
    public async Task Every_identification_method_charges_the_same(string method)
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var booking = await BookNowAsync(f);

        var result = await f.Activation.ActivateAsync(
            CourtOf(f), booking, f.Host.PlayerUser.Id, payerOverrideUserId: null, method, default);

        var activated = Assert.IsType<ActivationResult.Activated>(result);
        Assert.Equal(8m, activated.AmountCredits);

        // 100 topped up, 8 for one 15-minute slice.
        Assert.Equal(92m, await f.Ledger.GetBalanceAsync(f.Host.PlayerUser.Id, default));

        var charges = await f.Db.LedgerEntries
            .Where(l => l.Type == LedgerEntryType.BookingCharge && l.RelatedBookingId == booking.Id)
            .ToListAsync();

        Assert.Single(charges);
        Assert.Equal(-8m, charges[0].AmountCredits);
    }

    /// <summary>
    /// Attendance must be recorded whichever way the player identified — otherwise the
    /// no-show sweep refunds a session that actually happened, and the club loses the money
    /// for a court that was used.
    /// </summary>
    [Theory]
    [InlineData("biometric")]
    [InlineData("pin")]
    [InlineData("qr")]
    public async Task Every_identification_method_records_attendance(string method)
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var booking = await BookNowAsync(f);
        await f.Activation.ActivateAsync(CourtOf(f), booking, f.Host.PlayerUser.Id, null, method, default);

        var fresh = await f.Db.Bookings.AsNoTracking().FirstAsync(b => b.Id == booking.Id);
        Assert.NotNull(fresh.CheckedInAt);
        Assert.NotNull(fresh.ChargedAt);
    }

    /// <summary>Every activation is attributable — who, which court, and how they identified.</summary>
    [Theory]
    [InlineData("biometric")]
    [InlineData("pin")]
    [InlineData("qr")]
    public async Task Every_identification_method_writes_an_audit_row_naming_the_method(string method)
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var booking = await BookNowAsync(f);
        await f.Activation.ActivateAsync(CourtOf(f), booking, f.Host.PlayerUser.Id, null, method, default);

        var audit = await f.Db.AuditLogs.Where(a => a.Action == "court.activated").ToListAsync();

        Assert.Single(audit);
        Assert.Contains(method, audit[0].DetailsJson);
        Assert.Equal(f.Host.PlayerUser.Id, audit[0].ActorUserId);
    }

    // ---- Defect 2: insufficient balance refuses ---------------------------

    /// <summary>
    /// The expensive one. Lights must not come on unpaid, and — just as important —
    /// <c>CheckedInAt</c> must NOT be stamped, or the booking escapes the no-show sweep and
    /// the club never learns it was never paid for.
    /// </summary>
    [Theory]
    [InlineData("biometric")]
    [InlineData("pin")]
    [InlineData("qr")]
    public async Task Insufficient_balance_refuses_and_cues_nothing(string method)
    {
        // A reservation carrying no debit, held by a member with nothing to pay it with.
        var f = await CreateAsync(topUpCredits: 0m);
        await using var _ = f.Host;
        using var __ = f.Scope;

        var booking = await ReserveNowUnchargedAsync(f);

        var result = await f.Activation.ActivateAsync(
            CourtOf(f), booking, f.Host.PlayerUser.Id, null, method, default);

        var refused = Assert.IsType<ActivationResult.InsufficientBalance>(result);
        Assert.Equal(8m, refused.Required);
        Assert.Equal(0m, refused.Current);

        var fresh = await f.Db.Bookings.AsNoTracking().FirstAsync(b => b.Id == booking.Id);

        // The three things the old code did anyway.
        Assert.Null(fresh.CheckedInAt);
        Assert.Null(fresh.ChargedAt);
        Assert.Null(fresh.LightsOnCuedAt);

        Assert.Empty(await f.Db.LedgerEntries
            .Where(l => l.Type == LedgerEntryType.BookingCharge && l.RelatedBookingId == booking.Id)
            .ToListAsync());

        // No activation was recorded either. Asserted on the audit row rather than on the
        // email count: player emails are sent fire-and-forget off the request thread, so a
        // count is a race against a send that has not landed yet — an earlier draft of this
        // test failed intermittently on exactly that, naming a different method each run.
        Assert.Empty(await f.Db.AuditLogs.Where(a => a.Action == "court.activated").ToListAsync());
    }

    /// <summary>
    /// The consequence spelled out: a refused activation still looks like a no-show, which
    /// is the whole point — the sweep can see it and the club finds out.
    /// </summary>
    [Fact]
    public async Task A_refused_activation_remains_visible_to_the_no_show_sweep()
    {
        var f = await CreateAsync(topUpCredits: 0m);
        await using var _ = f.Host;
        using var __ = f.Scope;

        var booking = await ReserveNowUnchargedAsync(f);

        await f.Activation.ActivateAsync(CourtOf(f), booking, f.Host.PlayerUser.Id, null, "pin", default);

        var fresh = await f.Db.Bookings.AsNoTracking().FirstAsync(b => b.Id == booking.Id);

        // NoShowWorker's predicate is Status == Booked && CheckedInAt == null.
        Assert.Equal(BookingStatus.Booked, fresh.Status);
        Assert.Null(fresh.CheckedInAt);
    }

    // ---- Idempotency ------------------------------------------------------

    /// <summary>
    /// A player scans twice, or the box retries after a dropped response. One charge, one
    /// event, one attendance stamp.
    /// </summary>
    [Fact]
    public async Task A_repeat_scan_does_not_charge_again()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var booking = await BookNowAsync(f);

        var first = await f.Activation.ActivateAsync(CourtOf(f), booking, f.Host.PlayerUser.Id, null, "qr", default);
        Assert.False(Assert.IsType<ActivationResult.Activated>(first).AlreadyActive);

        var second = await f.Activation.ActivateAsync(CourtOf(f), booking, f.Host.PlayerUser.Id, null, "qr", default);
        Assert.True(Assert.IsType<ActivationResult.Activated>(second).AlreadyActive);

        Assert.Equal(92m, await f.Ledger.GetBalanceAsync(f.Host.PlayerUser.Id, default));

        Assert.Single(await f.Db.LedgerEntries
            .Where(l => l.Type == LedgerEntryType.BookingCharge && l.RelatedBookingId == booking.Id)
            .ToListAsync());

        Assert.Single(await f.Db.AuditLogs.Where(a => a.Action == "court.activated").ToListAsync());
    }

    // ---- Offline scans are judged when they happened ----------------------

    /// <summary>
    /// A court box decides scans offline and uploads them later, so the scan and the
    /// server hearing of it can be far apart. The cue gate and the attendance stamp use the
    /// scan's own time: a scan made ahead of the cue window is too early however open the
    /// window is by the time it arrives, and a scan made inside it is stamped when the
    /// member actually identified, not when the WiFi came back.
    /// </summary>
    [Fact]
    public async Task An_uploaded_scan_is_judged_and_stamped_at_the_time_it_happened()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        // Starts in a minute: the ten-minute cue opened nine minutes ago.
        var booking = await BookNowAsync(f);

        var early = await f.Activation.ActivateAsync(
            new ActivationRequest(CourtOf(f), booking, f.Host.PlayerUser.Id, null, "qr", DateTimeOffset.UtcNow.AddMinutes(-30)), default);
        Assert.IsType<ActivationResult.TooEarly>(early);
        Assert.Null(booking.CheckedInAt);

        var scannedAt = DateTimeOffset.UtcNow.AddMinutes(-5);
        var live = await f.Activation.ActivateAsync(
            new ActivationRequest(CourtOf(f), booking, f.Host.PlayerUser.Id, null, "qr", scannedAt), default);
        Assert.False(Assert.IsType<ActivationResult.Activated>(live).AlreadyActive);
        Assert.Equal(scannedAt, booking.CheckedInAt);
        Assert.Equal(scannedAt, booking.LightsOnCuedAt);
        Assert.Equal(92m, await f.Ledger.GetBalanceAsync(f.Host.PlayerUser.Id, default));
    }

    // ---- Defect 3: one grace window ---------------------------------------

    /// <summary>
    /// All three touchpoints must ask the same question of the same setting. Asserted
    /// against the tenant value rather than any hardcoded number, so changing the setting
    /// moves every touchpoint together.
    /// </summary>
    [Fact]
    public async Task The_activation_window_comes_from_tenant_settings()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var settings = await f.Scope.ServiceProvider
            .GetRequiredService<TenantSettingsAccessor>().GetAsync(default);

        var now = DateTimeOffset.UtcNow;
        var (start, end) = await f.Activation.WindowAsync(now, default);

        Assert.Equal(now.AddMinutes(-settings.GraceWindowMinutes), start, TimeSpan.FromSeconds(1));
        // The forward edge was a hardcoded two hours; it is the tenant's setting now.
        Assert.Equal(now.AddMinutes(settings.ActivationForwardWindowMinutes), end, TimeSpan.FromSeconds(1));
    }

    /// <summary>
    /// A booking that finished longer ago than the grace window is not activatable. Before
    /// this, PIN and QR would still have found it — they looked back 30 minutes while the
    /// sweep had already written it off after 5.
    /// </summary>
    [Fact]
    public async Task A_booking_older_than_the_grace_window_is_not_a_candidate()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var settings = await f.Scope.ServiceProvider
            .GetRequiredService<TenantSettingsAccessor>().GetAsync(default);

        // Ended comfortably beyond the grace window — 30 minutes ago would have been
        // inside PIN's old hardcoded window and outside the tenant's 5-minute one.
        var startsAt = DateTimeOffset.UtcNow.AddMinutes(-(settings.GraceWindowMinutes + settings.SliceMinutes + 25));
        var created = await f.Bookings.CreateAsync(
            f.Host.Courts[0].Id, f.Host.PlayerUser.Id, f.Host.PlayerUser.Id, startsAt, 1, default);

        if (created is not BookingResult.Ok ok) return;   // past-dated bookings may be refused outright

        var candidates = await f.Activation.CandidatesAsync(f.Host.Courts[0].Id, DateTimeOffset.UtcNow, default);
        Assert.DoesNotContain(candidates, b => b.Id == ok.Booking.Id);

        Assert.Null(await f.Activation.FindForUserAsync(
            f.Host.Courts[0].Id, f.Host.PlayerUser.Id, DateTimeOffset.UtcNow, default));
    }

    // ---- The cue window ---------------------------------------------------

    /// <summary>
    /// A scan inside the forward window but outside the cue window finds the booking and
    /// does nothing to it. The forward window has to be two hours wide to tell back-to-back
    /// slices apart; the cue window is the narrower one that says when a scan may light the
    /// court. They used to be the same two hours, so a member scanning on their way in was
    /// stamped present, cued the lights, and — because attendance means <c>CheckedInAt</c> —
    /// lost their refund if they then cancelled. Here the cancellation still refunds in full.
    /// </summary>
    [Fact]
    public async Task Scan_outside_cue_window_stamps_nothing()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var settings = await f.Scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>().GetAsync(default);
        var startsIn = settings.ActivationCueWindowMinutes + 30;
        Assert.True(startsIn < settings.ActivationForwardWindowMinutes, "the case must sit inside the forward window");
        Assert.True(startsIn > settings.PenaltyWindowMinutes, "the cancellation must sit outside the penalty window");

        // Booked by the admin on the player's behalf, so no booking rule stands in the way
        // of a slot that starts at whatever hour the suite happens to run.
        var created = await f.Bookings.CreateAsync(
            f.Host.Courts[0].Id, f.Host.PlayerUser.Id, f.Host.AdminUser.Id,
            DateTimeOffset.UtcNow.AddMinutes(startsIn), 1, default);
        var booking = Assert.IsType<BookingResult.Ok>(created).Booking;
        Assert.Equal(92m, await f.Ledger.GetBalanceAsync(f.Host.PlayerUser.Id, default));

        // The booking IS in the forward window — the selectors find it.
        Assert.NotNull(await f.Activation.FindForUserAsync(CourtOf(f).Id, f.Host.PlayerUser.Id, DateTimeOffset.UtcNow, default));

        var result = await f.Activation.ActivateAsync(CourtOf(f), booking, f.Host.PlayerUser.Id, null, "qr", default);

        var early = Assert.IsType<ActivationResult.TooEarly>(result);
        Assert.Equal(booking.Id, early.Booking.Id);
        Assert.InRange(early.StartsInSeconds, startsIn * 60 - 5, startsIn * 60);

        var fresh = await f.Db.Bookings.AsNoTracking().FirstAsync(b => b.Id == booking.Id);
        Assert.Null(fresh.CheckedInAt);
        Assert.Null(fresh.LightsOnCuedAt);
        Assert.Empty(await f.Db.AuditLogs.Where(a => a.Action == "court.activated").ToListAsync());

        // Not stamped, so the member can still change their mind and be made whole.
        var cancelled = await f.Bookings.CancelAsync(booking.Id, f.Host.PlayerUser.Id, actorIsAdmin: false, waivePenalty: false, default);
        var ok = Assert.IsType<CancellationResult.Ok>(cancelled);
        Assert.Equal(8m, ok.RefundedCredits);
        Assert.Equal(0m, ok.PenaltyCredits);
        Assert.Equal(100m, await f.Ledger.GetBalanceAsync(f.Host.PlayerUser.Id, default));
    }

    /// <summary>The cue window's edge is inclusive: a scan exactly at cue-minutes-before lights the court.</summary>
    [Fact]
    public async Task A_scan_inside_the_cue_window_activates()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var settings = await f.Scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>().GetAsync(default);
        var startsIn = Math.Max(settings.ActivationCueWindowMinutes - 1, 0);

        var created = await f.Bookings.CreateAsync(
            f.Host.Courts[0].Id, f.Host.PlayerUser.Id, f.Host.AdminUser.Id,
            DateTimeOffset.UtcNow.AddMinutes(startsIn).AddSeconds(30), 1, default);
        var booking = Assert.IsType<BookingResult.Ok>(created).Booking;

        var result = await f.Activation.ActivateAsync(CourtOf(f), booking, f.Host.PlayerUser.Id, null, "qr", default);

        Assert.IsType<ActivationResult.Activated>(result);
        Assert.NotNull((await f.Db.Bookings.AsNoTracking().FirstAsync(b => b.Id == booking.Id)).CheckedInAt);
    }

    // ---- Payer override ---------------------------------------------------

    /// <summary>Blueprint B.2 — someone else presses "I'll pay". Must survive the refactor.</summary>
    [Fact]
    public async Task A_payer_override_charges_the_other_member()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        await f.Ledger.PostAsync(new LedgerPosting(
            f.Host.LeaguePlayerUser.Id, LedgerEntryType.TopUp, 100m, f.Host.LeaguePlayerUser.Id), default);

        var booking = await BookNowAsync(f);

        var result = await f.Activation.ActivateAsync(
            CourtOf(f), booking, f.Host.PlayerUser.Id,
            payerOverrideUserId: f.Host.LeaguePlayerUser.Id, method: "biometric", default);

        var activated = Assert.IsType<ActivationResult.Activated>(result);
        Assert.Equal(f.Host.LeaguePlayerUser.Id, activated.PayerUserId);

        // The booker keeps their credits; the volunteer pays.
        Assert.Equal(100m, await f.Ledger.GetBalanceAsync(f.Host.PlayerUser.Id, default));
        Assert.Equal(92m, await f.Ledger.GetBalanceAsync(f.Host.LeaguePlayerUser.Id, default));
    }

    /// <summary>
    /// What charge-at-booking changed about B.2: the booker has <i>already paid</i> by the
    /// time anyone volunteers, so honouring "I'll pay" means moving the money, not choosing
    /// where to take it from. Both legs are posted in full and both are on the statement —
    /// a netted row settles to the same balances and cannot say who paid for the court.
    /// </summary>
    [Fact]
    public async Task A_payer_override_moves_the_charge_and_shows_both_legs()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        await f.Ledger.PostAsync(new LedgerPosting(
            f.Host.LeaguePlayerUser.Id, LedgerEntryType.TopUp, 100m, f.Host.LeaguePlayerUser.Id), default);

        var booking = await BookNowAsync(f);
        Assert.Equal(92m, await f.Ledger.GetBalanceAsync(f.Host.PlayerUser.Id, default));

        await f.Activation.ActivateAsync(
            CourtOf(f), booking, f.Host.PlayerUser.Id,
            payerOverrideUserId: f.Host.LeaguePlayerUser.Id, method: "qr", default);

        var rows = await f.Db.LedgerEntries.Where(l => l.RelatedBookingId == booking.Id).ToListAsync();

        // The booker: charged at booking, refunded at the court.
        Assert.Equal(-8m, Assert.Single(rows, l =>
            l.UserId == f.Host.PlayerUser.Id && l.Type == LedgerEntryType.BookingCharge).AmountCredits);
        Assert.Equal(8m, Assert.Single(rows, l =>
            l.UserId == f.Host.PlayerUser.Id && l.Type == LedgerEntryType.CancellationRefund).AmountCredits);

        // The volunteer: charged once.
        Assert.Equal(-8m, Assert.Single(rows, l =>
            l.UserId == f.Host.LeaguePlayerUser.Id && l.Type == LedgerEntryType.BookingCharge).AmountCredits);

        var fresh = await f.Db.Bookings.AsNoTracking().FirstAsync(b => b.Id == booking.Id);
        Assert.Equal(f.Host.LeaguePlayerUser.Id, fresh.PaidByUserId);

        // Who paid for whom, in the audit trail, as {actor, subject}.
        var reassigned = Assert.Single(
            await f.Db.AuditLogs.Where(a => a.Action == "booking.payer_reassigned").ToListAsync());
        Assert.Equal(f.Host.LeaguePlayerUser.Id, reassigned.SubjectUserId);
    }

    /// <summary>
    /// The half-applied reassignment: refund the booker, then find the volunteer cannot pay,
    /// and the court has been played on nobody's credits. Refusing up front is the only
    /// answer that leaves the money where it was — so the booker must still be out of pocket
    /// and still be the payer of record after the refusal.
    /// </summary>
    [Fact]
    public async Task A_payer_override_by_someone_who_cannot_afford_it_changes_nothing()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        // The volunteer is funded and then isn't — 4 credits against a 8-credit slice.
        await f.Ledger.PostAsync(new LedgerPosting(
            f.Host.LeaguePlayerUser.Id, LedgerEntryType.TopUp, 4m, f.Host.LeaguePlayerUser.Id), default);

        var booking = await BookNowAsync(f);

        var result = await f.Activation.ActivateAsync(
            CourtOf(f), booking, f.Host.PlayerUser.Id,
            payerOverrideUserId: f.Host.LeaguePlayerUser.Id, method: "biometric", default);

        var refused = Assert.IsType<ActivationResult.InsufficientBalance>(result);
        Assert.Equal(f.Host.LeaguePlayerUser.Id, refused.PayerUserId);
        Assert.Equal(4m, refused.Current);
        Assert.Equal(8m, refused.Required);

        // Nothing moved: no refund to the booker, no charge to the volunteer.
        Assert.Equal(92m, await f.Ledger.GetBalanceAsync(f.Host.PlayerUser.Id, default));
        Assert.Equal(4m, await f.Ledger.GetBalanceAsync(f.Host.LeaguePlayerUser.Id, default));

        var fresh = await f.Db.Bookings.AsNoTracking().FirstAsync(b => b.Id == booking.Id);
        Assert.Equal(f.Host.PlayerUser.Id, fresh.PaidByUserId);
        Assert.Null(fresh.CheckedInAt);
        Assert.Null(fresh.LightsOnCuedAt);
    }

    /// <summary>
    /// Two of the member's bookings are in the window; the one they are standing on wins.
    ///
    /// <para>
    /// The activation window runs from <c>now − grace</c> to <c>now + 2h</c>, which is wide
    /// enough to hold two back-to-back slices — the ordinary shape under a per-day cap
    /// measured in minutes. Neither selector ordered, so the row the store happened to
    /// return first was checked in.
    /// </para>
    ///
    /// <para>
    /// Getting it wrong is not a cosmetic mix-up. The later booking is checked in early and
    /// the earlier one never is, so the no-show sweep refunds it and charges a penalty for a
    /// court the member is playing on — and a rescan cannot repair it, because the row is no
    /// longer <c>Booked</c> and so no longer a candidate.
    /// </para>
    /// </summary>
    [Fact]
    public async Task The_earliest_booking_in_the_window_is_the_one_activated()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var court = f.Host.Courts[0];
        var now = DateTimeOffset.UtcNow;
        var earlier = now.AddMinutes(2);
        var later = earlier.AddMinutes(15);

        // Inserted latest-first, so a selector that takes whatever comes back first has every
        // chance to take the wrong one.
        foreach (var startsAt in new[] { later, earlier })
        {
            f.Db.Bookings.Add(new Booking
            {
                TenantId = f.Host.Tenant.Id,
                CourtId = court.Id,
                UserId = f.Host.PlayerUser.Id,
                BookedByUserId = f.Host.PlayerUser.Id,
                PaidByUserId = f.Host.PlayerUser.Id,
                ActorUserId = f.Host.PlayerUser.Id,
                StartsAt = startsAt,
                EndsAt = startsAt.AddMinutes(15),
                SliceMinutes = 15,
                SliceCount = 1,
                AmountChargedCredits = 8m,
                Status = BookingStatus.Booked,
                ChargedAt = now,
            });
        }
        await f.Db.SaveChangesAsync();

        var found = await f.Activation.FindForUserAsync(court.Id, f.Host.PlayerUser.Id, now, default);

        Assert.NotNull(found);
        Assert.Equal(earlier, found!.StartsAt);

        // And the candidate list the PIN path selects from is ordered the same way. The
        // biometric path now routes through CandidatesAsync too — MatchAtCourtAsync takes
        // the first candidate whose user matched, rather than building an unordered query
        // of its own — and BiometricServiceTests pins that end to end.
        var candidates = await f.Activation.CandidatesAsync(court.Id, now, default);
        Assert.Equal(earlier, candidates[0].StartsAt);
    }
}
