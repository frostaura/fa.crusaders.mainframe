using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;
using Microsoft.Extensions.Configuration;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Which firmware a given box should be running.
///
/// <para>
/// The catalogue is <b>deployment configuration, not a tenant setting</b>. A firmware
/// build belongs to this deployment of the product, not to a squash club: every tenant
/// on an instance runs the same images, and asking each club to maintain its own list
/// would mean a fix reaching some clubs and not others depending on who last edited a
/// JSON blob. Per-club and per-box control lives where it belongs instead — the
/// channel and the pin on the device row.
/// </para>
/// </summary>
public class OtaCatalogueTests
{
    private static OtaCatalogue Catalogue(params (string Key, string Value)[] settings)
        => new(new ConfigurationBuilder()
            .AddInMemoryCollection(settings.ToDictionary(s => s.Key, s => (string?)s.Value))
            .Build());

    private static Device Box(OtaChannel channel = OtaChannel.Stable, string? pinned = null) => new()
    {
        TenantId = Guid.NewGuid(),
        DeviceCode = "court-box-1",
        Name = "Court 1 box",
        OtaChannel = channel,
        PinnedVersion = pinned,
    };

    private static (string, string)[] Stable(string version = "1.2.0") =>
    [
        ("Ota:Stable:Version", version),
        ("Ota:Stable:Url", $"https://fw.example/{version}.bin"),
        ("Ota:Stable:SizeBytes", "328192"),
    ];

    [Fact]
    public void An_instance_with_no_published_firmware_offers_nothing()
    {
        // The default, and the correct behaviour for a deployment nobody has published
        // firmware for. A catalogue that defaulted to pointing somewhere is how a box
        // ends up fetching an image nobody meant it to.
        Assert.Null(Catalogue().For(Box()));
    }

    [Fact]
    public void A_stable_box_gets_the_promoted_release()
    {
        var release = Catalogue(Stable()).For(Box());
        Assert.NotNull(release);
        Assert.Equal("1.2.0", release!.Version);
        Assert.Equal(328192, release.SizeBytes);
    }

    [Theory]
    [InlineData("Ota:Stable:Version")]
    [InlineData("Ota:Stable:Url")]
    [InlineData("Ota:Stable:SizeBytes")]
    public void A_half_configured_release_is_treated_as_no_release(string missing)
    {
        // Offered-and-refused by every box in the fleet is worse than not offered:
        // it looks like the update is stuck rather than like nothing was published.
        var settings = Stable().Where(s => s.Item1 != missing).ToArray();
        Assert.Null(Catalogue(settings).For(Box()));
    }

    [Fact]
    public void A_canary_box_falls_back_to_stable_rather_than_being_stranded()
    {
        // A deployment that has not published a canary build should leave its canary
        // boxes on the promoted one, not leave them without updates entirely.
        var release = Catalogue(Stable()).For(Box(OtaChannel.Canary));
        Assert.Equal("1.2.0", release?.Version);
    }

    [Fact]
    public void A_canary_box_takes_the_canary_build_when_there_is_one()
    {
        var settings = Stable().Concat(new[]
        {
            ("Ota:Canary:Version", "1.3.0-canary"),
            ("Ota:Canary:Url", "https://fw.example/canary.bin"),
            ("Ota:Canary:SizeBytes", "330000"),
        }).ToArray();

        Assert.Equal("1.3.0-canary", Catalogue(settings).For(Box(OtaChannel.Canary))?.Version);
        // ...and the rest of the fleet is untouched, which is the whole point of one
        // box going first.
        Assert.Equal("1.2.0", Catalogue(settings).For(Box())?.Version);
    }

    [Fact]
    public void A_pinned_box_stays_pinned_even_when_the_pin_is_older()
    {
        // The point of pinning: a club holding one court on a build they trust while a
        // regression is investigated must not have it dragged forward by the next
        // heartbeat.
        var settings = Stable("2.0.0").Concat(new[]
        {
            ("Ota:Versions:1.1.0:Version", "1.1.0"),
            ("Ota:Versions:1.1.0:Url", "https://fw.example/1.1.0.bin"),
            ("Ota:Versions:1.1.0:SizeBytes", "320000"),
        }).ToArray();

        Assert.Equal("1.1.0", Catalogue(settings).For(Box(OtaChannel.Pinned, "1.1.0"))?.Version);
    }

    [Fact]
    public void A_pin_naming_the_promoted_version_needs_no_second_entry()
    {
        Assert.Equal("1.2.0", Catalogue(Stable()).For(Box(OtaChannel.Pinned, "1.2.0"))?.Version);
    }

    [Fact]
    public void A_pin_to_something_unpublished_offers_nothing_rather_than_something_else()
    {
        // Silently promoting a box whose pin cannot be honoured would defeat the pin at
        // exactly the moment it mattered.
        Assert.Null(Catalogue(Stable()).For(Box(OtaChannel.Pinned, "9.9.9")));
        Assert.Null(Catalogue(Stable()).For(Box(OtaChannel.Pinned, null)));
    }
}
