using System.Text;
using System.Text.Json;
using Crusaders.Mainframe.Api.Security.Discovery;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The server half of the shared discovery corpus.
///
/// <para>
/// Same contract, same reasoning and the same anti-drift assertion as
/// <see cref="DeviceProtocolCorpusTests"/>: the firmware builds these bytes on an ESP8266
/// with a hand-written SHA-256, neither side can see the other's source, and a single byte
/// of disagreement is a board that announces into a void. The vectors were produced by a
/// third, independent implementation, so this suite failing means the C# is wrong — not
/// that the corpus was written to agree with it.
/// </para>
///
/// <para>
/// Discovery adds one thing the HTTP corpus does not have: a set of <b>decode</b> cases,
/// each pinning a specific error identifier. That matters because this parser is fed
/// straight from an unauthenticated UDP socket on a club LAN, where the next datagram is
/// as likely to be a printer as a court box, and "rejected it somehow" is not the same
/// property as "rejected it for the reason the other implementation would".
/// </para>
/// </summary>
public class DiscoveryProtocolCorpusTests
{
    private static readonly JsonElement Corpus = LoadCorpus();
    private static readonly JsonElement Manifest = LoadManifest();

    /// <summary>
    /// Walks up from the test binary to the repository root. The corpus deliberately lives
    /// outside both <c>src/backend</c> and <c>src/iot</c> — under either one, the other side
    /// would be reaching into its counterpart's tree.
    /// </summary>
    private static string ContractRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var candidate = Path.Combine(dir.FullName, "src", "contracts", "device-protocol", "discovery");
            if (Directory.Exists(candidate)) return candidate;
            dir = dir.Parent;
        }

        throw new DirectoryNotFoundException(
            "src/contracts/device-protocol/discovery was not found above the test binary. " +
            "The corpus is the only thing keeping the firmware and the server in agreement; " +
            "a missing corpus must fail loudly rather than skip.");
    }

    private static JsonElement LoadCorpus() =>
        JsonDocument.Parse(File.ReadAllText(Path.Combine(ContractRoot(), "cases.json"))).RootElement;

    private static JsonElement LoadManifest() =>
        JsonDocument.Parse(File.ReadAllText(Path.Combine(ContractRoot(), "manifest.json"))).RootElement;

    private static int Declared(string section) =>
        Manifest.GetProperty("case_count").GetProperty(section).GetInt32();

    private static byte[] SigningKey() =>
        Convert.FromHexString(Corpus.GetProperty("signing_key_hex").GetString()!);

    private static List<KeyValuePair<string, string>> FieldsOf(JsonElement element) =>
        element.GetProperty("fields").EnumerateArray()
            .Select(f => new KeyValuePair<string, string>(
                f.GetProperty("key").GetString()!, f.GetProperty("value").GetString()!))
            .ToList();

    // ---- Encode ------------------------------------------------------------

    /// <summary>
    /// Bytes, the canonical signing string, and the HMAC over it.
    ///
    /// <para>
    /// The wire form is compared as hex rather than as text. Two strings that differ only in
    /// encoding compare equal as text and produce a different checksum and a different
    /// signature, which is precisely the class of bug this corpus exists to catch.
    /// </para>
    /// </summary>
    [Fact]
    public void Encode_matches_every_vector_byte_for_byte()
    {
        var key = SigningKey();
        var executed = 0;

        foreach (var c in Corpus.GetProperty("encode").EnumerateArray())
        {
            var verb = c.GetProperty("verb").GetString()!;
            var fields = FieldsOf(c);

            Assert.Equal(
                Convert.ToHexString(Encoding.UTF8.GetBytes(c.GetProperty("wire").GetString()!)),
                Convert.ToHexString(Encoding.UTF8.GetBytes(DiscoveryBeacon.Encode(verb, fields))));

            Assert.Equal(c.GetProperty("canonical").GetString(), DiscoveryBeacon.Canonical(verb, fields));

            var expectedSignature = fields.FirstOrDefault(f => f.Key == "sig").Value;
            if (expectedSignature is not null)
            {
                Assert.Equal(expectedSignature, DiscoveryBeacon.Sign(key, verb, fields));
                Assert.True(DiscoveryBeacon.VerifySignature(key, new BeaconFrame(verb, fields)));
            }

            executed++;
        }

        Assert.Equal(Declared("encode"), executed);
    }

    // ---- Decode ------------------------------------------------------------

    [Fact]
    public void Decode_matches_every_vector()
    {
        var executed = 0;

        foreach (var c in Corpus.GetProperty("decode").EnumerateArray())
        {
            var id = c.GetProperty("id").GetString();
            var expect = c.GetProperty("expect");
            var result = DiscoveryBeacon.Decode(c.GetProperty("wire").GetString()!);

            if (expect.GetProperty("ok").GetBoolean()) AssertDecoded(id, expect, result);
            else Assert.Equal(expect.GetProperty("error").GetString(), result.Error);

            executed++;
        }

        Assert.Equal(Declared("decode"), executed);
    }

    private static void AssertDecoded(string? id, JsonElement expect, BeaconDecodeResult result)
    {
        Assert.True(result.Ok, $"Case '{id}' should have decoded but failed with '{result.Error}'.");
        Assert.Equal(expect.GetProperty("verb").GetString(), result.Frame!.Verb);

        // Order is asserted, not just membership. Decode must not reorder: the checksum and
        // the wire form both depend on the order the sender chose, and only the canonical
        // form is allowed to sort.
        Assert.Equal(
            FieldsOf(expect).Select(f => $"{f.Key}={f.Value}").ToList(),
            result.Frame.Fields.Select(f => $"{f.Key}={f.Value}").ToList());
    }

    // ---- Claim commitment --------------------------------------------------

    /// <summary>
    /// The commitment is the whole security argument for claiming: the board displays a code
    /// on its own LCD and broadcasts only <c>SHA256(code || ":" || nonce)</c>, so the code is
    /// never on the wire and a fabricated commitment never matches. If the two
    /// implementations truncate differently, or separate with a different byte, every claim
    /// fails with "no board committed to that code" while the board sits there displaying it.
    /// </summary>
    [Fact]
    public void Claim_commitment_matches_every_example()
    {
        var claim = Corpus.GetProperty("claim");

        // Copied into locals so the corpus stays the "expected" side of each assertion. The
        // corpus is the contract; the constants are this implementation's reading of it.
        string alphabet = DiscoveryBeacon.ClaimAlphabet;
        int codeLength = DiscoveryBeacon.ClaimCodeLength;
        int commitmentLength = DiscoveryBeacon.CommitmentHexLength;

        Assert.Equal(claim.GetProperty("alphabet").GetString(), alphabet);
        Assert.Equal(claim.GetProperty("code_length").GetInt32(), codeLength);
        Assert.Equal(claim.GetProperty("commitment_hex_length").GetInt32(), commitmentLength);

        var executed = 0;
        foreach (var c in claim.GetProperty("examples").EnumerateArray())
        {
            var code = c.GetProperty("code").GetString()!;

            Assert.Equal(
                c.GetProperty("commitment").GetString(),
                DiscoveryBeacon.ClaimCommitment(code, c.GetProperty("nonce").GetString()!));

            Assert.True(DiscoveryBeacon.IsWellFormedClaimCode(code));
            executed++;
        }

        Assert.Equal(Declared("claim_examples"), executed);
    }

    /// <summary>
    /// The anti-drift assertion. A section present in the corpus but absent from the
    /// manifest — or the reverse — means someone added cases without declaring them, and a
    /// side that silently skips what it does not recognise would still pass everything above.
    ///
    /// <para>
    /// <c>claim</c> is an object rather than an array, so its examples are declared under
    /// <c>claim_examples</c>. That mapping is spelled out here rather than inferred, because
    /// inferring it is how a section quietly stops being counted.
    /// </para>
    /// </summary>
    [Fact]
    public void Every_corpus_section_is_declared_and_non_empty()
    {
        var sections = Corpus.EnumerateObject()
            .Where(p => p.Value.ValueKind == JsonValueKind.Array)
            .Select(p => p.Name)
            .Concat(["claim_examples"])
            .ToList();

        var declared = Manifest.GetProperty("case_count").EnumerateObject().Select(p => p.Name).ToList();
        Assert.Equal(sections.Order(), declared.Order());

        Assert.Equal(Corpus.GetProperty("encode").GetArrayLength(), Declared("encode"));
        Assert.Equal(Corpus.GetProperty("decode").GetArrayLength(), Declared("decode"));
        Assert.Equal(Corpus.GetProperty("claim").GetProperty("examples").GetArrayLength(), Declared("claim_examples"));

        Assert.All(new[] { "encode", "decode", "claim_examples" }, s => Assert.True(Declared(s) > 0, $"Section '{s}' is empty."));
    }
}
