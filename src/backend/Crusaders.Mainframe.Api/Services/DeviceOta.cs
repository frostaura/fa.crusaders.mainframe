using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The server's copy of the <c>ota/</c> rules (device-api.md §7): the signed manifest text, the
/// RSA-2048 PKCS#1 v1.5 SHA-256 verification, the version gate and the offer grammar. The boards
/// run the same rules in <c>devota</c>/<c>devcrypto</c> before they boot an image; the server runs
/// them when an image is UPLOADED, so an image no board would take is refused at the console
/// rather than rolled out to a fleet that refuses it. <c>ota/gen_cases.py</c> is the reference
/// implementation and <c>OtaCorpusTests</c> executes every vector against this.
/// </summary>
public static partial class DeviceOta
{
    public const string ManifestMagic = "crusaders-ota/1";
    public const string PathPrefix = "/api/v1/device/firmware/";
    public const string CourtBridge = "court_bridge";
    public const string DoorGate = "door_gate";

    /// <summary>Base64url characters in a 256-byte signature, unpadded.</summary>
    public const int SigB64Length = 342;

    /// <summary>
    /// The largest image each target's inactive area holds (a contract constant: the partition
    /// layout). ESP8266 4m2m OTA staging; ESP32 the default table's 1.25 MB app slot.
    /// </summary>
    public static readonly IReadOnlyDictionary<string, int> TargetMaxBytes = new Dictionary<string, int>
    {
        [CourtBridge] = 1044464,
        [DoorGate] = 1310720,
    };

    [GeneratedRegex(@"^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$", RegexOptions.CultureInvariant)]
    private static partial Regex VersionRe();

    [GeneratedRegex(@"^/api/v1/device/firmware/[A-Za-z0-9_-]{1,64}$", RegexOptions.CultureInvariant)]
    private static partial Regex PathRe();

    [GeneratedRegex(@"^[0-9a-f]{64}$", RegexOptions.CultureInvariant)]
    private static partial Regex ShaRe();

    [GeneratedRegex(@"^[A-Za-z0-9_-]+$", RegexOptions.CultureInvariant)]
    private static partial Regex B64UrlRe();

    /// <summary>
    /// The exact bytes that are signed: five LF-terminated lines. Target and version are INSIDE
    /// the signature, so a bridge image cannot be offered to a door, nor an old signed image as a
    /// new version.
    /// </summary>
    public static string ManifestText(string target, string version, long size, string sha256) =>
        string.Create(CultureInfo.InvariantCulture, $"{ManifestMagic}\n{target}\n{version}\n{size}\n{sha256}\n");

    /// <summary>The target a board of this kind runs.</summary>
    public static string TargetOf(Domain.DeviceKind kind) => kind == Domain.DeviceKind.Gate ? DoorGate : CourtBridge;

    /// <summary>The three numeric parts of a well-formed version, or null.</summary>
    public static (int, int, int)? VersionTuple(string? v)
    {
        if (v is null) return null;
        var m = VersionRe().Match(v);
        if (!m.Success) return null;
        return (Part(1), Part(2), Part(3));
        int Part(int i) => int.Parse(m.Groups[i].Value, CultureInfo.InvariantCulture);
    }

    /// <summary>Whether <paramref name="a"/> is strictly newer than <paramref name="b"/>, numerically; false when either is malformed.</summary>
    public static bool IsNewer(string? a, string? b) =>
        VersionTuple(a) is { } x && VersionTuple(b) is { } y && x.CompareTo(y) > 0;

    /// <summary>
    /// The board's version gate: <c>ok</c>, <c>version_format</c>, <c>running_unknown</c>,
    /// <c>failed_before</c>, <c>not_newer</c>. Strictly newer only; a downgrade is published as a
    /// higher version, so a replayed old image can never pass.
    /// </summary>
    public static string AcceptVersion(string? running, string? offered, IReadOnlyCollection<string> failed)
    {
        var o = VersionTuple(offered);
        if (o is null) return "version_format";
        var r = VersionTuple(running);
        if (r is null) return "running_unknown";
        if (failed.Contains(offered!)) return "failed_before";
        return o.Value.CompareTo(r.Value) > 0 ? "ok" : "not_newer";
    }

    /// <summary>
    /// The offer grammar a board checks first (§7 step 1): <c>ok</c> or the first failing rule.
    /// Every field mandatory; an extra field is ignored.
    /// </summary>
    public static string ParseOffer(JsonElement ota, string ownTarget)
    {
        foreach (var key in (string[])["target", "version", "size", "sha256", "sig", "path"])
        {
            if (!ota.TryGetProperty(key, out _)) return "missing_" + key;
        }
        var target = Str(ota, "target");
        if (target is null || !TargetMaxBytes.ContainsKey(target)) return "target_unknown";
        if (target != ownTarget) return "target_mismatch";
        if (VersionTuple(Str(ota, "version")) is null) return "version_format";
        var size = ota.GetProperty("size");
        if (size.ValueKind != JsonValueKind.Number || !size.TryGetInt64(out var n) || n < 1 || n > TargetMaxBytes[ownTarget]) return "size";
        if (Str(ota, "sha256") is not { } sha || !ShaRe().IsMatch(sha)) return "sha256_format";
        if (Str(ota, "sig") is not { } sig || !SigEncodingOk(sig)) return "sig_encoding";
        if (Str(ota, "path") is not { } path || !PathRe().IsMatch(path)) return "path";
        return "ok";
    }

    private static string? Str(JsonElement e, string name) =>
        e.GetProperty(name) is { ValueKind: JsonValueKind.String } v ? v.GetString() : null;

    private static bool SigEncodingOk(string sig) => sig.Length == SigB64Length && B64UrlRe().IsMatch(sig);

    /// <summary>
    /// Verifies <paramref name="sig"/> over <paramref name="manifestText"/> against the RSA-2048
    /// public key with modulus <paramref name="modulus"/> and e = 65537: <c>ok</c>,
    /// <c>sig_encoding</c>, <c>sig_range</c> (the signature is not less than the modulus) or
    /// <c>sig</c>. RSASSA-PKCS1-v1_5 over SHA-256, through <see cref="RSA"/>.
    /// </summary>
    public static string Verify(string manifestText, string sig, byte[] modulus)
    {
        if (!SigEncodingOk(sig)) return "sig_encoding";
        byte[] raw;
        try
        {
            raw = Base64UrlDecode(sig);
        }
        catch (FormatException)
        {
            return "sig_encoding";
        }
        if (raw.Length != 256) return "sig_encoding";
        if (CompareUnsigned(raw, modulus) >= 0) return "sig_range";

        using var rsa = RSA.Create();
        rsa.ImportParameters(new RSAParameters { Modulus = modulus, Exponent = [0x01, 0x00, 0x01] });
        try
        {
            return rsa.VerifyData(Encoding.ASCII.GetBytes(manifestText), raw, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1)
                ? "ok"
                : "sig";
        }
        catch (CryptographicException)
        {
            return "sig";
        }
    }

    /// <summary>A hex modulus as 256 big-endian bytes, or null when it is not a 2048-bit modulus.</summary>
    public static byte[]? ParseModulus(string? hex)
    {
        if (string.IsNullOrWhiteSpace(hex)) return null;
        var text = hex.Trim();
        if (text.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) text = text[2..];
        if (text.Length != 512 || !text.All(char.IsAsciiHexDigit)) return null;
        var bytes = Convert.FromHexString(text);
        return (bytes[0] & 0x80) == 0 || (bytes[^1] & 1) == 0 ? null : bytes;
    }

    /// <summary>Unpadded base64url to bytes.</summary>
    public static byte[] Base64UrlDecode(string text)
    {
        var s = text.Replace('-', '+').Replace('_', '/');
        s += new string('=', (4 - s.Length % 4) % 4);
        return Convert.FromBase64String(s);
    }

    private static int CompareUnsigned(byte[] a, byte[] b)
    {
        for (var i = 0; i < a.Length; i++)
        {
            if (a[i] != b[i]) return a[i].CompareTo(b[i]);
        }
        return 0;
    }

    /// <summary>
    /// The first 256 bits of the moduli of the two TEST keys <c>ota/gen_cases.py</c> signs the
    /// corpus with. A deployment outside Development configured with either is refused at start:
    /// their private halves are in the repository, so anyone could sign an image every board would
    /// boot. 256 bits of a modulus identify it beyond any collision.
    /// </summary>
    public static readonly string[] CorpusTestModulusPrefixes =
    [
        "d9ce9d8aeba6c19446077d6c0802c56f43e484653bc750b1e38913d390ee57d0",
        "a5105de8c0eeb5d3a8ddc78a4bc8a3850fb46322ac7a0aee23038f3c6bc3f23a",
    ];

    /// <summary>Whether <paramref name="modulus"/> is one of the corpus test keys'.</summary>
    public static bool IsCorpusTestKey(byte[] modulus)
    {
        var hex = Convert.ToHexStringLower(modulus);
        return CorpusTestModulusPrefixes.Any(p => hex.StartsWith(p, StringComparison.Ordinal));
    }
}
