using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// W1.7 and W1.8 — what a member standing at a door is told, and their own history.
///
/// <para>
/// <b>This is the other half of P3.</b> The admin door log filters by door, time and outcome
/// and has no per-member filter, because a member's door history belongs to the member. These
/// two routes are where it belongs to them — and nowhere else in the product may render it.
/// </para>
///
/// <para>
/// <b>One endpoint for the standing facts AND the last decision (A3.2).</b> The member's page
/// polls while it is visible; two endpoints would mean two failure states for one card and two
/// clocks that disagree about which is newer. Two minutes is a FETCH window, not a display
/// window — the page keeps showing a decision it has already fetched until it is superseded or
/// dismissed, which is the page's business and not this route's.
/// </para>
///
/// <para>
/// <b>Nothing of the trail's own shape crosses this boundary.</b> No fingerprint, no device id,
/// no MAC, no device code, no raw details, and not another member's anything. A door name is
/// the club's own label for a door the member is standing at — <c>gate_key</c>, which is what
/// the club has written on the door — and null when nobody has named it.
/// </para>
/// </summary>
public static class MeDoorEndpoints
{
    /// <summary>
    /// How far back a decision may be and still be THIS scan. Two minutes.
    ///
    /// <para>
    /// Short because the card's whole claim is "this just happened to you, here is what to do
    /// next", and a five-minute-old refusal shown to somebody who has since walked in is a page
    /// contradicting the building. Long enough that a phone waking from sleep, reconnecting and
    /// polling still catches the scan the member made before they pulled the handle.
    /// </para>
    /// </summary>
    public const int LastDecisionWindowSeconds = 120;

    /// <summary>Rows per page of a member's own history, and the ceiling on asking for more.</summary>
    public const int DefaultHistoryLimit = 50;

    /// <summary>Most rows one history page returns, clamped rather than refused.</summary>
    public const int MaxHistoryLimit = 200;

    public static IEndpointRouteBuilder MapMeDoorEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1/me/door").RequireAuthorization();

        g.MapGet("/", DoorAsync);
        g.MapGet("/history", HistoryAsync);

        return app;
    }

    /// <summary>
    /// <c>GET /api/v1/me/door</c> — everything the member's code page needs about doors.
    ///
    /// <para>
    /// <c>doors: false</c> is load-bearing: a club with no door controller must get a page that
    /// says NOTHING about doors rather than one describing a building with no controller in it.
    /// It counts ENABLED gates only, for the reason <c>QrEndpoints</c> already records — a board
    /// the club has switched off is answered 403 on every route it calls, so promising a member
    /// it will let them in would be false.
    /// </para>
    /// </summary>
    private static async Task<IResult> DoorAsync(
        HttpContext ctx, MainframeDbContext db, TenantSettingsAccessor settingsAccessor, CancellationToken ct)
    {
        var userId = ctx.User.Id() ?? Guid.Empty;
        if (userId == Guid.Empty) return Results.Unauthorized();

        var settings = await settingsAccessor.GetAsync(ct);
        var now = DateTimeOffset.UtcNow;

        var doors = await db.Devices.AnyAsync(d => d.Kind == DeviceKind.Gate && d.Enabled, ct);
        var status = await db.Memberships.Where(m => m.UserId == userId)
            .Select(m => (MembershipStatus?)m.Status).FirstOrDefaultAsync(ct);

        return Results.Ok(new
        {
            doors,
            policy = settings.GateAccessPolicy,
            membership = Membership(status),

            // The SAME fact at two resolutions, and both are wanted.
            //
            // `membership` is the three-valued answer to "may this person open a door" and is
            // what the standing line branches on. `membership_detail` is the club's own recorded
            // status, so the page can say WHICH not-active this is — "your membership is
            // suspended, speak to the club" and "your application has not been approved yet"
            // are two different things for a person outside a building to do next, and the
            // second is one click away. That is the same argument MembershipAccess already
            // makes for keeping StatusIfBarredAsync beside IsBarredFromCourtsAsync.
            membership_detail = MembershipDetail(status),

            // §5's carve-out, stated so the page's standing line can say it rather than
            // describe a rule this member is not held to. Club admins pass the booking check
            // under booking_window — and are held to the membership check like everybody.
            is_club_admin = await db.Users.AnyAsync(u => u.Id == userId && u.IsAdmin, ct),

            next_booking = await NextBookingAsync(db, settings, userId, now, ct),

            // Clamped server-side; the page never clamps. Additive to WIRE-W1 so the standing
            // line can name the window instead of saying "a while before".
            early_entry_minutes = BookingCodeWindow.EntryWindowMinutes(settings),
            roster_max_entries = DeviceGateRosterBuilder.GateRosterMaxEntries,

            contact = new
            {
                phone = DoorSettings.ContactPhone(settings),
                email = DoorSettings.ContactEmail(settings),
            },

            // So W1.8's line on the profile page carries the club's own number.
            door_log_retention_days = DoorSettings.LogRetentionDays(settings),

            last_decision = await LastDecisionAsync(db, settings, userId, now, ct),
        });
    }

    /// <summary>
    /// <c>GET /api/v1/me/door/history</c> — this member's own door rows, newest first.
    ///
    /// <para>
    /// Bounded by the club's retention rather than merely sorted, for the same reason the admin
    /// log is: the page states the number, the nightly sweep is what enforces it on disk, and a
    /// read answering past the sweep would make the page's own sentence false between sweeps.
    /// </para>
    /// </summary>
    private static async Task<IResult> HistoryAsync(
        HttpContext ctx, MainframeDbContext db, TenantSettingsAccessor settingsAccessor, CancellationToken ct)
    {
        var userId = ctx.User.Id() ?? Guid.Empty;
        if (userId == Guid.Empty) return Results.Unauthorized();

        var settings = await settingsAccessor.GetAsync(ct);
        var now = DateTimeOffset.UtcNow;
        var retentionDays = DoorSettings.LogRetentionDays(settings);
        var floor = now.AddDays(-retentionDays);

        var limit = Math.Clamp(
            int.TryParse(ctx.Request.Query["limit"].ToString(), out var asked) ? asked : DefaultHistoryLimit,
            1, MaxHistoryLimit);

        var rows = Mine(db, userId).Where(a => a.CreatedAt >= floor);
        if (DoorLogCursor.Parse(ctx.Request.Query["cursor"].ToString()) is { } cursor)
        {
            rows = rows.Where(a => a.CreatedAt < cursor.At || (a.CreatedAt == cursor.At && a.Id.CompareTo(cursor.Id) < 0));
        }

        var page = await rows.OrderByDescending(a => a.CreatedAt).ThenByDescending(a => a.Id)
            .Take(limit + 1)
            .Select(a => new { a.Id, a.Action, a.CreatedAt, a.DetailsJson })
            .ToListAsync(ct);

        var items = page.Take(limit).ToList();
        var doors = await DoorNamesAsync(db, items.Select(r => r.DetailsJson), ct);

        return Results.Ok(new
        {
            items = items.Select(r => Entry(r.Action, r.CreatedAt, r.DetailsJson, doors)).ToList(),
            next_cursor = page.Count > limit && items.Count > 0
                ? new DoorLogCursor(items[^1].CreatedAt, items[^1].Id).Encode()
                : null,
            retention_days = retentionDays,
        });
    }

    /// <summary>
    /// This member's own door rows — tenant-filtered by the context's global query filter, and
    /// subject-filtered here.
    ///
    /// <para>
    /// <b>Both filters are needed and neither substitutes for the other.</b> The tenant filter
    /// cannot separate two members of the same club, and the subject comparison cannot separate
    /// two clubs that happen to hold the same guid. The cross-member and cross-tenant tests in
    /// <c>MeDoorHttpTests</c> drive exactly those two cases.
    /// </para>
    ///
    /// <para>
    /// A row with no subject — an offline <c>unknown_scan</c>, which names nobody structurally
    /// (§6) — belongs to nobody and can never appear here. Neither can the anonymisation
    /// sentinel, which is not a user.
    /// </para>
    /// </summary>
    private static IQueryable<AuditLog> Mine(MainframeDbContext db, Guid userId)
        => db.AuditLogs.AsNoTracking().Where(DoorTrail.IsScanRow).Where(a => a.SubjectUserId == userId);

    /// <summary>
    /// The member's newest door row inside the fetch window, or null — which is not an error and
    /// never the sentence "no refusals found".
    /// </summary>
    private static async Task<object?> LastDecisionAsync(
        MainframeDbContext db, TenantSettingsView settings, Guid userId, DateTimeOffset now, CancellationToken ct)
    {
        var since = now.AddSeconds(-LastDecisionWindowSeconds);
        var row = await Mine(db, userId)
            .Where(a => a.CreatedAt >= since)
            .OrderByDescending(a => a.CreatedAt).ThenByDescending(a => a.Id)
            .Select(a => new { a.Action, a.CreatedAt, a.DetailsJson })
            .FirstOrDefaultAsync(ct);

        if (row is null) return null;

        var details = DoorActivityView.Details(row.DetailsJson);
        var reason = DoorActivityView.Reason(details)
                     ?? (DoorTrail.IsRelease(row.Action) ? GateAccess.Ok : null);

        // Only too_early has an instant to count down to. Every other refusal is about the
        // credential or the membership and is not a matter of waiting — a countdown on one
        // would be the page promising a door that is never going to open by itself.
        var opensAt = reason == GateAccess.TooEarly
            ? await TooEarlyOpensAtAsync(db, settings, userId, now, ct)
            : null;

        var doors = await DoorNamesAsync(db, [row.DetailsJson], ct);

        return new
        {
            at = DoorActivityView.ScannedAt(details, row.CreatedAt),
            delivered_at = DoorActivityView.DeliveredAt(details, row.CreatedAt),
            door_name = DoorNameOf(details, doors),
            released = DoorTrail.IsRelease(row.Action),
            reason,
            offline = DoorActivityView.Offline(details),
            opens_at = opensAt,
        };
    }

    /// <summary>
    /// The club's own label for each door these rows name, read at REPLY time rather than off
    /// the row.
    ///
    /// <para>
    /// <b>The row is not a reliable place to find it and never was.</b> The online gate path
    /// writes <c>gate_key</c> into its details and the offline upload path did not, so a
    /// member's history showed six releases at a null door — at a door the club had named
    /// "Side door" — and the page then told her the club had not named it (S1, D7). The admin
    /// log has always resolved the door by its id; this does the same, so the two surfaces
    /// cannot disagree about what a door is called. A rename is reflected in the history the
    /// moment it happens, which is the right answer: the member is being shown the door they
    /// will see next time, not the one the sign used to say.
    /// </para>
    ///
    /// <para>
    /// Tenant-filtered by the context's global query filter, like every other read here — a
    /// device id inside a jsonb document proves nothing about whose board it is.
    /// </para>
    /// </summary>
    private static async Task<Dictionary<Guid, string>> DoorNamesAsync(
        MainframeDbContext db, IEnumerable<string?> detailsJson, CancellationToken ct)
    {
        var ids = detailsJson
            .Select(d => DoorTrail.DeviceIdOf(DoorActivityView.Details(d)))
            .Where(d => d is not null).Select(d => d!.Value).Distinct().ToList();
        if (ids.Count == 0) return [];

        // The club's own label for the DOOR first, the board's display name second.
        //
        // `gate_key` is what a club writes on a door and what A2.2 keys "Needs a door name"
        // on; `Name` is the board's label and starts life as the auto-registration's
        // placeholder, which is a worse thing to show somebody standing outside than the slug
        // the club chose. A door with neither is the club's own gap and the page has its own
        // sentence for it.
        return await db.Devices.AsNoTracking()
            .Where(d => ids.Contains(d.Id))
            .Select(d => new { d.Id, Label = d.GateKey ?? d.Name })
            .ToDictionaryAsync(d => d.Id, d => d.Label, ct);
    }

    /// <summary>
    /// What to call the door on this row: the club's own label for it, resolved now, then the
    /// key the row stored, then nothing.
    ///
    /// <para>
    /// The stored key is the fallback for a board that has been DELETED since the scan, which
    /// is the one case resolution cannot answer and the one case where a history row would
    /// otherwise lose the only thing that made it readable. Block body for the lizard reason
    /// in <c>memory/gotchas.md</c>.
    /// </para>
    /// </summary>
    private static string? DoorNameOf(JsonElement? details, IReadOnlyDictionary<Guid, string> doors)
    {
        if (DoorTrail.DeviceIdOf(details) is { } id && doors.TryGetValue(id, out var name)) return name;
        return details is { } root ? DoorActivityView.Text(root, "gate_key") : null;
    }

    /// <summary>
    /// One row in the member's voice: when, which door, whether the lock released, why, and
    /// whether the board decided it alone.
    ///
    /// <para>
    /// <c>released</c> rather than "opened" — P2 and A1.2: the board energised the lock and this
    /// product has no sensor that could say the door moved or who walked through it. Block body
    /// for the lizard reason in <c>memory/gotchas.md</c>.
    /// </para>
    /// </summary>
    private static object Entry(
        string action, DateTimeOffset at, string? detailsJson, IReadOnlyDictionary<Guid, string> doors)
    {
        var details = DoorActivityView.Details(detailsJson);
        return new
        {
            // The scan, and when the club heard about it. See DoorActivityView.ScannedAt: an
            // offline row is written at the upload and the scan's own instant is on the row,
            // so a history stamped with `at` alone told a member they had walked in at the
            // moment their door's board came back from an outage.
            at = DoorActivityView.ScannedAt(details, at),
            delivered_at = DoorActivityView.DeliveredAt(details, at),
            door_name = DoorNameOf(details, doors),
            released = DoorTrail.IsRelease(action),
            reason = DoorActivityView.Reason(details) ?? (DoorTrail.IsRelease(action) ? GateAccess.Ok : null),
            offline = DoorActivityView.Offline(details),
        };
    }

    /// <summary>
    /// The three states the page has different sentences for.
    ///
    /// <para>
    /// <c>none</c> is a user with no membership row, and it is deliberately not
    /// <c>not_active</c>: <see cref="MembershipAccess"/> does not treat that state as barred, so
    /// telling such a person their membership is not active would be the page contradicting the
    /// door they are standing at.
    /// </para>
    /// </summary>
    /// <remarks>
    /// Block body, not an expression one: lizard's C# parser mis-scopes an expression-bodied
    /// member containing braces — a <c>switch</c> expression is enough — into a
    /// <c>*global*</c> pseudo-function the length of the file, which then fails the length
    /// gate naming no real function. See <c>memory/gotchas.md</c>.
    /// </remarks>
    private static string Membership(MembershipStatus? status)
    {
        if (status is null) return "none";
        return status == MembershipStatus.Active ? "active" : "not_active";
    }

    /// <summary>
    /// The club's recorded status, in the domain's own vocabulary rather than an invented one.
    ///
    /// <para>
    /// <b>The set is <see cref="MembershipStatus"/>'s, lowercased, plus <c>none</c>.</b> There
    /// is deliberately no <c>expired</c>: this product has no expiry concept — a membership is
    /// taken away by an admin setting <see cref="MembershipStatus.Suspended"/>, and inventing a
    /// seventh value here would put a state on a member's screen that nothing in the system can
    /// ever produce and that no door will ever act on. If lapse-with-grace-days ever lands (it
    /// is on the deferred list), the enum gains the member and this mapping follows it.
    /// </para>
    ///
    /// <para>
    /// Block body for the lizard reason in <c>memory/gotchas.md</c>.
    /// </para>
    /// </summary>
    private static string MembershipDetail(MembershipStatus? status)
    {
        if (status is not { } recorded) return "none";
        return recorded switch
        {
            MembershipStatus.Active => "active",
            MembershipStatus.PendingApproval => "pending_approval",
            MembershipStatus.Rejected => "rejected",
            MembershipStatus.Suspended => "suspended",
            _ => "none",
        };
    }

    /// <summary>
    /// For a <see cref="GateAccess.TooEarly"/> refusal: the instant a door WOULD open for the
    /// booking behind it — or null when there is no such booking.
    ///
    /// <para>
    /// <b>Computed through <see cref="BookingCodeWindow.DoorHorizonMinutes"/>, which is the
    /// function the door itself decides with.</b> The page cannot work it out: the horizon is
    /// <c>max(gate_early_entry, min(roster + cue, 240))</c> under one policy and
    /// <c>gate_early_entry</c> under the other, and none of those three settings is on a
    /// member's API surface, nor should it be. A countdown the page computed from its own copy
    /// is how a member ends up watching a clock reach zero at a door that refuses them.
    /// </para>
    ///
    /// <para>
    /// It is a separate read from <c>next_booking</c> and has to be: <c>too_early</c> means the
    /// booking's window has NOT opened, which is exactly the condition under which
    /// <see cref="NextBookingAsync"/> returns null. The earliest such booking is the one the
    /// member is standing at the door for.
    /// </para>
    ///
    /// <para>
    /// <c>Cancelled</c> and <c>AdminBlock</c> are excluded here as they are everywhere a door
    /// counts a booking — those are decisions the CLUB made about the booking, and counting one
    /// would promise a member a door that will never open.
    /// </para>
    /// </summary>
    private static async Task<DateTimeOffset?> TooEarlyOpensAtAsync(
        MainframeDbContext db, TenantSettingsView settings, Guid userId, DateTimeOffset now, CancellationToken ct)
    {
        var horizon = BookingCodeWindow.DoorHorizonMinutes(settings);
        var earliestStart = now.AddMinutes(horizon);

        var startsAt = await db.Bookings.AsNoTracking()
            .Where(b => b.UserId == userId
                        && (b.Status == BookingStatus.Booked
                            || b.Status == BookingStatus.NoShow
                            || b.Status == BookingStatus.Completed)
                        && b.StartsAt > earliestStart)
            .OrderBy(b => b.StartsAt)
            .Select(b => (DateTimeOffset?)b.StartsAt)
            .FirstOrDefaultAsync(ct);

        return startsAt?.AddMinutes(-horizon);
    }

    /// <summary>
    /// The member's next booking and the window a door will honour its code in — or null.
    ///
    /// <para>
    /// The window comes from <see cref="BookingCodeWindow"/>, the same function the door itself
    /// decides with, for the reason <c>QrEndpoints</c> records at length: the horizon is built
    /// from three club settings that are not on a member's API surface and should not be, so the
    /// server states the instants rather than leaving a page to compute a copy that drifts.
    /// </para>
    ///
    /// <para>
    /// <c>door_closes_at</c> is the CODE's expiry — the sold end plus the grace window — because
    /// that is genuinely the door's upper edge, and it is later than the slot. Telling a member
    /// their access ends at their booking's end would be the product understating itself to the
    /// person walking back in for a forgotten racquet.
    /// </para>
    /// </summary>
    private static async Task<object?> NextBookingAsync(
        MainframeDbContext db, TenantSettingsView settings, Guid userId, DateTimeOffset now, CancellationToken ct)
    {
        var horizon = BookingCodeWindow.DoorHorizonMinutes(settings);
        var latestStart = BookingCodeWindow.LatestStart(now, horizon);
        var tail = settings.GraceWindowMinutes;

        var booking = await db.Bookings.AsNoTracking()
            .Where(b => b.UserId == userId
                        && (b.Status == BookingStatus.Booked
                            || b.Status == BookingStatus.NoShow
                            || b.Status == BookingStatus.Completed)
                        && b.StartsAt <= latestStart
                        && b.StartsAt.AddMinutes((b.SliceMinutes * b.SliceCount) + tail) >= now)
            .OrderBy(b => b.StartsAt)
            .Select(b => new { b.StartsAt, b.EndsAt, b.SliceMinutes, b.SliceCount, b.CourtId })
            .FirstOrDefaultAsync(ct);

        if (booking is null) return null;

        var courtNumber = await db.Courts.AsNoTracking()
            .Where(c => c.Id == booking.CourtId).Select(c => (int?)c.CourtNumber).FirstOrDefaultAsync(ct);

        return new
        {
            starts_at = booking.StartsAt,

            // Additive to WIRE-W1: the page shows the slot, and computing its end from
            // SliceMinutes × SliceCount on the client would be a second copy of the one piece
            // of arithmetic the no-show sweep also truncates.
            ends_at = booking.EndsAt,
            court_number = courtNumber,
            door_opens_at = booking.StartsAt.AddMinutes(-horizon),
            door_closes_at = booking.StartsAt.AddMinutes((booking.SliceMinutes * booking.SliceCount) + tail),
        };
    }
}
