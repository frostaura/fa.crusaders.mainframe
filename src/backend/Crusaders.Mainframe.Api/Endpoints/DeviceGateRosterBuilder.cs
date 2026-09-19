using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// The roster a door gate caches so it can admit a booked member with no network.
///
/// <para>
/// <b>This is the gate's degraded mode, and it is narrower than the court box's on purpose.</b>
/// A court box offline still serves every member it has a use for, because everyone who turns
/// up at a court has a booking. A gate offline serves only members with a booking — a
/// sixty-second <see cref="AccessCodePurpose.MemberIdent"/> code can never be in a cache
/// fetched minutes ago, so under the default <c>active_member</c> policy an active member with
/// no court booked gets in online and does not get in offline. That is stated rather than
/// engineered around: the alternative is pushing the club's whole membership roll to a board
/// in a doorway, which is a different product and a much worse secret to leave in a cupboard.
/// </para>
///
/// <para>
/// The element grammar is the court box's, unchanged —
/// <c>TOKEN|relay|opens_in|closes_in</c> — so <c>devlink::parseRosterElement</c> and
/// <c>roster::Roster</c> are reused rather than forked. The relay field is always
/// <see cref="GateRelay"/>: a door has one lock and no relay bank to index. Keeping the field
/// rather than dropping it is what makes the reuse possible, and it costs two bytes an entry.
/// </para>
///
/// <para>
/// Split the same way the court builder is, and for the same reason:
/// <see cref="Format"/> is pure and testable against a fixed clock with no database, and
/// <see cref="BuildAsync"/> is the query plus the lazy mint that feeds it.
/// </para>
/// </summary>
public static class DeviceGateRosterBuilder
{
    /// <summary>
    /// Most entries one gate heartbeat carries. A <b>contract constant</b>, not a tenant
    /// setting: it bounds <c>Roster&lt;48&gt;</c> on the board and, through it, the static
    /// response buffer the gate holds the whole heartbeat in — and a tenant setting cannot
    /// resize a buffer in a doorway. Three times the court box's sixteen because a gate draws
    /// on every court in the club at once rather than on the four one box drives.
    /// </summary>
    public const int GateRosterMaxEntries = 48;

    /// <summary>
    /// The budget for the WHOLE gate heartbeat body, bytes — <c>max_bytes</c> on the corpus
    /// vector <c>gate-heartbeat-response-roster-full</c>, and the reason the board's buffer is
    /// 4608. The widest body the server can actually emit comes to about 1800; the headroom is
    /// for a field added to the envelope later without a reflash, not slack in the estimate.
    /// </summary>
    public const int MaxResponseBytes = 4096;

    /// <summary>
    /// The relay index every gate entry carries. A door has one lock, so the field exists only
    /// to keep the grammar identical to the court box's.
    /// </summary>
    public const int GateRelay = 0;

    /// <summary>One booking as a gate sees it: no court, because a door is not on one.</summary>
    public sealed record GateCandidate(Booking Booking, string Token);

    /// <summary>
    /// The roster strings for <paramref name="candidates"/>, relative to <paramref name="now"/>.
    ///
    /// <para>
    /// Pure. Orders by <c>StartsAt</c> then <c>Id</c> — the tie-break matters here in a way it
    /// does not on a court box, because a club with forty-eight bookings in its window very
    /// plausibly has several starting on the same slice boundary, and a cap applied to an
    /// unstable order sends a different forty-eight on every heartbeat. Drops a token too long
    /// for the firmware to match rather than sending one to be refused, and caps AFTER
    /// ordering so it is always the earliest forty-eight that go.
    /// </para>
    /// </summary>
    public static List<string> Format(
        IEnumerable<GateCandidate> candidates, DateTimeOffset now, TimeSpan earlyEntry)
    {
        var roster = new List<string>(GateRosterMaxEntries);

        foreach (var c in candidates.OrderBy(c => c.Booking.StartsAt).ThenBy(c => c.Booking.Id))
        {
            if (roster.Count == GateRosterMaxEntries) break;
            if (c.Token.Length is 0 or > DeviceRosterBuilder.MaxTokenLength) continue;

            roster.Add(DeviceRosterBuilder.Entry(
                c.Token, GateRelay, c.Booking.StartsAt - earlyEntry, c.Booking.EndsAt, now));
        }

        return roster;
    }

    /// <summary>
    /// The roster every gate in this club is given right now.
    ///
    /// <para>
    /// <b>It takes no <see cref="Device"/>, and that is the difference from the court box.</b>
    /// A box's roster is a function of the courts it drives; a gate's is a function of the
    /// club, so two doors on the same tenant are handed the same list and a gate row carries
    /// nothing that could change it. <c>gate_key</c> names the door for an admin and for the
    /// audit trail; it is not an access-control input, and making it one would be a policy
    /// decision nothing in the product has taken.
    /// </para>
    ///
    /// <para>
    /// Selects bookings that are still <c>Booked</c> — checked in or not — on any court, whose
    /// entry window <c>[StartsAt − gate_early_entry_minutes, EndsAt]</c> intersects
    /// <c>[now, now + roster_window_minutes]</c>, held by a member the club has not barred.
    /// The barred filter is the inline query-side twin
    /// <see cref="MembershipAccess"/> documents, written out rather than captured because a
    /// captured expression does not translate inside a subquery — the two must move together.
    /// Without it, a suspension would hold only while the gate can reach the API, and the one
    /// window in which a club most wants it to hold is the one where nobody is watching.
    /// </para>
    ///
    /// <para>
    /// A cancelled booking is expressed by its ABSENCE from the next push, so the list is
    /// always sent, empty included; an omitted key would leave a stale roster live. Codes are
    /// minted lazily for bookings that predate them, through the court builder's own
    /// <see cref="DeviceRosterBuilder.TokensForAsync"/> — one read for the batch, then a mint
    /// per booking that has none — so a member's phone and every cache in the club are minted
    /// from one rule.
    /// </para>
    /// </summary>
    public static async Task<List<string>> BuildAsync(
        MainframeDbContext db, AccessCodeService codes, TenantSettingsView settings,
        DateTimeOffset now, CancellationToken ct)
    {
        var earlyEntry = TimeSpan.FromMinutes(settings.GateEarlyEntryMinutes);

        // [StartsAt − early, EndsAt] ∩ [now, now + roster] ≠ ∅  ⇔
        // StartsAt ≤ now + roster + early  ∧  EndsAt ≥ now — two constants the provider can
        // translate, the same rearrangement DeviceRosterBuilder and QrEndpoints use.
        var latestStart = now.AddMinutes(settings.RosterWindowMinutes).Add(earlyEntry);

        var bookings = await db.Bookings
            .Where(b => b.Status == BookingStatus.Booked
                        && b.UserId != null
                        && b.StartsAt <= latestStart
                        && b.EndsAt >= now
                        && !db.Memberships.Any(m => m.UserId == b.UserId && m.Status != MembershipStatus.Active))
            .OrderBy(b => b.StartsAt)
            .ThenBy(b => b.Id)
            .Take(GateRosterMaxEntries)
            .ToListAsync(ct);
        if (bookings.Count == 0) return [];

        var tokens = await DeviceRosterBuilder.TokensForAsync(db, codes, bookings, settings, now, ct);

        return Format(bookings.Select(b => new GateCandidate(b, tokens[b.Id])), now, earlyEntry);
    }
}
