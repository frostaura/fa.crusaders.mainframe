using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Items 5 and 13 — an admin ticking a list of grid cells and cancelling or booking all of them.
///
/// <para>
/// <b>Each item is its own unit of work. The batch always answers 200 with a per-item result
/// array. There is no transactional batch.</b> Three reasons, in order of weight. Each booking
/// is its own money movement behind its own <c>PayerLock</c>, so wrapping forty bookings for
/// forty members in one transaction serialises them behind one another and makes one member's
/// lock contention roll back thirty-nine unrelated refunds. A collision is normal traffic — in a
/// twenty-slot league book-out, one slot already taken is the expected case, and an
/// all-or-nothing batch would fail the whole thing and give the admin no way to see which one.
/// And it matches what the admin is doing: they ticked a list of checkboxes, and the honest
/// answer to a list of checkboxes is a list of outcomes, not one word.
/// </para>
///
/// <para>
/// <b>Partial failure is data, not a status code.</b> <c>207 Multi-Status</c> is rejected: it is
/// a WebDAV code, the frontend's error handling keys on 2xx/4xx, and a partially-successful
/// batch is not an error — it is a result the admin has to read either way. Which is also why
/// the console must never render a bulk action as a spinner ending in a toast: a toast cannot
/// say "11 cancelled, 1 was already gone" and stay readable, and this audience will not go
/// looking.
/// </para>
///
/// <para>
/// <b>No new settlement code.</b> Every cancellation goes through
/// <see cref="BookingService.CancelAsync"/> and every booking through
/// <see cref="BookingService.CreateAsync"/>, exactly as the single-item routes do. The penalty
/// arithmetic, the waiver derivation, the email, the audit row and the domain event all stay
/// where they are. This service is a loop with a result collector.
/// </para>
/// </summary>
public sealed class AdminBulkBookingService
{
    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;
    private readonly BookingService _bookings;
    private readonly AdminBlockService _blocks;
    private readonly LedgerService _ledger;
    private readonly AdminChangeRecorder _changes;

    public AdminBulkBookingService(
        MainframeDbContext db, ITenantContext tenant, BookingService bookings,
        AdminBlockService blocks, LedgerService ledger, AdminChangeRecorder changes)
    { _db = db; _tenant = tenant; _bookings = bookings; _blocks = blocks; _ledger = ledger; _changes = changes; }

    /// <summary>
    /// The reference one item's refund and penalty are posted under.
    ///
    /// <para>
    /// <b>The tenant prefix is not optional.</b> The unique index on
    /// <c>ledger_entries.ExternalReference</c> carries no <c>TenantId</c>, which is why the
    /// minutes-adjust endpoint prefixes its own keys by hand. Two clubs whose consoles mint the
    /// same key would otherwise collide, and the loser's cancellation would fail to post a
    /// refund for money that had been taken.
    /// </para>
    /// </summary>
    public string CancelReference(string key, Guid bookingId)
        => $"bulkcancel:{_tenant.TenantId:N}:{key}:{bookingId:N}";

    /// <summary>
    /// The reference one booked item is posted under.
    ///
    /// <para>
    /// <b>Keyed on the item's INDEX rather than a hash of its contents.</b> An admin may
    /// legitimately name the same court and time twice in one batch only by mistake, and the
    /// second one should lose the slot race and say so — not be silently deduplicated into
    /// looking like it worked.
    /// </para>
    ///
    /// <para>
    /// <b>And on the PAYER.</b> It was <c>bulkbook:{tenant}:{key}:{index}</c>, and the console
    /// mints one key per sheet: a batch for member A that failed on the network, re-sent with
    /// the payer changed to B, found A's debit under the same reference and answered
    /// <c>duplicate</c> — "succeeded: 1", with A's booking id and A's 09:00 slot reported as B's
    /// result — while B had no booking and no charge. The payer is now part of the reference,
    /// as it is on the member route, and the replay is checked rather than trusted
    /// (<see cref="BulkReplay.RefusalFor"/>). The key is hashed, as the member route's is, so a
    /// 200-character key beside three guids still fits the 255-character column untruncated.
    /// </para>
    /// </summary>
    public string BookReference(string key, Guid payerUserId, int index)
    {
        var digest = Convert.ToHexString(
            System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(key)))[..32].ToLowerInvariant();
        return $"bulkbook:{_tenant.TenantId:N}:{payerUserId:N}:{digest}:{index}";
    }

    // ------------------------------------------------------------------ cancel

    /// <summary>
    /// Cancels or lifts each row in turn, never stopping, and reports every outcome.
    /// </summary>
    public async Task<BulkCancelOutcome> CancelAsync(
        IReadOnlyList<BulkCancelItem> items, string idempotencyKey, string reason,
        bool waivePenaltyDefault, Guid actorId, CancellationToken ct)
    {
        var context = await ContextForAsync(items.Select(i => i.BookingId).ToList(), ct);
        var results = new List<BulkCancelResult>(items.Count);
        var refunded = 0;
        var penalty = 0;

        foreach (var item in items)
        {
            var result = await CancelOneAsync(
                item, new BulkCancelBatch(idempotencyKey, reason, waivePenaltyDefault, actorId), context, ct);
            refunded += result.RefundMinutes;
            penalty += result.PenaltyMinutes;
            results.Add(result);
        }

        return new BulkCancelOutcome(results, refunded, penalty);
    }

    /// <summary>
    /// One row. Block body for the lizard reason in <c>memory/gotchas.md</c> — the four outcomes
    /// are four sentences and collapsing them would lose the distinction the vocabulary exists
    /// for.
    /// </summary>
    private async Task<BulkCancelResult> CancelOneAsync(
        BulkCancelItem item, BulkCancelBatch batch, BulkContext context, CancellationToken ct)
    {
        var (idempotencyKey, reason, waivePenaltyDefault, actorId) =
            (batch.IdempotencyKey, batch.Reason, batch.WaivePenaltyDefault, batch.ActorId);

        // Re-resolved through the tenant-filtered DbSet and never trusted from the client.
        //
        // This matters more here than anywhere: GET /api/v1/schedule hands every member every
        // other member's booking id, and this is the first endpoint to accept a LIST of them.
        // A foreign id answers `booking_not_found` — the same non-committal refusal
        // CancelAsync gives, so a stranger learns nothing, not even that the id is real.
        var booking = await _db.Bookings.FirstOrDefaultAsync(b => b.Id == item.BookingId, ct);
        if (booking is null)
        {
            return BulkCancelResult.Failure(item.BookingId, "booking_not_found");
        }

        var label = context.Describe(booking);

        if (booking.Status == BookingStatus.AdminBlock)
        {
            var lifted = await _blocks.RemoveAsync(booking.Id, actorId, reason, ct);
            return lifted
                ? label with { Status = BulkCancelStatuses.BlockLifted }
                : label with { Status = BulkCancelStatuses.AlreadyCancelled };
        }

        if (booking.Status == BookingStatus.Cancelled)
        {
            return label with { Status = BulkCancelStatuses.AlreadyCancelled };
        }

        // A no-show or a game already played is settled and still holds its court. Reporting it
        // "already cancelled" told the console the court was free, and the console counted it a
        // success; it is a failure the admin has to read, and the rest of the batch carries on.
        if (booking.Status != BookingStatus.Booked)
        {
            return label with { Status = BulkCancelStatuses.Failed, Error = Endpoints.BookingEndpoints.NotCancellable };
        }

        // Review round 5 (A5-2): each booking the batch cancels is on the record about its member,
        // exactly as a desk cancel is — staged before the cancellation so it flushes in that save,
        // withdrawn when nothing was cancelled. The batch row is the summary, not the only record.
        var record = await AdminCancelRecord.StageAsync(
            _db, _changes, new AdminCancelFacts(booking.Id, actorId, reason, PartOfBatch: true), ct);

        var waive = item.WaivePenalty ?? waivePenaltyDefault;
        var outcome = await _bookings.CancelAsync(
            booking.Id, actorId, actorIsAdmin: true, waivePenalty: waive, ct,
            waiveReason: reason,
            externalReferencePrefix: CancelReference(idempotencyKey, booking.Id));
        if (outcome is not CancellationResult.Ok) AdminCancelRecord.Withdraw(_db, record);

        return outcome switch
        {
            CancellationResult.Ok ok => label with
            {
                Status = BulkCancelStatuses.Cancelled,
                RefundMinutes = ok.RefundedMinutes,
                PenaltyMinutes = ok.PenaltyMinutes,
            },

            // The row was Booked when we read it and is not now — somebody else decided it
            // between the two statements. That is a success from the admin's point of view:
            // the court they wanted freed is free.
            CancellationResult.NotFound or CancellationResult.NotOpen => label with { Status = BulkCancelStatuses.AlreadyCancelled },

            // R17 E17-6: decided again after a lost race and found settled (played, a no-show) — not cancelled.
            CancellationResult.NotCancellable => label with { Status = BulkCancelStatuses.Failed, Error = Endpoints.BookingEndpoints.NotCancellable },

            _ => label with { Status = BulkCancelStatuses.Failed, Error = "already_started" },
        };
    }

    // ------------------------------------------------------------------ book

    /// <summary>
    /// Books each item in turn. Every error is per-item and the loop continues —
    /// <b>except</b> <c>insufficient_balance</c>, which halts.
    ///
    /// <para>
    /// A payer who has run out of minutes mid-batch is different from a slot that was taken:
    /// continuing would produce a jagged half-booked league night and a member who cannot cover
    /// it. The response then carries <c>halted_at</c> and <c>halted_reason</c> alongside the
    /// results so far, and the admin retries with <c>allow_negative_balance</c> <b>under the
    /// same idempotency key</b> — the items that landed answer <c>duplicate</c> and only the
    /// rest are attempted. That retry-safety is the entire reason the key is mandatory.
    /// </para>
    /// </summary>
    public async Task<BulkBookOutcome> BookAsync(
        IReadOnlyList<BulkBookItem> items, BulkBookRequestContext request, Guid actorId, CancellationToken ct)
    {
        var courts = await _db.Courts.AsNoTracking()
            .ToDictionaryAsync(c => c.Id, c => c.Name, ct);

        var results = new List<BulkBookResult>(items.Count);
        var charged = 0;
        int? haltedAt = null;
        string? haltedReason = null;

        for (var index = 0; index < items.Count; index++)
        {
            var item = items[index];
            var courtName = courts.TryGetValue(item.CourtId, out var name) ? name : null;

            var result = await BookOneAsync(item, index, courtName, request, actorId, ct);
            results.Add(result);
            charged += result.AmountMinutes;

            if (result.Error == BookingRefusals.InsufficientBalance)
            {
                haltedAt = index;
                haltedReason = BookingRefusals.InsufficientBalance;
                break;
            }
        }

        return new BulkBookOutcome(results, charged, haltedAt, haltedReason);
    }

    private async Task<BulkBookResult> BookOneAsync(
        BulkBookItem item, int index, string? courtName, BulkBookRequestContext request,
        Guid actorId, CancellationToken ct)
    {
        // A free-text guest has no wallet, no email and no cancellation rights — which is
        // exactly what an admin block already is. Putting the guest's name in BlockLabel is not
        // schema abuse: BlockLabel IS the label a block carries, and the grid already renders
        // one. The row charges nobody, and the response says so.
        if (request.PayerUserId is null)
        {
            return await BlockForGuestAsync(item, index, courtName, request, actorId, ct);
        }

        var payerId = request.PayerUserId.Value;
        var reference = BookReference(request.IdempotencyKey, payerId, index);
        if (await BulkReplay.FindAsync(_db, reference, payerId, item, ct) is { } already)
        {
            return Replayed(index, item, courtName, already, payerId);
        }

        // ActorIsAdmin is carried on the context from the route group's role claim, never
        // re-derived from actorId != userId — that inference is D2-B13, and every row this
        // method books satisfies it, so losing it silently would refuse a whole league night
        // with member-class reason codes.
        // PartOfBatch: the per-booking booked_on_behalf row is still written, in the booking's
        // own unit of work, and marks itself as one item of a batch. The batch's one
        // bookings.bulk_booked row is the summary, written after the loop — so it cannot be the
        // only record: a request that dies mid-batch has already charged every item before it.
        var payer = new BookingPayer(
            payerId, actorId, request.AllowNegativeBalance, request.ActorIsAdmin,
            PartOfBatch: true);
        var outcome = await _bookings.CreateAsync(
            item.CourtId, payer, item.StartsAt, item.SliceCount, ct, externalReference: reference);

        if (outcome is BookingResult.Ok ok)
        {
            // A guest name BESIDE a real member is a different thing from a guest booking: that
            // row is a member's paid booking and must not become a block. It goes on
            // Booking.AdminNote, which admins see and members do not.
            if (request.AdminNote is not null)
            {
                ok.Booking.AdminNote = request.AdminNote;
                await _db.SaveChangesAsync(ct);
            }

            return BulkBookResult.Booked(index, ok.Booking, courtName, ok.Booking.AmountChargedMinutes);
        }

        // A free court posts no debit (I10), so a retried item finds nothing under its
        // reference and loses the slot race to the booking it made itself. That booking is the
        // answer, exactly as a found reference would have been.
        if (outcome is BookingResult.DuplicateRequest or BookingResult.SlotTaken
            && await BulkReplay.FindAsync(_db, reference, payerId, item, ct) is { } twin)
        {
            return Replayed(index, item, courtName, twin, payerId);
        }

        return BulkBookResult.Failure(index, BookingRefusals.CodeOf(outcome), courtName, item.StartsAt);
    }

    /// <summary>
    /// An item an earlier attempt under this key booked: <c>duplicate</c> when it is this item's
    /// own live booking, and refused — <c>idempotency_key_reused</c> or
    /// <c>already_cancelled</c> — when it is not (<see cref="BulkReplay.RefusalFor"/>).
    /// </summary>
    private static BulkBookResult Replayed(
        int index, BulkBookItem item, string? courtName, Booking earlier, Guid payerId)
    {
        return BulkReplay.RefusalFor(earlier, payerId, item) is { } refusal
            ? BulkBookResult.Failure(index, refusal, courtName, item.StartsAt)
            : BulkBookResult.Replay(index, earlier, courtName);
    }

    private async Task<BulkBookResult> BlockForGuestAsync(
        BulkBookItem item, int index, string? courtName, BulkBookRequestContext request,
        Guid actorId, CancellationToken ct)
    {
        var settings = await _db.TenantSettings.AsNoTracking()
            .FirstOrDefaultAsync(s => s.TenantId == _tenant.TenantId, ct);
        _ = settings;

        // A block posts no ledger row, so there is no ExternalReference to make the retry
        // idempotent and the index cannot help. The honest substitute is to look for the row
        // this item would have produced: same court, same start, same label, not cancelled.
        // Without it, a retried batch answers `slot_taken` about a block it created itself —
        // technically safe and completely misleading.
        var existing = await _db.Bookings.AsNoTracking().FirstOrDefaultAsync(
            b => b.CourtId == item.CourtId
                 && b.StartsAt == item.StartsAt
                 && b.Status == BookingStatus.AdminBlock
                 && b.BlockLabel == request.GuestName, ct);
        if (existing is not null)
        {
            return BulkBookResult.Replay(index, existing, courtName);
        }

        var outcome = await _blocks.CreateAsync(
            item.CourtId, item.StartsAt, item.SliceCount, request.GuestName, actorId, ct);

        return outcome is BookingResult.Ok ok
            ? BulkBookResult.Blocked(index, ok.Booking, courtName)
            : BulkBookResult.Failure(index, BookingRefusals.CodeOf(outcome), courtName, item.StartsAt);
    }

    /// <summary>
    /// What a batch WOULD cost its payer, item by item, without booking anything (decision R19).
    ///
    /// <para>
    /// <b>Each item is priced by <see cref="BookingService.QuoteAsync"/></b> — the same path
    /// <see cref="BookingService.CreateAsync(Guid, BookingPayer, DateTimeOffset, int, CancellationToken, string?)"/>
    /// takes — so the total the console shows is the total the batch then charges. Nothing is
    /// duplicated here except the one thing a single quote cannot see: two items of the SAME
    /// batch that overlap on one court. The booking loop would book the first and refuse the
    /// second <c>slot_taken</c>; the quote says so up front rather than totalling both.
    /// </para>
    ///
    /// <para>
    /// <b>No balance halt.</b> The booking loop stops at the first <c>insufficient_balance</c>;
    /// the quote prices every item and reports <c>overdraws</c> instead, which is the whole point
    /// — the admin decides on the override before sending the batch, not after half of it.
    /// </para>
    /// </summary>
    public async Task<BulkQuote> QuoteAsync(
        IReadOnlyList<BulkBookItem> items, BookingPayer payer, CancellationToken ct)
    {
        var lines = new List<BulkQuoteLine>(items.Count);
        var accepted = new List<(Guid CourtId, DateTimeOffset StartsAt, DateTimeOffset EndsAt)>();

        foreach (var item in items)
        {
            var quote = await _bookings.QuoteAsync(item.CourtId, payer, item.StartsAt, item.SliceCount, ct);
            if (quote.PriceMinutes is not { } price)
            {
                lines.Add(new BulkQuoteLine(item, quote.CourtName, 0, false, BookingRefusals.CodeOf(quote.Refusal!)));
                continue;
            }

            var endsAt = quote.EndsAt!.Value;
            var clashes = accepted.Any(a =>
                a.CourtId == item.CourtId && a.StartsAt < endsAt && a.EndsAt > item.StartsAt);
            if (clashes)
            {
                lines.Add(new BulkQuoteLine(item, quote.CourtName, 0, false, BookingRefusals.SlotTaken));
                continue;
            }

            accepted.Add((item.CourtId, item.StartsAt, endsAt));
            lines.Add(new BulkQuoteLine(item, quote.CourtName, price, true, null));
        }

        var total = lines.Where(l => l.Bookable).Sum(l => l.PriceMinutes);
        // The raw balance and the hold beside it: the quote's `overdraws` is on SPENDABLE, for the
        // reason CommitAsync gives — shares a member holds for their partners are not the desk's to
        // book against (D11, ShareHolds) — so it is the POST's refusal exactly.
        var balance = await _ledger.GetBalanceAsync(payer.UserId, ct);
        var held = await _ledger.GetHeldAsync(payer.UserId, ct);
        return new BulkQuote(lines, total, balance, held.Held, held.OwedBack);
    }

    /// <summary>Every name and court title one batch's result rows need, in two reads rather than 2n.</summary>
    private async Task<BulkContext> ContextForAsync(IReadOnlyList<Guid> bookingIds, CancellationToken ct)
    {
        var bookings = await _db.Bookings.AsNoTracking()
            .Where(b => bookingIds.Contains(b.Id))
            .Select(b => new { b.Id, b.UserId, b.CourtId })
            .ToListAsync(ct);

        var names = await PersonNames.ForAsync(_db, bookings.Select(b => b.UserId), ct);
        var courts = await _db.Courts.AsNoTracking().ToDictionaryAsync(c => c.Id, c => c.Name, ct);

        return new BulkContext(names, courts);
    }

    private sealed record BulkContext(
        IReadOnlyDictionary<Guid, string> Names, IReadOnlyDictionary<Guid, string> Courts)
    {
        /// <summary>One row's names: the member's, or for a club hold its label (A5-2).</summary>
        public BulkCancelResult Describe(Booking booking) => new(
            BookingId: booking.Id,
            Status: BulkCancelStatuses.Failed,
            RefundMinutes: 0,
            PenaltyMinutes: 0,
            MemberName: PersonNames.Of(booking.UserId, Names),
            CourtName: Courts.TryGetValue(booking.CourtId, out var name) ? name : null,
            StartsAt: booking.StartsAt,
            Error: null,
            BlockLabel: booking.Status == BookingStatus.AdminBlock ? booking.BlockLabel : null);
    }
}
