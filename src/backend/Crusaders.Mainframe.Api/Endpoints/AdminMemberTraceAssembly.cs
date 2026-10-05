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
    int? AmountMinutes,
    int? BalanceAfterMinutes,
    IReadOnlyDictionary<string, object?> Detail)
{
    /// <summary>
    /// The code of the board the row happened at — a door row's gate, a receipt's court box — or
    /// null for a row no board wrote. The night's burst key: two doors in one minute are two
    /// stories (review round 4 wave B; nothing was sent and the console keyed on the door name).
    /// </summary>
    public string? DeviceCode { get; init; }

    /// <summary>
    /// The instant is the board's own clock and the server overruled it or cannot reconcile it —
    /// <see cref="DoorActivityView.TimeUncertain"/>, the door log's <c>time_uncertain</c>, one rule
    /// for one fact. False on every row the server timed itself (ledger, online scans) and on a
    /// relay receipt, which keeps no record of a clamp.
    /// </summary>
    public bool Approximate { get; init; }

    /// <summary>The board's outage the row's instant fell inside — the club could not hear that board then — or null.</summary>
    public Guid? OutageId { get; init; }

    /// <summary>
    /// Review round 10, E10-2: the member whose code a board READ to write this row, when the row
    /// records one — a partner or a pay-for payer lighting the organiser's court — so "with X's
    /// code" names the scanner, not the booking's owner. Null where the row names no code holder.
    /// </summary>
    public Guid? CodeHolderUserId { get; init; }

    /// <summary>The <see cref="CodeHolderUserId"/>'s name, as the club knows it now.</summary>
    public string? CodeHolderName { get; init; }

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
    IReadOnlyList<string> Courts, int MinutesSpent, int MinutesReceived,
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
public static partial class AdminMemberTraceAssembly
{
    /// <summary>The row came from <c>audit_log</c>.</summary>
    public const string AuditSource = "audit_log";

    /// <summary>The row came from <c>ledger_entries</c>.</summary>
    public const string LedgerSource = "ledger";

    /// <summary>The row came from <c>device_event_receipts</c> — what a relay actually did.</summary>
    public const string ReceiptSource = "device_event_receipt";

    /// <summary>One receipt with its booking's court already resolved.</summary>
    private sealed record ReceiptRow(
        Guid Id, DateTimeOffset OccurredAt, string Kind, Guid BookingId, Guid CourtId, int? Relay, Guid DeviceId)
    {
        /// <summary>The board's sequence number, which a reversal's <c>court.lights_on</c> row repeats (E7-1).</summary>
        public long Seq { get; init; }
    }

    /// <summary>Everything the three reads produced, before any of it is a sentence.</summary>
    private sealed record Strands(
        List<AuditLog> Audit, List<LedgerEntry> Ledger, List<ReceiptRow> Receipts,
        Dictionary<Guid, TraceCourtRef> Courts, Dictionary<Guid, Guid> BookingCourts,
        List<Guid> NotADoor, Dictionary<Guid, string> Names, HashSet<Guid> Admins, int Opening)
    {
        /// <summary>The boards the rows name, by id → code.</summary>
        public Dictionary<Guid, string> DeviceCodes { get; init; } = [];

        /// <summary>The same boards' display names NOW, by id — a rename reaches history (E7-4).</summary>
        public Dictionary<Guid, string> DeviceNames { get; init; } = [];

        /// <summary>Those boards' outages that reach into the night.</summary>
        public List<DeviceOutage> Outages { get; init; } = [];

        /// <summary>The court boxes' relay maps NOW, by id — relay index → court number (R12 D12-2).</summary>
        public Dictionary<Guid, List<int>> DeviceCourts { get; init; } = [];

        /// <summary>The owner of every booking the rows name, by id (R13 E13-8: whose earlier booking displaced this one).</summary>
        public Dictionary<Guid, Guid?> BookingOwners { get; init; } = [];

        /// <summary>The withdrawn seats the share rows name, by participant id — who withdrew, and when (R13 E13-4).</summary>
        public Dictionary<Guid, Withdrawal> Withdrawals { get; init; } = [];

        /// <summary>R15 E15-3 / J15-4: every share row's partner, organiser, direction and cause, by ledger id.</summary>
        public Dictionary<Guid, ShareRowWhy> ShareWhys { get; init; } = [];
    }

    public static async Task<TraceNight> BuildAsync(
        MainframeDbContext db, AdminMemberTraceQuery query, CancellationToken ct)
    {
        var strands = await ReadAsync(db, query, ct);

        var merged = new List<TraceEventRow>(
            strands.Audit.Count + strands.Ledger.Count + strands.Receipts.Count);
        merged.AddRange(AuditEvents(strands, query));
        merged.AddRange(LedgerEvents(strands, query));
        merged.AddRange(ReceiptEvents(strands));

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

        // R13 E13-8: an audit row's booking too (`booking_id`, a displacement's `displaced_by_booking_id`),
        // so a row that stored no court names the booking's, and a displacement names its cause.
        var bookingIds = ledger
            .Where(l => l.RelatedBookingId is not null)
            .Select(l => l.RelatedBookingId!.Value)
            .Concat(audit.SelectMany(AuditBookingIds))
            .Distinct()
            .ToList();
        var bookingRows = await db.Bookings.AsNoTracking()
            .Where(b => bookingIds.Contains(b.Id))
            .Select(b => new { b.Id, b.CourtId, b.UserId })
            .ToListAsync(ct);
        var bookingCourts = bookingRows.ToDictionary(b => b.Id, b => b.CourtId);
        var withdrawals = await WithdrawalsAsync(db, ledger, ct);
        var shareWhys = await ShareRowCauses.ForAsync(db, ledger, ct);

        var people = audit.SelectMany(a => new Guid?[] { a.ActorUserId, a.SubjectUserId, CodeHolderOf(a), OrganiserOf(a) })
            .Concat(ledger.SelectMany(l => new Guid?[] { l.ActorUserId, l.UserId }))
            .Concat(bookingRows.Select(b => b.UserId))
            .Concat(withdrawals.Values.Select(w => (Guid?)w.UserId))
            .Concat(shareWhys.Values.SelectMany(w => new Guid?[] { w.PartnerUserId, w.OrganiserUserId }));
        var names = await PersonNames.ForAsync(db, people, ct);
        var admins = await AdminsAsync(
            db, audit.Select(a => a.ActorUserId).Concat(ledger.Select(l => l.ActorUserId)).Concat(withdrawals.Values.Select(w => w.UserId)), ct);

        var boards = await BoardsAsync(db, audit, receipts, q, ct);
        return new Strands(
            audit, ledger, receipts, courts, bookingCourts,
            await DoorTrail.NotADoorIdsAsync(db, ct), names, admins,
            await OpeningBalanceAsync(db, q, ct))
        {
            DeviceCodes = boards.Codes,
            DeviceNames = boards.Names,
            Outages = boards.Outages,
            DeviceCourts = boards.Courts,
            BookingOwners = bookingRows.ToDictionary(b => b.Id, b => b.UserId),
            Withdrawals = withdrawals,
            ShareWhys = shareWhys,
        };
    }

    /// <summary>
    /// The codes of the boards the rows name, and those boards' outages that reach into the
    /// night (review round 4 wave B). Two reads, and none when no row names a board. An offline
    /// row prints at its scan, which can be earlier than the range it was heard in, so the
    /// outage window opens at the earliest scan.
    /// </summary>
    private static async Task<BoardFacts> BoardsAsync(
        MainframeDbContext db, List<AuditLog> audit, List<ReceiptRow> receipts, AdminMemberTraceQuery q,
        CancellationToken ct)
    {
        var ids = audit.Select(a => DoorTrail.DeviceIdOf(DoorActivityView.Details(a.DetailsJson)))
            .Where(id => id is not null).Select(id => id!.Value)
            .Concat(receipts.Select(r => r.DeviceId))
            .Distinct().ToList();
        if (ids.Count == 0) return new BoardFacts([], [], [], []);

        var boards = await db.Devices.AsNoTracking()
            .Where(d => ids.Contains(d.Id))
            .Select(d => new { d.Id, d.DeviceCode, d.Name, d.CourtNumbers })
            .ToListAsync(ct);
        var codes = boards.ToDictionary(d => d.Id, d => d.DeviceCode);
        var names = boards.ToDictionary(d => d.Id, d => d.Name);
        var courts = boards.ToDictionary(d => d.Id, d => d.CourtNumbers.ToList());

        var floor = audit.Select(a => AtOf(a, DoorActivityView.Details(a.DetailsJson))).Append(q.From).Min().ToUniversalTime();
        var to = q.To.ToUniversalTime();
        var outages = await db.DeviceOutages.AsNoTracking()
            .Where(o => ids.Contains(o.DeviceId) && o.StartedAt < to && (o.EndedAt == null || o.EndedAt > floor))
            .ToListAsync(ct);
        return new BoardFacts(codes, names, outages, courts);
    }

    /// <summary>What <see cref="BoardsAsync"/> read about the boards a night's rows name.</summary>
    private sealed record BoardFacts(
        Dictionary<Guid, string> Codes, Dictionary<Guid, string> Names, List<DeviceOutage> Outages,
        Dictionary<Guid, List<int>> Courts);

    /// <summary>The outage of <paramref name="deviceId"/> that <paramref name="at"/> fell inside, or null.</summary>
    private static Guid? OutageAt(Strands s, Guid? deviceId, DateTimeOffset at)
    {
        if (deviceId is not { } id) return null;
        return s.Outages
            .Where(o => o.DeviceId == id && o.StartedAt <= at && (o.EndedAt is not { } end || at < end))
            .Select(o => (Guid?)o.Id)
            .FirstOrDefault();
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
    /// <para>
    /// R13 E13-4: plus a partner's withdrawal from THIS member's game — that row is the partner's
    /// (actor and subject), and names the organiser only in its details.
    /// </para>
    /// <para>
    /// R15 E15-3 / J15-4: plus the club's other acts on THIS member's partners (an admin's removal,
    /// settle-outside, collect, add — <see cref="TraceKinds.OrganisersViewActions"/>), and the club's
    /// settlement of a game this member paid INTO as a partner — its no-show and its reversal
    /// (<see cref="PartnerRowsAsync"/>).
    /// </para>
    private static async Task<List<AuditLog>> AuditRowsAsync(
        MainframeDbContext db, AdminMemberTraceQuery q, CancellationToken ct)
    {
        var organiser = JsonSerializer.Serialize(new { organiser_user_id = q.UserId });
        var organisersView = TraceKinds.OrganisersViewActions;
        var rows = await db.AuditLogs.AsNoTracking()
            .Where(a => a.SubjectUserId == q.UserId || a.ActorUserId == q.UserId
                        || (organisersView.Contains(a.Action) && a.DetailsJson != null
                            && EF.Functions.JsonContains(a.DetailsJson, organiser)))
            .Where(a => a.CreatedAt >= q.From && a.CreatedAt < q.To)
            .OrderBy(a => a.CreatedAt)
            .Take(q.StrandRows)
            .ToListAsync(ct);
        var partner = await PartnerRowsAsync(db, q, ct);
        if (partner.Count == 0) return rows;
        var have = rows.Select(r => r.Id).ToHashSet();
        return [.. rows.Concat(partner.Where(r => have.Add(r.Id))).OrderBy(r => r.CreatedAt).ThenBy(r => r.Id)];
    }

    /// <summary>How far before the window a game may have started and still be settled inside it — a late check-in uploads hours after.</summary>
    private static readonly TimeSpan SettledLate = TimeSpan.FromDays(7);

    /// <summary>
    /// R15 J15-4: the club's no-show sweep and its reversal on a booking this member holds a PARTNER
    /// seat on — the rows are about the booker, so the partner's Night had their share moving with
    /// nothing saying why. Read by the bookers and the actions, narrowed to those bookings in memory.
    /// </summary>
    private static async Task<List<AuditLog>> PartnerRowsAsync(MainframeDbContext db, AdminMemberTraceQuery q, CancellationToken ct)
    {
        var floor = q.From - SettledLate;
        var games = await db.BookingParticipants.AsNoTracking()
            .Where(p => p.UserId == q.UserId && p.Seat > 1)
            .Join(db.Bookings.AsNoTracking(), p => p.BookingId, b => b.Id, (p, b) => b)
            .Where(b => b.StartsAt < q.To && b.EndsAt >= floor && b.UserId != null)
            .Select(b => new { b.Id, Booker = b.UserId!.Value })
            .Distinct()
            .ToListAsync(ct);
        if (games.Count == 0) return [];

        var bookers = games.Select(g => g.Booker).Distinct().ToList();
        var ids = games.Select(g => g.Id).ToHashSet();
        var actions = TraceKinds.PartnersViewActions;
        var rows = await db.AuditLogs.AsNoTracking()
            .Where(a => a.SubjectUserId != null && bookers.Contains(a.SubjectUserId!.Value) && actions.Contains(a.Action))
            .Where(a => a.CreatedAt >= q.From && a.CreatedAt < q.To)
            .Take(q.StrandRows)
            .ToListAsync(ct);
        return [.. rows.Where(r => GuidOf(DoorActivityView.Details(r.DetailsJson), "booking_id") is { } b && ids.Contains(b))];
    }

    private static async Task<List<LedgerEntry>> LedgerRowsAsync(
        MainframeDbContext db, AdminMemberTraceQuery q, CancellationToken ct)
    {
        var rows = await db.LedgerEntries.AsNoTracking()
            .Where(l => l.UserId == q.UserId || l.ActorUserId == q.UserId)
            .Where(l => l.CreatedAt >= q.From && l.CreatedAt < q.To)
            .OrderBy(l => l.CreatedAt)
            .Take(q.StrandRows)
            .ToListAsync(ct);
        return await WithShareTwinsAsync(db, q.UserId, rows, ct);
    }

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

        // E7-1: a receipt the server REFUSED still names the booking it was refused for, and is
        // no evidence the booking's court was lit. Null is a receipt from before the verdict was
        // kept, read as it always was.
        var rows = await db.DeviceEventReceipts.AsNoTracking()
            .Where(r => r.BookingId != null && ids.Contains(r.BookingId!.Value))
            .Where(r => r.OccurredAt >= q.From && r.OccurredAt < q.To)
            .Where(r => r.Outcome == null || !RefusedReceiptOutcomes.Contains(r.Outcome))
            .OrderBy(r => r.OccurredAt)
            .Select(r => new { r.Id, r.OccurredAt, r.Kind, r.BookingId, r.Court, r.DeviceId, r.Seq })
            .Take(q.StrandRows)
            .ToListAsync(ct);

        return [.. rows.Select(r => new ReceiptRow(
            r.Id, r.OccurredAt, r.Kind, r.BookingId!.Value, byBooking[r.BookingId!.Value],
            r.Court, r.DeviceId) { Seq = r.Seq })];
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
    private static Task<int> OpeningBalanceAsync(
        MainframeDbContext db, AdminMemberTraceQuery q, CancellationToken ct)
        => db.LedgerEntries.AsNoTracking()
            .Where(l => l.UserId == q.UserId && l.CreatedAt < q.From)
            .SumAsync(l => l.AmountMinutes, ct);

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

            var view = ViewOf(row, q.UserId);
            var kind = TraceKinds.OfAudit(row.Action, actorIsSubject: row.ActorUserId == q.UserId, view);
            if (kind is null) continue;

            // E7-1: the server's own lights row for a scan a board uploaded. The receipt already
            // says it, at the scan's instant; this row says it again at the upload's.
            if (IsReceiptTwin(row.Action, details, s)) continue;

            var deviceId = DoorTrail.DeviceIdOf(details);
            var place = PlaceOf(row.Action, details, deviceId, s);
            var court = place.Court;
            var at = AtOf(row, details);
            var actorKind = ActorKindOf(row.ActorUserId, deviceId is not null, s.Admins);
            var actorName = PersonNames.Of(row.ActorUserId, s.Names);
            var deviceCode = deviceId is { } id && s.DeviceCodes.TryGetValue(id, out var code) ? code : Text(details, "device_code");
            var doorName = DoorLabelOf(details, deviceId, deviceCode, s);

            yield return new TraceEventRow(
                At: at,
                SourceId: row.Id,
                Source: AuditSource,
                Kind: kind,
                Headline: TraceKinds.Headline(kind, new TraceFacts
                {
                    DoorName = doorName,
                    CourtName = place.CourtName,
                    BoxName = place.BoxName,
                    Verdict = place.Verdict,
                    ActorName = actorName,
                    ActorKind = actorKind,
                    RawAction = row.Action,
                    SubjectName = PersonNames.Of(row.SubjectUserId, s.Names),
                    CourtWasDark = Flag(details, "peripheral_outage"),
                    CodeUsed = Text(details, "reason") == MemberCodeIdentity.CodeUsed,
                    Attempt = Text(details, "attempt"),
                    RefusedOffline = Text(details, "outcome") == DoorTrail.RefusedOffline,
                    // R15 J15-4: a partner's view of the booker's row names the booker as the game's organiser.
                    OrganiserName = PersonNames.Of(view == TraceView.Partner ? row.SubjectUserId : OrganiserOf(row), s.Names),
                    CausedByName = CauseOf(row.Action, details, s),
                    // R14 E14-2: a split change says what the partner's share became; R15 E15-3: a collect what it took.
                    AmountMinutes = AuditAmountOf(row.Action, details),
                    Placed = Flag(details, "accepted"),
                }),
                ActorUserId: row.ActorUserId,
                ActorKind: actorKind,
                ActorName: actorName,
                SubjectUserId: row.SubjectUserId,
                SubjectName: PersonNames.Of(row.SubjectUserId, s.Names),
                Court: court,
                AmountMinutes: null,
                BalanceAfterMinutes: null,
                Detail: AuditDetail(row.Action, details, doorName, place.BoardCourt))
            {
                // A removed board keeps the code its rows were written with.
                DeviceCode = deviceCode,
                Approximate = DoorActivityView.TimeUncertain(details, row.CreatedAt),
                OutageId = OutageAt(s, deviceId, at),
                CodeHolderUserId = CodeHolderOf(row),
                CodeHolderName = CodeHolderOf(row) is { } holder ? PersonNames.Of(holder, s.Names) : null,
            };
        }
    }

    /// <summary>
    /// R15 E15-3 / J15-4: from where this member sees the row — their own (actor or subject), the
    /// organiser of the game an admin acted on, or a partner on the booking the club settled.
    /// </summary>
    private static TraceView ViewOf(AuditLog row, Guid traced)
    {
        if (row.ActorUserId == traced || row.SubjectUserId == traced) return TraceView.Own;
        return OrganiserOf(row) == traced ? TraceView.Organiser : TraceView.Partner;
    }

    /// <summary>The minutes an audit row's sentence names: a split change's new share (R14), a collect's figure (R15).</summary>
    private static int? AuditAmountOf(string action, JsonElement? details)
    {
        return action switch
        {
            TraceKinds.SplitChangedAction => IntOf(details, "share_minutes"),
            TraceKinds.ShareCollectedAction => IntOf(details, "collected_minutes"),
            _ => null,
        };
    }

    /// <summary>
    /// E10-2: whose code a lights-on row's board read (<c>identified_user_id</c> in its details), or null.
    /// </summary>
    private static Guid? CodeHolderOf(AuditLog row)
    {
        if (row.Action != TraceKinds.LightsOnAction) return null;
        return GuidOf(Inner(DoorActivityView.Details(row.DetailsJson)), "identified_user_id");
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
            if (own) running += row.AmountMinutes;

            var kind = TraceKinds.OfLedger(row.Type);
            // R13 E13-4: a share that went back because the partner withdrew is the partner's act —
            // also on a row posted before R13 under the system's id (only the partner can withdraw).
            var withdrew = WithdrewOf(row, s);
            var actorId = withdrew is { } partner && row.ActorUserId == Guid.Empty ? partner : row.ActorUserId;
            var actorKind = ActorKindOf(actorId, hasDevice: false, s.Admins);
            var actorName = PersonNames.Of(actorId, s.Names);
            var court = CourtOfBooking(row.RelatedBookingId, s);
            var share = s.ShareWhys.GetValueOrDefault(row.Id);

            yield return new TraceEventRow(
                At: row.CreatedAt,
                SourceId: row.Id,
                Source: LedgerSource,
                Kind: kind,
                Headline: TraceKinds.Headline(kind, new TraceFacts
                {
                    AmountMinutes = row.AmountMinutes,
                    CourtName = court?.Name,
                    ActorName = actorName,
                    ActorKind = actorKind,
                    // E6-1: a row where this member was only the actor is somebody else's money,
                    // and its sentence names whose — it carries no balance for the same reason.
                    OthersMoney = !own,
                    SubjectName = own ? null : PersonNames.Of(row.UserId, s.Names),
                    // E8-5: a desk top-up the club took no rand for was given, not sold.
                    NoCharge = GivenMinutes.IsGiven(row.Type, row.ZarPaid),
                    WithdrewName = withdrew is { } w ? PersonNames.Of(w, s.Names) ?? "their partner" : null,
                    // R15 E15-3 / J15-4: which way the share went, with whom, and why — off the record.
                    ShareCause = share?.Cause,
                    PartnerName = share is null ? null : PersonNames.Of(share.PartnerUserId, s.Names),
                    OrganiserSideName = share is null ? null : PersonNames.Of(share.OrganiserUserId, s.Names),
                    Collection = share?.Collection ?? false,
                }),
                ActorUserId: actorId,
                ActorKind: actorKind,
                ActorName: actorName,
                SubjectUserId: row.UserId,
                SubjectName: PersonNames.Of(row.UserId, s.Names),
                Court: court,
                // E7-3: the amount column is THIS member's money. Somebody else's movement is told in
                // the sentence ("Dan Splitter got 15 minutes back") and adds nothing to the column
                // beside this member's own −15.
                AmountMinutes: own ? row.AmountMinutes : null,
                BalanceAfterMinutes: own ? running : null,
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
    private static IEnumerable<TraceEventRow> ReceiptEvents(Strands s)
    {
        foreach (var row in s.Receipts)
        {
            // An uploaded ACTIVATION is what lit the relay. On this strand it is the LIGHTS
            // coming on and not a check-in: the check-in is the person identifying, which
            // `court.activated` already records with a person's name on it.
            var kind = row.Kind == DeviceEventEndpoints.ActivationKind
                ? TraceKinds.LightsOn
                : TraceKinds.OfAudit($"device.{row.Kind}", actorIsSubject: false);
            if (kind is null || kind == TraceKinds.Unrecognised) continue;

            s.Courts.TryGetValue(row.CourtId, out var court);
            var holder = TwinCodeHolderOf(row, s);
            yield return new TraceEventRow(
                At: row.OccurredAt,
                SourceId: row.Id,
                Source: ReceiptSource,
                Kind: kind,
                Headline: TraceKinds.Headline(kind, new TraceFacts { CourtName = court?.Name }),
                ActorUserId: Guid.Empty,
                ActorKind: TraceActors.Device,
                ActorName: null,
                SubjectUserId: null,
                SubjectName: null,
                Court: court,
                AmountMinutes: null,
                BalanceAfterMinutes: null,
                Detail: Detail(
                    ("booking_id", row.BookingId),
                    ("relay", row.Relay),
                    ("device_id", row.DeviceId)))
            {
                DeviceCode = s.DeviceCodes.GetValueOrDefault(row.DeviceId),
                OutageId = OutageAt(s, row.DeviceId, row.OccurredAt),
                CodeHolderUserId = holder,
                CodeHolderName = holder is { } h ? PersonNames.Of(h, s.Names) : null,
            };
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
    private static Dictionary<string, object?> AuditDetail(string action, JsonElement? details, string? doorName, int? boardCourt)
    {
        var detail = Detail(
            ("door_name", doorName),
            ("reason", Text(details, "reason") ?? Text(details, "outcome")),
            ("method", Text(details, "method")),
            ("booking_id", Text(details, "booking_id")),
            // R12 D12-2: a board row's stored `court` is the relay index; it publishes the court it maps to, or nothing.
            ("court", IsBoardRow(action)
                ? boardCourt?.ToString(System.Globalization.CultureInfo.InvariantCulture)
                : Text(details, "court") ?? Text(details, "court_number")),
            // R11 E11-4: a court-box refusal's attempt (activate / walkup / pay_for), as stored.
            ("attempt", Text(details, "attempt")));

        // R12 E12-4 (C3): a reversal whose restored session overlapped another member's booking on
        // that court — which bookings, and from when (the other's start). Absent when there was none.
        if (CollisionIdsOf(details) is { Count: > 0 } collisions)
        {
            detail["collision_booking_ids"] = collisions;
            detail["collision_from"] = DoorActivityView.Instant(details, "collision_from");
        }

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

    /// <summary>R14 E14-2: one whole-number field out of a details document; null when absent or not a number.</summary>
    private static int? IntOf(JsonElement? details, string key)
    {
        return int.TryParse(Text(details, key), System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out var n)
            ? n
            : null;
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
            .Select(e => e.AmountMinutes ?? 0)
            .ToList();

        return new TraceSummary(
            FirstSeenAt: present.Count > 0 ? present.Min() : null,
            LastSeenAt: present.Count > 0 ? present.Max() : null,
            MinutesOnCourt: MinutesOnCourt(receipts),
            Courts: [.. events.Where(e => e.Court is not null).Select(e => e.Court!.Name).Distinct().Order()],
            MinutesSpent: -money.Where(a => a < 0).Sum(),
            MinutesReceived: money.Where(a => a > 0).Sum(),
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
