using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// W1.5 — shutting and reopening every door at once.
///
/// <para>
/// <b>It rides the 403 that already exists and adds no new refusal.</b> A door out of service
/// is answered <c>403</c> on all five <c>/api/v1/device/*</c> routes, and
/// <c>DeviceForbiddenMeansOutOfServiceTests</c> pins in both directions that a 403 on that
/// surface can mean nothing else. Nothing here touches that route group; this is <c>N</c>
/// rows of <c>Enabled = false</c> in one unit of work.
/// </para>
///
/// <para>
/// <b>One unit of work is a promise the console repeats to the admin</b> — "nothing was shut,
/// and it is one all-or-nothing change, so every door is exactly as it was". That sentence is
/// only true because there is a single <c>SaveChangesAsync</c> at the end of this handler. Doing
/// it as N PATCHes, which was the only way before this route existed, meant a failure halfway
/// left a club half-shut with nothing anywhere saying which half.
/// </para>
///
/// <para>
/// <b>And it is honest about what it cannot do.</b> The change is immediate at the server and
/// reaches each board only when that board next calls in; a board that has lost the network
/// never hears it and goes on admitting whatever its cached roster still carries, for up to six
/// hours. That is why the response carries each door's <c>last_seen_at</c> and
/// <c>offline_after_seconds</c> AS AT THE MOMENT THE WORK WAS DONE: the result panel is a
/// receipt for an instant, and a client recomputing "confirmed 12 s ago" ten minutes later
/// would be inventing a confirmation nobody gave.
/// </para>
/// </summary>
public static class AdminDoorFleetEndpoint
{
    /// <summary>The audit action for a club-wide shut.</summary>
    public const string ShutAllAction = "doors.shut_all";

    /// <summary>The audit action for a club-wide reopen.</summary>
    public const string ReopenedAllAction = "doors.reopened_all";

    /// <summary>
    /// <c>POST /api/v1/admin/doors/shut-all</c> — every door that is still open.
    ///
    /// <para>
    /// A door already out of service is left alone rather than re-stamped, for the reason
    /// <c>AdminDeviceEndpoints.UpdateAsync</c>'s summary gives at length: moving
    /// <c>OutOfServiceSince</c> forward re-prices every unsettled deadline behind it. The same
    /// idempotence, at fleet scale.
    /// </para>
    /// </summary>
    public static Task<IResult> ShutAllAsync(
        MainframeDbContext db, ITenantContext tenant, TenantSettingsAccessor settingsAccessor,
        HttpContext ctx, CancellationToken ct)
        => ApplyAsync(db, tenant, settingsAccessor, ctx, shut: true, ct);

    /// <summary>
    /// <c>POST /api/v1/admin/doors/reopen-all</c> — every door THIS feature shut, and no other.
    ///
    /// <para>
    /// <b>A door an admin shut individually stays shut.</b> They shut it for a reason this
    /// system knows nothing about — a broken scanner, a lock being replaced, a wing closed for
    /// the season — and a fleet reopen that silently reversed that decision would be the
    /// product overruling a person. <see cref="Device.ShutByShutAllAt"/> is the only thing that
    /// can tell the two apart, which is why it is a column rather than a derivation.
    /// </para>
    /// </summary>
    public static Task<IResult> ReopenAllAsync(
        MainframeDbContext db, ITenantContext tenant, TenantSettingsAccessor settingsAccessor,
        HttpContext ctx, CancellationToken ct)
        => ApplyAsync(db, tenant, settingsAccessor, ctx, shut: false, ct);

    /// <summary>
    /// The one unit of work both directions run: select the doors this call is about, flip them,
    /// close or leave their outages, write ONE audit row, save once.
    /// </summary>
    private static async Task<IResult> ApplyAsync(
        MainframeDbContext db, ITenantContext tenant, TenantSettingsAccessor settingsAccessor,
        HttpContext ctx, bool shut, CancellationToken ct)
    {
        var settings = await settingsAccessor.GetAsync(ct);
        var now = DateTimeOffset.UtcNow;

        var doors = await db.Devices
            .Where(d => d.Kind == DeviceKind.Gate)
            .OrderBy(d => d.Name)
            .ThenBy(d => d.DeviceCode)
            .ToListAsync(ct);

        var changing = doors.Where(d => shut ? d.Enabled : d.ShutByShutAllAt is not null).ToList();

        // What this call will NOT touch, and why the console needs it in words (C1).
        //
        // A reopen-all undoes a shut-all; a door an admin shut on its own stays shut, for the
        // reason ReopenAllAsync gives. That semantic is right and it was unreadable: after
        // shut-one, shut-all, reopen-all the console said "0 doors reopened" — or "Reopen all
        // 3" and then nothing — with no sentence anywhere naming the door that stayed shut or
        // saying why. A zero-change result that does not explain itself is the defect, not the
        // rule behind it, so the rule now comes with its own evidence attached.
        var leftShut = shut
            ? []
            : doors.Where(d => !d.Enabled && d.ShutByShutAllAt is null)
                .Select(d => new { id = d.Id, name = DeviceView.Named(d.Name), gate_key = d.GateKey })
                .ToList();

        // Taking a board out of service closes whatever outage it is in, silently — the same
        // rule and the same reasoning as DeviceRegistryService.UpdateAsync, which explains why
        // an outage nobody can close eventually lies. Read for the whole set at once rather
        // than per door.
        if (shut && changing.Count > 0)
        {
            var ids = changing.Select(d => d.Id).ToList();
            var open = await db.DeviceOutages.Where(o => ids.Contains(o.DeviceId) && o.EndedAt == null).ToListAsync(ct);
            foreach (var outage in open)
            {
                outage.EndedAt = now;

                // Closed BY THE SWITCH and not by contact — the same rule and the same reason
                // as the single-door path. See DeviceOutage.EndedByContact (R3-2).
                outage.EndedByContact = false;
            }
        }

        var actor = ctx.User.Id() ?? Guid.Empty;
        foreach (var door in changing)
        {
            door.Enabled = !shut;
            door.OutOfServiceSince = shut ? now : null;
            door.ShutByShutAllAt = shut ? now : null;

            // Who, beside when. A fleet shut writes ONE audit row for the whole club with no
            // device_id on it, so a door shut this way could not be attributed by any query —
            // which is why this is a column and not a derivation. See Device.ShutByUserId.
            door.ShutByUserId = shut ? actor : null;
        }

        db.AuditLogs.Add(new AuditLog
        {
            TenantId = tenant.TenantId,
            ActorUserId = actor,

            // No subject. The club's doors are not a person, and A1.5 / P4 are explicit that a
            // door action is about doors — naming a member here would be the first place this
            // surface started keeping a per-member record of an admin's decisions.
            SubjectUserId = null,
            Action = shut ? ShutAllAction : ReopenedAllAction,
            DetailsJson = JsonSerializer.Serialize(new
            {
                doors = changing.Count,
                door_ids = changing.Select(d => d.Id).ToList(),
                at = now,
            }),
        });

        // ONE save. The console's "nothing was shut, every door is exactly as it was" depends
        // on this line and on nothing else.
        await db.SaveChangesAsync(ct);

        return Results.Ok(new
        {
            doors = changing.Select(d => Wire(d, settings)).ToList(),

            // Always present, empty on a shut-all: one response shape, and a console that
            // types it once cannot forget the case where it is not empty.
            left_shut = leftShut,
        });
    }

    /// <summary>
    /// One door on the result panel: what it is, whether it is open, and the two facts that
    /// decide whether it has HEARD about this yet.
    ///
    /// <para>
    /// <c>power_loss_behaviour</c> is here because the panel states it per door — a club
    /// shutting every door at night is entitled to be told, in the same breath, which of them a
    /// power cut would open anyway, and that most of them are <c>not_established</c> because
    /// nobody has looked. Block body for the lizard reason in <c>memory/gotchas.md</c>.
    /// </para>
    /// </summary>
    private static object Wire(Device door, TenantSettingsView settings)
    {
        return new
        {
            id = door.Id,
            name = DeviceView.Named(door.Name),
            gate_key = door.GateKey,
            enabled = door.Enabled,
            last_seen_at = door.LastSeenAt,
            offline_after_seconds = HeartbeatCadence.OfflineAfterSeconds(settings.HeartbeatSeconds),
            power_loss_behaviour = DoorPowerLoss.Wire(door.PowerLossBehaviour),
        };
    }
}
