using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>A court as a trace row names it. Null on every row that is not about one.</summary>
public sealed record TraceCourtRef(Guid Id, int Number, string Name);

/// <summary>One row of a member's night, before it is turned into JSON or a CSV line.</summary>
/// <param name="At">The instant the row PRINTS at — the scan's own instant for an offline door row.</param>
/// <param name="SourceId">Its id in its own table, which with <c>At</c> makes the list's order total.</param>
public sealed record TraceEventRow(
    DateTimeOffset At,
    Guid SourceId,
    string Source,
    string Kind,
    string Headline,
    Guid ActorUserId,
    string ActorKind,
    string? ActorName,
    Guid? SubjectUserId,
    string? SubjectName,
    TraceCourtRef? Court,
    decimal? AmountCredits,
    decimal? BalanceAfterCredits,
    IReadOnlyDictionary<string, object?> Detail)
{
    /// <summary>The strand, derived from the word rather than carried twice.</summary>
    public string Strand => TraceKinds.StrandOf(Kind);

    /// <summary>
    /// Whether the person whose night this is did it themselves.
    ///
    /// <para>
    /// <see cref="Guid.Empty"/> is never self: it is the club's own machinery, and a trace that
    /// answered <c>is_self</c> for a system row would be telling a member they did something a
    /// worker did at three in the morning.
    /// </para>
    /// </summary>
    public bool IsSelf(Guid traced) => ActorUserId != Guid.Empty && ActorUserId == traced;
}

/// <summary>
/// What the night added up to. Computed over the FILTERED RANGE and never over the page, for the
/// reason <see cref="DoorLogQuery.Filtered"/> gives about a heading that states a number it
/// cannot know.
/// </summary>
public sealed record TraceSummary(
    DateTimeOffset? FirstSeenAt, DateTimeOffset? LastSeenAt, int MinutesOnCourt,
    IReadOnlyList<string> Courts, decimal CreditsSpent, decimal CreditsReceived,
    int DoorsEntered, int DoorsRefused, int BookingsMade, int BookingsCancelled);

/// <summary>One member's night: the page the caller asked for, and what the whole range came to.</summary>
public sealed record TraceNight(
    IReadOnlyList<TraceEventRow> Page, int Total, string? Cursor, TraceSummary Summary);

/// <summary>
/// Assembles one member's night from the three places this product records one.
///
/// <para>
/// <b>Three queries, unioned in memory, not one SQL union</b> (D2 §6.3). The sources have three
/// different shapes; a <c>UNION</c> over jsonb projections is unreadable, unindexable and would
/// defeat the keyset cursor. At a racquet club's volume — one person, one day — each query
/// returns tens of rows, and the three indexes this needs already exist.
/// </para>
///
/// <para>
/// <b>Each strand is read on <c>subject OR actor</c>, and the second half is the point.</b> An
/// admin cancelling Priya's court writes <c>SubjectUserId = Priya, ActorUserId = admin</c>. That
/// row belongs on Priya's trace with the admin named — and on the ADMIN'S own trace, when
/// somebody asks what that admin did. Both are one query with an <c>OR</c>, which is what makes
/// "who performed each" answerable in both directions.
/// </para>
///
/// <para>
/// <b><c>DetailsJson</c> is projected field by field and never returned whole</b> (§6.6.6). A
/// scan's details carry a hashed subject fingerprint and the club's gate key; a settlement's
/// carry a board's boot id and sequence. None of that is a fact about somebody's evening, and a
/// surface returning the document whole publishes every field any writer ever adds to it.
/// </para>
/// </summary>
public static class AdminMemberTraceAssembly
{
    /// <summary>The row came from <c>audit_log</c>.</summary>
    public const string AuditSource = "audit_log";

    /// <summary>The row came from <c>ledger_entries</c>.</summary>
    public const string LedgerSource = "ledger";

    /// <summary>The row came from <c>device_event_receipts</c> — what a relay actually did.</summary>
    public const string ReceiptSource = "device_event_receipt";

    /// <summary>One receipt with its booking's court already resolved.</summary>
    private sealed record ReceiptRow(
        Guid Id, DateTimeOffset OccurredAt, string Kind, Guid BookingId, Guid CourtId, int? Relay, Guid DeviceId);

    /// <summary>Everything the three reads produced, before any of it is a sentence.</summary>
    private sealed record Strands(
        List<AuditLog> Audit, List<LedgerEntry> Ledger, List<ReceiptRow> Receipts,
        Dictionary<Guid, TraceCourtRef> Courts, Dictionary<Guid, Guid> BookingCourts,
        List<Guid> NotADoor, Dictionary<Guid, string> Names, HashSet<Guid> Admins, decimal Opening);

    public static async Task<TraceNight> BuildAsync(
        MainframeDbContext db, AdminMemberTraceQuery query, CancellationToken ct)
    {
        var strands = await ReadAsync(db, query, ct);

        var merged = new List<TraceEventRow>(
            strands.Audit.Count + strands.Ledger.Count + strands.Receipts.Count);
        merged.AddRange(AuditEvents(strands, query));
        merged.AddRange(LedgerEvents(strands, query));
        merged.AddRange(ReceiptEvents(strands, query));

        // OLDEST FIRST — a night reads forwards: she arrived, the lights came on, she paid, she
        // left. The tie-break on the row's own id is what makes the order TOTAL, which the
        // cursor depends on: two rows at one instant across two strands is an ordinary evening
        // (a court activation and the charge it caused are written together).
        merged.Sort(static (a, b) => a.At != b.At ? a.At.CompareTo(b.At) : a.SourceId.CompareTo(b.SourceId));

        var summary = Summarise(merged, strands.Receipts, query.UserId);

        var after = query.Cursor is { } cursor
            ? merged.Where(e => cursor.Precedes(e.At, e.SourceId)).ToList()
            : merged;
        var page = after.Take(query.Limit).ToList();
        var more = after.Count > page.Count;

        return new TraceNight(
            Page: page,
            Total: merged.Count,
            Cursor: more && page.Count > 0
                ? new AdminMemberTraceCursor(page[^1].At, page[^1].SourceId).Encode()
                : null,
            Summary: summary);
    }

    // ------------------------------------------------------------------ the three reads

    private static async Task<Strands> ReadAsync(
        MainframeDbContext db, AdminMemberTraceQuery q, CancellationToken ct)
    {
        var audit = await AuditRowsAsync(db, q, ct);
        var ledger = await LedgerRowsAsync(db, q, ct);
        var receipts = await ReceiptRowsAsync(db, q, ct);

        var courts = await db.Courts.AsNoTracking()
            .Select(c => new TraceCourtRef(c.Id, c.CourtNumber, c.Name))
            .ToDictionaryAsync(c => c.Id, c => c, ct);

        var bookingIds = ledger
            .Where(l => l.RelatedBookingId is not null)
            .Select(l => l.RelatedBookingId!.Value)
            .Distinct()
            .ToList();
        var bookingCourts = await db.Bookings.AsNoTracking()
            .Where(b => bookingIds.Contains(b.Id))
            .Select(b => new { b.Id, b.CourtId })
            .ToDictionaryAsync(b => b.Id, b => b.CourtId, ct);

        var people = audit.SelectMany(a => new Guid?[] { a.ActorUserId, a.SubjectUserId })
            .Concat(ledger.SelectMany(l => new Guid?[] { l.ActorUserId, l.UserId }));
        var names = await PersonNames.ForAsync(db, people, ct);
        var admins = await AdminsAsync(
            db, audit.Select(a => a.ActorUserId).Concat(ledger.Select(l => l.ActorUserId)), ct);

        return new Strands(
            audit, ledger, receipts, courts, bookingCourts,
            await DoorTrail.NotADoorIdsAsync(db, ct), names, admins,
            await OpeningBalanceAsync(db, q, ct));
    }

    /// <summary>
    /// Everything <c>audit_log</c> holds about this person in this window, in either direction.
    ///
    /// <para>
    /// Ranged on <c>CreatedAt</c> — when the club HEARD — exactly as the door log is, and for the
    /// same reason: a batch delivered this morning carrying scans from two days ago would
    /// otherwise fall outside "last 24 hours" and outside every window anybody would ever ask
    /// for afterwards, because it is already older than all of them. The row then PRINTS at its
    /// scan's instant (<see cref="AuditLog.ScanAt"/>), which is what the list is sorted by.
    /// </para>
    /// </summary>
    private static Task<List<AuditLog>> AuditRowsAsync(
        MainframeDbContext db, AdminMemberTraceQuery q, CancellationToken ct)
        => db.AuditLogs.AsNoTracking()
            .Where(a => a.SubjectUserId == q.UserId || a.ActorUserId == q.UserId)
            .Where(a => a.CreatedAt >= q.From && a.CreatedAt < q.To)
            .OrderBy(a => a.CreatedAt)
            .Take(q.StrandRows)
            .ToListAsync(ct);

    private static Task<List<LedgerEntry>> LedgerRowsAsync(
        MainframeDbContext db, AdminMemberTraceQuery q, CancellationToken ct)
        => db.LedgerEntries.AsNoTracking()
            .Where(l => l.UserId == q.UserId || l.ActorUserId == q.UserId)
            .Where(l => l.CreatedAt >= q.From && l.CreatedAt < q.To)
            .OrderBy(l => l.CreatedAt)
            .Take(q.StrandRows)
            .ToListAsync(ct);

    /// <summary>
    /// What the relays did on this member's bookings — the only MEASUREMENT in this product of
    /// what the lights actually did, as <c>DeviceEventEndpoints</c> says of the release event.
    ///
    /// <para>
    /// Reached through the member's own bookings rather than through a subject on the row,
    /// because a receipt names a device and a RELAY INDEX and no person at all. That is exactly
    /// why "who turned Court 2's lights on" is not answerable from receipts, and why D2 §6.4
    /// asks for a <c>court.lights_on</c> audit row carrying an actor.
    /// </para>
    /// </summary>
    private static async Task<List<ReceiptRow>> ReceiptRowsAsync(
        MainframeDbContext db, AdminMemberTraceQuery q, CancellationToken ct)
    {
        var bookings = await db.Bookings.AsNoTracking()
            .Where(b => b.UserId == q.UserId && b.StartsAt < q.To && b.EndsAt >= q.From)
            .Select(b => new { b.Id, b.CourtId })
            .ToListAsync(ct);
        if (bookings.Count == 0) return [];

        var byBooking = bookings.ToDictionary(b => b.Id, b => b.CourtId);
        var ids = byBooking.Keys.ToList();

        var rows = await db.DeviceEventReceipts.AsNoTracking()
            .Where(r => r.BookingId != null && ids.Contains(r.BookingId!.Value))
            .Where(r => r.OccurredAt >= q.From && r.OccurredAt < q.To)
            .OrderBy(r => r.OccurredAt)
            .Select(r => new { r.Id, r.OccurredAt, r.Kind, r.BookingId, r.Court, r.DeviceId })
            .Take(q.StrandRows)
            .ToListAsync(ct);

        return [.. rows.Select(r => new ReceiptRow(
            r.Id, r.OccurredAt, r.Kind, r.BookingId!.Value, byBooking[r.BookingId!.Value],
            r.Court, r.DeviceId))];
    }

    /// <summary>
    /// What this member's balance was at the start of the range, so a running balance can be
    /// stated beside each movement.
    ///
    /// <para>
    /// <b>There is no stored balance field and there is not going to be one</b> — the repository
    /// invariant. The alternative to this one aggregate is a money strand that says how much
    /// moved and never what was left, which is the first thing anybody asks of it.
    /// </para>
    /// </summary>
    private static Task<decimal> OpeningBalanceAsync(
        MainframeDbContext db, AdminMemberTraceQuery q, CancellationToken ct)
        => db.LedgerEntries.AsNoTracking()
            .Where(l => l.UserId == q.UserId && l.CreatedAt < q.From)
            .SumAsync(l => l.AmountCredits, ct);

    /// <summary>
    /// Which of the people on these rows this club has marked as administrators.
    ///
    /// <para>
    /// <b>Read, never inferred.</b> D2-B41: <c>ActorUserId != SubjectUserId</c> is what
    /// <see cref="LedgerService"/> still computes, and it makes every automatic no-show sweep
    /// claim an administrator did it. One read of one column is the difference between a screen
    /// a member can dispute and one they cannot.
    /// </para>
    /// </summary>
    private static async Task<HashSet<Guid>> AdminsAsync(
        MainframeDbContext db, IEnumerable<Guid> actors, CancellationToken ct)
    {
        var wanted = actors.Where(a => a != Guid.Empty).Distinct().ToList();
        if (wanted.Count == 0) return [];

        var found = await db.Users.AsNoTracking()
            .Where(u => wanted.Contains(u.Id) && u.IsAdmin)
            .Select(u => u.Id)
            .ToListAsync(ct);
        return [.. found];
    }

    // ------------------------------------------------------------------ projection

    private static IEnumerable<TraceEventRow> AuditEvents(Strands s, AdminMemberTraceQuery q)
    {
        foreach (var row in s.Audit)
        {
            var details = DoorActivityView.Details(row.DetailsJson);

            // D2-B27: a court box's `unknown_scan` is classified as a door REFUSAL by DoorTrail,
            // so without this a member mis-scanning at a COURT BOX appears on their own night
            // under a door headline. The rule is stated once, in DoorTrail, and lands here and
            // in the club's door log in the same change.
            if (DoorTrail.IsScan(row.Action) && DoorTrail.AtANonDoorBoard(details, s.NotADoor)) continue;

            var kind = TraceKinds.OfAudit(row.Action, actorIsSubject: row.ActorUserId == q.UserId);
            if (kind is null) continue;

            var court = CourtOf(details, s.Courts);
            var actorKind = ActorKindOf(row.ActorUserId, DoorTrail.DeviceIdOf(details) is not null, s.Admins);
            var actorName = PersonNames.Of(row.ActorUserId, s.Names);

            yield return new TraceEventRow(
                At: row.ScanAt,
                SourceId: row.Id,
                Source: AuditSource,
                Kind: kind,
                Headline: TraceKinds.Headline(kind, new TraceFacts
                {
                    DoorName = Text(details, "door_name"),
                    CourtName = court?.Name ?? Text(details, "court"),
                    ActorName = actorName,
                    ActorKind = actorKind,
                    RawAction = row.Action,
                }, q.CurrencySymbol),
                ActorUserId: row.ActorUserId,
                ActorKind: actorKind,
                ActorName: actorName,
                SubjectUserId: row.SubjectUserId,
                SubjectName: PersonNames.Of(row.SubjectUserId, s.Names),
                Court: court,
                AmountCredits: null,
                BalanceAfterCredits: null,
                Detail: AuditDetail(row.Action, details));
        }
    }

    /// <summary>
    /// The money strand, with a running balance carried forward from the opening one.
    ///
    /// <para>
    /// <b>The balance only moves on rows that are the member's OWN money.</b> A row where they
    /// were merely the actor — an admin topping somebody else up — belongs on their trace,
    /// because "what did this admin do" is half of what this surface is for; it changed nobody's
    /// balance but the subject's, and it says so by carrying none.
    /// </para>
    /// </summary>
    private static IEnumerable<TraceEventRow> LedgerEvents(Strands s, AdminMemberTraceQuery q)
    {
        var running = s.Opening;
        foreach (var row in s.Ledger)
        {
            var own = row.UserId == q.UserId;
            if (own) running += row.AmountCredits;

            var kind = TraceKinds.OfLedger(row.Type);
            var actorKind = ActorKindOf(row.ActorUserId, hasDevice: false, s.Admins);
            var actorName = PersonNames.Of(row.ActorUserId, s.Names);
            var court = CourtOfBooking(row.RelatedBookingId, s);

            yield return new TraceEventRow(
                At: row.CreatedAt,
                SourceId: row.Id,
                Source: LedgerSource,
                Kind: kind,
                Headline: TraceKinds.Headline(kind, new TraceFacts
                {
                    AmountCredits = row.AmountCredits,
                    CourtName = court?.Name,
                    ActorName = actorName,
                    ActorKind = actorKind,
                }, q.CurrencySymbol),
                ActorUserId: row.ActorUserId,
                ActorKind: actorKind,
                ActorName: actorName,
                SubjectUserId: row.UserId,
                SubjectName: PersonNames.Of(row.UserId, s.Names),
                Court: court,
                AmountCredits: row.AmountCredits,
                BalanceAfterCredits: own ? running : null,
                Detail: Detail(
                    ("ledger_type", row.Type.ToString()),
                    ("reason", row.Reason),
                    ("booking_id", row.RelatedBookingId)));
        }
    }

    /// <summary>
    /// What the relays did, as the boards reported it.
    ///
    /// <para>
    /// The actor is the BOARD — <see cref="TraceActors.Device"/> — and never the member, because
    /// that is all a receipt knows. A row claiming the member switched the relay would be a
    /// guess, and on this surface a guess about who did something is the failure the whole design
    /// is built against.
    /// </para>
    /// </summary>
    private static IEnumerable<TraceEventRow> ReceiptEvents(Strands s, AdminMemberTraceQuery q)
    {
        foreach (var row in s.Receipts)
        {
            var kind = TraceKinds.OfAudit($"device.{row.Kind}", actorIsSubject: false);
            if (kind is null || kind == TraceKinds.Unrecognised) continue;

            // An uploaded ACTIVATION is what lit the relay. On this strand it is the LIGHTS
            // coming on and not a check-in: the check-in is the person identifying, which
            // `court.activated` already records with a person's name on it.
            if (kind == TraceKinds.CourtCheckedIn) kind = TraceKinds.LightsOn;

            s.Courts.TryGetValue(row.CourtId, out var court);
            yield return new TraceEventRow(
                At: row.OccurredAt,
                SourceId: row.Id,
                Source: ReceiptSource,
                Kind: kind,
                Headline: TraceKinds.Headline(kind, new TraceFacts { CourtName = court?.Name }, q.CurrencySymbol),
                ActorUserId: Guid.Empty,
                ActorKind: TraceActors.Device,
                ActorName: null,
                SubjectUserId: null,
                SubjectName: null,
                Court: court,
                AmountCredits: null,
                BalanceAfterCredits: null,
                Detail: Detail(
                    ("booking_id", row.BookingId),
                    ("relay", row.Relay),
                    ("device_id", row.DeviceId)));
        }
    }

    /// <summary>
    /// §6.5, and the one predicate on this surface that must never be re-derived from a
    /// comparison of two ids. Block body for the lizard reason in <c>memory/gotchas.md</c>.
    /// </summary>
    private static string ActorKindOf(Guid actorUserId, bool hasDevice, IReadOnlySet<Guid> admins)
    {
        if (actorUserId == Guid.Empty) return hasDevice ? TraceActors.Device : TraceActors.System;
        return admins.Contains(actorUserId) ? TraceActors.Admin : TraceActors.Member;
    }

    /// <summary>A detail document with the keys the row did not carry left out rather than nulled.</summary>
    private static Dictionary<string, object?> Detail(params (string Key, object? Value)[] fields)
    {
        var detail = new Dictionary<string, object?>(fields.Length);
        foreach (var (key, value) in fields)
        {
            if (value is not null) detail[key] = value;
        }
        return detail;
    }

    /// <summary>The named fields one audit row is allowed to publish, and nothing else.</summary>
    private static Dictionary<string, object?> AuditDetail(string action, JsonElement? details)
    {
        var detail = Detail(
            ("door_name", Text(details, "door_name")),
            ("reason", Text(details, "reason") ?? Text(details, "outcome")),
            ("method", Text(details, "method")),
            ("booking_id", Text(details, "booking_id")),
            ("court", Text(details, "court") ?? Text(details, "court_number")));

        // Present on every door row and absent everywhere else: "the board decided this alone"
        // is a fact about the row, and false is a different answer from "not a door row".
        if (DoorTrail.IsScan(action)) detail["offline"] = DoorTrail.IsOfflineAction(action);
        return detail;
    }

    /// <summary>The court a row is about, by number or by name — whichever the writer recorded.</summary>
    private static TraceCourtRef? CourtOf(JsonElement? details, IReadOnlyDictionary<Guid, TraceCourtRef> courts)
    {
        if (Text(details, "court_number") is { } number
            && int.TryParse(number, System.Globalization.CultureInfo.InvariantCulture, out var parsed))
        {
            return courts.Values.FirstOrDefault(c => c.Number == parsed);
        }
        return Text(details, "court") is { } name
            ? courts.Values.FirstOrDefault(c => c.Name == name)
            : null;
    }

    /// <summary>The court a ledger row's booking was on, when it names one this club still has.</summary>
    private static TraceCourtRef? CourtOfBooking(Guid? bookingId, Strands s)
    {
        if (bookingId is not { } id) return null;
        if (!s.BookingCourts.TryGetValue(id, out var courtId)) return null;
        return s.Courts.TryGetValue(courtId, out var court) ? court : null;
    }

    /// <summary>One string field out of a details document, whatever JSON type it was written as.</summary>
    private static string? Text(JsonElement? details, string key)
    {
        if (details is not { } root || root.ValueKind != JsonValueKind.Object) return null;
        if (!root.TryGetProperty(key, out var value)) return null;
        return value.ValueKind switch
        {
            JsonValueKind.String => value.GetString(),
            JsonValueKind.Number => value.ToString(),
            _ => null,
        };
    }

    // ------------------------------------------------------------------ the summary

    /// <summary>
    /// What the night added up to.
    ///
    /// <para>
    /// <b><c>minutes_on_court</c> is measured, not inferred.</b> It is the span between the first
    /// and last receipt on each of the member's bookings — what the relays did — and it is zero
    /// where no board reported. A booking's own length would be the club's INTENTION, and this
    /// product's whole settlement model rests on those being different numbers.
    /// </para>
    ///
    /// <para>
    /// <b>A refusal counts as a sighting.</b> <c>first_seen_at</c> spans the door, court and
    /// lights strands including the refusals, because somebody turned away at 19:02 was at the
    /// club at 19:02 — and "she was not here" is the sentence this surface exists to be able to
    /// contradict.
    /// </para>
    /// </summary>
    private static TraceSummary Summarise(
        IReadOnlyList<TraceEventRow> events, IReadOnlyList<ReceiptRow> receipts, Guid traced)
    {
        var present = events
            .Where(e => e.Strand is TraceKinds.DoorStrand or TraceKinds.CourtStrand or TraceKinds.LightsStrand)
            .Select(e => e.At)
            .ToList();

        var money = events
            .Where(e => e.Source == LedgerSource && e.SubjectUserId == traced)
            .Select(e => e.AmountCredits ?? 0m)
            .ToList();

        return new TraceSummary(
            FirstSeenAt: present.Count > 0 ? present.Min() : null,
            LastSeenAt: present.Count > 0 ? present.Max() : null,
            MinutesOnCourt: MinutesOnCourt(receipts),
            Courts: [.. events.Where(e => e.Court is not null).Select(e => e.Court!.Name).Distinct().Order()],
            CreditsSpent: -money.Where(a => a < 0).Sum(),
            CreditsReceived: money.Where(a => a > 0).Sum(),
            DoorsEntered: events.Count(e => e.Kind is TraceKinds.DoorOpened or TraceKinds.DoorOpenedOffline),
            DoorsRefused: events.Count(e => e.Kind == TraceKinds.DoorRefused),
            BookingsMade: events.Count(e => e.Kind is TraceKinds.BookingMade or TraceKinds.BookingMadeForThem),
            BookingsCancelled: events.Count(e =>
                e.Kind is TraceKinds.BookingCancelled or TraceKinds.BookingCancelledByClub));
    }

    /// <summary>
    /// The measured span of each booking's receipts, summed. A booking with ONE receipt
    /// contributes nothing: a relay that came on and has not been reported off is a session this
    /// product cannot measure, and guessing its length is how a measurement becomes an estimate
    /// nobody labelled.
    /// </summary>
    private static int MinutesOnCourt(IReadOnlyList<ReceiptRow> receipts)
    {
        var total = TimeSpan.Zero;
        foreach (var group in receipts.GroupBy(r => r.BookingId))
        {
            var instants = group.Select(r => r.OccurredAt).ToList();
            if (instants.Count < 2) continue;
            total += instants.Max() - instants.Min();
        }
        return (int)Math.Round(total.TotalMinutes, MidpointRounding.AwayFromZero);
    }
}
