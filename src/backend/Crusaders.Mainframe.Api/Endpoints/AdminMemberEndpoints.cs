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

        g.MapGet("/", async (string? status, MainframeDbContext db, CancellationToken ct) =>
        {
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
                member_class = m.MemberClass.ToString(),
                created_at = m.CreatedAt,
                rejection_reason = m.RejectionReason,
                // Correlated subquery — EF translates to a single per-row SUM. Cheap at member-list scale.
                balance_credits = db.LedgerEntries.Where(l => l.UserId == m.UserId).Sum(l => (decimal?)l.AmountCredits) ?? 0m,
            }).ToListAsync(ct);
            return Results.Ok(rows);
        });

        // Phase 8.1 — admin assigns / changes a member's class (Regular / LeagueOrSenior).
        // Drives both the top-up conversion rate (blueprint A.8) and peak-hours access (A.12).
        g.MapPost("/{memberId:guid}/class", async (
            Guid memberId, AssignClassRequest req, HttpContext ctx,
            MainframeDbContext db, CancellationToken ct) =>
        {
            if (!Enum.TryParse<MemberClass>(req.MemberClass, ignoreCase: true, out var cls))
                return Results.BadRequest(new { error = "invalid_member_class", allowed = new[] { "Regular", "LeagueOrSenior" } });

            var m = await db.Memberships.FirstOrDefaultAsync(x => x.Id == memberId, ct);
            if (m is null) return Results.NotFound();

            var previous = m.MemberClass;
            if (previous == cls) return Results.Ok(new { member_class = cls.ToString(), changed = false });

            m.MemberClass = cls;
            db.AuditLogs.Add(new AuditLog
            {
                TenantId = m.TenantId,
                ActorUserId = ctx.User.Id() ?? Guid.Empty,
                SubjectUserId = m.UserId,
                Action = "member.class_changed",
                DetailsJson = System.Text.Json.JsonSerializer.Serialize(new { from = previous.ToString(), to = cls.ToString() }),
            });
            await db.SaveChangesAsync(ct);
            return Results.Ok(new { member_class = cls.ToString(), changed = true, previous = previous.ToString() });
        });

        g.MapPost("/{memberId:guid}/approve", async (Guid memberId, HttpContext ctx, MemberApprovalService svc, CancellationToken ct) =>
        {
            var actor = ctx.User.Id() ?? Guid.Empty;
            var ok = await svc.ApproveAsync(memberId, actor, ct);
            return ok ? Results.Ok(new { approved = true }) : Results.NotFound();
        });

        g.MapPost("/{memberId:guid}/reject", async (Guid memberId, RejectRequest req, HttpContext ctx, MemberApprovalService svc, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(req.Reason)) return Results.BadRequest(new { error = "reason_required" });
            var actor = ctx.User.Id() ?? Guid.Empty;
            var ok = await svc.RejectAsync(memberId, actor, req.Reason, ct);
            return ok ? Results.Ok(new { rejected = true }) : Results.NotFound();
        });

        // Admin-initiated password reset. Generates a strong temporary password, sets it as
        // the user's new hash, emails it to the user, and returns it to the admin (one-shot)
        // so they can communicate it directly when the email channel is broken.
        g.MapPost("/{memberId:guid}/reset-password", async (
            Guid memberId, HttpContext ctx, MainframeDbContext db,
            IPasswordHasher hasher, IEmailService email, ILoggerFactory loggerFactory, CancellationToken ct) =>
        {
            var logger = loggerFactory.CreateLogger("AdminResetPassword");
            var actor = ctx.User.Id() ?? Guid.Empty;
            var membership = await db.Memberships.FirstOrDefaultAsync(m => m.Id == memberId, ct);
            if (membership is null) return Results.NotFound();
            var user = await db.Users.FirstOrDefaultAsync(u => u.Id == membership.UserId, ct);
            if (user is null) return Results.NotFound();

            var tempPassword = GenerateTempPassword();
            user.PasswordHash = hasher.Hash(tempPassword);

            db.AuditLogs.Add(new AuditLog
            {
                TenantId = membership.TenantId,
                ActorUserId = actor,
                SubjectUserId = user.Id,
                Action = "user.password_reset_by_admin",
                DetailsJson = System.Text.Json.JsonSerializer.Serialize(new { membership_id = memberId }),
            });
            await db.SaveChangesAsync(ct);

            try { await email.SendAsync(EmailTemplates.AdminPasswordReset(user.Email, membership.FullName, tempPassword), ct); }
            catch (Exception ex) { logger.LogWarning(ex, "Admin reset email failed for {UserId}", user.Id); }

            return Results.Ok(new
            {
                temp_password = tempPassword,
                email_sent_to = user.Email,
                advice = "Share this with the member out-of-band if email delivery is uncertain. They should change it on first login.",
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
                    top_ups_credits = g2.Where(e => e.Type == LedgerEntryType.TopUp).Sum(e => e.AmountCredits),
                    top_ups_zar = g2.Where(e => e.Type == LedgerEntryType.TopUp).Sum(e => e.ZarPaid ?? 0m),
                    spent_credits = -g2.Where(e => e.Type == LedgerEntryType.BookingCharge).Sum(e => e.AmountCredits),
                    refunds_credits = g2.Where(e => e.Type == LedgerEntryType.CancellationRefund).Sum(e => e.AmountCredits),
                    penalties_credits = -g2.Where(e => e.Type == LedgerEntryType.NoShowPenalty || e.Type == LedgerEntryType.LateCancellationPenalty).Sum(e => e.AmountCredits),
                    adjustments_credits = g2.Where(e => e.Type == LedgerEntryType.AdminAdjustment).Sum(e => e.AmountCredits),
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
                    member_class = membership.MemberClass.ToString(),
                },
                totals = new
                {
                    top_ups_credits = entries.Where(e => e.Type == LedgerEntryType.TopUp).Sum(e => e.AmountCredits),
                    top_ups_zar = entries.Where(e => e.Type == LedgerEntryType.TopUp).Sum(e => e.ZarPaid ?? 0m),
                    spent_credits = -entries.Where(e => e.Type == LedgerEntryType.BookingCharge).Sum(e => e.AmountCredits),
                    refunds_credits = entries.Where(e => e.Type == LedgerEntryType.CancellationRefund).Sum(e => e.AmountCredits),
                    penalties_credits = -entries.Where(e => e.Type == LedgerEntryType.NoShowPenalty || e.Type == LedgerEntryType.LateCancellationPenalty).Sum(e => e.AmountCredits),
                    net_credits = entries.Sum(e => e.AmountCredits),
                    movement_count = entries.Count,
                },
                monthly = buckets,
            });
        });

        return app;
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
public sealed record AssignClassRequest(string MemberClass);
