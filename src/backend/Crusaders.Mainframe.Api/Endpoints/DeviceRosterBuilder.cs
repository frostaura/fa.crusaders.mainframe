using System.Globalization;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// The roster a court box caches so it can admit a booked member with no network.
///
/// <para>
/// This is the half of review C2 that lives on the server. <c>Roster.h</c> said "the API
/// pushes the roster on the heartbeat" and nothing ever did, so every scan at a healthy
/// box was refused as Stale — forever, on every court. The heartbeat now carries
/// <c>roster</c>: one string per near-future booking on the box's courts, in the four-field
/// shape the firmware's <c>bridgelogic/RosterSync</c> parses.
/// </para>
///
/// <para>
/// <b>The wire shape is <c>TOKEN|relay|opens_in|closes_in</c></b>. The token is the
/// booking's activation code — the bytes the member's phone will put in front of the
/// scanner, and nothing a stolen board could turn into a member. The relay is the index of
/// the booking's court in <see cref="Device.CourtNumbers"/>, because that list <i>is</i> the
/// relay mapping. The two counts are SIGNED seconds relative to the response instant —
/// until the booking's cue window opens (negative means already open) and until its slot
/// ends — because the box has no RTC and an absolute time is meaningless across the reboot
/// that clears <c>millis()</c>.
/// </para>
///
/// <para>
/// The assembly is split in two so the arithmetic is testable against a fixed clock without
/// a database: <see cref="Format"/> is pure, and <see cref="BuildAsync"/> is the query plus
/// the lazy mint that feeds it.
/// </para>
/// </summary>
public static class DeviceRosterBuilder
{
    /// <summary>
    /// Most entries one heartbeat carries. A <b>contract constant</b>, not a tenant setting:
    /// it bounds the firmware's roster buffer (<c>bridgelogic::kMaxRosterEntries</c>) and,
    /// through it, the size of the heartbeat response the box has to hold in RAM. Pinned by
    /// <c>heartbeat-response-roster-full</c> in the shared corpus. A tenant with more than
    /// sixteen bookings inside its window on one box gets the sixteen that start first; the
    /// rest arrive on a later heartbeat as the earlier ones check in or end.
    /// </summary>
    public const int RosterMaxEntries = 16;

    /// <summary>
    /// Longest token the firmware will match (<c>roster::kMaxTokenLen</c>). Access codes are
    /// twelve characters; this is the wall, and an entry whose token would breach it is left
    /// out rather than sent to be refused — a token cut short matches a different member.
    /// </summary>
    public const int MaxTokenLength = 20;

    /// <summary>One booking as the roster sees it: its court number and the code that opens it.</summary>
    public sealed record Candidate(Booking Booking, int CourtNumber, string Token);

    /// <summary>
    /// The roster strings for <paramref name="candidates"/>, relative to <paramref name="now"/>.
    ///
    /// <para>
    /// Pure. Orders by <c>StartsAt</c>, maps each court number to its relay index in
    /// <paramref name="courtNumbers"/>, drops anything that cannot be expressed — a court
    /// this box does not drive, a token too long for the firmware — and caps at
    /// <see cref="RosterMaxEntries"/>. The cap is applied AFTER ordering, so it is always the
    /// earliest sixteen that go, which is what the member standing at the box needs.
    /// </para>
    /// </summary>
    public static List<string> Format(
        IEnumerable<Candidate> candidates, IReadOnlyList<int> courtNumbers, DateTimeOffset now, TimeSpan cue)
    {
        var roster = new List<string>(RosterMaxEntries);

        foreach (var c in candidates.OrderBy(c => c.Booking.StartsAt).ThenBy(c => c.Booking.Id))
        {
            if (roster.Count == RosterMaxEntries) break;

            var relay = RelayOf(courtNumbers, c.CourtNumber);
            if (relay < 0 || relay > 3) continue;
            if (c.Token.Length is 0 or > MaxTokenLength) continue;

            roster.Add(Entry(c.Token, relay, c.Booking.StartsAt - cue, c.Booking.EndsAt, now));
        }

        return roster;
    }

    /// <summary>The relay a court number is wired to: its position in the list, or -1.</summary>
    public static int RelayOf(IReadOnlyList<int> courtNumbers, int courtNumber)
    {
        for (var i = 0; i < courtNumbers.Count; i++)
        {
            if (courtNumbers[i] == courtNumber) return i;
        }
        return -1;
    }

    /// <summary>
    /// One <c>TOKEN|relay|opens_in|closes_in</c> string. Floored, not rounded: a booking
    /// half a second from opening is not open, and a slot with half a second left is over.
    /// </summary>
    public static string Entry(string token, int relay, DateTimeOffset opensAt, DateTimeOffset closesAt, DateTimeOffset now)
    {
        var opensIn = (long)Math.Floor((opensAt - now).TotalSeconds);
        var closesIn = (long)Math.Floor((closesAt - now).TotalSeconds);
        return string.Create(CultureInfo.InvariantCulture, $"{token}|{relay}|{opensIn}|{closesIn}");
    }

    /// <summary>
    /// The roster for <paramref name="device"/> right now.
    ///
    /// <para>
    /// Selects bookings on the box's courts that are still <c>Booked</c> — checked in or not
    /// — and whose activation window <c>[StartsAt − cue, EndsAt]</c> intersects
    /// <c>[now, now + roster_window]</c>. That is the same horizon the QR screen uses to
    /// decide which code to show, so the code on the member's phone and the code in the
    /// box's cache are minted from one rule. A live session used to be left out on the
    /// grounds that a repeat scan is the online path's job; but the relay hard cap is
    /// ninety minutes and a slot can be longer, so the second half of a paid two-hour slot
    /// was dark during any outage — the box had nothing to re-light it from. A checked-in
    /// booking still inside its window stays on the roster until it ends.
    /// </para>
    ///
    /// <para>
    /// Every query here goes through the context's tenant filter. The device row was found
    /// under this tenant, its courts are this tenant's courts, and the bookings are read
    /// through the same filter — another club's booking on a court that happens to share a
    /// number cannot reach this list, structurally.
    /// </para>
    ///
    /// <para>
    /// Codes are minted lazily for bookings that predate them. <see cref="AccessCodeService.MintForBookingAsync"/>
    /// saves per new code, which is a write on a read path; it happens once per legacy
    /// booking and never again, and the alternative — a member with a paid booking and no
    /// code — is exactly the dark court this exists to prevent.
    /// </para>
    /// </summary>
    public static async Task<List<string>> BuildAsync(
        MainframeDbContext db, AccessCodeService codes, Device device, TenantSettingsView settings,
        DateTimeOffset now, CancellationToken ct)
    {
        if (device.CourtNumbers.Count == 0) return [];

        // Both windows clamped on read, through the same functions the door and the phone
        // read them with — see BookingCodeWindow. TenantSettingsAccessor bounds nothing on the
        // way in, so a hand-edited roster_window_minutes: -600 put `latestStart` ten hours in
        // the past and emptied every box's cache in the club on a clean 200, with no error and
        // no log; a negative cue moved the roster's own opens_in the wrong way.
        var cue = TimeSpan.FromMinutes(BookingCodeWindow.CueMinutes(settings));
        var courtNumbers = device.CourtNumbers;
        var courts = await db.Courts.AsNoTracking()
            .Where(c => courtNumbers.Contains(c.CourtNumber) && c.IsActive)
            .Select(c => new { c.Id, c.CourtNumber })
            .ToListAsync(ct);
        var courtIds = courts.Select(c => c.Id).ToList();
        var numberOf = courts.ToDictionary(c => c.Id, c => c.CourtNumber);

        // [StartsAt − cue, EndsAt] ∩ [now, now + roster] ≠ ∅  ⇔
        // StartsAt ≤ now + roster + cue  ∧  EndsAt ≥ now — two constants the provider can
        // translate, the same rearrangement QrEndpoints uses.
        var latestStart = now.AddMinutes(BookingCodeWindow.RosterReachMinutes(settings)).Add(cue);
        var bookings = await db.Bookings
            .Where(b => courtIds.Contains(b.CourtId)
                        && b.Status == BookingStatus.Booked
                        && b.UserId != null
                        && b.StartsAt <= latestStart
                        && b.EndsAt >= now
                        // A member the club has not approved — suspended, rejected, or
                        // still waiting — is not on the cached roster either. Without this,
                        // suspension holds only while the box can reach the API, and the
                        // one window in which a club most wants it to hold is the one where
                        // nobody is watching. `!= Active` rather than `== Suspended`: see
                        // MembershipAccess for why the rule is stated that way round.
                        // Ruling 15: an ACTIVE row, not merely the absence of a non-active one.
                        // The old shape let a booking with NO membership row through, which is
                        // the same conflation that opened a door — see MembershipAccess.
                        && db.Memberships.Any(m => m.UserId == b.UserId && m.Status == MembershipStatus.Active))
            .OrderBy(b => b.StartsAt)
            .Take(RosterMaxEntries)
            .ToListAsync(ct);
        if (bookings.Count == 0) return [];

        var tokens = await TokensForAsync(db, codes, bookings, settings, now, ct);

        return Format(
            bookings.Select(b => new Candidate(b, numberOf[b.CourtId], tokens[b.Id])),
            courtNumbers, now, cue);
    }

    /// <summary>
    /// The live activation code per booking — one read for the batch, then a mint for each
    /// booking that has none. Sixteen bookings must not be sixteen round trips four times a
    /// minute per box.
    ///
    /// <para>
    /// Public because <see cref="DeviceGateRosterBuilder"/> uses it unchanged, and that reuse
    /// is the point rather than an economy: the token a member's phone shows, the token in a
    /// court box's cache and the token in a door gate's cache all have to be the same bytes,
    /// minted under the same expiry rule. A second copy of this method is a second expiry
    /// rule waiting to drift from this one.
    /// </para>
    /// </summary>
    public static async Task<Dictionary<Guid, string>> TokensForAsync(
        MainframeDbContext db, AccessCodeService codes, List<Booking> bookings, TenantSettingsView settings,
        DateTimeOffset now, CancellationToken ct)
    {
        var ids = bookings.Select(b => b.Id).ToList();
        var live = await db.AccessCodes.AsNoTracking()
            .Where(c => c.BookingId != null && ids.Contains(c.BookingId.Value)
                        && c.Purpose == AccessCodePurpose.BookingActivation
                        && c.ExpiresAt > now)
            .OrderBy(c => c.ExpiresAt)
            .ToListAsync(ct);

        var tokens = new Dictionary<Guid, string>(bookings.Count);
        foreach (var code in live) tokens[code.BookingId!.Value] = code.Code;

        var grace = TimeSpan.FromMinutes(settings.GraceWindowMinutes);
        foreach (var booking in bookings)
        {
            if (tokens.ContainsKey(booking.Id)) continue;
            tokens[booking.Id] = (await codes.MintForBookingAsync(booking, grace, ct)).Code;
        }

        return tokens;
    }
}
