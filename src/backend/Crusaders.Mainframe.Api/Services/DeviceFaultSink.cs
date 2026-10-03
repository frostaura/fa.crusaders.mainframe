using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Files a server-detected fault from any refusal site, without that site having to carry a
/// scope factory, a logger factory and a tenant context of its own.
///
/// <para>
/// <b>It exists because the alternative was worse.</b> The refusal sites are spread across
/// three endpoint files whose service records are already at the complexity gate's
/// six-parameter cap, and threading three more dependencies through each of them would have
/// been a wide, mechanical change to records every fixture constructs — for a diagnostic. One
/// scoped service they can all take instead is one dependency, and it puts the
/// fire-and-forget decision in a single place rather than at every call site.
/// </para>
///
/// <para>
/// <b>There is deliberately no <c>auth_failed</c> here, and that is the sharpest decision on
/// this surface.</b> A key that matches no club resolves NO TENANT, and every row in
/// <c>device_errors</c> is tenant-scoped. Filing it would mean either inventing a tenant to
/// blame or writing it against whichever club the caller's host header happened to name —
/// which turns the monitoring page into an oracle for "is this a real club" and hands an
/// unauthenticated caller a way to fill a stranger's table. A failed key stays a log line,
/// where it already is and where it costs nothing to keep.
/// </para>
/// </summary>
public sealed class DeviceFaultSink
{
    private readonly IServiceScopeFactory _scopes;
    private readonly ITenantContext _tenant;
    private readonly ILoggerFactory _logs;

    public DeviceFaultSink(IServiceScopeFactory scopes, ITenantContext tenant, ILoggerFactory logs)
    {
        _scopes = scopes;
        _tenant = tenant;
        _logs = logs;
    }

    /// <summary>
    /// Records one fault off the request thread. Never throws — see
    /// <see cref="DeviceErrorService.InBackground"/> for why a monitoring write must never be
    /// able to fail the request that noticed the thing worth monitoring.
    /// </summary>
    public void Record(DeviceErrorReport report)
    {
        DeviceErrorService.InBackground(
            _scopes, _logs.CreateLogger(typeof(DeviceFaultSink)),
            _tenant.TenantId, _tenant.TenantSlug, report);
    }

    /// <summary>
    /// A board this club has not registered, calling a route that does not auto-register.
    ///
    /// <para>
    /// FOLDED BY CODE. Anything holding the club's device key can raise this once per MAC it
    /// invents, so fingerprinting on the MAC — as every ordinary code is fingerprinted — would
    /// let one key-holder open a thousand rows and bury the club's real faults underneath
    /// them. One row whose count climbs is also the more useful sentence.
    /// </para>
    /// </summary>
    public void UnregisteredMac(string? claimedMac)
    {
        Record(new DeviceErrorReport(
            DeviceErrorCodes.UnregisteredMac, DeviceErrorSource.Server,
            ClaimedMac: claimedMac, Detail: $"last seen mac {claimedMac ?? "(none)"}",
            FoldByCode: true));
    }

    /// <summary>The club is at its ceiling of boards nobody has acknowledged. Folded, for the same reason.</summary>
    public void TooManyUnacknowledged(string? claimedMac)
    {
        Record(new DeviceErrorReport(
            DeviceErrorCodes.TooManyUnacknowledgedDevices, DeviceErrorSource.Server,
            ClaimedMac: claimedMac,
            Detail: $"at the ceiling of {DeviceRegistryService.MaxUnacknowledgedDevices} unacknowledged boards",
            FoldByCode: true));
    }

    /// <summary>A scan this board sent that the API would not act on. One row per board per reason.</summary>
    public void ActivationRefused(Device device, string reason)
    {
        Record(new DeviceErrorReport(
            DeviceErrorCodes.ActivationRefused, DeviceErrorSource.Server,
            DeviceId: device.Id, ClaimedDeviceCode: device.DeviceCode, Detail: reason));
    }

    /// <summary>A walk-up purchase this board tried to make that the API would not sell.</summary>
    public void WalkUpRefused(Device device, string reason)
    {
        Record(new DeviceErrorReport(
            DeviceErrorCodes.WalkupRefused, DeviceErrorSource.Server,
            DeviceId: device.Id, ClaimedDeviceCode: device.DeviceCode, Detail: reason));
    }

    /// <summary>
    /// A member's code refused at a court box as already used (<c>code_used</c>) — on the
    /// MEMBER's record, as the door's refusal of the same code already is (review round 9, E9-6).
    ///
    /// <para>
    /// The Night of a member whose code was photographed showed the door turning the photo away
    /// and nothing at either court box. This writes the <see cref="TraceKinds.ActivationRefusedAction"/>
    /// row the trace has had a word for since D2, about the member the code resolved to, with the
    /// board as the actor (<c>Guid.Empty</c>, like every device row). <b>The code itself is never
    /// written</b>: a live access code in a trail an admin reads is a credential in a log.
    /// </para>
    ///
    /// <para>
    /// Awaited, in its own scope, and it never throws: the refusal the box is waiting on has
    /// already been decided, the request's own context may hold a use claim that is not this
    /// row's business, and a trail write that fails is a log line, never a failed scan.
    /// </para>
    /// </summary>
    public async Task CodeUsedAtCourtAsync(Device device, Guid userId, int? court, string attempt, string? method)
    {
        try
        {
            using var scope = _scopes.CreateScope();
            scope.ServiceProvider.GetRequiredService<ITenantContext>().Set(_tenant.TenantId, _tenant.TenantSlug);
            var db = scope.ServiceProvider.GetRequiredService<Persistence.MainframeDbContext>();
            db.AuditLogs.Add(new AuditLog
            {
                TenantId = _tenant.TenantId,
                ActorUserId = Guid.Empty,
                SubjectUserId = userId,
                Action = TraceKinds.ActivationRefusedAction,
                DetailsJson = System.Text.Json.JsonSerializer.Serialize(new
                {
                    device_id = device.Id,
                    device_code = device.DeviceCode,
                    // The box's one court when it drives one, so the row names where it happened.
                    court_number = court ?? (device.CourtNumbers.Count == 1 ? device.CourtNumbers[0] : (int?)null),
                    reason = MemberCodeIdentity.CodeUsed,
                    attempt,
                    method,
                }),
            });
            await db.SaveChangesAsync(CancellationToken.None);
        }
        catch (Exception ex)
        {
            _logs.CreateLogger(typeof(DeviceFaultSink)).LogWarning(ex, "Could not record a code_used refusal at {Device}", device.DeviceCode);
        }
    }

    /// <summary>
    /// A board whose event sequence numbers went BACKWARDS inside one boot.
    ///
    /// <para>
    /// Within a boot the sequence is monotonic by construction, and the receipt index depends
    /// on it: a board that renumbers without declaring a new boot will have its events silently
    /// discarded as duplicates, which is a hole in the evening's record that nothing else
    /// reports. A board that genuinely restarted says so with a new boot id and never lands
    /// here.
    /// </para>
    /// </summary>
    public void SeqRegression(Device device, long bootId, long seq, long highest)
    {
        Record(new DeviceErrorReport(
            DeviceErrorCodes.SeqRegression, DeviceErrorSource.Server,
            DeviceId: device.Id, ClaimedDeviceCode: device.DeviceCode,
            Detail: $"boot {bootId} offered seq {seq} after {highest}"));
    }
}
