using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// Admin-only ledger view. Returns the same money-movement events the user sees in their
/// wallet, but across every user in the tenant and pre-shaped as from / to / amount / time / comment
/// so it reads like a market order book.
/// </summary>
public static class AdminLedgerEndpoints
{
    public static IEndpointRouteBuilder MapAdminLedgerEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1/admin/ledger").RequireAuthorization(p => p.RequireRole("admin"));

        g.MapGet("/", async (
            DateTimeOffset? from, DateTimeOffset? to,
            Guid? userId, string? type, int? limit,
            MainframeDbContext db, CancellationToken ct) =>
        {
            var fromUtc = from ?? DateTimeOffset.UtcNow.AddDays(-90);
            var toUtc = to ?? DateTimeOffset.UtcNow.AddDays(1);
            var take = Math.Clamp(limit ?? 500, 1, 5000);

            var q = db.LedgerEntries.AsNoTracking()
                .Where(l => l.CreatedAt >= fromUtc && l.CreatedAt < toUtc);
            if (userId is { } u) q = q.Where(l => l.UserId == u);
            if (!string.IsNullOrWhiteSpace(type) && Enum.TryParse<LedgerEntryType>(type, true, out var t))
                q = q.Where(l => l.Type == t);

            var entries = await q.OrderByDescending(l => l.CreatedAt).Take(take).ToListAsync(ct);

            // Resolve display names for both subjects and actors in one round-trip.
            var ids = entries.Select(e => e.UserId).Concat(entries.Select(e => e.ActorUserId)).Distinct().ToList();
            var nameByUserId = await db.Memberships.AsNoTracking().IgnoreQueryFilters()
                .Where(m => ids.Contains(m.UserId))
                .ToDictionaryAsync(m => m.UserId, m => m.FullName, ct);
            var emailByUserId = await db.Users.AsNoTracking().IgnoreQueryFilters()
                .Where(u2 => ids.Contains(u2.Id))
                .ToDictionaryAsync(u2 => u2.Id, u2 => u2.Email, ct);

            string nameFor(Guid id) => nameByUserId.TryGetValue(id, out var n) ? n
                : emailByUserId.TryGetValue(id, out var e) ? e
                : "(unknown)";

            var rows = entries.Select(e => LedgerRowMapper.Build(e, nameFor)).ToList();
            return Results.Ok(rows);
        });

        return app;
    }
}

public static class LedgerRowMapper
{
    public const string Treasury = "Club treasury";
    public const string PaymentGateway = "PayFast";

    public static LedgerRowDto Build(LedgerEntry e, Func<Guid, string> nameFor)
    {
        var subject = nameFor(e.UserId);
        var actor = nameFor(e.ActorUserId);

        // Direction: positive amount = funds flow INTO the subject's wallet; negative = OUT.
        // The other party depends on the entry type.
        var (counterparty, comment) = e.Type switch
        {
            LedgerEntryType.TopUp =>
                (PaymentGateway, e.Reason ?? "Wallet top-up"),
            LedgerEntryType.BookingCharge =>
                (Treasury, e.Reason ?? "Booking charge"),
            LedgerEntryType.CancellationRefund =>
                (Treasury, e.Reason ?? "Cancellation refund"),
            LedgerEntryType.NoShowPenalty =>
                (Treasury, e.Reason ?? "No-show penalty"),
            LedgerEntryType.LateCancellationPenalty =>
                (Treasury, e.Reason ?? "Late-cancellation penalty"),
            LedgerEntryType.AdminAdjustment =>
                (actor == subject ? Treasury : actor, e.Reason ?? "Admin adjustment"),
            LedgerEntryType.PaymentReversal =>
                (PaymentGateway, e.Reason ?? "Payment reversal"),
            _ => (Treasury, e.Reason ?? e.Type.ToString()),
        };

        var (fromLabel, toLabel) = e.AmountCredits >= 0
            ? (counterparty, subject)   // money flowed INTO subject
            : (subject, counterparty);  // money flowed OUT of subject

        return new LedgerRowDto(
            Id: e.Id,
            At: e.CreatedAt,
            From: fromLabel,
            To: toLabel,
            AmountCredits: Math.Abs(e.AmountCredits),
            SignedAmountCredits: e.AmountCredits,
            Type: e.Type.ToString(),
            Comment: comment,
            SubjectUserId: e.UserId,
            SubjectName: subject,
            ActorUserId: e.ActorUserId,
            ActorName: actor,
            RelatedBookingId: e.RelatedBookingId);
    }
}

public sealed record LedgerRowDto(
    Guid Id,
    DateTimeOffset At,
    string From,
    string To,
    decimal AmountCredits,

    /// <summary>
    /// The same amount, keeping its sign, so a reader can tell money in from money out
    /// without re-deriving it from the type.
    ///
    /// <para>
    /// This was <c>SignedAmountZar</c> while holding credits — the unit lie
    /// <c>CLAUDE.md</c> says must never be added a second time. It was also simply broken:
    /// the frontend has always read <c>signedAmountCredits</c>, so the field arrived
    /// undefined, every row in the admin ledger and the member wallet rendered with a minus
    /// sign, and the credits/debits totals on the admin ledger page were both zero.
    /// </para>
    /// </summary>
    decimal SignedAmountCredits,
    string Type,
    string Comment,
    Guid SubjectUserId,
    string SubjectName,
    Guid ActorUserId,
    string ActorName,
    Guid? RelatedBookingId);
