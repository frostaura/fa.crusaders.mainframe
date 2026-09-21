using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>One relay a box should re-energise after a power cut, and for how much longer.</summary>
/// <param name="Relay">The relay index on this board, 0–3. An index, never a quantity.</param>
/// <param name="CourtId">The court that relay is wired to.</param>
/// <param name="CourtNumber">That court's club-facing number.</param>
/// <param name="BookingId">The booking the remaining time belongs to.</param>
/// <param name="RemainingSeconds">True remaining seconds, UNCAPPED — see <see cref="RelayRestorePlan"/>.</param>
/// <param name="EndsAt">When the grant ends, for the projection row.</param>
/// <param name="CausedByUserId">Whose booking it is, so "restored after power loss" can still name a member.</param>
public sealed record RelayRestoreItem(
    int Relay, Guid CourtId, int CourtNumber, Guid BookingId, int RemainingSeconds,
    DateTimeOffset EndsAt, Guid? CausedByUserId)
{
    /// <summary>
    /// The wire element: <c>&lt;relay&gt;|&lt;remaining_seconds&gt;|&lt;booking_ref&gt;</c>.
    ///
    /// <para>
    /// <b>A pipe-delimited string and not an object, deliberately.</b> The firmware has a
    /// heapless JSON <i>scanner</i>, not a parser — it offers a string-element walker and a
    /// number-element walker and no object-array walker at all. The roster already proves this
    /// idiom works on this board and the firmware already has the code that walks it. Adding an
    /// object walker to a heapless scanner on a part with no allocator is a new failure surface
    /// for no gain.
    /// </para>
    ///
    /// <para>
    /// <b>The reference is the first eight hex of the booking id and never an activation
    /// code.</b> It exists so the trace can pair a restore with its booking; a live code would
    /// be a credential travelling to a board that has no use for it.
    /// </para>
    /// </summary>
    public string ToWire() => $"{Relay}|{RemainingSeconds}|{Reference}";

    /// <summary>The booking's short reference — the first eight hex characters of its id.</summary>
    public string Reference => BookingId.ToString("N")[..8];
}

/// <summary>
/// What the API believes should be lit on one board right now — GOAL item 17's answer.
///
/// <para>
/// <b>Why this reads BOOKINGS and not <c>court_light_state</c>.</b> The projection is the
/// server's belief, and the health sweep sets it to <c>Unknown</c> precisely when a board goes
/// dark — which is the same power cut the restore exists to recover from. Computing the restore
/// from the projection would therefore return nothing in exactly the case it is for. Bookings
/// are the durable truth: <c>CheckedInAt</c> records that the lights were actually cued, and
/// <c>EndsAt</c> records what the member paid for. The projection is where the restore is
/// RECORDED, not where it is computed.
/// </para>
///
/// <para>
/// <b>The receipts clause is the one that stops a member being re-lit against their will.</b> A
/// member who pressed OFF early has a <c>release</c> receipt on that relay after their check-in
/// — and the server's own <c>LightsOffCuedAt</c> does NOT record it, because that column is set
/// by the slot-end sweep rather than by the device. Without the clause, a box rebooting after a
/// dip would re-light a court its occupant deliberately switched off and had walked away from.
/// The index it needs already exists for release pairing.
/// </para>
///
/// <para>
/// <b><c>remaining_seconds</c> is uncapped and relative to this response.</b> The box clamps to
/// the relay hard cap itself — twice, on both halves — and arms its re-light timer from the
/// uncapped value, so capping here would silently shorten a member's court. Relative rather
/// than absolute is what makes this work on a board with no RTC, and it is why the restore is
/// safe even when the box's clock is unknown: the arithmetic never touches a wall clock.
/// </para>
///
/// <para>
/// <b>An empty list switches nothing off.</b> It is information that nothing SHOULD be on,
/// which matters only at boot — when nothing IS on. Making it an off-command would hand the API
/// a way to darken a court somebody is playing on, which it must not have, and would contradict
/// the founding split that the box drives the relay.
/// </para>
/// </summary>
public static class RelayRestorePlan
{
    /// <summary>
    /// The relays this board should re-energise, in relay order, at <paramref name="now"/>.
    /// Only relays that should be ON appear.
    /// </summary>
    public static async Task<IReadOnlyList<RelayRestoreItem>> ForAsync(
        MainframeDbContext db, Device device, DateTimeOffset now, CancellationToken ct)
    {
        var numbers = device.CourtNumbers;
        if (numbers.Count == 0) return [];

        var courts = await db.Courts.AsNoTracking()
            .Where(c => numbers.Contains(c.CourtNumber))
            .ToListAsync(ct);
        if (courts.Count == 0) return [];

        var courtIds = courts.Select(c => c.Id).ToList();

        // The live, cued, unreleased bookings on this board's courts. One query for all four
        // relays: a heartbeat runs every minute per board and four round trips per beat is
        // four round trips.
        var live = await db.Bookings.AsNoTracking()
            .Where(b => courtIds.Contains(b.CourtId)
                        && b.CheckedInAt != null          // the lights were actually cued
                        && b.LightsOffCuedAt == null      // the slot-end sweep has not run
                        && b.CancelledAt == null
                        && b.StartsAt <= now
                        && b.EndsAt > now)
            .ToListAsync(ct);
        if (live.Count == 0) return [];

        // Every release this board has reported on any of these relays since the earliest
        // check-in in the set. Read once rather than per booking, and bounded by that instant
        // so a board with a year of history does not scan it.
        var earliest = live.Min(b => b.CheckedInAt!.Value);
        var releases = await db.DeviceEventReceipts.AsNoTracking()
            .Where(r => r.DeviceId == device.Id
                        && r.Kind == Endpoints.DeviceEventEndpoints.ReleaseKind
                        && r.OccurredAt > earliest)
            .Select(r => new { r.Court, r.OccurredAt })
            .ToListAsync(ct);

        var items = new List<RelayRestoreItem>(numbers.Count);
        for (var relay = 0; relay < numbers.Count; relay++)
        {
            var court = courts.FirstOrDefault(c => c.CourtNumber == numbers[relay]);
            if (court is null) continue;

            // A court with two live cued bookings is not a state the booking engine can
            // produce — the GiST exclusion constraint forbids overlapping slots — but reading
            // the LATEST rather than the first means a back-to-back pair whose predecessor was
            // never swept restores the one the member is actually playing.
            var booking = live.Where(b => b.CourtId == court.Id)
                .OrderByDescending(b => b.StartsAt)
                .FirstOrDefault();
            if (booking is null) continue;

            var checkedIn = booking.CheckedInAt!.Value;
            if (releases.Any(r => r.Court == relay && r.OccurredAt > checkedIn)) continue;

            var remaining = (int)Math.Ceiling((booking.EndsAt - now).TotalSeconds);
            if (remaining <= 0) continue;

            items.Add(new RelayRestoreItem(
                relay, court.Id, court.CourtNumber, booking.Id, remaining, booking.EndsAt,
                booking.PaidByUserId ?? booking.UserId));
        }

        return items;
    }
}
