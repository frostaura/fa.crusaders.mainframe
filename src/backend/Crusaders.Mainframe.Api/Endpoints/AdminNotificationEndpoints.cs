using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// The admin notice feed for the Admin overview, and the catalogue a settings screen renders its
/// toggles from (R23).
///
/// <para>
/// <b>The feed is the club's, not the caller's.</b> Every admin sees every notice the club
/// raised, including the kinds they have opted out of: an opt-out stops the interruption, never
/// the record. It carries the headline, a console link and the delivery outcome — never the
/// payload, which holds applicants' addresses and members' balances and is for the mail alone.
/// </para>
///
/// <para>
/// <b>Opting out is written through <c>PUT /api/v1/me/preferences</c></b>
/// (<c>admin_notification_optouts</c>), the one place a person's preferences are written. The
/// kinds route only reads, so the toggles and the notifier cannot disagree about what a kind is
/// called or whether it may be switched off.
/// </para>
/// </summary>
public static class AdminNotificationEndpoints
{
    /// <summary>Rows per page when the caller does not ask.</summary>
    public const int DefaultLimit = 20;

    /// <summary>Most rows one page returns, clamped rather than refused.</summary>
    public const int MaxLimit = 100;

    public static IEndpointRouteBuilder MapAdminNotificationEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1/admin/notifications").RequireAuthorization(p => p.RequireRole("admin"));

        g.MapGet("/", FeedAsync);
        g.MapGet("/kinds", KindsAsync);

        return app;
    }

    /// <summary>
    /// One page of this club's notices, newest first, keyset-paged on <c>(created_at, id)</c> by
    /// an opaque cursor. A malformed cursor is a 400, never a silent page one.
    /// </summary>
    public static async Task<IResult> FeedAsync(
        string? cursor, int? limit, MainframeDbContext db, CancellationToken ct)
    {
        var after = AdminChangeCursor.Parse(cursor);
        if (!string.IsNullOrWhiteSpace(cursor) && after is null)
        {
            return Results.BadRequest(new { error = DoorLogQuery.CursorInvalid });
        }

        var take = Math.Clamp(limit ?? DefaultLimit, 1, MaxLimit);
        // The club's ADMIN notices only. The outbox also carries mail for single members (D11),
        // which is theirs — it is on their own inbox, never on the admins' feed.
        var query = db.AdminNotifications.AsNoTracking().Where(n => n.Audience == NotificationAudience.Admins);
        if (after is not null)
        {
            var at = after.At;
            var id = after.Id;
            query = query.Where(n => n.CreatedAt < at || (n.CreatedAt == at && n.Id.CompareTo(id) < 0));
        }

        var rows = await query
            .OrderByDescending(n => n.CreatedAt).ThenByDescending(n => n.Id)
            .Take(take + 1)
            .ToListAsync(ct);
        var more = rows.Count > take;
        if (more) rows.RemoveAt(rows.Count - 1);

        return Results.Ok(new
        {
            items = rows.Select(Project).ToList(),
            next_cursor = more && rows.Count > 0 ? new AdminChangeCursor(rows[^1].CreatedAt, rows[^1].Id).Encode() : null,
        });
    }

    /// <summary>
    /// Every kind the notifier raises, with whether the caller may switch it off and whether they
    /// have. An opt-out naming a kind this build does not know is simply not listed.
    /// </summary>
    public static async Task<IResult> KindsAsync(
        HttpContext ctx, UserPreferencesService preferences, MainframeDbContext db, CancellationToken ct)
    {
        var me = ctx.User.Id() ?? Guid.Empty;
        var mine = (await preferences.GetAsync(me, ct)).AdminNotificationOptouts;
        var others = await OtherAdminsAsync(db, me, ct);
        return Results.Ok(new
        {
            kinds = AdminEventCatalogue.All.Select(k => KindView(k, mine, others)).ToList(),
        });
    }

    /// <summary>
    /// The OTHER admins a notice can reach — active, confirmed, not the caller, the dispatcher's own
    /// test (<see cref="AdminRecipients"/>) — each with their opt-out list. Review round 1, F3: the
    /// switch could not warn "nobody else will be told" without it.
    /// </summary>
    private static async Task<List<IReadOnlyList<string>>> OtherAdminsAsync(MainframeDbContext db, Guid me, CancellationToken ct)
    {
        var ids = await db.Users.AsNoTracking()
            .Where(u => u.IsAdmin && u.Status == "active" && u.EmailVerified && u.Id != me)
            .Select(u => u.Id).ToListAsync(ct);
        var stored = await db.UserPreferences.AsNoTracking().Where(p => ids.Contains(p.UserId))
            .ToDictionaryAsync(p => p.UserId, p => p.AdminNotificationOptoutsJson, ct);
        return [.. ids.Select(id => stored.TryGetValue(id, out var json) ? UserPreferencesRules.ReadOptouts(json) : (IReadOnlyList<string>)[])];
    }

    /// <summary>
    /// A security kind reads as opted in whatever the stored list says — the list may predate the
    /// kind becoming non-optional, and the toggle must describe what the notifier will do.
    /// Block body for the lizard reason in <c>memory/gotchas-build.md</c>.
    /// </summary>
    private static object KindView(AdminEventKind kind, IReadOnlyList<string> optouts, List<IReadOnlyList<string>> others)
    {
        return new
        {
            kind = kind.Kind,
            title = kind.Title,
            description = kind.Description,
            optional = kind.OptOutable,
            opted_out = kind.OptOutable && optouts.Contains(kind.Kind, StringComparer.Ordinal),
            // How many OTHER admins are still told of this kind (F3) — zero means switching it
            // off here leaves nobody told.
            others_receiving = kind.OptOutable
                ? others.Count(o => !o.Contains(kind.Kind, StringComparer.Ordinal))
                : others.Count,
        };
    }

    /// <summary>
    /// One notice as the Overview reads it. Block body for the lizard reason.
    ///
    /// <para>
    /// <b><c>sent_at</c> only for a notice that was sent.</b> The column is the instant the row
    /// stopped being pending — mailed, suppressed by a cooldown, or given up on — and returning
    /// it as <c>sent_at</c> for all three told the console a suppressed or failed notice had been
    /// sent. That instant is <c>finished_at</c>; <c>sent_at</c> is null unless the state is
    /// <c>sent</c>.
    /// </para>
    /// </summary>
    private static object Project(AdminNotification row)
    {
        return new
        {
            id = row.Id,
            kind = row.Kind,
            title = AdminEventCatalogue.Find(row.Kind)?.Title ?? row.Kind,
            headline = row.Headline,
            link = row.Link,
            subject_user_id = row.SubjectUserId,
            created_at = row.CreatedAt,
            delivery = new
            {
                state = StateName(row.State),
                sent_at = row.State == AdminNotificationState.Sent ? row.SentAt : null,
                finished_at = row.SentAt,
                recipients = row.RecipientCount,
                // BA-12: WHY a suppressed notice was not mailed, so a demo club's feed can say "a demo
                // club sends no mail" instead of "told recently", and a live club's cooldown is named.
                reason = row.State == AdminNotificationState.Suppressed ? SuppressionReason(row.LastError) : null,
            },
        };
    }

    /// <summary>The wire word for why a notice was suppressed (BA-12).</summary>
    public const string ReasonDemoClub = "demo_club";

    /// <inheritdoc cref="ReasonDemoClub"/>
    public const string ReasonToldRecently = "told_recently";

    /// <summary>
    /// The dispatcher's stored suppression cause, as the feed names it: <c>demo_club</c> for a demo
    /// club (which mails nobody, live or seeded), <c>told_recently</c> for the kind's cooldown (the
    /// one suppression that stores no cause), and any other stored cause as it was written.
    /// </summary>
    public static string SuppressionReason(string? stored) => stored switch
    {
        null => ReasonToldRecently,
        AdminNotificationDispatcher.DemoModeCause => ReasonDemoClub,
        _ => stored,
    };

    /// <summary>The wire's word for a state. Lower-case, and a closed set the frontend can switch on.</summary>
    public static string StateName(AdminNotificationState state)
    {
        switch (state)
        {
            case AdminNotificationState.Sent: return "sent";
            case AdminNotificationState.Suppressed: return "suppressed";
            case AdminNotificationState.Failed: return "failed";
            default: return "pending";
        }
    }
}
