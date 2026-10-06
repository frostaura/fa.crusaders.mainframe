using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>What the delete did, for the change record, the notices and the answer.</summary>
public sealed record MemberDeletionOutcome(int BookingsCancelled, int SeatsGivenUp, int PurchasesClosed, int WrittenOffMinutes);

/// <summary>
/// The last step of deleting a member: the account itself, under the club's admin lock, with its
/// audit row, its change-record row and every other administrator's notice in the same save. The
/// money — cancellations, share returns, the write-off — has already moved through the club's own
/// paths by then (<c>AdminMemberDeleteEndpoints</c>), so what is left here touches no ledger row.
/// </summary>
/// <remarks>
/// <para>
/// <b>The last-admin rule is read again under the lock</b> that every admin-rights change in the
/// club takes (<see cref="AdminRoleService.LockKey"/>): two admins deleting each other at once must
/// not leave the club with none, for the reason the R20 guard exists.
/// </para>
/// <para>
/// <b>Erase</b> wipes what identifies the person and keeps every row the books need. <b>Remove</b>
/// deletes every row of theirs; it is chosen only when nothing else points at them
/// (<see cref="MemberDeletion.HasHistoryAsync"/>), and that is checked again here.
/// </para>
/// </remarks>
public sealed class MemberDeletionService
{
    /// <summary>The collaborators that end an account's access, bundled for the parameter gate.</summary>
    public sealed record AccessEnders(MemberCodeService MemberCodes, LiveAdminRole LiveRole, SessionEpochs Sessions);

    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;
    private readonly AdminChangeRecorder _changes;
    private readonly AccessEnders _access;
    private readonly MemberPhotoFiles _photos;

    public MemberDeletionService(
        MainframeDbContext db, ITenantContext tenant, AdminChangeRecorder changes, AccessEnders access, MemberPhotoFiles photos)
    {
        _db = db; _tenant = tenant; _changes = changes; _access = access; _photos = photos;
    }

    /// <summary>
    /// Erases or removes the account. Answers the refusal code when the club may not (the last
    /// administrator, read under the lock), or null once it is done.
    /// </summary>
    public async Task<string?> CommitAsync(MemberDeletionPlan plan, Guid actorId, string reason, MemberDeletionOutcome outcome, CancellationToken ct)
    {
        await using var tx = await LockAdminsAsync(ct);
        if (plan.IsAdmin && !await MemberDeletion.AnotherAdminAsync(_db, plan.UserId, ct)) return MemberDeletion.LastAdmin;

        var user = await _db.Users.FirstAsync(u => u.Id == plan.UserId, ct);
        var membership = await _db.Memberships.FirstOrDefaultAsync(m => m.UserId == plan.UserId, ct);
        var photo = membership?.PhotoUrl;
        var erase = plan.Mode == MemberDeletionMode.Erase || await MemberDeletion.HasHistoryAsync(_db, plan.UserId, ct);

        await StageRecordsAsync(plan, actorId, reason, (erase, outcome), ct);
        if (erase) await EraseAsync(user, membership, actorId, ct);
        else await RemoveAsync(user, membership, ct);

        await _db.SaveChangesAsync(ct);
        if (tx is not null) await tx.CommitAsync(ct);
        if (erase) await _access.MemberCodes.CompleteRotationsAsync(ct);

        // After the commit, never before (LiveAdminRole.Invalidate says why).
        _access.LiveRole.Invalidate(_tenant.TenantId, plan.UserId);
        _access.Sessions.Invalidate(_tenant.TenantId, plan.UserId);
        _photos.TryDelete(_tenant.TenantSlug, photo);
        return null;
    }

    /// <summary>The club's admin lock, as <see cref="AdminRoleService"/> takes it. Null without transactions (the in-memory suites).</summary>
    private async Task<IDbContextTransaction?> LockAdminsAsync(CancellationToken ct)
    {
        if (!_db.Database.IsNpgsql()) return null;
        var tx = await _db.Database.BeginTransactionAsync(ct);
        await _db.Database.ExecuteSqlRawAsync("SELECT pg_advisory_xact_lock({0})", [AdminRoleService.LockKey(_tenant.TenantId)], ct);
        return tx;
    }

    /// <summary>
    /// The audit row, the change record (under the name the club knew them by) and every other
    /// administrator's notice, all in the deletion's own save.
    /// </summary>
    private async Task StageRecordsAsync(
        MemberDeletionPlan plan, Guid actorId, string reason, (bool Erase, MemberDeletionOutcome Did) what, CancellationToken ct)
    {
        var name = string.IsNullOrWhiteSpace(plan.FullName) ? MemberDeletion.DeletedName : plan.FullName;
        var did = what.Did;
        _db.AuditLogs.Add(new AuditLog
        {
            TenantId = _tenant.TenantId,
            ActorUserId = actorId,
            SubjectUserId = plan.UserId,
            Action = MemberDeletion.DeletedAction,
            DetailsJson = System.Text.Json.JsonSerializer.Serialize(new
            {
                reason,
                kept_history = what.Erase,
                bookings_cancelled = did.BookingsCancelled,
                seats_given_up = did.SeatsGivenUp,
                purchases_closed = did.PurchasesClosed,
                written_off_minutes = did.WrittenOffMinutes,
            }),
        });
        await _changes.StageAsync(new AdminChange(
            Action: AdminChangeActions.MemberDeleted,
            ActorUserId: actorId,
            SubjectKind: AdminChangeSubjects.User,
            SubjectId: plan.UserId,
            SubjectLabel: name,
            Reason: reason,
            Before: new { status = StatusWord(plan.Status) },
            After: new
            {
                status = "deleted",
                kept_history = what.Erase,
                bookings_cancelled = did.BookingsCancelled,
                written_off_minutes = did.WrittenOffMinutes,
            }), ct);

        var actorName = await _db.Memberships.AsNoTracking()
            .Where(m => m.UserId == actorId).Select(m => m.FullName).FirstOrDefaultAsync(ct) ?? "An administrator";
        AdminNotices.Stage(_db, _tenant.TenantId, AdminNotices.MemberDeleted(plan.UserId, actorId,
            new MemberDeletedPayload(name, actorName, reason, what.Erase, did.BookingsCancelled, did.WrittenOffMinutes)));
    }

    /// <summary>The change record's word for the status the member had — the members list's, in snake case.</summary>
    private static string StatusWord(MembershipStatus? status)
    {
        return status switch
        {
            MembershipStatus.PendingApproval => "pending_approval",
            MembershipStatus.Active => "active",
            MembershipStatus.Rejected => "rejected",
            MembershipStatus.Suspended => "suspended",
            _ => "none",
        };
    }

    /// <summary>
    /// Wipes everything that identifies the person and every way in, keeping the rows the books
    /// need. Their code rotates and every session ends (the same two raises a desk reset makes).
    /// </summary>
    private async Task EraseAsync(User user, Membership? membership, Guid actorId, CancellationToken ct)
    {
        await _access.MemberCodes.StageRotationAsync(user.Id, actorId, "member_deleted", ct);
        await _access.MemberCodes.StagePasskeyRevocationAsync(user.Id, actorId, "member_deleted", ct);

        user.Email = MemberDeletion.TombstoneEmail(user.Id);
        user.PasswordHash = null;
        user.PinHash = null;
        user.EmailVerified = false;
        user.MustChangePassword = false;
        user.IsAdmin = false;
        user.Status = UserStatuses.Deleted;
        if (membership is not null)
        {
            membership.FullName = MemberDeletion.DeletedName;
            membership.MembershipNumber = MemberDeletion.TombstoneNumber(membership.Id);
            membership.PhotoUrl = null;
            membership.RejectionReason = null;
            membership.Status = MembershipStatus.Deleted;
            membership.ReviewedAt = DateTimeOffset.UtcNow;
            membership.ReviewedByUserId = actorId;
        }

        var id = user.Id;
        await _db.AuthTokens.Where(t => t.UserId == id).ExecuteDeleteAsync(ct);
        await _db.AccessCodes.Where(c => c.UserId == id).ExecuteDeleteAsync(ct);
        await _db.EnrolledTemplates.Where(t => t.UserId == id).ExecuteDeleteAsync(ct);
        await _db.UserPreferences.Where(p => p.UserId == id).ExecuteDeleteAsync(ct);
        await _db.MemberGroupMembers.Where(g => g.UserId == id).ExecuteDeleteAsync(ct);
        await _db.PartnerFavourites.Where(f => f.UserId == id || f.PartnerUserId == id).ExecuteDeleteAsync(ct);
        await _db.MemberNotifications.Where(n => n.UserId == id).ExecuteDeleteAsync(ct);
        await _db.MemberPlayProfiles.Where(p => p.UserId == id).ExecuteDeleteAsync(ct);
        await _db.MemberStreakPauses.Where(p => p.UserId == id).ExecuteDeleteAsync(ct);
        await _db.PlayCelebrations.Where(c => c.UserId == id).ExecuteDeleteAsync(ct);
        // Mail still waiting for them is never sent: the address it would go to is gone.
        await _db.AdminNotifications
            .Where(n => n.RecipientUserId == id && n.State == AdminNotificationState.Pending)
            .ExecuteUpdateAsync(u => u.SetProperty(n => n.State, AdminNotificationState.Suppressed), ct);
    }

    /// <summary>Deletes every row of an account nothing else points at — the account, its membership and all it owned.</summary>
    private async Task RemoveAsync(User user, Membership? membership, CancellationToken ct)
    {
        var id = user.Id;
        await _db.AuthTokens.Where(t => t.UserId == id).ExecuteDeleteAsync(ct);
        await _db.RefreshTokens.Where(t => t.UserId == id).ExecuteDeleteAsync(ct);
        await _db.WebAuthnCredentials.Where(c => c.UserId == id).ExecuteDeleteAsync(ct);
        await _db.MemberCodes.Where(c => c.UserId == id).ExecuteDeleteAsync(ct);
        await _db.AccessCodes.Where(c => c.UserId == id).ExecuteDeleteAsync(ct);
        await _db.EnrolledTemplates.Where(t => t.UserId == id).ExecuteDeleteAsync(ct);
        await _db.UserPreferences.Where(p => p.UserId == id).ExecuteDeleteAsync(ct);
        await _db.MemberGroupMembers.Where(g => g.UserId == id).ExecuteDeleteAsync(ct);
        await _db.PartnerFavourites.Where(f => f.UserId == id || f.PartnerUserId == id).ExecuteDeleteAsync(ct);
        await _db.MemberNotifications.Where(n => n.UserId == id).ExecuteDeleteAsync(ct);
        await _db.MemberPlayProfiles.Where(p => p.UserId == id).ExecuteDeleteAsync(ct);
        await _db.MemberStreakPauses.Where(p => p.UserId == id).ExecuteDeleteAsync(ct);
        await _db.MemberBadges.Where(b => b.UserId == id).ExecuteDeleteAsync(ct);
        await _db.PlayCelebrations.Where(c => c.UserId == id).ExecuteDeleteAsync(ct);
        await _db.AdminNotifications.Where(n => n.RecipientUserId == id).ExecuteDeleteAsync(ct);
        if (membership is not null) _db.Memberships.Remove(membership);
        _db.Users.Remove(user);
    }
}
