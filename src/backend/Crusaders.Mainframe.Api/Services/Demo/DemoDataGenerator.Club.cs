using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;

namespace Crusaders.Mainframe.Api.Services.Demo;

public sealed partial class DemoDataGenerator
{
    /// <summary>The demo's boards: one court box per two courts and a front-door gate. None of them is real.</summary>
    private readonly List<Device> _boards = [];

    /// <summary>
    /// The hardware side of the club, as the console reads it: court boxes and a door gate that
    /// reported in moments ago (kept so by <see cref="DemoPulseWorker"/> — no board ever talks to a
    /// demo club), a past outage, open and resolved faults, each court's light state (lit where a game
    /// is in play right now) and a month of door scans.
    /// </summary>
    private void PlanClub(DemoWorld w, List<PlannedGame> games)
    {
        PlanBoards(w);
        PlanFaults(w);
        PlanLights(w, games);
        PlanDoorLog(w, games);
    }

    private void PlanBoards(DemoWorld w)
    {
        var pairs = w.Courts.Select((c, i) => (c, i)).GroupBy(x => x.i / 2).ToList();
        foreach (var pair in pairs)
        {
            var letter = (char)('A' + pair.Key);
            _boards.Add(Board(w, DeviceKind.CourtBox, $"BOX-{letter}", $"Court box {letter}", [.. pair.Select(x => x.c.CourtNumber)]));
        }
        var door = Board(w, DeviceKind.Gate, "GATE-1", "Front door", []);
        door.GateKey = "front";
        door.Hardware = DeviceHardware.Esp32;
        door.RunningVersion = "1.1.2";
        door.MegaVersion = null;
        door.PowerLossBehaviour = DoorPowerLossBehaviour.Released;
        door.LocationNote = "Glass door at the top of the stairs";
        _boards.Add(door);
        _db.Devices.AddRange(_boards);
    }

    private static Device Board(DemoWorld w, DeviceKind kind, string code, string name, List<int> courts)
    {
        var mac = string.Concat(Enumerable.Range(0, 6).Select(_ => w.Rng.Next(0, 256).ToString("X2")));
        return new Device
        {
            TenantId = w.TenantId,
            DeviceCode = code,
            Name = name,
            Kind = kind,
            Hardware = DeviceHardware.Esp8266,
            CourtNumbers = courts,
            MacAddress = mac,
            LastIpAddress = $"192.168.68.{w.Rng.Next(20, 90)}",
            LastSeenAt = (w.Now - TimeSpan.FromSeconds(w.Rng.Next(5, 40))).Storable(),
            RunningVersion = "2.2.9",
            MegaVersion = "1.4.0",
            Capabilities = [MemberCodeWire.Capability],
            CapabilitiesReportedAt = w.Now.AddDays(-12).Storable(),
            CreatedAt = w.Now.AddDays(-210).Storable(),
        };
    }

    private void PlanFaults(DemoWorld w)
    {
        var box = _boards[0];
        var other = _boards.Count > 2 ? _boards[1] : box;
        var gate = _boards[^1];
        Fault(w, box, (DeviceErrorCodes.LcdResync, DeviceErrorSeverity.Warning), (TimeSpan.FromDays(2), TimeSpan.FromHours(5)), 3, null);
        Fault(w, gate, (DeviceErrorCodes.ScannerUartError, DeviceErrorSeverity.Error), (TimeSpan.FromMinutes(70), TimeSpan.FromMinutes(40)), 1, null);
        Fault(w, other, (DeviceErrorCodes.MegaLinkLost, DeviceErrorSeverity.Error), (TimeSpan.FromDays(6), TimeSpan.FromDays(6) - TimeSpan.FromMinutes(12)), 2,
            "Reseated the serial cable between the boards.");
        Fault(w, box, (DeviceErrorCodes.ClockCorrected, DeviceErrorSeverity.Info), (TimeSpan.FromDays(9), TimeSpan.FromDays(9)), 1, "Expected after the power cut.");

        // The night the second box lost its power for twenty-seven minutes.
        var started = (w.Now - TimeSpan.FromDays(3) - TimeSpan.FromHours(2)).Storable();
        var outage = new DeviceOutage
        {
            TenantId = w.TenantId,
            DeviceId = other.Id,
            StartedAt = started,
            DetectedAt = started.AddMinutes(3),
            EndedAt = started.AddMinutes(27),
        };
        _db.DeviceOutages.Add(outage);
        Feed(w, AdminNotices.DeviceOutage(outage.Id, other, 0, recovered: false), outage.DetectedAt);
        Feed(w, AdminNotices.DeviceOutage(outage.Id, other, 27, recovered: true), outage.EndedAt!.Value);
    }

    private void Fault(DemoWorld w, Device device, (string Code, DeviceErrorSeverity Severity) what, (TimeSpan First, TimeSpan Last) ago, int count, string? resolution)
    {
        var (code, severity) = what;
        var court = device.CourtNumbers.Count > 0 ? device.CourtNumbers[0] : (int?)null;
        var last = (w.Now - ago.Last).Storable();
        _db.DeviceErrors.Add(new DeviceError
        {
            TenantId = w.TenantId,
            DeviceId = device.Id,
            ClaimedDeviceCode = device.DeviceCode,
            ClaimedMac = device.MacAddress,
            Source = DeviceErrorSource.Device,
            Code = code,
            Severity = severity,
            Court = court,
            FirstSeenAt = (w.Now - ago.First).Storable(),
            LastSeenAt = last,
            Count = count,
            Fingerprint = DeviceErrorFingerprint.Of(w.TenantId, device.Id, device.MacAddress, code, court, null),
            ResolvedAt = resolution is null ? null : last.AddHours(2),
            ResolvedByUserId = resolution is null ? null : w.AdminId,
            ResolutionNote = resolution,
        });
    }

    /// <summary>Every court's light, as the control board reads it: off, or on for the game in play now.</summary>
    private void PlanLights(DemoWorld w, List<PlannedGame> games)
    {
        foreach (var court in w.Courts)
        {
            var lit = games.FirstOrDefault(g => g.Fate == GameFate.InPlay && g.Booking.CourtId == court.Id);
            var box = _boards.FirstOrDefault(b => b.CourtNumbers.Contains(court.CourtNumber));
            var at = lit?.Booking.CheckedInAt ?? (w.Now - TimeSpan.FromMinutes(w.Rng.Next(20, 300))).Storable();
            _db.CourtLightStates.Add(new CourtLightState
            {
                TenantId = w.TenantId,
                CourtId = court.Id,
                State = lit is null ? LightState.Off : LightState.On,
                ConfirmedState = lit is null ? LightState.Off : LightState.On,
                OnSince = lit?.Booking.CheckedInAt,
                OnUntil = lit?.Booking.EndsAt,
                BookingId = lit?.Booking.Id,
                Cause = lit is null ? LightCause.Unknown : LightCause.Member,
                CausedByUserId = lit?.Organiser.UserId,
                DeviceId = box?.Id,
                Relay = box is null ? null : box.CourtNumbers.IndexOf(court.CourtNumber) + 1,
                LastEventAt = at,
                UpdatedAt = at,
                ConfirmedAt = at,
            });
        }
    }

    /// <summary>A month of the front door: each organiser let in before their game, and the odd refusal.</summary>
    private void PlanDoorLog(DemoWorld w, List<PlannedGame> games)
    {
        var door = _boards[^1];
        var since = w.Now.AddDays(-30);
        foreach (var g in games.Where(g => g.Booking.CheckedInAt is not null && g.Booking.StartsAt > since))
        {
            Scan(w, door, g.Organiser.UserId, (g.Booking.StartsAt - TimeSpan.FromMinutes(w.Rng.Next(4, 15))).Storable(), GateAccess.Ok);
        }
        for (var i = 0; i < 9; i++)
        {
            var at = (w.Now - w.Between(TimeSpan.FromHours(1), TimeSpan.FromDays(29))).Storable();
            var early = i % 3 == 0;
            Scan(w, door, early ? w.Pick(w.Players).UserId : null, at, early ? GateAccess.TooEarly : GateAccess.NotRecognised);
        }
    }

    private void Scan(DemoWorld w, Device door, Guid? who, DateTimeOffset at, string reason)
    {
        _db.AuditLogs.Add(new AuditLog
        {
            TenantId = w.TenantId,
            ActorUserId = Guid.Empty,
            SubjectUserId = reason == GateAccess.NotRecognised ? null : who,
            Action = reason == GateAccess.Ok ? DeviceGateEndpoint.OpenedAction : $"{DeviceGateEndpoint.DeniedActionPrefix}{reason}",
            DetailsJson = JsonSerializer.Serialize(new
            {
                device_id = door.Id,
                device_code = door.DeviceCode,
                gate_key = door.GateKey,
                door_name = door.Name,
                reason,
                method = "member_code",
            }),
            CreatedAt = at,
            ScanAt = at,
        });
    }
}
