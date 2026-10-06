using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>One partner's share that goes back to them when the organiser cancels.</summary>
public sealed record PartnerRefund(
    [property: System.Text.Json.Serialization.JsonPropertyName("user_id")] Guid UserId,
    [property: System.Text.Json.Serialization.JsonPropertyName("name")] string Name,
    [property: System.Text.Json.Serialization.JsonPropertyName("minutes")] int Minutes);

/// <summary>
/// What a cancellation does to a SPLIT booking's money (review round 1, B3). The organiser's
/// refund lands in their wallet, and then every partner's share follows the organiser's
/// <c>Owed</c> back out (D11) — so the sheet that said "200 back" to an organiser whose partners
/// had paid 80 of it overstated what they keep by 80. The quote and the cancel answer name each
/// partner's refund and the organiser's net.
///
/// <para>
/// <b>The rule is <see cref="ShareLedger.TargetFor"/>, not a copy of it.</b> The quote asks the
/// real rule what each accepted partner's target becomes once the booking is cancelled with the
/// organiser's net refund off its <c>Owed</c>; a partner's refund is what they paid above that.
/// (Today that is everything they paid unless the lights have been on, when it is nothing — the
/// late-cancel penalty is the organiser's alone.) After a cancellation the same sum is taken from
/// what each partner had paid when the cancel took the booking — read off the ledger afterwards
/// (R19 J19-4) — so a return that has to wait for cover (D11, returns) is still reported as owed
/// back to them, and an accept that landed while the cancel was on its way is reported too.
/// </para>
/// </summary>
public sealed class SplitCancelView
{
    private readonly MainframeDbContext _db;
    private readonly ShareLedger _shares;
    private readonly TenantSettingsAccessor _settings;

    public SplitCancelView(MainframeDbContext db, ShareLedger shares, TenantSettingsAccessor settings)
    {
        _db = db; _shares = shares; _settings = settings;
    }

    /// <summary>
    /// The refunds a cancellation that returns <paramref name="netRefund"/> to the organiser would
    /// send on to the partners, per the share rule.
    /// </summary>
    public async Task<List<PartnerRefund>> QuoteAsync(Booking booking, int netRefund, CancellationToken ct)
    {
        var seats = await PartnerSeatsAsync(booking.Id, ct);
        if (seats.Count == 0) return [];

        var owedAfter = await _shares.OwedAsync(booking, ct) - netRefund;
        var cancelled = new Booking
        {
            Id = booking.Id,
            TenantId = booking.TenantId,
            Status = BookingStatus.Cancelled,
            CheckedInAt = booking.CheckedInAt,
            AmountChargedMinutes = booking.AmountChargedMinutes,
            CancellationReason = booking.CancellationReason,
        };
        var settings = await _settings.GetAsync(ct);
        var paidBefore = new Dictionary<Guid, int>();
        var targetAfter = new Dictionary<Guid, int>();
        foreach (var s in seats)
        {
            var paid = await _shares.PaidAsync(s, ct);
            paidBefore[s.Id] = paid;
            var closed = ShareLedger.IsClosed(booking, s, settings, DateTimeOffset.UtcNow);
            targetAfter[s.Id] = ShareLedger.TargetFor(cancelled, s, owedAfter, paid, closed);
        }
        return await NameAsync(seats, s => paidBefore[s.Id] - targetAfter[s.Id], ct);
    }

    /// <summary>
    /// After the cancellation has settled: each partner's refund — what they had paid when the cancel
    /// took the booking, less what the share rule leaves them now.
    ///
    /// <para>
    /// <b>R19 J19-4: "what they had paid" is read off the ledger AFTER the fact, never off a snapshot
    /// taken before the cancel.</b> A partner's accept that landed while the cancel was on its way (the
    /// accept holds the booking row; the cancel's write waits for it) paid a share the snapshot never
    /// saw, the cancel's reconcile sent it straight back, and the answer said <c>partner_refunds: []</c>
    /// with a net that counted the partner's minutes as the organiser's. Now: paid at the cancel = what
    /// is still paid in + every return posted from the cancellation's instant on
    /// (<see cref="ShareLedger.ReturnedOfAsync"/>, the detail view's M4-4 rule). A collection can only
    /// land before the cancel (a cancelled game collects nothing), so it is in the first term; a return
    /// that has to wait for cover is still paid in, so it is still reported as owed back.
    /// </para>
    /// </summary>
    public async Task<List<PartnerRefund>> AfterAsync(Guid bookingId, CancellationToken ct)
    {
        var booking = await _db.Bookings.AsNoTracking().FirstOrDefaultAsync(b => b.Id == bookingId, ct);
        if (booking is null) return [];

        var seats = await PartnerSeatsAsync(bookingId, ct);
        if (seats.Count == 0) return [];
        var owed = await _shares.OwedAsync(booking, ct);
        var settings = await _settings.GetAsync(ct);
        var refunds = new Dictionary<Guid, int>();
        foreach (var s in seats)
        {
            var returned = booking.CancelledAt is { } at ? await ShareLedger.ReturnedOfAsync(_db, s, ct, at) : 0;
            var paidAtCancel = await _shares.PaidAsync(s, ct) + returned;
            var target = ShareLedger.TargetFor(booking, s, owed, paidAtCancel, ShareLedger.IsClosed(booking, s, settings, DateTimeOffset.UtcNow));
            refunds[s.Id] = paidAtCancel - target;
        }
        return await NameAsync(seats, s => refunds[s.Id], ct);
    }

    private Task<List<BookingParticipant>> PartnerSeatsAsync(Guid bookingId, CancellationToken ct) =>
        _db.BookingParticipants.AsNoTracking()
            .Where(p => p.BookingId == bookingId && p.Seat > 1 && p.UserId != null && p.GuestName == null)
            .OrderBy(p => p.Seat)
            .ToListAsync(ct);

    private async Task<List<PartnerRefund>> NameAsync(List<BookingParticipant> seats, Func<BookingParticipant, int> refund, CancellationToken ct)
    {
        var due = seats.Select(s => (Seat: s, Minutes: Math.Max(0, refund(s)))).Where(x => x.Minutes > 0).ToList();
        if (due.Count == 0) return [];
        var ids = due.Select(x => x.Seat.UserId!.Value).ToList();
        var names = await _db.Memberships.AsNoTracking().Where(m => ids.Contains(m.UserId))
            .ToDictionaryAsync(m => m.UserId, m => m.FullName, ct);
        return [.. due.Select(x => new PartnerRefund(x.Seat.UserId!.Value, names.GetValueOrDefault(x.Seat.UserId!.Value) ?? "", x.Minutes))];
    }
}
