using System.Text.Json;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// A deliberately small test-side model of what a DEVICE does with what the server sends it
/// (<c>docs/specs/member-code.md</c> §5.5, §6) — enough to execute the corpus sections that describe
/// a board's behaviour (<c>roster.decide</c>, <c>codesync.apply</c>, <c>gate.offline</c>) against
/// the server's own parsers and derivations. It is not the firmware and decides nothing in
/// production; if it disagrees with a vector, either the server's validators or this reading of
/// the spec is wrong, and both are worth knowing.
/// </summary>
internal static class DeviceModel
{
    /// <summary>The roster's (and the clock's) maximum age: six hours.</summary>
    public const long RosterMaxAgeMs = 21_600_000;

    private sealed record Entry(string Token, int Relay, long OpensMs, long ClosesMs);

    private static Entry? ParseEntry(string element)
    {
        var f = element.Split('|');
        if (f.Length != 4 || !int.TryParse(f[1], out var relay) || !long.TryParse(f[2], out var opens) || !long.TryParse(f[3], out var closes))
        {
            return null;
        }
        return new Entry(f[0], relay, Math.Max(0, opens) * 1000, closes * 1000);
    }

    /// <summary>§6.3: a PROVED REF against v1 REF lists only; a scanned token against legacy entries only.</summary>
    public static (string Verdict, int? Court, long? GrantMs) Decide(
        IReadOnlyList<string> roster, long acceptedAtMs, long maxAgeMs, int courts, long atMs, string? proved, string? scanned)
    {
        var age = atMs - acceptedAtMs;
        if (age > maxAgeMs) return ("stale", null, null);

        var matches = roster.Select(ParseEntry).OfType<Entry>().Where(e =>
            proved is not null
                ? MemberCodeWire.IsRefList(e.Token) && MemberCodeWire.RefsOf(e.Token).Contains(proved)
                : scanned is not null && !MemberCodeWire.IsRefList(e.Token) && e.Token == scanned).ToList();
        if (matches.Count == 0) return ("unknown", null, null);

        var entry = matches.FirstOrDefault(e => age >= e.OpensMs && age < e.ClosesMs) ?? matches[0];
        if (entry.Relay >= courts) return ("wrong_court", entry.Relay, null);
        if (age < entry.OpensMs) return ("too_early", entry.Relay, null);
        if (age >= entry.ClosesMs) return ("too_late", entry.Relay, null);
        return ("allow", entry.Relay, entry.ClosesMs - age);
    }

    /// <summary>What a board holds after applying one heartbeat body.</summary>
    public sealed class Sync
    {
        public bool Synced;
        public long Step;
        public long StepMs;
        public long ReceivedAtMs;
        public bool Replaced;
        public List<(string Ref, int Slot, byte[] Key)> Keys = [];
        public List<(long First, long End)?> Days = [];
        public int Rejected;
        public int Dropped;
        public List<string> Roster = [];
    }

    /// <summary>§5.5, top level only; a body that is not one complete object adopts nothing.</summary>
    public static Sync Apply(byte[] body, long receivedAtMs, int keyCapacity)
    {
        var sync = new Sync { ReceivedAtMs = receivedAtMs };
        JsonDocument doc;
        try { doc = JsonDocument.Parse(body); }
        catch (JsonException) { return sync; }

        using (doc)
        {
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return sync;

            if (root.TryGetProperty("roster", out var roster) && roster.ValueKind == JsonValueKind.Array)
            {
                sync.Roster = [.. roster.EnumerateArray().Where(e => e.ValueKind == JsonValueKind.String).Select(e => e.GetString()!)];
            }

            if (root.TryGetProperty("code_step", out var step) && step.ValueKind == JsonValueKind.Number
                && root.TryGetProperty("code_step_ms", out var ms) && ms.ValueKind == JsonValueKind.Number
                && ms.GetInt64() is >= 0 and < 30_000)
            {
                sync.Synced = true;
                sync.Step = step.GetInt64();
                sync.StepMs = ms.GetInt64();
            }

            if (!root.TryGetProperty("code_keys", out var keys) || keys.ValueKind != JsonValueKind.Array) return sync;
            sync.Replaced = true;

            if (root.TryGetProperty("code_days", out var days) && days.ValueKind == JsonValueKind.Array)
            {
                foreach (var d in days.EnumerateArray().Take(MemberCodeWire.MaxDaySlots))
                {
                    sync.Days.Add(d.ValueKind == JsonValueKind.String ? MemberCodeWire.ParseDayElement(d.GetString()) : null);
                }
            }

            foreach (var k in keys.EnumerateArray())
            {
                var parsed = k.ValueKind == JsonValueKind.String ? MemberCodeWire.ParseKeyElement(k.GetString()) : null;
                if (parsed is not { } p || p.Slot >= sync.Days.Count || sync.Days[p.Slot] is null)
                {
                    sync.Rejected++;
                    continue;
                }
                if (sync.Keys.Count == keyCapacity)
                {
                    sync.Dropped++;
                    continue;
                }
                sync.Keys.Add(p);
            }
        }
        return sync;
    }

    /// <summary>A door that has applied one heartbeat and decides scans offline (§6).</summary>
    public static DoorModel Door(byte[] heartbeat, long receivedAtMs) => new(Apply(heartbeat, receivedAtMs, MemberCodeWire.GateKeyCap));

    internal sealed class DoorModel(Sync sync)
    {
        private readonly Dictionary<string, long> _ring = [];

        public (bool Released, string Reason) Scan(string token, long atMs)
        {
            var since = atMs - sync.ReceivedAtMs;
            if (since > RosterMaxAgeMs || !sync.Synced) return (false, "roster_stale");
            if (MemberCodeMath.Parse(token) is not { } code) return (false, "not_recognised");

            var t = sync.Step + ((sync.StepMs + since) / 30_000);
            long? accepted = null;
            foreach (var s in new[] { t, t - 1, t + 1 })
            {
                var slot = sync.Days.FindIndex(d => d is { } x && s >= x.First && s < x.End);
                if (slot < 0) continue;
                var key = sync.Keys.FirstOrDefault(k => k.Ref == code.Ref && k.Slot == slot);
                if (key.Key is null) continue;
                if (MemberCodeMath.Off(key.Key, s) == code.Off)
                {
                    accepted = s;
                    break;
                }
            }
            if (accepted is not { } step) return (false, "not_recognised");
            if (_ring.TryGetValue(code.Ref, out var last) && step <= last) return (false, "replayed");

            var (verdict, _, _) = Decide(sync.Roster, sync.ReceivedAtMs, RosterMaxAgeMs, 1, atMs, code.Ref, null);
            switch (verdict)
            {
                case "allow":
                    _ring[code.Ref] = step;
                    return (true, "ok");
                case "too_early": return (false, "too_early");
                case "too_late": return (false, "too_late");
                case "stale": return (false, "roster_stale");
                default: return (false, "not_recognised");
            }
        }
    }
}
