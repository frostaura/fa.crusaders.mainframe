using System.Collections.Concurrent;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services.Demo;

/// <summary>
/// Which tenants are demo clubs, and whether the code running right now is acting for one.
///
/// <para>
/// <b>Why an ambient flag.</b> The things a demo club must never do — send mail, reach PayFast,
/// fire a webhook — are done by singletons that hold no tenant (the SMTP sender, the webhook
/// sender) and are often called off the request (<c>EmailDispatch.InBackground</c>, the workers).
/// Every path into a club's data goes through <see cref="Multitenancy.ITenantContext.Set"/>, so
/// that is where the flag is raised or lowered, and it flows with the execution context into every
/// task started under it. A worker that moves from a demo club to a real one lowers it again on
/// its next <c>Set</c>.
/// </para>
///
/// <para>
/// <b>Why a process-wide set of ids.</b> The answer must be known synchronously inside
/// <c>Set</c>, which cannot read the database. Ids are GUIDs, so one process serving several
/// hosts (the test suite) cannot confuse them. The set is filled at boot
/// (<see cref="LoadAsync"/>), by the mode switch the moment it creates a demo club, and by tenant
/// resolution whenever it reads one — three writers, so a missed one is covered by the others.
/// </para>
/// </summary>
public static class DemoTenants
{
    private static readonly ConcurrentDictionary<Guid, byte> Known = new();
    private static readonly AsyncLocal<bool> Ambient = new();

    /// <summary>The address domain every made-up person and every mirror admin is given. <c>.invalid</c> is reserved (RFC 2606): no mail to it can be delivered anywhere.</summary>
    public const string EmailDomain = "demo.crusaders.invalid";

    /// <summary>The refusal a route answers when it has no meaning in a demo club.</summary>
    public const string RefusalCode = "demo_mode";

    /// <summary>True while the current flow acts for a demo club.</summary>
    public static bool Active => Ambient.Value;

    /// <summary>Raised or lowered by every tenant <c>Set</c>.</summary>
    public static void Enter(Guid tenantId) => Ambient.Value = Known.ContainsKey(tenantId);

    public static bool IsDemo(Guid tenantId) => Known.ContainsKey(tenantId);

    public static void Register(Guid tenantId) => Known.TryAdd(tenantId, 0);

    /// <summary>True for an address no mail may go to: a made-up person's or a mirror admin's.</summary>
    public static bool IsDemoAddress(string address) =>
        address.Trim().EndsWith(".invalid", StringComparison.OrdinalIgnoreCase);

    /// <summary>Every demo club in the database, into the set. Run once at boot.</summary>
    public static async Task LoadAsync(MainframeDbContext db, CancellationToken ct)
    {
        var ids = await db.Tenants.AsNoTracking().Where(t => t.DemoOfTenantId != null).Select(t => t.Id).ToListAsync(ct);
        foreach (var id in ids) Register(id);
    }

    /// <summary><c>409 demo_mode</c>, with the sentence the console shows.</summary>
    public static IResult Refusal(string message = "This isn't available in the demo club.") =>
        Results.Json(new { error = RefusalCode, message }, statusCode: StatusCodes.Status409Conflict);
}
