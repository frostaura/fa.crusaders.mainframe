using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The settings layer, read the way a HAND-EDITED column reaches it.
///
/// <para>
/// Every number in this product is a <c>tenant_settings</c> key, and the PUT is not the only
/// way one arrives: a club's document can be edited by hand, restored from a backup taken
/// before a bound existed, or written by a migration. So the reader is the last line, not the
/// validator — <c>D2-B16</c> and <c>D2-B18</c> are both the same failure, one failing open and
/// one throwing, and both invisible to a suite whose fixtures only ever go through the PUT.
/// </para>
/// </summary>
public class SettingsHardeningTests
{
    private static async Task<TenantSettingsView> ReadAsync(string settingsJson)
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var row = await db.TenantSettings.FirstAsync(s => s.TenantId == host.Tenant.Id);
        row.SettingsJson = settingsJson;
        await db.SaveChangesAsync();
        return await scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>().GetAsync(default);
    }

    /// <summary>
    /// D2-B18. <c>GetInt32()</c> throws on a number the column can hold and an int cannot, so
    /// one hand-edited document made every request that reads settings a 500 — in a file whose
    /// own comment says a broken document "must not stop every box in the club from working".
    /// </summary>
    [Theory]
    [InlineData("""{"slice_minutes": 15.5}""")]
    [InlineData("""{"slice_minutes": 99999999999}""")]
    [InlineData("""{"slice_minutes": -99999999999}""")]
    public async Task A_number_an_int_cannot_hold_falls_back_instead_of_throwing(string json)
    {
        var view = await ReadAsync(json);
        Assert.Equal(15, view.SliceMinutes);
    }

    /// <summary>The decimal twin, for the same reason — this one prices a court.</summary>
    [Fact]
    public async Task A_decimal_the_column_cannot_hold_falls_back_instead_of_throwing()
    {
        var view = await ReadAsync("""{"slice_price_credits": 1e308}""");
        Assert.Equal(8m, view.DefaultSlicePriceCredits);
    }

    /// <summary>
    /// D2-B16. A stored <c>"19:00-16:00"</c> made <c>inPeak</c> permanently false, so peak
    /// protection was silently off for every Regular member with nothing anywhere saying so.
    /// The reader now refuses an inverted range and falls back to the club's own default
    /// window, which is the fail-CLOSED direction for an access rule.
    /// </summary>
    [Theory]
    [InlineData("19:00-16:00")]
    [InlineData("16:00")]
    [InlineData("")]
    [InlineData("not-a-range")]
    [InlineData("16:00-16:00")]
    public async Task An_unusable_peak_window_falls_back_to_the_default_rather_than_disabling_peak(string stored)
    {
        var view = await ReadAsync(JsonSerializer.Serialize(new Dictionary<string, object> { ["peak_hours"] = stored }));

        var window = view.PeakHours();
        Assert.NotNull(window);
        Assert.Equal(new TimeOnly(16, 0), window!.Value.start);
        Assert.Equal(new TimeOnly(19, 0), window.Value.end);
    }

    /// <summary>A well-formed window is still the club's own.</summary>
    [Fact]
    public async Task A_valid_peak_window_is_honoured()
    {
        var view = await ReadAsync("""{"peak_hours":"17:30-20:00"}""");
        Assert.Equal(new TimeOnly(17, 30), view.PeakHours()!.Value.start);
        Assert.Equal(new TimeOnly(20, 0), view.PeakHours()!.Value.end);
    }

    /// <summary>
    /// Ruling 5 / GOAL item 2: a door's lock is released for fifteen seconds, not three.
    /// Three was long enough to push a door and too short for the member this club actually
    /// has — someone with a bag in each hand and a door that has already re-locked.
    /// </summary>
    [Fact]
    public void The_door_release_default_is_fifteen_seconds()
    {
        Assert.Equal(15, TenantSettingsView.DefaultGateUnlockSeconds);
    }

    /// <summary>And a club with no key set reads fifteen, not the old three.</summary>
    [Fact]
    public async Task A_club_that_has_never_set_a_release_gets_fifteen_seconds()
    {
        var view = await ReadAsync("{}");
        Assert.Equal(15, view.GateUnlockSeconds);
        Assert.Equal(15, GateAccess.UnlockSecondsFor(view));
    }

    /// <summary>
    /// D2-B06's read side. <c>slice_price_credits</c> was touched by none of the validators and
    /// seeds new courts, so a negative one produced a court on which every booking CREDITED the
    /// member. The PUT refuses it now (see <c>AdminSettingsHttpTests</c>) and the reader floors
    /// it, because the PUT is not the only way a number reaches the column.
    /// </summary>
    [Fact]
    public async Task A_negative_stored_slice_price_is_floored_on_read()
    {
        var view = await ReadAsync("""{"slice_price_credits": -500}""");
        Assert.Equal(0m, MoneySettings.SlicePriceCredits(view));
    }

    /// <summary>Every new key in this wave answers its documented default on an empty document.</summary>
    [Fact]
    public async Task The_new_keys_carry_their_documented_defaults()
    {
        var view = await ReadAsync("{}");

        Assert.Equal(4, view.MemberMaxSlotsPerDay);
        Assert.True(view.SameDayCapRelaxation);
        Assert.Equal(120, view.SameDayRelaxationWindowMinutes);
        Assert.False(view.WalkUpHonoursDayCap);
        Assert.True(view.MemberGroupsEnabled);
        Assert.Equal(25, view.SseKeepaliveSeconds);
        Assert.Equal(20, view.RealtimePollSecondsWallet);
    }

    /// <summary>
    /// And a hand-edited value outside those bounds is clamped by the reader rather than
    /// obeyed — the third bullet of D2 §3.2, which exists because of the two failures above.
    /// </summary>
    [Theory]
    [InlineData("""{"member_max_slots_per_day": -3}""", 0)]
    [InlineData("""{"member_max_slots_per_day": 9999}""", 96)]
    public async Task A_hand_edited_slot_cap_is_clamped_on_read(string json, int expected)
    {
        var view = await ReadAsync(json);
        Assert.Equal(expected, BookingLimits.MaxSlotsPerDay(view));
    }
}
