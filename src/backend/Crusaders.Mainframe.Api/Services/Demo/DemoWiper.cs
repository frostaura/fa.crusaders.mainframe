using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;

namespace Crusaders.Mainframe.Api.Services.Demo;

/// <summary>
/// Empties a DEMO club before its made-up data is drawn again.
///
/// <para>
/// <b>Scoped by construction, twice over.</b> It refuses any tenant that is not a demo club, read
/// from the row inside the same transaction, and every statement it runs is
/// <c>DELETE … WHERE "TenantId" = @demo</c> — the one parameter is the demo club's id, so no
/// statement here can name a real club's row. <c>DemoResetIsolationTests</c> counts every real
/// row before and after a reset.
/// </para>
///
/// <para>
/// <b>What survives a reset.</b> The club row itself; its mirror admins (<see cref="User.DemoSourceUserId"/>)
/// with their memberships, preferences and sessions, so an admin who presses Reset is still signed
/// in to the demo afterwards; and the change record, which no code path may delete from — the
/// table's own triggers refuse it — so the record of what was done in the demo outlives the data
/// it was done to, exactly as the club's own record would.
/// </para>
///
/// <para>
/// <b>The tables come from the model, not from a list.</b> Every entity with a <c>TenantId</c> is
/// emptied, children before parents (the model's own foreign keys), so a table added next month is
/// covered the day it is added rather than the day somebody remembers this file.
/// </para>
/// </summary>
public static class DemoWiper
{
    /// <summary>Tables a reset never touches at all.</summary>
    private static readonly HashSet<string> Untouched = new(StringComparer.Ordinal)
    {
        "tenants", "admin_change_log",
    };

    /// <summary>Tables a reset empties EXCEPT for the mirror admins' own rows, keyed by the column naming the person.</summary>
    private static readonly Dictionary<string, string> KeepMirrors = new(StringComparer.Ordinal)
    {
        ["users"] = "Id",
        ["memberships"] = "UserId",
        ["user_preferences"] = "UserId",
        ["webauthn_credentials"] = "UserId",
        ["refresh_tokens"] = "UserId",
        ["auth_tokens"] = "UserId",
    };

    public static async Task WipeAsync(MainframeDbContext db, Guid demoTenantId, CancellationToken ct)
    {
        var isDemo = await db.Tenants.AsNoTracking().AnyAsync(t => t.Id == demoTenantId && t.DemoOfTenantId != null, ct);
        if (!isDemo) throw new InvalidOperationException($"Refusing to wipe tenant {demoTenantId}: it is not a demo club.");

        foreach (var table in TablesInDeleteOrder(db.Model))
        {
            if (Untouched.Contains(table)) continue;
            var sql = KeepMirrors.TryGetValue(table, out var personColumn)
                ? $"DELETE FROM \"{table}\" WHERE \"TenantId\" = {{0}} AND \"{personColumn}\" NOT IN "
                  + "(SELECT \"Id\" FROM users WHERE \"TenantId\" = {0} AND \"DemoSourceUserId\" IS NOT NULL)"
                : $"DELETE FROM \"{table}\" WHERE \"TenantId\" = {{0}}";
            await db.Database.ExecuteSqlRawAsync(sql, [demoTenantId], ct);
        }
        db.ChangeTracker.Clear();
    }

    /// <summary>
    /// Every table holding a <c>TenantId</c> column, ordered so a table comes before any table it
    /// references (dependents first).
    /// </summary>
    public static IReadOnlyList<string> TablesInDeleteOrder(IModel model)
    {
        var scoped = model.GetEntityTypes()
            .Where(e => e.FindProperty(nameof(ITenantScoped.TenantId)) is not null && e.GetTableName() is not null)
            .ToList();
        var ordered = new List<string>();
        var visiting = new HashSet<IEntityType>();
        var done = new HashSet<IEntityType>();

        void Visit(IEntityType entity)
        {
            if (done.Contains(entity) || !visiting.Add(entity)) return;
            // Dependents first: anything that points AT this entity is deleted before it.
            foreach (var dependent in scoped.Where(other => other.GetForeignKeys().Any(fk => fk.PrincipalEntityType == entity)))
            {
                if (dependent != entity) Visit(dependent);
            }
            visiting.Remove(entity);
            done.Add(entity);
            var table = entity.GetTableName()!;
            if (!ordered.Contains(table)) ordered.Add(table);
        }

        foreach (var entity in scoped) Visit(entity);
        return ordered;
    }
}
