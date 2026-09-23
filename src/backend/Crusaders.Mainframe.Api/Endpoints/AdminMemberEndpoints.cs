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

        g.MapGet("/", async (string? status, MainframeDbContext db, InherentAdmins inherent, CancellationToken ct) =>
        {
            // An array, not the set itself: EF translates Contains over an array to `= ANY(...)`,
            // and it is the list's `admin_source` below that needs it.
            var configAdmins = inherent.Emails.ToArray();
            var q = db.Memberships.AsNoTracking().Include(m => m.User).AsQueryable();
            if (Enum.TryParse<MembershipStatus>(status, true, out var s)) q = q.Where(m => m.Status == s);
            var rows = await q.OrderBy(m => m.CreatedAt).Select(m => new
            {
                membership_id = m.Id,
                user_id = m.UserId,
                email = m.User!.Email,
                full_name = m.FullName,
                membership_number = m.MembershipNumber,
                photo_url = m.PhotoUrl,
                status = m.Status.ToString(),
                // An unverified member cannot sign in and nothing on this screen said so,
                // so "they say the app won't let them in" had no answer here. The console
                // now shows it and offers a resend.
                email_verified = m.User!.EmailVerified,
                // R20. Who can administer the club, and where that came from: "config" is an
                // address in Admins:Emails, which only an operator can remove, so the console
                // can say so before anybody presses Remove and meets a 409; "granted" is
                // everyone the club appointed itself; null is not an admin.
                is_admin = m.User!.IsAdmin,
                admin_source = m.User!.IsAdmin
                    ? (configAdmins.Contains(m.User!.Email) ? AdminSource.Config : AdminSource.Granted)
                    : null,
                created_at = m.CreatedAt,
                rejection_reason = m.RejectionReason,
                // Correlated subquery — EF translates to a single per-row SUM. Cheap at member-list scale.
                balance_credits = db.LedgerEntries.Where(l => l.UserId == m.UserId).Sum(l => (decimal?)l.AmountCredits) ?? 0m,
            }).ToListAsync(ct);

            // D2: the member's active groups replace their class — one read for the whole list,
            // not one per row. `member_class` stays for ONE release, derived from the league
            // group, so the members screen in production keeps its column until it is rebuilt.
            var groups = await MemberTariffs.GroupsOfManyAsync(db, rows.Select(r => r.user_id).ToList(), ct);
            return Results.Ok(rows.Select(r =>
            {
                var mine = groups.GetValueOrDefault(r.user_id) ?? [];
                return new
                {
                    r.membership_id,
                    r.user_id,
                    r.email,
                    r.full_name,
                    r.membership_number,
                    r.photo_url,
                    r.status,
                    groups = GroupsWire(mine),
                    member_class = MemberTariff.LegacyClassOf(mine),
                    r.email_verified,
                    r.is_admin,
                    r.admin_source,
                    r.created_at,
                    r.rejection_reason,
                    r.balance_credits,
                };
            }).ToList());
        });

        // D2: POST /{memberId}/class is gone with the member class. A member's groups are set
        // with PUT /api/v1/admin/members/{userId}/groups (AdminMemberDetailEndpoints) or one
        // group at a time on /api/v1/admin/member-groups/{id}/members.

        g.MapPost("/{memberId:guid}/approve", async (Guid memberId, HttpContext ctx, MemberApprovalService svc, CancellationToken ct) =>
        {
            var actor = ctx.User.Id() ?? Guid.Empty;
            var r = await svc.ApproveAsync(memberId, actor, ct);
            // `member_notified` is the honest half of this answer. The approval commits before
            // the welcome email is attempted, so a dead SMTP host used to throw out of the
            // service and hand the console a 500 for a member who was already Active — and the
            // console then said "Approval failed." about somebody it had just approved. The
            // transition is the status change; the mail is a consequence of it, and the console
            // is told which of the two happened rather than being made to guess.
            return r.Ok ? Results.Ok(new { approved = true, member_notified = r.MemberNotified }) : Results.NotFound();
        });

        g.MapPost("/{memberId:guid}/reject", async (Guid memberId, RejectRequest req, HttpContext ctx, MemberApprovalService svc, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(req.Reason)) return Results.BadRequest(new { error = "reason_required" });
            var actor = ctx.User.Id() ?? Guid.Empty;
            var r = await svc.RejectAsync(memberId, actor, req.Reason, ct);
            return r.Ok ? Results.Ok(new { rejected = true, member_notified = r.MemberNotified }) : Results.NotFound();
        });

        // Suspend / reactivate (spec §8). The enum value and the console's "Suspended"
        // filter both existed; the operation did not, so a club could not lock out a
        // member whose dues had lapsed and the filter was permanently empty.
        g.MapPost("/{memberId:guid}/suspend", async (
            Guid memberId, SuspendRequest req, HttpContext ctx, MemberApprovalService svc, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(req.Reason)) return Results.BadRequest(new { error = "reason_required" });
            var r = await svc.SuspendAsync(memberId, ctx.User.Id() ?? Guid.Empty, req.Reason.Trim(), ct);
            return TransitionResult(r.Result, new { suspended = true, member_notified = r.MemberNotified }, "member_already_suspended", "member_not_active");
        });

        g.MapPost("/{memberId:guid}/reactivate", async (
            Guid memberId, HttpContext ctx, MemberApprovalService svc, CancellationToken ct) =>
        {
            var r = await svc.ReactivateAsync(memberId, ctx.User.Id() ?? Guid.Empty, ct);
            return TransitionResult(r.Result, new { reactivated = true, member_notified = r.MemberNotified }, "member_already_active", "member_not_suspended");
        });

        // Admin-initiated password reset. Generates a strong temporary password, sets it as
        // the user's new hash, emails it to the user, and returns it to the admin (one-shot)
        // so they can communicate it directly when the email channel is broken.
        g.MapPost("/{memberId:guid}/reset-password", async (
            Guid memberId, HttpContext ctx, MainframeDbContext db,
            IPasswordHasher hasher, IEmailService email, ClubIdentityResolver club,
            ILoggerFactory loggerFactory, CancellationToken ct) =>
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
            await db.SaveChangesAsync(ct);

            // `email_sent_to` used to be printed whether or not the send threw, so the one
            // screen an admin reaches for when "email delivery is uncertain" asserted that
            // delivery had happened. Same shape as approve/reject, one layer down.
            var notified = true;
            try { await email.SendAsync(EmailTemplates.AdminPasswordReset(await club.GetAsync(ct), user.Email, membership.FullName, tempPassword), ct); }
            catch (Exception ex) { notified = false; logger.LogWarning(ex, "Admin reset email failed for {UserId}", user.Id); }

            return Results.Ok(new
            {
                temp_password = tempPassword,
                email_sent_to = notified ? user.Email : null,
                member_notified = notified,
                advice = "Share this with the member out-of-band if email delivery is uncertain. It only unlocks the change-password screen — they must choose a new password before they can do anything else.",
            });
        });

        // Per-member spend drill-down (blueprint C.3) — month-bucketed credit movements for one member.
        g.MapGet("/{memberId:guid}/spend", async (
            Guid memberId, DateTimeOffset? from, DateTimeOffset? to,
            MainframeDbContext db, CancellationToken ct) =>
        {
            var membership = await db.Memberships.AsNoTracking().FirstOrDefaultAsync(m => m.Id == memberId, ct);
            if (membership is null) return Results.NotFound();

            var t = to ?? DateTimeOffset.UtcNow;
            var f = from ?? t.AddMonths(-12);
            var spendGroups = await MemberTariffs.GroupsOfAsync(db, membership.UserId, ct);

            var entries = await db.LedgerEntries
                .Where(l => l.UserId == membership.UserId && l.CreatedAt >= f && l.CreatedAt < t)
                .ToListAsync(ct);

            // Bucket by year-month (UTC). Output: chronological list of {month, top_ups_credits, spent_credits, refunds_credits, penalties_credits, net_credits}.
            var buckets = entries
                .GroupBy(e => new { e.CreatedAt.Year, e.CreatedAt.Month })
                .OrderBy(g2 => g2.Key.Year).ThenBy(g2 => g2.Key.Month)
                .Select(g2 => new
                {
                    month = $"{g2.Key.Year:0000}-{g2.Key.Month:00}",
                    top_ups_credits = g2.Where(e => LedgerEntryTypes.Funding.Contains(e.Type)).Sum(e => e.AmountCredits),
                    top_ups_zar = g2.Where(e => LedgerEntryTypes.Funding.Contains(e.Type)).Sum(e => e.ZarPaid ?? 0m),
                    spent_credits = -g2.Where(e => LedgerEntryTypes.Spend.Contains(e.Type)).Sum(e => e.AmountCredits),
                    refunds_credits = g2.Where(e => LedgerEntryTypes.Refund.Contains(e.Type)).Sum(e => e.AmountCredits),
                    penalties_credits = -g2.Where(e => LedgerEntryTypes.Penalty.Contains(e.Type)).Sum(e => e.AmountCredits),
                    adjustments_credits = g2.Where(e => LedgerEntryTypes.Adjustment.Contains(e.Type)).Sum(e => e.AmountCredits),
                    net_credits = g2.Sum(e => e.AmountCredits),
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
                    groups = GroupsWire(spendGroups),
                    // Deprecated for one release — derived from the league group (D2).
                    member_class = MemberTariff.LegacyClassOf(spendGroups),
                },
                totals = new
                {
                    top_ups_credits = entries.Where(e => LedgerEntryTypes.Funding.Contains(e.Type)).Sum(e => e.AmountCredits),
                    top_ups_zar = entries.Where(e => LedgerEntryTypes.Funding.Contains(e.Type)).Sum(e => e.ZarPaid ?? 0m),
                    spent_credits = -entries.Where(e => LedgerEntryTypes.Spend.Contains(e.Type)).Sum(e => e.AmountCredits),
                    refunds_credits = entries.Where(e => LedgerEntryTypes.Refund.Contains(e.Type)).Sum(e => e.AmountCredits),
                    penalties_credits = -entries.Where(e => LedgerEntryTypes.Penalty.Contains(e.Type)).Sum(e => e.AmountCredits),

                    // Present in the monthly breakdown above and absent here until now, so
                    // the columns did not sum to the total. A pre-existing inconsistency,
                    // not one introduced by the LightsPurchase sweep.
                    adjustments_credits = entries.Where(e => LedgerEntryTypes.Adjustment.Contains(e.Type)).Sum(e => e.AmountCredits),
                    net_credits = entries.Sum(e => e.AmountCredits),
                    movement_count = entries.Count,
                },
                monthly = buckets,
            });
        });

        return app;
    }

    /// <summary>
    /// One mapping from a lifecycle outcome to an HTTP answer, so suspend and reactivate
    /// cannot drift apart. A 409 rather than a 400 for the two conflict cases: the request
    /// was well-formed and the row was simply not in the state it names, which is a
    /// different repair (reload the list) from a malformed one.
    /// </summary>
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
    /// tariff fields a screen needs to explain a rate or a peak refusal.
    /// </summary>
    internal static List<object> GroupsWire(IEnumerable<TariffGroup> groups)
    {
        return groups.Select(g => (object)new
        {
            id = g.Id,
            name = g.Name,
            system_key = g.SystemKey,
            credits_per_zar = g.CreditsPerZar,
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
