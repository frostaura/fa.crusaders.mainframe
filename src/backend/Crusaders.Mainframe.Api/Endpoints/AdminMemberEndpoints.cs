using System.Security.Cryptography;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

public static class AdminMemberEndpoints
{
    public static IEndpointRouteBuilder MapAdminMemberEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1/admin/members").RequireAuthorization(p => p.RequireRole("admin"));

        g.MapGet("/", AdminMembersList.ListAsync);

        // D2: POST /{memberId}/class is gone with the member class. A member's groups are set
        // with PUT /api/v1/admin/members/{userId}/groups (AdminMemberDetailEndpoints) or one
        // group at a time on /api/v1/admin/member-groups/{id}/members.

        g.MapPost("/{memberId:guid}/approve", async (Guid memberId, HttpContext ctx, MemberApprovalService svc, CancellationToken ct) =>
        {
            var actor = ctx.User.Id() ?? Guid.Empty;
            var r = await svc.ApproveAsync(memberId, actor, ct);
            // `member_email_queued` is the honest half of this answer. The approval commits, then
            // the welcome email is QUEUED — a row in the email outbox, written in milliseconds,
            // sent by a worker. A dead SMTP host used to be awaited here and, before that, to throw
            // out of the service and hand the console a 500 for a member who was already Active.
            // The transition is the status change; the mail is a consequence of it, and the answer
            // says whether it was queued, never that it has arrived.
            return ApprovalResult(r);
        });

        g.MapPost("/{memberId:guid}/reject", async (Guid memberId, RejectRequest req, HttpContext ctx, MemberApprovalService svc, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(req.Reason)) return Results.BadRequest(new { error = "reason_required" });
            var actor = ctx.User.Id() ?? Guid.Empty;
            var r = await svc.RejectAsync(memberId, actor, req.Reason, ct);
            return r.Ok ? Results.Ok(new { rejected = true, member_email_queued = r.EmailQueued }) : Results.NotFound();
        });

        // Suspend / reactivate (spec §8). The enum value and the console's "Suspended"
        // filter both existed; the operation did not, so a club could not lock out a
        // member whose dues had lapsed and the filter was permanently empty.
        g.MapPost("/{memberId:guid}/suspend", async (
            Guid memberId, SuspendRequest req, HttpContext ctx, MemberApprovalService svc, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(req.Reason)) return Results.BadRequest(new { error = "reason_required" });
            var r = await svc.SuspendAsync(memberId, ctx.User.Id() ?? Guid.Empty, req.Reason.Trim(), ct);
            return TransitionResult(r.Result, new { suspended = true, member_email_queued = r.EmailQueued }, "member_already_suspended", "member_not_active");
        });

        g.MapPost("/{memberId:guid}/reactivate", async (
            Guid memberId, HttpContext ctx, MemberApprovalService svc, CancellationToken ct) =>
        {
            var r = await svc.ReactivateAsync(memberId, ctx.User.Id() ?? Guid.Empty, ct);
            return TransitionResult(r.Result, new { reactivated = true, member_email_queued = r.EmailQueued }, "member_already_active", "member_not_suspended");
        });

        // Admin-initiated password reset. Generates a strong temporary password, sets it as
        // the user's new hash, emails it to the user, and returns it to the admin (one-shot)
        // so they can communicate it directly when the email channel is broken.
        g.MapPost("/{memberId:guid}/reset-password", async (
            Guid memberId, HttpContext ctx, MainframeDbContext db,
            IPasswordHasher hasher, IEmailService email, ClubIdentityResolver club,
            MemberCodeService memberCodes, ILoggerFactory loggerFactory, CancellationToken ct) =>
        {
            var logger = loggerFactory.CreateLogger("AdminResetPassword");
            var actor = ctx.User.Id() ?? Guid.Empty;
            var membership = await db.Memberships.FirstOrDefaultAsync(m => m.Id == memberId, ct);
            if (membership is null) return Results.NotFound();
            var user = await db.Users.FirstOrDefaultAsync(u => u.Id == membership.UserId, ct);
            if (user is null) return Results.NotFound();

            var tempPassword = GenerateTempPassword();
            user.PasswordHash = hasher.Hash(tempPassword);
            // Arms the forced change. Without it the "temporary" password was simply the account's
            // password, forever — see PasswordChangeGate and User.MustChangePassword.
            user.MustChangePassword = true;

            db.AuditLogs.Add(new AuditLog
            {
                TenantId = membership.TenantId,
                ActorUserId = actor,
                SubjectUserId = user.Id,
                Action = "user.password_reset_by_admin",
                DetailsJson = System.Text.Json.JsonSerializer.Serialize(new { membership_id = memberId }),
            });
            await memberCodes.StageRotationAsync(user.Id, actor, "password_reset_by_admin", ct);
            // Review round 1, B5: on the club's own change record, in the same save.
            await ctx.RequestServices.GetRequiredService<AdminChangeRecorder>().StageAsync(new AdminChange(
                Action: AdminChangeActions.MemberPasswordReset, ActorUserId: actor, SubjectKind: AdminChangeSubjects.User,
                SubjectId: user.Id, SubjectLabel: membership.FullName, After: new { must_change_password = true }), ct);
            await db.SaveChangesAsync(ct);
            await memberCodes.CompleteRotationsAsync(ct);

            // The mail is queued, not sent: the admin's request no longer waits on SMTP, and the
            // answer names the address only when the mail really was queued. The temporary
            // password is on screen either way, for the admin to pass on out-of-band.
            var notified = true;
            try { await email.SendAsync(EmailTemplates.AdminPasswordReset(await club.GetAsync(ct), user.Email, membership.FullName, tempPassword), ct); }
            catch (Exception ex) { notified = false; logger.LogWarning(ex, "Admin reset email could not be queued for {UserId}", user.Id); }

            return Results.Ok(new
            {
                temp_password = tempPassword,
                email_queued_to = notified ? user.Email : null,
                member_email_queued = notified,
                advice = "Share this with the member out-of-band if email delivery is uncertain. It only unlocks the change-password screen — they must choose a new password before they can do anything else.",
            });
        });

        // Per-member spend drill-down (blueprint C.3) — month-bucketed minutes movements for one member.
        // Retires a member's rotating code (member-code §10): generation += 1, so every code
        // their phone can compute stops working and the phone re-enrols on its next check. The
        // desk's answer to "somebody photographed my code" or "I lost my phone".
        g.MapPost("/{memberId:guid}/code/reset", ResetCodeAsync);

        g.MapGet("/{memberId:guid}/spend", async (
            Guid memberId, DateTimeOffset? from, DateTimeOffset? to,
            MainframeDbContext db, CancellationToken ct) =>
        {
            var membership = await db.Memberships.AsNoTracking().FirstOrDefaultAsync(m => m.Id == memberId, ct);
            if (membership is null) return Results.NotFound();

            var t = (to ?? DateTimeOffset.UtcNow).ToUniversalTime();   // B-9: Npgsql refuses a non-zero offset
            var f = (from ?? t.AddMonths(-12)).ToUniversalTime();
            var spendGroups = await MemberTariffs.GroupsOfAsync(db, membership.UserId, ct);

            var entries = await db.LedgerEntries
                .Where(l => l.UserId == membership.UserId && l.CreatedAt >= f && l.CreatedAt < t)
                .ToListAsync(ct);

            // Bucket by year-month (UTC). Output: chronological list of {month, top_ups_minutes, spent_minutes, refunds_minutes, penalties_minutes, net_minutes}.
            var buckets = entries
                .GroupBy(e => new { e.CreatedAt.Year, e.CreatedAt.Month })
                .OrderBy(g2 => g2.Key.Year).ThenBy(g2 => g2.Key.Month)
                .Select(g2 => new
                {
                    month = $"{g2.Key.Year:0000}-{g2.Key.Month:00}",
                    top_ups_minutes = g2.Where(e => LedgerEntryTypes.Funding.Contains(e.Type)).Sum(e => e.AmountMinutes),
                    top_ups_zar = g2.Where(e => LedgerEntryTypes.Funding.Contains(e.Type)).Sum(e => e.ZarPaid ?? 0m),
                    spent_minutes = -g2.Where(e => LedgerEntryTypes.Spend.Contains(e.Type)).Sum(e => e.AmountMinutes),
                    refunds_minutes = g2.Where(e => LedgerEntryTypes.Refund.Contains(e.Type)).Sum(e => e.AmountMinutes),
                    penalties_minutes = -g2.Where(e => LedgerEntryTypes.Penalty.Contains(e.Type)).Sum(e => e.AmountMinutes),
                    adjustments_minutes = g2.Where(e => LedgerEntryTypes.Adjustment.Contains(e.Type)).Sum(e => e.AmountMinutes),
                    // R6 (E6-12): the two buckets the club's daily report and the member's own report
                    // carry and this one did not, so its columns did not sum to its own net.
                    reversals_minutes = g2.Where(e => LedgerEntryTypes.Reversal.Contains(e.Type)).Sum(e => e.AmountMinutes),
                    share_transfers_minutes = g2.Where(e => LedgerEntryTypes.Transfer.Contains(e.Type)).Sum(e => e.AmountMinutes),
                    net_minutes = g2.Sum(e => e.AmountMinutes),
                    movement_count = g2.Count(),
                })
                .ToList();

            return Results.Ok(new
            {
                from = f,
                to = t,
                member = new
                {
                    membership_id = membership.Id,
                    user_id = membership.UserId,
                    full_name = membership.FullName,
                    membership_number = membership.MembershipNumber,
                    // `member_class` is gone from this report (review round 6, E6-12): nothing reads
                    // it here, and the one release it was kept for has shipped. The members list and
                    // the member.* webhooks keep theirs until their own removal (webhooks.md).
                    groups = GroupsWire(spendGroups),
                },
                totals = new
                {
                    top_ups_minutes = entries.Where(e => LedgerEntryTypes.Funding.Contains(e.Type)).Sum(e => e.AmountMinutes),
                    top_ups_zar = entries.Where(e => LedgerEntryTypes.Funding.Contains(e.Type)).Sum(e => e.ZarPaid ?? 0m),
                    spent_minutes = -entries.Where(e => LedgerEntryTypes.Spend.Contains(e.Type)).Sum(e => e.AmountMinutes),
                    refunds_minutes = entries.Where(e => LedgerEntryTypes.Refund.Contains(e.Type)).Sum(e => e.AmountMinutes),
                    penalties_minutes = -entries.Where(e => LedgerEntryTypes.Penalty.Contains(e.Type)).Sum(e => e.AmountMinutes),

                    // Present in the monthly breakdown above and absent here until now, so
                    // the columns did not sum to the total. A pre-existing inconsistency,
                    // not one introduced by the LightsPurchase sweep.
                    adjustments_minutes = entries.Where(e => LedgerEntryTypes.Adjustment.Contains(e.Type)).Sum(e => e.AmountMinutes),
                    reversals_minutes = entries.Where(e => LedgerEntryTypes.Reversal.Contains(e.Type)).Sum(e => e.AmountMinutes),
                    share_transfers_minutes = entries.Where(e => LedgerEntryTypes.Transfer.Contains(e.Type)).Sum(e => e.AmountMinutes),
                    net_minutes = entries.Sum(e => e.AmountMinutes),
                    movement_count = entries.Count,
                },
                monthly = buckets,
            });
        });

        return app;
    }

    /// <summary>
    /// Retires a member's rotating code and ends every session they have open (member-code §10,
    /// §13) — the desk's answer to "I lost my phone". <c>revoke_passkeys</c> defaults to TRUE
    /// here: the lost phone's passkey would otherwise sign straight back in under the new epoch
    /// and enrol for the new secret. The answer says what went, so the desk can tell the member
    /// to set a passkey up again.
    /// </summary>
    /// <para>
    /// Review round 1, B6: the desk must say WHY (<c>reason</c>, required — 400 <c>reason_required</c>),
    /// the reset is written to the club's change record in the same save, and the member is emailed:
    /// it is their access that just changed, and if they did not ask for it this is how they learn.
    /// </para>
    private static async Task<IResult> ResetCodeAsync(
        Guid memberId, CodeResetRequest? req, HttpContext ctx, MainframeDbContext db, MemberCodeService memberCodes,
        CancellationToken ct)
    {
        var reason = req?.Reason?.Trim();
        if (string.IsNullOrEmpty(reason)) return Results.BadRequest(new { error = "reason_required" });
        var membership = await db.Memberships.AsNoTracking().FirstOrDefaultAsync(m => m.Id == memberId, ct);
        if (membership is null) return Results.NotFound();

        // Ensured first, so the answer is always a generation: a member who never enrolled has
        // nothing live to retire, and rotating a fresh row is harmless.
        var actor = ctx.User.Id() ?? Guid.Empty;
        await memberCodes.EnsureAsync(membership.UserId, ct);
        await memberCodes.StageRotationAsync(membership.UserId, actor, "admin_reset", ct);
        var revokePasskeys = req?.RevokePasskeys ?? true;
        var removed = revokePasskeys ? await memberCodes.StagePasskeyRevocationAsync(membership.UserId, actor, "admin_reset", ct) : 0;
        await ctx.RequestServices.GetRequiredService<AdminChangeRecorder>().StageAsync(new AdminChange(
            Action: AdminChangeActions.MemberCodeReset, ActorUserId: actor, SubjectKind: AdminChangeSubjects.User,
            SubjectId: membership.UserId, SubjectLabel: membership.FullName, Reason: reason,
            After: new { passkeys_removed = removed }), ct);
        await db.SaveChangesAsync(ct);
        await memberCodes.CompleteRotationsAsync(ct);

        var notified = await TellMemberOfCodeResetAsync(ctx, db, membership, (reason, removed > 0), ct);
        var row = await db.MemberCodes.AsNoTracking().FirstAsync(c => c.UserId == membership.UserId, ct);
        return Results.Ok(new
        {
            rotated = true,
            generation = row.Generation,
            passkeys_revoked = revokePasskeys,
            passkeys_removed = removed,
            member_email_queued = notified,
        });
    }

    /// <summary>The member's mail about the desk's code reset (B6), queued. A mail that cannot be queued is reported, never thrown: the reset has committed.</summary>
    private static async Task<bool> TellMemberOfCodeResetAsync(
        HttpContext ctx, MainframeDbContext db, Membership membership, (string Reason, bool PasskeysRemoved) what, CancellationToken ct)
    {
        var services = ctx.RequestServices;
        var to = await db.Users.AsNoTracking().Where(u => u.Id == membership.UserId).Select(u => u.Email).FirstAsync(ct);
        try
        {
            var club = await services.GetRequiredService<ClubIdentityResolver>().GetAsync(ct);
            await services.GetRequiredService<IEmailService>()
                .SendAsync(EmailTemplates.MemberCodeReset(club, to, membership.FullName, what.Reason, what.PasskeysRemoved), ct);
            return true;
        }
        catch (Exception ex)
        {
            services.GetRequiredService<ILoggerFactory>().CreateLogger("AdminCodeReset")
                .LogWarning(ex, "Code-reset email failed for {UserId}", membership.UserId);
            return false;
        }
    }

    /// <summary>
    /// One mapping from a lifecycle outcome to an HTTP answer, so suspend and reactivate
    /// cannot drift apart. A 409 rather than a 400 for the two conflict cases: the request
    /// was well-formed and the row was simply not in the state it names, which is a
    /// different repair (reload the list) from a malformed one.
    /// </summary>
    /// <summary>
    /// The approve route's answer. 409 <c>email_not_verified</c> when the applicant has not
    /// confirmed their address (BP-02) — the row's "Resend verification" is the way on.
    /// </summary>
    private static IResult ApprovalResult(TransitionReport r)
    {
        if (r.Ok) return Results.Ok(new { approved = true, member_email_queued = r.EmailQueued });
        return r.Result == MembershipTransition.EmailNotVerified
            ? Results.Json(new { error = "email_not_verified" }, statusCode: 409)
            : Results.NotFound();
    }

    private static IResult TransitionResult(MembershipTransition outcome, object ok, string alreadyError, string wrongStatusError)
    {
        return outcome switch
        {
            MembershipTransition.Ok => Results.Ok(ok),
            MembershipTransition.NotFound => Results.NotFound(),
            MembershipTransition.AlreadyInState => Results.Json(new { error = alreadyError }, statusCode: 409),
            _ => Results.Json(new { error = wrongStatusError }, statusCode: 409),
        };
    }

    /// <summary>
    /// A member's groups as every admin read names them: id, name, system key, and the two
    /// tariff fields a screen needs to explain a discount or a peak refusal.
    /// </summary>
    internal static List<object> GroupsWire(IEnumerable<TariffGroup> groups)
    {
        return groups.Select(g => (object)new
        {
            id = g.Id,
            name = g.Name,
            system_key = g.SystemKey,
            package_discount_bps = g.PackageDiscountBps,
            peak_priority = g.PeakPriority,
        }).ToList();
    }

    private static string GenerateTempPassword()
    {
        // 12 chars, mixed case + digits, no easily-confused glyphs.
        const string alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
        var chars = new char[12];
        for (var i = 0; i < chars.Length; i++)
            chars[i] = alphabet[RandomNumberGenerator.GetInt32(alphabet.Length)];
        return new string(chars);
    }
}

public sealed record RejectRequest(string Reason);
public sealed record SuspendRequest(string Reason);

/// <summary>
/// <c>GET /api/v1/admin/members/</c>. The perf round (2026-09-30) made it pageable WITHOUT
/// changing what an existing caller gets: with no <c>cursor</c> in the query string the answer is
/// the bare array of every member it always was; with one — empty for the first page — it is
/// <c>{ items, next_cursor, total }</c>, keyset-paged oldest first by (created_at, id), <c>limit</c>
/// default 50, max 200. <c>photos=url</c> hands a stored data-URI photo out as a link
/// (<see cref="PhotoEndpoints"/>) in either shape.
/// </summary>
public static class AdminMembersList
{
    public sealed record Query(string? Status, int? Limit, string? Cursor, string? Photos);

    public static async Task<IResult> ListAsync([AsParameters] Query query, HttpContext ctx, MainframeDbContext db, InherentAdmins inherent, CancellationToken ct)
    {
        var paged = ctx.Request.Query.ContainsKey("cursor");
        var after = AdminChangeCursor.Parse(query.Cursor);
        if (paged && !string.IsNullOrEmpty(query.Cursor) && after is null)
        {
            return Results.BadRequest(new { error = "cursor_invalid" });
        }

        var q = db.Memberships.AsNoTracking().AsQueryable();
        // A deleted member is on no list unless it is asked for by name (?status=Deleted).
        if (Enum.TryParse<MembershipStatus>(query.Status, true, out var s)) q = q.Where(m => m.Status == s);
        else q = q.Where(m => m.Status != MembershipStatus.Deleted);
        var take = Math.Clamp(query.Limit ?? 50, 1, 200);
        var page = paged ? Page(q, after).Take(take + 1) : q.OrderBy(m => m.CreatedAt);
        var rows = await RowsAsync(page, db, inherent, ct);
        var more = paged && rows.Count > take;
        if (more) rows.RemoveAt(rows.Count - 1);

        var items = await WireAsync(rows, db, PhotoEndpoints.Wanted(query.Photos), ct);
        if (!paged) return Results.Ok(items);
        return Results.Ok(new
        {
            items,
            next_cursor = more ? new AdminChangeCursor(rows[^1].CreatedAt, rows[^1].MembershipId).Encode() : null,
            total = await q.CountAsync(ct),
        });
    }

    private static IQueryable<Membership> Page(IQueryable<Membership> q, AdminChangeCursor? after)
    {
        if (after is not null)
        {
            var (at, id) = (after.At, after.Id);
            q = q.Where(m => m.CreatedAt > at || (m.CreatedAt == at && m.Id.CompareTo(id) > 0));
        }
        return q.OrderBy(m => m.CreatedAt).ThenBy(m => m.Id);
    }

    private sealed class Row
    {
        public Guid MembershipId { get; init; }
        public Guid UserId { get; init; }
        public string Email { get; init; } = "";
        public string FullName { get; init; } = "";
        public string MembershipNumber { get; init; } = "";
        public string? PhotoUrl { get; init; }
        public string Status { get; init; } = "";
        public bool EmailVerified { get; init; }
        public bool IsAdmin { get; init; }
        public string? AdminSource { get; init; }
        public DateTimeOffset CreatedAt { get; init; }
        public string? RejectionReason { get; init; }
        public int BalanceMinutes { get; init; }
    }

    private static async Task<List<Row>> RowsAsync(IQueryable<Membership> q, MainframeDbContext db, InherentAdmins inherent, CancellationToken ct)
    {
        // An array, not the set itself: EF translates Contains over an array to `= ANY(...)`,
        // and it is the list's `admin_source` below that needs it.
        var configAdmins = inherent.Emails.ToArray();
        return await q.Select(m => new Row
        {
            MembershipId = m.Id,
            UserId = m.UserId,
            Email = m.User!.Email,
            FullName = m.FullName,
            MembershipNumber = m.MembershipNumber,
            PhotoUrl = m.PhotoUrl,
            Status = m.Status.ToString(),
            // An unverified member cannot sign in and nothing on this screen said so,
            // so "they say the app won't let them in" had no answer here. The console
            // now shows it and offers a resend.
            EmailVerified = m.User!.EmailVerified,
            // R20. Who can administer the club, and where that came from: "config" is an
            // address in Admins:Emails, which only an operator can remove, so the console
            // can say so before anybody presses Remove and meets a 409; "granted" is
            // everyone the club appointed itself; null is not an admin.
            IsAdmin = m.User!.IsAdmin,
            AdminSource = m.User!.IsAdmin
                ? (configAdmins.Contains(m.User!.Email) ? AdminSource.Config : AdminSource.Granted)
                : null,
            CreatedAt = m.CreatedAt,
            RejectionReason = m.RejectionReason,
            // Correlated subquery — EF translates to a single per-row SUM. Cheap at member-list scale.
            BalanceMinutes = db.LedgerEntries.Where(l => l.UserId == m.UserId).Sum(l => (int?)l.AmountMinutes) ?? 0,
        }).ToListAsync(ct);
    }

    private static async Task<List<object>> WireAsync(List<Row> rows, MainframeDbContext db, bool photoLinks, CancellationToken ct)
    {
        // D2: the member's active groups replace their class — one read for the whole list,
        // not one per row. `member_class` stays for ONE release, derived from the league
        // group, so the members screen in production keeps its column until it is rebuilt.
        var groups = await MemberTariffs.GroupsOfManyAsync(db, rows.Select(r => r.UserId).ToList(), ct);
        return rows.Select(r =>
        {
            var mine = groups.GetValueOrDefault(r.UserId) ?? [];
            return (object)new
            {
                membership_id = r.MembershipId,
                user_id = r.UserId,
                email = r.Email,
                full_name = r.FullName,
                membership_number = r.MembershipNumber,
                photo_url = photoLinks ? PhotoEndpoints.Link(r.UserId, r.PhotoUrl) : r.PhotoUrl,
                status = r.Status,
                groups = AdminMemberEndpoints.GroupsWire(mine),
                member_class = MemberTariff.LegacyClassOf(mine),
                email_verified = r.EmailVerified,
                is_admin = r.IsAdmin,
                admin_source = r.AdminSource,
                created_at = r.CreatedAt,
                rejection_reason = r.RejectionReason,
                balance_minutes = r.BalanceMinutes,
            };
        }).ToList();
    }
}
