using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// WIRE-W1 §6 — the five Wave 1 door settings, held to the house rule.
///
/// <para>
/// <b>Both spellings bind, the PUT bounds, and the reader clamps again.</b>
/// <c>door-gate.md</c> §8 argues all three and the cost of the first: this endpoint answers
/// snake_case while .NET binds camelCase, so a client on the wrong convention gets
/// <c>{"saved": true}</c> and no change, which is the silent write
/// <c>Opening_the_settings_page_and_saving_it_changes_nothing</c> exists to prevent. The
/// sharpest of these five is <c>door_log_retention_days</c>: an admin who narrows it from 90
/// days to 30 and is answered "saved" believes the club has stopped holding a record it is
/// still holding.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class DoorSettingsHttpTests
{
    private readonly PostgresFixture _pg;

    public DoorSettingsHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string SettingsPath = "/api/v1/admin/settings/";

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    /// <summary>The keys the PUT requires whatever else is being changed.</summary>
    private const string Required =
        "\"sliceMinutes\":15,\"slicePriceCredits\":8,\"advanceBookingDays\":14,"
        + "\"dayStartMinute\":0,\"dayEndMinute\":1440,\"penaltyPct\":30,"
        + "\"graceWindowMinutes\":5,\"penaltyWindowMinutes\":15";

    private static Task<HttpResponseMessage> PutAsync(HttpClient client, string extra)
        => client.PutAsync(
            SettingsPath,
            new StringContent($"{{{Required},{extra}}}", Encoding.UTF8, "application/json"));

    [SkippableFact]
    public async Task The_five_door_settings_are_served_with_their_documented_defaults()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "dset1", "{}");

        var shown = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(SettingsPath);

        Assert.Equal(DoorSettings.DefaultLogRetentionDays, shown.GetProperty("door_log_retention_days").GetInt32());
        Assert.Equal(DoorSettings.DefaultRefusalSpikeCount, shown.GetProperty("door_refusal_spike_count").GetInt32());
        Assert.Equal(DoorSettings.DefaultRefusalSpikeMinutes, shown.GetProperty("door_refusal_spike_minutes").GetInt32());
        Assert.Equal("", shown.GetProperty("club_contact_phone").GetString());
        Assert.Equal("", shown.GetProperty("club_contact_email").GetString());
    }

    [SkippableTheory]
    [InlineData("doorLogRetentionDays", "door_log_retention_days", "30")]
    [InlineData("door_log_retention_days", "door_log_retention_days", "30")]
    [InlineData("doorRefusalSpikeCount", "door_refusal_spike_count", "12")]
    [InlineData("door_refusal_spike_count", "door_refusal_spike_count", "12")]
    [InlineData("doorRefusalSpikeMinutes", "door_refusal_spike_minutes", "45")]
    [InlineData("door_refusal_spike_minutes", "door_refusal_spike_minutes", "45")]
    public async Task Every_door_number_binds_under_either_spelling(string sent, string read, string value)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, $"dset-{sent}"[..20], "{}");
        var client = club.AdminClient(factory);

        var res = await PutAsync(client, $"\"{sent}\":{value}");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);

        var shown = await client.GetFromJsonAsync<JsonElement>(SettingsPath);
        Assert.Equal(int.Parse(value), shown.GetProperty(read).GetInt32());
    }

    [SkippableTheory]
    [InlineData("clubContactPhone", "club_contact_phone")]
    [InlineData("club_contact_phone", "club_contact_phone")]
    [InlineData("clubContactEmail", "club_contact_email")]
    [InlineData("club_contact_email", "club_contact_email")]
    public async Task Every_contact_string_binds_under_either_spelling(string sent, string read)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, $"dsetc-{sent}"[..20], "{}");
        var client = club.AdminClient(factory);

        var res = await PutAsync(client, $"\"{sent}\":\"  desk@club.test  \"");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);

        var shown = await client.GetFromJsonAsync<JsonElement>(SettingsPath);
        Assert.Equal("desk@club.test", shown.GetProperty(read).GetString());
    }

    [SkippableTheory]
    [InlineData("doorLogRetentionDays", 6, "door_log_retention_days_out_of_range")]
    [InlineData("doorLogRetentionDays", 731, "door_log_retention_days_out_of_range")]
    [InlineData("doorRefusalSpikeCount", 2, "door_refusal_spike_count_out_of_range")]
    [InlineData("doorRefusalSpikeCount", 101, "door_refusal_spike_count_out_of_range")]
    [InlineData("doorRefusalSpikeMinutes", 4, "door_refusal_spike_minutes_out_of_range")]
    [InlineData("doorRefusalSpikeMinutes", 241, "door_refusal_spike_minutes_out_of_range")]
    public async Task A_door_number_outside_its_bounds_is_refused(string key, int value, string error)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, $"dsetb-{key}{value}"[..22], "{}");
        var client = club.AdminClient(factory);

        var res = await PutAsync(client, $"\"{key}\":{value}");

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        var body = await res.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(error, body.GetProperty("error").GetString());
    }

    [SkippableFact]
    public async Task A_contact_longer_than_the_reader_will_show_is_refused()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "dsetlong", "{}");
        var client = club.AdminClient(factory);

        var phone = new string('9', DoorSettings.MaxContactPhoneLength + 1);
        var phoneRes = await PutAsync(client, $"\"clubContactPhone\":\"{phone}\"");
        Assert.Equal(HttpStatusCode.BadRequest, phoneRes.StatusCode);
        Assert.Equal(
            "club_contact_phone_too_long",
            (await phoneRes.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());

        var email = new string('e', DoorSettings.MaxContactEmailLength + 1);
        var emailRes = await PutAsync(client, $"\"clubContactEmail\":\"{email}\"");
        Assert.Equal(HttpStatusCode.BadRequest, emailRes.StatusCode);
        Assert.Equal(
            "club_contact_email_too_long",
            (await emailRes.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());
    }

    /// <summary>A refused save must leave the document exactly as it was.</summary>
    [SkippableFact]
    public async Task A_refused_door_setting_writes_nothing()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "dsetnow", "{}");
        var client = club.AdminClient(factory);

        await PutAsync(client, "\"doorLogRetentionDays\":30");
        await PutAsync(client, "\"doorLogRetentionDays\":9999,\"doorRefusalSpikeCount\":12");

        var shown = await client.GetFromJsonAsync<JsonElement>(SettingsPath);
        Assert.Equal(30, shown.GetProperty("door_log_retention_days").GetInt32());
        Assert.Equal(DoorSettings.DefaultRefusalSpikeCount, shown.GetProperty("door_refusal_spike_count").GetInt32());
    }

    /// <summary>Omitted means unchanged — a save from one screen must not revert another's.</summary>
    [SkippableFact]
    public async Task Omitting_a_door_setting_leaves_it_alone()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "dsetomit", "{}");
        var client = club.AdminClient(factory);

        await PutAsync(client, "\"doorRefusalSpikeCount\":12,\"clubContactPhone\":\"+27 21 555 0100\"");
        await PutAsync(client, "\"doorLogRetentionDays\":30");

        var shown = await client.GetFromJsonAsync<JsonElement>(SettingsPath);
        Assert.Equal(12, shown.GetProperty("door_refusal_spike_count").GetInt32());
        Assert.Equal("+27 21 555 0100", shown.GetProperty("club_contact_phone").GetString());
        Assert.Equal(30, shown.GetProperty("door_log_retention_days").GetInt32());
    }

    /// <summary>An empty string is a real instruction: it is how a club takes a contact down.</summary>
    [SkippableFact]
    public async Task An_empty_contact_clears_it()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "dsetclear", "{}");
        var client = club.AdminClient(factory);

        await PutAsync(client, "\"clubContactPhone\":\"+27 21 555 0100\"");
        await PutAsync(client, "\"clubContactPhone\":\"\"");

        var shown = await client.GetFromJsonAsync<JsonElement>(SettingsPath);
        Assert.Equal("", shown.GetProperty("club_contact_phone").GetString());
    }

    /// <summary>
    /// The house rule's second half: a hand-edited column is not a PUT, so every reader clamps
    /// again. The GET renders the clamped value, so the page cannot report a retention the
    /// worker is not deleting against.
    /// </summary>
    [SkippableTheory]
    [InlineData("""{"door_log_retention_days":1}""", "door_log_retention_days", DoorSettings.MinLogRetentionDays)]
    [InlineData("""{"door_log_retention_days":99999}""", "door_log_retention_days", DoorSettings.MaxLogRetentionDays)]
    [InlineData("""{"door_refusal_spike_count":-4}""", "door_refusal_spike_count", DoorSettings.MinRefusalSpikeCount)]
    [InlineData("""{"door_refusal_spike_minutes":100000}""", "door_refusal_spike_minutes", DoorSettings.MaxRefusalSpikeMinutes)]
    public async Task A_hand_edited_number_is_clamped_on_the_way_out(string stored, string key, int expected)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, $"dsethand{key.Length}", stored);

        var shown = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(SettingsPath);
        Assert.Equal(expected, shown.GetProperty(key).GetInt32());
    }

    /// <summary>A hand-edited contact longer than the bound is cut rather than published whole.</summary>
    [SkippableFact]
    public async Task A_hand_edited_contact_is_cut_to_the_bound_on_the_way_out()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var absurd = new string('7', 4000);
        var club = await DoorClub.SeedAsync(factory, "dsetcut", $$"""{"club_contact_phone":"{{absurd}}"}""");

        var shown = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(SettingsPath);
        Assert.Equal(DoorSettings.MaxContactPhoneLength, shown.GetProperty("club_contact_phone").GetString()!.Length);
    }

    /// <summary>The five keys land in the club's own settings document and nowhere else.</summary>
    [SkippableFact]
    public async Task A_save_never_reaches_another_clubs_settings()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var mine = await DoorClub.SeedAsync(factory, "dsetmine", "{}");
        var theirs = await DoorClub.SeedAsync(factory, "dsettheirs", "{}");

        await PutAsync(mine.AdminClient(factory), "\"doorLogRetentionDays\":30");

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var theirRow = await db.TenantSettings.IgnoreQueryFilters().FirstAsync(s => s.TenantId == theirs.TenantId);
        Assert.DoesNotContain("door_log_retention_days", theirRow.SettingsJson);
    }
}
