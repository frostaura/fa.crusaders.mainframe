using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// A trigger that makes one club's <c>admin_change_log</c> inserts fail, for as long as the
/// returned handle lives.
///
/// <para>
/// <b>What it is for:</b> proving that a record and the change it records are one unit of work.
/// A green happy path cannot tell "flushed together" from "flushed one after the other" — both
/// leave both rows. Only a failure of the SECOND write shows whether the first one stayed. The
/// trigger is scoped to one tenant and one action prefix, because the whole Postgres tier shares
/// one database and a sibling test must never see its inserts refused.
/// </para>
/// </summary>
public sealed class ChangeLogSabotage : IAsyncDisposable
{
    private readonly TestWebAppFactory _factory;
    private readonly string _name;

    private ChangeLogSabotage(TestWebAppFactory factory, string name)
    {
        _factory = factory;
        _name = name;
    }

    /// <summary>Refuses every insert of an action starting with <paramref name="actionPrefix"/> for this club.</summary>
    public static async Task<ChangeLogSabotage> InstallAsync(
        TestWebAppFactory factory, Guid tenantId, string actionPrefix)
    {
        var name = $"sabotage_{Guid.NewGuid():N}";
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        // Identifiers and literals are generated here, never taken from input, so the raw SQL is
        // safe; EF's parameterised form cannot be used inside a function body.
#pragma warning disable EF1002
        await db.Database.ExecuteSqlRawAsync($"""
            CREATE FUNCTION {name}() RETURNS trigger AS $$
            BEGIN
              IF NEW."TenantId" = '{tenantId}'::uuid AND NEW."Action" LIKE '{actionPrefix.Replace("'", "''")}%' THEN
                RAISE EXCEPTION 'change record refused by test sabotage';
              END IF;
              RETURN NEW;
            END $$ LANGUAGE plpgsql;
            CREATE TRIGGER {name} BEFORE INSERT ON admin_change_log
              FOR EACH ROW EXECUTE FUNCTION {name}();
            """);
#pragma warning restore EF1002
        return new ChangeLogSabotage(factory, name);
    }

    public async ValueTask DisposeAsync()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
#pragma warning disable EF1002
        await db.Database.ExecuteSqlRawAsync(
            $"DROP TRIGGER IF EXISTS {_name} ON admin_change_log; DROP FUNCTION IF EXISTS {_name}();");
#pragma warning restore EF1002
    }
}
