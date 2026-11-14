using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests;

/// <summary>The device contract v3 rules that need no database: key priority, the v1 shape, the walk-up cap on buttons.</summary>
public sealed class DeviceV3UnitTests
{
    /// <summary>MCV1-11: 19 characters AND a leading 1 — the firmware's rule; length alone disagreed.</summary>
    [Theory]
    [InlineData("118Y956008441714835", true)]
    [InlineData("218Y956008441714835", false)]
    [InlineData("A18Y956008441714835", false)]
    [InlineData("118Y95600844171483", false)]
    [InlineData(null, false)]
    public void A_v1_shaped_token_is_nineteen_characters_and_a_leading_one(string? token, bool shaped)
    {
        Assert.Equal(shaped, MemberCodeMath.IsV1Shaped(token));
    }

    /// <summary>
    /// MCV1-07 (member-code §5.4): keys are written slot-0 keys of open windows first, then by window
    /// start, slot-1 keys last — so the cap sheds the least-needed — and the owed count is kept, so
    /// the trim is counted rather than silent.
    /// </summary>
    [Fact]
    public void Keys_are_written_in_priority_order_and_the_trim_is_counted()
    {
        var zone = TimeZoneInfo.Utc;
        var now = new DateTimeOffset(2026, 11, 13, 22, 0, 0, TimeSpan.Zero);
        var codes = new MemberCodeService(null!, new Crusaders.Mainframe.Api.Multitenancy.TenantContext(), new Crusaders.Mainframe.Api.Security.MemberCodeMasterKey(new byte[32], false), null!, null!, TimeProvider.System);
        MemberCode Member(int r) => new() { TenantId = Guid.Empty, UserId = Guid.NewGuid(), Ref = r };
        MemberCodeEntry Entry(int r, int opensInMinutes, int minutes) =>
            new("x", [Member(r)], now.AddMinutes(opensInMinutes), now.AddMinutes(opensInMinutes + minutes));

        // Later first in the input; the one already open, and the late one running into tomorrow.
        var entries = new List<MemberCodeEntry> { Entry(0x40003, 90, 30), Entry(0x40001, -10, 60), Entry(0x40002, 30, 240) };
        var sync = MemberCodeHeartbeat.Sync(entries, entitled: true, keyCap: 3, codes, zone, now);

        Assert.Equal(4, sync.Wanted);
        Assert.Equal(3, sync.Keys.Count);
        Assert.Equal(1, sync.Trimmed);
        var parsed = sync.Keys.Select(k => MemberCodeWire.ParseKeyElement(k)!.Value).ToList();
        Assert.Equal([0, 0, 0], parsed.Select(p => p.Slot));
        Assert.Equal(
            [MemberCodeMath.RefText(0x40001), MemberCodeMath.RefText(0x40002), MemberCodeMath.RefText(0x40003)],
            sync.Keys.Select(k => k[..4]));
    }

    /// <summary>FC-8: a button above the walk-up cap is lowered to it; a map with none above it is the same instance.</summary>
    [Fact]
    public void A_map_is_capped_at_the_walk_up_maximum()
    {
        var map = ButtonMap.Default();
        Assert.Equal(["court:A", "court:B", "court:C", "court:D", "minutes:15", "minutes:30", "minutes:30", "minutes:30"], map.CappedAt(30).ToWire());
        Assert.Same(map, map.CappedAt(90));
    }

    /// <summary>The settings bounds the console reads are the bounds every validator enforces — one table, three readers (FA-2, BA-05).</summary>
    [Fact]
    public void Every_device_setting_has_served_bounds()
    {
        var bounds = DeviceSettings.Bounds();
        foreach (var key in DeviceSettings.LegacyInts.Select(s => s.Key).Concat(DeviceSettings.V3Ints.Select(s => s.Key)))
        {
            Assert.True(bounds.ContainsKey(key), $"{key} has no served bounds");
        }
        foreach (var key in new[] { "lcd_layout", "hw_relay_active_level", "hw_lcd_i2c_address", "hw_scanner_baud", "hw_scanner_line_end" })
        {
            Assert.True(bounds.ContainsKey(key), $"{key} has no served values");
        }
        var config = DeviceSettings.HeartbeatConfig(new Device { DeviceCode = "x", Name = "x", MacAddress = "x" }, DefaultView()).ToList();
        Assert.Equal(12 + 5, config.Count);
        // No remote firmware update (device-api.md §7): no probation window is a setting, served or sent.
        Assert.DoesNotContain(config, kv => kv.Key.Contains("_ota_", StringComparison.Ordinal));
        Assert.DoesNotContain(bounds.Keys, k => k.Contains("_ota_", StringComparison.Ordinal));
    }

    private static TenantSettingsView DefaultView() => new(15, 0, 5, 0, 14, "UTC", 0, "16:00-19:00", 0, 7, 0, 1440, 7, ButtonMap.Default());
}
