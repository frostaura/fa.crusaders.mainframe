using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Hosting;

namespace Crusaders.Mainframe.Api.Webhooks;

/// <summary>
/// Periodic worker that emits <c>booking.lights_on</c> at booking start and <c>booking.lights_off</c>
/// at booking end. Uses <c>cued_lights_on_at</c> / <c>cued_lights_off_at</c> markers on the booking
/// row to avoid double-firing.
/// </summary>
public sealed class LightsCueWorker : BackgroundService
{
    private readonly IServiceProvider _services;
    private readonly IEventBus _bus;
    private readonly ILogger<LightsCueWorker> _logger;

    /// <summary>
    /// R15 D14-4: the club's injected clock — the one every device route and the reversal's cue stamp
    /// read — so the sweep's <c>now</c>, its <c>LightsOffCuedAt</c> and its events' <c>occurred_at</c>
    /// are on the same clock as the check-ins they close. Read from the container, so the hand-built
    /// workers in the suites get the host's clock without a new constructor parameter.
    /// </summary>
    private readonly TimeProvider _clock;

    public LightsCueWorker(IServiceProvider services, IEventBus bus, ILogger<LightsCueWorker> logger)
    {
        _services = services; _bus = bus; _logger = logger;
        _clock = services.GetService<TimeProvider>() ?? TimeProvider.System;
    }

    /// <summary>
    /// Tests only: runs after a booking's off has been DECIDED and before it is saved and sent — the
    /// window a concurrent check-in must not be able to slip into (R13, <c>R13LightsCueRaceHttpTests</c>).
    /// </summary>
    internal Func<Booking, Task>? AfterOffDecidedForTests { get; init; }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var period = TimeSpan.FromSeconds(15);
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await TickAsync(stoppingToken); }
            catch (Exception ex) { _logger.LogError(ex, "LightsCueWorker tick failed"); }
            await Task.Delay(period, stoppingToken);
        }
    }

    /// <summary>
    /// R14 (D14-2 bounded): how long after its end a lit, cancelled booking's off is still said. The
    /// sweep runs every fifteen seconds, so two hours only matters across an outage of the worker;
    /// past it the off is stale noise to a webhook consumer and the box's own relay timer has long
    /// released the court. The other statuses have no lookback: their off has always been said.
    /// </summary>
    internal static readonly TimeSpan CancelledLitLookback = TimeSpan.FromHours(2);

    /// <summary>Internal so tests drive one tick directly rather than waiting on the timer.</summary>
    internal async Task TickAsync(CancellationToken ct)
    {
        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var tenant = scope.ServiceProvider.GetRequiredService<ITenantContext>();

        var now = _clock.GetUtcNow();

        // NOTE: this worker no longer cues lights ON.
        //
        // It used to, on a pure clock: any Booked row whose start had passed, with no
        // reference to attendance, payment or balance. So a court lit itself for a member
        // who never arrived, for a booking that was never paid for, and for a no-show whose
        // minutes were about to be refunded — every one of them, every fifteen seconds.
        //
        // Lights-on now belongs to CourtActivationService, which fires it when somebody
        // actually identifies themselves at the court AND the charge succeeds. That is
        // what CLAUDE.md means by "the at-court identification event is the source of
        // truth for attendance", and it is why LightsOnCuedAt carries a comment warning it
        // is not an attendance proxy.
        //
        // The OFF sweep stays, and matters more than it did: it is now the backstop that
        // releases a court whose session ended, including one this worker never lit.

        // Bookings that have just ended and we haven't cued off.
        //
        // Widened to include NoShow, so a no-show's lights stop too. Previously the sweep
        // only looked at Booked and Completed, and NoShowWorker sets NoShow — so a booking
        // swept as a no-show before this ran was never cued off at all. The court box's own
        // timer would eventually release it, but the backend would believe the lights were
        // still on and the event stream would never say otherwise.
        //
        // R14 D14-2: and a CANCELLED booking that was lit. A member scanned in (its lights_on went
        // out) and the desk — or the member, ahead of a start they had scanned in early for — then
        // cancelled it: the box's relay runs on to the grant's end regardless, and the event stream
        // said the court came on and never that it went off. Its off is said like any other, at its
        // end (the grant the box was given) through the next-free rule, under the cue lock — but
        // only while that end is recent (CancelledLitLookback): an older one is left un-cued and is
        // never read again, so the first deploy does not say an off hours late for every lit
        // booking ever cancelled.
        var cancelledSince = now - CancelledLitLookback;
        var dueOff = await db.Bookings.IgnoreQueryFilters()
            .Where(b => (b.Status == BookingStatus.Booked
                         || b.Status == BookingStatus.Completed
                         || b.Status == BookingStatus.NoShow
                         || (b.Status == BookingStatus.Cancelled && b.CheckedInAt != null && b.EndsAt > cancelledSince))
                && b.LightsOffCuedAt == null
                && b.EndsAt <= now)
            .ToListAsync(ct);

        // `booking.completed` (spec §9) fires once per booking from the two places that
        // promote one — this sweep and the reversed-no-show catch-up below — and in both it
        // fires only after the save that makes the promotion real, never before.
        foreach (var b in dueOff)
        {
            // R13 (E13-1's rule, for every slot): said at the instant the court is next free — never
            // after the lights_on of the next session already lit on it, which closes the court itself.
            // Read, decided, saved and SENT under the court's cue lock, so a check-in committing
            // meanwhile announces its lights_on after this off, never before it (CourtCueLock).
            await using var cue = await CourtCueLock.BeginAsync(db, b.TenantId, b.CourtId, ct);
            var offAt = await NextFreeAsync(db, b, ct);
            if (AfterOffDecidedForTests is { } hook) await hook(b);
            b.LightsOffCuedAt = now;

            // Only promote a booking that was actually attended. Flipping an
            // un-checked-in Booked row to Completed here is what raced NoShowWorker, whose
            // predicate is Status == Booked: whichever ran first decided whether the member
            // was a no-show or had simply finished, and the 15-second tick usually won.
            var promoted = b.Status == BookingStatus.Booked && b.CheckedInAt is not null;
            if (promoted) b.Status = BookingStatus.Completed;

            // Claim the row FIRST, then announce it — and one row per save.
            //
            // Both halves of that sentence are the fix for a crash this worker took on
            // every fresh seed. `Booking` carries a concurrency token and NoShowWorker
            // writes `Status` on rows matched by the same `Status == Booked`, so whichever
            // loses the race throws DbUpdateConcurrencyException. The old shape emitted
            // every lights-off onto the bus and then saved the whole batch in ONE
            // SaveChanges, so a single lost row threw away the entire tick's work — every
            // other booking's marker with it — while their `booking.lights_off` events had
            // already gone out. The next tick then re-emitted all of them. One lost race
            // therefore cost a dropped sweep AND duplicate events for unrelated courts.
            //
            // Saving before emitting makes the marker the idempotency guard it was always
            // meant to be: at-most-once rather than at-least-once. A process that dies in
            // between loses one lights-off cue, which the Mega's own auto-off timer already
            // backstops by design — whereas a duplicate cue is noise a club's webhook
            // consumer has no way to tell from a real one.
            //
            // R13: the send is inside the lock and so before the commit. A commit that then fails
            // (the connection died — the save itself already passed its concurrency check) loses
            // the marker and the next tick says the off again: the one way this is not at-most-once.
            if (await SaveOneAsync(db, b, ct))
            {
                if (offAt is { } at) await FireLightsAsync(db, tenant, b, on: false, ct, occurredAt: at);
                await cue.CommitAsync(ct);
                if (promoted) await FireCompletedAsync(db, tenant, b, ct);
            }
        }

        // A reversed no-show was cued off at the sweep, when it was NoShow with a truncated
        // end; the reversal put it back to Booked and checked in, and unless its restored
        // end was still ahead (in which case the marker was cleared and the sweep above
        // handles it) nothing would ever promote it: LightsOffCuedAt is set, so the
        // predicate above never sees it again, and it sat as Booked for ever — never
        // Completed, never anonymised by retention. Attended and over is Completed,
        // whether or not the lights-off was already cued.
        await CompleteAttendedAsync(db, tenant, now, ct);
    }

    /// <summary>
    /// The attended-and-over pass: a reversed no-show the off sweep can no longer see is promoted to
    /// Completed (and, R12 E12-3, cued off again when its reversal re-lit it). Lifted out of
    /// <see cref="TickAsync"/> for the complexity gate.
    /// </summary>
    private async Task CompleteAttendedAsync(MainframeDbContext db, ITenantContext tenant, DateTimeOffset now, CancellationToken ct)
    {
        var attendedAndOver = await db.Bookings.IgnoreQueryFilters()
            .Where(b => b.Status == BookingStatus.Booked
                && b.CheckedInAt != null
                && b.LightsOffCuedAt != null
                && b.EndsAt <= now)
            .ToListAsync(ct);
        foreach (var b in attendedAndOver)
        {
            // R13: the court's cue lock, as in the sweep above — this pass can say an off too.
            await using var cue = await CourtCueLock.BeginAsync(db, b.TenantId, b.CourtId, ct);
            b.Status = BookingStatus.Completed;
            // R12 E12-3 (decision I12, amended): a reversal that came AFTER the off cue re-emitted
            // `booking.lights_on` for the late scan, so the court is lit again on every consumer's
            // mirror; its off is said here, once, at the restored end. A reversal before the cue
            // emitted nothing to undo. The row's own cue marker records this second cue.
            var relit = b.NoShowReversedAt is { } reversedAt && b.LightsOffCuedAt is { } cuedAt && reversedAt > cuedAt;
            // R13 E13-1: said at the instant the court is next free, never at this tick — and not at
            // all while another booking still holds the court (its own off closes it).
            var offAt = relit ? await NextFreeAsync(db, b, ct) : null;
            if (offAt is not null) b.LightsOffCuedAt = now;
            // Saved on its own, like the lights-off rows above and for the same reason: a
            // lost concurrency race means another writer decided this booking, and its
            // decision stands. Only a save that stuck may announce itself — a
            // `booking.completed` for a row the database refused would be a club's
            // utilisation report counting a session that never closed.
            if (await SaveOneAsync(db, b, ct))
            {
                if (offAt is { } at) await FireLightsAsync(db, tenant, b, on: false, ct, occurredAt: at);
                await cue.CommitAsync(ct);
                await FireCompletedAsync(db, tenant, b, ct);
            }
        }
    }

    /// <summary>
    /// R13: when a booking's <c>booking.lights_off</c> is said, or null for "not at all" — the end-of-slot
    /// cue and a relit reversal's extra one (E13-1, I12 refined) alike.
    ///
    /// <para>
    /// A collided reversal's restored end is the start of the booking that survived on the court, and
    /// back-to-back slots meet the same way: an off stamped at the tick that sent it arrived after the
    /// next member's <c>lights_on</c> (they scanned in early, or the sweep ran late) and read their paid
    /// session dark. Walking forward from the booking's end: a LIT booking that holds the court at that
    /// instant and whose own off is still to come means this one is not sent — that off closes the
    /// court later by arrival and by <c>occurred_at</c>. One whose off has been said moves the instant
    /// to its end; the first instant no lit booking holds is the stamp. A booking nobody checked in on
    /// lit nothing (the court IS dark), and a club block holds nothing.
    /// </para>
    /// <para>
    /// R14. <b>A lit booking holds the court from when it was lit</b> — <c>min(StartsAt, CheckedInAt)</c>
    /// (D14-1): a member scanned in early across a gap was read only from their start, so the previous
    /// slot's off landed inside their lit session. <b>A cancelled booking that was lit holds it</b> too
    /// (D14-2: its relay runs on to its end, and the sweep now says its off). <b>A relit reversal still
    /// to be closed holds it</b> (E14-4): Booked, with its reversal after its old cue — that cue does not
    /// close the session the reversal re-lit; the attended-and-over pass will.
    /// </para>
    /// </summary>
    internal static async Task<DateTimeOffset?> NextFreeAsync(MainframeDbContext db, Booking b, CancellationToken ct) =>
        (await WalkAsync(db, b, ct)).FreeAt;

    /// <summary>
    /// The walk behind <see cref="NextFreeAsync"/>: the first instant no lit booking holds the court
    /// (null when one whose off is still to come holds it), and that HOLDER. R15 D15-2: a reversal
    /// needs to know not only that the court is held at its restored end but by whom, and since when.
    /// </summary>
    internal static async Task<CourtWalk> WalkAsync(MainframeDbContext db, Booking b, CancellationToken ct)
    {
        var at = b.EndsAt;
        // Untracked: a tracked row would answer with what this tick read before the lock, not now.
        // Only LIT bookings can hold the court, and every lit one is read: a check-in is never ahead
        // of its own cue window, so nothing lit is far in the future.
        var lit = await db.Bookings.IgnoreQueryFilters().AsNoTracking()
            .Where(o => o.TenantId == b.TenantId && o.CourtId == b.CourtId && o.Id != b.Id
                && (o.Status == BookingStatus.Booked || o.Status == BookingStatus.Completed
                    || o.Status == BookingStatus.NoShow || o.Status == BookingStatus.Cancelled)
                && o.CheckedInAt != null
                && o.EndsAt > at)
            .ToListAsync(ct);
        foreach (var holder in lit.OrderBy(LitFrom))
        {
            if (LitFrom(holder) > at) break;
            if (OffStillToCome(holder)) return new CourtWalk(null, holder);
            if (holder.EndsAt > at) at = holder.EndsAt;
        }
        return new CourtWalk(at, null);
    }

    /// <summary>R15 D15-2: what <see cref="WalkAsync"/> found — the free instant, or the lit booking holding the court.</summary>
    internal sealed record CourtWalk(DateTimeOffset? FreeAt, Booking? Holder);

    /// <summary>R14 D14-1: when a lit booking's lights came on — its scan, when that was before its start.</summary>
    /// <remarks>Block body: an expression body holding a property pattern's braces trips lizard (memory/gotchas-build.md).</remarks>
    internal static DateTimeOffset LitFrom(Booking lit)
    {
        return lit.CheckedInAt is { } scan && scan < lit.StartsAt ? scan : lit.StartsAt;
    }

    /// <summary>
    /// Whether a lit booking's own off is still to be said: never cued, or (E14-4) a reversal that is
    /// still Booked and re-lit the court after its old cue — the attended-and-over pass owes its off.
    /// </summary>
    private static bool OffStillToCome(Booking lit)
    {
        return lit.LightsOffCuedAt is not { } cued
            || (lit.Status == BookingStatus.Booked && lit.NoShowReversedAt is { } reversed && reversed > cued);
    }

    /// <summary>
    /// Persists one booking's change, on its own, and answers whether it stuck.
    ///
    /// <para>
    /// A lost optimistic-concurrency race here is a normal outcome, not an error: it means
    /// another writer — the no-show sweeper, a cancellation, a check-in at the pad —
    /// decided this booking between our read and our write, and their decision is the one
    /// that counts. It is logged at information and the sweep carries on with the next
    /// row, which is the whole point of saving one at a time.
    /// </para>
    ///
    /// <para>
    /// The losing entry is detached so the next <c>SaveChanges</c> on this scope's context
    /// does not re-submit the same stale row and fail identically for every remaining
    /// booking in the tick.
    /// </para>
    /// </summary>
    private async Task<bool> SaveOneAsync(MainframeDbContext db, Booking booking, CancellationToken ct)
    {
        try
        {
            await db.SaveChangesAsync(ct);
            return true;
        }
        catch (DbUpdateConcurrencyException)
        {
            _logger.LogInformation(
                "LightsCueWorker lost a concurrent write on booking {BookingId}; another writer decided it",
                booking.Id);
            db.Entry(booking).State = EntityState.Detached;
            return false;
        }
    }

    /// <summary>
    /// <c>booking.completed</c> — a booking's slice ended naturally with the member having
    /// actually been there.
    ///
    /// <para>
    /// Distinct from <c>booking.lights_off</c>, which fires for every booking whose end has
    /// passed including a no-show: this one is the "played and finished" signal a club's
    /// utilisation reporting needs, and it fires only where <c>Status</c> becomes
    /// <see cref="BookingStatus.Completed"/> — which under this worker's ordering means
    /// <c>CheckedInAt</c> was set. After the save, so nothing is mirrored that the database
    /// did not accept.
    /// </para>
    /// </summary>
    private async Task FireCompletedAsync(MainframeDbContext db, ITenantContext tenant, Booking b, CancellationToken ct)
    {
        var court = await db.Courts.IgnoreQueryFilters().FirstAsync(c => c.Id == b.CourtId, ct);
        var tenantRow = await db.Tenants.IgnoreQueryFilters().FirstAsync(t => t.Id == b.TenantId, ct);
        tenant.Set(tenantRow.Id, tenantRow.Slug);

        await _bus.EmitAsync(new DomainEvent(
            Id: $"evt_{Guid.NewGuid():N}",
            Type: "booking.completed",
            TenantId: b.TenantId, TenantSlug: tenantRow.Slug,
            OccurredAt: _clock.GetUtcNow(),
            ActorUserId: null, ActorIsAdmin: false,
            SubjectUserId: b.UserId,
            Data: new()
            {
                ["booking_id"] = b.Id,
                ["court_id"] = b.CourtId,
                ["court_number"] = court.CourtNumber,
                ["court_name"] = court.Name,
                ["user_id"] = b.UserId,
                ["starts_at"] = b.StartsAt,
                ["ends_at"] = b.EndsAt,
                ["checked_in_at"] = b.CheckedInAt,
                ["amount_charged_minutes"] = b.AmountChargedMinutes,
            }), ct);
    }

    /// <param name="occurredAt">When the lights did this, when that is not now (R13 E13-1: a relit reversal's off).</param>
    private async Task FireLightsAsync(
        MainframeDbContext db, ITenantContext tenant, Booking b, bool on, CancellationToken ct, DateTimeOffset? occurredAt = null)
    {
        var court = await db.Courts.IgnoreQueryFilters().FirstAsync(c => c.Id == b.CourtId, ct);
        var tenantRow = await db.Tenants.IgnoreQueryFilters().FirstAsync(t => t.Id == b.TenantId, ct);
        tenant.Set(tenantRow.Id, tenantRow.Slug);

        var data = new Dictionary<string, object?>
        {
            ["booking_id"] = b.Id,
            ["court_id"] = b.CourtId,
            ["court_number"] = court.CourtNumber,
            ["court_name"] = court.Name,
            ["user_id"] = b.UserId,
            ["starts_at"] = b.StartsAt,
            ["ends_at"] = b.EndsAt,
            ["duration_seconds"] = on ? Math.Max(0, (int)(b.EndsAt - _clock.GetUtcNow()).TotalSeconds) : 0,
        };
        await _bus.EmitAsync(new DomainEvent(
            Id: $"evt_{Guid.NewGuid():N}",
            Type: on ? "booking.lights_on" : "booking.lights_off",
            TenantId: b.TenantId, TenantSlug: tenantRow.Slug,
            OccurredAt: occurredAt ?? _clock.GetUtcNow(),
            ActorUserId: null, ActorIsAdmin: false,
            SubjectUserId: b.UserId,
            Data: data), ct);
    }
}
