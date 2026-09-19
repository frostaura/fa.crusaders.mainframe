using System.Text.Json;
using System.Text.Json.Serialization;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// A member opening a door.
///
/// <para>
/// The mirror of <see cref="DeviceActivateEndpoint"/> with the money taken out. The gate
/// calls this when a scan is not answerable from its cached roster; what comes back is
/// whether to release the lock and for how long. <b>Nothing on this path touches a booking,
/// <c>CheckedInAt</c>, the ledger or the settlement</b> — walking through a door is not
/// attendance, and a member who comes in early to collect a racquet has not started playing.
/// </para>
///
/// <para>
/// <b>Every refusal is a 200 with <c>opened:false</c> and a <c>reason</c></b>, exactly as
/// <c>/device/activate</c> answers, and for a sharper version of the same reason. The
/// firmware falls back to its roster on anything that is not a clean 200 — a timeout, a 401,
/// a 5xx — because those mean the server could not be reached or could not answer. A refusal
/// is an answer. Returning 403 for a barred member would make the gate treat a decision the
/// server definitely made as an outage, second-guess it against a roster fetched minutes ago,
/// and let in whoever the club had just suspended.
/// </para>
///
/// <para>
/// The decision itself is not here. It is <see cref="GateAccess.DecideAsync"/>, in one place,
/// for the reason that type records; this file is routing, the contact note, the audit row
/// and the wire shape.
/// </para>
/// </summary>
public static class DeviceGateEndpoint
{
    public static async Task<IResult> HandleAsync(
        GateScanRequest req,
        [AsParameters] GateServices services,
        CancellationToken ct)
    {
        var (db, tenant, codes, settingsAccessor) = services;

        var (device, refusal) = await DeviceIdentity.ResolveAsync(db, req.Mac, ct);
        if (refusal is not null) return refusal;

        var now = DateTimeOffset.UtcNow;
        var settings = await settingsAccessor.GetAsync(ct);

        // A board asking this question is a board that is reporting, on every branch including
        // the refusals — the same rule and the same reason as /activate and /walkup. See
        // DeviceSilenceLog.NoteContactAsync for what judging a working board "silent" cost.
        await DeviceSilenceLog.NoteContactAsync(db, device!, settings, now, ct);

        // A court box arriving here is a board flashed with the wrong image, not a member
        // being refused. Answered rather than 404'd so it shows a refusal and stops.
        var decision = device!.Kind == DeviceKind.Gate
            ? await GateAccess.DecideAsync(db, codes, new GateContext(device, settings, req.Method, req.Token, now), ct)
            : GateAccess.Refused(GateAccess.NotAGate);

        await AuditAsync(db, tenant, device, decision, req.Method, ct);

        return Results.Ok(new GateScanResponse(decision.Opened, decision.Reason, decision.UnlockSeconds));
    }

    /// <summary>
    /// One row per decision, opened or not.
    ///
    /// <para>
    /// A door is the only surface in the product that moves no money and leaves no booking
    /// behind, so the audit row is the <b>entire</b> record that anything happened — there is
    /// no ledger entry, no <c>CheckedInAt</c> and no receipt to reconstruct it from
    /// afterwards. That makes it worth writing on the refusals too: "nobody could get in
    /// through the side door all Tuesday" is a question the desk will eventually ask, and the
    /// refusals are the only place the answer lives.
    /// </para>
    ///
    /// <para>
    /// <c>ActorUserId</c> is <c>Guid.Empty</c> — the board did this, and that is how every
    /// device-originated row already names itself — while <c>SubjectUserId</c> carries whoever
    /// the code resolved to, including on the refusals that came after it resolved. The token
    /// itself is deliberately NOT in the details: a live access code in a trail an admin can
    /// read is a credential in a log.
    /// </para>
    /// </summary>
    private static async Task AuditAsync(
        MainframeDbContext db, ITenantContext tenant, Device device, GateDecision decision,
        string? method, CancellationToken ct)
    {
        db.AuditLogs.Add(new AuditLog
        {
            TenantId = tenant.TenantId,
            ActorUserId = Guid.Empty,
            SubjectUserId = decision.SubjectUserId,
            Action = decision.Opened ? OpenedAction : $"{DeniedActionPrefix}{decision.Reason}",
            DetailsJson = JsonSerializer.Serialize(new
            {
                device_id = device.Id,
                device_code = device.DeviceCode,
                gate_key = device.GateKey,
                reason = decision.Reason,
                method,
            }),
        });

        await db.SaveChangesAsync(ct);
    }

    /// <summary>The audit action for an open.</summary>
    public const string OpenedAction = "gate.opened";

    /// <summary>The audit action for a refusal, with the reason appended — <c>gate.denied_not_recognised</c>.</summary>
    public const string DeniedActionPrefix = "gate.denied_";
}

/// <summary>
/// The services the gate decision needs, bundled — the same reason as
/// <see cref="WalkUpServices"/>: bound individually they put too many parameters on one
/// handler, past the complexity gate.
/// </summary>
public sealed record GateServices(
    MainframeDbContext Db,
    ITenantContext Tenant,
    AccessCodeService Codes,
    TenantSettingsAccessor Settings);

/// <summary>
/// What a gate sends when a scan needs the server. Three fields — there is no <c>court</c>,
/// because a door is not on one, and no gate identifier either: <c>mac</c> names the board
/// and the row it resolves to carries the <c>gate_key</c>. A board that told the server which
/// door it was would be a board that could claim to be a different one.
/// </summary>
public sealed record GateScanRequest(
    [property: JsonPropertyName("mac")] string? Mac,
    [property: JsonPropertyName("method")] string? Method,
    [property: JsonPropertyName("token")] string? Token);

/// <summary>
/// The door's answer. <c>unlock_seconds</c> is what goes on the lock's release timer and is
/// zero on every refusal — a refusal that carried a positive release would be a door that
/// opens while saying no. Pinned by the <c>gate-scan-response-*</c> vectors in the shared
/// corpus, one per reason.
/// </summary>
public sealed record GateScanResponse(
    [property: JsonPropertyName("opened")] bool Opened,
    [property: JsonPropertyName("reason")] string Reason,
    [property: JsonPropertyName("unlock_seconds")] int UnlockSeconds);
