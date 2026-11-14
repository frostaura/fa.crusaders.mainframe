using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Endpoints;

namespace Crusaders.Mainframe.Tests;

public abstract partial class AdminSettingsHttpTests
{
    /// <summary>
    /// Pass 2: a key the PUT bound under its snake_case spelling only was silently dropped when a
    /// client sent it camelCase — <c>{"saved": true}</c> and nothing changed. Every snake-only key
    /// now binds under both spellings (<see cref="SettingsSpelling"/>), and two spellings that
    /// disagree in one body are refused rather than one silently winning.
    /// </summary>
    public sealed class Spelling(PostgresFixture pg) : AdminSettingsHttpTests(pg), IClassFixture<PostgresFixture>
    {
        [SkippableTheory]
        [InlineData("lcdRevertSeconds", "lcd_revert_seconds", 10, 20)]
        [InlineData("lcdChoiceSeconds", "lcd_choice_seconds", 20, 30)]
        [InlineData("scanMemorySeconds", "scan_memory_seconds", 30, 120)]
        [InlineData("clockTrustMinutes", "clock_trust_minutes", 90, 240)]
        [InlineData("deviceFaultMaxPerHour", "device_fault_max_per_hour", 20, 45)]
        [InlineData("faultSpikeCount", "fault_spike_count", 5, 9)]
        public async Task A_snake_only_key_sent_camelCase_is_saved(string field, string wireKey, int documentedDefault, int chosen)
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory);
            var client = AdminClient(factory, seeded);
            Assert.Equal(documentedDefault, (await client.GetFromJsonAsync<JsonElement>(SettingsPath)).GetProperty(wireKey).GetInt32());

            var body = Baseline();
            body[field] = chosen;
            Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync(SettingsPath, body)).StatusCode);

            Assert.Equal(chosen, (await client.GetFromJsonAsync<JsonElement>(SettingsPath)).GetProperty(wireKey).GetInt32());
        }

        [SkippableFact]
        public async Task A_boolean_snake_only_key_sent_camelCase_is_saved()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory);
            var client = AdminClient(factory, seeded);
            Assert.True((await client.GetFromJsonAsync<JsonElement>(SettingsPath)).GetProperty("device_fault_reporting").GetBoolean());

            var body = Baseline();
            body["deviceFaultReporting"] = false;
            Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync(SettingsPath, body)).StatusCode);

            Assert.False((await client.GetFromJsonAsync<JsonElement>(SettingsPath)).GetProperty("device_fault_reporting").GetBoolean());
        }

        [SkippableFact]
        public async Task Both_spellings_agreeing_save_once_and_disagreeing_are_refused()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory);
            var client = AdminClient(factory, seeded);

            var agree = Baseline();
            agree["lcdRevertSeconds"] = 15;
            agree["lcd_revert_seconds"] = 15;
            Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync(SettingsPath, agree)).StatusCode);
            Assert.Equal(15, (await client.GetFromJsonAsync<JsonElement>(SettingsPath)).GetProperty("lcd_revert_seconds").GetInt32());

            var disagree = Baseline();
            disagree["lcdRevertSeconds"] = 25;
            disagree["lcd_revert_seconds"] = 12;
            var refused = await client.PutAsJsonAsync(SettingsPath, disagree);
            Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
            var why = await refused.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal(SettingsSpelling.SpelledTwice, why.GetProperty("error").GetString());
            Assert.Equal("lcd_revert_seconds", why.GetProperty("key").GetString());
            Assert.Equal(15, (await client.GetFromJsonAsync<JsonElement>(SettingsPath)).GetProperty("lcd_revert_seconds").GetInt32());
        }

        [SkippableFact]
        public async Task A_camelCase_value_out_of_range_is_refused_as_the_snake_one_is()
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            await using var factory = CreateFactory();
            var seeded = await SeedAsync(factory);
            var client = AdminClient(factory, seeded);

            var body = Baseline();
            body["deviceFaultMaxPerHour"] = 1000;
            var refused = await client.PutAsJsonAsync(SettingsPath, body);
            Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
            Assert.Equal("device_fault_max_per_hour_out_of_range",
                (await refused.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());

            var wrongKind = Baseline();
            wrongKind["lcdCardSeconds"] = "soon";
            var bad = await client.PutAsJsonAsync(SettingsPath, wrongKind);
            Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
            Assert.Equal("lcd_card_seconds_invalid", (await bad.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());
        }
    }
}

/// <summary>The spelling table itself, read off the record: no Postgres needed.</summary>
public sealed class SettingsSpellingTests
{
    [Fact]
    public void Every_snake_only_key_has_a_camel_spelling_and_twinned_keys_are_left_alone()
    {
        Assert.True(SettingsSpelling.SnakeOnlyKeyCount >= 40, $"only {SettingsSpelling.SnakeOnlyKeyCount} snake-only keys found");
        Assert.Equal("lcdRevertSeconds", SettingsSpelling.CamelOf("lcd_revert_seconds"));
        Assert.Equal("realtimePollSecondsControlBoard", SettingsSpelling.CamelOf("realtime_poll_seconds_control_board"));

        // gate_unlock_seconds already binds under gateUnlockSeconds: adopting it would double-read it.
        var twinned = new UpdateSettingsRequest(SliceMinutes: 15) { Extra = new() { ["gateUnlockSeconds"] = JsonSerializer.SerializeToElement(9) } };
        var (same, refusal) = SettingsSpelling.Adopt(twinned);
        Assert.Null(refusal);
        Assert.Same(twinned, same);

        var snakeOnly = new UpdateSettingsRequest(SliceMinutes: 15) { Extra = new() { ["LCDREVERTSECONDS"] = JsonSerializer.SerializeToElement(9) } };
        var (adopted, none) = SettingsSpelling.Adopt(snakeOnly);
        Assert.Null(none);
        Assert.Equal(9, adopted.LcdRevertSeconds);
        Assert.Null(snakeOnly.LcdRevertSeconds);
    }
}
