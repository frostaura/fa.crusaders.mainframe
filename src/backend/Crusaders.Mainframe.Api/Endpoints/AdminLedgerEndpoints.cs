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

        g.MapGet("/", ListAsync);

        return app;
    }

    /// <summary>
    /// The query string. <c>cursor</c> is the perf round's (2026-09-30) additive paging switch:
    /// ABSENT, the answer is the bare array it always was (newest first, <c>limit</c> default 500,
    /// max 5000); PRESENT — even empty, for the first page — it is <c>{ items, next_cursor }</c>,
    /// keyset-paged newest first by (at, id), <c>limit</c> default 100, max 500, and the first
    /// page carries the whole range's <c>totals</c> (null on later pages).
    /// </summary>
    public sealed record LedgerQuery(DateTimeOffset? From, DateTimeOffset? To, Guid? UserId, string? Type, int? Limit, string? Cursor);

    private static async Task<IResult> ListAsync([AsParameters] LedgerQuery query, HttpContext ctx, MainframeDbContext db, CancellationToken ct)
    {
        var paged = ctx.Request.Query.ContainsKey("cursor");
        var after = AdminChangeCursor.Parse(query.Cursor);
        if (paged && !string.IsNullOrEmpty(query.Cursor) && after is null)
        {
            return Results.BadRequest(new { error = "cursor_invalid" });
        }

        var take = paged ? Math.Clamp(query.Limit ?? 100, 1, 500) : Math.Clamp(query.Limit ?? 500, 1, 5000);
        var entries = await Filtered(db, query, after).Take(paged ? take + 1 : take).ToListAsync(ct);
        var more = paged && entries.Count > take;
        if (more) entries.RemoveAt(entries.Count - 1);

        var rows = await RowsAsync(db, entries, ct);
        if (!paged) return Results.Ok(rows);
        return Results.Ok(new
        {
            items = rows,
            next_cursor = more ? new AdminChangeCursor(entries[^1].CreatedAt, entries[^1].Id).Encode() : null,
            // Review round 4 (A4 carry-over): the WHOLE range's totals, on the first page only.
            // The console summed what it had read, and a range past its cap read "1000
            // movements" with sums over a truncated set.
            totals = after is null ? await TotalsAsync(db, query, ct) : null,
        });
    }

    /// <summary>Count, minutes in, minutes out (a magnitude) and net over the filtered range (P13 §12.7).</summary>
    private static async Task<object> TotalsAsync(MainframeDbContext db, LedgerQuery query, CancellationToken ct)
    {
        var range = Filtered(db, query, null);
        var count = await range.CountAsync(ct);
        var inMinutes = await range.Where(l => l.AmountMinutes > 0).SumAsync(l => l.AmountMinutes, ct);
        var outMinutes = await range.Where(l => l.AmountMinutes < 0).SumAsync(l => -l.AmountMinutes, ct);
        return new { count, in_minutes = inMinutes, out_minutes = outMinutes, net_minutes = inMinutes - outMinutes };
    }

    /// <summary>The window, the filters and the keyset, newest first with the id as tie-break.</summary>
    private static IQueryable<LedgerEntry> Filtered(MainframeDbContext db, LedgerQuery query, AdminChangeCursor? after)
    {
        // B-9: a query-string instant keeps the offset it was sent with; Npgsql refuses one.
        var fromUtc = (query.From ?? DateTimeOffset.UtcNow.AddDays(-90)).ToUniversalTime();
        var toUtc = (query.To ?? DateTimeOffset.UtcNow.AddDays(1)).ToUniversalTime();

        var q = db.LedgerEntries.AsNoTracking()
            .Where(l => l.CreatedAt >= fromUtc && l.CreatedAt < toUtc);
        if (query.UserId is { } u) q = q.Where(l => l.UserId == u);
        if (!string.IsNullOrWhiteSpace(query.Type) && Enum.TryParse<LedgerEntryType>(query.Type, true, out var t))
        {
            q = q.Where(l => l.Type == t);
        }
        if (after is not null)
        {
            var (at, id) = (after.At, after.Id);
            q = q.Where(l => l.CreatedAt < at || (l.CreatedAt == at && l.Id.CompareTo(id) < 0));
        }
        return q.OrderByDescending(l => l.CreatedAt).ThenByDescending(l => l.Id);
    }

    private static async Task<List<LedgerRowDto>> RowsAsync(MainframeDbContext db, List<LedgerEntry> entries, CancellationToken ct)
    {
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
        var admins = await LedgerRowMapper.AdminsAsync(db, ids, ct);
        var counterparties = await LedgerRowMapper.ShareCounterpartiesAsync(db, entries, ct);

        var codes = await DeskCodesAsync(db, entries, ct);

        // R9 J9-3: the rand and the desk's code travel with each row, so a package GIVEN at no
        // charge is not "sold" on the Transactions page.
        return entries.Select(e => LedgerRowMapper.Build(e, nameFor, admins.Contains, counterparties) with
        {
            ZarPaid = e.ZarPaid,
            ReasonCode = codes.GetValueOrDefault(e.Id),
        }).ToList();
    }

    /// <summary>
    /// The desk's code for each by-hand row on this page (review round 9, J9-3), read off the desk
    /// audit row that names the entry (<c>credit.adjusted</c>, <c>entry_id</c>, <c>reason_code</c>)
    /// — the ledger row itself never stored it, and this needs no migration. Tenant-filtered like
    /// every read; only the page's desk rows are looked for, in the window they were written in.
    /// </summary>
    private static async Task<Dictionary<Guid, string>> DeskCodesAsync(MainframeDbContext db, List<LedgerEntry> entries, CancellationToken ct)
    {
        var desk = entries.Where(e => e.Type is LedgerEntryType.AdminTopUp or LedgerEntryType.AdminAdjustment).ToList();
        if (desk.Count == 0) return [];
        var users = desk.Select(e => e.UserId).Distinct().ToList();
        var from = desk.Min(e => e.CreatedAt).AddMinutes(-1);
        var to = desk.Max(e => e.CreatedAt).AddMinutes(1);
        var audits = await db.AuditLogs.AsNoTracking()
            .Where(a => a.Action == AdminCreditReasons.AuditAction && a.SubjectUserId != null && users.Contains(a.SubjectUserId.Value)
                        && a.CreatedAt >= from && a.CreatedAt <= to)
            .Select(a => a.DetailsJson)
            .ToListAsync(ct);

        var ids = desk.Select(e => e.Id).ToHashSet();
        var codes = new Dictionary<Guid, string>();
        foreach (var json in audits)
        {
            var details = DoorActivityView.Details(json);
            if (details is not { } root || root.ValueKind != System.Text.Json.JsonValueKind.Object) continue;
            if (!root.TryGetProperty("entry_id", out var id) || !id.TryGetGuid(out var entryId) || !ids.Contains(entryId)) continue;
            if (root.TryGetProperty("reason_code", out var code) && code.GetString() is { } c) codes[entryId] = c;
        }
        return codes;
    }
}

public static class LedgerRowMapper
{
    /// <summary>Which of these users are this club's administrators — tenant-filtered.</summary>
    public static async Task<HashSet<Guid>> AdminsAsync(MainframeDbContext db, List<Guid> ids, CancellationToken ct)
    {
        return (await db.Users.AsNoTracking().Where(u => ids.Contains(u.Id) && u.IsAdmin).Select(u => u.Id).ToListAsync(ct)).ToHashSet();
    }

    public const string Treasury = "Club treasury";
    public const string PaymentGateway = "PayFast";

    /// <summary>The name a share's other member is given when the club holds none for them. Never an email: members see names only.</summary>
    public const string SomeMember = "A member";

    /// <summary>
    /// For each <see cref="LedgerEntryType.ShareTransfer"/> row among <paramref name="entries"/>,
    /// the OTHER member of its pair (review round 2, C5) — the owner of the twin row, found by
    /// reference (<c>share:{seat}:{seq}:out</c> ↔ <c>…:in</c>, unique). Names from this club's
    /// memberships only, never an address: the wallet is a member-facing read.
    /// </summary>
    public static async Task<Dictionary<Guid, ShareCounterparty>> ShareCounterpartiesAsync(
        MainframeDbContext db, IReadOnlyCollection<LedgerEntry> entries, CancellationToken ct)
    {
        var twins = entries
            .Where(e => e.Type == LedgerEntryType.ShareTransfer && e.ExternalReference is not null && TwinOf(e.ExternalReference) is not null)
            .ToDictionary(e => e.Id, e => TwinOf(e.ExternalReference!)!);
        if (twins.Count == 0) return [];

        var refs = twins.Values.Distinct().ToList();
        var owners = (await db.LedgerEntries.AsNoTracking()
                .Where(l => l.ExternalReference != null && refs.Contains(l.ExternalReference))
                .Select(l => new { Reference = l.ExternalReference!, l.UserId })
                .ToListAsync(ct))
            .GroupBy(o => o.Reference)
            .ToDictionary(g => g.Key, g => g.First().UserId);
        var people = owners.Values.Distinct().ToList();
        var names = await db.Memberships.AsNoTracking().Where(m => people.Contains(m.UserId))
            .Select(m => new { m.UserId, m.FullName }).ToListAsync(ct);
        var nameOf = names.GroupBy(n => n.UserId).ToDictionary(g => g.Key, g => g.First().FullName);

        var result = new Dictionary<Guid, ShareCounterparty>();
        foreach (var (entryId, twin) in twins)
        {
            if (!owners.TryGetValue(twin, out var other)) continue;
            result[entryId] = new ShareCounterparty(other, nameOf.GetValueOrDefault(other) ?? SomeMember);
        }
        return result;
    }

    /// <summary>The reference of a share row's other half, or null for a reference that is not one.</summary>
    public static string? TwinOf(string reference)
    {
        if (!reference.StartsWith("share:", StringComparison.Ordinal)) return null;
        if (reference.EndsWith(":out", StringComparison.Ordinal)) return reference[..^4] + ":in";
        if (reference.EndsWith(":in", StringComparison.Ordinal)) return reference[..^3] + ":out";
        return null;
    }

    /// <summary>The name a MEMBER reads for an admin who moved their money (R14 review L3): the club, never the person.</summary>
    public const string TheClub = "The club";

    /// <param name="memberView">
    /// The row is for the member's own wallet (R14 review L3): an administrator acting on it is "The
    /// club", on <c>actor_name</c> and <c>actorName</c> alike. Admin surfaces keep the admin's name.
    /// </param>
    public static LedgerRowDto Build(
        LedgerEntry e, Func<Guid, string> nameFor, Func<Guid, bool>? isAdmin = null,
        IReadOnlyDictionary<Guid, ShareCounterparty>? counterparties = null, bool memberView = false)
    {
        var subject = nameFor(e.UserId);
        var actor = ActorNameOf(e, nameFor, isAdmin, memberView);
        var other = counterparties is not null && counterparties.TryGetValue(e.Id, out var found) ? found : null;

        // Direction: positive amount = funds flow INTO the subject's wallet; negative = OUT.
        // The other party depends on the entry type.
        var (counterparty, comment) = e.Type switch
        {
            LedgerEntryType.TopUp =>
                (PaymentGateway, e.Reason ?? "Package purchase"),
            LedgerEntryType.BookingCharge =>
                (Treasury, e.Reason ?? "Booking charge"),
            LedgerEntryType.CancellationRefund =>
                (Treasury, e.Reason ?? "Cancellation refund"),
            LedgerEntryType.NoShowPenalty =>
                (Treasury, e.Reason ?? "No-show penalty"),
            LedgerEntryType.LateCancellationPenalty =>
                (Treasury, e.Reason ?? "Late-cancellation penalty"),
            // The club, never the admin, however the money moved.
            //
            // This named the acting admin as the counterparty, so a negative adjustment
            // rendered on a member's own statement as "Naledi Khoza → Crusaders Admin
            // −10.00 cr" — reading as money handed to a person, next to booking charges
            // that correctly say "Club treasury". Who did it is not lost: it is
            // ActorName on this same row, which is where a statement should carry it.
            LedgerEntryType.AdminAdjustment =>
                (Treasury, e.Reason ?? "Admin adjustment"),
            LedgerEntryType.PaymentReversal =>
                (PaymentGateway, e.Reason ?? "Payment reversal"),
            // C5: a share moves between two members — "Sam → Alice", never via the treasury.
            LedgerEntryType.ShareTransfer when other is not null =>
                (other.Name, e.Reason ?? "Share transfer"),
            _ => (Treasury, e.Reason ?? e.Type.ToString()),
        };

        var (fromLabel, toLabel) = e.AmountMinutes >= 0
            ? (counterparty, subject)   // money flowed INTO subject
            : (subject, counterparty);  // money flowed OUT of subject

        return new LedgerRowDto(
            Id: e.Id,
            At: e.CreatedAt,
            From: fromLabel,
            To: toLabel,
            AmountMinutes: Math.Abs(e.AmountMinutes),
            SignedAmountMinutes: e.AmountMinutes,
            Type: e.Type.ToString(),
            Comment: comment,
            SubjectUserId: e.UserId,
            SubjectName: subject,
            ActorUserId: e.ActorUserId,
            ActorName: actor,
            RelatedBookingId: e.RelatedBookingId)
        {
            DoneBy = DoneByOf(e, actor, isAdmin),
            CounterpartyName = other?.Name,
            CounterpartyUserId = other?.UserId,
        };
    }

    /// <summary>
    /// Who moved this money when it was somebody OTHER than the wallet's owner (review round 1,
    /// B9): the admin behind a desk adjustment or package sale, or who booked or cancelled on the
    /// member's behalf. Null for the member's own movements and the system's (no actor), and for
    /// a share moving between two members — the other member is already the row's From or To —
    /// unless an administrator moved it.
    /// </summary>
    /// <summary>The actor's name — "The club" for an administrator, on the member's own wallet (R14 review L3).</summary>
    private static string ActorNameOf(LedgerEntry e, Func<Guid, string> nameFor, Func<Guid, bool>? isAdmin, bool memberView)
    {
        return memberView && IsClubHand(e, isAdmin) ? TheClub : nameFor(e.ActorUserId);
    }

    /// <summary>An administrator moved somebody else's money — the club's hand, to the member whose money it was.</summary>
    private static bool IsClubHand(LedgerEntry e, Func<Guid, bool>? isAdmin)
    {
        return e.ActorUserId != Guid.Empty && e.ActorUserId != e.UserId && isAdmin?.Invoke(e.ActorUserId) == true;
    }

    private static string? DoneByOf(LedgerEntry e, string actor, Func<Guid, bool>? isAdmin)
    {
        if (e.ActorUserId == Guid.Empty || e.ActorUserId == e.UserId) return null;
        if (e.Type == LedgerEntryType.ShareTransfer && isAdmin?.Invoke(e.ActorUserId) != true) return null;
        return actor;
    }
}

public sealed record LedgerRowDto(
    Guid Id,
    DateTimeOffset At,
    string From,
    string To,
    int AmountMinutes,

    /// <summary>
    /// The same amount, keeping its sign, so a reader can tell money in from money out
    /// without re-deriving it from the type.
    ///
    /// <para>
    /// This was <c>SignedAmountZar</c> while holding the ledger unit — the unit lie
    /// <c>CLAUDE.md</c> says must never be added a second time. It was also simply broken:
    /// the frontend has always read <c>signedAmountMinutes</c>, so the field arrived
    /// undefined, every row in the admin ledger and the member wallet rendered with a minus
    /// sign, and the in/out totals on the admin ledger page were both zero.
    /// </para>
    /// </summary>
    int SignedAmountMinutes,
    string Type,
    string Comment,
    Guid SubjectUserId,
    string SubjectName,
    Guid ActorUserId,
    string ActorName,
    Guid? RelatedBookingId)
{
    /// <summary>
    /// The person who moved this money on the owner's behalf, or null (B9). Named on the wire as
    /// the round-1 contract names it; the record's older fields are camelCase.
    /// </summary>
    [System.Text.Json.Serialization.JsonPropertyName("actor_name")]
    public string? DoneBy { get; init; }

    /// <summary>The rand taken on this row, 2 dp (a desk sale, a PayFast package); null where no rand applies (R9 J9-3).</summary>
    [System.Text.Json.Serialization.JsonPropertyName("zar_paid")]
    public decimal? ZarPaid { get; init; }

    /// <summary>
    /// The desk's code on a by-hand row — <c>top_up_cash</c>, <c>package_free</c>, <c>goodwill</c>, …
    /// (R9 J9-3); null on every other row, and on the member's own wallet.
    /// </summary>
    [System.Text.Json.Serialization.JsonPropertyName("reason_code")]
    public string? ReasonCode { get; init; }

    /// <summary>On a share transfer: the other member of the pair (C5). Null on every other row.</summary>
    [System.Text.Json.Serialization.JsonPropertyName("counterparty_name")]
    public string? CounterpartyName { get; init; }

    /// <summary>On a share transfer: the other member's user id (C5). Null on every other row.</summary>
    [System.Text.Json.Serialization.JsonPropertyName("counterparty_user_id")]
    public Guid? CounterpartyUserId { get; init; }
}

/// <summary>The other member of a share transfer, as a ledger row names them.</summary>
public sealed record ShareCounterparty(Guid UserId, string Name);
