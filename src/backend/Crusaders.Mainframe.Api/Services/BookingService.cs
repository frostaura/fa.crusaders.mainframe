using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Booking lifecycle service.
///
/// Phase 8 economics (per client blueprint Rev 2):
/// <list type="bullet">
///   <item><b>Booking is the charge.</b> <see cref="CreateAsync"/> reserves the slot and debits the
///         payer in the same unit of work. Cancelling before anyone has checked in refunds it, less
///         the late-cancellation penalty if applicable. This deviates from blueprint A.9, which
///         debits on lights-on; the deviation is recorded in
///         <c>docs/specs/client-blueprint-deltas.md</c> and needs committee sign-off before go-live.</item>
///   <item><b>Per-day cap.</b> A member can't have more than <c>member_per_day_max_minutes</c> of
///         bookings on a single day (A.4). Same-day relaxation: a slot starting today can still be
///         booked even if the member is over their cap, as long as the slot is otherwise empty (B.3).</item>
///   <item><b>Peak-hours rule.</b> 16:00–19:00 slots are reserved for LeagueOrSenior members until
///         <c>peak_advance_hours_for_regular</c> hours before slot start (A.12). Admins bypass.</item>
///   <item><b>Payer override.</b> <see cref="BookedByUserId"/> defaults to the booking user;
///         <see cref="PaidByUserId"/> can be overridden at the court via a second identification (B.2).</item>
/// </list>
/// </summary>
public sealed class BookingService
{
    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;
    private readonly LedgerService _ledger;
    private readonly TenantSettingsAccessor _settings;
    private readonly IEmailService _email;
    private readonly IEventBus _bus;
    private readonly AccessCodeService _codes;
    private readonly ILogger<BookingService> _logger;

    public BookingService(
        MainframeDbContext db, ITenantContext tenant, LedgerService ledger, TenantSettingsAccessor settings,
        IEmailService email, IEventBus bus, AccessCodeService codes, ILogger<BookingService> logger)
    { _db = db; _tenant = tenant; _ledger = ledger; _settings = settings; _email = email; _bus = bus; _codes = codes; _logger = logger; }

    /// <summary>
    /// A booking nobody is overriding anything for — the member's own, or an admin's
    /// on-behalf booking that the member can afford. Delegates to the overload below.
    /// </summary>
    public Task<BookingResult> CreateAsync(Guid courtId, Guid userId, Guid actorId, DateTimeOffset startsAt, int sliceCount, CancellationToken ct)
        => CreateAsync(courtId, new BookingPayer(userId, actorId), startsAt, sliceCount, ct);

    /// <summary>
    /// <paramref name="payer"/> carries who is charged, who is doing it, and whether the
    /// desk has explicitly authorised an overdraft (<c>feature-spec.md</c> §8). It is a
    /// parameter object rather than a seventh argument because the complexity gate caps
    /// signatures at six — and because the three travel together everywhere they are read.
    /// </summary>
    public async Task<BookingResult> CreateAsync(Guid courtId, BookingPayer payer, DateTimeOffset startsAt, int sliceCount, CancellationToken ct)
    {
        var (userId, actorId) = (payer.UserId, payer.ActorId);
        // Bounds before arithmetic, because the arithmetic is signed.
        //
        // sliceCount arrives straight off the request body and was never checked. A negative
        // count runs the whole method backwards: endsAt lands BEFORE startsAt, the overlap
        // predicate cannot match an inverted range, the per-day cap sees negative minutes
        // and passes, totalCost comes out negative, and the balance guard `balance <
        // totalCost` reads 0 < -200 and passes too. The debit is posted as -(-200), which
        // CREDITS the member 200 for a booking they did not pay for.
        //
        // The only thing standing in the way today is Postgres refusing tstzrange(lower >
        // upper) when it maintains the exclusion-constraint index — SQLSTATE 22000, which is
        // not the 23P01 the overlap catch filters on, so it surfaces as a 500. That is
        // protection by accident, and it is invisible to the test suite: the in-memory
        // provider has neither the constraint nor the numeric column.
        if (sliceCount is < 1 or > MaxSlicesPerBooking)
            return new BookingResult.InvalidDuration(sliceCount, MaxSlicesPerBooking);

        var settings = await _settings.GetAsync(ct);
        var court = await _db.Courts.FirstOrDefaultAsync(c => c.Id == courtId && c.IsActive, ct);
        if (court is null) return new BookingResult.NotFound();

        var endsAt = startsAt.AddMinutes(settings.SliceMinutes * sliceCount);
        if (startsAt < DateTimeOffset.UtcNow) return new BookingResult.PastTime();
        if (startsAt > DateTimeOffset.UtcNow.AddDays(settings.AdvanceBookingDays)) return new BookingResult.TooFarAhead();

        // Overlap check
        var overlap = await _db.Bookings.AnyAsync(b =>
            b.CourtId == courtId &&
            b.Status != BookingStatus.Cancelled &&
            b.StartsAt < endsAt && b.EndsAt > startsAt, ct);
        if (overlap) return new BookingResult.SlotTaken();

        // Class / peak-hours / per-day-cap rules — admins bypass everything.
        var isAdminActor = actorId != userId;
        if (!isAdminActor)
        {
            // §5 "Operating hours per day per tenant: configurable". Enforced here and not
            // only drawn on the grid, because the grid is not the only way in: a member
            // could POST 03:00 on a Sunday, be charged for it, and then find the slot on
            // no screen in the product — bought, unrefundable and invisible.
            var hoursResult = CheckOperatingHoursRule(startsAt, endsAt, settings);
            if (hoursResult is not null) return hoursResult;

            var membership = await _db.Memberships.AsNoTracking().FirstOrDefaultAsync(m => m.UserId == userId, ct);
            var memberClass = membership?.MemberClass ?? MemberClass.Regular;

            // A.12 — peak hours league/senior exclusivity.
            var peakResult = CheckPeakHoursRule(startsAt, endsAt, memberClass, settings);
            if (peakResult is not null) return peakResult;

            // A.4 / B.3 — per-day cap with same-day relaxation.
            var capResult = await CheckPerDayCapAsync(userId, startsAt, endsAt, settings, ct);
            if (capResult is not null) return capResult;
        }

        var pricePerSlice = court.SlicePriceCredits;      // Now in credits per blueprint A.8/A.9.
        var totalCost = pricePerSlice * sliceCount;

        // §8's third admin action: "Book on behalf of any member (charges that member's
        // credit; if insufficient, admin can override and create a negative balance,
        // logged)."
        //
        // The override is DELIBERATE and NARROW, and both halves matter.
        //
        // Deliberate: it is never implied by being an admin. The desk gets the ordinary
        // 402 first, with the member's balance and the price in it, and has to come back
        // asking for the overdraft by name. An admin who mis-picks a member from a
        // dropdown must not silently put a stranger 50 credits in the red.
        //
        // Narrow: `isAdminActor` is `actorId != userId`, so it is true only when somebody
        // is acting FOR somebody else — and the flag only reaches here from the
        // admin-only route group. An admin cannot overdraw their own wallet with it, and
        // a member's own POST carries no such field to set. The rule lives here, next to
        // the check it lifts, rather than in the endpoint that happens to pass it.
        //
        // Nothing else about the booking changes: the debit is the same BookingCharge for
        // the same price, so `Owed(b) = P` and settlement-model.md I1 is untouched. What
        // moves is the WALLET, which is a sum over the ledger and has never been
        // constrained to be non-negative — DeviceEventHttpTests already covers a member
        // going negative when a release correction lands on spent credit.
        var overdraftAuthorised = payer.AllowNegativeBalance && isAdminActor;

        var balance = await _ledger.GetBalanceAsync(userId, ct);
        if (!overdraftAuthorised && balance < totalCost) return new BookingResult.InsufficientBalance(balance, totalCost);

        var booking = new Booking
        {
            TenantId = _tenant.TenantId,
            CourtId = courtId,
            UserId = userId,
            BookedByUserId = userId,
            PaidByUserId = userId,             // Default — overridable at court via the "I'll pay" flow.
            ActorUserId = actorId,
            StartsAt = startsAt,
            EndsAt = endsAt,
            SliceMinutes = settings.SliceMinutes,
            SliceCount = sliceCount,
            AmountChargedCredits = totalCost,
            Status = BookingStatus.Booked,
            ChargedAt = DateTimeOffset.UtcNow,
        };
        _db.Bookings.Add(booking);

        return await CommitAsync(new NewBooking(
            Row: booking,
            Court: court,
            Settings: settings,
            TotalCost: totalCost,
            DurationLabel: $"{settings.SliceMinutes * sliceCount} min",
            IsWalkUp: false,
            AllowNegativeBalance: overdraftAuthorised), ct);
    }

    /// <summary>
    /// A member buying light time at the court, there and then.
    ///
    /// <para>
    /// A walk-up is an ordinary booking, not a second money path: it lands in the member's
    /// name, shows up online immediately, and is charged and refunded by exactly the same
    /// rules. One data model, one ledger story.
    /// </para>
    ///
    /// <para>
    /// Two things are its own. It is <b>truncated at the next booking</b> — asking for an
    /// hour at 17:40 when someone has 18:00 gets twenty minutes, not a collision — and it is
    /// therefore <b>charged pro rata</b>, which is the first fractional price in the system.
    /// <c>SliceCount</c> is an integer and the tariff is a flat multiple of it, so the
    /// arithmetic could not have been expressed before: the row carries one slice of the
    /// length actually sold, which keeps <c>SliceMinutes × SliceCount</c> equal to
    /// <c>EndsAt − StartsAt</c> the way every other booking does.
    /// </para>
    ///
    /// <para>
    /// It is not checked in here. The caller runs it through
    /// <c>CourtActivationService.ActivateAsync</c> like any other identification, so
    /// attendance, the audit row and <c>booking.lights_on</c> all come from the one place
    /// that is allowed to produce them.
    /// </para>
    ///
    /// <para>
    /// <paramref name="externalReference"/> is the purchase's identity across retries —
    /// <c>walkup:{device}:{nonce}</c> — and it lands on the ledger row, where the filtered
    /// unique index makes a second attempt with the same reference fail to post rather
    /// than debit twice (review H3). The caller looks the reference up <i>before</i>
    /// calling this and answers a replay with the original grant; this is the backstop
    /// for two attempts in flight at once, which no read-first check can catch.
    /// </para>
    /// </summary>
    public async Task<BookingResult> CreateWalkUpAsync(
        Guid courtId, Guid userId, Guid actorId, int requestedMinutes, string externalReference, CancellationToken ct)
    {
        var settings = await _settings.GetAsync(ct);
        var court = await _db.Courts.FirstOrDefaultAsync(c => c.Id == courtId && c.IsActive, ct);
        if (court is null) return new BookingResult.NotFound();
        if (requestedMinutes <= 0) return new BookingResult.NoTimeAvailable(requestedMinutes, 0);

        var now = DateTimeOffset.UtcNow;

        var (refusal, endsAt) = await SellableEndAsync(courtId, now, requestedMinutes, settings, ct);
        if (refusal is not null) return refusal;

        // Whole minutes: the member is buying light time off a wall clock, and a price
        // derived from a fractional minute is a price nobody can check.
        var grantedMinutes = (int)Math.Floor((endsAt - now).TotalMinutes);
        if (grantedMinutes <= 0) return new BookingResult.NoTimeAvailable(requestedMinutes, 0);

        endsAt = now.AddMinutes(grantedMinutes);

        // Pro rata, rounded to the ledger's own scale. Away-from-zero matches the penalty
        // arithmetic in CancelAsync; the club does not round in its own favour by accident
        // in one place and against itself in another.
        var totalCost = Math.Round(
            court.SlicePriceCredits * grantedMinutes / settings.SliceMinutes, 2, MidpointRounding.AwayFromZero);

        var balance = await _ledger.GetBalanceAsync(userId, ct);
        if (balance < totalCost) return new BookingResult.InsufficientBalance(balance, totalCost);

        var booking = new Booking
        {
            TenantId = _tenant.TenantId,
            CourtId = courtId,
            UserId = userId,
            BookedByUserId = userId,
            PaidByUserId = userId,
            ActorUserId = actorId,
            StartsAt = now,
            EndsAt = endsAt,
            SliceMinutes = grantedMinutes,
            SliceCount = 1,
            AmountChargedCredits = totalCost,
            Status = BookingStatus.Booked,
            ChargedAt = now,
        };
        _db.Bookings.Add(booking);

        return await CommitAsync(new NewBooking(
            Row: booking,
            Court: court,
            Settings: settings,
            TotalCost: totalCost,
            DurationLabel: $"{grantedMinutes} min",
            IsWalkUp: true,
            ExternalReference: externalReference), ct);
    }

    /// <summary>
    /// How far a walk-up can actually run, or the refusal that says why none of it can.
    ///
    /// <para>
    /// Three things bound it and all three are truncations rather than refusals wherever
    /// there is still time worth selling: somebody already on the court (no time at all —
    /// which is a different answer from selling zero minutes), whoever is next through the
    /// door, and closing time. A box standing in a locked club must not sell the night, and
    /// an hour bought at 19:50 on a Saturday ends at 20:00 rather than at 20:50.
    /// </para>
    /// </summary>
    private async Task<(BookingResult? Refusal, DateTimeOffset EndsAt)> SellableEndAsync(
        Guid courtId, DateTimeOffset now, int requestedMinutes, TenantSettingsView settings, CancellationToken ct)
    {
        var window = OpenWindowUtc(now, settings);
        if (now < window.OpensAtUtc || now >= window.ClosesAtUtc)
        {
            return (new BookingResult.OutOfHours(window.OpensAtLocal, window.ClosesAtLocal), now);
        }

        var inProgress = await _db.Bookings.AnyAsync(b =>
            b.CourtId == courtId &&
            b.Status != BookingStatus.Cancelled &&
            b.StartsAt <= now && b.EndsAt > now, ct);
        if (inProgress) return (new BookingResult.SlotTaken(), now);

        var requestedEnd = now.AddMinutes(requestedMinutes);
        var nextStart = await _db.Bookings
            .Where(b => b.CourtId == courtId
                && b.Status != BookingStatus.Cancelled
                && b.StartsAt > now && b.StartsAt < requestedEnd)
            .OrderBy(b => b.StartsAt)
            .Select(b => (DateTimeOffset?)b.StartsAt)
            .FirstOrDefaultAsync(ct);

        var endsAt = nextStart ?? requestedEnd;
        return (null, endsAt < window.ClosesAtUtc ? endsAt : window.ClosesAtUtc);
    }

    /// <summary>
    /// Everything a new booking does once its price is settled: take the money, write the
    /// audit row, tell the member, announce it.
    ///
    /// <para>
    /// Shared by the online and walk-up paths on purpose. Two copies of this would be two
    /// places for the debit to drift out of step with the row it pays for — and the whole
    /// point of a walk-up being a real booking is that there is one money path, not two.
    /// </para>
    /// </summary>
    /// <summary>
    /// <c>AllowNegativeBalance</c> is the desk's explicit §8 overdraft authorisation, already
    /// checked against "the actor is not the payer" by the caller. It travels on the spec
    /// rather than being re-derived here because <see cref="CommitAsync"/> must lift the
    /// same guard the caller lifted, under the lock, or the two disagree at the one moment
    /// that decides whether money moves.
    /// </summary>
    private sealed record NewBooking(
        Booking Row, Court Court, TenantSettingsView Settings,
        decimal TotalCost, string DurationLabel, bool IsWalkUp,
        string? ExternalReference = null,
        bool AllowNegativeBalance = false);

    private async Task<BookingResult> CommitAsync(NewBooking spec, CancellationToken ct)
    {
        var (booking, court, settings) = (spec.Row, spec.Court, spec.Settings);
        var userId = booking.UserId!.Value;
        var actorId = booking.ActorUserId;

        // Balance is checked TWICE, and the second one is the one that counts.
        //
        // The caller's check is a fast refusal on the common case — a member who plainly
        // cannot afford the court should not have a booking row built for them. But it reads
        // an unlocked SUM, so two requests from the same member both saw 200, both found it
        // sufficient, and both debited 200: one member, two courts, a balance of −200.
        // Nothing in the schema refused it, because there is no stored balance to constrain
        // and there must not be one.
        //
        // So the authoritative check happens here, under a lock on the payer, in the same
        // transaction as the debit. See PayerLock for why it locks the payer rather than the
        // court, and why the key is derived rather than hashed.
        await using var payerLock = await PayerLock.BeginAsync(_db, _tenant.TenantId, userId, ct);

        var openingBalance = await _ledger.GetBalanceAsync(userId, ct);

        // Read under the lock, so this is the answer and not a guess: nothing else can move
        // this payer's balance between here and the debit below, which makes
        // `openingBalance − TotalCost` exactly the balance the booking leaves behind. It is
        // negative precisely when the payer could not cover the court, which is what "the
        // desk overdrew this member" means and what the audit row records.
        var overdrawn = openingBalance < spec.TotalCost;
        if (overdrawn && !spec.AllowNegativeBalance)
        {
            // Detached, not left tracked: the row was built optimistically and this request
            // is over. Leaving it attached would have the next SaveChanges on this context
            // insert a booking nobody paid for.
            _db.Entry(booking).State = EntityState.Detached;
            return new BookingResult.InsufficientBalance(openingBalance, spec.TotalCost);
        }

        // The code the member's phone will show at the box, staged on the context now so
        // it flushes in the same SaveChanges as the booking and the debit below. A booking
        // that exists without its code is a member who paid and cannot get in; a code
        // without its booking is a handle to nothing. One flush, both or neither. A
        // walk-up gets none — the member is already standing at the court, identified.
        if (!spec.IsWalkUp)
        {
            await _codes.StageForBookingAsync(booking, TimeSpan.FromMinutes(settings.GraceWindowMinutes), ct);
        }

        // The debit, at booking time.
        //
        // This reverses the previous "booking is a hold" model, per the founder's decision.
        // It also differs from the client blueprint, which says at A.9 that the member's
        // account is debited "on putting lights on" — recorded as a deviation needing
        // committee sign-off in docs/specs/client-blueprint-deltas.md, because the
        // blueprint is the customer's own words.
        //
        // Posted through LedgerService so the balance broadcast and the wallet stream see
        // it like any other movement. LedgerService.PostAsync calls SaveChanges itself, so
        // the booking row the caller tracked is written in the same unit of work as the
        // ledger row. That is also what makes the slot-race catch below safe — one flush,
        // one outcome.
        try
        {
            await _ledger.PostAsync(new LedgerPosting(
                UserId: userId,
                // A walk-up is light time bought at the court, not a reservation, and the
                // enum member exists to tell the two apart in reporting. Nothing had ever
                // posted it: every walk-up landed as a BookingCharge, so a
                // Where(Type == LightsPurchase) report was guaranteed to be empty. Both are
                // in LedgerEntryTypes.Spend, so no bucket total moves.
                Type: spec.IsWalkUp ? LedgerEntryType.LightsPurchase : LedgerEntryType.BookingCharge,
                AmountCredits: -spec.TotalCost,
                ActorUserId: actorId,
                RelatedBookingId: booking.Id,
                Reason: $"Booking {court.Name} {SlotLabel(booking, settings)}",
                ExternalReference: spec.ExternalReference), ct);
        }
        catch (DbUpdateException ex) when (IsDuplicateReference(ex))
        {
            // The same purchase, twice, in flight together — a box that retried before its
            // first attempt had answered. The filtered unique index on ExternalReference
            // refused the second debit, and the booking row went down with it in the same
            // SaveChanges. Told apart from the slot race below because the answer is
            // different: not "court in use" but "you already bought this" — the caller
            // re-reads the reference and returns the original grant, so the box can !ON.
            _logger.LogInformation(
                "Booking with reference {Reference} was already posted by a concurrent request",
                spec.ExternalReference);
            DiscardPendingAdds();
            return new BookingResult.DuplicateRequest();
        }
        catch (DbUpdateException ex) when (IsOverlapViolation(ex))
        {
            DiscardPendingAdds();
            // Lost the race. The overlap check upstream passed because the other request had
            // not committed yet — under READ COMMITTED it could not have seen it. The
            // database is the only place that collision is decidable, and this is the answer
            // it gave.
            //
            // Nothing was taken: the booking row and the ledger row flush in the same
            // SaveChanges, so the constraint aborts both together. That coupling is the
            // reason the debit is posted through the tracked context rather than in a second
            // unit of work — a member who lost the slot must not be left paying for it.
            _logger.LogInformation(
                "Booking lost the slot race on court {CourtId} at {StartsAt}",
                booking.CourtId, booking.StartsAt);
            return new BookingResult.SlotTaken();
        }

        _db.AuditLogs.Add(new AuditLog
        {
            TenantId = _tenant.TenantId,
            ActorUserId = actorId,
            SubjectUserId = userId,
            Action = AuditActionFor(spec, actorId, userId, overdrawn),
            // ActorUserId / SubjectUserId above are already the {admin, member} pair the
            // repo's "admins act on behalf of users" invariant asks for. The two balance
            // figures are what §8's "logged" needs on top of that: the overdraft is only
            // reviewable if the row says how deep it went, and re-deriving it later from
            // the ledger means replaying every row that has landed since.
            DetailsJson = System.Text.Json.JsonSerializer.Serialize(new
            {
                booking_id = booking.Id,
                court = court.Name,
                starts_at = booking.StartsAt,
                slice_count = booking.SliceCount,
                minutes = booking.SliceMinutes * booking.SliceCount,
                amount_credits = spec.TotalCost,
                balance_before_credits = openingBalance,
                balance_after_credits = openingBalance - spec.TotalCost,
                overdrawn,
            }),
        });

        await _db.SaveChangesAsync(ct);

        // Re-read after the charge: the member has just paid, and the confirmation and the
        // booking.created event must show what they have left rather than what they had.
        var balance = await _ledger.GetBalanceAsync(userId, ct);

        // Published here, before the notifications. Everything below is telling people what
        // happened; holding a lock on the member's wallet while an email is composed and an
        // event is queued would serialise their bookings behind work that cannot fail the
        // booking anyway.
        await payerLock.CommitAsync(ct);

        var user = await _db.Users.FirstAsync(u => u.Id == userId, ct);
        var startsAtLocal = TimeZoneInfo
            .ConvertTimeFromUtc(booking.StartsAt.UtcDateTime, ResolveTz(settings.Timezone))
            .ToString("ddd dd MMM HH:mm");
        // Build the message in the request scope; dispatch in the background so SMTP latency
        // (Mailhog/EHLO can take seconds) does not block the booking response.
        // Credits, not rand — the template printed a rand sign over both of these. The penalty
        // policy travels with them for the same reason: it was hardcoded "15 minutes / 30%" and
        // went on saying so after an admin moved the club.
        var details = new Email.BookingConfirmationDetails(
            court.Name, startsAtLocal, spec.DurationLabel,
            spec.TotalCost, balance,
            settings.PenaltyWindowMinutes, settings.PenaltyPct);
        var confirmationMsg = EmailTemplates.BookingConfirmation(
            user.Email, details, await BuildReceiptAsync(booking, details, userId, ct));
        SendEmailInBackground(confirmationMsg, $"booking confirmation for {booking.Id}");

        await _bus.EmitAsync(new DomainEvent(
            Id: $"evt_{Guid.NewGuid():N}",
            Type: "booking.created",
            TenantId: _tenant.TenantId, TenantSlug: _tenant.TenantSlug,
            OccurredAt: DateTimeOffset.UtcNow,
            ActorUserId: actorId, ActorIsAdmin: actorId != userId,
            SubjectUserId: userId,
            Data: new()
            {
                ["booking_id"] = booking.Id,
                ["court_id"] = court.Id,
                ["court_number"] = court.CourtNumber,
                ["court_name"] = court.Name,
                ["user_id"] = userId,
                ["starts_at"] = booking.StartsAt,
                ["ends_at"] = booking.EndsAt,
                ["slice_count"] = booking.SliceCount,
                ["minutes"] = booking.SliceMinutes * booking.SliceCount,
                ["amount_credits"] = spec.TotalCost,
                ["balance_after_credits"] = balance,
                ["walk_up"] = spec.IsWalkUp,
            }), ct);

        return new BookingResult.Ok(booking, balance);
    }

    /// <summary>
    /// Forgets every row staged on this context that the database just refused.
    ///
    /// <para>
    /// A save that fails leaves its rows tracked as <c>Added</c>, and the next
    /// <c>SaveChanges</c> on the same context — the walk-up endpoint activating the
    /// <i>original</i> booking after a duplicate — would try to insert them again and fail
    /// the same way. The refusal was the outcome that was wanted; the tracker must not
    /// keep arguing with it.
    /// </para>
    /// </summary>
    private void DiscardPendingAdds()
    {
        foreach (var entry in _db.ChangeTracker.Entries().Where(e => e.State == EntityState.Added).ToList())
        {
            entry.State = EntityState.Detached;
        }
    }

    /// <summary>
    /// The action name is the OUTCOME, not the request. An admin who ticks the §8 override
    /// for a member who turns out to be able to afford the court has done an ordinary
    /// on-behalf booking and the trail should say so; <c>overdrawn</c> is true only when the
    /// balance the booking leaves behind is actually below zero.
    /// </summary>
    private static string AuditActionFor(NewBooking spec, Guid actorId, Guid userId, bool overdrawn)
    {
        if (spec.IsWalkUp) return "booking.walk_up_created";
        if (actorId == userId) return "booking.created";
        return overdrawn ? "booking.created_on_behalf_overdrawn" : "booking.created_on_behalf";
    }

    /// <summary>
    /// What a cancellation is worth: the refund, and the penalty deducted from it.
    ///
    /// <para>
    /// The debit has ALWAYS happened by now under charge-at-booking, so the old
    /// <c>ChargedAt is not null</c> branch would be the path every cancellation takes — and
    /// it refunded a pro-rata slice of wall-clock time, which for someone who never turned
    /// up is simply the wrong question. The decision that governs this is "no refund once
    /// the lights have been on", and the source of truth for that is attendance:
    /// </para>
    ///
    /// <list type="bullet">
    ///   <item>never checked in, outside the penalty window — full refund</item>
    ///   <item>never checked in, inside the penalty window — refund less the penalty</item>
    ///   <item>checked in (the lights have been on) — no refund at all</item>
    /// </list>
    ///
    /// <para>
    /// <see cref="Booking.CheckedInAt"/> rather than <c>LightsOnCuedAt</c>: the latter is a
    /// cue marker and its own doc comment warns it is not an attendance proxy.
    /// </para>
    ///
    /// <para>
    /// Both movements come back separately and the caller posts them separately, never
    /// netted into one. "Money is ledger-only… disputes are resolved by replaying the
    /// ledger" — and a single net row cannot answer "how much penalty did I pay?", which is
    /// precisely the question a disputed cancellation asks. Two rows cost one line on a
    /// statement and keep the ledger self-explaining; presenting them together is the UI's
    /// job.
    /// </para>
    /// </summary>
    private static (decimal Refund, decimal Penalty) SettleCancellation(
        Booking booking, TenantSettingsView settings, bool insidePenaltyWindow, bool waivePenalty)
    {
        var lightsHaveBeenOn = booking.CheckedInAt is not null;
        if (lightsHaveBeenOn) return (0m, 0m);

        var penalty = insidePenaltyWindow && !waivePenalty
            ? Math.Round(booking.AmountChargedCredits * settings.PenaltyPct / 100m, 2, MidpointRounding.AwayFromZero)
            : 0m;

        return (booking.AmountChargedCredits, penalty);
    }

    /// <summary>
    /// What cancelling this booking, right now, would actually cost — before the member commits.
    ///
    /// <para>
    /// §7 requires the cancellation modal to state the penalty and the refund in figures,
    /// and the product stated neither: the whole confirmation was a button that changed
    /// its label, and the toast afterwards said "refund pending" whether 50.00 had come
    /// back, 35.00 had, or nothing had. A member who had already scanned in at the box
    /// was told "refund pending" while losing the entire price in silence.
    /// </para>
    ///
    /// <para>
    /// Computed on the server, through the same <see cref="SettleCancellation"/> the
    /// cancellation itself uses, and fetched when the modal opens rather than carried on
    /// the schedule payload — the answer turns on the clock (the penalty window) and on
    /// attendance (a scan at the court), both of which move after a schedule is loaded.
    /// A quote baked into the grid would be a promise the product could not keep.
    /// </para>
    ///
    /// <para>
    /// It is a quote, not a reservation: the cancellation re-derives everything. If a
    /// check-in lands between the quote and the tap, the member is charged what the
    /// cancellation decides, and the response says so.
    /// </para>
    /// </summary>
    public async Task<CancellationQuote?> QuoteCancellationAsync(Guid bookingId, Guid actorId, bool actorIsAdmin, CancellationToken ct)
    {
        var booking = await _db.Bookings.AsNoTracking().FirstOrDefaultAsync(b => b.Id == bookingId, ct);
        if (booking is null || booking.Status != BookingStatus.Booked || booking.UserId is null) return null;

        // Same refusal shape as CancelAsync: a stranger learns nothing, not even that the
        // id is real, and certainly not what the booking cost.
        if (!actorIsAdmin && actorId != booking.UserId.Value) return null;

        var settings = await _settings.GetAsync(ct);
        var now = DateTimeOffset.UtcNow;
        var minutesUntilStart = (booking.StartsAt - now).TotalMinutes;
        var insidePenaltyWindow = minutesUntilStart < settings.PenaltyWindowMinutes;
        var (refund, penalty) = SettleCancellation(booking, settings, insidePenaltyWindow, waivePenalty: false);

        return new CancellationQuote(
            BookingId: booking.Id,
            AmountChargedCredits: booking.AmountChargedCredits,
            RefundCredits: refund - penalty,
            PenaltyCredits: penalty,
            PenaltyPct: settings.PenaltyPct,
            PenaltyWindowMinutes: settings.PenaltyWindowMinutes,
            InsidePenaltyWindow: insidePenaltyWindow,
            CheckedIn: booking.CheckedInAt is not null,
            AlreadyStarted: !actorIsAdmin && booking.StartsAt <= now);
    }

    public async Task<CancellationResult> CancelAsync(Guid bookingId, Guid actorId, bool actorIsAdmin, bool waivePenalty, CancellationToken ct)
    {
        var booking = await _db.Bookings.FirstOrDefaultAsync(b => b.Id == bookingId, ct);
        if (booking is null || booking.Status != BookingStatus.Booked) return new CancellationResult.NotFound();
        if (booking.UserId is null) return new CancellationResult.NotFound();

        var isSelfCancel = actorId == booking.UserId.Value;

        // Whether the actor is an admin is the ROUTE's answer, never inferred from whether
        // they happen to own the booking.
        //
        // Inferring it was an in-tenant IDOR of the worst shape: the member cancel route
        // passed the caller's own id as the actor, so "actor is not the owner" — the test
        // used to spot an admin acting on behalf — was equally true of a stranger. Any
        // member could read a victim's booking id straight off GET /api/v1/schedule and
        // cancel it: the AlreadyStarted guard below is skipped for non-owners, so even a
        // booking in progress went, the victim was charged the late-cancellation penalty,
        // and the audit row recorded the attacker as an administrator.
        //
        // NotFound rather than Forbidden, deliberately: a distinct 403 would confirm to a
        // stranger that the booking id is real and, from the penalty in the response, what
        // it cost.
        if (!actorIsAdmin && !isSelfCancel) return new CancellationResult.NotFound();

        if (isSelfCancel && booking.StartsAt <= DateTimeOffset.UtcNow)
            return new CancellationResult.AlreadyStarted();

        var settings = await _settings.GetAsync(ct);
        var minutesUntilStart = (booking.StartsAt - DateTimeOffset.UtcNow).TotalMinutes;
        var insidePenaltyWindow = minutesUntilStart < settings.PenaltyWindowMinutes;

        var payerUserId = booking.PaidByUserId ?? booking.UserId.Value;
        var (refundAmount, penaltyAmount) =
            SettleCancellation(booking, settings, insidePenaltyWindow, waivePenalty);

        // Status first, then the money.
        //
        // LedgerService.PostAsync saves through this same tracked context, so the first post
        // carries the status change with it — and the concurrency token on Booking means a
        // second cancellation of the same row matches nothing and throws rather than posting
        // a second refund. Set the status after the posts and the refund would be durable
        // while the status was not, which is how one cancellation pays out twice.
        booking.Status = BookingStatus.Cancelled;
        booking.CancelledAt = DateTimeOffset.UtcNow;
        booking.CancellationPenaltyWaived = waivePenalty && insidePenaltyWindow;

        _db.AuditLogs.Add(new AuditLog
        {
            TenantId = _tenant.TenantId,
            ActorUserId = actorId,
            SubjectUserId = booking.UserId.Value,
            Action = "booking.cancelled",
            DetailsJson = System.Text.Json.JsonSerializer.Serialize(new { booking_id = booking.Id, refund = refundAmount, penalty = penaltyAmount, waived = waivePenalty, was_charged = booking.ChargedAt is not null }),
        });

        // Both movements and the status in ONE save.
        //
        // Two rows rather than a netted one, because "money is ledger-only… disputes are
        // resolved by replaying the ledger" and a single net row cannot answer "how much
        // penalty did I pay?". Posting them together is what keeps that from costing
        // atomicity: PostManyAsync stages both and saves once, carrying the status change
        // with them, so the concurrency token decides the whole cancellation at once.
        var postings = new List<LedgerPosting>(2);
        if (refundAmount > 0)
        {
            postings.Add(new LedgerPosting(
                UserId: payerUserId,
                Type: LedgerEntryType.CancellationRefund,
                AmountCredits: refundAmount,
                ActorUserId: actorId,
                RelatedBookingId: booking.Id,
                Reason: "Cancellation refund"));
        }
        if (penaltyAmount > 0)
        {
            postings.Add(new LedgerPosting(
                UserId: payerUserId,
                Type: LedgerEntryType.LateCancellationPenalty,
                AmountCredits: -penaltyAmount,
                ActorUserId: actorId,
                RelatedBookingId: booking.Id,
                Reason: $"Late-cancellation penalty {Email.EmailTemplates.Num(settings.PenaltyPct)}%"));
        }

        try
        {
            await _ledger.PostManyAsync(postings, ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            // Somebody else decided this booking between our read and our write — the other
            // half of a double-tap on the PWA, an admin cancelling at the same moment, or a
            // check-in at the pad. Nothing was written, including the ledger rows, because
            // they save through this context. NotFound is the same answer a second
            // cancellation gets when it loses cleanly, which is what this is.
            _logger.LogInformation("Cancellation of {BookingId} lost a concurrent write", booking.Id);
            return new CancellationResult.NotFound();
        }

        var court = await _db.Courts.FirstAsync(c => c.Id == booking.CourtId, ct);
        var user = await _db.Users.FirstAsync(u => u.Id == booking.UserId, ct);
        var cancellationMsg = EmailTemplates.BookingCancellation(user.Email, court.Name, refundAmount, penaltyAmount > 0 ? penaltyAmount : null);
        SendEmailInBackground(cancellationMsg, $"cancellation for {booking.Id}");

        await _bus.EmitAsync(new DomainEvent(
            Id: $"evt_{Guid.NewGuid():N}",
            Type: penaltyAmount > 0 ? "booking.late_cancellation" : "booking.cancelled",
            TenantId: _tenant.TenantId, TenantSlug: _tenant.TenantSlug,
            OccurredAt: DateTimeOffset.UtcNow,
            ActorUserId: actorId, ActorIsAdmin: actorIsAdmin,
            SubjectUserId: booking.UserId,
            Data: new()
            {
                ["booking_id"] = booking.Id,
                ["court_id"] = court.Id,
                ["court_number"] = court.CourtNumber,
                ["user_id"] = booking.UserId,
                ["refund_credits"] = refundAmount,
                ["penalty_credits"] = penaltyAmount,
                ["was_charged"] = booking.ChargedAt is not null,
            }), ct);

        return new CancellationResult.Ok(refundAmount, penaltyAmount);
    }

    /// <summary>The ledger reference under which one booking's no-show reversal is posted — one per leg, once per booking.</summary>
    public static string NoShowReversalReference(Guid bookingId, string leg) => $"noshow-reversal:{bookingId:N}:{leg}";

    /// <summary>The reference under which a booking displaced by a reversal is refunded — once per displaced booking.</summary>
    public static string DisplacedReference(Guid reversedBookingId, Guid displacedBookingId) =>
        $"noshow-reversal:{reversedBookingId:N}:displaced:{displacedBookingId:N}";

    /// <summary>The reason text on a displaced booking's ledger rows, so the ledger names the collision by itself.</summary>
    public const string ResoldTailRefunded = "ResoldTailRefunded";

    /// <summary>
    /// The end a booking was sold to, before the sweep truncated it. The row keeps
    /// <c>SliceMinutes × SliceCount</c> as sold — the sweep moves only <c>EndsAt</c>.
    /// </summary>
    public static DateTimeOffset OriginalEndsAt(Booking booking) =>
        booking.StartsAt.AddMinutes(booking.SliceMinutes * booking.SliceCount);

    /// <summary>
    /// Reverses a settled no-show when evidence of attendance arrives after the sweep
    /// (review C6, the residual form).
    ///
    /// <para>
    /// A court box that has been offline for longer than the grace window lights a court
    /// from its cached roster and queues the activation. By the time the link returns the
    /// sweep has already run: the row is <c>NoShow</c>, the refund less the penalty has been
    /// paid, and the uploaded activation resolved to "not chargeable" — so the member who
    /// played kept the refund, paid the penalty, and the club's ledger said they never came.
    /// The activation event is attendance, and attendance is what the sweep was betting
    /// against; when it arrives late the bet is settled the other way.
    /// </para>
    ///
    /// <para>
    /// <b>Two new rows, never an edit.</b> The ledger is append-only and the sweep's rows are
    /// what happened; this posts a debit reversing the refund and a credit reversing the
    /// penalty, each tied to the booking and to its own reference, and each read back off
    /// the ledger rather than recomputed from settings that may since have changed. The
    /// same two types with the opposite sign, so every report bucket sums back to the
    /// truth — refunds for this booking net to nothing, penalties net to nothing, and the
    /// original charge stands as the one thing the member paid.
    /// </para>
    ///
    /// <para>
    /// <b>The reversal is a correction, not a purchase</b>, so it is posted whatever the
    /// balance: a member who spent the refund before the evidence arrived goes negative,
    /// which is the honest state — they owe the court they played on — and is what the
    /// balance guard on the next booking exists to collect.
    /// </para>
    ///
    /// <para>
    /// <b>An admin who already put the member right by hand is not corrected twice.</b> A
    /// positive <see cref="LedgerEntryType.AdminAdjustment"/> referencing this booking
    /// means the desk compensated the member before the box's evidence arrived; the
    /// money legs are then skipped and the fact is audited (<c>manual_compensation</c>
    /// on the reversal row), while attendance is still restored — the member was there.
    /// </para>
    ///
    /// <para>
    /// <b>The resold tail is reconciled</b> (closing re-review #16). The sweep released the
    /// remainder of the slot (decision 2026-08-24, H5) and it may since have been sold to
    /// somebody else — online, or at the box as a walk-up — while the box's own timer kept
    /// the first member's lights on to the original end. Every later booking on this
    /// court overlapping <c>[truncated EndsAt, original EndsAt]</c> that nobody checked in
    /// on is <i>displaced</i>: cancelled with the full charge back (a Booked row) or the
    /// no-show penalty returned (a row the sweep has already refunded), reason
    /// <see cref="ResoldTailRefunded"/>, its own reference, an audit row, an email and a
    /// <c>booking.displaced</c> event — the second buyer got a court someone else was
    /// already playing on. A booking somebody DID check in on is left alone and named on
    /// the audit row as a collision: two people cannot both have played, and the ledger
    /// is not the place to guess which one did. <b>Decision (2026-09-04): <c>EndsAt</c> is
    /// restored</b> to the original end, or to the start of the earliest surviving
    /// overlap — the lights genuinely ran that long, the row should say so, and a
    /// truncated end left the tail sellable at the box while the court was lit. The
    /// cue-off marker is cleared when the restored end is still ahead so the normal
    /// lights-off sweep fires once at the real end and promotes the row to Completed.
    /// </para>
    ///
    /// <para>
    /// Under the payer's lock, with the status change, the audit row and every movement in
    /// one save, so the concurrency token decides the whole reversal at once: a second
    /// upload of the same evidence finds the row <c>Booked</c> and checked in, and a
    /// concurrent one loses on the token, on a reference's unique index or on the slot
    /// exclusion constraint and reports <see cref="NoShowReversalResult.Lost"/> — nothing
    /// written, the winner's work intact, the caller re-reads and goes again.
    /// </para>
    /// </summary>
    public async Task<NoShowReversalResult> ReverseNoShowAsync(
        Booking booking, DateTimeOffset attendedAt, Guid actorUserId, CancellationToken ct,
        DateTimeOffset? provisionalLitEnd = null)
    {
        if (booking.Status != BookingStatus.NoShow || booking.UserId is null) return new NoShowReversalResult.NotNoShow();

        var now = DateTimeOffset.UtcNow;
        var payerUserId = booking.PaidByUserId ?? booking.UserId.Value;

        var legs = await SettledLegsAsync(booking, payerUserId, actorUserId, ct);
        var tail = await DisplacementAsync(booking, actorUserId, now, provisionalLitEnd, ct);
        var postings = legs.Postings.Concat(tail.Postings).ToList();

        await using var payerLock = await PayerLock.BeginAsync(_db, _tenant.TenantId, payerUserId, ct);

        try
        {
            // Two statements inside the one transaction, in this order, because the slot
            // exclusion constraint is checked per statement and not deferred: the displaced
            // rows must be Cancelled — out of the constraint — BEFORE this row's end is
            // restored over them. A failure on either statement rolls back both.
            if (tail.Displaced.Count > 0) await _db.SaveChangesAsync(ct);

            booking.Status = BookingStatus.Booked;
            booking.CheckedInAt = attendedAt;
            booking.LightsOnCuedAt ??= attendedAt;
            booking.NoShowReversedAt = now;
            RestoreEnd(booking, tail);

            _db.AuditLogs.Add(ReversalAudit(booking, attendedAt, payerUserId, actorUserId, legs, tail));
            foreach (var other in tail.Displaced) _db.AuditLogs.Add(DisplacedAudit(booking, other, tail.Amounts[other.Id], actorUserId));

            await _ledger.PostManyAsync(postings, ct);
        }
        catch (Exception ex) when (ex is DbUpdateConcurrencyException
                                   || (ex is DbUpdateException due && (IsDuplicateReference(due) || IsOverlapViolation(due))))
        {
            // The other upload of the same evidence got there first, something else
            // decided the row, or the tail was sold between the read and the write.
            // Nothing was written — the transaction is rolled back with the lock, so no
            // query here; forget the staged rows and the stale rows so the caller's
            // context is clean, and let it re-read: on the retry a fresh sale is a
            // survivor and the end is restored only up to it.
            _logger.LogInformation("No-show reversal of {BookingId} lost a concurrent write", booking.Id);
            DiscardPendingAdds();
            _db.Entry(booking).State = EntityState.Detached;
            foreach (var other in tail.Overlaps) _db.Entry(other).State = EntityState.Detached;
            return new NoShowReversalResult.Lost();
        }

        await payerLock.CommitAsync(ct);

        await NotifyNoShowReversedAsync(booking, legs.RefundBack, legs.PenaltyBack, attendedAt, ct);
        foreach (var other in tail.Displaced) await NotifyDisplacedAsync(other, booking, ct);
        return new NoShowReversalResult.Ok(legs.RefundBack, legs.PenaltyBack)
        {
            DisplacedBookingIds = tail.Displaced.Select(b => b.Id).ToList(),
            ManuallyCompensated = legs.Compensation.Count > 0,
        };
    }

    /// <summary>
    /// The two money legs of a reversal, read off the ledger.
    ///
    /// <para>
    /// <see cref="Refunded"/> and <see cref="Penalised"/> are what the sweep posted;
    /// <see cref="PenaltyBack"/> is what is actually returned once any money the desk
    /// already moved by hand has been netted off it (settlement model I3).
    /// </para>
    /// </summary>
    private sealed record SettledLegs(
        decimal Refunded, decimal Penalised, decimal RefundBack, decimal PenaltyBack,
        List<Guid> Compensation, decimal CompensatedCredits, List<LedgerPosting> Postings);

    /// <summary>
    /// Settles the reversal's two legs, netting any manual compensation <b>per leg</b>.
    ///
    /// <para>
    /// This used to read "a positive <see cref="LedgerEntryType.AdminAdjustment"/> naming
    /// this booking means the desk already fixed it" and drop <b>both</b> legs. That is the
    /// round-3 finding 2 defect, and it is worth naming precisely because the shape recurs:
    /// the sign of a hand adjustment says nothing about which leg it repaired. The honest
    /// outstanding after a sweep is always negative — the member holds a full refund less a
    /// penalty for a court they played — so a <i>positive</i> adjustment can never be the
    /// whole correction, and matching on sign alone matched only the wrong-direction ones.
    /// A desk that returned the 2.40 penalty made the whole 8-credit court free; a desk that
    /// posted the correct −7.60 was not <c>&gt; 0</c>, so the reversal ran on top of it and
    /// charged the member twice.
    /// </para>
    ///
    /// <para>
    /// So: <b>both legs are always attempted</b>, and each is netted against the adjustments
    /// that move money in <i>its own</i> direction. There is exactly one leg that gives
    /// money back (the penalty return) and exactly one that takes it (the refund reversal),
    /// so the mapping is forced:
    /// </para>
    ///
    /// <code>
    /// penaltyBack = max(0, penalised − Σ  positive adjustments)
    /// refundBack  = max(0, refunded  − Σ |negative adjustments|)
    /// </code>
    ///
    /// <para>
    /// A desk that returned the 2.40 penalty leaves <c>penaltyBack = 0</c> and the full
    /// refund reversal, ending at 92 on an 8-credit court — the honest owed. A desk that
    /// posted the whole correction by hand as −5.60 leaves 2.40 either way, which nets to
    /// nothing and also ends at 92. Neither can be reached by matching on sign alone.
    /// </para>
    ///
    /// <para>
    /// The adjustment ids land on the audit row, so the desk can see which of their rows was
    /// netted. <c>l.UserId == payerUserId</c> is not optional (finding 17): without it, an
    /// adjustment on another member's wallet that happened to name this booking counted as
    /// compensation to <i>this</i> payer.
    /// </para>
    /// </summary>
    private async Task<SettledLegs> SettledLegsAsync(Booking booking, Guid payerUserId, Guid actorUserId, CancellationToken ct)
    {
        // What the sweep actually posted. The sweep is the only producer that posts these
        // two types as the system actor, and a reversal already on the ledger nets to zero
        // here — so this is "what is still outstanding", read off the record.
        var settled = await _db.LedgerEntries.AsNoTracking()
            .Where(l => l.RelatedBookingId == booking.Id
                        && l.UserId == payerUserId
                        && l.ActorUserId == Guid.Empty
                        && (l.Type == LedgerEntryType.CancellationRefund || l.Type == LedgerEntryType.NoShowPenalty))
            .ToListAsync(ct);
        var refunded = settled.Where(l => l.Type == LedgerEntryType.CancellationRefund).Sum(l => l.AmountCredits);
        var penalised = -settled.Where(l => l.Type == LedgerEntryType.NoShowPenalty).Sum(l => l.AmountCredits);

        var compensation = await _db.LedgerEntries.AsNoTracking()
            .Where(l => l.RelatedBookingId == booking.Id
                        && l.UserId == payerUserId
                        && l.Type == LedgerEntryType.AdminAdjustment)
            .Select(l => new { l.Id, l.AmountCredits })
            .ToListAsync(ct);
        var givenBack = compensation.Where(c => c.AmountCredits > 0).Sum(c => c.AmountCredits);
        var takenBack = -compensation.Where(c => c.AmountCredits < 0).Sum(c => c.AmountCredits);
        var penaltyBack = Math.Max(0m, penalised - givenBack);
        var refundBack = Math.Max(0m, refunded - takenBack);

        var postings = new List<LedgerPosting>(2);
        if (refundBack > 0)
        {
            postings.Add(new LedgerPosting(
                UserId: payerUserId,
                Type: LedgerEntryType.CancellationRefund,
                AmountCredits: -refundBack,
                ActorUserId: actorUserId,
                RelatedBookingId: booking.Id,
                Reason: takenBack > 0
                    ? "No-show refund reversed — attendance recorded after the sweep, net of the desk's own adjustment"
                    : "No-show refund reversed — attendance recorded after the sweep",
                ExternalReference: NoShowReversalReference(booking.Id, "refund")));
        }
        if (penaltyBack > 0)
        {
            postings.Add(new LedgerPosting(
                UserId: payerUserId,
                Type: LedgerEntryType.NoShowPenalty,
                AmountCredits: penaltyBack,
                ActorUserId: actorUserId,
                RelatedBookingId: booking.Id,
                Reason: givenBack > 0
                    ? "No-show penalty reversed — attendance recorded after the sweep, net of the desk's own adjustment"
                    : "No-show penalty reversed — attendance recorded after the sweep",
                ExternalReference: NoShowReversalReference(booking.Id, "penalty")));
        }
        return new SettledLegs(
            refunded, penalised, refundBack, penaltyBack,
            compensation.Select(c => c.Id).ToList(), givenBack - takenBack, postings);
    }

    /// <summary>
    /// The released tail, reconciled: every later booking overlapping it, which of them are
    /// displaced (flipped to Cancelled on the tracked rows, their refund postings staged) and
    /// which survive because somebody checked in on them, and what each displaced member
    /// gets back — captured before the flip.
    /// </summary>
    private sealed record Displacement(
        DateTimeOffset OriginalEndsAt, DateTimeOffset ProvisionalEnd,
        List<Booking> Overlaps, List<Booking> Displaced, List<Booking> Survivors,
        Dictionary<Guid, decimal> Amounts, List<LedgerPosting> Postings);

    /// <summary>
    /// The tail the sweep released, reconciled against the window the lights are believed to
    /// have run for.
    ///
    /// <para>
    /// <paramref name="provisionalLitEnd"/> is the caller's best knowledge of when the court
    /// went dark: the activation's own grant, bounded by the sold window (settlement model
    /// I6/I8). It used to be the original end unconditionally, which displaced — refunded,
    /// emailed, cancelled — every later booking in the whole slot even when the box's grant
    /// could not have reached them.
    /// </para>
    ///
    /// <para>
    /// A displaced booking's access code is expired on the same tracked context, so it dies
    /// in the same save as the cancellation. Leaving it live is finding 16: the member is
    /// told their court was taken, walks in anyway, is admitted by the box's cached roster
    /// onto the court that displaced them, and is then billed pro rata for it.
    /// </para>
    /// </summary>
    private async Task<Displacement> DisplacementAsync(
        Booking booking, Guid actorUserId, DateTimeOffset now, DateTimeOffset? provisionalLitEnd, CancellationToken ct)
    {
        var originalEndsAt = OriginalEndsAt(booking);
        var provisionalEnd = provisionalLitEnd is { } end && end < originalEndsAt ? end : originalEndsAt;
        if (provisionalEnd < booking.EndsAt) provisionalEnd = booking.EndsAt;
        var overlaps = await TailOverlapsAsync(booking, provisionalEnd, ct);
        var displaced = overlaps.Where(b => b.CheckedInAt is null && b.Status is BookingStatus.Booked or BookingStatus.NoShow).ToList();
        var survivors = overlaps.Except(displaced).ToList();
        var penaltiesTaken = await NoShowPenaltiesTakenAsync(displaced, ct);
        var amounts = displaced.ToDictionary(
            b => b.Id, b => b.Status == BookingStatus.NoShow ? penaltiesTaken.GetValueOrDefault(b.Id) : DisplacedAmount(b));

        var postings = new List<LedgerPosting>(displaced.Count);
        foreach (var other in displaced)
        {
            // I10: nothing is posted for a booking that was never charged. A zero row moves
            // no money, burns the reference the real posting would need, and reads on a
            // statement as a movement that did not happen.
            if (amounts[other.Id] > 0) postings.Add(DisplacedPosting(booking, other, penaltiesTaken.GetValueOrDefault(other.Id), actorUserId));
            other.Status = BookingStatus.Cancelled;
            other.CancelledAt = now;
            other.CancellationPenaltyWaived = true;
            other.CancellationReason = ResoldTailRefunded;
            other.DisplacedByBookingId = booking.Id;
        }
        await ExpireCodesAsync(displaced.Select(b => b.Id).ToList(), now, ct);

        return new Displacement(originalEndsAt, provisionalEnd, overlaps, displaced, survivors, amounts, postings);
    }

    /// <summary>
    /// Kills every live access code on these bookings, on the tracked context so it lands in
    /// the caller's own save. Expiry is set to <paramref name="now"/> rather than the past:
    /// a scan that genuinely happened <i>before</i> this instant must still resolve, so the
    /// event can be recognised and refused for the right reason instead of vanishing as
    /// <c>unresolved</c>.
    /// </summary>
    private async Task ExpireCodesAsync(List<Guid> bookingIds, DateTimeOffset now, CancellationToken ct)
    {
        if (bookingIds.Count == 0) return;
        var codes = await _db.AccessCodes
            .Where(c => c.BookingId != null && bookingIds.Contains(c.BookingId.Value) && c.ExpiresAt > now)
            .ToListAsync(ct);
        foreach (var code in codes) code.ExpiresAt = now;
    }

    /// <summary>
    /// The truncated end is restored to the window the lights are believed to have run for —
    /// the provisional lit end, or the start of the earliest surviving overlap, whichever is
    /// sooner (settlement model I8).
    ///
    /// <para>
    /// Two changes from the 2026-09-04 decision, both from round 3. The end is the
    /// <b>provisional lit end</b> rather than the original end, because the original end is
    /// not evidence of anything; the box's <c>release</c> narrows it further when it lands.
    /// And <c>LightsOffCuedAt</c> is <b>not</b> cleared: the sweep had already cued the
    /// lights off at the truncated end, and clearing the marker made
    /// <c>LightsCueWorker</c> fire a second <c>booking.lights_off</c> for the same booking
    /// with a different <c>ends_at</c> (I12). Promotion to <c>Completed</c> does not need
    /// it — the worker's attended-and-over pass promotes a reversed row whether or not the
    /// cue already fired.
    /// </para>
    /// </summary>
    private static void RestoreEnd(Booking booking, Displacement tail)
    {
        var restoreTo = tail.Survivors.Aggregate(tail.ProvisionalEnd, (end, s) => s.StartsAt < end ? s.StartsAt : end);
        if (restoreTo > booking.EndsAt) booking.EndsAt = restoreTo;
    }

    private AuditLog ReversalAudit(Booking booking, DateTimeOffset attendedAt, Guid payerUserId, Guid actorUserId, SettledLegs legs, Displacement tail)
    {
        return new AuditLog
        {
            TenantId = _tenant.TenantId,
            ActorUserId = actorUserId,
            SubjectUserId = booking.UserId,
            Action = "booking.no_show_reversed",
            DetailsJson = System.Text.Json.JsonSerializer.Serialize(new
            {
                booking_id = booking.Id,
                attended_at = attendedAt,
                refund_reversed_credits = legs.RefundBack,
                penalty_reversed_credits = legs.PenaltyBack,
                refund_settled_credits = legs.Refunded,
                penalty_settled_credits = legs.Penalised,
                payer_user_id = payerUserId,
                manual_compensation = legs.Compensation.Count > 0 ? legs.Compensation : null,
                manual_compensation_credits = legs.CompensatedCredits,
                ends_at = booking.EndsAt,
                original_ends_at = tail.OriginalEndsAt,
                provisional_lit_end = tail.ProvisionalEnd,
                displaced_booking_ids = tail.Displaced.Select(b => b.Id).ToList(),
                collision_booking_ids = tail.Survivors.Select(b => b.Id).ToList(),
            }),
        };
    }

    private AuditLog DisplacedAudit(Booking booking, Booking other, decimal refund, Guid actorUserId)
    {
        return new AuditLog
        {
            TenantId = _tenant.TenantId,
            ActorUserId = actorUserId,
            SubjectUserId = other.UserId,
            Action = "booking.displaced",
            DetailsJson = System.Text.Json.JsonSerializer.Serialize(new
            {
                booking_id = other.Id,
                displaced_by_booking_id = booking.Id,
                refund_credits = refund,
                reason = ResoldTailRefunded,
            }),
        };
    }

    /// <summary>
    /// Every later booking on the same court that overlaps the tail the sweep released:
    /// <c>[EndsAt as truncated, the provisional lit end)</c>. Nothing can have overlapped
    /// before the sweep — the exclusion constraint saw to that — so every hit here was sold
    /// after it. Tracked, because the displaced ones are cancelled in the same save.
    /// </summary>
    private async Task<List<Booking>> TailOverlapsAsync(Booking booking, DateTimeOffset provisionalEnd, CancellationToken ct)
    {
        if (provisionalEnd <= booking.EndsAt) return [];
        var truncatedEnd = booking.EndsAt;
        return await _db.Bookings
            .Where(b => b.CourtId == booking.CourtId
                        && b.Id != booking.Id
                        && b.Status != BookingStatus.Cancelled
                        && b.StartsAt < provisionalEnd
                        && b.EndsAt > truncatedEnd)
            .OrderBy(b => b.StartsAt)
            .ToListAsync(ct);
    }

    /// <summary>What a displaced <c>Booked</c> row gets back: its whole charge. A swept row was refunded at the sweep and gets its penalty back instead.</summary>
    private static decimal DisplacedAmount(Booking other) => other.Status == BookingStatus.NoShow
        ? 0m
        : other.ChargedAt is not null ? other.AmountChargedCredits : 0m;

    /// <summary>The net no-show penalty still standing against each swept row in <paramref name="displaced"/>, off the ledger.</summary>
    private async Task<Dictionary<Guid, decimal>> NoShowPenaltiesTakenAsync(List<Booking> displaced, CancellationToken ct)
    {
        var swept = displaced.Where(b => b.Status == BookingStatus.NoShow).Select(b => b.Id).ToList();
        if (swept.Count == 0) return [];
        var rows = await _db.LedgerEntries.AsNoTracking()
            .Where(l => l.RelatedBookingId != null && swept.Contains(l.RelatedBookingId.Value) && l.Type == LedgerEntryType.NoShowPenalty)
            .ToListAsync(ct);
        return rows.GroupBy(l => l.RelatedBookingId!.Value).ToDictionary(g => g.Key, g => -g.Sum(l => l.AmountCredits));
    }

    /// <summary>
    /// The one movement that puts a displaced member right. A <c>Booked</c> row is refunded
    /// in full; a row the sweep already settled gets its penalty back (the refund was paid
    /// at the sweep). The same types as the rows they answer, so the buckets net to truth.
    /// </summary>
    private static LedgerPosting DisplacedPosting(Booking reversed, Booking other, decimal penaltyTaken, Guid actorUserId)
    {
        var payer = other.PaidByUserId ?? other.UserId ?? other.BookedByUserId ?? Guid.Empty;
        var reference = DisplacedReference(reversed.Id, other.Id);
        if (other.Status == BookingStatus.NoShow)
        {
            var penalty = penaltyTaken;
            return new LedgerPosting(
                UserId: payer,
                Type: LedgerEntryType.NoShowPenalty,
                AmountCredits: penalty,
                ActorUserId: actorUserId,
                RelatedBookingId: other.Id,
                Reason: $"{ResoldTailRefunded} — no-show penalty returned: the court was already in use by an earlier booking whose attendance arrived late",
                ExternalReference: reference);
        }

        return new LedgerPosting(
            UserId: payer,
            Type: LedgerEntryType.CancellationRefund,
            AmountCredits: DisplacedAmount(other),
            ActorUserId: actorUserId,
            RelatedBookingId: other.Id,
            Reason: $"{ResoldTailRefunded} — refunded in full: the court was already in use by an earlier booking whose attendance arrived late",
            ExternalReference: reference);
    }

    private async Task NotifyDisplacedAsync(Booking other, Booking reversed, CancellationToken ct)
    {
        var user = other.UserId is null ? null : await _db.Users.FirstOrDefaultAsync(u => u.Id == other.UserId, ct);
        var court = await _db.Courts.FirstOrDefaultAsync(c => c.Id == other.CourtId, ct);
        var courtName = court?.Name ?? "a court";

        if (user is not null)
        {
            try
            {
                await _email.SendAsync(DisplacedEmail(user.Email, courtName, other.StartsAt), ct);
            }
            catch (Exception ex) { _logger.LogWarning(ex, "Displacement email failed for {BookingId}", other.Id); }
        }

        await _bus.EmitAsync(new DomainEvent(
            Id: $"evt_{Guid.NewGuid():N}",
            Type: "booking.displaced",
            TenantId: _tenant.TenantId, TenantSlug: _tenant.TenantSlug,
            OccurredAt: DateTimeOffset.UtcNow, ActorUserId: null, ActorIsAdmin: false, SubjectUserId: other.UserId,
            Data: new()
            {
                ["booking_id"] = other.Id,
                ["displaced_by_booking_id"] = reversed.Id,
                ["court_id"] = other.CourtId,
                ["court_number"] = court?.CourtNumber,
                ["user_id"] = other.UserId,
                ["starts_at"] = other.StartsAt,
                ["ends_at"] = other.EndsAt,
                ["reason"] = ResoldTailRefunded,
            }), ct);
    }

    // Block body, not an expression body — lizard mis-scopes an expression-bodied member
    // containing braces; see memory/gotchas.md.
    private static Email.EmailMessage DisplacedEmail(string to, string courtName, DateTimeOffset startsAt)
    {
        return new Email.EmailMessage(
            To: to,
            Subject: $"Booking refunded — {courtName} was already in use",
            HtmlBody:
                $"""
                <div style="font-family:Figtree,sans-serif;color:#0F172A;max-width:560px">
                  <h2 style="margin:0 0 12px">Your booking has been refunded</h2>
                  <p>Your booking on {courtName} at {startsAt:HH:mm} on {startsAt:ddd dd MMM} was sold while the court was still being used by an earlier booking whose check-in reached us late.</p>
                  <p>It has been cancelled and refunded in full, with no penalty. We are sorry for the wasted trip.</p>
                </div>
                """);
    }

    /// <summary>The ledger reference for the one pro-rata charge a cancelled-then-lit booking may carry.</summary>
    public static string CancelledLightsReference(Guid bookingId) => $"cancelled-lit:{bookingId:N}";

    /// <summary>The reference for the one correction the box's own release may make to that charge.</summary>
    public static string CancelledLightsReleaseReference(Guid bookingId) => $"cancelled-lit-release:{bookingId:N}";

    /// <summary>
    /// What lit time on a cancelled booking is worth, under the settlement model's ceiling.
    ///
    /// <para>
    /// Three bounds, and each of them was missing (finding 3). <b>Sold minutes</b>, because
    /// the box's grant runs from a roster window that opens a cue window before the slot —
    /// a punctual member on a 60-minute court was billed 68 minutes. <b>The relay hard
    /// cap</b>, which was already there. And <b>the price ceiling</b>: a booking cancelled
    /// inside the penalty window has already cost its member the penalty, and charging the
    /// full lit time on top of that billed 143 credits for a 100-credit court. What is left
    /// to charge is <c>P − retained penalty</c>, and never more.
    /// </para>
    ///
    /// <para>
    /// Null when there is nothing to charge — no minutes, or the retained penalty already
    /// accounts for the whole price.
    /// </para>
    /// </summary>
    private async Task<(int Minutes, decimal Amount, Court Court)?> PriceLitTimeAsync(
        Booking booking, Guid payerUserId, int litMinutes, CancellationToken ct)
    {
        var settings = await _settings.GetAsync(ct);
        var court = await _db.Courts.FirstAsync(c => c.Id == booking.CourtId, ct);

        var soldMinutes = booking.SliceMinutes * booking.SliceCount;
        var minutes = Math.Clamp(litMinutes, 0, Math.Min(soldMinutes, RelayHardCap.Minutes));
        if (minutes <= 0) return null;

        var gross = Math.Round(court.SlicePriceCredits * minutes / settings.SliceMinutes, 2, MidpointRounding.AwayFromZero);
        var retained = await RetainedPenaltyAsync(booking, payerUserId, ct);
        var amount = Math.Min(gross, booking.AmountChargedCredits - retained);
        return amount <= 0 ? null : (minutes, amount, court);
    }

    /// <summary>
    /// The late-cancellation penalty still standing against this booking for this payer, net
    /// of anything that reversed it. Positive, because the rows themselves are debits.
    /// </summary>
    private async Task<decimal> RetainedPenaltyAsync(Booking booking, Guid payerUserId, CancellationToken ct)
    {
        var sum = await _db.LedgerEntries.AsNoTracking()
            .Where(l => l.RelatedBookingId == booking.Id
                        && l.UserId == payerUserId
                        && l.Type == LedgerEntryType.LateCancellationPenalty)
            .SumAsync(l => (decimal?)l.AmountCredits, ct) ?? 0m;
        return Math.Max(0m, -sum);
    }

    /// <summary>
    /// The lights ran on a booking that had already been cancelled and refunded — charge
    /// the time that was lit, pro rata, as a walk-up-style purchase (closing re-review #21).
    ///
    /// <para>
    /// The roster is rebuilt only on the heartbeat and the box trusts it offline for hours,
    /// so a booking cancelled after its code was pushed still opens its court from a box
    /// that lost the network. The late event used to be audited <c>not_chargeable</c> and
    /// the money stayed refunded: an hour of court for nothing, on a slot the club may have
    /// resold. "Nothing back once the lights have been on" is the rule, so the lit time is
    /// charged: a <see cref="LedgerEntryType.LightsPurchase"/> for <paramref name="litMinutes"/>
    /// at the court's tariff, separate from the refund it does not net against, reason
    /// naming the cancelled booking, one per booking by reference. Posted whatever the
    /// balance — it is a correction, like the reversal above — and the member is told.
    /// </para>
    /// </summary>
    public async Task<CancelledLightsResult> ChargeLitCancelledBookingAsync(
        Booking booking, DateTimeOffset occurredAt, int litMinutes, CancellationToken ct)
    {
        if (booking.Status != BookingStatus.Cancelled || booking.UserId is null) return new CancelledLightsResult.NotCharged();
        if (booking.CheckedInAt is not null) return new CancelledLightsResult.NotCharged();   // cancelled after check-in: no refund was ever paid

        // Settlement model I5. This row was not cancelled by its member — the system took
        // the court away from them so an earlier booking's late attendance evidence could
        // have it, refunded them in full and emailed them to say so. Billing them pro rata
        // for the collision charges two members for one court, which is the exact outcome
        // the displacement exists to avoid (finding 16). Owed is zero, unconditionally.
        if (string.Equals(booking.CancellationReason, ResoldTailRefunded, StringComparison.Ordinal))
        {
            return new CancelledLightsResult.Displaced(booking.DisplacedByBookingId);
        }

        var payerUserId = booking.PaidByUserId ?? booking.UserId.Value;
        var priced = await PriceLitTimeAsync(booking, payerUserId, litMinutes, ct);
        if (priced is not { } charge) return new CancelledLightsResult.NotCharged();
        var (minutes, amount, court) = charge;

        try
        {
            await _ledger.PostAsync(new LedgerPosting(
                UserId: payerUserId,
                Type: LedgerEntryType.LightsPurchase,
                AmountCredits: -amount,
                ActorUserId: Guid.Empty,
                RelatedBookingId: booking.Id,
                Reason: $"Lights ran {minutes} min on cancelled booking {court.Name} {await SlotLabelAsync(booking, ct)} — charged pro rata",
                ExternalReference: CancelledLightsReference(booking.Id)), ct);
        }
        catch (DbUpdateException ex) when (IsDuplicateReference(ex))
        {
            DiscardPendingAdds();
            return new CancelledLightsResult.AlreadyCharged();
        }

        _db.AuditLogs.Add(new AuditLog
        {
            TenantId = _tenant.TenantId,
            ActorUserId = Guid.Empty,
            SubjectUserId = booking.UserId.Value,
            Action = "booking.cancelled_lights_charged",
            DetailsJson = System.Text.Json.JsonSerializer.Serialize(new
            {
                booking_id = booking.Id,
                occurred_at = occurredAt,
                lit_minutes = minutes,
                amount_credits = amount,
                payer_user_id = payerUserId,
                original_price_credits = booking.AmountChargedCredits,
                sold_minutes = booking.SliceMinutes * booking.SliceCount,
            }),
        });
        await _db.SaveChangesAsync(ct);

        var user = await _db.Users.FirstOrDefaultAsync(u => u.Id == booking.UserId, ct);
        if (user is not null)
        {
            try
            {
                await _email.SendAsync(CancelledLightsEmail(user.Email, court.Name, minutes, amount), ct);
            }
            catch (Exception ex) { _logger.LogWarning(ex, "Cancelled-lights email failed for {BookingId}", booking.Id); }
        }

        await _bus.EmitAsync(new DomainEvent(
            Id: $"evt_{Guid.NewGuid():N}",
            Type: "booking.cancelled_lights_charged",
            TenantId: _tenant.TenantId, TenantSlug: _tenant.TenantSlug,
            OccurredAt: DateTimeOffset.UtcNow, ActorUserId: null, ActorIsAdmin: false, SubjectUserId: booking.UserId,
            Data: new()
            {
                ["booking_id"] = booking.Id,
                ["court_id"] = court.Id,
                ["court_number"] = court.CourtNumber,
                ["user_id"] = booking.UserId,
                ["lit_minutes"] = minutes,
                ["amount_credits"] = amount,
                ["occurred_at"] = occurredAt,
            }), ct);

        return new CancelledLightsResult.Charged(amount, minutes);
    }

    private static Email.EmailMessage CancelledLightsEmail(string to, string courtName, int minutes, decimal amount)
    {
        return new Email.EmailMessage(
            To: to,
            Subject: $"Lights charged — {courtName}",
            HtmlBody:
                $"""
                <div style="font-family:Figtree,sans-serif;color:#0F172A;max-width:560px">
                  <h2 style="margin:0 0 12px">Your cancelled booking was used</h2>
                  <p>The lights on {courtName} were switched on with the code of a booking you had cancelled and been refunded for.</p>
                  <p><strong>{minutes} minutes</strong> of court time has been charged at the usual rate: <strong>{amount:0.00} credits</strong>. Nothing is refunded once the lights have been on.</p>
                </div>
                """);
    }

    /// <summary>
    /// The box's own <c>release</c> event, applied: the one measurement of how long a relay
    /// was actually closed (settlement model §4, I6, I8, I9).
    ///
    /// <para>
    /// Everything upstream of this works from the <i>grant</i> — what the relay was told to
    /// run for. The grant is an upper bound and nothing more: a member who plays twenty
    /// minutes of an hour and presses OFF produces a sixty-minute grant and a twenty-minute
    /// hold. The release is the only place the difference is knowable, and it necessarily
    /// arrives late — the box uploads one event per request in sequence order, so a release
    /// is always at least one request behind the activation it belongs to.
    /// </para>
    ///
    /// <para>
    /// Two things are corrected, and both only ever move in the member's favour. A
    /// cancelled-then-lit charge is <b>reduced</b> to the real lit time, never increased —
    /// increasing it on late evidence would let a mis-paired release bill someone. And a
    /// reversed no-show's provisional end is <b>narrowed</b> to the real one, freeing the
    /// tail for resale, and any booking the reversal displaced that the court never
    /// actually reached — and which has not yet started — is put back.
    /// </para>
    /// </summary>
    public async Task<ReleaseSettlement> SettleReleaseAsync(
        Booking booking, int litMinutes, DateTimeOffset litEnd, Guid actorUserId, CancellationToken ct)
    {
        if (booking.UserId is null) return ReleaseSettlement.NotApplicable;

        if (booking.Status == BookingStatus.Cancelled
            && booking.CheckedInAt is null
            && !string.Equals(booking.CancellationReason, ResoldTailRefunded, StringComparison.Ordinal))
        {
            return await ReduceLitChargeAsync(booking, litMinutes, ct);
        }

        if (booking.NoShowReversedAt is not null
            && booking.Status is BookingStatus.Booked or BookingStatus.Completed)
        {
            return await NarrowReversedWindowAsync(booking, litEnd, actorUserId, ct);
        }

        return ReleaseSettlement.NotApplicable;
    }

    /// <summary>
    /// The cancelled-then-lit charge, re-priced against the measured window and refunded
    /// down to it. Never up: a release that would <i>increase</i> the charge is ignored,
    /// because the activation's grant already bounded what could honestly be billed and a
    /// mis-paired release must not be able to invent a charge.
    /// </summary>
    private async Task<ReleaseSettlement> ReduceLitChargeAsync(Booking booking, int litMinutes, CancellationToken ct)
    {
        var payerUserId = booking.PaidByUserId ?? booking.UserId!.Value;
        var posted = await _db.LedgerEntries.AsNoTracking()
            .Where(l => l.RelatedBookingId == booking.Id
                        && l.UserId == payerUserId
                        && l.Type == LedgerEntryType.LightsPurchase)
            .SumAsync(l => (decimal?)l.AmountCredits, ct) ?? 0m;
        var charged = -posted;
        if (charged <= 0) return ReleaseSettlement.NotApplicable;

        var priced = await PriceLitTimeAsync(booking, payerUserId, litMinutes, ct);
        var back = charged - (priced?.Amount ?? 0m);
        if (back <= 0) return ReleaseSettlement.NotApplicable;

        _db.AuditLogs.Add(new AuditLog
        {
            TenantId = _tenant.TenantId,
            ActorUserId = Guid.Empty,
            SubjectUserId = booking.UserId,
            Action = "booking.cancelled_lights_adjusted",
            DetailsJson = System.Text.Json.JsonSerializer.Serialize(new
            {
                booking_id = booking.Id,
                charged_credits = charged,
                measured_credits = priced?.Amount ?? 0m,
                returned_credits = back,
                measured_minutes = litMinutes,
                payer_user_id = payerUserId,
            }),
        });

        try
        {
            await _ledger.PostAsync(new LedgerPosting(
                UserId: payerUserId,
                Type: LedgerEntryType.LightsPurchase,
                AmountCredits: back,
                ActorUserId: Guid.Empty,
                RelatedBookingId: booking.Id,
                Reason: $"Lights ran {litMinutes} min, not the granted window — {back:0.00} credits returned",
                ExternalReference: CancelledLightsReleaseReference(booking.Id)), ct);
        }
        catch (DbUpdateException ex) when (IsDuplicateReference(ex))
        {
            DiscardPendingAdds();
            return ReleaseSettlement.NotApplicable;
        }

        return new ReleaseSettlement("charge_reduced", back, []);
    }

    /// <summary>
    /// The reversed no-show's provisional end, narrowed to what the relay measured — and
    /// every booking the displacement took that the court never reached, put back.
    ///
    /// <para>
    /// Reinstatement is bounded to bookings that have <b>not started yet</b>. A member who
    /// was emailed that their court was gone and did not come cannot be un-told after the
    /// fact, and the refund has already made them whole; putting the row back would only
    /// re-charge them for a court they did not use. Before their start, putting it back is
    /// exactly right — in the common shape the release lands seconds after the activation,
    /// long before the displaced slot begins.
    /// </para>
    /// </summary>
    private async Task<ReleaseSettlement> NarrowReversedWindowAsync(
        Booking booking, DateTimeOffset litEnd, Guid actorUserId, CancellationToken ct)
    {
        var newEnd = litEnd < booking.StartsAt ? booking.StartsAt : litEnd;
        if (newEnd >= booking.EndsAt) return ReleaseSettlement.NotApplicable;

        var now = DateTimeOffset.UtcNow;
        var displaced = await _db.Bookings
            .Where(b => b.DisplacedByBookingId == booking.Id && b.Status == BookingStatus.Cancelled)
            .ToListAsync(ct);
        var candidates = displaced.Where(b => b.StartsAt >= newEnd && b.StartsAt > now).ToList();

        var previousEnd = booking.EndsAt;
        booking.EndsAt = newEnd;
        _db.AuditLogs.Add(new AuditLog
        {
            TenantId = _tenant.TenantId,
            ActorUserId = Guid.Empty,
            SubjectUserId = booking.UserId,
            Action = "booking.lit_window_narrowed",
            DetailsJson = System.Text.Json.JsonSerializer.Serialize(new
            {
                booking_id = booking.Id,
                provisional_ends_at = previousEnd,
                measured_ends_at = newEnd,
                reinstatable_booking_ids = candidates.Select(b => b.Id).ToList(),
            }),
        });

        // The range has to be freed before anything is put back into it: the slot exclusion
        // constraint is checked per statement, not deferred.
        await _db.SaveChangesAsync(ct);

        var reinstated = new List<Guid>();
        foreach (var other in candidates)
        {
            if (await ReinstateAsync(booking, other, actorUserId, ct)) reinstated.Add(other.Id);
        }

        return new ReleaseSettlement("window_narrowed", 0m, reinstated);
    }

    /// <summary>
    /// Puts one displaced booking back: <c>Booked</c> again, the displacement refund
    /// reversed, a fresh access code minted (the old one died with the displacement), the
    /// member told. False when it could not be done — the slot was resold in the meantime,
    /// or the row was a swept no-show whose slot is long past.
    /// </summary>
    private async Task<bool> ReinstateAsync(Booking reversed, Booking other, Guid actorUserId, CancellationToken ct)
    {
        var reference = DisplacedReference(reversed.Id, other.Id);
        var refund = await _db.LedgerEntries.AsNoTracking()
            .FirstOrDefaultAsync(l => l.ExternalReference == reference, ct);
        if (refund is not null && refund.Type != LedgerEntryType.CancellationRefund) return false;

        var settings = await _settings.GetAsync(ct);
        other.Status = BookingStatus.Booked;
        other.CancelledAt = null;
        other.CancellationReason = null;
        other.CancellationPenaltyWaived = false;
        other.DisplacedByBookingId = null;
        await _codes.StageForBookingAsync(other, TimeSpan.FromMinutes(settings.GraceWindowMinutes), ct);

        _db.AuditLogs.Add(new AuditLog
        {
            TenantId = _tenant.TenantId,
            ActorUserId = actorUserId,
            SubjectUserId = other.UserId,
            Action = "booking.displacement_reversed",
            DetailsJson = System.Text.Json.JsonSerializer.Serialize(new
            {
                booking_id = other.Id,
                displaced_by_booking_id = reversed.Id,
                recharged_credits = refund?.AmountCredits ?? 0m,
            }),
        });

        var postings = refund is null || refund.AmountCredits <= 0
            ? new List<LedgerPosting>()
            : [new LedgerPosting(
                UserId: refund.UserId,
                Type: LedgerEntryType.CancellationRefund,
                AmountCredits: -refund.AmountCredits,
                ActorUserId: actorUserId,
                RelatedBookingId: other.Id,
                Reason: "Booking reinstated — the earlier court went dark before your slot",
                ExternalReference: reference + ":reinstated")];

        try
        {
            await _ledger.PostManyAsync(postings, ct);
        }
        catch (Exception ex) when (ex is DbUpdateConcurrencyException
                                   || (ex is DbUpdateException due && (IsDuplicateReference(due) || IsOverlapViolation(due))))
        {
            _logger.LogInformation("Reinstatement of displaced booking {BookingId} was refused", other.Id);
            DiscardPendingAdds();
            _db.Entry(other).State = EntityState.Detached;
            return false;
        }

        await NotifyReinstatedAsync(other, ct);
        return true;
    }

    private async Task NotifyReinstatedAsync(Booking other, CancellationToken ct)
    {
        var user = other.UserId is null ? null : await _db.Users.FirstOrDefaultAsync(u => u.Id == other.UserId, ct);
        var court = await _db.Courts.FirstOrDefaultAsync(c => c.Id == other.CourtId, ct);
        var courtName = court?.Name ?? "a court";

        if (user is not null)
        {
            try
            {
                await _email.SendAsync(ReinstatedEmail(user.Email, courtName, other.StartsAt), ct);
            }
            catch (Exception ex) { _logger.LogWarning(ex, "Reinstatement email failed for {BookingId}", other.Id); }
        }

        await _bus.EmitAsync(new DomainEvent(
            Id: $"evt_{Guid.NewGuid():N}",
            Type: "booking.displacement_reversed",
            TenantId: _tenant.TenantId, TenantSlug: _tenant.TenantSlug,
            OccurredAt: DateTimeOffset.UtcNow, ActorUserId: null, ActorIsAdmin: false, SubjectUserId: other.UserId,
            Data: new()
            {
                ["booking_id"] = other.Id,
                ["court_id"] = other.CourtId,
                ["court_number"] = court?.CourtNumber,
                ["user_id"] = other.UserId,
                ["starts_at"] = other.StartsAt,
                ["ends_at"] = other.EndsAt,
            }), ct);
    }

    // Block body, not an expression body — lizard mis-scopes an expression-bodied member
    // containing braces; see memory/gotchas.md.
    private static Email.EmailMessage ReinstatedEmail(string to, string courtName, DateTimeOffset startsAt)
    {
        return new Email.EmailMessage(
            To: to,
            Subject: $"Booking reinstated — {courtName}",
            HtmlBody:
                $"""
                <div style="font-family:Figtree,sans-serif;color:#0F172A;max-width:560px">
                  <h2 style="margin:0 0 12px">Your booking is back on</h2>
                  <p>We refunded your booking on {courtName} at {startsAt:HH:mm} on {startsAt:ddd dd MMM} because an earlier booking looked as though it was still using the court.</p>
                  <p>The court's own lights say otherwise — it went dark before your slot — so the booking has been reinstated and re-charged at the original price. Your access code is in the app.</p>
                </div>
                """);
    }

    /// <summary>
    /// Tells the member and the event stream. Mirrors the sweep's own notification: the
    /// money is committed by now and the email is the courtesy, so a member with no
    /// <c>users</c> row is logged and skipped, and a failed send is logged and swallowed.
    /// </summary>
    private async Task NotifyNoShowReversedAsync(
        Booking booking, decimal refunded, decimal penalised, DateTimeOffset attendedAt, CancellationToken ct)
    {
        var user = await _db.Users.FirstOrDefaultAsync(u => u.Id == booking.UserId, ct);
        var court = await _db.Courts.FirstOrDefaultAsync(c => c.Id == booking.CourtId, ct);
        var courtName = court?.Name ?? "a court";

        if (user is null)
        {
            _logger.LogInformation("No-show reversal of {BookingId} has no subject to notify — anonymised or removed", booking.Id);
        }
        else
        {
            try
            {
                await _email.SendAsync(NoShowReversedEmail(user.Email, courtName, refunded, penalised), ct);
            }
            catch (Exception ex) { _logger.LogWarning(ex, "No-show reversal email failed for {BookingId}", booking.Id); }
        }

        await _bus.EmitAsync(new DomainEvent(
            Id: $"evt_{Guid.NewGuid():N}",
            Type: "booking.no_show_reversed",
            TenantId: _tenant.TenantId, TenantSlug: _tenant.TenantSlug,
            OccurredAt: DateTimeOffset.UtcNow, ActorUserId: null, ActorIsAdmin: false, SubjectUserId: booking.UserId,
            Data: new()
            {
                ["booking_id"] = booking.Id,
                ["court_id"] = booking.CourtId,
                ["court_number"] = court?.CourtNumber,
                ["user_id"] = booking.UserId,
                ["penalty_credits"] = penalised,
                ["refund_credits"] = refunded,
                ["attended_at"] = attendedAt,
            }), ct);
    }

    // Block body, not an expression body — lizard mis-scopes an expression-bodied member
    // containing braces; see memory/gotchas.md.
    private static Email.EmailMessage NoShowReversedEmail(string to, string courtName, decimal refunded, decimal penalised)
    {
        return new Email.EmailMessage(
            To: to,
            Subject: $"No-show reversed — {courtName}",
            HtmlBody:
                $"""
                <div style="font-family:Figtree,sans-serif;color:#0F172A;max-width:560px">
                  <h2 style="margin:0 0 12px">You were there after all</h2>
                  <p>Your booking on {courtName} was marked as a no-show, but the court's check-in reached us afterwards.</p>
                  <p>The no-show refund of <strong>{refunded:0.00} credits</strong> has been reversed and the penalty of <strong>{penalised:0.00} credits</strong> returned. The booking now stands as attended.</p>
                </div>
                """);
    }

    /// <summary>
    /// Settles who pays, at the moment somebody identifies at the court.
    ///
    /// <para>
    /// Under charge-at-booking the debit has normally already happened, so this is usually
    /// a no-op returning <see cref="ChargeResult.AlreadyCharged"/>. It still has two real
    /// jobs.
    /// </para>
    ///
    /// <para>
    /// <b>Payer reassignment (blueprint B.2).</b> Someone else presses "I'll pay" at the
    /// touchpad. The booker has already been debited, so honouring that means refunding
    /// them and charging the volunteer — two movements, both posted in full, because a
    /// ledger that nets them cannot answer who actually paid for the court.
    /// </para>
    ///
    /// <para>
    /// <b>An uncharged booking.</b> A walk-up created at the court, or a booking made
    /// before this behaviour changed. Charged here as it always was.
    /// </para>
    /// </summary>
    public async Task<ChargeResult> ChargeOnActivationAsync(Guid bookingId, Guid? payerOverrideUserId, Guid actorUserId, CancellationToken ct)
    {
        var booking = await _db.Bookings.FirstOrDefaultAsync(b => b.Id == bookingId, ct);
        if (booking is null || booking.UserId is null) return new ChargeResult.NotFound();
        if (booking.Status != BookingStatus.Booked && booking.Status != BookingStatus.Completed) return new ChargeResult.NotChargeable();

        var currentPayer = booking.PaidByUserId ?? booking.UserId.Value;
        var court = await _db.Courts.FirstAsync(c => c.Id == booking.CourtId, ct);

        if (booking.ChargedAt is not null)
        {
            var reassignTo = payerOverrideUserId;

            // Nobody volunteered, or the volunteer is already the payer. Idempotent.
            if (reassignTo is null || reassignTo == currentPayer)
            {
                return new ChargeResult.AlreadyCharged(booking.AmountChargedCredits);
            }

            // The volunteer is about to be debited, so the volunteer is who is locked —
            // the balance read below is an unlocked SUM otherwise, and two scans at two
            // courts naming the same volunteer both saw enough and both charged (the same
            // race CommitAsync closes for a booker). The booker's refund needs no lock:
            // credit never overspends. The advisory lock is per transaction and reentrant
            // within it, so a caller already holding a lock on this payer — the walk-up
            // path commits and releases the booker's before activating, but a future
            // caller that does not would simply nest — cannot deadlock against itself.
            await using var volunteerLock = await PayerLock.BeginAsync(_db, _tenant.TenantId, reassignTo.Value, ct);

            var volunteerBalance = await _ledger.GetBalanceAsync(reassignTo.Value, ct);
            if (volunteerBalance < booking.AmountChargedCredits)
            {
                // Refuse rather than half-apply. Refunding the booker first and then
                // discovering the volunteer cannot pay would leave the court unpaid for.
                return new ChargeResult.InsufficientBalance(
                    reassignTo.Value, volunteerBalance, booking.AmountChargedCredits);
            }

            booking.PaidByUserId = reassignTo.Value;

            _db.AuditLogs.Add(new AuditLog
            {
                TenantId = _tenant.TenantId,
                ActorUserId = actorUserId,
                SubjectUserId = reassignTo.Value,
                Action = "booking.payer_reassigned",
                DetailsJson = System.Text.Json.JsonSerializer.Serialize(new
                {
                    booking_id = booking.Id,
                    from_user_id = currentPayer,
                    to_user_id = reassignTo.Value,
                    amount_credits = booking.AmountChargedCredits,
                }),
            });

            // Refund, charge and the field recording who now pays, in ONE save.
            //
            // These were three independent commits, and the failure mode was not exotic: all
            // three took the HTTP request's cancellation token, so a courtside client
            // disconnecting between the first and the second was enough. That left the booker
            // refunded, the volunteer charged nothing, and PaidByUserId still the booker — a
            // court played for free.
            //
            // Worse, it was not idempotent. On a rescan with the same volunteer, the
            // guard above compares reassignTo against a currentPayer that the failed attempt
            // never committed, so it looked like a fresh reassignment: the booker was
            // refunded a SECOND time. Over the two attempts they netted 200 credits from
            // nothing against a single charge. Two concurrent scans carrying the same payer
            // produced the same result with no failure at all, both reading state the other
            // had not committed yet.
            //
            // One save closes both: the guard now reads committed state, and the concurrency
            // token on Booking means the second of two racing scans matches nothing and
            // throws rather than posting a second pair.
            var slotLabel = await SlotLabelAsync(booking, ct);
            try
            {
                await _ledger.PostManyAsync(
                [
                    new LedgerPosting(
                        UserId: currentPayer,
                        Type: LedgerEntryType.CancellationRefund,
                        AmountCredits: booking.AmountChargedCredits,
                        ActorUserId: actorUserId,
                        RelatedBookingId: booking.Id,
                        Reason: $"Payer changed at court — refunded, {court.Name} {slotLabel}"),
                    new LedgerPosting(
                        UserId: reassignTo.Value,
                        Type: LedgerEntryType.BookingCharge,
                        AmountCredits: -booking.AmountChargedCredits,
                        ActorUserId: actorUserId,
                        RelatedBookingId: booking.Id,
                        Reason: $"Paid at court on behalf of another member — {court.Name} {slotLabel}"),
                ], ct);
            }
            catch (DbUpdateConcurrencyException)
            {
                // Not committed: disposing the lock rolls the transaction back.
                _logger.LogInformation("Payer reassignment on {BookingId} lost a concurrent write", booking.Id);
                return new ChargeResult.NotChargeable();
            }

            await volunteerLock.CommitAsync(ct);
            return new ChargeResult.Ok(booking, reassignTo.Value, booking.AmountChargedCredits);
        }

        // Never charged: a walk-up, or a booking predating charge-at-booking.
        var payerUserId = payerOverrideUserId ?? currentPayer;

        // Locked for the same reason CommitAsync locks the booker: the balance read is an
        // unlocked SUM, and a member with one booking's worth of credits holding two
        // uncharged bookings could otherwise have both activated at once and finish
        // negative. Same reentrancy note as the volunteer lock above. A refusal below
        // returns without committing, which rolls back — nothing to unwind.
        await using var payerLock = await PayerLock.BeginAsync(_db, _tenant.TenantId, payerUserId, ct);

        var balance = await _ledger.GetBalanceAsync(payerUserId, ct);
        if (balance < booking.AmountChargedCredits)
            return new ChargeResult.InsufficientBalance(payerUserId, balance, booking.AmountChargedCredits);

        await _ledger.PostAsync(new LedgerPosting(
            UserId: payerUserId,
            Type: LedgerEntryType.BookingCharge,
            AmountCredits: -booking.AmountChargedCredits,
            ActorUserId: actorUserId,
            RelatedBookingId: booking.Id,
            Reason: $"Booking {court.Name} {await SlotLabelAsync(booking, ct)}"), ct);

        booking.PaidByUserId = payerUserId;
        booking.ChargedAt = DateTimeOffset.UtcNow;

        _db.AuditLogs.Add(new AuditLog
        {
            TenantId = _tenant.TenantId,
            ActorUserId = actorUserId,
            SubjectUserId = payerUserId,
            Action = payerOverrideUserId is not null ? "booking.charged_by_payer_override" : "booking.charged",
            DetailsJson = System.Text.Json.JsonSerializer.Serialize(new { booking_id = booking.Id, payer_user_id = payerUserId, amount_credits = booking.AmountChargedCredits }),
        });

        await _db.SaveChangesAsync(ct);
        await payerLock.CommitAsync(ct);
        return new ChargeResult.Ok(booking, payerUserId, booking.AmountChargedCredits);
    }

    // ---- helpers ----

    /// <summary>
    /// The database's verdict on a slot collision, as distinct from every other reason a
    /// save can fail. Matched on the constraint name rather than on SQLSTATE 23P01 alone:
    /// a future exclusion constraint on some other table must not be read as "slot taken".
    /// Falls back to the SQLSTATE when the driver gives no name.
    /// </summary>
    private const string OverlapConstraintName = "ck_bookings_no_overlapping_slot";

    /// <summary>
    /// The most slices one booking may span — a day's worth at the default 15-minute slice.
    ///
    /// <para>
    /// An upper bound as well as a lower one, because an enormous count is the same defect
    /// as a negative one wearing a different hat: it walks straight past the per-day cap for
    /// an admin actor and prices a court in the millions. The real limit on a member is
    /// <c>member_per_day_max_minutes</c>; this is the outer wall that keeps the arithmetic
    /// sane for everyone, admins included.
    /// </para>
    /// </summary>
    private const int MaxSlicesPerBooking = 96;

    private static bool IsOverlapViolation(DbUpdateException ex) =>
        ex.InnerException is Npgsql.PostgresException pg
        && pg.SqlState == "23P01"
        && (string.IsNullOrEmpty(pg.ConstraintName) || pg.ConstraintName == OverlapConstraintName);

    /// <summary>
    /// The filtered unique index on <c>ledger_entries.ExternalReference</c>, as named by the
    /// migration. Matched on the name so a unique violation on some other table in the same
    /// flush — an access code, say — is not read as a duplicate purchase.
    /// </summary>
    private const string ExternalReferenceIndexName = "IX_ledger_entries_ExternalReference";

    private static bool IsDuplicateReference(DbUpdateException ex) =>
        ex.InnerException is Npgsql.PostgresException pg
        && pg.SqlState == "23505"
        && pg.ConstraintName == ExternalReferenceIndexName;

    /// <summary>
    /// Refuses court time the club is not open for.
    ///
    /// <para>
    /// Both ends are checked against the LOCAL day the booking starts on, so a booking
    /// that runs past close is refused rather than silently truncated — the member asked
    /// for an hour and half of it does not exist. A booking that would cross local
    /// midnight fails the same test, because its end lands past that day's close.
    /// </para>
    /// </summary>
    private static BookingResult? CheckOperatingHoursRule(DateTimeOffset startsAt, DateTimeOffset endsAt, TenantSettingsView settings)
    {
        var tz = ResolveTz(settings.Timezone);
        var localStart = TimeZoneInfo.ConvertTimeFromUtc(startsAt.UtcDateTime, tz);
        var localEnd = TimeZoneInfo.ConvertTimeFromUtc(endsAt.UtcDateTime, tz);
        var (openMinute, closeMinute) = settings.HoursFor(localStart.DayOfWeek);

        var startMinute = (localStart.Hour * 60) + localStart.Minute;
        var endMinute = startMinute + (int)Math.Round((localEnd - localStart).TotalMinutes);

        if (startMinute >= openMinute && endMinute <= closeMinute) return null;
        return new BookingResult.OutOfHours(MinutesToHhmm(openMinute), MinutesToHhmm(closeMinute));
    }

    /// <summary>Minutes past midnight as <c>HH:mm</c> — the form the member is shown.</summary>
    internal static string MinutesToHhmm(int minutes)
    {
        var clamped = Math.Clamp(minutes, 0, 24 * 60);
        return $"{clamped / 60:D2}:{clamped % 60:D2}";
    }

    /// <summary>The club's open window for the local day containing <paramref name="at"/>, as UTC instants plus the local labels to show.</summary>
    private sealed record OpenWindow(DateTimeOffset OpensAtUtc, DateTimeOffset ClosesAtUtc, string OpensAtLocal, string ClosesAtLocal);

    private static OpenWindow OpenWindowUtc(DateTimeOffset at, TenantSettingsView settings)
    {
        var tz = ResolveTz(settings.Timezone);
        var local = TimeZoneInfo.ConvertTimeFromUtc(at.UtcDateTime, tz);
        var (openMinute, closeMinute) = settings.HoursFor(local.DayOfWeek);
        var midnightUtc = TimeZoneInfo.ConvertTimeToUtc(DateTime.SpecifyKind(local.Date, DateTimeKind.Unspecified), tz);
        var midnight = new DateTimeOffset(midnightUtc, TimeSpan.Zero);
        return new OpenWindow(
            midnight.AddMinutes(openMinute), midnight.AddMinutes(closeMinute),
            MinutesToHhmm(openMinute), MinutesToHhmm(closeMinute));
    }

    private static BookingResult? CheckPeakHoursRule(DateTimeOffset startsAt, DateTimeOffset endsAt, MemberClass memberClass, TenantSettingsView settings)
    {
        if (memberClass == MemberClass.LeagueOrSenior) return null;
        var peak = settings.PeakHours();
        if (peak is null) return null;
        var (pStart, pEnd) = peak.Value;

        // Convert to tenant-local time. If timezone is malformed, fall back to UTC.
        TimeZoneInfo tz;
        try { tz = TimeZoneInfo.FindSystemTimeZoneById(settings.Timezone); }
        catch { tz = TimeZoneInfo.Utc; }
        var local = TimeZoneInfo.ConvertTimeFromUtc(startsAt.UtcDateTime, tz);
        var slotStart = TimeOnly.FromDateTime(local);
        var inPeak = slotStart >= pStart && slotStart < pEnd;
        if (!inPeak) return null;

        // Regular members inside peak: only allowed within the last <peak_advance_hours_for_regular> hours before slot start.
        var hoursUntil = (startsAt - DateTimeOffset.UtcNow).TotalHours;
        if (hoursUntil > settings.PeakAdvanceHoursForRegular)
            return new BookingResult.PeakHoursLeagueOnly(pStart.ToString("HH:mm"), pEnd.ToString("HH:mm"), settings.PeakAdvanceHoursForRegular);
        return null;
    }

    private async Task<BookingResult?> CheckPerDayCapAsync(Guid userId, DateTimeOffset startsAt, DateTimeOffset endsAt, TenantSettingsView settings, CancellationToken ct)
    {
        if (settings.MemberPerDayMaxMinutes <= 0) return null;

        // Compute the local-day window for the booking's start.
        TimeZoneInfo tz;
        try { tz = TimeZoneInfo.FindSystemTimeZoneById(settings.Timezone); }
        catch { tz = TimeZoneInfo.Utc; }

        var localDay = TimeZoneInfo.ConvertTimeFromUtc(startsAt.UtcDateTime, tz).Date;
        // Build the local-day window in UTC — Npgsql requires offset 0 for timestamptz parameters.
        var localDayStartUtc = TimeZoneInfo.ConvertTimeToUtc(DateTime.SpecifyKind(localDay, DateTimeKind.Unspecified), tz);
        var localDayStart = new DateTimeOffset(localDayStartUtc, TimeSpan.Zero);
        var localDayEnd = localDayStart.AddDays(1);

        var existing = await _db.Bookings
            .Where(b => b.UserId == userId
                && b.Status != BookingStatus.Cancelled
                && b.StartsAt < localDayEnd && b.EndsAt > localDayStart)
            .ToListAsync(ct);

        var minutesAlreadyBooked = existing.Sum(b => (b.EndsAt - b.StartsAt).TotalMinutes);
        var thisBookingMinutes = (endsAt - startsAt).TotalMinutes;
        if (minutesAlreadyBooked + thisBookingMinutes <= settings.MemberPerDayMaxMinutes) return null;

        // Same-day relaxation per B.3: if the slot starts today AND there's no other booking on that
        // court for the same window, the cap doesn't block it. (We've already done the overlap check.)
        var bookingLocalDay = TimeZoneInfo.ConvertTimeFromUtc(startsAt.UtcDateTime, tz).Date;
        var todayLocal = TimeZoneInfo.ConvertTimeFromUtc(DateTimeOffset.UtcNow.UtcDateTime, tz).Date;
        if (bookingLocalDay == todayLocal) return null;

        return new BookingResult.PerDayCapExceeded(
            CapMinutes: settings.MemberPerDayMaxMinutes,
            AlreadyBookedMinutes: (int)Math.Round(minutesAlreadyBooked),
            AttemptedMinutes: (int)Math.Round(thisBookingMinutes));
    }

    private static TimeZoneInfo ResolveTz(string id)
    {
        try { return TimeZoneInfo.FindSystemTimeZoneById(id); }
        catch { return TimeZoneInfo.Utc; }
    }

    /// <summary>
    /// The receipt PDF that rides on the booking confirmation, per spec §11.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Never throws. A receipt that could not be built — a member row that has moved, a tenant
    /// display name that is not there — must not turn a completed, charged booking into a failed
    /// request, and must not cost the member the confirmation email either. The booking is
    /// already committed by the time this runs; the worst outcome available here is a
    /// confirmation with nothing attached, and that is strictly better than the alternatives.
    /// </para>
    /// <para>
    /// The reference on the receipt is the booking id, because that is the identifier a member
    /// can be asked for and the one the ledger row already carries — a receipt whose number
    /// matches nothing in the ledger cannot settle the dispute it exists for.
    /// </para>
    /// </remarks>
    private async Task<Email.EmailAttachment?> BuildReceiptAsync(
        Domain.Booking booking, Email.BookingConfirmationDetails details, Guid userId, CancellationToken ct)
    {
        try
        {
            var membership = await _db.Memberships.FirstOrDefaultAsync(m => m.UserId == userId, ct);
            var tenant = await _db.Tenants.IgnoreQueryFilters()
                .FirstOrDefaultAsync(t => t.Id == _tenant.TenantId, ct);

            var pdf = Email.ReceiptPdf.ForBooking(
                clubName: tenant?.DisplayName ?? "Crusaders Mainframe",
                memberName: membership?.FullName ?? "Member",
                bookingReference: booking.Id.ToString(),
                courtName: details.CourtName,
                startsAtLocal: details.StartsAtLocal,
                duration: details.Duration,
                amountCredits: details.AmountCredits,
                balanceAfterCredits: details.BalanceAfterCredits,
                issuedAt: DateTimeOffset.UtcNow);

            return new Email.EmailAttachment($"receipt-{booking.Id:N}.pdf", "application/pdf", pdf);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Could not build the receipt for booking {BookingId}; sending the confirmation without it", booking.Id);
            return null;
        }
    }

    /// <summary>
    /// A booking's slot, in the club's own wall clock, for a ledger comment.
    ///
    /// <para>
    /// Every ledger <c>Reason</c> formatted <c>booking.StartsAt</c> straight out of the
    /// UTC <c>DateTimeOffset</c>, so the one line a member reads when disputing a charge
    /// named a slot two hours away from the one they booked — "Booking Court 3 2026-09-16
    /// 08:00" for a 10:00 court — while the confirmation email beside it, the grid and the
    /// wallet's own Time column all said 10:00. The tenant's timezone was already being
    /// resolved correctly four lines away for the email.
    /// </para>
    ///
    /// <para>
    /// Invariant culture with it: the comment column also carried the server process's
    /// ambient separator, so one row could read "−15.00 cr" beside "penalty 30,0%".
    /// </para>
    /// </summary>
    private static string SlotLabel(Booking booking, TenantSettingsView settings) =>
        TimeZoneInfo.ConvertTimeFromUtc(booking.StartsAt.UtcDateTime, ResolveTz(settings.Timezone))
            .ToString("yyyy-MM-dd HH:mm", System.Globalization.CultureInfo.InvariantCulture);

    /// <summary>
    /// <see cref="SlotLabel"/> where the caller has no settings in hand. One extra read on
    /// paths that are already doing several.
    /// </summary>
    private async Task<string> SlotLabelAsync(Booking booking, CancellationToken ct) =>
        SlotLabel(booking, await _settings.GetAsync(ct));

    // Fire-and-forget email dispatch. IEmailService is registered as singleton so the captured
    // reference outlives the request scope safely. Errors are swallowed and logged.
    private void SendEmailInBackground(Email.EmailMessage message, string context)
    {
        var email = _email;
        var logger = _logger;
        _ = Task.Run(async () =>
        {
            try { await email.SendAsync(message, CancellationToken.None); }
            catch (Exception ex) { logger.LogWarning(ex, "Background email send failed ({Context})", context); }
        });
    }
}

/// <summary>
/// Who a booking is charged to, who is making it, and whether the desk has explicitly
/// authorised pushing that member below zero.
/// </summary>
/// <param name="UserId">The member whose credit pays and whose booking it is.</param>
/// <param name="ActorId">
/// Who pressed the button. Equal to <paramref name="UserId"/> for a member's own booking;
/// the admin's id when the club desk is acting for somebody. The difference is what
/// <c>BookingService</c> reads as "this is an on-behalf booking".
/// </param>
/// <param name="AllowNegativeBalance">
/// <c>feature-spec.md</c> §8's admin override, asked for by name. It is honoured only when
/// <paramref name="ActorId"/> differs from <paramref name="UserId"/>, so it can never
/// overdraw the actor's own wallet, and it defaults to <c>false</c> so no existing caller
/// acquires it by accident.
/// </param>
public readonly record struct BookingPayer(Guid UserId, Guid ActorId, bool AllowNegativeBalance = false);

public abstract record BookingResult
{
    public sealed record Ok(Booking Booking, decimal BalanceAfterCredits) : BookingResult;
    public sealed record NotFound : BookingResult;
    public sealed record PastTime : BookingResult;
    public sealed record TooFarAhead : BookingResult;
    public sealed record SlotTaken : BookingResult;
    public sealed record InsufficientBalance(decimal CurrentCredits, decimal RequiredCredits) : BookingResult;
    public sealed record PeakHoursLeagueOnly(string PeakStart, string PeakEnd, int RegularAdvanceHours) : BookingResult;

    /// <summary>The club is shut for the whole or part of the requested window. Carries that day's hours so the member is told when to come back.</summary>
    public sealed record OutOfHours(string OpensAt, string ClosesAt) : BookingResult;
    public sealed record PerDayCapExceeded(int CapMinutes, int AlreadyBookedMinutes, int AttemptedMinutes) : BookingResult;

    /// <summary>
    /// A walk-up truncated to nothing — the next booking starts now, or the request was for
    /// no time at all. Distinct from <see cref="SlotTaken"/>, which means someone is already
    /// playing: the court box has to say "court free at 18:00", not "court busy".
    /// </summary>
    public sealed record NoTimeAvailable(int RequestedMinutes, int AvailableMinutes) : BookingResult;

    /// <summary>
    /// The requested slice count is not a length a booking can have. Zero, negative, or past
    /// the outer wall.
    /// </summary>
    public sealed record InvalidDuration(int RequestedSlices, int MaxSlices) : BookingResult;

    /// <summary>
    /// A purchase carrying an external reference that another request has already posted
    /// — the concurrent half of a walk-up retry. Nothing was written; the caller re-reads
    /// the reference and answers with the original grant.
    /// </summary>
    public sealed record DuplicateRequest : BookingResult;
}

/// <summary>
/// What a cancellation would cost right now, in figures, so the member reads the number
/// before they tap rather than the ledger afterwards.
/// </summary>
/// <param name="RefundCredits">What actually lands back in the wallet — the refund NET of the penalty, which is the only figure a member can check against their balance.</param>
/// <param name="PenaltyCredits">What is kept. Reported separately because the ledger posts it as its own row and a dispute asks for it by name.</param>
/// <param name="CheckedIn">The lights have been on. Nothing comes back; <paramref name="RefundCredits"/> is zero and the copy must say why.</param>
public sealed record CancellationQuote(
    Guid BookingId,
    decimal AmountChargedCredits,
    decimal RefundCredits,
    decimal PenaltyCredits,
    decimal PenaltyPct,
    int PenaltyWindowMinutes,
    bool InsidePenaltyWindow,
    bool CheckedIn,
    bool AlreadyStarted);

public abstract record CancellationResult
{
    public sealed record Ok(decimal RefundedCredits, decimal PenaltyCredits) : CancellationResult;
    public sealed record NotFound : CancellationResult;
    public sealed record AlreadyStarted : CancellationResult;
}

/// <summary>What became of a late-attendance reversal. See <c>BookingService.ReverseNoShowAsync</c>.</summary>
public abstract record NoShowReversalResult
{
    /// <summary>
    /// Reversed: the refund debited back and the penalty credited back, the row <c>Booked</c>
    /// and checked in. Both amounts are zero when an admin had already compensated the
    /// member by hand (<see cref="ManuallyCompensated"/>) — attendance is restored, money
    /// is not moved twice. <see cref="DisplacedBookingIds"/> names the later bookings on
    /// the released tail that were cancelled and refunded to make room.
    /// </summary>
    public sealed record Ok(decimal RefundReversedCredits, decimal PenaltyReversedCredits) : NoShowReversalResult
    {
        public IReadOnlyList<Guid> DisplacedBookingIds { get; init; } = [];
        public bool ManuallyCompensated { get; init; }
    }

    /// <summary>The row is not a settled no-show — nothing to reverse. The caller takes the ordinary activation path.</summary>
    public sealed record NotNoShow : NoShowReversalResult;

    /// <summary>A concurrent write decided the row first. Nothing was written; re-read and go again.</summary>
    public sealed record Lost : NoShowReversalResult;
}

/// <summary>
/// What a box's <c>release</c> event changed. See <c>BookingService.SettleReleaseAsync</c>.
/// <c>Code</c> lands on the event's audit row so the desk can see the measurement arriving.
/// </summary>
public sealed record ReleaseSettlement(string Code, decimal AmountCredits, IReadOnlyList<Guid> ReinstatedBookingIds)
{
    /// <summary>Nothing to correct: an ordinary booking, or a measurement that agrees with the grant.</summary>
    public static readonly ReleaseSettlement NotApplicable = new("not_applicable", 0m, []);
}

/// <summary>What became of the lit time on a cancelled booking. See <c>BookingService.ChargeLitCancelledBookingAsync</c>.</summary>
public abstract record CancelledLightsResult
{
    /// <summary>A pro-rata <c>LightsPurchase</c> posted for the lit minutes.</summary>
    public sealed record Charged(decimal AmountCredits, int Minutes) : CancelledLightsResult;

    /// <summary>This booking's lit time was already charged by an earlier event.</summary>
    public sealed record AlreadyCharged : CancelledLightsResult;

    /// <summary>Nothing to charge: not cancelled, cancelled after check-in (no refund was paid), or no tariff.</summary>
    public sealed record NotCharged : CancelledLightsResult;

    /// <summary>
    /// The booking was cancelled by a displacement, not by its member — settlement model I5.
    /// Nothing is owed and nothing is posted; the caller audits the collision, naming
    /// <paramref name="DisplacedByBookingId"/>, so the desk can see two members reached one
    /// court.
    /// </summary>
    public sealed record Displaced(Guid? DisplacedByBookingId) : CancelledLightsResult;
}

public abstract record ChargeResult
{
    public sealed record Ok(Booking Booking, Guid ChargedUserId, decimal AmountCredits) : ChargeResult;
    public sealed record NotFound : ChargeResult;
    public sealed record NotChargeable : ChargeResult;
    public sealed record AlreadyCharged(decimal AmountCredits) : ChargeResult;
    public sealed record InsufficientBalance(Guid PayerUserId, decimal Current, decimal Required) : ChargeResult;
}
