using System.Security.Cryptography;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>A claim on one acting use (§4.4). <paramref name="Fresh"/> is false for a claim re-entered by the same act retried.</summary>
public sealed record MemberCodeClaim(Guid Id, bool Fresh);

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
    private readonly SessionCutoff _sessions;

    public MemberCodeService(MainframeDbContext db, ITenantContext tenant, MemberCodeMasterKey master, SessionCutoff sessions)
    {
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
    /// and the phone's next status check re-enrols — AND ends every session they had open
    /// (<see cref="User.SessionsValidAfter"/>). <b>Staged, not saved</b>: the caller's own change
    /// (a password, a suspension) and the rotation commit together or not at all; the session
    /// cache is evicted once that save has happened.
    ///
    /// <para>
    /// <b>Why the sessions go with the code.</b> A rotation is the desk's answer to "I lost my
    /// phone". Retiring the codes alone left the phone's signed-in PWA free to call
    /// <c>/me/code/enrol</c> and be handed the new generation's secret — the rotation changed
    /// nothing for whoever held the phone. So every rotation cuts every session minted before it;
    /// a member changing their own password is re-issued a token for the session they are in
    /// (<see cref="AuthService.ChangePasswordAsync"/>).
    /// </para>
    ///
    /// <para>
    /// A member who has never had a code row has never been handed a secret, so there is no
    /// generation to move and false is returned — but their sessions are still cut, because a
    /// password change or a suspension must end them whether or not a phone ever enrolled.
    /// </para>
    /// </summary>
    public async Task<bool> StageRotationAsync(Guid userId, Guid actorUserId, string reason, CancellationToken ct)
    {
        var validAfter = SessionCutoff.StampNow();
        var user = await _db.Users.FirstOrDefaultAsync(u => u.Id == userId, ct);
        if (user is not null)
        {
            user.SessionsValidAfter = validAfter;
            EvictAfterSave(user.TenantId, userId);
        }

        var row = await _db.MemberCodes.FirstOrDefaultAsync(c => c.UserId == userId, ct);
        if (row is null) return false;

        row.Generation += 1;
        row.RotatedAt = DateTimeOffset.UtcNow;
        _db.AuditLogs.Add(new AuditLog
        {
            TenantId = _tenant.TenantId,
            ActorUserId = actorUserId,
            SubjectUserId = userId,
            Action = RotatedAction,
            DetailsJson = JsonSerializer.Serialize(new { reason, generation = row.Generation, sessions_valid_after = validAfter }),
        });
        return true;
    }

    /// <summary>
    /// Evicts the account's cached cut-off once the caller's save has written it — never before,
    /// or a request in between would cache the old instant for another fifteen seconds.
    /// </summary>
    private void EvictAfterSave(Guid tenantId, Guid userId)
    {
        void OnSaved(object? sender, Microsoft.EntityFrameworkCore.SavedChangesEventArgs e)
        {
            _db.SavedChanges -= OnSaved;
            _sessions.Invalidate(tenantId, userId);
        }

        _db.SavedChanges += OnSaved;
    }

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
    /// </summary>
    public async Task<MemberCodeClaim?> TryClaimAsync(
        MemberCodeMatch match, string useClass, Guid? deviceId, string kind, CancellationToken ct, string? claimKey = null)
    {
        var id = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow.Storable();
        var key = claimKey is { Length: > MemberCodeUse.ClaimKeyMaxLength } ? claimKey[..MemberCodeUse.ClaimKeyMaxLength] : claimKey;

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

        if (inserted) return new MemberCodeClaim(id, Fresh: true);
        if (key is null || deviceId is null) return null;

        var taken = await FindUseAsync(match, useClass, ct);
        return taken is not null && taken.DeviceId == deviceId && taken.ClaimKey == key
            ? new MemberCodeClaim(taken.Id, Fresh: false)
            : null;
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
