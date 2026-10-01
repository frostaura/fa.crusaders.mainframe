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
/// what each partner had paid BEFORE it, so a return that has to wait for cover (D11, returns) is
/// still reported as owed back to them.
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

    /// <summary>What each accepted member partner has paid towards this booking, now.</summary>
    public async Task<Dictionary<Guid, int>> PaidByPartnerAsync(Guid bookingId, CancellationToken ct)
    {
        var seats = await PartnerSeatsAsync(bookingId, ct);
        var paid = new Dictionary<Guid, int>();
        foreach (var s in seats) paid[s.Id] = await _shares.PaidAsync(s, ct);
        return paid;
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

    /// <summary>After the cancellation has settled: each partner's refund against what they had paid before it.</summary>
    public async Task<List<PartnerRefund>> AfterAsync(Guid bookingId, Dictionary<Guid, int> paidBefore, CancellationToken ct)
    {
        var booking = await _db.Bookings.AsNoTracking().FirstOrDefaultAsync(b => b.Id == bookingId, ct);
        if (booking is null || paidBefore.Count == 0) return [];

        var seats = await PartnerSeatsAsync(bookingId, ct);
        var owed = await _shares.OwedAsync(booking, ct);
        var settings = await _settings.GetAsync(ct);
        var targets = new Dictionary<Guid, int>();
        foreach (var s in seats)
        {
            var before = paidBefore.GetValueOrDefault(s.Id);
            targets[s.Id] = ShareLedger.TargetFor(booking, s, owed, before, ShareLedger.IsClosed(booking, s, settings, DateTimeOffset.UtcNow));
        }
        return await NameAsync(seats, s => paidBefore.GetValueOrDefault(s.Id) - targets[s.Id], ct);
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
