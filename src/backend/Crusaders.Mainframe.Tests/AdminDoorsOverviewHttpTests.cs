using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// <c>GET /api/v1/admin/doors</c> — W1.1's one read.
///
/// <para>
/// Three claims are under test here and each of them is a rule the UX spec argued for rather
/// than a convenience. <b>The day is the CLUB's day</b>, because a count computed in the
/// browser is a different day for an admin travelling or with a wrong device clock, and this
/// is the one number on the page somebody will quote in a committee meeting. <b>A count that
/// could not be made is null and never zero</b>, because a zero rendered on a failed read is
/// the <c>admin-failed-read</c> defect with a different noun. <b>A signal names no member and
/// no credential</b> — P3 and P4 — and the cheapest way to make that structural rather than a
/// convention is for the payload not to carry one at all, which is what the serialise-and-grep
/// test below pins.
/// </para>
/// </summary>
public sealed class AdminDoorsOverviewHttpTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public AdminDoorsOverviewHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string DoorsPath = "/api/v1/admin/doors";

    private TestWebAppFactory CreateFactory() => _pg.SharedHost;

    private static JsonElement DoorNamed(JsonElement body, string deviceCode)
        => body.GetProperty("doors").EnumerateArray()
            .Single(d => d.GetProperty("device").GetProperty("device_code").GetString() == deviceCode);

    /// <summary>Court boxes are not doors. The doors area lists doors.</summary>
    [SkippableFact]
    public async Task A_court_box_is_not_on_the_doors_list()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "ovkind", DoorClub.DaytimeSettings());
        await club.AddDoorAsync(factory, "gate-ov0001", "front-door");
        await club.AddCourtBoxAsync(factory, "box-ov0001");

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(DoorsPath);

        var codes = body.GetProperty("doors").EnumerateArray()
            .Select(d => d.GetProperty("device").GetProperty("device_code").GetString()).ToList();
        Assert.Equal(["gate-ov0001"], codes);
    }

    /// <summary>
    /// Name ascending, stable, and no sort control anywhere — A2.3. A list of doors ordered by
    /// anything a club can choose becomes a footfall ranking the first time somebody sorts it.
    /// </summary>
    [SkippableFact]
    public async Task The_doors_are_ordered_by_name_ascending_and_stably()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "ovorder", DoorClub.DaytimeSettings());
        await club.AddDoorAsync(factory, "gate-ov0013", "z", name: "Side door");
        await club.AddDoorAsync(factory, "gate-ov0011", "x", name: "Back door");
        await club.AddDoorAsync(factory, "gate-ov0012", "y", name: "Back door");

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(DoorsPath);
        var codes = body.GetProperty("doors").EnumerateArray()
            .Select(d => d.GetProperty("device").GetProperty("device_code").GetString()).ToList();

        // Two doors share a name; the device code breaks the tie, so the order is the same on
        // every read rather than whatever the database happened to return.
        Assert.Equal(["gate-ov0011", "gate-ov0012", "gate-ov0013"], codes);
    }

    /// <summary>
    /// The club's day, not the reader's. A club in Auckland counts a different set of rows at
    /// the same instant than a club in Johannesburg, and the boundary is stated so the page can
    /// name it.
    /// </summary>
    [SkippableFact]
    public async Task Todays_counts_are_taken_in_the_clubs_own_timezone()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(
            factory, "ovtz",
            """{"slice_minutes":15,"grace_window_minutes":5,"timezone":"Pacific/Auckland"}""");
        var doorId = await club.AddDoorAsync(factory, "gate-ov0002", "front-door");

        var zone = TimeZoneInfo.FindSystemTimeZoneById("Pacific/Auckland");
        var now = DateTimeOffset.UtcNow;
        var localNow = TimeZoneInfo.ConvertTime(now, zone);
        var dayStart = new DateTimeOffset(localNow.Year, localNow.Month, localNow.Day, 0, 0, 0, localNow.Offset);

        // One minute inside the club's day, one minute outside it. In UTC those two instants
        // are on the same calendar day for most of the year, which is the whole point.
        // Written in UTC: Npgsql refuses a DateTimeOffset with a non-zero offset on a
        // `timestamp with time zone` column. Same instants, stated the way the column stores
        // them, which is also what makes the assertion below about the CLUB's day meaningful
        // rather than a tautology about the fixture's own offset.
        await club.WriteRowAsync(factory, doorId, DeviceGateEndpoint.OpenedAction, dayStart.AddMinutes(1).ToUniversalTime());
        await club.WriteRowAsync(factory, doorId, DeviceGateEndpoint.OpenedAction, dayStart.AddMinutes(-1).ToUniversalTime());
        await club.WriteRowAsync(
            factory, doorId, $"{DeviceGateEndpoint.DeniedActionPrefix}too_early", dayStart.AddMinutes(2).ToUniversalTime(),
            reason: "too_early");

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(DoorsPath);

        Assert.Equal("Pacific/Auckland", body.GetProperty("timezone").GetString());
        Assert.Equal(dayStart, body.GetProperty("day_started_at").GetDateTimeOffset());

        var today = DoorNamed(body, "gate-ov0002").GetProperty("today");
        Assert.Equal(1, today.GetProperty("released").GetInt32());
        Assert.Equal(1, today.GetProperty("refused").GetInt32());
    }

    /// <summary>
    /// An offline open is an open and an offline unknown scan is a refusal. Both halves of the
    /// board's day, exactly as the per-device feed already carries them.
    /// </summary>
    [SkippableFact]
    public async Task The_counts_carry_both_halves_of_the_doors_day()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "ovhalves", DoorClub.DaytimeSettings());
        var doorId = await club.AddDoorAsync(factory, "gate-ov0003", "front-door");
        var now = DateTimeOffset.UtcNow;

        await club.WriteRowAsync(factory, doorId, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-5));
        await club.WriteRowAsync(factory, doorId, "device.gate_open", now.AddMinutes(-4), seq: 7);
        await club.WriteRowAsync(
            factory, doorId, $"{DeviceGateEndpoint.DeniedActionPrefix}not_recognised", now.AddMinutes(-3),
            reason: "not_recognised");
        await club.WriteRowAsync(factory, doorId, "device.unknown_scan", now.AddMinutes(-2), seq: 8);

        // Neither of these is a scan: a registration and an admin edit are in the per-board
        // feed and must not be counted as somebody at the door.
        await club.WriteRowAsync(factory, doorId, "device.registered", now.AddMinutes(-1));
        await club.WriteRowAsync(factory, doorId, "device.updated", now.AddMinutes(-1));

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(DoorsPath);
        var today = DoorNamed(body, "gate-ov0003").GetProperty("today");

        Assert.Equal(2, today.GetProperty("released").GetInt32());
        Assert.Equal(2, today.GetProperty("refused").GetInt32());
    }

    /// <summary>Counts are door-scoped. One door's busy morning is not another door's.</summary>
    [SkippableFact]
    public async Task The_counts_are_scoped_to_their_own_door()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "ovscope", DoorClub.DaytimeSettings());
        var front = await club.AddDoorAsync(factory, "gate-ov0004", "front-door", name: "A front");
        await club.AddDoorAsync(factory, "gate-ov0005", "side-door", name: "B side");
        var now = DateTimeOffset.UtcNow;

        await club.WriteRowAsync(factory, front, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-5));
        await club.WriteRowAsync(factory, front, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-4));

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(DoorsPath);

        Assert.Equal(2, DoorNamed(body, "gate-ov0004").GetProperty("today").GetProperty("released").GetInt32());
        Assert.Equal(0, DoorNamed(body, "gate-ov0005").GetProperty("today").GetProperty("released").GetInt32());
    }

    /// <summary>
    /// A club whose stored zone the platform does not know has no day this server can name, so
    /// it gets NO counts rather than counts against a day it does not keep. Null, never zero.
    /// </summary>
    [SkippableFact]
    public async Task A_day_that_cannot_be_established_yields_null_counts_and_never_zero()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(
            factory, "ovbadtz",
            """{"slice_minutes":15,"grace_window_minutes":5,"timezone":"Mars/Olympus_Mons"}""");
        var doorId = await club.AddDoorAsync(factory, "gate-ov0006", "front-door");
        await club.WriteRowAsync(factory, doorId, DeviceGateEndpoint.OpenedAction, DateTimeOffset.UtcNow.AddMinutes(-5));

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(DoorsPath);

        Assert.Equal(JsonValueKind.Null, DoorNamed(body, "gate-ov0006").GetProperty("today").ValueKind);
    }

    /// <summary>A quiet door is a real zero. It is the unknown that is null.</summary>
    [SkippableFact]
    public async Task A_door_with_no_scans_today_counts_zero_rather_than_null()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "ovquiet", DoorClub.DaytimeSettings());
        await club.AddDoorAsync(factory, "gate-ov0007", "front-door");

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(DoorsPath);
        var today = DoorNamed(body, "gate-ov0007").GetProperty("today");

        Assert.Equal(0, today.GetProperty("released").GetInt32());
        Assert.Equal(0, today.GetProperty("refused").GetInt32());
    }

    [SkippableFact]
    public async Task A_run_of_refusals_at_one_door_raises_a_spike_and_states_its_own_window()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "ovspike", DoorClub.DaytimeSettings());
        var doorId = await club.AddDoorAsync(factory, "gate-ov0008", "side-door");
        var now = DateTimeOffset.UtcNow;

        for (var i = 0; i < DoorSettings.DefaultRefusalSpikeCount; i++)
        {
            await club.WriteRowAsync(
                factory, doorId, $"{DeviceGateEndpoint.DeniedActionPrefix}not_recognised",
                now.AddMinutes(-(i + 1)), reason: "not_recognised");
        }

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(DoorsPath);
        var signal = DoorNamed(body, "gate-ov0008").GetProperty("signals").EnumerateArray()
            .Single(s => s.GetProperty("kind").GetString() == DoorSignals.RefusalSpike);

        Assert.Equal(DoorSettings.DefaultRefusalSpikeCount, signal.GetProperty("scans").GetInt32());
        var since = signal.GetProperty("since").GetDateTimeOffset();
        var until = signal.GetProperty("until").GetDateTimeOffset();
        Assert.Equal(DoorSettings.DefaultRefusalSpikeMinutes, (int)Math.Round((until - since).TotalMinutes));
    }

    /// <summary>One short of the club's threshold is not a spike. The number is the club's.</summary>
    [SkippableFact]
    public async Task A_run_one_short_of_the_clubs_threshold_raises_nothing()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(
            factory, "ovnospike",
            """{"slice_minutes":15,"grace_window_minutes":5,"timezone":"UTC","door_refusal_spike_count":5}""");
        var doorId = await club.AddDoorAsync(factory, "gate-ov0009", "side-door");
        var now = DateTimeOffset.UtcNow;

        for (var i = 0; i < 4; i++)
        {
            await club.WriteRowAsync(
                factory, doorId, $"{DeviceGateEndpoint.DeniedActionPrefix}too_early",
                now.AddMinutes(-(i + 1)), reason: "too_early");
        }

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(DoorsPath);
        Assert.Empty(DoorNamed(body, "gate-ov0009").GetProperty("signals").EnumerateArray());
    }

    /// <summary>
    /// Refusals older than the club's own window have fallen out of it. The flag is windowed by
    /// construction and disappears on its own — it never says "since Tuesday".
    /// </summary>
    [SkippableFact]
    public async Task Refusals_older_than_the_window_do_not_raise_a_spike()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "ovoldspike", DoorClub.DaytimeSettings());
        var doorId = await club.AddDoorAsync(factory, "gate-ov0010", "side-door");
        var now = DateTimeOffset.UtcNow;

        for (var i = 0; i < DoorSettings.DefaultRefusalSpikeCount + 4; i++)
        {
            await club.WriteRowAsync(
                factory, doorId, $"{DeviceGateEndpoint.DeniedActionPrefix}not_recognised",
                now.AddMinutes(-(DoorSettings.DefaultRefusalSpikeMinutes + i + 1)), reason: "not_recognised");
        }

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(DoorsPath);
        Assert.Empty(DoorNamed(body, "gate-ov0010").GetProperty("signals").EnumerateArray());
    }

    /// <summary>
    /// W1.6's second signal: one credential granted three times in under a minute at one door.
    /// People do not scan again when a door opens.
    /// </summary>
    [SkippableFact]
    public async Task One_credential_granted_three_times_in_a_minute_flags_the_door()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "ovrelease", DoorClub.DaytimeSettings());
        var doorId = await club.AddDoorAsync(factory, "gate-ov0014", "front-door");
        var now = DateTimeOffset.UtcNow;

        for (var i = 0; i < DoorSignals.MayNotBeReleasingGrants; i++)
        {
            await club.WriteRowAsync(
                factory, doorId, DeviceGateEndpoint.OpenedAction, now.AddSeconds(-(i * 10) - 1),
                subjectUserId: club.MemberUserId);
        }

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(DoorsPath);
        var signal = DoorNamed(body, "gate-ov0014").GetProperty("signals").EnumerateArray()
            .Single(s => s.GetProperty("kind").GetString() == DoorSignals.MayNotBeReleasing);

        Assert.Equal(DoorSignals.MayNotBeReleasingGrants, signal.GetProperty("scans").GetInt32());
    }

    /// <summary>Three DIFFERENT people arriving together is a club, not a stuck door.</summary>
    [SkippableFact]
    public async Task Three_different_credentials_in_a_minute_flag_nothing()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "ovcrowd", DoorClub.DaytimeSettings());
        var doorId = await club.AddDoorAsync(factory, "gate-ov0015", "front-door");
        var now = DateTimeOffset.UtcNow;

        await club.WriteRowAsync(factory, doorId, DeviceGateEndpoint.OpenedAction, now.AddSeconds(-1), subjectUserId: club.MemberUserId);
        await club.WriteRowAsync(factory, doorId, DeviceGateEndpoint.OpenedAction, now.AddSeconds(-2), subjectUserId: club.AdminUserId);
        await club.WriteRowAsync(factory, doorId, DeviceGateEndpoint.OpenedAction, now.AddSeconds(-3), fingerprint: "1f4c9ab2");

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(DoorsPath);
        Assert.Empty(DoorNamed(body, "gate-ov0015").GetProperty("signals").EnumerateArray());
    }

    /// <summary>
    /// D4, made structural. The signal is derived from rows that name a member, and the payload
    /// must carry nothing of them: no id, no name, no fingerprint. Serialise the whole thing and
    /// look — a field added later by somebody who has not read the rule fails here.
    /// </summary>
    [SkippableFact]
    public async Task A_signal_payload_carries_no_member_and_no_fingerprint()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "ovprivacy", DoorClub.DaytimeSettings());
        var doorId = await club.AddDoorAsync(factory, "gate-ov0016", "front-door");
        var now = DateTimeOffset.UtcNow;

        for (var i = 0; i < DoorSignals.MayNotBeReleasingGrants; i++)
        {
            await club.WriteRowAsync(
                factory, doorId, DeviceGateEndpoint.OpenedAction, now.AddSeconds(-(i * 10) - 1),
                subjectUserId: club.MemberUserId, fingerprint: "1f4c9ab2");
        }
        for (var i = 0; i < DoorSettings.DefaultRefusalSpikeCount; i++)
        {
            await club.WriteRowAsync(
                factory, doorId, $"{DeviceGateEndpoint.DeniedActionPrefix}not_recognised",
                now.AddMinutes(-(i + 1)), subjectUserId: club.MemberUserId, reason: "not_recognised",
                fingerprint: "1f4c9ab2");
        }

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(DoorsPath);
        var signals = DoorNamed(body, "gate-ov0016").GetProperty("signals");
        Assert.Equal(2, signals.GetArrayLength());

        var text = signals.GetRawText();
        Assert.DoesNotContain(club.MemberUserId.ToString(), text, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("1f4c9ab2", text, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Door Member", text, StringComparison.OrdinalIgnoreCase);
        foreach (var banned in new[] { "member", "fingerprint", "subject", "user", "name", "code" })
        {
            Assert.DoesNotContain(banned, text, StringComparison.OrdinalIgnoreCase);
        }
    }

    /// <summary>The banner's fact, and the thing that makes "reopen all" an undo.</summary>
    [SkippableFact]
    public async Task Shut_all_active_is_false_until_a_fleet_shut_and_true_after_one()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "ovbanner", DoorClub.DaytimeSettings());
        await club.AddDoorAsync(factory, "gate-ov0017", "front-door");
        var client = club.AdminClient(factory);

        var before = await client.GetFromJsonAsync<JsonElement>(DoorsPath);
        Assert.False(before.GetProperty("shut_all_active").GetBoolean());

        await client.PostAsync($"{DoorsPath}/shut-all", null);

        var after = await client.GetFromJsonAsync<JsonElement>(DoorsPath);
        Assert.True(after.GetProperty("shut_all_active").GetBoolean());
    }

    /// <summary>A door individually shut is not a club-wide shut-all, and the banner must not claim one.</summary>
    [SkippableFact]
    public async Task One_door_shut_by_hand_does_not_raise_the_club_wide_banner()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "ovonedoor", DoorClub.DaytimeSettings());
        var doorId = await club.AddDoorAsync(factory, "gate-ov0018", "front-door");
        var client = club.AdminClient(factory);

        await client.PatchAsync(
            $"/api/v1/admin/devices/{doorId}",
            new StringContent("""{"enabled": false}""", System.Text.Encoding.UTF8, "application/json"));

        var body = await client.GetFromJsonAsync<JsonElement>(DoorsPath);
        Assert.False(body.GetProperty("shut_all_active").GetBoolean());
    }

    /// <summary>Tenant isolation, structural — the repo's non-negotiable.</summary>
    [SkippableFact]
    public async Task Another_clubs_doors_and_rows_never_appear_here()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var mine = await DoorClub.SeedAsync(factory, "ovmine", DoorClub.DaytimeSettings());
        var theirs = await DoorClub.SeedAsync(factory, "ovtheirs", DoorClub.DaytimeSettings());
        var myDoor = await mine.AddDoorAsync(factory, "gate-ov0019", "mine");
        var theirDoor = await theirs.AddDoorAsync(factory, "gate-ov0020", "theirs");
        var now = DateTimeOffset.UtcNow;

        await theirs.WriteRowAsync(factory, theirDoor, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-5));

        // The sharpest case: another club's row claiming MY device id. Rows are attributed by
        // a guid inside a jsonb document with no foreign key behind it, so the tenant filter
        // is the only thing standing between the two clubs.
        await theirs.WriteRowAsync(factory, myDoor, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-5));

        var body = await mine.AdminClient(factory).GetFromJsonAsync<JsonElement>(DoorsPath);
        var codes = body.GetProperty("doors").EnumerateArray()
            .Select(d => d.GetProperty("device").GetProperty("device_code").GetString()).ToList();

        Assert.Equal(["gate-ov0019"], codes);
        Assert.Equal(0, DoorNamed(body, "gate-ov0019").GetProperty("today").GetProperty("released").GetInt32());
    }

    [SkippableFact]
    public async Task A_member_cannot_read_the_doors_area()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "ovmember", DoorClub.DaytimeSettings());
        await club.AddDoorAsync(factory, "gate-ov0021", "front-door");

        var res = await club.MemberClient(factory).GetAsync(DoorsPath);
        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
    }
}
