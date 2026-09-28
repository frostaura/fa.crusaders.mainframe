using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// The four keys a <c>codes:m1</c> board is sent after <c>roster</c> (<c>docs/specs/member-code.md</c>
/// §5.2): the step clock, the day slots and the per-day keys. Always present for such a board —
/// empty arrays when it is not entitled to keys, never omitted, because an absent <c>code_keys</c>
/// means "this server does not do member codes" and a board keeps whatever ring it had.
/// </summary>
public sealed record MemberCodeSync(long Step, int StepMs, IReadOnlyList<string> Days, IReadOnlyList<string> Keys)
{
    /// <summary>The four keys, in wire order, onto a response body being assembled.</summary>
    public void WriteTo(IDictionary<string, object?> body)
    {
        body["code_step"] = Step;
        body["code_step_ms"] = StepMs;
        body["code_days"] = Days;
        body["code_keys"] = Keys;
    }

    /// <summary>The same sync with its last <paramref name="drop"/> keys removed — the budget's last resort (§5.4).</summary>
    public MemberCodeSync WithoutLast(int drop) => this with { Keys = [.. Keys.Take(Math.Max(0, Keys.Count - drop))] };
}

/// <summary>One v1 roster entry and the players behind it, for the key budget.</summary>
public sealed record MemberCodeEntry(string Element, IReadOnlyList<MemberCode> Players, DateTimeOffset OpensAt, DateTimeOffset ClosesAt);

/// <summary>
/// Builds the v1 roster (§5.3) and the key sync (§5.4) for one heartbeat. Pure over what it is
/// handed except for the REF rows it asks <see cref="MemberCodeService"/> to ensure.
/// </summary>
public static class MemberCodeHeartbeat
{
    /// <summary>
    /// The v1 entries for <paramref name="bookings"/> — already in roster order and capped — each
    /// naming its players' REFs, organiser first. A booking with no eligible player is left out,
    /// exactly as a legacy booking without a code would be: an entry that names nobody opens nothing.
    /// </summary>
    public static async Task<List<MemberCodeEntry>> EntriesAsync(
        IReadOnlyList<(Booking Booking, int Relay)> bookings, TimeSpan early, DateTimeOffset now,
        IBookingPlayers players, MemberCodeService codes, CancellationToken ct)
    {
        if (bookings.Count == 0) return [];

        var who = await players.PlayersOfAsync([.. bookings.Select(b => b.Booking)], ct);
        var rows = await codes.EnsureManyAsync([.. who.Values.SelectMany(p => p)], ct);

        var entries = new List<MemberCodeEntry>(bookings.Count);
        foreach (var (booking, relay) in bookings)
        {
            var seated = who.GetValueOrDefault(booking.Id) ?? [];
            var refs = seated.Take(MemberCodeWire.MaxRefsPerEntry).Select(u => rows[u]).ToList();
            if (refs.Count == 0) continue;

            var token = MemberCodeWire.RosterToken([.. refs.Select(r => MemberCodeMath.RefText(r.Ref))]);
            var opensAt = booking.StartsAt - early;
            entries.Add(new MemberCodeEntry(
                DeviceRosterBuilder.Entry(token, relay, opensAt, booking.EndsAt, now), refs, opensAt, booking.EndsAt));
        }
        return entries;
    }

    /// <summary>
    /// The clock, the days and the keys. <paramref name="entitled"/> is phase <c>v1</c>/<c>v1_only</c>
    /// AND an acknowledged board; anything else gets the clock and two empty arrays.
    ///
    /// <para>
    /// Keys go in roster order — bookings by start — for each REF in the entry and each day slot the
    /// entry's window reaches, once per (REF, slot), until the cap. So the players who lose offline
    /// access to the cap are the latest-starting ones, which is the stated residual (§11).
    /// </para>
    /// </summary>
    public static MemberCodeSync Sync(
        IReadOnlyList<MemberCodeEntry> entries, bool entitled, int keyCap,
        MemberCodeService codes, TimeZoneInfo zone, DateTimeOffset now)
    {
        var step = MemberCodeMath.StepOf(now);
        var stepMs = (int)(now.ToUnixTimeMilliseconds() - (step * MemberCodeMath.StepSeconds * 1000L));
        if (!entitled) return new MemberCodeSync(step, stepMs, [], []);

        var today = MemberCodeMath.DayRange(step, zone);
        var tomorrow = MemberCodeMath.DayRange(today.End, zone);
        var slots = new List<(long First, long End)> { today };
        if (entries.Any(e => LastStep(e) >= tomorrow.First)) slots.Add(tomorrow);

        var keys = new List<string>(keyCap);
        var seen = new HashSet<(int, int)>();
        foreach (var entry in entries)
        {
            var first = MemberCodeMath.StepOf(entry.OpensAt > now ? entry.OpensAt : now);
            var last = LastStep(entry);
            foreach (var player in entry.Players)
            {
                for (var slot = 0; slot < slots.Count; slot++)
                {
                    if (keys.Count == keyCap) return Done(step, stepMs, slots, keys);
                    var (dayFirst, dayEnd) = slots[slot];
                    if (first >= dayEnd || last < dayFirst) continue;
                    if (!seen.Add((player.Ref, slot))) continue;

                    var kday = codes.KdayOf(player, MemberCodeMath.ClubDay(dayFirst, zone));
                    keys.Add(MemberCodeWire.KeyElement(MemberCodeMath.RefText(player.Ref), slot, kday));
                }
            }
        }

        return Done(step, stepMs, slots, keys);
    }

    private static long LastStep(MemberCodeEntry e) => MemberCodeMath.StepOf(e.ClosesAt.AddMilliseconds(-1));

    private static MemberCodeSync Done(long step, int stepMs, List<(long First, long End)> slots, List<string> keys) =>
        new(step, stepMs, [.. slots.Select(s => MemberCodeWire.DayElement(s.First, s.End))], keys);

    /// <summary>
    /// Whether a board is ENTITLED to keys: a court box an admin has acknowledged, a door with a
    /// <c>gate_key</c> (§5.2). An auto-registered board is served the clock and empty arrays.
    /// </summary>
    public static bool Acknowledged(Device device) =>
        device.Kind == DeviceKind.Gate ? !string.IsNullOrWhiteSpace(device.GateKey) : !device.AutoRegistered;

    /// <summary>
    /// Keeps a body inside its contract by dropping keys, last first (§5.4). With today's fields it
    /// never fires — the widest body the corpus can build is 1984 / 3879 bytes — but a future field
    /// must shed a key rather than push a board's whole heartbeat past its buffer.
    /// </summary>
    public static Dictionary<string, object?> Fit(
        Func<MemberCodeSync?, Dictionary<string, object?>> compose, MemberCodeSync? sync, int maxBytes)
    {
        var body = compose(sync);
        while (sync is { Keys.Count: > 0 } && System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(body).Length > maxBytes)
        {
            sync = sync.WithoutLast(1);
            body = compose(sync);
        }
        return body;
    }
}
