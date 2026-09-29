using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// A member's own inbox — the bell (D11). Everything keyed on the caller's token; there is no user
/// id in any route, so there is nothing to change to read somebody else's.
///
/// <para>
/// <b>Poll-friendly, with a push on top.</b> <c>unread-count</c> is one indexed count, cheap
/// enough to poll; and whenever a line is written the member's open wallet stream
/// (<c>/api/v1/wallet/stream</c>) carries a named <c>notification</c> frame with the new count, so
/// a client holding that stream never needs to.
/// </para>
/// </summary>
public static class MemberNotificationEndpoints
{
    public const int DefaultLimit = 20;
    public const int MaxLimit = 100;

    public static IEndpointRouteBuilder MapMemberNotificationEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1/me/notifications").RequireAuthorization();

        g.MapGet("/", ListAsync);
        g.MapGet("/unread-count", async (HttpContext ctx, MainframeDbContext db, CancellationToken ct) =>
        {
            var me = ctx.User.Id() ?? Guid.Empty;
            return Results.Ok(new { unread_count = await db.MemberNotifications.CountAsync(n => n.UserId == me && n.ReadAt == null, ct) });
        });
        g.MapPost("/{id:guid}/read", async (Guid id, HttpContext ctx, MainframeDbContext db, CancellationToken ct) =>
        {
            var me = ctx.User.Id() ?? Guid.Empty;
            var now = Services.StorableTime.UtcNow;
            // Scoped to the caller: another member's id matches nothing and answers 404, like any unknown id.
            var marked = await db.MemberNotifications.Where(n => n.Id == id && n.UserId == me)
                .ExecuteUpdateAsync(u => u.SetProperty(n => n.ReadAt, n => n.ReadAt ?? now), ct);
            return marked == 0 ? Results.NotFound(new { error = "notification_not_found" }) : Results.Ok(new { id, read = true });
        });
        g.MapPost("/read-all", async (HttpContext ctx, MainframeDbContext db, CancellationToken ct) =>
        {
            var me = ctx.User.Id() ?? Guid.Empty;
            var now = Services.StorableTime.UtcNow;
            var marked = await db.MemberNotifications.Where(n => n.UserId == me && n.ReadAt == null)
                .ExecuteUpdateAsync(u => u.SetProperty(n => n.ReadAt, now), ct);
            return Results.Ok(new { marked });
        });

        return app;
    }

    /// <summary>One page, newest first, keyset-paged on <c>(created_at, id)</c> — the admin feed's cursor.</summary>
    private static async Task<IResult> ListAsync(string? cursor, int? limit, HttpContext ctx, MainframeDbContext db, CancellationToken ct)
    {
        var after = AdminChangeCursor.Parse(cursor);
        if (!string.IsNullOrWhiteSpace(cursor) && after is null) return Results.BadRequest(new { error = DoorLogQuery.CursorInvalid });

        var me = ctx.User.Id() ?? Guid.Empty;
        var take = Math.Clamp(limit ?? DefaultLimit, 1, MaxLimit);
        var query = db.MemberNotifications.AsNoTracking().Where(n => n.UserId == me);
        if (after is not null)
        {
            var (at, id) = (after.At, after.Id);
            query = query.Where(n => n.CreatedAt < at || (n.CreatedAt == at && n.Id.CompareTo(id) < 0));
        }

        var rows = await query.OrderByDescending(n => n.CreatedAt).ThenByDescending(n => n.Id).Take(take + 1).ToListAsync(ct);
        var more = rows.Count > take;
        if (more) rows.RemoveAt(rows.Count - 1);

        return Results.Ok(new
        {
            items = rows.Select(n => new
            {
                id = n.Id,
                kind = n.Kind,
                headline = n.Headline,
                link = n.Link,
                booking_id = n.BookingId,
                created_at = n.CreatedAt,
                read_at = n.ReadAt,
            }).ToList(),
            unread_count = await db.MemberNotifications.CountAsync(n => n.UserId == me && n.ReadAt == null, ct),
            next_cursor = more && rows.Count > 0 ? new AdminChangeCursor(rows[^1].CreatedAt, rows[^1].Id).Encode() : null,
        });
    }
}
