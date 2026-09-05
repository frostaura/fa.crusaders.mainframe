using System.Text.Json;
using Crusaders.Mainframe.Api.Endpoints;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The server half of the shared device-protocol corpus.
///
/// <para>
/// The firmware has to read the heartbeat response — its roster in particular — on an
/// 8-bit micro, out of a fixed buffer, with a hand-written JSON scan. A disagreement
/// produces a box that silently refuses every scan in a cupboard, and costs a trip to the
/// club to discover. Both sides read
/// <c>src/contracts/device-protocol/http/cases.json</c>; neither can drift without this
/// going red.
/// </para>
///
/// <para>
/// The signing, key-derivation and clock-skew halves of this suite are gone with the HMAC
/// device scheme: there is no canonical string to reproduce, no per-device key to derive
/// and no skew window to sit inside. What is left is the shape of the bodies, which is the
/// part that was always the firmware's real problem.
/// </para>
/// </summary>
public class DeviceProtocolCorpusTests
{
    private static readonly JsonElement Corpus = LoadCorpus();
    private static readonly JsonElement Manifest = LoadManifest();

    /// <summary>
    /// Walks up from the test binary to the repository root. The corpus deliberately
    /// lives outside both <c>src/backend</c> and <c>src/iot</c> — under either one, the
    /// other side would be reaching into its counterpart's tree.
    /// </summary>
    private static string ContractRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var candidate = Path.Combine(dir.FullName, "src", "contracts", "device-protocol", "http");
            if (Directory.Exists(candidate)) return candidate;
            dir = dir.Parent;
        }

        throw new DirectoryNotFoundException(
            "src/contracts/device-protocol/http was not found above the test binary. " +
            "The corpus is the only thing keeping the firmware and the server in agreement; " +
            "a missing corpus must fail loudly rather than skip.");
    }

    private static JsonElement LoadCorpus() =>
        JsonDocument.Parse(File.ReadAllText(Path.Combine(ContractRoot(), "cases.json"))).RootElement;

    private static JsonElement LoadManifest() =>
        JsonDocument.Parse(File.ReadAllText(Path.Combine(ContractRoot(), "manifest.json"))).RootElement;

    private static int Declared(string section) =>
        Manifest.GetProperty("case_count").GetProperty(section).GetInt32();

    private static byte[] Hex(JsonElement e, string prop) => Convert.FromHexString(e.GetProperty(prop).GetString()!);

    private static IEnumerable<JsonElement> Section(string name) =>
        Corpus.TryGetProperty(name, out var section) && section.ValueKind == JsonValueKind.Array
            ? section.EnumerateArray()
            : [];

    // ---- Requests ----------------------------------------------------------

    /// <summary>
    /// What a box sends. The whole of the request contract is now two things — the club
    /// key in <c>Authorization: Bearer</c> and the board's MAC in the body — so that is
    /// what is asserted, wherever in a vector those two appear.
    ///
    /// <para>
    /// The MAC must be exactly what <c>DeviceRegistryService.NormaliseMacAddress</c>
    /// produces, because that is what the row is looked up by: a vector pinning
    /// <c>5C:CF:7F:1A:2B:3C</c> would be a firmware that registers a second row for a board
    /// that already has one.
    /// </para>
    /// </summary>
    [Fact]
    public void Request_vectors_pin_the_bearer_header_and_the_mac()
    {
        var sawBearer = false;
        var sawMac = false;

        foreach (var c in Section("requests"))
        {
            foreach (var property in c.EnumerateObject())
            {
                if (property.Value.ValueKind != JsonValueKind.String) continue;
                var value = property.Value.GetString()!;
                if (!value.StartsWith("Bearer ", StringComparison.Ordinal)) continue;

                Assert.True(value.Length > "Bearer ".Length, $"'{property.Name}' is a bearer header with no key in it.");
                sawBearer = true;
            }

            if (!c.TryGetProperty("body_hex", out var bodyHex) || bodyHex.GetString() is not { Length: > 0 }) continue;

            using var body = JsonDocument.Parse(Hex(c, "body_hex"));
            if (body.RootElement.ValueKind != JsonValueKind.Object) continue;
            if (!body.RootElement.TryGetProperty("mac", out var mac)) continue;

            var text = mac.GetString();
            Assert.Equal(text, Crusaders.Mainframe.Api.Services.DeviceRegistryService.NormaliseMacAddress(text));
            sawMac = true;
        }

        Assert.True(sawBearer, "No request vector carries an Authorization: Bearer header; the device credential is unpinned.");
        Assert.True(sawMac, "No request vector carries a `mac` in its body; device identity is unpinned.");
    }

    // ---- Response bodies ---------------------------------------------------

    /// <summary>
    /// The other direction of the wire: the bodies the firmware reads. Every body must
    /// parse as JSON and carry every field its <c>expect</c> declares with the declared
    /// value; the live serializers are held to the same keys by the HTTP tests in
    /// <c>DeviceAuthHttpTests</c> and <c>DeviceEventHttpTests</c>.
    /// </summary>
    [Fact]
    public void Response_bodies_carry_every_field_they_declare()
    {
        var executed = 0;
        foreach (var c in Section("responses"))
        {
            var bytes = Hex(c, "body_hex");
            using var body = JsonDocument.Parse(bytes);
            var expect = c.GetProperty("expect");
            var id = c.GetProperty("id").GetString();

            foreach (var field in expect.EnumerateObject())
            {
                // Not a field of the body but a bound on it: the box reads the whole
                // response into a fixed buffer, and a roster that fills to its cap has to
                // fit alongside everything else the heartbeat carries.
                if (field.Name == MaxBytesKey)
                {
                    Assert.True(bytes.Length <= field.Value.GetInt32(),
                        $"response '{id}' is {bytes.Length} bytes, over its {field.Value.GetInt32()}-byte budget");
                    continue;
                }

                Assert.True(
                    body.RootElement.TryGetProperty(field.Name, out var actual),
                    $"response '{id}' lacks expected field '{field.Name}'");
                Assert.True(
                    JsonElement.DeepEquals(field.Value, actual),
                    $"response '{id}' field '{field.Name}': expected {field.Value.GetRawText()}, got {actual.GetRawText()}");
            }

            executed++;
        }

        Assert.Equal(Declared("responses"), executed);
    }

    /// <summary>
    /// <c>server_unix</c> went with the clock the device scheme no longer keeps. A vector
    /// still carrying it means one side is writing a field the other stopped reading —
    /// which is the exact class of silent disagreement this corpus exists to catch.
    /// </summary>
    [Fact]
    public void No_response_body_still_carries_server_unix()
    {
        foreach (var c in Section("responses"))
        {
            using var body = JsonDocument.Parse(Hex(c, "body_hex"));
            Assert.False(
                body.RootElement.TryGetProperty("server_unix", out _),
                $"response '{c.GetProperty("id").GetString()}' still carries server_unix; the box has no clock to seed.");
        }
    }

    /// <summary>The one <c>expect</c> key that is a bound on the body rather than a field of it.</summary>
    private const string MaxBytesKey = "max_bytes";

    // ---- The roster push -----------------------------------------------------

    /// <summary>
    /// The element grammar the firmware's <c>bridgelogic::parseRosterElement</c> reads:
    /// a Crockford token of at most twenty characters, one relay digit 0–3, a SIGNED
    /// opens_in, an unsigned closes_in. The server-side builder is held to the same
    /// expression in <c>DeviceRosterTests</c>, so the two cannot drift apart silently.
    /// </summary>
    public const string RosterEntryPattern = @"^[0-9A-HJKMNP-TV-Z]{1,20}\|[0-3]\|-?\d+\|\d+$";

    /// <summary>
    /// Every heartbeat vector's roster parses under the contract grammar, is ordered by
    /// opens_in, and is no longer than <see cref="DeviceRosterBuilder.RosterMaxEntries"/>
    /// — and the one vector that fills the roster really does fill it, because a cap
    /// pinned by a vector with three entries is not pinned.
    /// </summary>
    [Fact]
    public void Heartbeat_roster_vectors_match_the_firmware_grammar_and_the_cap()
    {
        var sawFull = false;
        foreach (var c in Section("responses"))
        {
            if (c.GetProperty("kind").GetString() != "heartbeat") continue;

            using var body = JsonDocument.Parse(Hex(c, "body_hex"));
            var roster = body.RootElement.GetProperty("roster").EnumerateArray().Select(e => e.GetString()!).ToList();

            Assert.True(roster.Count <= DeviceRosterBuilder.RosterMaxEntries);
            Assert.All(roster, entry => Assert.Matches(RosterEntryPattern, entry));

            var opensIn = roster.Select(e => long.Parse(e.Split('|')[2])).ToList();
            Assert.Equal(opensIn.OrderBy(x => x), opensIn);

            var courts = body.RootElement.GetProperty("court_numbers").GetArrayLength();
            Assert.All(roster, entry => Assert.InRange(int.Parse(entry.Split('|')[1]), 0, courts - 1));

            sawFull |= roster.Count == DeviceRosterBuilder.RosterMaxEntries;
        }

        Assert.True(sawFull, "no heartbeat vector fills the roster to RosterMaxEntries; the cap is not pinned");
    }

    /// <summary>
    /// The server's limits are the contract's. The cap and the token bound are constants on
    /// the builder because the firmware buffer is sized to them, and a tenant setting cannot
    /// resize a buffer in a cupboard.
    /// </summary>
    [Fact]
    public void Roster_constants_match_the_firmware_buffer()
    {
        Assert.Equal(16, DeviceRosterBuilder.RosterMaxEntries);          // bridgelogic::kMaxRosterEntries
        Assert.Equal(20, DeviceRosterBuilder.MaxTokenLength);            // roster::kMaxTokenLen
        Assert.True(Crusaders.Mainframe.Api.Domain.AccessCode.Length <= DeviceRosterBuilder.MaxTokenLength);
    }

    /// <summary>
    /// The anti-drift assertion itself. A section present in the corpus but absent
    /// from the manifest — or vice versa — means someone added cases without
    /// declaring them, and a side that silently skips what it does not recognise
    /// would still pass every test above.
    /// </summary>
    [Fact]
    public void Every_corpus_section_is_declared_and_non_empty()
    {
        var sections = Corpus.EnumerateObject()
            .Where(p => p.Value.ValueKind == JsonValueKind.Array)
            .Select(p => p.Name)
            .ToList();

        var declared = Manifest.GetProperty("case_count").EnumerateObject().Select(p => p.Name).ToList();

        Assert.Equal(sections.Order(), declared.Order());
        Assert.All(sections, s =>
        {
            Assert.True(Corpus.GetProperty(s).GetArrayLength() > 0, $"Corpus section '{s}' is empty.");
            Assert.Equal(Corpus.GetProperty(s).GetArrayLength(), Declared(s));
        });
    }
}
