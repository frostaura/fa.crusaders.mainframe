using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace Crusaders.Mainframe.Api.Security.Discovery;

/// <summary>
/// One decoded discovery packet: a verb and its fields, in the order they arrived.
///
/// <para>
/// Fields are kept as an ordered list rather than a dictionary because encode has to
/// reproduce the sender's order byte for byte, while <see cref="DiscoveryBeacon.Canonical"/>
/// sorts independently. Collapsing them into a dictionary on decode would throw away
/// the only thing that lets a round-trip test prove the codec did not silently reorder.
/// </para>
/// </summary>
public sealed record BeaconFrame(string Verb, IReadOnlyList<KeyValuePair<string, string>> Fields)
{
    public string? Get(string key)
    {
        foreach (var f in Fields)
        {
            if (string.Equals(f.Key, key, StringComparison.Ordinal)) return f.Value;
        }

        return null;
    }
}

/// <summary>The decode outcome. Exactly one of <see cref="Frame"/> and <see cref="Error"/> is set.</summary>
public sealed record BeaconDecodeResult(BeaconFrame? Frame, string? Error)
{
    public bool Ok => Frame is not null;

    public static BeaconDecodeResult Fail(string error) => new(null, error);
    public static BeaconDecodeResult Success(BeaconFrame frame) => new(frame, null);
}

/// <summary>
/// The UDP discovery wire format: <c>CRSDR1 &lt;VERB&gt; k=v k=v ...*CC\n</c>.
///
/// <para>
/// Deliberately the same shape as the serial protocol so one mental model covers both
/// links, and deliberately checksummed even though it rides on UDP: the IPv4 UDP
/// checksum is optional and is sometimes transmitted as zero, so a corrupted packet can
/// arrive looking pristine. <c>*CC</c> is not decoration.
/// </para>
///
/// <para>
/// This class is the C# half of <c>src/contracts/device-protocol/discovery/</c>. The
/// firmware builds the same bytes on an ESP8266 with a hand-written SHA-256, and
/// neither side can see the other's source — a single byte of drift in the canonical
/// signing string is a signature that never verifies, on a board in an electrical
/// cupboard, with no diagnostic. Every rule below is pinned by a corpus case.
/// </para>
/// </summary>
public static class DiscoveryBeacon
{
    /// <summary>Magic plus protocol version. A packet not starting with this is dropped without parsing.</summary>
    public const string Magic = "CRSDR1";

    public const string Announce = "ANNOUNCE";
    public const string Offer = "OFFER";

    /// <summary>The protocol version carried in <c>v=</c>. Distinct from the magic, which pins the framing.</summary>
    public const string ProtocolVersion = "1";

    /// <summary>Port 48653, both directions. Fixed by the spec, not configurable per tenant — the firmware hardcodes it.</summary>
    public const int Port = 48653;

    /// <summary>
    /// The claim-code alphabet: no <c>I</c>, <c>O</c>, <c>0</c> or <c>1</c>. Someone reads
    /// this off a 16x2 LCD in an electrical cupboard and types it on a phone.
    /// </summary>
    public const string ClaimAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    public const int ClaimCodeLength = 8;

    /// <summary>Commitment length in hex characters. 64 bits is far beyond a 32^8 code space.</summary>
    public const int CommitmentHexLength = 16;

    // Error identifiers. These are corpus values, not prose — the firmware asserts on the
    // same strings, so they are constants rather than inline literals.
    public const string ErrorBadMagic = "bad_magic";
    public const string ErrorBadChecksum = "bad_checksum";
    public const string ErrorBadFrame = "bad_frame";
    public const string ErrorBadVerb = "bad_verb";
    public const string ErrorDuplicateKey = "duplicate_key";

    private static readonly string[] KnownVerbs = [Announce, Offer];

    private static readonly string Preamble = Magic + " ";

    /// <summary>
    /// Renders a frame, checksum and trailing newline included.
    ///
    /// <para>
    /// Field order is the caller's, not sorted. The wire order is what a receiver sees
    /// and what the corpus pins; sorting belongs only to <see cref="Canonical"/>, and
    /// conflating the two would make the signing string depend on transmission order.
    /// </para>
    /// </summary>
    public static string Encode(string verb, IEnumerable<KeyValuePair<string, string>> fields)
    {
        var body = string.Join(' ', fields.Select(f => $"{f.Key}={f.Value}"));
        return string.Concat(Preamble, verb, " ", body, "*", Checksum(body), "\n");
    }

    /// <summary>
    /// The canonical form for signing: the verb, then every field except <c>sig</c>
    /// sorted by key, joined with <c>\n</c>.
    ///
    /// <para>
    /// Ordinal sort, not culture-aware. A Turkish locale sorts <c>i</c> differently and
    /// would produce a signing string the firmware cannot reproduce. Same discipline as
    /// <c>DeviceRequestSigner</c> and for the same reason: a canonicalisation under which
    /// two different packets share one signing string is a signature-reuse hole.
    /// </para>
    /// </summary>
    public static string Canonical(string verb, IEnumerable<KeyValuePair<string, string>> fields)
    {
        var ordered = fields
            .Where(f => !string.Equals(f.Key, "sig", StringComparison.Ordinal))
            .OrderBy(f => f.Key, StringComparer.Ordinal)
            .Select(f => $"{f.Key}={f.Value}");

        return string.Concat(verb, "\n", string.Join('\n', ordered));
    }

    /// <summary>Lowercase hex HMAC-SHA256 over the canonical form, matching every other signature in the system.</summary>
    public static string Sign(byte[] key, string verb, IEnumerable<KeyValuePair<string, string>> fields)
        => Convert.ToHexString(
            HMACSHA256.HashData(key, Encoding.UTF8.GetBytes(Canonical(verb, fields)))).ToLowerInvariant();

    /// <summary>Constant-time verification. A timing side channel here leaks the signature a byte at a time.</summary>
    public static bool VerifySignature(byte[] key, BeaconFrame frame)
    {
        var presented = frame.Get("sig");
        if (presented is null) return false;

        var expected = Encoding.UTF8.GetBytes(Sign(key, frame.Verb, frame.Fields));
        var actual = Encoding.UTF8.GetBytes(presented);

        return expected.Length == actual.Length && CryptographicOperations.FixedTimeEquals(expected, actual);
    }

    /// <summary>
    /// XOR of every byte of the body, as two <b>uppercase</b> hex digits.
    ///
    /// <para>
    /// Uppercase only, and compared as text rather than parsed: widening the accept set
    /// to lowercase doubles the number of byte strings that pass, which is exactly the
    /// slack a corrupted frame needs. The serial protocol makes the same choice.
    /// </para>
    /// </summary>
    public static string Checksum(string body)
    {
        byte x = 0;
        foreach (var b in Encoding.UTF8.GetBytes(body)) x ^= b;
        return x.ToString("X2", CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// <c>SHA256(code || ":" || nonce)</c>, truncated to 16 lowercase hex characters.
    ///
    /// <para>
    /// This is what makes claiming safe: the board displays the code on its own LCD and
    /// broadcasts only the commitment, so the code itself is never on the wire. An
    /// impostor that fabricates a commitment never matches; one that copies a real
    /// board's nonce and commitment produces two announcers with the same commitment,
    /// which the claim endpoint refuses out loud.
    /// </para>
    /// </summary>
    public static string ClaimCommitment(string code, string nonce)
    {
        var digest = SHA256.HashData(Encoding.UTF8.GetBytes(string.Concat(code, ":", nonce)));
        return Convert.ToHexString(digest).ToLowerInvariant()[..CommitmentHexLength];
    }

    /// <summary>True when <paramref name="code"/> is exactly eight characters of the LCD alphabet.</summary>
    public static bool IsWellFormedClaimCode(string? code)
    {
        return code is { Length: ClaimCodeLength }
               && code.All(c => ClaimAlphabet.Contains(c, StringComparison.Ordinal));
    }

    /// <summary>
    /// Parses one packet. Never throws: this is fed straight from an unauthenticated UDP
    /// socket on a club LAN, where the next datagram is as likely to be someone's printer
    /// discovery as it is to be a court box.
    ///
    /// <para>
    /// The order of the checks is itself part of the contract. Magic is tested before the
    /// checksum so unrelated traffic costs one string comparison; the checksum is tested
    /// before the verb and before field parsing so a corrupted frame is never
    /// misdiagnosed as a semantic error.
    /// </para>
    /// </summary>
    public static BeaconDecodeResult Decode(string packet)
    {
        var text = (packet ?? string.Empty).TrimEnd('\n', '\r');

        // An empty datagram is a framing failure rather than a magic failure: there is no
        // magic to have got wrong. UDP delivers zero-length datagrams quite legitimately.
        if (text.Length == 0) return BeaconDecodeResult.Fail(ErrorBadFrame);
        if (!text.StartsWith(Preamble, StringComparison.Ordinal)) return BeaconDecodeResult.Fail(ErrorBadMagic);

        var star = text.LastIndexOf('*');

        // Exactly two characters may follow the star. A frame truncated mid-flight has
        // none, and that is the common case this catches.
        if (star < 0 || text.Length - star != 3) return BeaconDecodeResult.Fail(ErrorBadFrame);

        var rest = text[Preamble.Length..star];
        var space = rest.IndexOf(' ');

        // sp <= 0 covers both "no body separator at all" and an empty verb.
        if (space <= 0) return BeaconDecodeResult.Fail(ErrorBadFrame);

        var verb = rest[..space];
        var body = rest[(space + 1)..];

        if (!string.Equals(Checksum(body), text[(star + 1)..], StringComparison.Ordinal))
        {
            return BeaconDecodeResult.Fail(ErrorBadChecksum);
        }

        if (!KnownVerbs.Contains(verb, StringComparer.Ordinal)) return BeaconDecodeResult.Fail(ErrorBadVerb);
        if (body.Length == 0) return BeaconDecodeResult.Fail(ErrorBadFrame);

        return ParseFields(verb, body);
    }

    private static BeaconDecodeResult ParseFields(string verb, string body)
    {
        var fields = new List<KeyValuePair<string, string>>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (var token in body.Split(' '))
        {
            var eq = token.IndexOf('=');

            // eq <= 0 rejects both a bare token and an empty key. The value may contain
            // further '=' characters, so only the first one separates.
            if (eq <= 0) return BeaconDecodeResult.Fail(ErrorBadFrame);

            var key = token[..eq];

            // Last-wins would let a spoofer append st=unclaimed to a legitimate frame and
            // have it take effect. Two values for one key is not a packet anyone meant to
            // send, so it is refused rather than resolved.
            if (!seen.Add(key)) return BeaconDecodeResult.Fail(ErrorDuplicateKey);

            fields.Add(new KeyValuePair<string, string>(key, token[(eq + 1)..]));
        }

        return BeaconDecodeResult.Success(new BeaconFrame(verb, fields));
    }
}
