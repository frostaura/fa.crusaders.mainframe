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
        if (!device.IsActive) return (null, await RefuseShutAsync(db, device, ct));

        return (device, null);
    }

    /// <summary>
    /// The 403 a shut board gets — and the two facts the server learns by serving it.
    ///
    /// <para>
    /// <b>A refused call is still a call, and pretending otherwise made the console say the
    /// opposite of what had happened (B1 / E10 / G4c-H2, R3-1).</b> This method returned
    /// <c>Forbid()</c> before anything wrote anything down, so a shut door's
    /// <see cref="Device.LastSeenAt"/> froze at its last pre-shut call. Three minutes later the
    /// sweep declared it unreachable, the tile flipped to "Not reporting", and the page said
    /// "Nothing can reach Front door, so it has not been told. It may still be admitting booked
    /// members from its saved list" — about a board that had heard the 403 within one heartbeat
    /// and emptied its roster on the spot. Reopening it then confirmed "it has been admitting
    /// booked members from its saved list all along". Three sentences, all false, all reasoned
    /// from a silence this server manufactured itself.
    /// </para>
    ///
    /// <para>
    /// So the contact is recorded (<see cref="DeviceSilenceLog.NoteContactAsync"/>, the same
    /// rule and the same reason as every other board call), and
    /// <see cref="Device.ShutHeardAt"/> records that the board has been TOLD — the first 403
    /// served after the current shut began. A board being refused is a board that is reachable,
    /// and "reachable" and "has heard" are two different facts that only a record written at the
    /// refusal can separate afterwards.
    /// </para>
    ///
    /// <para>
    /// <b>Nothing else changes and nothing else may.</b> The answer is still 403 on every route,
    /// still before any decision is reached, and still the only thing a shut board can get —
    /// <c>DeviceForbiddenMeansOutOfServiceTests</c> pins that in both directions. What is added
    /// is a write, not an answer.
    /// </para>
    ///
    /// <para>
    /// <b>No outage row is written here, in either direction</b> (WIRE-R3 §1).
    /// <c>PeripheralHealthWorker</c> skips disabled rows, so there is never an open one to
    /// extend; and recording a CLOSED one for the silence this call ends would be minting
    /// outage history for a board the club deliberately switched off — which is the exact noise
    /// <c>DeviceRegistryService.SwitchAsync</c> closes rows to avoid. That is also why this does
    /// not go through <see cref="DeviceSilenceLog.NoteContactAsync"/>, whose whole job is to
    /// write that row. See <see cref="Domain.DeviceOutage.EndedByContact"/> for the other half
    /// of the outage story, which is R3-2.
    /// </para>
    /// </summary>
    private static async Task<IResult> RefuseShutAsync(
        MainframeDbContext db, Device device, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;

        // FIRST 403 of this shut, not the latest: the question the console asks is "when did
        // this door learn?", and an instant that moved forward on every retry would answer
        // "just now" for ever. Cleared on reopen (DeviceRegistryService.SwitchAsync), so a
        // non-null value here always belongs to the shut that is in force.
        device.ShutHeardAt ??= now;

        // Liveness, like any other call from this board.
        device.LastSeenAt = now;

        await db.SaveChangesAsync(ct);
        return Results.Forbid();
    }

    /// <summary>
    /// The heartbeat's version: an unknown MAC creates the row rather than being refused.
    /// A board appears on the Devices page by flashing it and switching it on, which is the
    /// entire provisioning story now.
    /// </summary>
    /// <param name="hintedKind">
    /// What the board says it is, honoured <b>only</b> when the MAC is unknown.
    ///
    /// <para>
    /// On a row that already exists the hint is ignored outright: the row's
    /// <see cref="Device.Kind"/> is authoritative and a board cannot re-kind itself. A gate
    /// that could turn its own row into a court box could hand itself the club's courts, and
    /// a box that could turn itself into a gate would drop off the settlement model's map of
    /// which courts have a working door. An admin cannot change a kind either — deleting the
    /// row and letting the board register again is the way, which is the same reset that
    /// already exists for a box whose configuration has been got into a mess.
    /// </para>
    /// </param>
    public static async Task<(Device? Device, IResult? Refusal)> ResolveOrRegisterAsync(
        MainframeDbContext db, DeviceRegistryService devices, string? mac, DeviceKind hintedKind,
        Guid tenantId, CancellationToken ct)
    {
        var normalised = DeviceRegistryService.NormaliseMacAddress(mac);
        if (normalised is null) return (null, Results.BadRequest(new { error = MacRequired }));

        var device = await db.Devices.FirstOrDefaultAsync(d => d.MacAddress == normalised, ct);
        if (device is null)
        {
            // A club may hold only so many boards nobody has looked at. Every invented MAC
            // that gets here leaves a permanent row — on the Devices page, in the audit trail,
            // and (before G3's B3) in every admin's inbox the moment it went quiet — and the
            // rate limit was the only ceiling on how many. See
            // DeviceRegistryService.MaxUnacknowledgedDevices for why the count is of the
            // UNACKNOWLEDGED rows and why the answer is 409 rather than 403.
            //
            // Checked here and not inside AutoRegisterAsync, because this is a refusal to
            // SERVE the request and that method's job is to build a row. A board that already
            // has one never reaches this line: the cap bounds creation, never service, or a
            // flood would take a club's installed doors offline.
            // UNDER THE CLUB'S REGISTRATION LOCK — D2-B30. A count followed by an insert is not
            // a limit: thirty-two heartbeats arriving together with thirty-two invented MACs
            // all read "fewer than sixteen" and all insert, because the only unique index is
            // on the MAC and constrains identity rather than a count. See
            // DeviceRegistryService.RegistrationLockAsync for why an advisory lock is the
            // smallest thing that closes it, and why it is keyed on the tenant alone.
            //
            // Taken only on the branch that can CREATE a row. A board that already has one
            // never reaches this line, so the lock cannot serialise ordinary heartbeats — a
            // flood would otherwise queue a club's installed doors behind each other.
            await using var registration = await devices.RegistrationLockAsync(tenantId, ct);

            // Re-read inside the lock. The whole point is that the value read outside it was
            // not a fact anybody could act on.
            if (await devices.UnacknowledgedCountAsync(ct) >= DeviceRegistryService.MaxUnacknowledgedDevices)
            {
                return (null, Results.Conflict(new { error = DeviceRegistryService.TooManyUnacknowledgedDevices }));
            }

            return (await devices.AutoRegisterAsync(normalised, hintedKind, ct), null);
        }

        // A box an admin disabled is refused rather than silently re-registered: the row is
        // still there, and re-creating it around the disable would make the switch a lie. The
        // refusal records the contact and the fact that the board has been told — see
        // RefuseShutAsync. The heartbeat is the call that matters most for that: it is the one
        // a shut board goes on making on a fixed cadence, so it is the one that answers "has
        // this door heard yet" within a heartbeat rather than at the next scan.
        return device.IsActive ? (device, null) : (null, await RefuseShutAsync(db, device, ct));
    }
}
