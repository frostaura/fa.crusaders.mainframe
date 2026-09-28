using System.Security.Cryptography;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

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

    public MemberCodeService(MainframeDbContext db, ITenantContext tenant, MemberCodeMasterKey master)
    {
        _db = db;
        _tenant = tenant;
        _master = master;
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
    /// and the phone's next status check re-enrols. <b>Staged, not saved</b>: the caller's own
    /// change (a password, a suspension) and the rotation commit together or not at all.
    /// A member who has never had a code row has never been handed a secret, so there is nothing
    /// to rotate and nothing is written.
    /// </summary>
    public async Task<bool> StageRotationAsync(Guid userId, Guid actorUserId, string reason, CancellationToken ct)
    {
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
            DetailsJson = JsonSerializer.Serialize(new { reason, generation = row.Generation }),
        });
        return true;
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
    /// The previous generation is searched as well as the current one. A board that was offline
    /// across a rotation held the old generation's keys and verified the old generation's codes
    /// honestly; calling that a forgery would page every administrator for a member whose
    /// password change happened to land during an outage. A code that is genuine under neither is
    /// what this exists to catch.
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

        foreach (var generation in row.Generation > 1 ? new[] { row.Generation, row.Generation - 1 } : [row.Generation])
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
    /// </summary>
    public async Task<Guid?> TryClaimAsync(
        MemberCodeMatch match, string useClass, Guid? deviceId, string kind, CancellationToken ct)
    {
        var id = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow.Storable();

        if (!_db.Database.IsRelational())
        {
            // The in-memory test host has no unique index to lean on; the read stands in for it.
            if (await IsUsedAsync(match, useClass, ct)) return null;
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
            });
            await _db.SaveChangesAsync(ct);
            return id;
        }

        var inserted = await _db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO member_code_uses ("Id", "TenantId", "Ref", "Step", "UseClass", "UsedAt", "DeviceId", "Kind")
            VALUES ({id}, {_tenant.TenantId}, {match.RefValue}, {match.Step}, {useClass}, {now}, {deviceId}, {kind})
            ON CONFLICT ("TenantId", "Ref", "Step", "UseClass") DO NOTHING
            """, ct);
        return inserted == 1 ? id : null;
    }

    /// <summary>Gives a claim back: the server decided not to act after all.</summary>
    public async Task ReleaseAsync(Guid? claim, CancellationToken ct)
    {
        if (claim is not { } id) return;

        if (!_db.Database.IsRelational())
        {
            var row = await _db.MemberCodeUses.FirstOrDefaultAsync(u => u.Id == id, ct);
            if (row is null) return;
            _db.MemberCodeUses.Remove(row);
            await _db.SaveChangesAsync(ct);
            return;
        }

        await _db.Database.ExecuteSqlInterpolatedAsync(
            $"""DELETE FROM member_code_uses WHERE "Id" = {id} AND "TenantId" = {_tenant.TenantId}""", ct);
    }

    private static bool IsUniqueViolation(DbUpdateException ex) =>
        ex.InnerException is Npgsql.PostgresException pg && pg.SqlState == "23505";
}
