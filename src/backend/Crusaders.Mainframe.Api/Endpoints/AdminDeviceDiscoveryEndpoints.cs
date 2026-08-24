using System.Text.Json.Serialization;
using Crusaders.Mainframe.Api.Security.Discovery;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// Connecting a board without typing an IP address.
///
/// <para>
/// Mounted on the same <c>/api/v1/admin/devices</c> prefix as
/// <see cref="AdminDeviceEndpoints"/> and kept in its own file because it is a different
/// subject: that one manages rows that exist, this one turns something heard on the LAN
/// into one of them. The work is in <see cref="DeviceDiscoveryService"/>; this file is
/// routing and shape.
/// </para>
/// </summary>
public static class AdminDeviceDiscoveryEndpoints
{
    public static IEndpointRouteBuilder MapAdminDeviceDiscoveryEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1/admin/devices").RequireAuthorization(p => p.RequireRole("admin"));

        g.MapGet("/discovered", Discovered);
        g.MapGet("/discovery-status", Status);
        g.MapPost("/claim", ClaimAsync);

        return app;
    }

    private static IResult Discovered(DeviceDiscoveryService discovery)
        => Results.Ok(discovery.Visible().Select(DiscoveredBoardView.Of).ToList());

    /// <summary>
    /// Whether the API can hear the club LAN at all.
    ///
    /// <para>
    /// This endpoint exists because of one failure mode that otherwise looks like a
    /// different one. In the shipped <c>docker-compose.yml</c> the backend sits on a bridge
    /// network, and broadcast frames do not cross a bridge — so with the default compose
    /// file the listener receives <b>nothing, ever</b>. Without this endpoint the symptom is
    /// an empty board list, which is indistinguishable from a board that is switched off,
    /// mis-flashed or out of WiFi range; someone drives to the club and opens a cupboard to
    /// diagnose a deployment setting.
    /// </para>
    ///
    /// <para>
    /// So the diagnosis is served rather than inferred: whether the listener bound, on what
    /// address, how many packets have arrived, and when the last one did.
    /// <c>packets_received: 0</c> with <c>state: Listening</c> says the socket is fine and
    /// nothing is reaching it — check host networking and the access point's broadcast
    /// filter. Anything other than <c>Listening</c> says the API is the problem, and
    /// <c>detail</c> says why.
    /// </para>
    /// </summary>
    private static IResult Status(DeviceDiscoveryService discovery)
    {
        var s = discovery.Status();

        return Results.Ok(new
        {
            state = s.State.ToString(),
            listening = s.State == DiscoveryListenerState.Listening,
            bound_endpoint = s.BoundEndpoint,
            detail = s.Detail,
            packets_received = s.PacketsReceived,
            packets_accepted = s.PacketsAccepted,
            packets_rejected = s.PacketsRejected,
            last_packet_at = s.LastPacketAt,
            started_at = s.StartedAt,
            announcers = s.AnnouncerCount,
            capacity_reached = s.CapacityReached,
            hint = Hint(s),
        });
    }

    private static string Hint(DiscoveryStatus s)
    {
        return s.State switch
        {
            DiscoveryListenerState.Disabled => "Discovery is switched off in configuration (Discovery:Enabled).",
            DiscoveryListenerState.NotStarted => "The discovery listener has not started in this process.",
            DiscoveryListenerState.Failed => "The listener could not bind its UDP socket. See detail.",
            _ when s.PacketsReceived == 0 =>
                "Listening, but nothing has arrived. On the default docker-compose the backend is on a bridge network " +
                "and cannot receive LAN broadcast at all — apply docker-compose.onprem.yml. If it is already on host " +
                "networking, check the access point for broadcast/multicast filtering.",
            _ => "Listening and receiving.",
        };
    }

    private static async Task<IResult> ClaimAsync(
        ClaimBoardRequest req, DeviceDiscoveryService discovery, HttpContext ctx, CancellationToken ct)
    {
        var result = await discovery.ClaimAsync(
            new ClaimBoardCommand(req.ClaimCode ?? string.Empty, req.DeviceCode ?? string.Empty, req.Name ?? string.Empty, req.CourtNumber),
            ctx.User.Id() ?? Guid.Empty, ct);

        if (!result.Succeeded) return Refused(result);

        // The key is shown once, exactly as on manual registration — it is derived, not
        // stored, so there is nothing to read back. Pushing it to the board is a separate,
        // explicit step: the address came from an unauthenticated UDP packet, and the
        // outbound guard's private-network allow-list is what stands between this API and
        // being used to POST at arbitrary LAN addresses.
        return Results.Ok(new
        {
            device = DeviceView.Of(result.Registration!.Device),
            device_key = result.Registration.DeviceKey,
            key_version = result.Registration.Device.KeyVersion,
            board = DiscoveredBoardView.Of(result.Board!),
            note = "Store this key on the board now. It is derived, not stored, and cannot be shown again.",
        });
    }

    private static IResult Refused(ClaimResult result)
    {
        return result.Failure switch
        {
            ClaimFailure.BoardAlreadyRegistered => Results.Conflict(new
            {
                error = "board_already_registered",
                message = $"This board is already registered as '{result.Detail}'. Rotate that device's key rather " +
                          "than registering it a second time — two rows for one board both derive working keys.",
                device_code = result.Detail,
            }),
            ClaimFailure.InvalidClaimCode => Results.BadRequest(new
            {
                error = "claim_code_invalid",
                message = "A claim code is eight characters from ABCDEFGHJKLMNPQRSTUVWXYZ23456789.",
            }),
            ClaimFailure.InvalidRegistration => Results.BadRequest(new
            {
                error = "registration_invalid",
                message = "A device code, a name and a court number are all required.",
            }),
            ClaimFailure.NoMatch => Results.NotFound(new
            {
                error = "claim_no_match",
                message = "No board on the network committed to that code. Check the code on the LCD, and that the board is still announcing.",
            }),
            ClaimFailure.Ambiguous => Results.Conflict(new
            {
                error = "claim_ambiguous",
                message = "Two boards presented the same claim commitment. One of them is copying the other, so the claim is refused rather than guessed. Power the boards on one at a time and try again.",
            }),
            ClaimFailure.BoardAlreadyClaimed => Results.Conflict(new
            {
                error = "board_already_claimed",
                message = "That board is already claimed. Revoke its device first, then reboot it to generate a new claim code.",
            }),
            _ => Results.Conflict(new { error = "device_code_taken" }),
        };
    }
}

/// <summary>
/// What an admin sends to connect a board: the code from its LCD, plus the details of the
/// device row it becomes.
///
/// <para>
/// Names are pinned with <see cref="JsonPropertyNameAttribute"/> for the same reason the
/// device surface pins its own — the application configures no naming policy, so responses
/// are hand-written snake_case while requests would otherwise bind camelCase.
/// </para>
/// </summary>
public sealed record ClaimBoardRequest(
    [property: JsonPropertyName("claim_code")] string? ClaimCode,
    [property: JsonPropertyName("device_code")] string? DeviceCode,
    [property: JsonPropertyName("name")] string? Name,
    [property: JsonPropertyName("court_number")] int? CourtNumber);

/// <summary>
/// The wire shape of a discovered board.
///
/// <para>
/// A projection rather than the store record, so an internal field cannot become an API
/// field by accident. The nonce is not published: it is public on the wire, but nothing in
/// the UI needs it and every field that leaves the server is one more thing to keep true.
/// </para>
/// </summary>
public static class DiscoveredBoardView
{
    public static object Of(DiscoveredBoard b)
    {
        return new
        {
            mac = b.Mac,
            address = b.Address,
            hardware = b.Hardware,
            firmware = b.Firmware,
            mega_version = b.MegaVersion,
            claimed = b.Claimed,
            claimable = !b.Claimed && b.Commitment is not null,

            // Null means there was nothing to verify — an unclaimed board has no key. False
            // means a board asserted an identity it could not prove, which an admin has to see:
            // that is what a key rotated out from under a board looks like, and also what a
            // spoof looks like.
            signature_verified = b.SignatureVerified,
            device_id = b.DeviceId,
            tenant_slug = b.TenantSlug,
            uptime_seconds = b.UptimeSeconds,
            first_seen_at = b.FirstSeenAt,
            last_seen_at = b.LastSeenAt,
        };
    }
}
