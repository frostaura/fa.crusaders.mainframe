using System.Text.Json;
using Crusaders.Mainframe.Api.Endpoints;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// W1.6 — the two readings a door's own rows support, derived on read.
///
/// <para>
/// <b>No new tables, and no acknowledgement.</b> Both signals describe a WINDOW that is still
/// open: "this door turned away eleven scans in the last twenty minutes" stops being true on
/// its own when the window empties, so there is nothing to acknowledge and nothing to store.
/// That is the opposite of a <c>DeviceOutage</c>, which is a fact about a past interval and
/// needs a row.
/// </para>
///
/// <para>
/// <b>The payload carries no member, no fingerprint and no code — P3 and P4, and A2.4.</b> The
/// rows these are derived FROM name members; the signal must not, because at a club of two
/// hundred people a credential is a person, and a door flag that renders one has become a
/// per-member observation on an admin screen. The cheapest way to make that structural rather
/// than a convention is for <see cref="DoorSignal"/> to have nowhere to put one — which is why
/// it is a four-field record and not a projection of the rows. The subject of every signal is
/// the door, and the unit is <b>scans</b>: one person trying four times is four.
/// </para>
/// </summary>
public static class DoorSignals
{
    /// <summary>A door turning a lot of people away inside the club's own window.</summary>
    public const string RefusalSpike = "refusal_spike";

    /// <summary>
    /// One credential accepted several times in under a minute at one door — which people do
    /// not do when a door opens.
    /// </summary>
    public const string MayNotBeReleasing = "may_not_be_releasing";

    /// <summary>
    /// How many grants of one credential at one door raise <see cref="MayNotBeReleasing"/>.
    ///
    /// <para>
    /// Three, and a contract constant rather than a tenant setting — unlike the spike's two
    /// numbers, which a club genuinely tunes to its own traffic. This one is not about volume:
    /// it is the smallest number at which "scanned, walked away, came back" stops being the
    /// likelier story than "the lock did not release". W1.6 fixes it, and the flag's own copy
    /// states it, so a club reading the notice is reading the rule that produced it.
    /// </para>
    /// </summary>
    public const int MayNotBeReleasingGrants = 3;

    /// <summary>The window those grants must fall inside. Sixty seconds — see above.</summary>
    public const int MayNotBeReleasingWindowSeconds = 60;

    /// <summary>
    /// The signals one door's scans support right now.
    ///
    /// <para>
    /// <paramref name="scans"/> is this door's rows only, already tenant-filtered by the
    /// caller's query, and may reach further back than either window — the caller reads one
    /// range for the day's counts and both signals rather than three. Each signal narrows to
    /// its own window here, so widening the caller's read can never widen a flag.
    /// </para>
    /// </summary>
    public static List<DoorSignal> For(
        IReadOnlyList<DoorScan> scans, TenantSettingsView settings, DateTimeOffset now)
    {
        var signals = new List<DoorSignal>(2);
        if (RefusalSpikeFor(scans, settings, now) is { } spike) signals.Add(spike);
        if (StuckReleaseFor(scans, now) is { } stuck) signals.Add(stuck);
        return signals;
    }

    /// <summary>
    /// The spike, or null. Both numbers are the club's, clamped — a club that widens the
    /// window reads its own window back off the flag.
    ///
    /// <para>
    /// <c>since</c> and <c>until</c> are the WINDOW, not the first and last refusal in it. The
    /// notice says "in the last twenty minutes", and a window narrowed to the observed rows
    /// would make the console's own sentence false whenever the run happened to be short.
    /// </para>
    /// </summary>
    private static DoorSignal? RefusalSpikeFor(
        IReadOnlyList<DoorScan> scans, TenantSettingsView settings, DateTimeOffset now)
    {
        var minutes = DoorSettings.RefusalSpikeMinutes(settings);
        var since = now.AddMinutes(-minutes);
        var refusals = scans.Count(s => !s.Released && s.At >= since && s.At <= now);

        return refusals >= DoorSettings.RefusalSpikeCount(settings)
            ? new DoorSignal(RefusalSpike, since, now, refusals)
            : null;
    }

    /// <summary>
    /// The stuck-release reading, or null.
    ///
    /// <para>
    /// Grouped by the credential as the row recorded it — the resolved member for an online
    /// open, the token's fingerprint for an offline one — and a row with NEITHER is excluded
    /// rather than grouped with the other neithers. An offline open whose token had been
    /// pruned before the upload arrived names nothing at all (§6), and lumping several of
    /// those together as "one credential" would invent the very correlation the signal claims
    /// to have observed.
    /// </para>
    ///
    /// <para>
    /// The window is per GROUP, not per door: it is the earliest and latest grant of the one
    /// credential that triggered it, which is what makes the count honest. The identity itself
    /// is discarded at this line and never reaches the caller.
    /// </para>
    /// </summary>
    private static DoorSignal? StuckReleaseFor(IReadOnlyList<DoorScan> scans, DateTimeOffset now)
    {
        var since = now.AddSeconds(-MayNotBeReleasingWindowSeconds);
        var grants = scans
            .Where(s => s.Released && s.At >= since && s.At <= now && s.Credential is not null)
            .GroupBy(s => s.Credential!)
            .Select(g => new { Count = g.Count(), First = g.Min(s => s.At), Last = g.Max(s => s.At) })
            .Where(g => g.Count >= MayNotBeReleasingGrants)
            .OrderByDescending(g => g.Count)
            .ThenBy(g => g.First)
            .FirstOrDefault();

        return grants is null ? null : new DoorSignal(MayNotBeReleasing, grants.First, grants.Last, grants.Count);
    }

    /// <summary>
    /// One scan, reduced to the three things a signal may look at: when, whether the lock was
    /// released, and an opaque handle for "the same credential as that other one".
    /// </summary>
    public static DoorScan ScanOf(string action, DateTimeOffset at, Guid? subjectUserId, JsonElement? details)
    {
        var credential = subjectUserId is { } id && id != Guid.Empty
            ? $"u:{id}"
            : DoorActivityView.Fingerprint(details) is { } fingerprint ? $"f:{fingerprint}" : null;

        return new DoorScan(at, DoorTrail.IsRelease(action), credential);
    }
}

/// <summary>
/// One row as a signal sees it. Top-level and bodyless for the lizard reason recorded in
/// <c>memory/gotchas.md</c>.
///
/// <para>
/// <paramref name="Credential"/> is an opaque equality handle and is never serialised. It
/// exists so "the same credential three times" can be asked; it must never leave this layer,
/// which is why <see cref="DoorSignal"/> has no field it could be put in.
/// </para>
/// </summary>
public sealed record DoorScan(DateTimeOffset At, bool Released, string? Credential);

/// <summary>
/// A door-scoped reading. Four fields, and the absence of a fifth is the rule: no member, no
/// fingerprint, no code. See <see cref="DoorSignals"/>.
/// </summary>
public sealed record DoorSignal(string Kind, DateTimeOffset Since, DateTimeOffset Until, int Scans)
{
    /// <summary>
    /// The wire shape. Written out rather than serialised from the record so the keys are
    /// snake_case like every other door payload, and so adding a field to the record is never
    /// accidentally a privacy regression on the wire.
    /// </summary>
    public object ToWire() => new { kind = Kind, since = Since, until = Until, scans = Scans };
}
