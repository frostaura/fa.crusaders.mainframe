using System.Text;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// GOAL item 6 — <i>"an event log and trace per person present's night"</i> — as one read, and
/// <b>the most privacy-consequential surface in this product</b>.
///
/// <para>
/// <c>GOAL.md:42</c> is explicit that this supersedes the doors contract's P5 ("no attendance")
/// <b>for this surface only</b>, and that it is to be designed deliberately rather than allowed
/// to leak into the door log. §6.6's six controls are what "deliberately" means here, and not
/// one of them is a convention:
/// </para>
///
/// <list type="number">
/// <item><b>Admin-only and tenant-filtered.</b> The role is on the group; the member is resolved
/// through the tenant-filtered <c>db.Users</c>, whose filter is a plain equality and must stay
/// one — the disjunction that once let a tenant admin reach a foreign user was reachable through
/// exactly this shape of existence check.</item>
/// <item><b>Retention-bound, and honest about TWO horizons.</b> See
/// <see cref="AdminMemberTraceQuery.DoorRowsMayBeIncomplete"/>.</item>
/// <item><b>Every view is itself recorded</b>, in <c>admin_change_log</c> and NOT in
/// <c>audit_log</c> — see <see cref="RecordAsync"/>.</item>
/// <item><b>A kill switch that answers 404, not 403.</b> A 403 confirms both that the surface
/// exists and that this member has one, which is the fact a club switching it off is trying not
/// to publish.</item>
/// <item><b>No discovery.</b> There is no list endpoint, no search and no traces index in this
/// file or anywhere else. The only way in is a member id an admin already holds.</item>
/// <item><b>The subject fingerprint is never forwarded.</b> <c>DetailsJson</c> is projected field
/// by field by <see cref="AdminMemberTraceAssembly"/>, never returned whole.</item>
/// </list>
///
/// <para>
/// <b>The member is a PATH SEGMENT.</b> That is §6.7's structural mechanism and the reason this
/// route and <c>/api/v1/admin/doors/log</c> share no query type and no handler: you cannot
/// discover a person from the door log, and you can only ask this about a person you already
/// named. A query parameter would be made optional by somebody eventually, and an optional
/// member filter on a log is precisely what P3 forbids.
/// </para>
/// </summary>
public static class AdminMemberTraceEndpoints
{
    /// <summary>
    /// Columns of the export, in the order the rows are written.
    ///
    /// <para>
    /// <b>The two money columns are named <c>amount</c> and <c>balance_after</c>, and a
    /// <c>currency</c> column carries the club's own symbol.</b> They used to be
    /// <c>amount_credits</c> / <c>balance_after_credits</c>, and once the product stopped
    /// writing "credits" as a unit anywhere a member or an admin can read one, a header saying
    /// it was the last place in the export still naming a unit that no longer exists.
    /// </para>
    ///
    /// <para>
    /// The cells stay BARE NUMBERS — a spreadsheet sums a number and cannot sum "R36.00" — so
    /// the unit has to live somewhere, and a column is the only place a per-tenant symbol can
    /// live without making every cell text. It repeats down the file, which is what a currency
    /// column in an export always does and what makes a filtered selection still say what it is
    /// denominated in.
    /// </para>
    ///
    /// <para>
    /// <b>The JSON response's keys are deliberately NOT renamed with these</b> — see
    /// <see cref="Event"/>. That is a wire contract with a console this change does not own.
    /// </para>
    /// </summary>
    private const string Header =
        "date,time,timezone,at_utc,strand,kind,headline,actor,actor_kind,is_self,subject,court," +
        "amount,balance_after,currency,source";

    /// <summary>How many rows the file actually holds, so a page announces the file and not its page size.</summary>
    public const string RowsHeader = "X-Crusaders-Rows";

    /// <summary>
    /// Registers both reads.
    ///
    /// <para>
    /// <b>There is no <c>MapPost</c>, no <c>MapPatch</c> and no <c>MapDelete</c> here, and there
    /// is no route without a <c>{userId}</c> in it.</b> Both absences are the design: a trace is
    /// a read of one named person, and a route that listed traces would be the discovery surface
    /// §6.6.5 exists to refuse.
    /// </para>
    /// </summary>
    public static IEndpointRouteBuilder MapAdminMemberTraceEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1/admin/members/{userId:guid}")
            .RequireAuthorization(p => p.RequireRole("admin"));

        // The export is a sibling path rather than a segment under /trace, matching the doors
        // group's `activity` / `activity.csv` pair: the file and the page answer the same query
        // string, so they read as one surface.
        g.MapGet("/trace.csv", CsvAsync);
        g.MapGet("/trace", HandleAsync);

        return app;
    }

    /// <summary>One page of one member's night.</summary>
    public static async Task<IResult> HandleAsync(
        Guid userId, HttpContext ctx, MainframeDbContext db, TenantSettingsAccessor settings,
        AdminChangeRecorder recorder, CancellationToken ct)
    {
        var (state, asked) = await ResolveAsync(userId, ctx, db, settings, ct);
        if (state is not null) return state;

        var night = await AdminMemberTraceAssembly.BuildAsync(db, asked!.Query, ct);
        await RecordAsync(recorder, ctx, asked, night, export: false, ct);

        return Results.Ok(Body(asked, night));
    }

    /// <summary>
    /// The same night as a file.
    ///
    /// <para>
    /// The export is bounded by the same <c>member_trace_max_events</c> the page is, rather than
    /// by an export ceiling of its own. A trace is one person's evening; a club that has turned
    /// the ceiling up to two thousand has said what it wants in a file, and a second, larger
    /// number here would be a second answer to one question.
    /// </para>
    /// </summary>
    public static async Task<IResult> CsvAsync(
        Guid userId, HttpContext ctx, MainframeDbContext db, TenantSettingsAccessor settings,
        AdminChangeRecorder recorder, CancellationToken ct)
    {
        var (state, asked) = await ResolveAsync(userId, ctx, db, settings, ct);
        if (state is not null) return state;

        var night = await AdminMemberTraceAssembly.BuildAsync(db, asked!.Query, ct);
        await RecordAsync(recorder, ctx, asked, night, export: true, ct);

        var csv = new StringBuilder(Header).Append("\r\n");
        foreach (var row in night.Page) csv.Append(Line(asked.Query, row));

        ctx.Response.Headers[RowsHeader] =
            night.Page.Count.ToString(System.Globalization.CultureInfo.InvariantCulture);

        // A UTF-8 BOM, because Excel reads a BOM-less UTF-8 file in the machine's legacy code
        // page and a club whose member is named "José" gets mojibake in a record about her.
        var bytes = Encoding.UTF8.GetPreamble()
            .Concat(Encoding.UTF8.GetBytes(csv.ToString())).ToArray();

        ctx.Response.Headers.ContentDisposition = $"attachment; filename=\"{FileName(asked)}\"";
        return Results.File(bytes, "text/csv; charset=utf-8");
    }

    /// <summary>The member this club knows by that id.</summary>
    private sealed record TracedMember(Guid UserId, string Name, string MembershipNumber, string? PhotoUrl);

    /// <summary>
    /// A request that got past all three refusals: the range it resolved to, and who it is about.
    ///
    /// <para>
    /// The two travel together because every step after this point needs both, and carrying them
    /// as one value is what keeps the privacy record's signature inside the complexity gate's
    /// parameter ceiling — a limit worth respecting here rather than whitelisting, because this
    /// is the file where a long argument list would start hiding what is being passed about a
    /// person.
    /// </para>
    /// </summary>
    private sealed record Asked(AdminMemberTraceQuery Query, TracedMember Member);

    /// <summary>
    /// The three ways in: switched off, nobody by that id, or a range this server cannot bound.
    ///
    /// <para>
    /// <b>The kill switch is checked BEFORE the member is looked up</b>, so a club that has
    /// turned the trace off cannot have the existence of one of its members confirmed through
    /// the difference between two 404s. Both answers are a bare 404 with no body for the same
    /// reason — see <see cref="AdminMemberTraceQuery.MemberNotFound"/>, and note that the error
    /// code exists for the console's benefit on the member answer only.
    /// </para>
    /// </summary>
    private static async Task<(IResult? State, Asked? Ok)> ResolveAsync(
        Guid userId, HttpContext ctx, MainframeDbContext db, TenantSettingsAccessor settings, CancellationToken ct)
    {
        var view = await settings.GetAsync(ct);
        if (!TraceSettings.Enabled(view)) return (Results.NotFound(), null);

        var (query, error) = AdminMemberTraceQuery.Parse(ctx.Request, view, userId, DateTimeOffset.UtcNow);
        if (error is not null) return (Results.BadRequest(new { error }), null);

        var member = await MemberAsync(db, userId, ct);
        if (member is null)
        {
            return (Results.NotFound(new { error = AdminMemberTraceQuery.MemberNotFound }), null);
        }

        return (null, new Asked(query!, member));
    }

    /// <summary>
    /// The member, resolved through the TENANT-FILTERED sets and through nothing this method
    /// compares.
    ///
    /// <para>
    /// A foreign club's member id is therefore indistinguishable from an invented one: the
    /// isolation is structural rather than a claim checked, which is the only form of it this
    /// repository accepts. The <c>Users</c> read is what decides existence — a person may have a
    /// user row and no membership row yet, and answering 404 for them would hide a real member of
    /// this club from the one surface that can say where they were.
    /// </para>
    /// </summary>
    private static async Task<TracedMember?> MemberAsync(MainframeDbContext db, Guid userId, CancellationToken ct)
    {
        var exists = await db.Users.AsNoTracking().AnyAsync(u => u.Id == userId, ct);
        if (!exists) return null;

        var membership = await db.Memberships.AsNoTracking()
            .Where(m => m.UserId == userId)
            .Select(m => new { m.FullName, m.MembershipNumber, m.PhotoUrl })
            .FirstOrDefaultAsync(ct);

        return new TracedMember(
            userId,
            membership?.FullName ?? AdminChangeRecorder.UnknownActorName,
            membership?.MembershipNumber ?? "",
            membership?.PhotoUrl);
    }

    /// <summary>
    /// <b>The privacy record, and the reason it is in THIS table.</b>
    ///
    /// <para>
    /// One <c>member.trace_viewed</c> row per request, into <c>admin_change_log</c> and NOT into
    /// <c>audit_log</c>: <c>audit_log</c> has a delete path (<c>RetentionWorker</c>'s door
    /// purge), and <b>a surveillance-capable surface whose access log can be deleted is not
    /// audited</b>. The change record is trigger-protected and exempt from retention, so this
    /// row outlives everything it describes.
    /// </para>
    ///
    /// <para>
    /// It is written with <c>RecordAsync</c> rather than staged, because the trace is a READ and
    /// there is nothing else to save; and it is written on the way OUT, after the assembly, so
    /// the row can say how much was actually looked at rather than how much was asked for.
    /// </para>
    /// </summary>
    private static Task RecordAsync(
        AdminChangeRecorder recorder, HttpContext ctx, Asked asked, TraceNight night,
        bool export, CancellationToken ct)
    {
        var query = asked.Query;
        return recorder.RecordAsync(new AdminChange(
            Action: AdminChangeActions.MemberTraceViewed,
            ActorUserId: ctx.User.Id() ?? Guid.Empty,
            SubjectKind: AdminChangeSubjects.User,
            SubjectId: asked.Member.UserId,
            SubjectLabel: asked.Member.Name,
            After: new
            {
                day = query.ClubDay?.ToString("yyyy-MM-dd"),
                range = new { from = query.From, to = query.To },
                strands_returned = night.Page.Select(e => e.Strand).Distinct().Order().ToList(),
                event_count = night.Page.Count,
                total = night.Total,
                exported = export,
            }), ct);
    }

    // ------------------------------------------------------------------ the wire

    /// <summary>
    /// The response, exactly as D2 §6.2 states it.
    ///
    /// <para>
    /// A night with nothing in it is a <b>200 with an empty <c>events</c> array and a populated
    /// summary of zeros</b>, never a 404 and never an empty body. "Nobody was here that night"
    /// is an answer; "we could not look" is a different one; the response distinguishes them by
    /// <c>retention.door_rows_may_be_incomplete</c> and by the presence of the <c>member</c>
    /// block. Block body for the lizard reason in <c>memory/gotchas.md</c>.
    /// </para>
    /// </summary>
    private static object Body(Asked asked, TraceNight night)
    {
        var query = asked.Query;
        var member = asked.Member;
        return new
        {
            member = new
            {
                user_id = member.UserId,
                name = member.Name,
                membership_number = member.MembershipNumber,
                photo_url = member.PhotoUrl,
            },
            club_day = query.ClubDay?.ToString("yyyy-MM-dd"),
            range = new { from = query.From, to = query.To },
            timezone = query.Timezone,
            retention = new
            {
                audit_days = query.AuditDays,
                door_days = query.DoorDays,
                door_horizon = TimeZoneInfo.ConvertTime(query.DoorHorizon, query.Zone).ToString("yyyy-MM-dd"),
                door_rows_may_be_incomplete = query.DoorRowsMayBeIncomplete,
            },
            summary = Summary(night.Summary),
            events = night.Page.Select(e => Event(query, e)).ToList(),
            total = night.Total,
            cursor = night.Cursor,
        };
    }

    /// <summary>Block body for the lizard reason in <c>memory/gotchas.md</c>.</summary>
    private static object Summary(TraceSummary s)
    {
        return new
        {
            first_seen_at = s.FirstSeenAt,
            last_seen_at = s.LastSeenAt,
            minutes_on_court = s.MinutesOnCourt,
            courts = s.Courts,
            credits_spent = s.CreditsSpent,
            credits_received = s.CreditsReceived,
            doors_entered = s.DoorsEntered,
            doors_refused = s.DoorsRefused,
            bookings_made = s.BookingsMade,
            bookings_cancelled = s.BookingsCancelled,
        };
    }

    /// <summary>
    /// One event as the console reads it — the word and the sentence already composed, the actor
    /// already classified.
    ///
    /// <para>
    /// <c>actor.is_admin</c> is derived from <c>actor.kind</c> and not computed a second way, so
    /// the two can never disagree; both are read from <c>users.IsAdmin</c> and never from
    /// <c>ActorUserId != SubjectUserId</c>, which is D2-B41. Block body for the lizard reason in
    /// <c>memory/gotchas.md</c>.
    /// </para>
    ///
    /// <para>
    /// <b><c>amount_credits</c> and <c>balance_after_credits</c> keep their names here while the
    /// CSV's columns were renamed, and the difference is deliberate.</b> These are wire keys a
    /// console already reads; the CSV's are column captions a person reads. Renaming the first
    /// pair is a breaking change to a client this change does not own, and the figures are bare
    /// numbers either way — the composed <c>headline</c> beside them is where this surface says
    /// what they are denominated in.
    /// </para>
    /// </summary>
    private static object Event(AdminMemberTraceQuery query, TraceEventRow e)
    {
        return new
        {
            at = e.At,
            strand = e.Strand,
            kind = e.Kind,
            headline = e.Headline,
            detail = e.Detail,
            actor = new
            {
                user_id = e.ActorUserId == Guid.Empty ? (Guid?)null : e.ActorUserId,
                name = e.ActorName,
                kind = e.ActorKind,
                is_self = e.IsSelf(query.UserId),
                is_admin = e.ActorKind == TraceActors.Admin,
            },
            subject = e.SubjectUserId is null
                ? null
                : new { user_id = e.SubjectUserId, name = e.SubjectName },
            court = e.Court is null
                ? null
                : new { id = e.Court.Id, number = e.Court.Number, name = e.Court.Name },
            amount_credits = e.AmountCredits,
            balance_after_credits = e.BalanceAfterCredits,
            source = e.Source,
            source_id = e.SourceId,
        };
    }

    /// <summary>One CSV line, defused then quoted by <see cref="CsvCell"/>.</summary>
    private static string Line(AdminMemberTraceQuery query, TraceEventRow e)
    {
        var local = TimeZoneInfo.ConvertTime(e.At, query.Zone);
        return CsvCell.Line(
            local.ToString("yyyy-MM-dd"),
            local.ToString("HH:mm:ss"),
            query.Timezone,
            e.At.ToUniversalTime().ToString("yyyy-MM-dd HH:mm:ss"),
            e.Strand,
            e.Kind,
            e.Headline,
            e.ActorName,
            e.ActorKind,
            e.IsSelf(query.UserId) ? "yes" : "no",
            e.SubjectName,
            e.Court?.Name,
            Number(e.AmountCredits),
            Number(e.BalanceAfterCredits),
            Currency(e, query),
            e.Source);
    }

    /// <summary>A figure as a spreadsheet should read it, or blank where the row carries none.</summary>
    private static string Number(decimal? value)
    {
        return value is { } amount
            ? amount.ToString("0.00", System.Globalization.CultureInfo.InvariantCulture)
            : "";
    }

    /// <summary>
    /// The club's symbol, on the rows that carry a figure, and blank on the rows that do not.
    ///
    /// <para>
    /// A door opening and a relay closing are not movements of zero — they are rows that never
    /// touched the balance — and stamping a currency on them would invite a reader to total a
    /// column of blanks. Same rule as the night trace's own dash; see
    /// <see cref="Services.TraceKinds"/>.
    /// </para>
    /// </summary>
    private static string Currency(TraceEventRow e, AdminMemberTraceQuery query)
    {
        return e.AmountCredits is null && e.BalanceAfterCredits is null ? "" : query.CurrencySymbol;
    }

    /// <summary>
    /// What the file is called: the person and the exact range it holds, in the club's own zone.
    ///
    /// <para>
    /// The door log's lesson (A4) — a file is forwarded, printed and filed under its name, so the
    /// name has to be the range rather than a shape the range usually has. The MEMBERSHIP NUMBER
    /// rather than the name, because a filename is the one part of this export that travels
    /// outside the club's own systems. Block body for the lizard reason in
    /// <c>memory/gotchas.md</c>.
    /// </para>
    /// </summary>
    private static string FileName(Asked asked)
    {
        var query = asked.Query;
        var member = asked.Member;
        var who = string.Concat((member.MembershipNumber.Length > 0 ? member.MembershipNumber : "member")
            .Where(c => char.IsAsciiLetterOrDigit(c) || c == '-'));
        if (query.ClubDay is { } day) return $"member-trace-{who}-{day:yyyy-MM-dd}.csv";

        var from = TimeZoneInfo.ConvertTime(query.From, query.Zone);
        var to = TimeZoneInfo.ConvertTime(query.To, query.Zone);
        return $"member-trace-{who}-{from:yyyy-MM-dd-HHmm}-{to:yyyy-MM-dd-HHmm}.csv";
    }
}
