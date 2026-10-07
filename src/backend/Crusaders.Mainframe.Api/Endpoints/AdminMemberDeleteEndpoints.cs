using System.Text.Json.Serialization;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Mvc;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// Deleting a member — "should be able to delete an account, not just suspend it" (Dean,
/// 2026-10-06). Two routes, keyed on the USER id like the member detail they sit on:
///
/// <list type="bullet">
/// <item><c>GET /api/v1/admin/members/{userId}/delete-preview</c> — what a delete would do, for the
/// confirm step: erase or remove, what it would cancel, and the balance the admin would be asked to
/// write off.</item>
/// <item><c>DELETE /api/v1/admin/members/{userId}</c> with <c>{ reason, confirm_balance_write_off }</c>.</item>
/// </list>
///
/// <para>
/// <b>The money moves through the club's own paths, in order, before the account changes</b>: each
/// of the member's bookings that has not started is cancelled as the desk cancels one (penalty
/// waived, refund in full, partners' shares handed back, a <c>booking.cancelled_by_admin</c> row
/// each); each seat they hold on another member's game is taken off as the desk takes one off (their
/// paid share comes back); open package checkouts are closed; and whatever balance is left is
/// written off through the desk's adjustment path, only when the admin has said so by name. Then
/// <see cref="MemberDeletionService"/> erases or removes the account in one save under the club's
/// admin lock. Every step is idempotent, so a retry after a lost reply or a refusal half-way
/// carries on from where the club's books now are, and a delete of an erased member answers 200.
/// </para>
///
/// <para>
/// <b>Each refusal is its own 409</b>: <c>cannot_delete_self</c>, <c>admin_inherited_from_config</c>,
/// <c>last_admin</c>, <c>share_return_uncovered</c> (a partner game whose organiser cannot cover
/// handing their share back — settle that game first), and <c>balance_write_off_required</c> with
/// <c>balance_minutes</c>. Another club's member is <c>404 member_not_found</c>, like every read here.
/// </para>
/// </summary>
public static class AdminMemberDeleteEndpoints
{
    public static IEndpointRouteBuilder MapAdminMemberDeleteEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1/admin/members/{userId:guid}").RequireAuthorization(p => p.RequireRole("admin"));
        g.MapGet("/delete-preview", PreviewAsync);
        g.MapDelete("/", DeleteAsync);
        return app;
    }

    private static Task<MemberDeletionPlan?> PlanAsync(Guid userId, HttpContext ctx, CancellationToken ct)
    {
        var sp = ctx.RequestServices;
        return MemberDeletion.PlanAsync(
            sp.GetRequiredService<MainframeDbContext>(), sp.GetRequiredService<LedgerService>(), sp.GetRequiredService<ShareLedger>(),
            (userId, ctx.User.Id() ?? Guid.Empty, sp.GetRequiredService<InherentAdmins>()), ct);
    }

    // Block bodies throughout: lizard mis-scopes an expression body holding braces (memory/gotchas-gates.md).
    private static IResult NotFound()
    {
        return Results.NotFound(new { error = AdminMemberDetailEndpoints.MemberNotFound });
    }

    private static IResult Conflict(string error)
    {
        return Results.Json(new { error }, statusCode: StatusCodes.Status409Conflict);
    }

    private static string ModeWord(MemberDeletionMode mode)
    {
        return mode == MemberDeletionMode.Erase ? "erase" : "remove";
    }

    /// <summary><c>GET …/delete-preview</c> — what deleting this member would do, read now.</summary>
    public static async Task<IResult> PreviewAsync(Guid userId, HttpContext ctx, CancellationToken ct)
    {
        if (await PlanAsync(userId, ctx, ct) is not { } plan) return NotFound();
        return Results.Ok(new
        {
            user_id = plan.UserId,
            mode = ModeWord(plan.Mode),
            already_deleted = plan.AlreadyDeleted,
            refusal = plan.Refusal,
            future_bookings = plan.FutureBookingIds.Count,
            partner_games = plan.PartnerSeats.Count,
            open_purchases = plan.OpenPurchases,
            balance_minutes = plan.BalanceMinutes,
            write_off_minutes = plan.WriteOffMinutes,
            member_told = plan.TellMember,
        });
    }

    /// <summary><c>DELETE /api/v1/admin/members/{userId}</c> — see the class remarks.</summary>
    public static async Task<IResult> DeleteAsync(Guid userId, [FromBody] DeleteMemberBody? body, HttpContext ctx, CancellationToken ct)
    {
        var reason = body?.Reason?.Trim();
        if (string.IsNullOrEmpty(reason)) return Results.BadRequest(new { error = "reason_required" });
        var confirm = body?.Confirmed == true;

        if (await PlanAsync(userId, ctx, ct) is not { } plan) return NotFound();
        if (BeforeAnything(plan, confirm) is { } early) return early;

        var actor = ctx.User.Id() ?? Guid.Empty;
        var settled = plan.Mode == MemberDeletionMode.Erase
            ? await SettleAsync(plan, (actor, reason, confirm), ctx, ct)
            : (new MemberDeletionOutcome(0, 0, 0, 0), null);
        if (settled.Item2 is { } stopped) return stopped;

        var service = ctx.RequestServices.GetRequiredService<MemberDeletionService>();
        if (await service.CommitAsync(plan, actor, reason, settled.Item1, ct) is { } lockedRefusal) return Conflict(lockedRefusal);

        var notified = plan.TellMember && await TellMemberAsync(ctx, plan, reason, settled.Item1, ct);
        return Answer(plan, settled.Item1, alreadyDeleted: false, memberNotified: notified);
    }

    /// <summary>The answer a delete gets before anything moves: already done, refused, or a write-off not yet agreed.</summary>
    private static IResult? BeforeAnything(MemberDeletionPlan plan, bool confirm)
    {
        if (plan.AlreadyDeleted) return Answer(plan, new MemberDeletionOutcome(0, 0, 0, 0), alreadyDeleted: true, memberNotified: false);
        if (plan.Refusal is { } refusal) return Conflict(refusal);
        var unagreed = plan.Mode == MemberDeletionMode.Erase && plan.WriteOffMinutes != 0 && !confirm;
        return unagreed ? WriteOffRequired(plan.WriteOffMinutes) : null;
    }

    private static IResult WriteOffRequired(int minutes)
    {
        return Results.Json(new { error = MemberDeletion.WriteOffRequired, balance_minutes = minutes }, statusCode: StatusCodes.Status409Conflict);
    }

    private static IResult Answer(MemberDeletionPlan plan, MemberDeletionOutcome did, bool alreadyDeleted, bool memberNotified)
    {
        return Results.Ok(new
        {
            deleted = true,
            user_id = plan.UserId,
            mode = ModeWord(plan.Mode),
            already_deleted = alreadyDeleted,
            bookings_cancelled = did.BookingsCancelled,
            seats_given_up = did.SeatsGivenUp,
            purchases_closed = did.PurchasesClosed,
            written_off_minutes = did.WrittenOffMinutes,
            member_email_queued = memberNotified,
        });
    }

    /// <summary>
    /// Everything that moves money, through the club's own paths, before the account changes. A
    /// refusal half-way stops here and is answered; what already moved stays moved, and the retry
    /// finds it done.
    /// </summary>
    private static async Task<(MemberDeletionOutcome, IResult?)> SettleAsync(
        MemberDeletionPlan plan, (Guid Actor, string Reason, bool Confirm) ask, HttpContext ctx, CancellationToken ct)
    {
        var sp = ctx.RequestServices;
        var cancelled = await CancelBookingsAsync(plan, ask, ctx, ct);

        var seats = 0;
        var players = sp.GetRequiredService<PlayersAdminService>();
        foreach (var seat in plan.PartnerSeats)
        {
            var r = await players.RemoveAsync(new PlayersAdminService.AdminAct(seat.BookingId, seat.SeatId, ask.Actor, ask.Reason), ct);
            if (r.IsOk) seats++;
            else if (r.Error == PlayerErrors.OverdraftNotAuthorised) return (new MemberDeletionOutcome(0, 0, 0, 0), Conflict(MemberDeletion.ShareReturnUncovered));
        }

        var purchases = await TopUpEndpoints.CloseForDeletedMemberAsync(sp.GetRequiredService<MainframeDbContext>(), plan.UserId, ct);

        var balance = await sp.GetRequiredService<LedgerService>().GetBalanceAsync(plan.UserId, ct);
        if (balance != 0 && !ask.Confirm) return (new MemberDeletionOutcome(cancelled, seats, purchases, 0), WriteOffRequired(balance));
        var writtenOff = await WalletEndpoints.WriteOffDeletedMemberAsync(plan.UserId, ask.Reason, ctx, ct);
        return (new MemberDeletionOutcome(cancelled, seats, purchases, writtenOff), null);
    }

    /// <summary>
    /// Cancels each booking as the desk does — the record row staged first so it flushes in the
    /// cancellation's own save, the penalty waived, the partners' shares settled after, one wallet
    /// frame each. A booking somebody else settled in the meantime is simply not counted.
    /// </summary>
    private static async Task<int> CancelBookingsAsync(
        MemberDeletionPlan plan, (Guid Actor, string Reason, bool Confirm) ask, HttpContext ctx, CancellationToken ct)
    {
        var bookings = ctx.RequestServices.GetRequiredService<BookingService>();
        var cancelled = 0;
        foreach (var bookingId in plan.FutureBookingIds)
        {
            var record = await AdminCancelRecord.StageAsync(ctx, bookingId, ask.Actor, ask.Reason, ct);
            await using (BookingEndpoints.OneWalletFrame(ctx, bookingId))
            {
                var result = await bookings.CancelAsync(bookingId, ask.Actor, actorIsAdmin: true, waivePenalty: true, ct, ask.Reason);
                if (result is not CancellationResult.Ok)
                {
                    AdminCancelRecord.Withdraw(ctx, record);
                    continue;
                }
                cancelled++;
                await ctx.AfterSettlementAsync([bookingId], ct);
            }
        }
        return cancelled;
    }

    /// <summary>
    /// The member's own mail, to the address they had — read before it was wiped. A mail that cannot be
    /// queued is reported, never thrown: the deletion has committed. Queued, not sent: delivery is the email outbox's.
    /// </summary>
    private static async Task<bool> TellMemberAsync(
        HttpContext ctx, MemberDeletionPlan plan, string reason, MemberDeletionOutcome did, CancellationToken ct)
    {
        var sp = ctx.RequestServices;
        try
        {
            var club = await sp.GetRequiredService<ClubIdentityResolver>().GetAsync(ct);
            await sp.GetRequiredService<IEmailService>().SendAsync(EmailTemplates.MemberAccountDeleted(club, plan.Email, new MemberDeletedNotice
            {
                SubjectName = plan.FullName ?? plan.Email,
                ActorName = club.Name,
                Reason = reason,
                KeptHistory = plan.Mode == MemberDeletionMode.Erase,
                BookingsCancelled = did.BookingsCancelled,
                WrittenOffMinutes = did.WrittenOffMinutes,
            }), ct);
            return true;
        }
        catch (Exception ex)
        {
            sp.GetRequiredService<ILoggerFactory>().CreateLogger("AdminMemberDelete")
                .LogWarning(ex, "Account-deleted email failed for {UserId}", plan.UserId);
            return false;
        }
    }
}

/// <summary>
/// The delete's body. Both spellings of the write-off confirmation bind, for the reason
/// <c>AdminRoleBody</c> gives: the console's client sends camelCase.
/// </summary>
public sealed class DeleteMemberBody
{
    [JsonPropertyName("reason")] public string? Reason { get; init; }
    [JsonPropertyName("confirm_balance_write_off")] public bool? ConfirmWriteOff { get; init; }
    [JsonPropertyName("confirmBalanceWriteOff")] public bool? ConfirmWriteOffCamel { get; init; }

    /// <summary>Whether the admin agreed to write the balance off, in either spelling.</summary>
    [JsonIgnore] public bool Confirmed => (ConfirmWriteOff ?? ConfirmWriteOffCamel) == true;
}
