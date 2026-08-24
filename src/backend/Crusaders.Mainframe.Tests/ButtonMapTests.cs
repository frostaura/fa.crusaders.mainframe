using System.Text.Json;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The button map: what each of a court box's eight buttons does.
///
/// <para>
/// The wiring is fixed — the box is screwed into a cupboard and the club is not
/// rewiring it — but the <i>meaning</i> is a decision they change their mind about.
/// So the index is always the physical button and the action is a setting, which is
/// what lets an admin swap courts A and C from a browser instead of sending somebody
/// with a laptop.
/// </para>
///
/// <para>
/// The governing asymmetry: <b>lenient on read, strict on write.</b> A settings
/// document somebody hand-edited into nonsense must not stop every court box in the
/// club from working, and the write path is the one moment an admin is standing
/// there to be told what is wrong.
/// </para>
/// </summary>
public class ButtonMapTests
{
    private static JsonElement Settings(string json) => JsonDocument.Parse(json).RootElement.Clone();

    [Fact]
    public void The_default_map_is_what_the_hand_built_box_already_did()
    {
        var map = ButtonMap.Default();

        // Courts A-D then 15/30/45/60. A different default would silently change the
        // behaviour of every box in the club on the first deploy.
        Assert.Equal(
            new[] { "court:A", "court:B", "court:C", "court:D", "minutes:15", "minutes:30", "minutes:45", "minutes:60" },
            map.ToWire());
    }

    [Fact]
    public void An_absent_setting_falls_back_to_the_default()
    {
        var map = ButtonMap.FromSettings(Settings("""{"slice_minutes":15}"""));
        Assert.Equal(ButtonMap.Default().ToWire(), map.ToWire());
    }

    [Theory]
    [InlineData("""{"button_map":"not-an-array"}""")]
    [InlineData("""{"button_map":[1,2,3,4,5,6,7,8]}""")]
    [InlineData("""{"button_map":["court:A","court:B"]}""")]
    [InlineData("""{"button_map":["court:Z","court:B","court:C","court:D","minutes:15","minutes:30","minutes:45","minutes:60"]}""")]
    public void A_broken_setting_falls_back_rather_than_bricking_every_box(string json)
    {
        // Read is deliberately lenient. A box that cannot parse the map has nobody to
        // ask; refusing to work would take four courts offline over a typo.
        var map = ButtonMap.FromSettings(Settings(json));
        Assert.Equal(ButtonMap.Default().ToWire(), map.ToWire());
    }

    [Fact]
    public void A_valid_map_round_trips_through_the_wire_form()
    {
        var wire = new[] { "court:D", "court:C", "court:B", "court:A", "minutes:20", "off", "none", "minutes:90" };
        var map = ButtonMap.FromSettings(Settings($$"""{"button_map":{{JsonSerializer.Serialize(wire)}}}"""));

        Assert.Equal(wire, map.ToWire());

        // Position 0 is the button on pin 22 whatever it now does — that is the whole
        // point of the index being physical.
        Assert.Equal(3, Assert.IsType<ButtonAction.SelectCourt>(map.Actions[0]).CourtIndex);
        Assert.Equal(20, Assert.IsType<ButtonAction.GrantMinutes>(map.Actions[4]).Minutes);
        Assert.IsType<ButtonAction.TurnOff>(map.Actions[5]);
        Assert.IsType<ButtonAction.None>(map.Actions[6]);
    }

    [Fact]
    public void Parsing_is_case_and_whitespace_tolerant()
    {
        var wire = new[] { " Court:a ", "COURT:B", "court:c", "court:D", "Minutes: 15 ", "OFF", "None", "minutes:60" };
        Assert.True(ButtonMap.TryParse(wire, out var map, out var error), error);
        Assert.Equal(0, Assert.IsType<ButtonAction.SelectCourt>(map!.Actions[0]).CourtIndex);
        Assert.IsType<ButtonAction.TurnOff>(map.Actions[5]);
    }

    [Theory]
    [InlineData("court:E", "court must be A, B, C or D")]
    [InlineData("minutes:0", "minutes must be between 1 and 240")]
    [InlineData("minutes:241", "minutes must be between 1 and 240")]
    [InlineData("minutes:-5", "minutes must be between 1 and 240")]
    [InlineData("minutes:abc", "minutes must be between 1 and 240")]
    [InlineData("explode", "expected court:<A-D>, minutes:<n>, off or none")]
    public void The_write_path_names_the_button_and_the_problem(string bad, string expectedReason)
    {
        var wire = new List<string> { "court:A", "court:B", "court:C", "court:D", "minutes:15", "minutes:30", "minutes:45", "minutes:60" };
        wire[2] = bad;

        Assert.False(ButtonMap.TryParse(wire, out _, out var error));

        // The admin is looking at eight boxes on a screen. "invalid" tells them nothing;
        // "button 3: court must be A, B, C or D" tells them where to look and what to type.
        Assert.NotNull(error);
        Assert.Contains("button 3", error);
        Assert.Contains(expectedReason, error);
    }

    [Fact]
    public void A_map_that_cannot_start_or_finish_a_walk_up_is_refused()
    {
        var noCourt = new[] { "minutes:15", "minutes:30", "minutes:45", "minutes:60", "off", "none", "none", "none" };
        Assert.False(ButtonMap.TryParse(noCourt, out _, out var courtError));
        Assert.Contains("select a court", courtError);

        var noMinutes = new[] { "court:A", "court:B", "court:C", "court:D", "off", "none", "none", "none" };
        Assert.False(ButtonMap.TryParse(noMinutes, out _, out var minutesError));
        Assert.Contains("grant minutes", minutesError);
    }

    [Fact]
    public void A_map_of_the_wrong_length_is_refused_by_count()
    {
        // Eight buttons are soldered to the board. A map of seven or nine is an edit
        // that lost or gained a row, and either way half the panel would be undefined.
        Assert.False(ButtonMap.TryParse(new[] { "court:A" }, out _, out var error));
        Assert.Contains("exactly 8 entries", error);
    }

    // ---- the shared corpus ----------------------------------------------
    //
    // Both implementations of this grammar read the same file. The API validates a
    // proposed map and the firmware parses the one it is handed; neither can see the
    // other's source, and the failure they would produce is silent — a token one side
    // accepts and the other ignores leaves a button that still does what it did before
    // an admin changed it, with nothing anywhere saying so.
    //
    // This already earned its place: the corpus' " court:A " case failed on the C++
    // side, because C# trims both ends and the firmware only skipped the leading space.
    // Without the corpus that would have shipped as one dead button per club that ever
    // hand-edited a settings row.

    private sealed record ActionCase(string Wire, bool Valid, string? Kind, int? Court, int? Minutes);
    private sealed record MapCase(string Name, string[] Wire, bool Valid);

    private static JsonElement Corpus()
    {
        // Walk upward: the corpus lives outside both src/backend and src/iot so that
        // neither side reaches into the other's tree, and the test runner's working
        // directory is the bin folder.
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var candidate = Path.Combine(dir.FullName, "src", "contracts", "device-protocol", "buttonmap", "cases.json");
            if (File.Exists(candidate)) return JsonDocument.Parse(File.ReadAllText(candidate)).RootElement.Clone();
            dir = dir.Parent;
        }

        // Loud, never skipped. A corpus test that quietly does not run is exactly the
        // failure mode the corpus exists to prevent.
        throw new FileNotFoundException("button-map corpus not found above " + AppContext.BaseDirectory);
    }

    public static TheoryData<string> ActionWires()
    {
        var data = new TheoryData<string>();
        foreach (var c in Corpus().GetProperty("actions").EnumerateArray())
        {
            data.Add(c.GetProperty("wire").GetString()!);
        }
        return data;
    }

    [Theory]
    [MemberData(nameof(ActionWires))]
    public void Every_corpus_token_parses_as_the_corpus_says(string wire)
    {
        var expected = Corpus().GetProperty("actions").EnumerateArray()
            .First(c => c.GetProperty("wire").GetString() == wire);

        // One entry of an otherwise-valid map, so only the token under test decides.
        var map = new[] { "court:A", "court:B", "court:C", "court:D", "minutes:15", "minutes:30", "minutes:45", wire };
        var parsed = ButtonMap.TryParse(map, out var result, out var error);

        var shouldBeValid = expected.GetProperty("valid").GetBoolean();
        Assert.Equal(shouldBeValid, parsed);
        if (!shouldBeValid)
        {
            Assert.NotNull(error);
            return;
        }

        var action = result!.Actions[7];
        switch (expected.GetProperty("kind").GetString())
        {
            case "none":
                Assert.IsType<ButtonAction.None>(action);
                break;
            case "off":
                Assert.IsType<ButtonAction.TurnOff>(action);
                break;
            case "court":
                Assert.Equal(expected.GetProperty("court").GetInt32(), Assert.IsType<ButtonAction.SelectCourt>(action).CourtIndex);
                break;
            case "minutes":
                Assert.Equal(expected.GetProperty("minutes").GetInt32(), Assert.IsType<ButtonAction.GrantMinutes>(action).Minutes);
                break;
            default:
                Assert.Fail("corpus names a kind this build does not know");
                break;
        }
    }

    public static TheoryData<string> MapNames()
    {
        var data = new TheoryData<string>();
        foreach (var c in Corpus().GetProperty("maps").EnumerateArray())
        {
            data.Add(c.GetProperty("name").GetString()!);
        }
        return data;
    }

    [Theory]
    [MemberData(nameof(MapNames))]
    public void Every_corpus_map_is_accepted_or_refused_as_the_corpus_says(string name)
    {
        var expected = Corpus().GetProperty("maps").EnumerateArray()
            .First(c => c.GetProperty("name").GetString() == name);

        var wire = expected.GetProperty("wire").EnumerateArray().Select(e => e.GetString() ?? "").ToArray();
        Assert.Equal(expected.GetProperty("valid").GetBoolean(), ButtonMap.TryParse(wire, out _, out _));
    }

    [Fact]
    public void The_corpus_pins_the_limits_this_build_enforces()
    {
        var corpus = Corpus();
        // If the corpus and the code disagree about the cap, every "minutes:241" case
        // is testing the wrong boundary on one side or the other.
        Assert.Equal(ButtonMap.MaxGrantMinutes, corpus.GetProperty("max_grant_minutes").GetInt32());
        Assert.Equal(ButtonMap.ButtonCount, corpus.GetProperty("button_count").GetInt32());
    }

    [Fact]
    public void The_same_action_may_appear_on_several_buttons()
    {
        // Not a mistake to guard against: a club with two courts may reasonably put
        // "45 minutes" on two buttons and leave the rest as none.
        var wire = new[] { "court:A", "court:A", "minutes:45", "minutes:45", "none", "none", "none", "none" };
        Assert.True(ButtonMap.TryParse(wire, out _, out var error), error);
    }
}
