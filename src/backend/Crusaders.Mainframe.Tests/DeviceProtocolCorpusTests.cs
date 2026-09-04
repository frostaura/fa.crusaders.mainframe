using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Security.DeviceAuth;
using Microsoft.Extensions.Configuration;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The server half of the shared device-protocol corpus.
///
/// <para>
/// The firmware has to reproduce the canonical signing string, the HMAC and the key
/// derivation byte for byte, on an 8-bit micro, with a hand-written SHA-256. A
/// disagreement produces a 401 with no diagnostic on a board in an electrical
/// cupboard, and costs a trip to the club to discover. Both sides read
/// <c>src/contracts/device-protocol/http/cases.json</c>; neither can drift without
/// this going red.
/// </para>
///
/// <para>
/// This is not the C# implementation testing itself. The vectors were produced by a
/// third, independent implementation (Python's <c>hashlib</c>/<c>hmac</c>), so this
/// suite failing means C# is wrong — not that the corpus was written to agree with it.
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

    // ---- SHA-256 -----------------------------------------------------------
    //
    // Tested on its own so a broken primitive is diagnosed at the primitive rather
    // than three layers up inside a canonical string. The lengths are chosen around
    // the 64-byte block and the 55/56-byte padding boundary, which is where a
    // hand-written implementation goes wrong.

    [Fact]
    public void Sha256_matches_every_vector()
    {
        var executed = 0;
        foreach (var c in Corpus.GetProperty("sha256").EnumerateArray())
        {
            var actual = Convert.ToHexString(SHA256.HashData(Hex(c, "input_hex"))).ToLowerInvariant();
            Assert.Equal(c.GetProperty("digest").GetString(), actual);
            executed++;
        }

        Assert.Equal(Declared("sha256"), executed);
    }

    // ---- HMAC-SHA256 -------------------------------------------------------
    //
    // Key lengths straddle the 64-byte block: shorter is zero-padded, exactly 64 is
    // used as-is, longer is hashed first. All three paths are separate code.

    [Fact]
    public void Hmac_sha256_matches_every_vector()
    {
        var executed = 0;
        foreach (var c in Corpus.GetProperty("hmac_sha256").EnumerateArray())
        {
            var actual = Convert.ToHexString(
                HMACSHA256.HashData(Hex(c, "key_hex"), Hex(c, "message_hex"))).ToLowerInvariant();

            Assert.Equal(c.GetProperty("mac").GetString(), actual);
            executed++;
        }

        Assert.Equal(Declared("hmac_sha256"), executed);
    }

    // ---- Canonical string and request signature ----------------------------

    [Fact]
    public void Canonical_string_matches_every_vector_byte_for_byte()
    {
        var executed = 0;
        foreach (var c in Corpus.GetProperty("requests").EnumerateArray())
        {
            var body = Hex(c, "body_hex");

            var canonical = DeviceRequestSigner.CanonicalString(
                c.GetProperty("method").GetString()!,
                c.GetProperty("path_and_query").GetString()!,
                c.GetProperty("unix_seconds").GetInt64(),
                c.GetProperty("nonce").GetString()!,
                body);

            // Compared as bytes, not as a string. A canonical string that differs only
            // in encoding compares equal as text and produces a different HMAC.
            Assert.Equal(
                Convert.ToHexString(Hex(c, "canonical_hex")),
                Convert.ToHexString(Encoding.UTF8.GetBytes(canonical)));

            Assert.Equal(
                c.GetProperty("body_sha256").GetString(),
                Convert.ToHexString(SHA256.HashData(body)).ToLowerInvariant());

            executed++;
        }

        Assert.Equal(Declared("requests"), executed);
    }

    [Fact]
    public void Request_signature_matches_every_vector()
    {
        var key = Convert.FromHexString(Corpus.GetProperty("signing_key_hex").GetString()!);
        var executed = 0;

        foreach (var c in Corpus.GetProperty("requests").EnumerateArray())
        {
            var canonical = DeviceRequestSigner.CanonicalString(
                c.GetProperty("method").GetString()!,
                c.GetProperty("path_and_query").GetString()!,
                c.GetProperty("unix_seconds").GetInt64(),
                c.GetProperty("nonce").GetString()!,
                Hex(c, "body_hex"));

            var expected = c.GetProperty("signature").GetString()!;

            Assert.Equal(expected, DeviceRequestSigner.Sign(key, canonical));
            Assert.True(DeviceRequestSigner.Verify(key, canonical, expected));

            executed++;
        }

        Assert.Equal(Declared("requests"), executed);
    }

    // ---- HKDF device-key derivation ----------------------------------------

    /// <summary>
    /// The provisioning path. An admin registers a device, reads the key off the
    /// screen and flashes it; if the firmware ever needs to derive rather than carry
    /// one, it must reach the same 32 bytes. The salt is
    /// <c>Guid.ToByteArray()</c>, whose first three groups are little-endian — a
    /// detail nothing else in the codebase depends on and which a reimplementation
    /// gets wrong by default.
    /// </summary>
    [Fact]
    public void Device_key_derivation_matches_every_vector()
    {
        var executed = 0;

        foreach (var c in Corpus.GetProperty("hkdf").EnumerateArray())
        {
            var master = c.GetProperty("master_utf8").GetString()!;
            var tenantId = Guid.Parse(c.GetProperty("tenant_id").GetString()!);
            var deviceId = Guid.Parse(c.GetProperty("device_id").GetString()!);
            var version = c.GetProperty("key_version").GetInt32();

            // The corpus records the salt and info separately, so a mismatch says which
            // half is wrong instead of only that the key differs.
            Assert.Equal(Convert.ToHexString(Hex(c, "salt_hex")), Convert.ToHexString(tenantId.ToByteArray()));
            Assert.Equal(c.GetProperty("info_utf8").GetString(), $"crusaders-device:{deviceId:D}:v{version}");

            var deriver = new DeviceKeyDeriver(new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?> { ["Devices:MasterKey"] = master })
                .Build());

            Assert.Equal(
                c.GetProperty("key_hex").GetString(),
                Convert.ToHexString(deriver.Derive(tenantId, deviceId, version)).ToLowerInvariant());

            Assert.Equal(
                c.GetProperty("key_base64url").GetString(),
                deriver.DeriveEncoded(tenantId, deviceId, version));

            executed++;
        }

        Assert.Equal(Declared("hkdf"), executed);
    }

    // ---- Response clock seeds ----------------------------------------------

    /// <summary>
    /// The other direction of the wire. The <c>requests</c> section is what the
    /// firmware signs; these are the responses it reads — the provision body (the
    /// first clock seed a fresh board ever sees), the Device-scheme 401 body (how a
    /// skewed box recovers without reprovisioning), the activation answers it puts on
    /// its relay timer, and the replayed walk-up grant. Every body must parse as JSON,
    /// carry <c>server_unix</c>, and carry every field its <c>expect</c> declares with
    /// the declared value; the live serializers are held to the same keys by the HTTP
    /// tests in <c>ProvisioningHttpTests</c>, <c>DeviceAuthHttpTests</c> and
    /// <c>DeviceEventHttpTests</c>.
    /// </summary>
    [Fact]
    public void Response_bodies_carry_the_declared_server_unix()
    {
        var executed = 0;
        foreach (var c in Corpus.GetProperty("responses").EnumerateArray())
        {
            var bytes = Hex(c, "body_hex");
            using var body = JsonDocument.Parse(bytes);
            var expect = c.GetProperty("expect");
            var id = c.GetProperty("id").GetString();

            // server_unix is mandatory on every response the box reads: it is the one
            // field a clockless board cannot do without.
            Assert.Equal(
                expect.GetProperty("server_unix").GetInt64(),
                body.RootElement.GetProperty("server_unix").GetInt64());

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
        foreach (var c in Corpus.GetProperty("responses").EnumerateArray())
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

    // ---- Clock skew --------------------------------------------------------

    /// <summary>
    /// The two-sided skew invariant. The server refuses a signature drifted past
    /// <see cref="DeviceVerifier.ClockSkew"/>; the firmware judges a 401-with-time to
    /// be a clock problem only when the correction it measures exceeds its own local
    /// threshold, which must sit strictly BELOW the server's window — at or above it,
    /// a board drifted between the two reads a healthy credential as revoked and
    /// reprovisions. The corpus pins both numbers; this asserts the server half, the
    /// firmware's bridge suite asserts its half, and both check the inequality.
    /// </summary>
    [Fact]
    public void Server_clock_skew_matches_the_corpus_and_the_firmware_tolerance_sits_inside_it()
    {
        var clock = Corpus.GetProperty("clock");
        var serverSkew = clock.GetProperty("server_skew_seconds").GetInt64();
        var clientTolerance = clock.GetProperty("client_skew_tolerance_seconds").GetInt64();

        Assert.Equal(serverSkew, (long)DeviceVerifier.ClockSkew.TotalSeconds);
        Assert.True(clientTolerance < serverSkew,
            $"Firmware skew tolerance ({clientTolerance}s) must be strictly below the server window ({serverSkew}s).");
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
