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
    private readonly ILogger<BookingService> _logger;

    public BookingService(MainframeDbContext db, ITenantContext tenant, LedgerService ledger, TenantSettingsAccessor settings, IEmailService email, IEventBus bus, ILogger<BookingService> logger)
    { _db = db; _tenant = tenant; _ledger = ledger; _settings = settings; _email = email; _bus = bus; _logger = logger; }

    public async Task<BookingResult> CreateAsync(Guid courtId, Guid userId, Guid actorId, DateTimeOffset startsAt, int sliceCount, CancellationToken ct)
    {
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
        var balance = await _ledger.GetBalanceAsync(userId, ct);
        if (balance < totalCost) return new BookingResult.InsufficientBalance(balance, totalCost);

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
            IsWalkUp: false), ct);
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
    /// </summary>
    public async Task<BookingResult> CreateWalkUpAsync(Guid courtId, Guid userId, Guid actorId, int requestedMinutes, CancellationToken ct)
    {
        var settings = await _settings.GetAsync(ct);
        var court = await _db.Courts.FirstOrDefaultAsync(c => c.Id == courtId && c.IsActive, ct);
        if (court is null) return new BookingResult.NotFound();
        if (requestedMinutes <= 0) return new BookingResult.NoTimeAvailable(requestedMinutes, 0);

        var now = DateTimeOffset.UtcNow;
        var requestedEnd = now.AddMinutes(requestedMinutes);

        // Someone is on the court right now. Not a truncation case — there is no time to
        // sell at all, and saying so is different from selling zero minutes.
        var inProgress = await _db.Bookings.AnyAsync(b =>
            b.CourtId == courtId &&
            b.Status != BookingStatus.Cancelled &&
            b.StartsAt <= now && b.EndsAt > now, ct);
        if (inProgress) return new BookingResult.SlotTaken();

        // Truncate at whoever is next through the door.
        var nextStart = await _db.Bookings
            .Where(b => b.CourtId == courtId
                && b.Status != BookingStatus.Cancelled
                && b.StartsAt > now && b.StartsAt < requestedEnd)
            .OrderBy(b => b.StartsAt)
            .Select(b => (DateTimeOffset?)b.StartsAt)
            .FirstOrDefaultAsync(ct);

        var endsAt = nextStart ?? requestedEnd;

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
            IsWalkUp: true), ct);
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
    private sealed record NewBooking(
        Booking Row, Court Court, TenantSettingsView Settings,
        decimal TotalCost, string DurationLabel, bool IsWalkUp);

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
        if (openingBalance < spec.TotalCost)
        {
            // Detached, not left tracked: the row was built optimistically and this request
            // is over. Leaving it attached would have the next SaveChanges on this context
            // insert a booking nobody paid for.
            _db.Entry(booking).State = EntityState.Detached;
            return new BookingResult.InsufficientBalance(openingBalance, spec.TotalCost);
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
                Reason: $"Booking {court.Name} {booking.StartsAt:yyyy-MM-dd HH:mm}"), ct);
        }
        catch (DbUpdateException ex) when (IsOverlapViolation(ex))
        {
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
            Action = AuditActionFor(spec, actorId, userId),
            DetailsJson = System.Text.Json.JsonSerializer.Serialize(new
            {
                booking_id = booking.Id,
                court = court.Name,
                starts_at = booking.StartsAt,
                slice_count = booking.SliceCount,
                minutes = booking.SliceMinutes * booking.SliceCount,
                amount_credits = spec.TotalCost,
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
        // Build the message in the request scope; dispatch in the background so SMTP latency
        // (Mailhog/EHLO can take seconds) does not block the booking response.
        var confirmationMsg = EmailTemplates.BookingConfirmation(
            user.Email, court.Name,
            TimeZoneInfo.ConvertTimeFromUtc(booking.StartsAt.UtcDateTime, ResolveTz(settings.Timezone)).ToString("ddd dd MMM HH:mm"),
            spec.DurationLabel,
            spec.TotalCost, balance);
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

    private static string AuditActionFor(NewBooking spec, Guid actorId, Guid userId)
    {
        if (spec.IsWalkUp) return "booking.walk_up_created";
        return actorId == userId ? "booking.created" : "booking.created_on_behalf";
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
                Reason: $"Late-cancellation penalty {settings.PenaltyPct}%"));
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
                        Reason: $"Payer changed at court — refunded, {court.Name} {booking.StartsAt:yyyy-MM-dd HH:mm}"),
                    new LedgerPosting(
                        UserId: reassignTo.Value,
                        Type: LedgerEntryType.BookingCharge,
                        AmountCredits: -booking.AmountChargedCredits,
                        ActorUserId: actorUserId,
                        RelatedBookingId: booking.Id,
                        Reason: $"Paid at court on behalf of another member — {court.Name} {booking.StartsAt:yyyy-MM-dd HH:mm}"),
                ], ct);
            }
            catch (DbUpdateConcurrencyException)
            {
                _logger.LogInformation("Payer reassignment on {BookingId} lost a concurrent write", booking.Id);
                return new ChargeResult.NotChargeable();
            }

            return new ChargeResult.Ok(booking, reassignTo.Value, booking.AmountChargedCredits);
        }

        // Never charged: a walk-up, or a booking predating charge-at-booking.
        var payerUserId = payerOverrideUserId ?? currentPayer;

        var balance = await _ledger.GetBalanceAsync(payerUserId, ct);
        if (balance < booking.AmountChargedCredits)
            return new ChargeResult.InsufficientBalance(payerUserId, balance, booking.AmountChargedCredits);

        await _ledger.PostAsync(new LedgerPosting(
            UserId: payerUserId,
            Type: LedgerEntryType.BookingCharge,
            AmountCredits: -booking.AmountChargedCredits,
            ActorUserId: actorUserId,
            RelatedBookingId: booking.Id,
            Reason: $"Booking {court.Name} {booking.StartsAt:yyyy-MM-dd HH:mm}"), ct);

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

public abstract record BookingResult
{
    public sealed record Ok(Booking Booking, decimal BalanceAfterCredits) : BookingResult;
    public sealed record NotFound : BookingResult;
    public sealed record PastTime : BookingResult;
    public sealed record TooFarAhead : BookingResult;
    public sealed record SlotTaken : BookingResult;
    public sealed record InsufficientBalance(decimal CurrentCredits, decimal RequiredCredits) : BookingResult;
    public sealed record PeakHoursLeagueOnly(string PeakStart, string PeakEnd, int RegularAdvanceHours) : BookingResult;
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
}

public abstract record CancellationResult
{
    public sealed record Ok(decimal RefundedCredits, decimal PenaltyCredits) : CancellationResult;
    public sealed record NotFound : CancellationResult;
    public sealed record AlreadyStarted : CancellationResult;
}

public abstract record ChargeResult
{
    public sealed record Ok(Booking Booking, Guid ChargedUserId, decimal AmountCredits) : ChargeResult;
    public sealed record NotFound : ChargeResult;
    public sealed record NotChargeable : ChargeResult;
    public sealed record AlreadyCharged(decimal AmountCredits) : ChargeResult;
    public sealed record InsufficientBalance(Guid PayerUserId, decimal Current, decimal Required) : ChargeResult;
}
