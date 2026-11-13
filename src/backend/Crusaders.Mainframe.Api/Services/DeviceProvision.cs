using System.Text.Json;
using System.Text.RegularExpressions;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The server's copy of the <c>provision/</c> rules (device-api.md §6, §8): the base URL grammar,
/// when a <c>net</c> object is adoptable, and when a <c>key_next</c> object is. The boards run the
/// same rules in <c>devnet</c>; the server runs them when an admin SAVES the values, so a network
/// or key the boards would refuse is refused at the console with the same reason code, rather than
/// saved and then ignored by every board in the club. <c>provision/gen_cases.py</c> is the
/// reference implementation and <c>ProvisionCorpusTests</c> executes every vector against this.
/// </summary>
public static partial class DeviceProvision
{
    /// <summary>The longest base URL a board stores (a contract constant: its buffer).</summary>
    public const int BaseUrlMax = 96;

    /// <summary>The longest SSID, in UTF-8 bytes (802.11).</summary>
    public const int SsidMaxBytes = 32;

    [GeneratedRegex(@"^http://(?<host>[^:/?#@\s]+)(?::(?<port>[0-9]{1,5}))?$", RegexOptions.CultureInvariant)]
    private static partial Regex BaseRe();

    [GeneratedRegex(@"^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$", RegexOptions.CultureInvariant)]
    private static partial Regex Ipv4Re();

    [GeneratedRegex(@"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$", RegexOptions.CultureInvariant)]
    private static partial Regex NameRe();

    [GeneratedRegex(@"^k[1-9][0-9]{0,5}$", RegexOptions.CultureInvariant)]
    private static partial Regex KeyIdRe();

    [GeneratedRegex(@"^[A-Za-z0-9_-]{43}$", RegexOptions.CultureInvariant)]
    private static partial Regex KeyRe();

    /// <summary>
    /// The base URL rule: <c>ok</c>, or the reason a board would refuse it — <c>empty</c>,
    /// <c>too_long</c>, <c>https</c>, <c>grammar</c>, <c>host</c>, <c>port</c>. http only (the
    /// boards have no heap for TLS), no path, query, userinfo or trailing slash, an IPv4 literal or
    /// a lowercase DNS name, port 1–65535 with no leading zero.
    /// </summary>
    public static string BaseUrl(string? url)
    {
        if (string.IsNullOrEmpty(url)) return "empty";
        if (url.Length > BaseUrlMax) return "too_long";
        if (url.StartsWith("https://", StringComparison.Ordinal)) return "https";
        var m = BaseRe().Match(url);
        if (!m.Success) return "grammar";
        var host = m.Groups["host"].Value;
        var isName = NameRe().IsMatch(host) && !host.Replace(".", "", StringComparison.Ordinal).All(char.IsAsciiDigit);
        if (!Ipv4Re().IsMatch(host) && !isName) return "host";
        if (m.Groups["port"].Success)
        {
            var port = m.Groups["port"].Value;
            if (port.StartsWith('0') || int.Parse(port, System.Globalization.CultureInfo.InvariantCulture) is < 1 or > 65535) return "port";
        }
        return "ok";
    }

    /// <summary>A network a board would adopt: its version, base URL and up to two (ssid, psk) profiles.</summary>
    public sealed record NetSet(long Ver, string? Base, IReadOnlyList<(string Ssid, string Psk)> Wifi);

    /// <summary>
    /// The <c>net</c> adoption rule, all or nothing: <c>(true, "ok", set)</c>, or the first reason a
    /// board would refuse it — <c>ver</c>, <c>not_newer</c>, <c>base_&lt;why&gt;</c>,
    /// <c>wifi&lt;n&gt;_ssid</c>, <c>wifi&lt;n&gt;_psk</c>, <c>empty</c>.
    /// </summary>
    public static (bool Adopt, string Reason, NetSet? Result) AdoptNet(JsonElement net, long appliedVer)
    {
        if (net.ValueKind != JsonValueKind.Object) return (false, "ver", null);
        if (!net.TryGetProperty("ver", out var verEl) || verEl.ValueKind != JsonValueKind.Number
            || !verEl.TryGetInt64(out var ver) || ver is < 1 or > int.MaxValue)
        {
            return (false, "ver", null);
        }
        if (ver <= appliedVer) return (false, "not_newer", null);

        string? baseUrl = null;
        if (net.TryGetProperty("base", out var baseEl))
        {
            var why = BaseUrl(baseEl.ValueKind == JsonValueKind.String ? baseEl.GetString() : null);
            if (why != "ok") return (false, "base_" + why, null);
            baseUrl = baseEl.GetString();
        }

        var wifi = new List<(string, string)>();
        for (var slot = 0; slot < 2; slot++)
        {
            var hasSsid = net.TryGetProperty($"wifi{slot}_ssid", out var ssidEl) && ssidEl.ValueKind != JsonValueKind.Null;
            var hasPsk = net.TryGetProperty($"wifi{slot}_psk", out var pskEl) && pskEl.ValueKind != JsonValueKind.Null;
            if (!hasSsid && !hasPsk) continue;

            var ssid = hasSsid && ssidEl.ValueKind == JsonValueKind.String ? ssidEl.GetString() : null;
            if (WifiSsid(ssid) is not null) return (false, $"wifi{slot}_ssid", null);

            var psk = hasPsk ? (pskEl.ValueKind == JsonValueKind.String ? pskEl.GetString() : null) : "";
            if (WifiPsk(psk) is not null) return (false, $"wifi{slot}_psk", null);
            wifi.Add((ssid!, psk!));
        }

        if (baseUrl is null && wifi.Count == 0) return (false, "empty", null);
        return (true, "ok", new NetSet(ver, baseUrl, wifi));
    }

    /// <summary>Null when <paramref name="ssid"/> is one a board takes: 1–32 UTF-8 bytes, no control character.</summary>
    public static string? WifiSsid(string? ssid)
    {
        if (ssid is null) return "ssid";
        var bytes = System.Text.Encoding.UTF8.GetByteCount(ssid);
        if (bytes is < 1 or > SsidMaxBytes) return "ssid";
        return ssid.Any(c => c < 0x20 || c == 0x7F) ? "ssid" : null;
    }

    /// <summary>Null when <paramref name="psk"/> is one a board takes: empty (an open network) or 8–63 printable ASCII.</summary>
    public static string? WifiPsk(string? psk)
    {
        if (psk is null) return "psk";
        if (!psk.All(c => c is >= (char)0x20 and <= (char)0x7E)) return "psk";
        return psk.Length == 0 || psk.Length is >= 8 and <= 63 ? null : "psk";
    }

    /// <summary>
    /// The <c>key_next</c> adoption rule: <c>ok</c>, or <c>id</c>, <c>key</c>, <c>current</c>,
    /// <c>held</c>. The server uses the first two at a key restore (a key a board would refuse can
    /// never be put back) and to prove every id it mints is one a board accepts.
    /// </summary>
    public static string AdoptKey(JsonElement keyNext, string currentId, IReadOnlyCollection<string> heldIds)
    {
        var id = keyNext.TryGetProperty("id", out var i) && i.ValueKind == JsonValueKind.String ? i.GetString() : null;
        if (id is null || !KeyIdRe().IsMatch(id)) return "id";
        var key = keyNext.TryGetProperty("key", out var k) && k.ValueKind == JsonValueKind.String ? k.GetString() : null;
        if (key is null || !IsKey(key)) return "key";
        if (id == currentId) return "current";
        return heldIds.Contains(id) ? "held" : "ok";
    }

    /// <summary>A device key is exactly 43 base64url characters (32 random bytes, unpadded).</summary>
    public static bool IsKey(string? key) => key is not null && KeyRe().IsMatch(key);

    /// <summary>The wire id of key number <paramref name="n"/>: <c>k&lt;n&gt;</c>.</summary>
    public static string KeyId(int n) => "k" + n.ToString(System.Globalization.CultureInfo.InvariantCulture);

    /// <summary>Whether a minted id is one a board accepts — <c>k1</c>…<c>k999999</c>.</summary>
    public static bool IsKeyId(string id) => KeyIdRe().IsMatch(id);
}
