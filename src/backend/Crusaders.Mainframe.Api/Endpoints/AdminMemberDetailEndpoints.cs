using System.Text.Json.Serialization;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// R17 — "the per-person views live on the member" — as two reads: everything an admin needs
/// on one screen about one person, and that person's bookings a page at a time.
///
/// <para>
/// <b>Keyed on the USER id, not the membership id.</b> The older member routes (approve,
/// suspend, spend) take the membership id; the trace, the admin-role switch and this detail
/// take the user id, because a person can hold an account with no membership row — a bootstrap
/// administrator is exactly that — and a detail screen that 404s for one of the club's own
/// admins is a screen that lies about who runs the club. Both ids are on every row of
/// <c>GET /api/v1/admin/members</c>, so a console never has to translate.
/// </para>
///
/// <para>
/// <b>Tenant isolation is structural here, as everywhere.</b> Every read goes through the
/// tenant-filtered sets, so another club's user id is indistinguishable from an invented one:
/// both answer <c>404 member_not_found</c>. Nothing in this file compares a tenant id.
/// </para>
///
/// <para>
/// <b>What is deliberately absent.</b> No phone number — the product has never collected one
/// (<c>docs/development-plan.md</c>'s libphonenumber is unbuilt, see
/// <c>memory/decisions.md</c>). No door rows — those are
/// <see cref="AdminMemberDoorEndpoints"/>, whose every read is audited, and folding a door
/// count into this unaudited aggregate would make the audit a formality.
/// </para>
/// </summary>
public static class AdminMemberDetailEndpoints
{
    /// <summary>The refusal for a user id this club does not hold.</summary>
    public const string MemberNotFound = "member_not_found";

    /// <summary>How many upcoming bookings the detail carries. The bookings route has the rest.</summary>
    public const int NextBookingsShown = 5;

    /// <summary>The trailing window the detail's three counts are taken over.</summary>
    public const int CountWindowDays = 30;

    /// <summary>Rows per bookings page when the caller does not ask.</summary>
    public const int DefaultBookingsLimit = 20;

    /// <summary>Most rows one bookings page returns, clamped rather than refused.</summary>
    public const int MaxBookingsLimit = 100;

    /// <summary><c>?when=</c> for bookings that have not finished yet. The default.</summary>
    public const string Upcoming = "upcoming";

    /// <summary><c>?when=</c> for bookings whose end has passed.</summary>
    public const string Past = "past";

    public static IEndpointRouteBuilder MapAdminMemberDetailEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1/admin/members/{userId:guid}")
            .RequireAuthorization(p => p.RequireRole("admin"));

        g.MapGet("/", DetailAsync);
        g.MapGet("/bookings", BookingsAsync);

        return app;
    }

    // ------------------------------------------------------------------ detail

    /// <summary>
    /// <c>GET /api/v1/admin/members/{userId}</c> — one person, aggregated.
    /// </summary>
    public static async Task<IResult> DetailAsync(
        Guid userId, MainframeDbContext db, InherentAdmins inherent, LedgerService ledger,
        TenantSettingsAccessor settings, CancellationToken ct)
    {
        var user = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Id == userId, ct);
        if (user is null) return Results.NotFound(new { error = MemberNotFound });

        var membership = await db.Memberships.AsNoTracking().FirstOrDefaultAsync(m => m.UserId == userId, ct);
        var now = DateTimeOffset.UtcNow;
        var tariff = await MemberTariffs.ForAsync(db, userId, await settings.GetAsync(ct), ct);
        var held = await ledger.GetHeldAsync(userId, ct);

        return Results.Ok(new
        {
            user_id = user.Id,
            membership_id = membership?.Id,
            full_name = membership?.FullName,
            email = user.Email,
            membership_number = membership?.MembershipNumber,

            // The MEMBERSHIP's status — PendingApproval / Active / Rejected / Suspended, exactly
            // as the members list spells it — or null for an account with no membership row. The
            // account's own status is separate because they are two different switches.
            status = membership?.Status.ToString(),
            account_status = user.Status,
            email_verified = user.EmailVerified,
            created_at = membership?.CreatedAt ?? user.CreatedAt,
            last_login_at = user.LastLoginAt,
            photo_url = membership?.PhotoUrl,
            is_admin = user.IsAdmin,
            admin_source = AdminSource.Of(user.IsAdmin, user.Email, inherent),
            groups = AdminMemberEndpoints.GroupsWire(tariff.Groups),
            // D2: what the groups add up to for money and the peak window, resolved by the same
            // MemberTariffs rule the top-up and the booking path read, so the screen cannot
            // explain a rate the POST would not quote.
            tariff = new
            {
                top_up_credits_per_zar = tariff.TopUpRate,
                rate_group_id = tariff.RateGroup?.Id,
                peak_priority = tariff.PeakPriority,
                peak_withheld_by = tariff.PeakWithheldBy,
            },
            balance_credits = await ledger.GetBalanceAsync(userId, ct),
            // D11: the same held / owed-back figures the member's own wallet shows, so the desk
            // sees that part of a balance belongs to partners before it acts on it.
            held_credits = held.Held,
            owed_back_credits = held.OwedBack,
            held_until = held.ReleasesAt,
            passkey_count = await db.WebAuthnCredentials.AsNoTracking().CountAsync(c => c.UserId == userId, ct),
            fingerprints = await FingerprintsAsync(db, userId, ct),
            next_bookings = await NextBookingsAsync(db, userId, now, ct),
            counts_30d = await CountsAsync(db, userId, now, ct),
        });
    }

    /// <summary>
    /// The fingerprints enrolled for this person at the court boxes — live templates only.
    ///
    /// <para>
    /// A SUPERSEDED template is one an admin deleted (or a re-enrolment replaced); it no longer
    /// identifies anybody, so counting it would tell an admin the member can use a finger that
    /// every box has already forgotten. The template id travels so the console can offer the
    /// existing <c>DELETE /api/v1/admin/biometric/templates/{templateId}</c> from here.
    /// </para>
    /// </summary>
    private static async Task<FingerprintSummary> FingerprintsAsync(
        MainframeDbContext db, Guid userId, CancellationToken ct)
    {
        var enrolments = await db.EnrolledTemplates.AsNoTracking()
            .Where(t => t.UserId == userId && t.SupersededAt == null)
            .OrderBy(t => t.CreatedAt)
            .Select(t => new FingerprintEnrolment(t.TemplateId, t.FingerLabel, t.CreatedAt))
            .ToListAsync(ct);
        return new FingerprintSummary(enrolments.Count, enrolments);
    }

    /// <summary>
    /// Up to <see cref="NextBookingsShown"/> bookings still to be played, soonest first — the
    /// same rows the first page of <c>?when=upcoming</c> starts with, minus the cancelled ones,
    /// because "next" means courts this person is actually going to be on.
    /// </summary>
    private static async Task<List<MemberBookingRow>> NextBookingsAsync(
        MainframeDbContext db, Guid userId, DateTimeOffset now, CancellationToken ct)
    {
        var rows = await db.Bookings.AsNoTracking()
            .Where(b => b.UserId == userId && b.Status == BookingStatus.Booked && b.EndsAt > now)
            .OrderBy(b => b.StartsAt).ThenBy(b => b.Id)
            .Take(NextBookingsShown)
            .ToListAsync(ct);
        return await MemberBookingRow.ProjectAsync(db, userId, rows, ct);
    }

    /// <summary>
    /// Three numbers over the trailing <see cref="CountWindowDays"/> days, each keyed on the
    /// booking's START.
    ///
    /// <para>
    /// <c>bookings</c> counts every booking that was not cancelled; <c>no_shows</c> counts the
    /// sweep's verdicts; <c>sessions_played</c> counts bookings with a <c>CheckedInAt</c> —
    /// <b>attendance means <c>CheckedInAt</c>, never the clock and never <c>ChargedAt</c></b>,
    /// which under charge-at-booking is set on every row. A no-show later reversed by late box
    /// evidence carries a <c>CheckedInAt</c> and is counted as played, which is the truth.
    /// </para>
    /// </summary>
    private static async Task<ActivityCounts> CountsAsync(
        MainframeDbContext db, Guid userId, DateTimeOffset now, CancellationToken ct)
    {
        var from = now.AddDays(-CountWindowDays);
        var window = db.Bookings.AsNoTracking()
            .Where(b => b.UserId == userId && b.StartsAt >= from && b.StartsAt < now);

        return new ActivityCounts(
            Bookings: await window.CountAsync(
                b => b.Status != BookingStatus.Cancelled && b.Status != BookingStatus.AdminBlock, ct),
            NoShows: await window.CountAsync(b => b.Status == BookingStatus.NoShow, ct),
            SessionsPlayed: await window.CountAsync(b => b.CheckedInAt != null, ct));
    }

    // ------------------------------------------------------------------ bookings

    /// <summary>
    /// <c>GET /api/v1/admin/members/{userId}/bookings?when=upcoming|past&amp;cursor&amp;limit</c>.
    ///
    /// <para>
    /// <b>Every status is returned, cancelled included.</b> This is the admin's record of what a
    /// person booked, and "they cancelled it on Tuesday" is often the answer the desk is looking
    /// for; the row's <c>status</c> and <c>cancelled_at</c> say which it is.
    /// </para>
    ///
    /// <para>
    /// <b>Split on the booking's END, not its start.</b> A session in progress has not finished
    /// and belongs with what is coming, not with the history. Upcoming reads soonest first;
    /// past reads most recent first. The cursor is a keyset over <c>(starts_at, id)</c> in the
    /// same direction as the page — an offset would repeat or skip a row every time the member
    /// booked while an admin paged.
    /// </para>
    /// </summary>
    public static async Task<IResult> BookingsAsync(
        Guid userId, HttpContext ctx, MainframeDbContext db, CancellationToken ct)
    {
        var (asked, error) = BookingsQuery.Parse(ctx.Request);
        if (error is not null) return Results.BadRequest(new { error });

        if (!await db.Users.AsNoTracking().AnyAsync(u => u.Id == userId, ct))
        {
            return Results.NotFound(new { error = MemberNotFound });
        }

        var rows = await asked!.Apply(db.Bookings.AsNoTracking().Where(b => b.UserId == userId), DateTimeOffset.UtcNow)
            .Take(asked.Limit + 1)
            .ToListAsync(ct);

        var page = rows.Take(asked.Limit).ToList();
        return Results.Ok(new
        {
            when = asked.When,
            items = await MemberBookingRow.ProjectAsync(db, userId, page, ct),
            next_cursor = rows.Count > asked.Limit && page.Count > 0
                ? new DoorLogCursor(page[^1].StartsAt, page[^1].Id).Encode()
                : null,
        });
    }

}

/// <summary>
/// What a bookings page was asked for.
///
/// <para>
/// The cursor reuses <see cref="DoorLogCursor"/>'s encoding — an instant and a row id, base64 —
/// rather than inventing a second opaque format for the same two values. It is the booking's
/// <c>StartsAt</c> here, not a scan instant.
/// </para>
/// </summary>
public sealed record BookingsQuery(string When, int Limit, DoorLogCursor? Cursor)
{
    /// <summary>The refusal when <c>?when=</c> is neither <c>upcoming</c> nor <c>past</c>.</summary>
    public const string WhenInvalid = "when_invalid";

    /// <summary>The refusal when <c>?limit=</c> is present and is not an integer.</summary>
    public const string LimitInvalid = "limit_invalid";

    /// <summary>The refusal when <c>?cursor=</c> is present and is not one of ours.</summary>
    public const string CursorInvalid = "cursor_invalid";

    /// <summary>
    /// Reads the query string. A closed vocabulary or a value that is not a number is refused by
    /// name; a limit out of range is clamped. The same three answers the door log gives, for the
    /// reasons <see cref="DoorLogQuery"/> records.
    /// </summary>
    public static (BookingsQuery? Query, string? Error) Parse(HttpRequest request)
    {
        var when = Text(request, "when") ?? AdminMemberDetailEndpoints.Upcoming;
        if (when is not (AdminMemberDetailEndpoints.Upcoming or AdminMemberDetailEndpoints.Past))
        {
            return (null, WhenInvalid);
        }

        var limitText = Text(request, "limit");
        var limit = AdminMemberDetailEndpoints.DefaultBookingsLimit;
        if (limitText is not null && !int.TryParse(limitText, System.Globalization.NumberStyles.AllowLeadingSign,
                System.Globalization.CultureInfo.InvariantCulture, out limit))
        {
            return (null, LimitInvalid);
        }

        var cursorText = Text(request, "cursor");
        var cursor = DoorLogCursor.Parse(cursorText);
        if (cursorText is not null && cursor is null) return (null, CursorInvalid);

        return (new BookingsQuery(when, Math.Clamp(limit, 1, AdminMemberDetailEndpoints.MaxBookingsLimit), cursor), null);
    }

    /// <summary>
    /// The window, the cursor and the order, applied to one person's bookings.
    ///
    /// <para>
    /// Block body for the lizard reason in <c>memory/gotchas-gates.md</c>.
    /// </para>
    /// </summary>
    public IQueryable<Booking> Apply(IQueryable<Booking> mine, DateTimeOffset now)
    {
        var rows = mine.Where(b => b.Status != BookingStatus.AdminBlock);

        if (When == AdminMemberDetailEndpoints.Upcoming)
        {
            rows = rows.Where(b => b.EndsAt > now);
            if (Cursor is { } after)
            {
                rows = rows.Where(b => b.StartsAt > after.At || (b.StartsAt == after.At && b.Id.CompareTo(after.Id) > 0));
            }
            return rows.OrderBy(b => b.StartsAt).ThenBy(b => b.Id);
        }

        rows = rows.Where(b => b.EndsAt <= now);
        if (Cursor is { } before)
        {
            rows = rows.Where(b => b.StartsAt < before.At || (b.StartsAt == before.At && b.Id.CompareTo(before.Id) < 0));
        }
        return rows.OrderByDescending(b => b.StartsAt).ThenByDescending(b => b.Id);
    }

    private static string? Text(HttpRequest request, string key)
    {
        var value = request.Query[key].ToString();
        return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
    }
}

/// <summary>
/// One booking as the member-detail surfaces print it — the detail's <c>next_bookings</c> and
/// every page of <c>/bookings</c> share this shape, so a console renders one row component.
/// </summary>
/// <remarks>
/// Snake-case names are pinned per property because this API has no global naming policy — the
/// anonymous objects everywhere else are written in snake case by hand, and a record left to the
/// default would reach the wire in camelCase beside them.
/// </remarks>
public sealed record MemberBookingRow(
    [property: JsonPropertyName("booking_id")] Guid BookingId,
    [property: JsonPropertyName("court_id")] Guid CourtId,
    [property: JsonPropertyName("court_name")] string? CourtName,
    [property: JsonPropertyName("starts_at")] DateTimeOffset StartsAt,
    [property: JsonPropertyName("ends_at")] DateTimeOffset EndsAt,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("charged_credits")] decimal ChargedCredits,
    [property: JsonPropertyName("checked_in_at")] DateTimeOffset? CheckedInAt,
    [property: JsonPropertyName("cancelled_at")] DateTimeOffset? CancelledAt,
    [property: JsonPropertyName("booked_by")] MemberBookingActor BookedBy)
{
    /// <summary>
    /// The rows, with their court names and the names of whoever booked them, in two reads
    /// rather than 2n.
    ///
    /// <para>
    /// <c>booked_by</c> is the booking's <c>ActorUserId</c> — who pressed the button — because
    /// <c>BookedByUserId</c> is set to the member on every row, including the ones an admin
    /// booked on their behalf, and a column that always names the member answers nothing.
    /// <c>is_self</c> is that comparison, and nothing more is inferred from it: whether the
    /// actor was an ADMIN is a fact about <c>users.IsAdmin</c>, not about two ids differing
    /// (D2-B41), and this row does not claim it.
    /// </para>
    /// </summary>
    public static async Task<List<MemberBookingRow>> ProjectAsync(
        MainframeDbContext db, Guid userId, IReadOnlyList<Booking> rows, CancellationToken ct)
    {
        if (rows.Count == 0) return [];

        var courtIds = rows.Select(r => r.CourtId).Distinct().ToList();
        var courts = await db.Courts.AsNoTracking()
            .Where(c => courtIds.Contains(c.Id))
            .ToDictionaryAsync(c => c.Id, c => c.Name, ct);
        var names = await PersonNames.ForAsync(db, rows.Select(r => (Guid?)r.ActorUserId), ct);

        return rows.Select(b => new MemberBookingRow(
            BookingId: b.Id,
            CourtId: b.CourtId,
            CourtName: courts.TryGetValue(b.CourtId, out var court) ? court : null,
            StartsAt: b.StartsAt,
            EndsAt: b.EndsAt,
            Status: b.Status.ToString().ToLowerInvariant(),
            ChargedCredits: b.AmountChargedCredits,
            CheckedInAt: b.CheckedInAt,
            CancelledAt: b.CancelledAt,
            BookedBy: new MemberBookingActor(
                b.ActorUserId == Guid.Empty ? null : b.ActorUserId,
                PersonNames.Of(b.ActorUserId, names),
                b.ActorUserId == userId))).ToList();
    }
}

/// <summary>Who made a booking: their id and name, and whether it was the member themselves.</summary>
public sealed record MemberBookingActor(
    [property: JsonPropertyName("user_id")] Guid? UserId,
    [property: JsonPropertyName("name")] string? Name,
    [property: JsonPropertyName("is_self")] bool IsSelf);

/// <summary>The fingerprints a member has enrolled: how many, and which.</summary>
public sealed record FingerprintSummary(
    [property: JsonPropertyName("count")] int Count,
    [property: JsonPropertyName("enrolments")] IReadOnlyList<FingerprintEnrolment> Enrolments);

/// <summary>One live fingerprint template.</summary>
public sealed record FingerprintEnrolment(
    [property: JsonPropertyName("template_id")] string TemplateId,
    [property: JsonPropertyName("finger_label")] string? FingerLabel,
    [property: JsonPropertyName("enrolled_at")] DateTimeOffset EnrolledAt);

/// <summary>The detail's three trailing counts.</summary>
public sealed record ActivityCounts(
    [property: JsonPropertyName("bookings")] int Bookings,
    [property: JsonPropertyName("no_shows")] int NoShows,
    [property: JsonPropertyName("sessions_played")] int SessionsPlayed);
