using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// How a member is deleted, decided by whether the club's books mention them.
/// </summary>
public enum MemberDeletionMode
{
    /// <summary>Nothing on the ledger, no booking, no seat, no purchase: every row of theirs goes.</summary>
    Remove,

    /// <summary>
    /// They have history the club's ledger, reports and bookings must keep balancing over: the rows
    /// stay, everything that identifies the person is wiped, and the account can never sign in.
    /// </summary>
    Erase,
}

/// <summary>One live seat the member holds on somebody else's game that has not started.</summary>
public readonly record struct MemberDeletionSeat(Guid BookingId, Guid SeatId, int PaidMinutes);

/// <summary>
/// What deleting one member would do, read before anything is done — the console's confirm step
/// shows it, and the delete itself acts on it.
/// </summary>
public sealed record MemberDeletionPlan
{
    public required Guid UserId { get; init; }
    public Guid? MembershipId { get; init; }
    public string? FullName { get; init; }
    public required string Email { get; init; }
    public MembershipStatus? Status { get; init; }
    public bool EmailVerified { get; init; }
    public bool IsAdmin { get; init; }
    public required MemberDeletionMode Mode { get; init; }

    /// <summary>Already erased: a second delete answers as the first did and changes nothing.</summary>
    public bool AlreadyDeleted { get; init; }

    /// <summary>Why the club may not delete this account, or null when it may. A <see cref="MemberDeletion"/> code.</summary>
    public string? Refusal { get; init; }

    /// <summary>The member's own bookings that have not started — each cancelled with a full refund.</summary>
    public IReadOnlyList<Guid> FutureBookingIds { get; init; } = [];

    /// <summary>Their live seats on other members' games that have not started — each taken off by the club.</summary>
    public IReadOnlyList<MemberDeletionSeat> PartnerSeats { get; init; } = [];

    /// <summary>Package purchases still open at the gateway — each closed.</summary>
    public int OpenPurchases { get; init; }

    /// <summary>The balance now.</summary>
    public int BalanceMinutes { get; init; }

    /// <summary>
    /// What the balance will be once the refunds and share returns above have posted — what the
    /// admin is asked to write off. A projection: the delete measures it again after the refunds.
    /// </summary>
    public int WriteOffMinutes { get; init; }

    /// <summary>Whether they are told by mail: only a member the club had admitted, at an address they confirmed.</summary>
    public bool TellMember => Status == MembershipStatus.Active && EmailVerified;
}

/// <summary>
/// The rules of deleting a member: who may not be deleted, and whether their rows can go or must
/// be erased in place. <see cref="MemberDeletionService"/> carries them out.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why two modes.</b> Money is ledger-only and a balance is the sum of the member's rows, so a
/// member with a single ledger row cannot simply be deleted: the club's reports, its revenue and
/// every partner's share history would stop adding up. Such a member is ERASED — their name, email,
/// photo and every credential are wiped and the account becomes a terminal <c>Deleted</c> state —
/// while an applicant who never transacted leaves nothing behind at all.
/// </para>
/// <para>
/// <b>History is anything another row points at</b>: the ledger (as the member or as the actor),
/// a booking they made, own or paid for, a seat or an invitation, a package purchase, a match result,
/// a pay-for at a box, or an entry on the club's change record they made as an administrator.
/// </para>
/// </remarks>
public static class MemberDeletion
{
    /// <summary>The audit verb. Its Night word is <c>TraceKinds.AccountDeleted</c>.</summary>
    public const string DeletedAction = "member.deleted";

    /// <summary>What an erased member is called everywhere — reports, the ledger, other members' games.</summary>
    public const string DeletedName = "Deleted member";

    // ---- refusals, each its own 409 ----
    public const string CannotDeleteSelf = "cannot_delete_self";
    public const string InheritedFromConfig = "admin_inherited_from_config";
    public const string LastAdmin = "last_admin";
    public const string ShareReturnUncovered = "share_return_uncovered";
    public const string WriteOffRequired = "balance_write_off_required";

    /// <summary>
    /// The address an erased account keeps: unique, so the users index holds, and on <c>.invalid</c>
    /// (RFC 2606), which no mail server will ever accept — so the person's real address is free to
    /// register again and nothing can be sent to the tombstone.
    /// </summary>
    public static string TombstoneEmail(Guid userId) => $"deleted-{userId:N}@deleted.invalid";

    /// <summary>The membership number an erased member keeps — unique, and frees the real one.</summary>
    public static string TombstoneNumber(Guid membershipId) => $"deleted-{membershipId:N}";

    /// <summary>What deleting this member would do now, or null when the club has no such account.</summary>
    public static async Task<MemberDeletionPlan?> PlanAsync(
        MainframeDbContext db, LedgerService ledger, ShareLedger shares, (Guid UserId, Guid ActorId, InherentAdmins Inherent) who,
        CancellationToken ct)
    {
        var userId = who.UserId;
        var user = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Id == userId, ct);
        if (user is null) return null;
        var membership = await db.Memberships.AsNoTracking().FirstOrDefaultAsync(m => m.UserId == userId, ct);

        var plan = new MemberDeletionPlan
        {
            UserId = userId,
            MembershipId = membership?.Id,
            FullName = membership?.FullName,
            Email = user.Email,
            Status = membership?.Status,
            EmailVerified = user.EmailVerified,
            IsAdmin = user.IsAdmin,
            Mode = await HasHistoryAsync(db, userId, ct) ? MemberDeletionMode.Erase : MemberDeletionMode.Remove,
            AlreadyDeleted = membership?.Status == MembershipStatus.Deleted || user.Status == UserStatuses.Deleted,
        };
        if (plan.AlreadyDeleted) return plan;

        var refusal = await RefusalAsync(db, user, who.ActorId, who.Inherent, ct);
        if (plan.Mode == MemberDeletionMode.Remove) return plan with { Refusal = refusal };
        return await WithMoneyAsync(db, (ledger, shares), plan, refusal, ct);
    }

    /// <summary>An erase's money: the bookings it cancels, the seats it gives up, the purchases it closes and the write-off.</summary>
    private static async Task<MemberDeletionPlan> WithMoneyAsync(
        MainframeDbContext db, (LedgerService Ledger, ShareLedger Shares) books, MemberDeletionPlan plan, string? refusal, CancellationToken ct)
    {
        var (ledger, shares) = books;
        var userId = plan.UserId;
        var now = DateTimeOffset.UtcNow;
        var bookings = await db.Bookings.AsNoTracking()
            .Where(b => (b.UserId == userId || b.PaidByUserId == userId)
                        && b.Status == BookingStatus.Booked && b.StartsAt > now && b.CheckedInAt == null)
            .OrderBy(b => b.StartsAt).ToListAsync(ct);
        var seats = await PartnerSeatsAsync(db, shares, userId, now, ct);
        var balance = await ledger.GetBalanceAsync(userId, ct);

        // Each cancelled booking refunds its payer in full (the club waives the penalty), and every
        // partner's paid share on it then goes back to that partner out of the refund; each seat
        // taken off another member's game hands this member's paid share back.
        var projected = balance + seats.Sum(s => s.PaidMinutes);
        foreach (var booking in bookings) projected += booking.AmountChargedMinutes - await PaidByPartnersAsync(db, shares, booking.Id, ct);

        refusal ??= await UncoveredReturnAsync(db, ledger, seats, ct);
        return plan with
        {
            Refusal = refusal,
            FutureBookingIds = bookings.Select(b => b.Id).ToList(),
            PartnerSeats = seats,
            OpenPurchases = await db.PendingTopups.AsNoTracking().CountAsync(p => p.UserId == userId && p.Status == TopUpStatus.Pending, ct),
            BalanceMinutes = balance,
            WriteOffMinutes = projected,
        };
    }

    /// <summary>
    /// Never yourself; never an address the server's configuration makes an administrator (it would
    /// be handed the rights back on its next sign-in); never the club's last active administrator.
    /// The last-admin rule is read again under the club's admin lock when the delete commits.
    /// </summary>
    private static async Task<string?> RefusalAsync(
        MainframeDbContext db, User user, Guid actorId, InherentAdmins inherent, CancellationToken ct)
    {
        if (user.Id == actorId) return CannotDeleteSelf;
        if (user.IsAdmin && inherent.Includes(user.Email)) return InheritedFromConfig;
        if (user.IsAdmin && !await AnotherAdminAsync(db, user.Id, ct)) return LastAdmin;
        return null;
    }

    /// <summary>Whether an active administrator other than this account exists — the R20 rule.</summary>
    public static Task<bool> AnotherAdminAsync(MainframeDbContext db, Guid userId, CancellationToken ct)
    {
        return db.Users.AsNoTracking().AnyAsync(u => u.IsAdmin && u.Status == UserStatuses.Active && u.Id != userId, ct);
    }

    /// <summary>Whether any row the club keeps points at this person. See the class remarks.</summary>
    public static async Task<bool> HasHistoryAsync(MainframeDbContext db, Guid userId, CancellationToken ct)
    {
        return await db.LedgerEntries.AnyAsync(l => l.UserId == userId || l.ActorUserId == userId, ct)
               || await db.Bookings.AnyAsync(b => b.UserId == userId || b.BookedByUserId == userId || b.PaidByUserId == userId, ct)
               || await db.BookingParticipants.AnyAsync(p => p.UserId == userId || p.InvitedByUserId == userId, ct)
               || await db.PendingTopups.AnyAsync(p => p.UserId == userId, ct)
               || await db.MatchResultPlayers.AnyAsync(p => p.UserId == userId, ct)
               || await db.DevicePayFors.AnyAsync(p => p.PayerUserId == userId, ct)
               || await db.AdminChangeLogs.AnyAsync(c => c.ActorUserId == userId, ct);
    }

    /// <summary>Their live seats on other members' games that have not started, with what each has paid in.</summary>
    private static async Task<List<MemberDeletionSeat>> PartnerSeatsAsync(
        MainframeDbContext db, ShareLedger shares, Guid userId, DateTimeOffset now, CancellationToken ct)
    {
        var seats = await db.BookingParticipants.AsNoTracking()
            .Where(p => p.UserId == userId && p.Seat > 1
                        && (p.Status == ParticipantStatus.Invited || p.Status == ParticipantStatus.Accepted)
                        && db.Bookings.Any(b => b.Id == p.BookingId && b.Status == BookingStatus.Booked && b.StartsAt > now
                                                && b.UserId != userId))
            .ToListAsync(ct);
        var list = new List<MemberDeletionSeat>(seats.Count);
        foreach (var seat in seats) list.Add(new MemberDeletionSeat(seat.BookingId, seat.Id, await shares.PaidAsync(seat, ct)));
        return list;
    }

    /// <summary>What the partners on one booking have paid in — it goes back to them when the booking is cancelled.</summary>
    private static async Task<int> PaidByPartnersAsync(MainframeDbContext db, ShareLedger shares, Guid bookingId, CancellationToken ct)
    {
        var seats = await db.BookingParticipants.AsNoTracking().Where(p => p.BookingId == bookingId && p.Seat > 1).ToListAsync(ct);
        var paid = 0;
        foreach (var seat in seats) paid += await shares.PaidAsync(seat, ct);
        return paid;
    }

    /// <summary>
    /// A paid share whose organiser cannot cover handing it back: the delete would leave the return
    /// waiting on a deleted account, so the desk settles that game first (the R16 overdraft rule).
    /// </summary>
    private static async Task<string?> UncoveredReturnAsync(
        MainframeDbContext db, LedgerService ledger, List<MemberDeletionSeat> seats, CancellationToken ct)
    {
        foreach (var seat in seats.Where(s => s.PaidMinutes > 0))
        {
            var booking = await db.Bookings.AsNoTracking().FirstAsync(b => b.Id == seat.BookingId, ct);
            var coverage = await ledger.GetCoverageAsync(ShareLedger.PayerOf(booking), booking.Id, seat.SeatId, ct);
            if (coverage < seat.PaidMinutes) return ShareReturnUncovered;
        }
        return null;
    }
}

/// <summary>The account statuses <see cref="User.Status"/> holds.</summary>
public static class UserStatuses
{
    public const string Active = "active";
    public const string Suspended = "suspended";

    /// <summary>Erased by the club. Terminal: nothing signs in, nothing reactivates it.</summary>
    public const string Deleted = "deleted";
}
