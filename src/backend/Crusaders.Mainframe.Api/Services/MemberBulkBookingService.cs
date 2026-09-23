using System.Security.Cryptography;
using System.Text;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// D8 — "members get full multiselect" — a member ticking several grid cells, across courts and
/// days, and booking them in one request, <b>under every rule their single booking obeys</b>.
///
/// <para>
/// <b>The admin bulk's semantics, deliberately.</b> Each item is its own unit of work — its own
/// <see cref="BookingService.CreateAsync"/>, its own payer lock, its own commit — and the answer
/// is always a per-item list. There is no transactional batch, for the reasons
/// <see cref="AdminBulkBookingService"/> gives, and one more that is the member's own: a batch
/// whose one taken slot refused the other five would make the multiselect worse than tapping
/// six times. And like the admin bulk, <b>the batch HALTS at the first
/// <c>insufficient_balance</c></b>: continuing would leave a jagged half-booked week, and the
/// member's remedy — top up, then retry under the SAME key — books exactly the rest. Items after
/// the halt answer <c>refused</c> / <c>not_attempted</c> rather than being left off the list, so
/// every item the member ticked has an answer.
/// </para>
///
/// <para>
/// <b>Why this is not the admin service called with a member's id.</b> Three things that are
/// harmless for an admin are defects for a member, and the admin service belongs to another
/// lane's quote work this run:
/// </para>
/// <list type="number">
/// <item><b>The reference is not per-person.</b> <c>bulkbook:{tenant}:{key}:{index}</c> is shared
/// by everybody in the club, so two members whose phones minted the same key would collide on the
/// global unique index — and the second member's replay lookup would hand back the FIRST
/// member's booking as their own. This reference carries the payer.</item>
/// <item><b>The refusals a member meets are not the ones an admin meets.</b> Group windows, the
/// slot cap, crossing midnight and "no bookable window" never reach an admin. Every path names
/// them through the one mapping, <see cref="BookingRefusals.CodeOf"/>, so none of them can fall
/// to <c>booking_failed</c> on one route while it has a word on another.</item>
/// <item><b>A replay is checked, not trusted.</b> The reference is keyed on the item's index, so
/// a key reused for a DIFFERENT list would answer item 0 with whatever item 0 was last time. A
/// replayed booking must be the payer's, on the same court at the same start, or the item is
/// refused <c>idempotency_key_reused</c>.</item>
/// </list>
///
/// <para>
/// <b>No overdraft, ever.</b> The payer is always the caller and
/// <see cref="BookingPayer.AllowNegativeBalance"/> is always false, so whatever the overdraft
/// rule in <see cref="BookingService"/> becomes, it has nothing to lift here: the balance guard
/// under the payer lock refuses any item the member cannot cover, and the batch halts there.
/// </para>
/// </summary>
public sealed class MemberBulkBookingService
{
    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;
    private readonly BookingService _bookings;

    public MemberBulkBookingService(MainframeDbContext db, ITenantContext tenant, BookingService bookings)
    {
        _db = db; _tenant = tenant; _bookings = bookings;
    }

    /// <summary>
    /// The reference one item's debit is posted under.
    ///
    /// <para>
    /// Tenant AND payer AND key AND index. The key is hashed rather than embedded because the
    /// ledger's <c>ExternalReference</c> is 255 characters, and a 200-character key beside two
    /// guids would not fit — a reference that is truncated is a reference that collides.
    /// </para>
    /// </summary>
    public string Reference(Guid userId, string key, int index)
    {
        var digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key)))[..32].ToLowerInvariant();
        return $"memberbulk:{_tenant.TenantId:N}:{userId:N}:{digest}:{index}";
    }

    /// <summary>
    /// Books each item in turn for the caller, halting at the first <c>insufficient_balance</c>.
    /// </summary>
    public async Task<MemberBulkOutcome> BookAsync(
        IReadOnlyList<BulkBookItem> items, MemberBulkRequest request, CancellationToken ct)
    {
        var courts = await _db.Courts.AsNoTracking().ToDictionaryAsync(c => c.Id, c => c.Name, ct);
        var results = new List<MemberBulkResult>(items.Count);
        int? haltedAt = null;

        for (var index = 0; index < items.Count; index++)
        {
            var item = items[index];
            var courtName = courts.TryGetValue(item.CourtId, out var name) ? name : null;

            if (haltedAt is not null)
            {
                results.Add(MemberBulkResult.Refused(index, item, courtName, BookingRefusals.NotAttempted));
                continue;
            }

            var result = await BookOneAsync(item, index, courtName, request, ct);
            results.Add(result);
            if (result.Reason == BookingRefusals.InsufficientBalance) haltedAt = index;
        }

        return new MemberBulkOutcome(
            results, haltedAt, haltedAt is null ? null : BookingRefusals.InsufficientBalance);
    }

    /// <summary>
    /// One item, through the single-booking path. Block body for the lizard reason in
    /// <c>memory/gotchas-gates.md</c>.
    /// </summary>
    private async Task<MemberBulkResult> BookOneAsync(
        BulkBookItem item, int index, string? courtName, MemberBulkRequest request, CancellationToken ct)
    {
        var reference = Reference(request.UserId, request.IdempotencyKey, index);
        if (await BulkReplay.FindAsync(_db, reference, request.UserId, item, ct) is { } earlier)
        {
            return Replay(index, item, courtName, earlier, request.UserId);
        }

        // Payer and actor are the caller. ActorIsAdmin is the ROLE CLAIM, exactly as the single
        // member route takes it — an admin booking for themselves through the member surface is
        // still an admin for the rules — and AllowNegativeBalance is false, full stop.
        var payer = new BookingPayer(request.UserId, request.UserId, AllowNegativeBalance: false, request.ActorIsAdmin);
        var outcome = await _bookings.CreateAsync(
            item.CourtId, payer, item.StartsAt, item.SliceCount, ct, externalReference: reference);

        if (outcome is BookingResult.Ok ok)
        {
            return MemberBulkResult.Booked(index, ok.Booking, courtName, replayed: false);
        }

        // The same item in flight twice — a double-tapped button. The unique index refused the
        // second debit; the first one's booking is the answer, if it is this item's. On a free
        // court there is no debit to collide on (I10), so the twin loses the slot race instead —
        // and the first one's booking is the answer to that as well.
        if (outcome is BookingResult.DuplicateRequest or BookingResult.SlotTaken
            && await BulkReplay.FindAsync(_db, reference, request.UserId, item, ct) is { } twin)
        {
            return Replay(index, item, courtName, twin, request.UserId);
        }

        return MemberBulkResult.Refused(index, item, courtName, BookingRefusals.CodeOf(outcome));
    }

    /// <summary>
    /// A booking an earlier attempt under this reference produced, answered as that attempt
    /// answered it — or refused, when the key has been reused for a different list or the
    /// booking has since been cancelled (<see cref="BulkReplay.RefusalFor"/>).
    /// </summary>
    private static MemberBulkResult Replay(
        int index, BulkBookItem item, string? courtName, Booking earlier, Guid userId)
    {
        return BulkReplay.RefusalFor(earlier, userId, item) is { } refusal
            ? MemberBulkResult.Refused(index, item, courtName, refusal)
            : MemberBulkResult.Booked(index, earlier, courtName, replayed: true);
    }
}

/// <summary>Who is booking, and under which key. The payer is always the caller.</summary>
public readonly record struct MemberBulkRequest(Guid UserId, bool ActorIsAdmin, string IdempotencyKey);

/// <summary>What happened to one item in a member's bulk book. A closed set of two.</summary>
public static class MemberBulkStatuses
{
    public const string Booked = "booked";
    public const string Refused = "refused";
}

/// <summary>One row of a member bulk book's answer.</summary>
public sealed record MemberBulkResult(
    int Index, Guid CourtId, string? CourtName, DateTimeOffset StartsAt, DateTimeOffset? EndsAt,
    string Status, string? Reason, Guid? BookingId, decimal AmountCredits, bool Replayed)
{
    public static MemberBulkResult Booked(int index, Booking booking, string? courtName, bool replayed)
    {
        return new MemberBulkResult(
            index, booking.CourtId, courtName, booking.StartsAt, booking.EndsAt,
            MemberBulkStatuses.Booked, null, booking.Id, booking.AmountChargedCredits, replayed);
    }

    public static MemberBulkResult Refused(int index, BulkBookItem item, string? courtName, string reason)
    {
        return new MemberBulkResult(
            index, item.CourtId, courtName, item.StartsAt, null,
            MemberBulkStatuses.Refused, reason, null, 0m, false);
    }
}

/// <summary>A whole member bulk book's answer.</summary>
public sealed record MemberBulkOutcome(IReadOnlyList<MemberBulkResult> Results, int? HaltedAt, string? HaltedReason);
