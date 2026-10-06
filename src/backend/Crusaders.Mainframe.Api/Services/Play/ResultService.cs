using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>A result as recorded or edited (camelCase on the wire). <c>games</c> is read raw so a non-integer is a score reason, not a 400 of the binder's.</summary>
public sealed record ResultRequest(
    string? IdempotencyKey = null, int? ExpectedVersion = null, string? Format = null,
    IReadOnlyList<string>? SideA = null, IReadOnlyList<string>? SideB = null, JsonElement? Games = null);

/// <summary>A confirm, dispute or withdraw: the version the member was shown, and a dispute's optional note.</summary>
public sealed record ResultActionRequest(int? ExpectedVersion = null, string? Note = null);

/// <summary>
/// A results answer: the result on success (<see cref="Changed"/> when this call moved it), or a
/// refusal code with its figures. <see cref="Affected"/> are the members whose record may have moved.
/// </summary>
public sealed record ResultOutcome(
    int StatusCode, string? Error = null, object? Figures = null, MatchResult? Result = null, bool Changed = false,
    IReadOnlyList<Guid>? Affected = null)
{
    public bool IsOk => Error is null;

    public static ResultOutcome Refuse(int status, string error, object? figures = null) => new(status, error, figures);

    public static ResultOutcome Ok(MatchResult r, int status = 200) => new(status, Result: r);
}

/// <summary>The stable error codes the results routes answer with (§6).</summary>
public static class ResultErrors
{
    public const string BookingNotFound = "booking_not_found";
    public const string ResultNotFound = "result_not_found";
    public const string IdempotencyKeyInvalid = "idempotency_key_invalid";
    public const string LineupInvalid = "lineup_invalid";
    public const string NotRecordable = "result_not_recordable";
    public const string Exists = "result_exists";
    public const string NotYours = "result_not_yours";
    public const string NotYoursToConfirm = "result_not_yours_to_confirm";
    public const string NotPending = "result_not_pending";
    public const string Changed = "result_changed";
    public const string NoteTooLong = "note_too_long";
    public const string ReasonRequired = "reason_required";
    public const string NotVoidable = "result_not_voidable";
    public const string NotDisputed = "result_not_disputed";

    public const string NotEnoughPlayers = "not_enough_players";
    public const string NotCheckedIn = "not_checked_in";

    /// <summary>The court time has not begun (review round 1, B15): a box check-in during early entry is not a game played.</summary>
    public const string NotStarted = "not_started";
    public const string WindowClosed = "window_closed";

    /// <summary>R18 J18-1: the booking was cancelled — a game called off is not one played, so it takes no result.</summary>
    public const string Cancelled = "cancelled";
}

/// <summary>Reads and writes a result's <c>GamesJson</c>: <c>[{"a":11,"b":7}, …]</c>.</summary>
public static class ResultGames
{
    public static IReadOnlyList<GameScore> Read(string json)
    {
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.EnumerateArray()
            .Select(g => new GameScore(g.GetProperty("a").GetInt32(), g.GetProperty("b").GetInt32())).ToList();
    }

    public static string Write(IEnumerable<GameScore> games)
    {
        return JsonSerializer.Serialize(games.Select(g => new { a = g.A, b = g.B }));
    }

    /// <summary>
    /// The submitted games, or the index of the first one that is not a pair of integers — which
    /// §4.1's first rule reads as <c>negative</c> ("a ≥ 0 and b ≥ 0, integers").
    /// </summary>
    public static (List<GameScore> Games, int? BadIndex) Parse(JsonElement? games)
    {
        var list = new List<GameScore>();
        if (games is not { ValueKind: JsonValueKind.Array } array) return (list, null);
        var i = 0;
        foreach (var g in array.EnumerateArray())
        {
            if (!TryInt(g, "a", out var a) || !TryInt(g, "b", out var b)) return (list, i);
            list.Add(new GameScore(a, b));
            i++;
        }
        return (list, null);
    }

    private static bool TryInt(JsonElement game, string name, out int value)
    {
        value = 0;
        return game.ValueKind == JsonValueKind.Object && game.TryGetProperty(name, out var v)
               && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out value);
    }
}

/// <summary>
/// The result state machine (<c>docs/specs/play.md</c> §3): record, edit, confirm, dispute,
/// withdraw, and the admin's void and uphold. Every time-dependent step takes <c>now</c> so the
/// deadline rules are testable at the instant.
///
/// <para>
/// <b>The deadline is the instant; the worker only catches up.</b> Every read and every action
/// first applies a due auto-confirmation in its own save (<see cref="SettleDueAsync"/>), so a
/// dispute a second after <c>ConfirmDueAt</c> is refused however recently the sweep ran.
/// </para>
///
/// <para>
/// <b>Races lose cleanly.</b> <see cref="MatchResult.Version"/> is the concurrency token: of an
/// auto-confirm and a dispute racing, one save wins and the loser re-reads and answers from the
/// winner's row.
/// </para>
/// </summary>
public sealed class ResultService
{
    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;
    private readonly TenantSettingsAccessor _settings;
    private readonly AdminChangeRecorder _changes;

    public ResultService(MainframeDbContext db, ITenantContext tenant, TenantSettingsAccessor settings, AdminChangeRecorder changes)
    {
        _db = db; _tenant = tenant; _settings = settings; _changes = changes;
    }

    // ------------------------------------------------------------------ reads

    /// <summary>The booking, when <paramref name="me"/> is a player of it; else null (the caller answers 404).</summary>
    public async Task<Booking?> PlayerBookingAsync(Guid bookingId, Guid me, CancellationToken ct) =>
        await AttendanceQuery.IsPlayerAsync(_db, bookingId, me, ct)
            ? await _db.Bookings.AsNoTracking().FirstOrDefaultAsync(b => b.Id == bookingId, ct)
            : null;

    /// <summary>The booking's live result, else its most recent closed one, else null. Tracked, with its lineup.</summary>
    public async Task<MatchResult?> CurrentAsync(Guid bookingId, CancellationToken ct)
    {
        var all = await _db.MatchResults.Include(r => r.Players)
            .Where(r => r.BookingId == bookingId).OrderByDescending(r => r.CreatedAt).ThenByDescending(r => r.Version).ToListAsync(ct);
        return all.FirstOrDefault(r => MatchResultStatus.IsLive(r.Status)) ?? all.FirstOrDefault();
    }

    /// <summary>
    /// Confirms <paramref name="r"/> when its deadline has passed, in its own save (§3.3). Answers
    /// the row as it now stands and whether this call confirmed it. A concurrency loss re-reads.
    /// </summary>
    public async Task<(MatchResult Result, bool Changed)> SettleDueAsync(MatchResult r, DateTimeOffset now, CancellationToken ct)
    {
        if (r.Status != MatchResultStatus.Pending || r.ConfirmDueAt is not { } due || due > now) return (r, false);

        r.Status = MatchResultStatus.Confirmed;
        r.AutoConfirmed = true;
        r.ConfirmedAt = due;
        r.ConfirmedByUserId = null;
        r.UpdatedAt = now.Storable();
        PlayNotices.Confirmed(_db, r, await ContextAsync(r, ct));
        await PlayNotices.RetireToConfirmAsync(_db, r, now, ct);
        try
        {
            await _db.SaveChangesAsync(ct);
            return (r, true);
        }
        catch (DbUpdateException ex) when (LostRace(ex))
        {
            // Somebody else decided first — a confirm, a dispute, the sweep. Answer from their row.
            var id = r.Id;
            _db.ChangeTracker.Clear();
            return (await _db.MatchResults.Include(x => x.Players).FirstAsync(x => x.Id == id, ct), false);
        }
    }

    // ------------------------------------------------------------------ record and edit

    /// <summary>Records a result (§3.1, §6.1). A replay of the same key by the same member answers the row as it now stands.</summary>
    public async Task<ResultOutcome> RecordAsync(Guid bookingId, Guid me, ResultRequest req, DateTimeOffset now, CancellationToken ct)
    {
        var key = req.IdempotencyKey?.Trim() ?? "";
        if (key.Length is < 1 or > MatchResult.IdempotencyKeyMaxLength) return ResultOutcome.Refuse(400, ResultErrors.IdempotencyKeyInvalid);
        if (await ReplayAsync(bookingId, me, key, now, ct) is { } replay) return replay;

        var booking = await PlayerBookingAsync(bookingId, me, ct);
        if (booking is null) return ResultOutcome.Refuse(404, ResultErrors.BookingNotFound);
        var settings = await _settings.GetAsync(ct);
        var candidates = await Lineup.CandidatesAsync(_db, booking, ct);
        if (NotRecordableReason(booking, candidates.Count, settings, now) is { } reason)
        {
            return ResultOutcome.Refuse(409, ResultErrors.NotRecordable, new { reason });
        }
        if (await LiveResultIdAsync(bookingId, now, ct) is { } live) return ResultOutcome.Refuse(409, ResultErrors.Exists, new { result_id = live });

        var (checkedMatch, refusal) = CheckMatch(req, candidates, me);
        if (refusal is not null) return refusal;

        var r = new MatchResult
        {
            TenantId = _tenant.TenantId,
            BookingId = bookingId,
            Status = MatchResultStatus.Pending,
            SubmittedByUserId = me,
            RecordedByUserId = me,
            SubmittedAt = now.Storable(),
            IdempotencyKey = key,
            ConfirmDueAt = now.AddHours(PlaySettings.AutoConfirmHours(settings)).Storable(),
            Version = await NextVersionAsync(bookingId, ct),
            CreatedAt = now.Storable(),
            UpdatedAt = now.Storable(),
        };
        Apply(r, checkedMatch!);
        _db.MatchResults.Add(r);
        await PlayNotices.StageToConfirmAsync(_db, r, await ContextAsync(r, ct), ct);
        return await SaveNewAsync(r, bookingId, me, now, ct);
    }

    /// <summary>Why <paramref name="booking"/> cannot take a result now (§3.1), or null when it can.</summary>
    public static string? NotRecordableReason(Booking booking, int candidates, TenantSettingsView settings, DateTimeOffset now)
    {
        // R18 J18-1: first — a game the club called off after it started was checked in, so every
        // later rule passed and it took a result nobody's attendance counted.
        if (IsCalledOff(booking)) return ResultErrors.Cancelled;
        if (booking.UserId is null || candidates < 2) return ResultErrors.NotEnoughPlayers;
        if (booking.CheckedInAt is not { } checkedIn) return ResultErrors.NotCheckedIn;
        // B15: from the court time's start or the check-in, whichever is later — a scan at the box
        // during early entry used to open recording before a ball was hit.
        if (now < (checkedIn > booking.StartsAt ? checkedIn : booking.StartsAt)) return ResultErrors.NotStarted;
        if (now > RecordClosesAt(booking, settings)) return ResultErrors.WindowClosed;
        return null;
    }

    /// <summary>R18 J18-1: the booking was cancelled — the one rule <see cref="AttendanceQuery"/> also keeps.</summary>
    public static bool IsCalledOff(Booking booking) => booking.Status == BookingStatus.Cancelled || booking.CancelledAt is not null;

    /// <summary>R18 J18-1: the refusal a confirm or an edit meets on a game since called off.</summary>
    private static Decision? CalledOff(Booking booking)
    {
        if (!IsCalledOff(booking)) return null;
        return Decision.Answer(ResultOutcome.Refuse(409, ResultErrors.NotRecordable, new { reason = ResultErrors.Cancelled }));
    }

    /// <summary>The last instant a result may be recorded: the booking's end as it stands plus <c>result_record_days</c>.</summary>
    public static DateTimeOffset RecordClosesAt(Booking booking, TenantSettingsView settings) =>
        booking.EndsAt.AddDays(PlaySettings.RecordDays(settings));

    /// <summary>Edits a pending result (§3.3): the submitting side only; the editor becomes the submitter and the clock restarts.</summary>
    public Task<ResultOutcome> EditAsync(Guid bookingId, Guid me, ResultRequest req, DateTimeOffset now, CancellationToken ct)
    {
        return ActAsync(new Act(bookingId, me, now), async (r, booking) =>
        {
            if (!OnSide(r, me, PlayNotices.SubmittingSide(r))) return Decision.Answer(ResultOutcome.Refuse(403, ResultErrors.NotYours));
            if (CalledOff(booking) is { } off) return off;
            if (r.Status != MatchResultStatus.Pending) return Decision.Answer(NotPending(r));
            if (req.ExpectedVersion != r.Version) return Decision.Answer(Stale(r));

            var candidates = await Lineup.CandidatesAsync(_db, booking, ct);
            var (checkedMatch, refusal) = CheckMatch(req, candidates, me);
            if (refusal is not null) return Decision.Answer(refusal);

            var settings = await _settings.GetAsync(ct);
            // The old lineup goes by a DELETE ahead of the save, in its transaction: EF would
            // insert the new rows before deleting the old, and (side, position) is unique.
            foreach (var old in r.Players) _db.Entry(old).State = EntityState.Detached;
            r.Players.Clear();
            Apply(r, checkedMatch!);
            r.SubmittedByUserId = me;
            r.EditedAt = now.Storable();
            r.UpdatedAt = now.Storable();
            r.ConfirmDueAt = now.AddHours(PlaySettings.AutoConfirmHours(settings)).Storable();
            await PlayNotices.StageToConfirmAsync(_db, r, await ContextAsync(r, ct), ct, r.Version + 1);
            return Decision.ReplacingLineup;
        }, ct);
    }

    // ------------------------------------------------------------------ confirm, dispute, withdraw

    public Task<ResultOutcome> ConfirmAsync(Guid bookingId, Guid me, int? expectedVersion, DateTimeOffset now, CancellationToken ct)
    {
        return ActAsync(new Act(bookingId, me, now), async (r, booking) =>
        {
            if (!OnConfirmingSide(r, me)) return Decision.Answer(ResultOutcome.Refuse(403, ResultErrors.NotYoursToConfirm));
            if (r.Status == MatchResultStatus.Confirmed && r.ConfirmedByUserId == me) return Decision.Answer(ResultOutcome.Ok(r));
            if (CalledOff(booking) is { } off) return off;
            if (r.Status != MatchResultStatus.Pending) return Decision.Answer(NotPending(r));
            if (expectedVersion != r.Version) return Decision.Answer(Stale(r));

            r.Status = MatchResultStatus.Confirmed;
            r.ConfirmedByUserId = me;
            r.ConfirmedAt = now.Storable();
            r.UpdatedAt = now.Storable();
            PlayNotices.Confirmed(_db, r, await ContextAsync(r, ct));
            return Decision.Applied;
        }, ct);
    }

    public Task<ResultOutcome> DisputeAsync(Guid bookingId, Guid me, ResultActionRequest req, DateTimeOffset now, CancellationToken ct)
    {
        var note = string.IsNullOrWhiteSpace(req.Note) ? null : req.Note.Trim();
        if (note is { Length: > MatchResult.DisputeNoteMaxLength })
        {
            return Task.FromResult(ResultOutcome.Refuse(400, ResultErrors.NoteTooLong, new { max = MatchResult.DisputeNoteMaxLength }));
        }

        return ActAsync(new Act(bookingId, me, now), async (r, _) =>
        {
            if (!OnConfirmingSide(r, me)) return Decision.Answer(ResultOutcome.Refuse(403, ResultErrors.NotYoursToConfirm));
            if (r.Status == MatchResultStatus.Disputed) return Decision.Answer(ResultOutcome.Ok(r));
            if (r.Status != MatchResultStatus.Pending) return Decision.Answer(NotPending(r));
            if (req.ExpectedVersion != r.Version) return Decision.Answer(Stale(r));

            r.Status = MatchResultStatus.Disputed;
            r.DisputedAt = now.Storable();
            r.DisputedByUserId = me;
            r.DisputeNote = note;
            r.ConfirmDueAt = null;
            r.UpdatedAt = now.Storable();
            PlayNotices.Disputed(_db, r, await ContextAsync(r, ct));
            return Decision.Applied;
        }, ct);
    }

    public Task<ResultOutcome> WithdrawAsync(Guid bookingId, Guid me, int? expectedVersion, DateTimeOffset now, CancellationToken ct)
    {
        return ActAsync(new Act(bookingId, me, now), (r, _) =>
        {
            if (!OnSide(r, me, PlayNotices.SubmittingSide(r))) return Task.FromResult(Decision.Answer(ResultOutcome.Refuse(403, ResultErrors.NotYours)));
            if (r.Status == MatchResultStatus.Withdrawn) return Task.FromResult(Decision.Answer(ResultOutcome.Ok(r)));
            if (r.Status is not (MatchResultStatus.Pending or MatchResultStatus.Disputed)) return Task.FromResult(Decision.Answer(NotPending(r)));
            if (expectedVersion != r.Version) return Task.FromResult(Decision.Answer(Stale(r)));

            r.Status = MatchResultStatus.Withdrawn;
            r.ClosedAt = now.Storable();
            r.ClosedByUserId = me;
            r.ConfirmDueAt = null;
            r.UpdatedAt = now.Storable();
            return Task.FromResult(Decision.Applied);
        }, ct);
    }

    // ------------------------------------------------------------------ admin

    /// <summary>An admin removes a result (§6.3): pending, disputed or confirmed. A second void is 200 and logs nothing.</summary>
    public Task<ResultOutcome> VoidAsync(Guid resultId, Guid admin, string? reason, DateTimeOffset now, CancellationToken ct)
    {
        return AdminActAsync(new AdminAct(resultId, admin, reason, now), async (r, why) =>
        {
            if (r.Status == MatchResultStatus.Voided) return Decision.Answer(ResultOutcome.Ok(r));
            if (r.Status == MatchResultStatus.Withdrawn) return Decision.Answer(ResultOutcome.Refuse(409, ResultErrors.NotVoidable, new { status = r.Status }));

            var from = r.Status;
            r.Status = MatchResultStatus.Voided;
            r.ClosedAt = now.Storable();
            r.ClosedByUserId = admin;
            r.CloseReason = why;
            r.ConfirmDueAt = null;
            r.UpdatedAt = now.Storable();
            var context = await ContextAsync(r, ct);
            await RecordChangeAsync(new AdminAct(resultId, admin, why, now), AdminChangeActions.PlayResultVoided, r, from, context, ct);
            PlayNotices.Voided(_db, r, context);
            return Decision.Applied;
        }, ct);
    }

    /// <summary>An admin keeps a disputed result (§6.3): it becomes confirmed, with the admin's reason.</summary>
    public Task<ResultOutcome> UpholdAsync(Guid resultId, Guid admin, string? reason, DateTimeOffset now, CancellationToken ct)
    {
        return AdminActAsync(new AdminAct(resultId, admin, reason, now), async (r, why) =>
        {
            if (r.Status != MatchResultStatus.Disputed) return Decision.Answer(ResultOutcome.Refuse(409, ResultErrors.NotDisputed, new { status = r.Status }));

            r.Status = MatchResultStatus.Confirmed;
            r.ConfirmedAt = now.Storable();
            r.ConfirmedByUserId = null;
            r.AutoConfirmed = false;
            r.ClosedByUserId = admin;
            r.CloseReason = why;
            r.UpdatedAt = now.Storable();
            var context = await ContextAsync(r, ct);
            await RecordChangeAsync(new AdminAct(resultId, admin, why, now), AdminChangeActions.PlayResultUpheld, r, MatchResultStatus.Disputed, context, ct);
            PlayNotices.Confirmed(_db, r, context, everyone: true);
            return Decision.Applied;
        }, ct);
    }

    // ------------------------------------------------------------------ plumbing

    private sealed record Act(Guid BookingId, Guid Me, DateTimeOffset Now);

    private sealed record AdminAct(Guid ResultId, Guid Admin, string? Reason, DateTimeOffset Now);

    /// <summary>What a step decided: answer without a change, or apply (the step already mutated the row).</summary>
    private sealed record Decision(ResultOutcome? Outcome)
    {
        public static Decision Answer(ResultOutcome outcome) => new(outcome);

        public static readonly Decision Applied = new((ResultOutcome?)null);

        /// <summary>Applied, and the stored lineup must be deleted in the save's transaction first.</summary>
        public static readonly Decision ReplacingLineup = new((ResultOutcome?)null) { ReplaceLineup = true };

        public bool ReplaceLineup { get; private init; }
    }

    /// <summary>
    /// A member's action on the booking's current result: 404 unless they are a player, the due
    /// auto-confirmation first, then <paramref name="decide"/>, then the save. A concurrency loss
    /// re-reads and decides again from the winner's row.
    /// </summary>
    private async Task<ResultOutcome> ActAsync(Act act, Func<MatchResult, Booking, Task<Decision>> decide, CancellationToken ct)
    {
        for (var attempt = 0; ; attempt++)
        {
            var booking = await PlayerBookingAsync(act.BookingId, act.Me, ct);
            if (booking is null) return ResultOutcome.Refuse(404, ResultErrors.BookingNotFound);
            if (await CurrentAsync(act.BookingId, ct) is not { } current) return ResultOutcome.Refuse(404, ResultErrors.ResultNotFound);
            var (r, settled) = await SettleDueAsync(current, act.Now, ct);
            var before = PlayNotices.MembersOf(r, null);

            var decision = await decide(r, booking);
            if (decision.Outcome is { } answer) return answer with { Changed = settled, Affected = before };
            await PlayNotices.RetireToConfirmAsync(_db, r, act.Now, ct);
            var saved = decision.ReplaceLineup ? await TrySaveReplacingLineupAsync(r.Id, ct) : await TrySaveAsync(ct);
            if (saved) return new ResultOutcome(200, Result: r, Changed: true, Affected: before.Union(PlayNotices.MembersOf(r, null)).ToList());
            if (attempt > 0) return Stale(await CurrentAsync(act.BookingId, ct) ?? r);
        }
    }

    private async Task<ResultOutcome> AdminActAsync(AdminAct act, Func<MatchResult, string, Task<Decision>> decide, CancellationToken ct)
    {
        var reason = act.Reason?.Trim();
        if (string.IsNullOrEmpty(reason) || reason.Length > MatchResult.CloseReasonMaxLength) return ResultOutcome.Refuse(400, ResultErrors.ReasonRequired);

        for (var attempt = 0; ; attempt++)
        {
            var current = await _db.MatchResults.Include(r => r.Players).FirstOrDefaultAsync(r => r.Id == act.ResultId, ct);
            if (current is null) return ResultOutcome.Refuse(404, ResultErrors.ResultNotFound);
            var (r, settled) = await SettleDueAsync(current, act.Now, ct);
            var members = PlayNotices.MembersOf(r, null);

            var decision = await decide(r, reason);
            if (decision.Outcome is { } answer) return answer with { Changed = settled, Affected = members };
            await PlayNotices.RetireToConfirmAsync(_db, r, act.Now, ct);
            if (await TrySaveAsync(ct)) return new ResultOutcome(200, Result: r, Changed: true, Affected: members);
            if (attempt > 0) return ResultOutcome.Refuse(409, PlayerErrors.Conflict);
        }
    }

    /// <summary>Saves; on a concurrency loss clears the context (the staged notices and change row go with it) and answers false.</summary>
    private async Task<bool> TrySaveAsync(CancellationToken ct)
    {
        try
        {
            await _db.SaveChangesAsync(ct);
            return true;
        }
        catch (DbUpdateException ex) when (LostRace(ex))
        {
            _db.ChangeTracker.Clear();
            return false;
        }
    }

    /// <summary>Deletes the stored lineup and saves the new one in one transaction; a lost race rolls both back.</summary>
    private async Task<bool> TrySaveReplacingLineupAsync(Guid resultId, CancellationToken ct)
    {
        await using var tx = await _db.Database.BeginTransactionAsync(ct);
        await _db.MatchResultPlayers.Where(p => p.ResultId == resultId).ExecuteDeleteAsync(ct);
        if (!await TrySaveAsync(ct)) return false;
        await tx.CommitAsync(ct);
        return true;
    }

    /// <summary>
    /// A save that lost to another writer: the version moved under it, or the notices it staged for
    /// the same event were already written by the winner (the inbox's dedupe index fires before the
    /// row's own version check can) — either way, re-read and answer from the winner's row.
    /// </summary>
    private static bool LostRace(DbUpdateException ex)
    {
        return ex is DbUpdateConcurrencyException || ex.InnerException is Npgsql.PostgresException { SqlState: "23505" };
    }

    private async Task<ResultOutcome?> ReplayAsync(Guid bookingId, Guid me, string key, DateTimeOffset now, CancellationToken ct)
    {
        var found = await _db.MatchResults.Include(r => r.Players)
            .FirstOrDefaultAsync(r => r.RecordedByUserId == me && r.IdempotencyKey == key, ct);
        if (found is null) return null;
        if (found.BookingId != bookingId) return ResultOutcome.Refuse(400, ResultErrors.IdempotencyKeyInvalid);
        if (!await AttendanceQuery.IsPlayerAsync(_db, bookingId, me, ct)) return ResultOutcome.Refuse(404, ResultErrors.BookingNotFound);
        var (r, settled) = await SettleDueAsync(found, now, ct);
        return new ResultOutcome(200, Result: r, Changed: settled, Affected: PlayNotices.MembersOf(r, null));
    }

    /// <summary>The live result on the booking after applying its due confirmation, if there is one.</summary>
    private async Task<Guid?> LiveResultIdAsync(Guid bookingId, DateTimeOffset now, CancellationToken ct)
    {
        var live = await _db.MatchResults.Include(r => r.Players)
            .FirstOrDefaultAsync(r => r.BookingId == bookingId && MatchResultStatus.Live.Contains(r.Status), ct);
        if (live is null) return null;
        await SettleDueAsync(live, now, ct);
        return live.Id;
    }

    /// <summary>One past the highest version any result on this booking reached, so an <c>expectedVersion</c> names one result.</summary>
    private async Task<int> NextVersionAsync(Guid bookingId, CancellationToken ct) =>
        (await _db.MatchResults.Where(r => r.BookingId == bookingId).MaxAsync(r => (int?)r.Version, ct) ?? 0) + 1;

    /// <summary>Saves a new result; a lost race on the live index is <c>result_exists</c>, on the key index a replay.</summary>
    private async Task<ResultOutcome> SaveNewAsync(MatchResult r, Guid bookingId, Guid me, DateTimeOffset now, CancellationToken ct)
    {
        try
        {
            await _db.SaveChangesAsync(ct);
            return new ResultOutcome(201, Result: r, Changed: true, Affected: PlayNotices.MembersOf(r, null));
        }
        catch (DbUpdateException)
        {
            _db.ChangeTracker.Clear();
            if (await ReplayAsync(bookingId, me, r.IdempotencyKey, now, ct) is { } replay) return replay;
            var live = await _db.MatchResults.AsNoTracking()
                .Where(x => x.BookingId == bookingId && MatchResultStatus.Live.Contains(x.Status)).Select(x => (Guid?)x.Id).FirstOrDefaultAsync(ct);
            if (live is { } id) return ResultOutcome.Refuse(409, ResultErrors.Exists, new { result_id = id });
            throw;
        }
    }

    /// <summary>A checked lineup and score, ready to write.</summary>
    private sealed record CheckedMatch(string Format, LineupCheck Lineup, IReadOnlyList<GameScore> Games, MatchVerdict Verdict);

    /// <summary>Format, then lineup, then score — the create's and the edit's shared validation.</summary>
    private static (CheckedMatch? Match, ResultOutcome? Refusal) CheckMatch(ResultRequest req, IReadOnlyList<LineupCandidate> candidates, Guid me)
    {
        var format = req.Format ?? MatchFormat.BestOf5;
        if (SquashScore.GamesNeeded(format) is null) return (null, ResultOutcome.Refuse(400, SquashScore.FormatInvalid));

        var lineup = Lineup.Validate(req.SideA, req.SideB, candidates, me);
        if (!lineup.Ok) return (null, ResultOutcome.Refuse(400, ResultErrors.LineupInvalid, new { reason = lineup.Reason }));

        var (games, bad) = ResultGames.Parse(req.Games);
        if (bad is { } index) return (null, ResultOutcome.Refuse(400, SquashScore.ScoreInvalid, new { game_index = index, reason = SquashScore.Negative }));
        var verdict = SquashScore.Validate(format, games);
        if (!verdict.Ok) return (null, ResultOutcome.Refuse(400, verdict.Error!, VerdictFigures(verdict)));
        return (new CheckedMatch(format, lineup, games, verdict), null);
    }

    /// <summary>The figures each score refusal carries (§6.1).</summary>
    private static object? VerdictFigures(MatchVerdict v)
    {
        if (v.Error == SquashScore.ScoreInvalid) return new { game_index = v.GameIndex, reason = v.Reason };
        if (v.Error == SquashScore.GamesAfterDecided) return new { game_index = v.GameIndex };
        if (v.Error == SquashScore.MatchIncomplete) return new { games_needed = v.GamesNeeded };
        return null;
    }

    private void Apply(MatchResult r, CheckedMatch m)
    {
        r.Format = m.Format;
        r.GamesJson = ResultGames.Write(m.Games);
        r.GamesWonA = (short)m.Verdict.WonA;
        r.GamesWonB = (short)m.Verdict.WonB;
        r.WinnerSide = m.Verdict.Winner!;
        AddSide(r, MatchSide.A, m.Lineup.SideA);
        AddSide(r, MatchSide.B, m.Lineup.SideB);
    }

    private void AddSide(MatchResult r, string side, IReadOnlyList<LineupCandidate> players)
    {
        for (var i = 0; i < players.Count; i++)
        {
            var p = players[i];
            var row = new MatchResultPlayer
            {
                TenantId = _tenant.TenantId,
                ResultId = r.Id,
                Side = side,
                Position = (short)(i + 1),
                UserId = p.UserId,
                ParticipantId = p.ParticipantId,
                GuestName = p.GuestName,
            };
            // Added explicitly: a row with its key already set, found only through a TRACKED
            // result's collection (an edit), would be taken for an existing row and UPDATEd.
            // (EF's fixup puts it in the tracked result's collection; an untracked one needs it added.)
            _db.MatchResultPlayers.Add(row);
            if (!r.Players.Contains(row)) r.Players.Add(row);
        }
    }

    private static bool OnSide(MatchResult r, Guid me, string side) => r.Players.Any(p => p.UserId == me && p.Side == side);

    private static bool OnConfirmingSide(MatchResult r, Guid me) => OnSide(r, me, MatchSide.Other(PlayNotices.SubmittingSide(r)));

    private static ResultOutcome NotPending(MatchResult r)
    {
        return ResultOutcome.Refuse(409, ResultErrors.NotPending, new { status = r.Status });
    }

    private static ResultOutcome Stale(MatchResult r)
    {
        return ResultOutcome.Refuse(409, ResultErrors.Changed, new { version = r.Version, status = r.Status });
    }

    /// <summary>The court, the club's settings and the names every notice about <paramref name="r"/> needs.</summary>
    public async Task<ResultContext> ContextAsync(MatchResult r, CancellationToken ct)
    {
        var booking = await _db.Bookings.AsNoTracking().FirstAsync(b => b.Id == r.BookingId, ct);
        var court = await _db.Courts.AsNoTracking().Where(c => c.Id == booking.CourtId).Select(c => c.Name).FirstOrDefaultAsync(ct);
        var people = r.Players.Where(p => p.UserId != null).Select(p => p.UserId!.Value)
            .Append(r.SubmittedByUserId).Concat(r.DisputedByUserId is { } d ? [d] : []);
        return new ResultContext(booking, court ?? "the court", await _settings.GetAsync(ct), await PlayNotices.NamesAsync(_db, people, ct));
    }

    private async Task RecordChangeAsync(
        AdminAct act, string action, MatchResult r, string fromStatus, ResultContext context, CancellationToken ct)
    {
        await _changes.StageAsync(new AdminChange(
            action, act.Admin, AdminChangeSubjects.MatchResult, r.Id, $"{context.CourtName}, {context.When}", act.Reason,
            // The status on BOTH sides (review round 4 wave B): `from_status` sat on the after side
            // alone and the record read "Status: Disputed → —" over a result the club had kept.
            Before: new { status = fromStatus },
            After: new
            {
                status = r.Status,
                result_id = r.Id,
                booking_id = r.BookingId,
                reason = act.Reason,
                games = ResultGames.Read(r.GamesJson).Select(g => new { a = g.A, b = g.B }),
                format = r.Format,
                subject_user_id = r.SubmittedByUserId,
                lineup_user_ids = PlayNotices.MembersOf(r, null),
            }), ct);
    }
}
