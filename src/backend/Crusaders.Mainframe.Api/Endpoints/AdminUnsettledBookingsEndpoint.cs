using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// The bookings behind the <c>booking.unsettled</c> notice (money lane BM-11, pass 2): past the
/// no-show sweep's reach, still <c>Booked</c>, never checked in, with a payer — each one a full
/// charge nobody settled. The notice links to <c>/admin/bookings</c>, and the console's filter there
/// lists exactly these, so an admin can cancel one (the member gets the whole charge back) or leave it.
///
/// <para>
/// <b>One rule, two readers.</b> <see cref="Query"/> is what the daily notice counts AND what this
/// list returns, so the notice can never say "3 bookings" over a list of 2.
/// </para>
/// </summary>
public static class AdminUnsettledBookingsEndpoint
{
    public const int DefaultLimit = 50;
    public const int MaxLimit = 200;

    /// <summary>Bookings older than the club's <c>no_show_lookback_days</c>, still booked, never checked in, with a payer.</summary>
    public static IQueryable<Booking> Query(MainframeDbContext db, TenantSettingsView settings, DateTimeOffset now)
    {
        var floor = now.AddDays(-settings.NoShowLookbackDays);
        return db.Bookings.AsNoTracking()
            .Where(b => b.Status == BookingStatus.Booked && b.CheckedInAt == null && b.UserId != null && b.StartsAt < floor);
    }

    public static IEndpointRouteBuilder MapAdminUnsettledBookings(this IEndpointRouteBuilder app)
    {
        app.MapGroup("/api/v1/admin/bookings")
            .RequireAuthorization(p => p.RequireRole("admin"))
            .MapGet("/unsettled", ListAsync);
        return app;
    }

    /// <summary>
    /// <c>GET /api/v1/admin/bookings/unsettled?cursor=&amp;limit=</c> — oldest first, by a keyset cursor
    /// over the start instant, with the total so the page can say how many there are in all.
    /// </summary>
    public static async Task<IResult> ListAsync(
        string? cursor, int? limit, MainframeDbContext db, TenantSettingsAccessor settingsAccessor, TimeProvider clock, CancellationToken ct)
    {
        var after = AdminChangeCursor.Parse(cursor);
        if (!string.IsNullOrWhiteSpace(cursor) && after is null) return Results.BadRequest(new { error = DoorLogQuery.CursorInvalid });

        var settings = await settingsAccessor.GetAsync(ct);
        var all = Query(db, settings, clock.GetUtcNow());
        var total = await all.CountAsync(ct);
        var page = all;
        if (after is not null)
        {
            var (at, id) = (after.At, after.Id);
            page = page.Where(b => b.StartsAt > at || (b.StartsAt == at && b.Id.CompareTo(id) > 0));
        }
        var take = Math.Clamp(limit ?? DefaultLimit, 1, MaxLimit);
        var rows = await page.OrderBy(b => b.StartsAt).ThenBy(b => b.Id).Take(take + 1).ToListAsync(ct);
        var more = rows.Count > take;
        if (more) rows.RemoveAt(rows.Count - 1);

        var people = rows.SelectMany(b => new[] { b.UserId, b.PaidByUserId }).Where(u => u is not null).Select(u => u!.Value).Distinct().ToList();
        var names = await db.Memberships.AsNoTracking().Where(m => people.Contains(m.UserId))
            .ToDictionaryAsync(m => m.UserId, m => (m.FullName, m.PhotoUrl), ct);
        var courtIds = rows.Select(b => b.CourtId).Distinct().ToList();
        var courts = await db.Courts.AsNoTracking().Where(c => courtIds.Contains(c.Id)).ToDictionaryAsync(c => c.Id, c => c.Name, ct);

        return Results.Ok(new
        {
            total,
            lookback_days = settings.NoShowLookbackDays,
            timezone = settings.Timezone,
            items = rows.Select(b => new
            {
                booking_id = b.Id,
                court_id = b.CourtId,
                court_name = courts.GetValueOrDefault(b.CourtId),
                starts_at = b.StartsAt,
                ends_at = b.EndsAt,
                charged_minutes = b.AmountChargedMinutes,
                member = Person(b.UserId, names),
                // The payer when somebody else paid for the court at the box (R7 E7-5): the refund is theirs.
                payer = b.PaidByUserId is { } payer && payer != b.UserId ? Person(payer, names) : null,
            }).ToList(),
            next_cursor = more && rows.Count > 0 ? new AdminChangeCursor(rows[^1].StartsAt, rows[^1].Id).Encode() : null,
        });
    }

    private static object? Person(Guid? userId, Dictionary<Guid, (string FullName, string? PhotoUrl)> names)
    {
        if (userId is not { } id) return null;
        var known = names.TryGetValue(id, out var p);
        return new { user_id = id, name = known ? p.FullName : null, photo_url = known ? p.PhotoUrl : null };
    }
}
