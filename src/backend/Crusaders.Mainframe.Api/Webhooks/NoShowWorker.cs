using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Hosting;

namespace Crusaders.Mainframe.Api.Webhooks;

/// <summary>
/// Marks bookings as no-show after the grace window passes without a successful biometric match,
/// applies the configured penalty as a ledger entry, and emits booking.no_show.
/// </summary>
public sealed class NoShowWorker : BackgroundService
{
    private readonly IServiceProvider _services;
    private readonly IEventBus _bus;
    private readonly ILogger<NoShowWorker> _logger;

    public NoShowWorker(IServiceProvider services, IEventBus bus, ILogger<NoShowWorker> logger)
    { _services = services; _bus = bus; _logger = logger; }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await TickAsync(stoppingToken); }
            catch (Exception ex) { _logger.LogError(ex, "NoShowWorker tick failed"); }
            await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken);
        }
    }

    // internal so the money-correctness regression test can drive one tick directly
    // rather than waiting on the 30s BackgroundService timer.

    /// <summary>
    /// Everything one tick needs, so the per-booking work can be its own method.
    ///
    /// <para>
    /// Bundled rather than passed one by one: the sweep needs six collaborators and the
    /// complexity gate caps a signature at six parameters, which is the right pressure —
    /// a method that wants eight arguments is a method doing two things.
    /// </para>
    /// </summary>
    private sealed record Sweep(
        MainframeDbContext Db,
        LedgerService Ledger,
        IEmailService Email,
        Tenant Tenant,
        TenantSettingsView Settings,
        DateTimeOffset Now)
    {
        /// <summary>
        /// Which courts had no reachable box at which instant, for this tenant and this tick.
        ///
        /// <para>
        /// An init property rather than a seventh constructor parameter: six is the gate, and
        /// the reason above still holds — a method that wants eight arguments is doing two
        /// things. Defaulted to <see cref="DeviceOutageIndex.Empty"/> so a caller that forgets
        /// it charges penalties as before rather than waiving them all.
        /// </para>
        /// </summary>
        public DeviceOutageIndex Outages { get; init; } = DeviceOutageIndex.Empty;
    }

    /// <summary>
    /// What this sweep costs the member, in penalty.
    ///
    /// <para>
    /// Zero rather than uncollected on an uncharged booking, so the email and the event quote
    /// it as zero too — a penalty nobody was charged is not a penalty. Zero also when the
    /// court's own box was unreachable: <c>feature-spec.md</c> §6a, <c>settlement-model.md</c>
    /// S5a. Its own method because it is the one line of this worker a reviewer checking the
    /// economics has to read, and because inlining it put <see cref="SweepOneAsync"/> past the
    /// complexity gate.
    /// </para>
    /// </summary>
    private static decimal PenaltyFor(Booking b, TenantSettingsView settings, bool wasCharged, bool courtWasDark)
        => wasCharged && !courtWasDark
            ? Math.Round(b.AmountChargedCredits * settings.PenaltyPct / 100m, 2, MidpointRounding.AwayFromZero)
            : 0m;

    /// <summary>
    /// What the member is told — §6a's "players in the affected window get an email explaining
    /// the situation".
    ///
    /// <para>
    /// The no-show notice says the member did not turn up and quotes a penalty. A member whose
    /// court had no reachable box may have been standing in front of it, so they get the reason
    /// instead of the accusation.
    /// </para>
    /// </summary>
    private static EmailMessage Notice(
        string to, string courtName, string clubName, decimal netRefund, decimal penalty, bool courtWasDark)
        => courtWasDark
            ? EmailTemplates.BookingRefundedForOutage(to, courtName, netRefund, clubName)
            : EmailTemplates.BookingCancellation(to, courtName + " (no-show)", netRefund, penalty);

    /// <summary>
    /// Reverses one no-show: refund, penalty, status, notification, event.
    ///
    /// <para>
    /// Extracted from <see cref="TickAsync"/> when the atomicity fix pushed it past the
    /// complexity gate. Worth having as its own method regardless — the loop is now "for each
    /// due booking, sweep it", and everything that decides what a sweep costs is in one place
    /// where it can be read against the blueprint.
    /// </para>
    /// </summary>
    private async Task SweepOneAsync(Sweep sweep, Booking b, CancellationToken ct)
    {
        var db = sweep.Db;
        var ledger = sweep.Ledger;
        var email = sweep.Email;
        var tenant = sweep.Tenant;
        var tSettings = sweep.Settings;
        var now = sweep.Now;

        if (b.UserId is null) return;

        // Who pays is who was charged. Posting the penalty to the booker when
        // someone else paid (blueprint B.2 payer override) debits the wrong person.
        var payerUserId = b.PaidByUserId ?? b.UserId.Value;

        // Both movements are guarded on an actual charge having happened.
        //
        // Under charge-at-booking that guard is true for every row CreateAsync writes,
        // and the economics are the club's: the member paid at booking, did not turn
        // up, and gets the slot back less the penalty — the blueprint's own words.
        //
        // The guard is not therefore redundant. A reservation carrying no debit still
        // reaches this sweep, and refunding one credits a player for a slot nobody
        // paid for. That was live once: the refund ran on AmountChargedCredits > 0
        // alone, so under the old charge-on-activation model — where a no-show by
        // definition never checked in and so was never charged — failing to turn up
        // paid out 70% of the booking value.
        var wasCharged = b.ChargedAt is not null;

        // feature-spec.md §6a / settlement-model.md S5a: a booking whose court had no reachable
        // box when its grace window closed is refunded in full with NO penalty. Owed(b) = 0.
        //
        // The instant asked about is the grace DEADLINE, not the slot start, and that is the
        // whole of the rule: a box that reconnected before the deadline uploads the events it
        // queued through the outage, so if the member did play we already know it and this
        // booking is not due at all. A box still dark at the deadline is one whose evidence had
        // no path home — the member may have been standing at an unlit court, and charging them
        // 30% for the club's own hardware is the club billing a member for its outage.
        //
        // This does not make a played court free (invariant I2): if the court WAS lit, the box
        // holds an activation, and when it reconnects that reverses the sweep to S6 and Owed
        // returns to the full price. The waiver only ever removes the penalty leg.
        var courtWasDark = sweep.Outages.CourtWasDark(b.CourtId, b.StartsAt.AddMinutes(tSettings.GraceWindowMinutes));

        var penalty = PenaltyFor(b, tSettings, wasCharged, courtWasDark);

        var postings = new List<LedgerPosting>(2);
        if (wasCharged && b.AmountChargedCredits > 0)
        {
            postings.Add(new LedgerPosting(
                UserId: payerUserId, Type: LedgerEntryType.CancellationRefund, AmountCredits: b.AmountChargedCredits,
                ActorUserId: Guid.Empty, RelatedBookingId: b.Id, Reason: "No-show — booking refunded"));
        }

        // A penalty is only collectable against money that moved. Charging one for a
        // booking that was never paid for would drive the balance negative for a slot
        // the club never received anything for.
        if (penalty > 0)
        {
            postings.Add(new LedgerPosting(
                UserId: payerUserId, Type: LedgerEntryType.NoShowPenalty, AmountCredits: -penalty,
                ActorUserId: Guid.Empty, RelatedBookingId: b.Id,
                Reason: $"No-show penalty ({Email.EmailTemplates.Num(tSettings.PenaltyPct)}% of {Email.EmailTemplates.Cr(b.AmountChargedCredits)})"));
        }

        // Status FIRST, then one save carrying it and both movements together.
        //
        // This used to be the other way round, and it was the difference between a
        // sweep that is idempotent and one that is not. PostAsync saves per call, so
        // the refund and penalty were durable while `Status = NoShow` was still only
        // in memory — persisted, if at all, by a later booking's save or by the
        // SaveChanges at the end of the tick. Anything failing in that window (the
        // Users lookup below on an anonymised subject, stoppingToken firing on a
        // deploy, a transient error) left the money moved and the row still Booked.
        // The next tick, thirty seconds later, matched it again and refunded it
        // again, and kept doing so until it succeeded or the row aged past
        // no_show_lookback_days — roughly twenty thousand attempts.
        //
        // The single save is also what makes the concurrency token bite. The due list
        // is materialised once per tick and CheckedInAt is never re-read, and there is
        // a blocking email send per booking in between; a member who identified at the
        // pad seconds after the tick began would otherwise be refunded and penalised
        // for a court they were standing on, leaving a row both checked in and NoShow.
        // Now the activation's write moves Version, this save matches nothing, and the
        // catch below leaves the booking alone.
        b.Status = BookingStatus.NoShow;

        // Settling a no-show releases the court (decision 2026-08-24, review H5). The
        // row keeps only its elapsed portion — EndsAt truncated to the sweep's own
        // clock — so the GiST exclusion constraint and every overlap predicate free the
        // remainder of the slot with no NoShow exemption needed in either. Rides the
        // same save as the status change and the money, so a concurrent check-in rolls
        // all of it back together.
        //
        // No lower bound is needed: the due predicate is StartsAt <= now - grace with
        // grace >= 0, so StartsAt <= now always holds, and the equal-bound row that a
        // zero grace can produce is an empty [x,x) range the GiST constraint treats as
        // overlapping nothing.
        // Truncate, never extend: a booking swept after its natural end (the worker was
        // down, or the lookback reached it late) must keep its own EndsAt, or the range
        // grows forward into the next booking on the court and the exclusion constraint
        // throws — stalling the sweep for every tenant.
        if (now < b.EndsAt) b.EndsAt = now;

        try
        {
            await ledger.PostManyAsync(postings, ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            // Somebody checked in, or an admin cancelled, while this tick was
            // walking its list. Nothing was written. Undo the in-memory status so
            // the rest of the tick is unaffected, and leave the row to whoever won.
            _logger.LogInformation(
                "No-show sweep skipped {BookingId}: the booking changed underneath it", b.Id);
            db.Entry(b).State = EntityState.Detached;
            return;
        }

        // FirstOrDefault, not First. One booking must not be able to stop the sweep.
        //
        // RetentionWorker anonymises an old booking by pointing UserId at a sentinel
        // Guid that has no users row — so a First() here threw, and because the throw
        // escapes TickAsync it took down the whole tick, for every tenant, on every
        // run, until that booking aged past no_show_lookback_days. Nothing enforces
        // that retention_days exceeds no_show_lookback_days, and both are tenant
        // settings, so an admin setting retention to 3 days and lookback to 7 stops
        // the club's no-show sweep permanently.
        //
        // The money is already committed by this point and that is deliberate: what
        // is missing here is somebody to notify, not somebody to charge. The ledger
        // is the record; the email is the courtesy.
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == b.UserId, ct);
        var court = await db.Courts.FirstOrDefaultAsync(c => c.Id == b.CourtId, ct);

        // What the member is actually left with, which is nothing at all if nothing was
        // ever taken — quoting them a refund they did not receive is how a support
        // ticket starts.
        var netRefund = wasCharged ? b.AmountChargedCredits - penalty : 0m;
        var courtName = court?.Name ?? "a court";
        if (user is null)
        {
            _logger.LogInformation(
                "No-show {BookingId} swept with no subject to notify — anonymised or removed", b.Id);
        }
        else
        {
            try
            {
                await email.SendAsync(
                    Notice(user.Email, courtName, tenant.DisplayName, netRefund, penalty, courtWasDark), ct);
            }
            catch (Exception ex) { _logger.LogWarning(ex, "No-show email failed for {BookingId}", b.Id); }
        }

        await _bus.EmitAsync(new DomainEvent(
            Id: $"evt_{Guid.NewGuid():N}",
            Type: "booking.no_show",
            TenantId: tenant.Id, TenantSlug: tenant.Slug,
            OccurredAt: now, ActorUserId: null, ActorIsAdmin: false, SubjectUserId: b.UserId,
            Data: new()
            {
                ["booking_id"] = b.Id,
                ["court_id"] = b.CourtId,
                ["court_number"] = court?.CourtNumber,
                ["user_id"] = b.UserId,
                ["penalty_credits"] = penalty,
                ["refund_credits"] = netRefund,
                // True when the penalty was waived because the court's box was unreachable
                // (§6a). A club reconciling its no-show revenue needs to tell the two apart.
                ["peripheral_outage"] = courtWasDark,
            }), ct);
    }

    internal async Task TickAsync(CancellationToken ct)
    {
        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var tenantContext = scope.ServiceProvider.GetRequiredService<ITenantContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var settings = scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>();
        var email = scope.ServiceProvider.GetRequiredService<IEmailService>();

        var now = DateTimeOffset.UtcNow;

        // Pull all tenants and walk them — keeps the worker tenant-aware.
        var tenants = await db.Tenants.IgnoreQueryFilters().ToListAsync(ct);
        foreach (var tenant in tenants)
        {
            tenantContext.Set(tenant.Id, tenant.Slug);
            var tSettings = await settings.GetAsync(ct);
            var graceCutoff = now.AddMinutes(-tSettings.GraceWindowMinutes);

            // A booking is a no-show iff:
            //  - it's still in Booked status (not Cancelled/Completed/AdminBlock)
            //  - StartsAt + grace_window has passed
            //  - the player never checked in (no successful biometric match against this booking)
            // Note: we deliberately check CheckedInAt — NOT LightsOnCuedAt — because LightsCueWorker
            // sets LightsOnCuedAt automatically at slot start as a webhook-idempotency stamp,
            // independent of whether anyone actually showed up.
            // The lower bound matters: without it, switching on terminal check-in over a
            // backlog of historical un-checked-in Booked rows would mass-post no-shows
            // (and, before the refund guard below, mass-refund them) on the first tick.
            var lookbackFloor = now.AddDays(-tSettings.NoShowLookbackDays);

            // Once per tenant, not once per booking. Covers exactly the span the sweep can
            // still reach, so a long-closed outage costs nothing to carry.
            var outages = await DeviceOutageIndex.BuildAsync(db, lookbackFloor, ct);

            var dueNoShow = await db.Bookings
                .Where(b => b.Status == BookingStatus.Booked
                    && b.CheckedInAt == null
                    && b.UserId != null
                    && b.StartsAt <= graceCutoff
                    && b.StartsAt >= lookbackFloor)
                .ToListAsync(ct);

            foreach (var b in dueNoShow)
            {
                await SweepOneAsync(new Sweep(db, ledger, email, tenant, tSettings, now) { Outages = outages }, b, ct);
            }

            // The postings above already saved each booking's status. This catches anything
            // else the loop left tracked — nothing today, but a save that silently does
            // nothing is cheaper than one somebody forgets to add later.
            if (dueNoShow.Count > 0) await db.SaveChangesAsync(ct);
        }
    }
}
