using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Assembles the control board — GOAL item 10's one read.
///
/// <para>
/// <b>Six queries, flat, and flat as the club grows.</b> This is a wall screen refreshing every
/// few seconds on a league night; a projection derived per court on every request is the shape
/// that melts a club's database at 18:00. Courts, light states, one day's bookings in one
/// window, the memberships for the distinct user set, devices, and open-fault counts grouped by
/// device — then <c>current</c> and <c>next</c> are picked in memory from the one booking list.
/// The budget is pinned by a test, because a silent extra round trip is a cost nobody notices
/// until the night it matters.
/// </para>
///
/// <para>
/// <b>Everything it cannot say, it says.</b> A light state the box has not confirmed is
/// <c>stale</c> with an <c>as_of</c> beside it, so a tile reads "ON — but the box has not
/// reported for six minutes" rather than an unqualified "ON". A board that has gone dark leaves
/// the projection at <c>unknown</c> and the board prints unknown. This is a MIRROR, not a
/// control panel: there is no "turn the lights off" button anywhere on it, because adding an
/// actuation control to a read model is how a wall screen becomes a way to switch off a court
/// somebody is playing on.
/// </para>
/// </summary>
public sealed class ControlBoardReader
{
    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;
    private readonly TenantSettingsAccessor _settings;

    public ControlBoardReader(MainframeDbContext db, ITenantContext tenant, TenantSettingsAccessor settings)
    {
        _db = db;
        _tenant = tenant;
        _settings = settings;
    }

    /// <summary>The whole payload, as the endpoint and the stream's snapshot both send it.</summary>
    public async Task<Dictionary<string, object?>> BuildAsync(CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        var s = await _settings.GetAsync(ct);
        var zone = ZoneOf(s.Timezone);
        var day = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(now, zone).DateTime);

        var data = await LoadAsync(now, ct);

        var effective = HeartbeatCadence.Effective(s.HeartbeatSeconds);
        var offlineAfter = HeartbeatCadence.OfflineAfterSeconds(s.HeartbeatSeconds);
        var staleAfter = effective * RealtimeSettings.StaleMultiplier(s);

        var courts = data.Courts
            .Select(c => Tile(c, data, now, staleAfter, effective, offlineAfter))
            .ToList();

        return new Dictionary<string, object?>
        {
            ["generated_at"] = now,

            // The zone as it will actually be USED, never as it is stored. A page printing a
            // club's own label beside instants that are not in it is worse than one that says
            // UTC and means it.
            ["timezone"] = zone.Id == TimeZoneInfo.Utc.Id ? "UTC" : s.Timezone,
            ["slice_minutes"] = s.SliceMinutes,
            ["club_day"] = day.ToString("yyyy-MM-dd"),
            ["courts"] = courts,

            // Review round 4, A4-5: the BOXES, once each, beside the tiles. "N boxes haven't
            // called in" was counted over tiles, so one box driving four courts read as four;
            // and every box is named "Court box", so the MAC and the code are what tell two
            // apart on the wall. Out of the same device read — the query budget is unchanged.
            ["boxes"] = data.Devices
                .OrderBy(d => d.DeviceCode, StringComparer.Ordinal)
                .Select(d => BoxBlock(d, now, effective, offlineAfter))
                .ToList(),

            // The page's own numbers, on the same read. A page that has to make a second
            // request to learn how often to make requests is a page that gets one of them
            // wrong — and this one runs unattended for hours.
            ["realtime"] = new
            {
                poll_seconds = RealtimeSettings.PollSecondsControlBoard(s),
                resync_seconds = RealtimeSettings.ResyncSeconds(s),
                fallback_after_failures = RealtimeSettings.FallbackAfterFailures(s),
                fallback_window_seconds = RealtimeSettings.FallbackWindowSeconds(s),
            },
        };
    }

    /// <summary>Everything the board needs, in six queries that do not grow with the club.</summary>
    private sealed record Data(
        List<Court> Courts,
        Dictionary<Guid, CourtLightState> Lights,
        List<Booking> Bookings,
        Dictionary<Guid, (string Name, string? PhotoUrl)> People,
        List<Device> Devices,
        Dictionary<Guid, Dictionary<DeviceErrorSeverity, int>> OpenErrors);

    private async Task<Data> LoadAsync(DateTimeOffset now, CancellationToken ct)
    {
        // INACTIVE COURTS INCLUDED. A soft-deleted court still carries tonight's paid booking
        // — a member's money on a court that is on no screen is the defect, and this is the
        // one screen that would show it.
        var courts = await _db.Courts.AsNoTracking()
            .OrderBy(c => c.CourtNumber)
            .ToListAsync(ct);

        var lights = await _db.CourtLightStates.AsNoTracking()
            .ToDictionaryAsync(l => l.CourtId, ct);

        // One window around now rather than one query per court: wide enough to carry the slot
        // being played and the one after it, narrow enough that a club with a season of history
        // is not read.
        var from = now.AddHours(-4);
        var to = now.AddHours(12);
        var bookings = await _db.Bookings.AsNoTracking()
            .Where(b => b.Status != BookingStatus.Cancelled && b.EndsAt > from && b.StartsAt < to)
            .OrderBy(b => b.StartsAt)
            .ToListAsync(ct);

        var userIds = bookings
            .Select(b => b.UserId)
            .Concat(lights.Values.Select(l => l.CausedByUserId))
            .Where(id => id is not null && id != Guid.Empty)
            .Select(id => id!.Value)
            .Distinct()
            .ToList();

        var people = await _db.Memberships.AsNoTracking()
            .Where(m => userIds.Contains(m.UserId))
            .ToDictionaryAsync(m => m.UserId, m => (m.FullName, m.PhotoUrl), ct);

        var devices = await _db.Devices.AsNoTracking()
            .Where(d => d.Kind == DeviceKind.CourtBox)
            .ToListAsync(ct);

        var counts = await _db.DeviceErrors.AsNoTracking()
            .Where(e => e.ResolvedAt == null && e.DeviceId != null)
            .GroupBy(e => new { e.DeviceId, e.Severity })
            .Select(g => new { g.Key.DeviceId, g.Key.Severity, Count = g.Count() })
            .ToListAsync(ct);

        var openErrors = counts
            .GroupBy(c => c.DeviceId!.Value)
            .ToDictionary(g => g.Key, g => g.ToDictionary(c => c.Severity, c => c.Count));

        return new Data(courts, lights, bookings, people, devices, openErrors);
    }

    private Dictionary<string, object?> Tile(
        Court court, Data data, DateTimeOffset now, int staleAfter, int effective, int offlineAfter)
    {
        data.Lights.TryGetValue(court.Id, out var light);
        var onThisCourt = data.Bookings.Where(b => b.CourtId == court.Id).ToList();

        var current = onThisCourt.FirstOrDefault(b => b.StartsAt <= now && b.EndsAt > now);
        var next = onThisCourt.FirstOrDefault(b => b.StartsAt > now);

        // The box whose court list CONTAINS this court number, and the position in that list
        // is the relay. A relay is an index into one board's own wiring, never a court number.
        var claiming = data.Devices.Where(d => d.CourtNumbers.Contains(court.CourtNumber)).ToList();
        var device = BoxFor(claiming);
        var relay = device?.CourtNumbers.IndexOf(court.CourtNumber);
        var enabled = claiming.Where(d => d.Enabled).ToList();

        return new Dictionary<string, object?>
        {
            ["court_id"] = court.Id,
            ["court_number"] = court.CourtNumber,
            ["name"] = court.Name,
            ["is_active"] = court.IsActive,
            ["lights"] = LightsBlock(light, data, now, staleAfter),
            ["current"] = CurrentBlock(current, data, now),
            ["next"] = NextBlock(next, data, now),
            ["device"] = DeviceBlock(device, relay, data, now, effective, offlineAfter),

            // Review round 3, A-11: how many ENABLED boxes claim this court, and the ones the tile
            // is not reporting. More than one is a wiring or commissioning mistake the console
            // must warn about, not a choice the board may make silently.
            ["boxes_on_court"] = enabled.Count,
            ["other_boxes"] = enabled.Where(d => d.Id != device?.Id).Select(OtherBox).ToList(),
        };
    }

    /// <summary>
    /// The box a court's tile reports (review round 3, A-11): the freshest ENABLED box claiming it,
    /// or — when none is enabled — the freshest of the rest, so a board taken out of service still
    /// says so. It was the first row the database returned, and a box replaced 22 hours earlier
    /// made the tile contradict its own light state.
    /// </summary>
    private static Device? BoxFor(List<Device> claiming)
    {
        return claiming
            .OrderByDescending(d => d.Enabled)
            .ThenByDescending(d => d.LastSeenAt ?? DateTimeOffset.MinValue)
            .ThenBy(d => d.DeviceCode, StringComparer.Ordinal)
            .FirstOrDefault();
    }

    private static object OtherBox(Device d)
    {
        return new
        {
            device_id = d.Id,
            device_code = d.DeviceCode,
            name = d.Name,
            mac_address = d.MacAddress,
            last_seen_at = d.LastSeenAt,
        };
    }

    private static object BoxBlock(Device d, DateTimeOffset now, int effective, int offlineAfter)
    {
        var silent = d.LastSeenAt is { } seen ? (int)Math.Max(0, (now - seen).TotalSeconds) : (int?)null;
        return new
        {
            device_id = d.Id,
            device_code = d.DeviceCode,
            name = d.Name,
            mac_address = d.MacAddress,
            enabled = d.Enabled,
            link = LinkOf(d, silent, effective, offlineAfter),
            last_seen_at = d.LastSeenAt,
            court_numbers = d.CourtNumbers,
        };
    }

    /// <summary>
    /// What the server believes about this court's relay, with every qualifier it needs.
    ///
    /// <para>
    /// A court with no projection row at all reads <c>unknown</c> rather than <c>off</c>, for
    /// the reason the backfill writes <c>unknown</c>: <c>off</c> would be a claim, and the
    /// server has no evidence for one.
    /// </para>
    /// </summary>
    private static object LightsBlock(
        CourtLightState? light, Data data, DateTimeOffset now, int staleAfter)
    {
        var state = light?.State ?? LightState.Unknown;
        var cause = light?.Cause ?? LightCause.Unknown;

        // Strictly greater: a court whose last event is exactly one window old has not yet
        // failed to report, and a boundary that shouts one beat early is a boundary an admin
        // learns to ignore.
        var stale = light is not null && (now - light.LastEventAt).TotalSeconds > staleAfter;

        return new
        {
            state = CourtLightStateService.StateWire(state),
            since = state == LightState.On ? light?.OnSince : null,
            until = light?.OnUntil,
            seconds_remaining = light?.SecondsRemainingAt(now),
            stale,
            as_of = light?.LastEventAt,

            // What the BOX said, kept apart from what the server believes. A box reporting a
            // relay open while the server believes it granted time is a contradiction an admin
            // must see, not one the server should resolve by adopting the box's view and
            // losing the evidence that they ever disagreed.
            confirmed_at = light?.ConfirmedAt,
            confirmed_state = ConfirmedWire(light),

            turned_on_by = TurnedOnBy(cause, light?.CausedByUserId, data),
            from_booking_id = light?.BookingId,
        };
    }

    /// <summary>
    /// What the BOX last said about this relay, or null when it has never said anything.
    ///
    /// <para>
    /// Null rather than <c>"off"</c> for a board whose firmware does not report relay state —
    /// which is every board in the field until the new image ships. Three states, not two: a
    /// tile that read "confirmed off" about a court no box has ever spoken about would be the
    /// software asserting evidence it does not have, on the one screen whose job is to tell
    /// those two apart.
    /// </para>
    /// </summary>
    private static string? ConfirmedWire(CourtLightState? light)
    {
        if (light?.ConfirmedAt is null) return null;
        return CourtLightStateService.StateWire(light.ConfirmedState);
    }

    /// <summary>
    /// Who or what lit the court.
    ///
    /// <para>
    /// A restore after a power dip names NOBODY. Nobody scanned; putting a member's name
    /// against an act no person performed is the software inventing evidence, and the trace
    /// reads this same distinction.
    /// </para>
    /// </summary>
    private static object TurnedOnBy(LightCause cause, Guid? userId, Data data)
    {
        var known = userId is { } id && id != Guid.Empty && data.People.TryGetValue(id, out var person);
        var found = known && userId is { } uid ? data.People[uid] : default;

        return new
        {
            kind = CourtLightStateService.CauseWire(cause),
            user_id = cause == LightCause.RestoreAfterPowerDip ? null : userId,
            name = cause == LightCause.RestoreAfterPowerDip || !known ? null : found.Name,
            photo_url = cause == LightCause.RestoreAfterPowerDip || !known ? null : found.PhotoUrl,
        };
    }

    private static object? CurrentBlock(Booking? booking, Data data, DateTimeOffset now)
    {
        if (booking is null) return null;
        return new
        {
            booking_id = booking.Id,
            starts_at = booking.StartsAt,
            ends_at = booking.EndsAt,
            status = StatusWire(booking.Status),
            kind = KindOf(booking),
            label = booking.BlockLabel,
            booked_by = Person(booking.UserId, data),
            checked_in_at = booking.CheckedInAt,
            amount_credits = booking.AmountChargedCredits,
            minutes_remaining = Math.Max(0, (int)Math.Ceiling((booking.EndsAt - now).TotalMinutes)),
        };
    }

    private static object? NextBlock(Booking? booking, Data data, DateTimeOffset now)
    {
        if (booking is null) return null;
        return new
        {
            booking_id = booking.Id,
            starts_at = booking.StartsAt,
            minutes_until = Math.Max(0, (int)Math.Round((booking.StartsAt - now).TotalMinutes)),
            kind = KindOf(booking),
            label = booking.BlockLabel,
            booked_by = Person(booking.UserId, data),
        };
    }

    private static object? Person(Guid? userId, Data data)
    {
        if (userId is not { } id || id == Guid.Empty) return null;
        if (!data.People.TryGetValue(id, out var person)) return null;
        return new { user_id = id, name = person.Name, photo_url = person.PhotoUrl };
    }

    /// <summary>
    /// The board driving this court, and how much of what it says can be believed.
    ///
    /// <para>
    /// <c>link</c> is five states, derived once. <c>silent</c> is the one with no name before
    /// this board existed — past one heartbeat, not yet offline — and it is the one an admin
    /// most wants to see, because it is the band in which somebody can still walk over and fix
    /// it before a member is standing at a dark court.
    /// </para>
    /// </summary>
    private static object DeviceBlock(
        Device? device, int? relay, Data data, DateTimeOffset now, int effective, int offlineAfter)
    {
        var silent = device?.LastSeenAt is { } seen ? (int)Math.Max(0, (now - seen).TotalSeconds) : (int?)null;

        return new
        {
            device_id = device?.Id,
            device_code = device?.DeviceCode,
            name = device?.Name,
            mac_address = device?.MacAddress,

            // The relay LETTER, from the position in this board's own court list. Index 0 is
            // relay A, whatever court number sits there.
            relay = relay is { } index and >= 0 and < 26 ? ((char)('A' + index)).ToString() : null,

            link = LinkOf(device, silent, effective, offlineAfter),
            last_seen_at = device?.LastSeenAt,
            silent_seconds = silent,

            // On the wire even for an unlinked court: the tile can then say what "offline"
            // would mean for this club, rather than leaving the number to the page to invent.
            offline_after_seconds = offlineAfter,

            firmware = device?.RunningVersion,
            mega_version = device?.MegaVersion,
            open_errors = OpenErrorsOf(device, data),
        };
    }

    private static string LinkOf(Device? device, int? silent, int effective, int offlineAfter)
    {
        if (device is null) return "unlinked";

        // The club's own decision outranks the board's chatter. A board an admin shut is out
        // of service even while it is heartbeating, because the decision is the fact.
        if (!device.Enabled || device.OutOfServiceSince is not null) return "out_of_service";

        // Never heard from at all is OFFLINE, not online-with-a-null. A board that has never
        // called in has never proved anything.
        if (silent is not { } quiet) return "offline";

        if (quiet > offlineAfter) return "offline";
        return quiet > effective ? "silent" : "online";
    }

    private static object OpenErrorsOf(Device? device, Data data)
    {
        var counts = device is not null && data.OpenErrors.TryGetValue(device.Id, out var found)
            ? found
            : [];

        return new
        {
            critical = counts.GetValueOrDefault(DeviceErrorSeverity.Critical),
            error = counts.GetValueOrDefault(DeviceErrorSeverity.Error),
            warning = counts.GetValueOrDefault(DeviceErrorSeverity.Warning),
            info = counts.GetValueOrDefault(DeviceErrorSeverity.Info),
        };
    }

    /// <summary>
    /// What kind of thing is on the court.
    ///
    /// <para>
    /// A walk-up is charged at the instant it starts, because one <c>now</c> serves both fields
    /// where the row is created — and that equality is the only discriminator the row carries.
    /// It is recorded here rather than inferred at each reader, because the next reader would
    /// infer it differently.
    /// </para>
    /// </summary>
    private static string KindOf(Booking booking)
    {
        if (booking.Status == BookingStatus.AdminBlock) return "block";
        return booking.ChargedAt is { } charged && charged == booking.StartsAt ? "walk_up" : "booking";
    }

    private static string StatusWire(BookingStatus status)
    {
        return status switch
        {
            BookingStatus.Booked => "booked",
            BookingStatus.Completed => "completed",
            BookingStatus.Cancelled => "cancelled",
            BookingStatus.NoShow => "no_show",
            BookingStatus.AdminBlock => "admin_block",
            _ => "booked",
        };
    }

    /// <summary>
    /// The club's zone, or UTC when the stored id is one this platform's tzdb cannot name.
    ///
    /// <para>
    /// Falling back rather than throwing, and the caller RENDERS the fallback's name: a board
    /// that 500s because somebody typed a zone wrongly is a blank wall screen, and one that
    /// prints the club's label beside instants that are not in it is worse than one that says
    /// UTC.
    /// </para>
    /// </summary>
    private static TimeZoneInfo ZoneOf(string id)
        => TimeZoneInfo.TryFindSystemTimeZoneById(id, out var zone) ? zone : TimeZoneInfo.Utc;
}
