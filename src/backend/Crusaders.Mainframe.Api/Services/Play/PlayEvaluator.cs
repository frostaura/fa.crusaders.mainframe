using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services.Realtime;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Awards badges and stages celebrations for one member (<c>docs/specs/play.md</c> §7.2) —
/// idempotent and safe to run concurrently for the same member, because every award is an
/// <c>INSERT … ON CONFLICT DO NOTHING</c> and only the run whose insert landed stages the moment.
///
/// <para>
/// <b>Fresh or retro.</b> A badge whose qualifying instant is within <see cref="FreshWindow"/> of
/// now is news: a celebration and an inbox line. An older one — the retro-award of a history, the
/// first run after P12 or after a catalogue bump — is inserted silently, so a member opening the
/// app for the first time sees their badges on the profile, not twelve overlays.
/// </para>
/// </summary>
public sealed class PlayEvaluator
{
    /// <summary>How old a moment may be and still be news. A constant, not a club policy.</summary>
    public static readonly TimeSpan FreshWindow = TimeSpan.FromDays(14);

    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;
    private readonly TenantSettingsAccessor _settings;
    private readonly IRealtimeBus _bus;

    public PlayEvaluator(MainframeDbContext db, ITenantContext tenant, TenantSettingsAccessor settings, IRealtimeBus bus)
    {
        _db = db; _tenant = tenant; _settings = settings; _bus = bus;
    }

    /// <summary>What one evaluation did: the badges it inserted and whether it staged any celebration.</summary>
    public sealed record Evaluation(IReadOnlyList<string> Awarded, int Celebrations);

    /// <summary>Evaluates <paramref name="userId"/> at <paramref name="now"/> in one transaction.</summary>
    public async Task<Evaluation> EvaluateAsync(Guid userId, DateTimeOffset now, CancellationToken ct)
    {
        var settings = await _settings.GetAsync(ct);
        var record = await PlayRecord.LoadAsync(_db, settings, userId, now, ct);
        var awards = BadgeRules.Qualified(record.BadgeInputs);
        var celebrate = record.Profile?.CelebrationsEnabled ?? true;
        var at = now.Storable();

        var inserted = new List<string>();
        var celebrations = 0;
        var noticed = false;
        await using (var tx = await _db.Database.BeginTransactionAsync(ct))
        {
            foreach (var award in awards)
            {
                if (!await AwardAsync(userId, award, at, ct)) continue;
                inserted.Add(award.Key);
                if (award.QualifiedAt < now - FreshWindow) continue;
                if (await CelebrateAsync(new Moment(userId, CelebrationKind.Badge, $"badge:{award.Key}", award.Key, null), celebrate, at, ct)) celebrations++;
                PlayNotices.BadgeEarned(_db, _tenant.TenantId, userId, BadgeCatalogue.Find(award.Key)!, settings);
                noticed = true;
            }

            if (GoalReached(record) && await CelebrateAsync(
                    new Moment(userId, CelebrationKind.GoalReached, $"goal:{record.CurrentMonth}", null, record.CurrentMonth), celebrate, at, ct))
            {
                celebrations++;
            }

            await _db.SaveChangesAsync(ct);
            await StampAsync(userId, at, ct);
            await tx.CommitAsync(ct);
        }

        if (noticed) await MemberNotices.PublishUnreadAsync(_db, _bus, _tenant.TenantId, [userId], CancellationToken.None);
        return new Evaluation(inserted, celebrations);
    }

    /// <summary>Whether the member set a goal and this club month's attended minutes reach it.</summary>
    public static bool GoalReached(PlayRecord record)
    {
        if (record.Profile?.MonthlyGoalMinutes is not { } goal) return false;
        return PlayStats.Month(record.Sessions, record.Zone, record.CurrentMonth).Minutes >= goal;
    }

    /// <summary>Inserts one badge; true when this call's insert landed (it was not already held).</summary>
    private async Task<bool> AwardAsync(Guid userId, BadgeAward award, DateTimeOffset at, CancellationToken ct)
    {
        var rows = await _db.Database.ExecuteSqlAsync(
            $"""
            INSERT INTO member_badges ("Id", "TenantId", "UserId", "BadgeKey", "AwardedAt", "BookingId", "ResultId", "CreatedAt")
            VALUES ({Guid.NewGuid()}, {_tenant.TenantId}, {userId}, {award.Key}, {award.QualifiedAt.Storable()}, {award.BookingId}, {award.ResultId}, {at})
            ON CONFLICT ("TenantId", "UserId", "BadgeKey") DO NOTHING
            """, ct);
        return rows == 1;
    }

    /// <summary>A moment to stage: whose, what kind, its dedupe key, and the badge or month it names.</summary>
    public sealed record Moment(Guid UserId, string Kind, string DedupeKey, string? BadgeKey, string? Month);

    /// <summary>
    /// Stages one celebration (once per dedupe key, however often or concurrently this runs). With
    /// celebrations switched off it is written already seen, so switching them back on replays nothing.
    /// </summary>
    public async Task<bool> CelebrateAsync(Moment m, bool show, DateTimeOffset at, CancellationToken ct)
    {
        DateTimeOffset? seen = show ? null : at;
        var rows = await _db.Database.ExecuteSqlAsync(
            $"""
            INSERT INTO play_celebrations ("Id", "TenantId", "UserId", "Kind", "DedupeKey", "BadgeKey", "Month", "CreatedAt", "SeenAt")
            VALUES ({Guid.NewGuid()}, {_tenant.TenantId}, {m.UserId}, {m.Kind}, {m.DedupeKey}, {m.BadgeKey}, {m.Month}, {at}, {seen})
            ON CONFLICT ("TenantId", "UserId", "DedupeKey") DO NOTHING
            """, ct);
        return rows == 1;
    }

    /// <summary>Stamps the profile (creating it lazily) with the catalogue version it was evaluated against.</summary>
    private Task<int> StampAsync(Guid userId, DateTimeOffset at, CancellationToken ct) =>
        _db.Database.ExecuteSqlAsync(
            $"""
            INSERT INTO member_play_profiles ("Id", "TenantId", "UserId", "CelebrationsEnabled", "EvaluatorVersion", "EvaluatedAt", "CreatedAt", "UpdatedAt", "Version")
            VALUES ({Guid.NewGuid()}, {_tenant.TenantId}, {userId}, TRUE, {BadgeCatalogue.Version}, {at}, {at}, {at}, 0)
            ON CONFLICT ("TenantId", "UserId") DO UPDATE SET "EvaluatorVersion" = EXCLUDED."EvaluatorVersion", "EvaluatedAt" = EXCLUDED."EvaluatedAt"
            """, ct);
}
