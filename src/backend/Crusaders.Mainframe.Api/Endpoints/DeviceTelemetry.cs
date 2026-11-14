using System.Text.Json;
using System.Text.Json.Nodes;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// What a v3 board says about itself on every heartbeat (device-api.md §2, §13): the network it
/// applied, the layout its Mega acknowledged, its restore report, and the <c>mega</c>, <c>diag</c>
/// and <c>drift</c> telemetry — onto the row, and the notices a club has to see raised.
///
/// <para>
/// <b>Nothing here can cost a board its heartbeat.</b> Every field is optional, an unknown
/// enumeration is stored as <c>unknown</c>, a value of the wrong kind is skipped, every number is
/// read 64-bit, and an unknown key inside <c>mega</c> or <c>diag</c> is dropped. After the last cable
/// flash the heartbeat is the only window into a board; a diagnostic field that could 400 it would
/// close the window exactly when it is needed.
/// </para>
/// </summary>
public static class DeviceTelemetry
{
    public static readonly string[] NetSources = ["server", "local", "compiled"];
    public static readonly string[] RestoreReports = ["warm", "cold", "none"];

    /// <summary>Reset reasons that are not a fault: the board was switched on, or restarted itself on purpose.</summary>
    public static readonly string[] BenignResets = ["power_on", "software"];

    /// <summary>The planning floors (§13): contract constants, like the supervisor's timings, not club preferences.</summary>
    public const long BlockFloorBytes = 4096;
    public const long StackFloorBytes = 512;

    /// <summary>The most <c>drift</c> names kept (§2: up to eight), each cut to this many characters.</summary>
    public const int MaxDrift = 8;
    public const int DriftNameMax = 64;

    public const string Unknown = "unknown";

    private static readonly string[] DiagKeys = ["exc", "epc1", "heap", "heap_min", "block", "stack_min", "flash_mb"];
    private static readonly string[] MegaTextKeys = ["reset", "lcd", "relay", "scan_end", "keys"];

    /// <summary>The v3 report fields onto the row. Called for every heartbeat; a 2.x board sends none of them and nothing changes.</summary>
    public static void NoteReport(Device device, HeartbeatRequest req, int? keyId, DateTimeOffset now)
    {
        if (req.NetVer is { } ver && ver >= 0) device.NetVer = ver;
        if (req.NetSrc is { } src) device.NetSrc = Known(src, NetSources);

        if (req.LcdLayout is { } layout)
        {
            var acked = layout is DeviceSettings.Compact or DeviceSettings.Expanded ? layout : Unknown;
            if (acked != device.LcdLayoutAcknowledged) device.LcdLayoutAcknowledgedAt = now;
            device.LcdLayoutAcknowledged = acked;
        }

        if (req.Restore is { } restore)
        {
            device.RestoreReport = Known(restore, RestoreReports);
            device.RestoreReportedAt = now;
        }

        if (keyId is { } used)
        {
            device.LastKeyId = used;
            device.LastKeyAt = now;
        }
    }

    /// <summary>What the telemetry changed that a club has to be told about: (code, detail) pairs.</summary>
    public static List<(string Code, string Detail)> NoteTelemetry(Device device, HeartbeatRequest req, DateTimeOffset now)
    {
        var notices = new List<(string, string)>();
        var previousDiag = Parse(device.DiagJson);
        var previousMega = Parse(device.MegaJson);

        if (req.Mega.ValueKind == JsonValueKind.Object)
        {
            var mega = ReadMega(req.Mega);
            device.MegaJson = mega.ToJsonString();
            device.TelemetryAt = now;
            if (Text(mega, "lcd") == "00" && Text(previousMega, "lcd") != "00")
            {
                notices.Add((DeviceErrorCodes.LcdAbsent, "the Mega's address probe found no LCD backpack (mega.lcd 00)"));
            }
        }

        if (req.Diag.ValueKind == JsonValueKind.Object)
        {
            var diag = ReadDiag(req.Diag);
            device.DiagJson = diag.ToJsonString();
            device.TelemetryAt = now;
            notices.AddRange(DiagNotices(diag, previousDiag, firstOfBoot: req.Restore is not null));
        }

        var drift = ReadDrift(req.Drift);
        if (req.Drift.ValueKind != JsonValueKind.Undefined || device.Drift.Count > 0)
        {
            if (drift.Count > 0 && !drift.SequenceEqual(device.Drift))
            {
                notices.Add((DeviceErrorCodes.AnswerDrift, "could not read: " + string.Join(", ", drift)));
            }
            device.Drift = drift;
            device.TelemetryAt = now;
        }

        return notices;
    }

    private static IEnumerable<(string, string)> DiagNotices(JsonObject diag, JsonObject? previous, bool firstOfBoot)
    {
        var reset = Text(diag, "reset");
        if (reset is not null && !BenignResets.Contains(reset) && (firstOfBoot || reset != Text(previous, "reset")))
        {
            yield return (DeviceErrorCodes.BoardRestarted, $"reset reason: {reset}");
        }
        if (Number(diag, "block") is { } block && block < BlockFloorBytes && !(Number(previous, "block") < BlockFloorBytes))
        {
            yield return (DeviceErrorCodes.HeapLow, $"largest free block {block} bytes, under the {BlockFloorBytes}-byte floor");
        }
        if (Number(diag, "stack_min") is { } stack && stack < StackFloorBytes && !(Number(previous, "stack_min") < StackFloorBytes))
        {
            yield return (DeviceErrorCodes.StackLow, $"lowest free stack {stack} bytes, under the {StackFloorBytes}-byte floor");
        }
    }

    /// <summary>The <c>diag</c> object as the server keeps it: the known keys, numbers 64-bit, the reset reason a word.</summary>
    public static JsonObject ReadDiag(JsonElement diag)
    {
        var o = new JsonObject();
        if (diag.TryGetProperty("reset", out var r) && r.ValueKind == JsonValueKind.String) o["reset"] = Cut(r.GetString(), 16);
        foreach (var key in DiagKeys)
        {
            if (diag.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var n)) o[key] = n;
        }
        return o;
    }

    /// <summary>The <c>mega</c> object as the server keeps it: the known keys, <c>diag</c> as up to five integers.</summary>
    public static JsonObject ReadMega(JsonElement mega)
    {
        var o = new JsonObject();
        foreach (var key in MegaTextKeys)
        {
            if (mega.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String) o[key] = Cut(v.GetString(), 8);
        }
        if (mega.TryGetProperty("scan_baud", out var b) && b.ValueKind == JsonValueKind.Number && b.TryGetInt64(out var baud)) o["scan_baud"] = baud;
        if (mega.TryGetProperty("diag", out var d) && d.ValueKind == JsonValueKind.Array)
        {
            var counters = new JsonArray();
            foreach (var c in d.EnumerateArray().Take(5))
            {
                counters.Add(c.ValueKind == JsonValueKind.Number && c.TryGetInt64(out var n) ? n : 0L);
            }
            o["diag"] = counters;
        }
        return o;
    }

    /// <summary>The <c>drift</c> names: strings only, at most eight, each cut to <see cref="DriftNameMax"/>.</summary>
    public static List<string> ReadDrift(JsonElement drift)
    {
        if (drift.ValueKind != JsonValueKind.Array) return [];
        return [.. drift.EnumerateArray()
            .Where(e => e.ValueKind == JsonValueKind.String)
            .Select(e => Cut(e.GetString(), DriftNameMax)!)
            .Where(e => e.Length > 0)
            .Take(MaxDrift)];
    }

    /// <summary>The stored telemetry for the device view, or null.</summary>
    public static JsonNode? View(string? json) => json is null ? null : JsonNode.Parse(json);

    private static JsonObject? Parse(string? json)
    {
        if (json is null) return null;
        try
        {
            return JsonNode.Parse(json) as JsonObject;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string? Text(JsonObject? o, string key) =>
        o is not null && o.TryGetPropertyValue(key, out var v) && v is JsonValue value && value.TryGetValue<string>(out var s) ? s : null;

    private static long? Number(JsonObject? o, string key) =>
        o is not null && o.TryGetPropertyValue(key, out var v) && v is JsonValue value && value.TryGetValue<long>(out var n) ? n : null;

    private static string Known(string value, string[] vocabulary) =>
        vocabulary.Contains(value.Trim(), StringComparer.Ordinal) ? value.Trim() : Unknown;

    private static string? Cut(string? value, int max)
    {
        var text = value?.Trim();
        if (string.IsNullOrEmpty(text)) return null;
        return text.Length <= max ? text : text[..max];
    }
}
