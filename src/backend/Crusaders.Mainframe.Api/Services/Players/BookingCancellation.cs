using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Who cancelled a cancelled booking, and why, as its players may be told (review round 13, J13-6 /
/// E13-6, contract C13-1): the booking page said only "This game was cancelled", and the partner's
/// "Game cancelled" mail never said the club had done it.
///
/// <para>
/// <b>Read from the record, not stored on the booking.</b> <see cref="Booking.CancellationReason"/>
/// is the displacement's money discriminator and must never carry prose (see
/// <c>BookingService.CancelAsync</c>); the cancellation's own <c>booking.cancelled</c> audit row
/// already holds the actor and the desk's words (<c>reason</c>; before R17 <c>waive_reason</c> — the
/// admin route passes its required reason there), written in the cancellation's save. The admin's NAME is not given to
/// members: "the club" cancelled it.
/// </para>
/// </summary>
/// <param name="By"><see cref="Member"/> or <see cref="Club"/>.</param>
/// <param name="Cause"><see cref="Displaced"/> when the system displaced it; null otherwise.</param>
/// <param name="Reason">The desk's recorded words on a club cancel; null otherwise.</param>
public sealed record BookingCancellation(string By, string? Cause, string? Reason)
{
    public const string Member = "member";
    public const string Club = "club";
    public const string Displaced = "displaced";

    /// <summary>The three wire fields of C13-1 — all null when <paramref name="c"/> is.</summary>
    public static (string? By, string? Cause, string? Reason) Wire(BookingCancellation? c)
    {
        return c is null ? (null, null, null) : (c.By, c.Cause, c.Reason);
    }

    /// <summary>
    /// R14 E14-2: who cancelled it, off the record — the organiser, or the admin at the desk; null for
    /// the club's system (a displacement, or a row written by the system). The share returns name them.
    /// </summary>
    public Guid? ActorUserId { get; init; }

    /// <summary>True when the club (a person at the desk, or its system) cancelled it.</summary>
    public bool ByClub => By == Club;

    /// <summary>
    /// The facts for <paramref name="booking"/>, or null when it is not cancelled — or is, with no
    /// record of who did it (a row older than the record, or written by hand).
    /// </summary>
    public static async Task<BookingCancellation?> ForAsync(MainframeDbContext db, Booking booking, CancellationToken ct)
    {
        if (booking.Status != BookingStatus.Cancelled) return null;
        if (booking.CancellationReason == BookingService.ResoldTailRefunded || booking.DisplacedByBookingId is not null)
        {
            return new BookingCancellation(Club, Displaced, null);
        }

        var row = await CancelledRowAsync(db, booking, ct);
        if (row is null) return null;
        var byClub = row.ActorUserId == Guid.Empty || row.ActorUserId != booking.UserId;
        return new BookingCancellation(byClub ? Club : Member, null, byClub ? ReasonOf(row.DetailsJson) : null)
        {
            ActorUserId = row.ActorUserId == Guid.Empty ? null : row.ActorUserId,
        };
    }

    /// <summary>The newest <c>booking.cancelled</c> row naming this booking, on its member's record.</summary>
    private static async Task<AuditLog?> CancelledRowAsync(MainframeDbContext db, Booking booking, CancellationToken ct)
    {
        var rows = db.AuditLogs.AsNoTracking()
            .Where(a => a.Action == CancelledAction && a.SubjectUserId == booking.UserId && a.DetailsJson != null);
        if (db.Database.IsNpgsql())
        {
            var containment = JsonSerializer.Serialize(new { booking_id = booking.Id });
            return await rows.Where(a => EF.Functions.JsonContains(a.DetailsJson!, containment))
                .OrderByDescending(a => a.CreatedAt).FirstOrDefaultAsync(ct);
        }
        // The unit suites' in-memory provider has no jsonb containment: the same filter, client side.
        var id = booking.Id.ToString();
        return (await rows.ToListAsync(ct))
            .Where(a => a.DetailsJson!.Contains(id, StringComparison.OrdinalIgnoreCase))
            .MaxBy(a => a.CreatedAt);
    }

    /// <summary>The audit action every cancellation writes (<c>BookingService.CancelAsync</c>).</summary>
    private const string CancelledAction = "booking.cancelled";

    /// <summary>
    /// The desk's words: <c>reason</c> since R17 E17-7 (BE17b — <c>waive_reason</c> is now written only
    /// when a penalty was waived), else <c>waive_reason</c>, which every row before R17 carries.
    /// </summary>
    private static string? ReasonOf(string? details)
    {
        if (details is null) return null;
        using var doc = JsonDocument.Parse(details);
        return Words(doc.RootElement, "reason") ?? Words(doc.RootElement, "waive_reason");
    }

    private static string? Words(JsonElement root, string key)
    {
        return root.TryGetProperty(key, out var r) && r.ValueKind == JsonValueKind.String && r.GetString()?.Trim() is { Length: > 0 } words
            ? words
            : null;
    }
}
