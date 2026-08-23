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
        // Enough to book (the hold only verifies affordability), then spent elsewhere.
        var f = await CreateAsync(topUpCredits: 8m);
        await using var _ = f.Host;
        using var __ = f.Scope;

        var booking = await BookNowAsync(f);

        await f.Ledger.PostAsync(new LedgerPosting(
            f.Host.PlayerUser.Id, LedgerEntryType.AdminAdjustment, -8m, f.Host.AdminUser.Id), default);

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
        var f = await CreateAsync(topUpCredits: 8m);
        await using var _ = f.Host;
        using var __ = f.Scope;

        var booking = await BookNowAsync(f);
        await f.Ledger.PostAsync(new LedgerPosting(
            f.Host.PlayerUser.Id, LedgerEntryType.AdminAdjustment, -8m, f.Host.AdminUser.Id), default);

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
        Assert.True(end > now);
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
}
