using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Which board is calling.
///
/// <para>
/// The bearer key authenticates a <b>club</b>, so every device request body carries a
/// <c>mac</c> and this is where it becomes a row. One place rather than four copies of the
/// same three lines, because the three failure shapes have to agree across heartbeat,
/// activate, walk-up and events: a malformed MAC is a 400, an unknown MAC is a 404 on
/// every endpoint except the heartbeat (where it registers itself), and a disabled box is
/// a 403.
/// </para>
///
/// <para>
/// The lookup is tenant-filtered like every other request-path query — the auth scheme has
/// already set the tenant — so a MAC belonging to another club resolves to nothing here.
/// The isolation is structural, not a claim compared.
/// </para>
/// </summary>
public static class DeviceIdentity
{
    /// <summary>Error code for a <c>mac</c> that is not twelve hex characters.</summary>
    public const string MacRequired = "mac_required";

    /// <summary>
    /// The board this request names, or the refusal to return instead. Never registers —
    /// see <see cref="ResolveOrRegisterAsync"/> for the heartbeat's version.
    /// </summary>
    public static async Task<(Device? Device, IResult? Refusal)> ResolveAsync(
        MainframeDbContext db, string? mac, CancellationToken ct)
    {
        var normalised = DeviceRegistryService.NormaliseMacAddress(mac);
        if (normalised is null) return (null, Results.BadRequest(new { error = MacRequired }));

        var device = await db.Devices.FirstOrDefaultAsync(d => d.MacAddress == normalised, ct);
        if (device is null) return (null, Results.NotFound());
        if (!device.IsActive) return (null, Results.Forbid());

        return (device, null);
    }

    /// <summary>
    /// The heartbeat's version: an unknown MAC creates the row rather than being refused.
    /// A box appears on the Devices page by flashing it and switching it on, which is the
    /// entire provisioning story now.
    /// </summary>
    public static async Task<(Device? Device, IResult? Refusal)> ResolveOrRegisterAsync(
        MainframeDbContext db, DeviceRegistryService devices, string? mac, CancellationToken ct)
    {
        var normalised = DeviceRegistryService.NormaliseMacAddress(mac);
        if (normalised is null) return (null, Results.BadRequest(new { error = MacRequired }));

        var device = await db.Devices.FirstOrDefaultAsync(d => d.MacAddress == normalised, ct);
        if (device is null) return (await devices.AutoRegisterAsync(normalised, ct), null);

        // A box an admin disabled is refused rather than silently re-registered: the row is
        // still there, and re-creating it around the disable would make the switch a lie.
        return device.IsActive ? (device, null) : (null, Results.Forbid());
    }
}
