using System.Security.Cryptography;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>A claim on one acting use (§4.4). <paramref name="Fresh"/> is false for a claim re-entered by the same act retried.</summary>
public sealed record MemberCodeClaim(Guid Id, bool Fresh)
{
    /// <summary>What was claimed, so a re-entered claim can be held again (<see cref="MemberCodeService.HoldAgainAsync"/>).</summary>
    public MemberCodeClaimTerms? Terms { get; init; }
}

/// <summary>The terms of one claim: the code and class it uses, the board, the act's kind and its idempotency key.</summary>
public sealed record MemberCodeClaimTerms(MemberCodeMatch Match, string UseClass, Guid? DeviceId, string Kind, string? Key);

/// <summary>A v1 code the server checked and accepted: whose it is, and the step it was accepted at.</summary>
public sealed record MemberCodeMatch(Guid UserId, int RefValue, string Ref, long Step, int Generation);

/// <summary>What the server made of a v1 token a device reported having acted on offline (§7).</summary>
public abstract record MemberCodeEvidence
{
    /// <summary>Both halves reproduce at one step: a genuine offline use.</summary>
    public sealed record Genuine(MemberCodeMatch Match) : MemberCodeEvidence;

    /// <summary>
    /// The server cannot reproduce what the device accepted. <paramref name="Why"/> is
    /// <c>off_mismatch</c> (a firmware defect or tampering), <c>on_mismatch</c> (somebody held
    /// K_day and not S — a copied roster or a stolen box), <c>reused</c> (one code acted on twice
    /// across devices) or <c>malformed</c>.
    /// </summary>
    public sealed record Forged(string Why, Guid? UserId, string? Ref) : MemberCodeEvidence;
}

/// <summary>
/// The member code's server half (<c>docs/specs/member-code.md</c> §3–§4, §7, §10): each member's
/// REF and generation, the online check, the use table, rotation and the evidence re-check.
///
/// <para>
/// <b>S is never stored and never logged.</b> It is derived from the master key each time it is
/// needed and handed out once per enrolment, over the member's own authenticated session.
/// </para>
/// </summary>
public sealed class MemberCodeService
{
    /// <summary>A REF collision is a one-in-a-million event per draw; a handful of retries is the whole budget.</summary>
    private const int RefDrawAttempts = 8;

    /// <summary>Steps either side of an uploaded event's estimated instant the evidence check searches (§7).</summary>
    public const int EvidenceWindowSteps = 4;

    /// <summary>Use rows older than this are purged — a code is worthless ninety seconds after it was shown (§4.4).</summary>
    public static readonly TimeSpan UseRetention = TimeSpan.FromDays(1);

    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;
    private readonly MemberCodeMasterKey _master;
    private readonly SessionEpochs _sessions;
    private readonly RefreshSessions _refresh;

    /// <summary>
    /// R14 D14-4: the device routes' clock. A use's <c>UsedAt</c> is what an uploaded offline twin of
    /// the same scan is matched against (<c>DeviceEventEndpoints.SameActTolerance</c>), and that
    /// event is placed on this clock — a claim on the wall clock read it as a second use.
    /// </summary>
    private readonly TimeProvider _clock;

    public MemberCodeService(
        MainframeDbContext db, ITenantContext tenant, MemberCodeMasterKey master, SessionEpochs sessions, RefreshSessions refresh,
        TimeProvider clock)
    {
        _clock = clock;
        _refresh = refresh;
        _db = db;
        _tenant = tenant;
        _master = master;
        _sessions = sessions;
    }

    // ---- Identity -------------------------------------------------------------------------------

    /// <summary>The member's code row, created with a fresh random REF the first time it is asked for.</summary>
    public async Task<MemberCode> EnsureAsync(Guid userId, CancellationToken ct)
    {
        var rows = await EnsureManyAsync([userId], ct);
        return rows[userId];
    }

    /// <summary>
    /// Every member's code row, creating the missing ones — one read for the batch, so a roster of
    /// forty-eight bookings is not forty-eight round trips. Created rows are saved immediately and
    /// on their own: a REF is an identity other rows will point at, and it must exist before any
    /// roster carries it.
    /// </summary>
    public async Task<IReadOnlyDictionary<Guid, MemberCode>> EnsureManyAsync(IReadOnlyCollection<Guid> userIds, CancellationToken ct)
    {
        var wanted = userIds.Distinct().ToList();
        var found = await _db.MemberCodes.Where(c => wanted.Contains(c.UserId)).ToListAsync(ct);
        var rows = found.ToDictionary(c => c.UserId);

        foreach (var userId in wanted.Where(u => !rows.ContainsKey(u)))
        {
            rows[userId] = await CreateAsync(userId, ct);
        }

        return rows;
    }

    private async Task<MemberCode> CreateAsync(Guid userId, CancellationToken ct)
    {
        for (var attempt = 0; attempt < RefDrawAttempts; attempt++)
        {
            var draw = RandomNumberGenerator.GetInt32(1, MemberCodeMath.MaxRefValue + 1);
            if (await _db.MemberCodes.AnyAsync(c => c.Ref == draw, ct)) continue;

            var row = new MemberCode { TenantId = _tenant.TenantId, UserId = userId, Ref = draw };
            _db.MemberCodes.Add(row);
            try
            {
                await _db.SaveChangesAsync(ct);
                return row;
            }
            catch (DbUpdateException ex) when (IsUniqueViolation(ex))
            {
                _db.Entry(row).State = EntityState.Detached;

                // Either the REF was taken between the check and the insert, or another request
                // created this member's row first. The second is an answer, not a retry.
                var raced = await _db.MemberCodes.FirstOrDefaultAsync(c => c.UserId == userId, ct);
                if (raced is not null) return raced;
            }
        }

        throw new InvalidOperationException("could not draw a free REF; the tenant's REF space is implausibly full");
    }

    /// <summary>S at the row's current generation.</summary>
    public byte[] SecretOf(MemberCode row) => SecretAt(row.UserId, row.Generation);

    private byte[] SecretAt(Guid userId, int generation) =>
        MemberCodeMath.MemberSecret(_master.Bytes, _tenant.TenantId, userId, generation);

    /// <summary>K_day of a member for one club day, under their current generation.</summary>
    public byte[] KdayOf(MemberCode row, string clubDay) => MemberCodeMath.Kday(SecretOf(row), clubDay);

    // ---- Rotation (§10) ------------------------------------------------------------------------

    /// <summary>
    /// Moves the member to a new generation — every code their phone can compute stops working,
    /// and the phone's next status check re-enrols — AND ends every session they had open, by
    /// raising <see cref="User.SessionEpoch"/>.
    ///
    /// <para>
    /// <b>The epoch moves NOW, in one SQL statement; the generation is staged.</b> The caller's own
    /// change (a password, a suspension) and the new generation commit together. The epoch does
    /// not wait for them: it is incremented atomically and committed first, so there is no instant
    /// in which the new generation is visible and an old session is still current — which is the
    /// ordering <c>/me/code/enrol</c>'s row lock relies on. A save that then fails has ended the
    /// member's sessions without rotating their code: a sign-in, never a hole.
    /// </para>
    ///
    /// <para>
    /// <b>Why the sessions go with the code.</b> A rotation is the desk's answer to "I lost my
    /// phone". Retiring the codes alone left the phone's signed-in PWA free to call
    /// <c>/me/code/enrol</c> and be handed the new generation's secret. A member changing their own
    /// password is re-issued a token under the new epoch (<see cref="AuthService.ChangePasswordAsync"/>).
    /// </para>
    ///
    /// <para>
    /// A member who has never had a code row has never been handed a secret, so there is no
    /// generation to move and false is returned — but their sessions are still ended.
    /// </para>
    ///
    /// <para>
    /// <b>Every caller calls <see cref="CompleteRotationsAsync"/> after its own save commits</b> —
    /// the second raise that ends a session signed in with the old credential in between.
    /// </para>
    /// </summary>
    public async Task<bool> StageRotationAsync(Guid userId, Guid actorUserId, string reason, CancellationToken ct)
    {
        var epoch = await RaiseSessionEpochAsync(userId, ct);
        _awaitingSecondRaise.Add(userId);

        var row = await _db.MemberCodes.FirstOrDefaultAsync(c => c.UserId == userId, ct);
        if (row is null) return false;

        row.Generation += 1;
        row.RotatedAt = _clock.GetUtcNow();
        _db.AuditLogs.Add(new AuditLog
        {
            TenantId = _tenant.TenantId,
            ActorUserId = actorUserId,
            SubjectUserId = userId,
            Action = RotatedAction,
            DetailsJson = JsonSerializer.Serialize(new { reason, generation = row.Generation, session_epoch = epoch }),
        });
        return true;
    }

    /// <summary>
    /// <c>SessionEpoch = SessionEpoch + 1</c> in one statement, committed at once, and the cache
    /// evicted after it. A tracked copy of the user is brought up to the new value WITHOUT being
    /// marked modified, so the caller's save can neither write it back down nor race another
    /// rotation's increment. Returns the new epoch, or null for an unknown user.
    /// </summary>
    private async Task<int?> RaiseSessionEpochAsync(Guid userId, CancellationToken ct)
    {
        int? epoch;
        Guid? tenantId;
        if (_db.Database.IsRelational())
        {
            var raised = await _db.Database.SqlQuery<EpochRow>($"""
                UPDATE users SET "SessionEpoch" = "SessionEpoch" + 1
                 WHERE "Id" = {userId} AND "TenantId" = {_tenant.TenantId}
                RETURNING "SessionEpoch", "TenantId"
                """).ToListAsync(ct);
            epoch = raised.Count == 1 ? raised[0].SessionEpoch : null;
            tenantId = raised.Count == 1 ? raised[0].TenantId : null;
        }
        else
        {
            var row = await _db.Users.FirstOrDefaultAsync(u => u.Id == userId, ct);
            if (row is not null)
            {
                row.SessionEpoch += 1;
                await _db.SaveChangesAsync(ct);
            }
            epoch = row?.SessionEpoch;
            tenantId = row?.TenantId;
        }
        if (epoch is not { } value || tenantId is not { } tenant) return null;

        var tracked = _db.ChangeTracker.Entries<User>().FirstOrDefault(e => e.Entity.Id == userId);
        if (tracked is not null)
        {
            tracked.Property(u => u.SessionEpoch).CurrentValue = value;
            tracked.Property(u => u.SessionEpoch).OriginalValue = value;
            tracked.Property(u => u.SessionEpoch).IsModified = false;
        }
        _sessions.Invalidate(tenant, userId);

        // The refresh links die with the epoch anyway (an exchange refuses a link below it); they
        // are stamped revoked as well so the table says what happened to them (B1).
        await _refresh.RevokeUserAsync(tenant, userId, ct);
        return value;
    }

    private sealed record EpochRow(int SessionEpoch, Guid TenantId);

    private readonly HashSet<Guid> _awaitingSecondRaise = [];

    /// <summary>
    /// The rotation's SECOND epoch raise, called by every rotating caller once its own save has
    /// committed. <b>Why twice:</b> the first raise (in <see cref="StageRotationAsync"/>) must come
    /// before the new generation commits, or a refresh in between keeps an old session alive; but
    /// until the caller's save commits, the OLD password still verifies and a lost phone's passkey
    /// still exists — a sign-in landing in that gap is minted under the NEW epoch and survived the
    /// rotation (refuted 2026-09-28). Raising again after the commit ends it, and nothing can sign
    /// in with the old credential after this point. A member's own replacement token (a password
    /// change) is minted after this, from the second value. Evicts the cache each time.
    /// </summary>
    public async Task CompleteRotationsAsync(CancellationToken ct)
    {
        foreach (var userId in _awaitingSecondRaise.ToList())
        {
            await RaiseSessionEpochAsync(userId, ct);
            _awaitingSecondRaise.Remove(userId);
        }
    }

    /// <summary>
    /// Deletes every passkey the member has registered (member-code §13): after a lost-phone reset
    /// the phone's passkey still signs in and would mint a session under the NEW epoch — the reset
    /// then changed nothing for whoever holds the phone. Staged with an audit row naming how many
    /// went; the caller saves. Returns the count.
    /// </summary>
    public async Task<int> StagePasskeyRevocationAsync(Guid userId, Guid actorUserId, string reason, CancellationToken ct)
    {
        var passkeys = await _db.WebAuthnCredentials.Where(c => c.UserId == userId).ToListAsync(ct);
        _db.WebAuthnCredentials.RemoveRange(passkeys);
        _db.AuditLogs.Add(new AuditLog
        {
            TenantId = _tenant.TenantId,
            ActorUserId = actorUserId,
            SubjectUserId = userId,
            Action = PasskeysRevokedAction,
            DetailsJson = JsonSerializer.Serialize(new { reason, removed = passkeys.Count }),
        });
        return passkeys.Count;
    }

    public const string PasskeysRevokedAction = "member.passkeys_revoked";

    public const string RotatedAction = "member_code.rotated";
    public const string EnrolledAction = "member_code.enrolled";

    // ---- The online check (§4.2–§4.3) ----------------------------------------------------------

    /// <summary>
    /// Whose code this is, checked at the instant the device says it read it, or null.
    ///
    /// <para>
    /// <b>Null covers every failure, on purpose</b> — malformed, a REF nobody here holds, another
    /// tenant's REF, a member who may not act, an old generation, a wrong half, a scan too old —
    /// because a path that told them apart would be an oracle for which REFs exist.
    /// </para>
    /// </summary>
    public async Task<MemberCodeMatch?> VerifyAsync(
        string? token, DateTimeOffset receivedAt, long? scanAgeMs, TenantSettingsView settings, CancellationToken ct)
    {
        if (MemberCodeMath.Parse(token) is not { } parsed) return null;

        var age = scanAgeMs ?? 0;
        if (age < 0 || age > MemberCodeSettings.MaxScanAgeMs(settings)) return null;

        // Tenant-filtered: another club's REF resolves to nothing here, structurally.
        var row = await _db.MemberCodes.AsNoTracking().FirstOrDefaultAsync(c => c.Ref == parsed.RefValue, ct);
        if (row is null) return null;

        // §4.3: "a member without a membership row that may act". An ACTIVE row, the same rule
        // every roster and every activation path applies.
        var mayAct = await _db.Memberships.AsNoTracking()
            .AnyAsync(m => m.UserId == row.UserId && m.Status == MembershipStatus.Active, ct);
        if (!mayAct) return null;

        var zone = MemberCodeMath.ZoneOf(settings.Timezone);
        var secret = SecretOf(row);
        var t = MemberCodeMath.StepOf(receivedAt.AddMilliseconds(-age));

        foreach (var s in new[] { t, t - 1, t + 1 })
        {
            if (MemberCodeMath.SameDigits(MemberCodeMath.On(secret, s), parsed.On)
                & MemberCodeMath.SameDigits(MemberCodeMath.Off(secret, s, zone), parsed.Off))
            {
                return new MemberCodeMatch(row.UserId, row.Ref, parsed.Ref, s, row.Generation);
            }
        }

        return null;
    }

    // ---- The evidence re-check (§7) ------------------------------------------------------------

    /// <summary>
    /// What a v1 subject on an uploaded event proves. Searches <c>[step(est) − 4, step(est) + 4]</c>
    /// for an OFF match under the member's K_day, then checks ON at that same step.
    ///
    /// <para>
    /// The previous generation is searched as well as the current one — but only within
    /// <see cref="PreviousGenerationGrace"/> of the rotation and for a member active at the scan
    /// (<see cref="PreviousGenerationHonestAtAsync"/>). A board that was offline across a rotation
    /// held the old generation's keys and verified the old generation's codes honestly; calling
    /// that a forgery would page every administrator for a member whose password change happened
    /// to land during an outage. A code that is genuine under neither is what this exists to catch.
    /// </para>
    /// </summary>
    public async Task<MemberCodeEvidence> CheckEvidenceAsync(
        string? token, DateTimeOffset estimatedAt, TenantSettingsView settings, CancellationToken ct)
    {
        if (MemberCodeMath.Parse(token) is not { } parsed) return new MemberCodeEvidence.Forged("malformed", null, null);

        var row = await _db.MemberCodes.AsNoTracking().FirstOrDefaultAsync(c => c.Ref == parsed.RefValue, ct);
        if (row is null) return new MemberCodeEvidence.Forged("off_mismatch", null, parsed.Ref);

        var zone = MemberCodeMath.ZoneOf(settings.Timezone);
        var estimate = MemberCodeMath.StepOf(estimatedAt);
        var offOnly = false;

        var generations = row.Generation > 1 && await PreviousGenerationHonestAtAsync(row, estimatedAt, ct)
            ? new[] { row.Generation, row.Generation - 1 }
            : [row.Generation];
        foreach (var generation in generations)
        {
            var secret = SecretAt(row.UserId, generation);
            for (var d = 0; d <= EvidenceWindowSteps * 2; d++)
            {
                // est, est−1, est+1, est−2, est+2 …
                var s = estimate + ((d % 2 == 0 ? 1 : -1) * ((d + 1) / 2));
                if (!MemberCodeMath.SameDigits(MemberCodeMath.Off(secret, s, zone), parsed.Off)) continue;
                if (MemberCodeMath.SameDigits(MemberCodeMath.On(secret, s), parsed.On))
                {
                    return new MemberCodeEvidence.Genuine(new MemberCodeMatch(row.UserId, row.Ref, parsed.Ref, s, generation));
                }
                offOnly = true;
            }
        }

        return new MemberCodeEvidence.Forged(offOnly ? "on_mismatch" : "off_mismatch", row.UserId, parsed.Ref);
    }

    /// <summary>
    /// How long after a rotation a board can honestly still verify the old generation: the life
    /// of the roster that carried its keys (<c>ROSTER_MAX_AGE_MS</c>, six hours, §6.2). Past it
    /// every board has either fetched the new keys or stopped verifying anybody.
    /// </summary>
    public static readonly TimeSpan PreviousGenerationGrace = TimeSpan.FromHours(6);

    /// <summary>
    /// Whether an old-generation code used at <paramref name="at"/> could have been verified
    /// honestly: inside <see cref="PreviousGenerationGrace"/> of the rotation, and by a member who
    /// was active then. <b>Why bounded:</b> accepted unbounded, a code from a phone the desk
    /// retired — lost, stolen, a suspended member's — was genuine evidence forever, at any board
    /// holding a stale key, and never raised the alarm the rotation exists to raise.
    ///
    /// <para>
    /// "Active at <paramref name="at"/>" is read off the membership as it stands: active now and
    /// not re-decided since <paramref name="at"/>. A membership decided after the scan (a
    /// suspension lifted, say) cannot say what it was at the scan, so the old generation is not
    /// honoured — the current one still is, and the alarm is the conservative mistake.
    /// </para>
    /// </summary>
    private async Task<bool> PreviousGenerationHonestAtAsync(MemberCode row, DateTimeOffset at, CancellationToken ct)
    {
        if (row.RotatedAt is not { } rotated || at > rotated.Add(PreviousGenerationGrace)) return false;
        return await _db.Memberships.AsNoTracking().AnyAsync(
            m => m.UserId == row.UserId && m.Status == MembershipStatus.Active && (m.ReviewedAt == null || m.ReviewedAt <= at), ct);
    }

    // ---- The use table (§4.4) -------------------------------------------------------------------

    /// <summary>Whether this code has already been acted on in this class.</summary>
    public Task<bool> IsUsedAsync(MemberCodeMatch match, string useClass, CancellationToken ct) =>
        _db.MemberCodeUses.AsNoTracking()
            .AnyAsync(u => u.Ref == match.RefValue && u.Step == match.Step && u.UseClass == useClass, ct);

    /// <summary>Whether this code has already been acted on in ANY of <paramref name="useClasses"/>.</summary>
    public Task<bool> IsUsedAsync(MemberCodeMatch match, IReadOnlyCollection<string> useClasses, CancellationToken ct) =>
        _db.MemberCodeUses.AsNoTracking()
            .AnyAsync(u => u.Ref == match.RefValue && u.Step == match.Step && useClasses.Contains(u.UseClass), ct);

    /// <summary>
    /// Claims one acting use, or answers null when it is already taken — <c>code_used</c>.
    ///
    /// <para>
    /// <b>Claimed BEFORE the action and released if the action does not happen</b>, so the end
    /// state is exactly "a row only when the server acted" while two concurrent requests carrying
    /// one code can never both act: the unique index decides between them, not a read that both
    /// passed. Written OUTSIDE the request's change tracker, with <c>ON CONFLICT DO NOTHING</c>,
    /// so a claim neither flushes the caller's pending changes early nor poisons its context
    /// with a failed insert.
    /// </para>
    ///
    /// <para>
    /// <b>Re-entrant for the same act.</b> When the caller has an idempotency key of its own — a
    /// walk-up's or a pay-for's nonce — a taken row carrying the SAME device and the SAME key is
    /// that act retried, and the claim is handed back as <see cref="MemberCodeClaim.Fresh"/> =
    /// false rather than refused: two identical retries in flight together used to answer one of
    /// them <c>code_used</c> for a purchase that went through. A re-entered claim is never
    /// released by the request that re-entered it; it belongs to the one that made it.
    /// </para>
    ///
    /// <para>
    /// R19 BE19L: <b>a use given back between the insert and the read is free.</b> The insert met a
    /// row (ON CONFLICT DO NOTHING) and the read that follows found none: the request holding it gave
    /// it back in between (its act failed — a lost connection, a refusal). That is not "already
    /// used"; it was answered <c>code_used</c> to a box retrying a purchase nobody had made. The
    /// claim is tried again, a bounded number of times.
    /// </para>
    /// </summary>
    public async Task<MemberCodeClaim?> TryClaimAsync(
        MemberCodeMatch match, string useClass, Guid? deviceId, string kind, CancellationToken ct, string? claimKey = null)
    {
        var key = claimKey is { Length: > MemberCodeUse.ClaimKeyMaxLength } ? claimKey[..MemberCodeUse.ClaimKeyMaxLength] : claimKey;
        var terms = new MemberCodeClaimTerms(match, useClass, deviceId, kind, key);
        for (var attempt = 1; ; attempt++)
        {
            if (await InsertUseAsync(terms, ct) is { } id) return new MemberCodeClaim(id, Fresh: true) { Terms = terms };

            var taken = await FindUseAsync(match, useClass, ct);
            if (taken is null && attempt < ClaimAttempts) continue;
            if (taken is null || key is null || deviceId is null) return null;
            return taken.DeviceId == deviceId && taken.ClaimKey == key
                ? new MemberCodeClaim(taken.Id, Fresh: false) { Terms = terms }
                : null;
        }
    }

    /// <summary>How many times a claim is tried when the use it met keeps being given back before it can be read.</summary>
    private const int ClaimAttempts = 3;

    /// <summary>
    /// R19 BE19L: holds a RE-ENTERED claim's use again once its act has committed. The request that
    /// made the claim may have given it back after this one re-entered it (its own attempt failed,
    /// and its "did the act commit?" read came before this one's commit), leaving an act with no use
    /// behind it — and the code free to act again. Re-claimed under the same terms: restored when it
    /// is gone, a no-op when it is still there. A fresh claim needs nothing; only its maker releases it.
    /// </summary>
    public async Task HoldAgainAsync(MemberCodeClaim? claim, CancellationToken ct)
    {
        if (claim is not { Fresh: false, Terms: { } t }) return;
        await TryClaimAsync(t.Match, t.UseClass, t.DeviceId, t.Kind, ct, t.Key);
    }

    /// <summary>Inserts the use row; its id when this request took it, null when the code already holds one in this class.</summary>
    private async Task<Guid?> InsertUseAsync(MemberCodeClaimTerms t, CancellationToken ct)
    {
        var id = Guid.NewGuid();
        var now = _clock.GetUtcNow().Storable();
        var (match, useClass, deviceId, kind, key) = t;

        bool inserted;
        if (!_db.Database.IsRelational())
        {
            // The in-memory test host has no unique index to lean on; the read stands in for it.
            inserted = !await IsUsedAsync(match, useClass, ct);
            if (inserted)
            {
                _db.MemberCodeUses.Add(new MemberCodeUse
                {
                    Id = id,
                    TenantId = _tenant.TenantId,
                    Ref = match.RefValue,
                    Step = match.Step,
                    UseClass = useClass,
                    UsedAt = now,
                    DeviceId = deviceId,
                    Kind = kind,
                    ClaimKey = key,
                });
                await _db.SaveChangesAsync(ct);
            }
        }
        else
        {
            inserted = await _db.Database.ExecuteSqlInterpolatedAsync($"""
                INSERT INTO member_code_uses ("Id", "TenantId", "Ref", "Step", "UseClass", "UsedAt", "DeviceId", "Kind", "ClaimKey")
                VALUES ({id}, {_tenant.TenantId}, {match.RefValue}, {match.Step}, {useClass}, {now}, {deviceId}, {kind}, {key})
                ON CONFLICT ("TenantId", "Ref", "Step", "UseClass") DO NOTHING
                """, ct) == 1;
        }

        return inserted ? id : null;
    }

    /// <summary>The use row this code already holds in this class, or null.</summary>
    public Task<MemberCodeUse?> FindUseAsync(MemberCodeMatch match, string useClass, CancellationToken ct) =>
        _db.MemberCodeUses.AsNoTracking()
            .FirstOrDefaultAsync(u => u.Ref == match.RefValue && u.Step == match.Step && u.UseClass == useClass, ct);

    /// <summary>
    /// Gives a claim back: the server decided not to act after all, or the action threw. Only a
    /// FRESH claim is released — a re-entered one belongs to the request that made it. Takes no
    /// cancellation from the caller on purpose: it runs on the way out of a failed or abandoned
    /// request, which is exactly when that token has fired, and a claim left behind strands the
    /// member's code for its whole window.
    /// </summary>
    public async Task ReleaseAsync(MemberCodeClaim? claim)
    {
        if (claim is not { Fresh: true, Id: var id }) return;

        if (!_db.Database.IsRelational())
        {
            var row = await _db.MemberCodeUses.FirstOrDefaultAsync(u => u.Id == id);
            if (row is null) return;
            _db.MemberCodeUses.Remove(row);
            await _db.SaveChangesAsync();
            return;
        }

        await _db.Database.ExecuteSqlInterpolatedAsync(
            $"""DELETE FROM member_code_uses WHERE "Id" = {id} AND "TenantId" = {_tenant.TenantId}""");
    }

    private static bool IsUniqueViolation(DbUpdateException ex) =>
        ex.InnerException is Npgsql.PostgresException pg && pg.SqlState == "23505";
}
