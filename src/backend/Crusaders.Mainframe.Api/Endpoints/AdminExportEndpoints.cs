using System.Globalization;
using System.Text;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// The club's members and its no-shows, as files (BA-08; <c>feature-spec.md</c> "view / export all
/// transactions, bookings, members, no-shows"). Admin-only and tenant-scoped like every admin read.
///
/// <para>
/// <b>PII minimal, by decision.</b> A file leaves the app's access control the moment it is saved:
/// it is mailed, printed and kept on laptops. So each file carries only what its job needs and
/// nothing that reaches a person outside the club — the name and membership number a committee
/// already prints on its lists, the status, groups, join date and balance a treasurer reconciles
/// against — and <b>never</b> an email address, a phone number, a photo, a PIN or a fingerprint.
/// Contacting a member is done from inside the app, where it is recorded.
/// </para>
///
/// <para>
/// <b>Each export is recorded</b> (<see cref="MembersExportedAction"/>, <see cref="NoShowsExportedAction"/>):
/// who took the file and how many rows, never which members are in it — the door log's rule.
/// Every cell goes through <see cref="CsvCell"/>: a member's name is club-entered text, and a cell
/// beginning <c>=</c> is a formula in every spreadsheet.
/// </para>
/// </summary>
public static class AdminExportEndpoints
{
    public const string MembersExportedAction = "members.exported";
    public const string NoShowsExportedAction = "no_shows.exported";

    /// <summary>The members file's columns, in order — a contract with a spreadsheet, pinned by a test.</summary>
    public const string MembersHeader = "membership_number,full_name,status,groups,joined_date,balance_minutes";

    /// <summary>The no-shows file's columns, in order.</summary>
    public const string NoShowsHeader =
        "date,time,timezone,court,full_name,membership_number,booked_minutes,penalty_minutes,refunded_for_outage";

    /// <summary>The longest range one no-shows file covers: a year of club days.</summary>
    public const int MaxNoShowDays = 366;

    public static IEndpointRouteBuilder MapAdminExportEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1/admin/exports").RequireAuthorization(p => p.RequireRole("admin"));
        g.MapGet("/members.csv", MembersAsync);
        g.MapGet("/no-shows.csv", NoShowsAsync);
        return app;
    }

    /// <summary>
    /// <c>GET /api/v1/admin/exports/members.csv?status=</c> — every membership, or those in one status
    /// (<c>Active</c>, <c>PendingApproval</c>, <c>Suspended</c>, <c>Rejected</c>), by name.
    /// </summary>
    public static async Task<IResult> MembersAsync(
        string? status, HttpContext ctx, MainframeDbContext db, ITenantContext tenant, TenantSettingsAccessor settings,
        CancellationToken ct)
    {
        MembershipStatus? only = null;
        if (!string.IsNullOrWhiteSpace(status))
        {
            if (!Enum.TryParse<MembershipStatus>(status.Trim(), ignoreCase: true, out var parsed) || !Enum.IsDefined(parsed))
                return Results.BadRequest(new { error = "status_invalid", valid = Enum.GetNames<MembershipStatus>() });
            only = parsed;
        }

        var memberships = await db.Memberships.AsNoTracking()
            .Where(m => only == null || m.Status == only)
            .OrderBy(m => m.FullName).ThenBy(m => m.MembershipNumber)
            .Select(m => new { m.UserId, m.FullName, m.MembershipNumber, m.Status, m.CreatedAt })
            .ToListAsync(ct);
        var ids = memberships.Select(m => m.UserId).ToList();
        var balances = await db.LedgerEntries.AsNoTracking()
            .Where(l => ids.Contains(l.UserId))
            .GroupBy(l => l.UserId)
            .Select(g => new { UserId = g.Key, Minutes = g.Sum(l => l.AmountMinutes) })
            .ToDictionaryAsync(b => b.UserId, b => b.Minutes, ct);
        var groups = (await db.MemberGroupMembers.AsNoTracking()
                .Where(m => ids.Contains(m.UserId))
                .Join(db.MemberGroups.AsNoTracking(), m => m.GroupId, g => g.Id, (m, g) => new { m.UserId, g.Name })
                .ToListAsync(ct))
            .GroupBy(x => x.UserId)
            .ToDictionary(x => x.Key, x => string.Join("; ", x.Select(y => y.Name).OrderBy(n => n, StringComparer.OrdinalIgnoreCase)));
        var zone = ClubClock.ZoneOf(await settings.GetAsync(ct));

        var csv = new StringBuilder(MembersHeader).Append("\r\n");
        foreach (var m in memberships)
        {
            csv.Append(CsvCell.Line(
                m.MembershipNumber, m.FullName, m.Status.ToString(), groups.GetValueOrDefault(m.UserId),
                TimeZoneInfo.ConvertTime(m.CreatedAt, zone).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                balances.GetValueOrDefault(m.UserId).ToString(CultureInfo.InvariantCulture)));
        }

        await RecordAsync(db, tenant, ctx, MembersExportedAction, new { status = only?.ToString(), rows = memberships.Count }, ct);
        var day = TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, zone).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        return File(ctx, csv, $"members-{day}.csv", memberships.Count);
    }

    /// <summary>
    /// <c>GET /api/v1/admin/exports/no-shows.csv?from=&amp;to=</c> — every booking the no-show sweep
    /// settled as a no-show whose start falls in the range of club days (the last 30 by default),
    /// oldest first, with the penalty the ledger holds for it. A no-show refunded in full because no
    /// box on its court could be reached is listed and says so (E6-6): it is not held against anyone.
    /// </summary>
    public static async Task<IResult> NoShowsAsync(
        DateOnly? from, DateOnly? to, HttpContext ctx, MainframeDbContext db, ITenantContext tenant,
        TenantSettingsAccessor settings, CancellationToken ct)
    {
        var view = await settings.GetAsync(ct);
        var zone = ClubClock.ZoneOf(view);
        var last = to ?? ClubClock.Today(view);
        var first = from ?? last.AddDays(-30);
        if (last < first) return Results.BadRequest(new { error = "range_inverted" });
        if (last.DayNumber - first.DayNumber + 1 > MaxNoShowDays) return Results.BadRequest(new { error = "range_too_long", max_days = MaxNoShowDays });
        var (start, _) = ClubClock.DayWindow(view, first);
        var (_, end) = ClubClock.DayWindow(view, last);

        var rows = await db.Bookings.AsNoTracking()
            .Where(b => b.Status == BookingStatus.NoShow && b.StartsAt >= start && b.StartsAt < end)
            .OrderBy(b => b.StartsAt).ThenBy(b => b.Id)
            .ToListAsync(ct);
        var bookingIds = rows.Select(b => b.Id).ToList();
        var penalties = await db.LedgerEntries.AsNoTracking()
            .Where(l => l.Type == LedgerEntryType.NoShowPenalty && l.RelatedBookingId != null && bookingIds.Contains(l.RelatedBookingId!.Value))
            .GroupBy(l => l.RelatedBookingId!.Value)
            .Select(g => new { BookingId = g.Key, Minutes = g.Sum(l => l.AmountMinutes) })
            .ToDictionaryAsync(p => p.BookingId, p => -p.Minutes, ct);
        var people = rows.Select(b => b.UserId).Where(u => u is not null).Select(u => u!.Value).Distinct().ToList();
        var members = await db.Memberships.AsNoTracking().Where(m => people.Contains(m.UserId))
            .ToDictionaryAsync(m => m.UserId, m => (m.FullName, m.MembershipNumber), ct);
        var courts = await db.Courts.AsNoTracking().ToDictionaryAsync(c => c.Id, c => c.Name, ct);
        var timezone = zone.Id == TimeZoneInfo.Utc.Id ? "UTC" : view.Timezone;

        var csv = new StringBuilder(NoShowsHeader).Append("\r\n");
        foreach (var b in rows)
        {
            var local = TimeZoneInfo.ConvertTime(b.StartsAt, zone);
            var who = b.UserId is { } id && members.TryGetValue(id, out var m) ? m : (FullName: null, MembershipNumber: null);
            csv.Append(CsvCell.Line(
                local.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), local.ToString("HH:mm", CultureInfo.InvariantCulture), timezone,
                courts.GetValueOrDefault(b.CourtId), who.FullName, who.MembershipNumber,
                b.AmountChargedMinutes.ToString(CultureInfo.InvariantCulture),
                penalties.GetValueOrDefault(b.Id).ToString(CultureInfo.InvariantCulture),
                NoShows.IsRefundedForOutage(b) ? "yes" : "no"));
        }

        await RecordAsync(db, tenant, ctx, NoShowsExportedAction, new { from = first, to = last, rows = rows.Count }, ct);
        return File(ctx, csv, $"no-shows-{first:yyyy-MM-dd}-{last:yyyy-MM-dd}.csv", rows.Count);
    }

    /// <summary>Who took the file, what they asked for and how much came back — never who is in it.</summary>
    private static async Task RecordAsync(MainframeDbContext db, ITenantContext tenant, HttpContext ctx, string action, object details, CancellationToken ct)
    {
        db.AuditLogs.Add(new AuditLog
        {
            TenantId = tenant.TenantId,
            ActorUserId = ctx.User.Id() ?? Guid.Empty,
            SubjectUserId = null,
            Action = action,
            DetailsJson = JsonSerializer.Serialize(details),
        });
        await db.SaveChangesAsync(ct);
    }

    /// <summary>A BOM (Excel reads BOM-less UTF-8 in a legacy code page), a quoted name and the row count, as the door log answers.</summary>
    private static IResult File(HttpContext ctx, StringBuilder csv, string name, int rows)
    {
        ctx.Response.Headers[AdminDoorLogEndpoint.RowsHeader] = rows.ToString(CultureInfo.InvariantCulture);
        ctx.Response.Headers.ContentDisposition = $"attachment; filename=\"{name}\"";
        var bytes = Encoding.UTF8.GetPreamble().Concat(Encoding.UTF8.GetBytes(csv.ToString())).ToArray();
        return Results.File(bytes, "text/csv; charset=utf-8");
    }
}
