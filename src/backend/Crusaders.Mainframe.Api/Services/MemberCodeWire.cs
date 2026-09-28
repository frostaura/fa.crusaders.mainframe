using System.Globalization;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The member-code shapes a device is SENT — roster REF lists, key elements and day elements
/// (<c>docs/specs/member-code.md</c> §5) — and the validators that say whether a string is one.
///
/// <para>
/// The validators are the device's own rules, restated server side, and they are here for one
/// reason: the server must never emit an element a board will refuse. A REF list that is not
/// whole canonical REFs, a key that is not twenty-one characters, a day longer than 3120 steps —
/// each is a member refused offline for a reason nobody at the club can see. The builders refuse
/// to produce them, and <c>MemberCodeCorpusTests</c> holds both halves to the corpus.
/// </para>
/// </summary>
public static class MemberCodeWire
{
    /// <summary>The capability a board names on its heartbeat when it speaks this contract.</summary>
    public const string Capability = "codes:m1";

    /// <summary>The lower-case marker that begins a v1 roster TOKEN. No legacy code can start with it.</summary>
    public const char RosterMarker = 'm';

    /// <summary>At most four players on a booking, so at most four REFs in an entry.</summary>
    public const int MaxRefsPerEntry = 4;

    /// <summary>Characters in one key element: REF(4) + slot(1) + K_day as base64url(16).</summary>
    public const int KeyElementLength = MemberCodeMath.RefLength + 1 + 16;

    /// <summary>Key cap for a court box: what fits its 2048-byte heartbeat with sixteen full entries.</summary>
    public const int CourtBoxKeyCap = 24;

    /// <summary>Key cap for a door: what fits its 4096-byte heartbeat with forty-eight full entries.</summary>
    public const int GateKeyCap = 72;

    /// <summary>The court box's heartbeat body contract, bytes.</summary>
    public const int CourtBoxMaxBytes = 2048;

    /// <summary>The door's heartbeat body contract, bytes.</summary>
    public const int GateMaxBytes = 4096;

    /// <summary>Day slots a ring holds.</summary>
    public const int MaxDaySlots = 2;

    /// <summary>The roster TOKEN for a booking's players, organiser first: <c>m</c> + REFs.</summary>
    public static string RosterToken(IReadOnlyList<string> refs)
    {
        if (refs.Count is < 1 or > MaxRefsPerEntry) throw new ArgumentOutOfRangeException(nameof(refs));
        foreach (var r in refs)
        {
            if (!MemberCodeMath.IsCanonicalRef(r)) throw new ArgumentException($"'{r}' is not a canonical REF", nameof(refs));
        }
        return RosterMarker + string.Concat(refs);
    }

    /// <summary>
    /// Whether <paramref name="token"/> (the first field of a roster element) is a v1 REF list a
    /// device will accept: the marker, then one to four whole, canonical, non-reserved REFs.
    /// </summary>
    public static bool IsRefList(ReadOnlySpan<char> token)
    {
        if (token.Length < 1 || token[0] != RosterMarker) return false;
        var body = token[1..];
        if (body.Length == 0 || body.Length % MemberCodeMath.RefLength != 0) return false;
        if (body.Length / MemberCodeMath.RefLength > MaxRefsPerEntry) return false;
        for (var i = 0; i < body.Length; i += MemberCodeMath.RefLength)
        {
            if (!MemberCodeMath.IsCanonicalRef(body.Slice(i, MemberCodeMath.RefLength))) return false;
        }
        return true;
    }

    /// <summary>The REFs of a v1 roster token, in seat order. Empty for anything that is not one.</summary>
    public static IReadOnlyList<string> RefsOf(string token)
    {
        if (!IsRefList(token)) return [];
        var refs = new List<string>(MaxRefsPerEntry);
        for (var i = 1; i < token.Length; i += MemberCodeMath.RefLength) refs.Add(token.Substring(i, MemberCodeMath.RefLength));
        return refs;
    }

    /// <summary>One key element: canonical REF, slot digit, twelve bytes base64url unpadded.</summary>
    public static string KeyElement(string canonicalRef, int slot, ReadOnlySpan<byte> kday)
    {
        if (!MemberCodeMath.IsCanonicalRef(canonicalRef)) throw new ArgumentException("not a canonical REF", nameof(canonicalRef));
        if (slot is < 0 or >= MaxDaySlots) throw new ArgumentOutOfRangeException(nameof(slot));
        if (kday.Length != MemberCodeMath.KdayBytes) throw new ArgumentException("K_day is twelve bytes", nameof(kday));
        return canonicalRef + (char)('0' + slot) + MemberCodeMath.Base64Url(kday);
    }

    /// <summary>A key element parsed by the device's rules, or null.</summary>
    public static (string Ref, int Slot, byte[] Key)? ParseKeyElement(string? element)
    {
        if (element is not { Length: KeyElementLength }) return null;
        var refText = element[..MemberCodeMath.RefLength];
        if (!MemberCodeMath.IsCanonicalRef(refText)) return null;
        var slot = element[MemberCodeMath.RefLength] - '0';
        if (slot is < 0 or >= MaxDaySlots) return null;
        var key = MemberCodeMath.FromBase64Url(element[(MemberCodeMath.RefLength + 1)..]);
        if (key is not { Length: MemberCodeMath.KdayBytes }) return null;
        return (refText, slot, key);
    }

    /// <summary>One day element: <c>"&lt;first&gt;|&lt;end&gt;"</c>, half-open steps.</summary>
    public static string DayElement(long first, long end) =>
        string.Create(CultureInfo.InvariantCulture, $"{first}|{end}");

    /// <summary>A day element parsed by the device's rules — digits only, 32-bit, 1 to 3120 steps long — or null.</summary>
    public static (long First, long End)? ParseDayElement(string? element)
    {
        if (element is null) return null;
        var parts = element.Split('|');
        if (parts.Length != 2) return null;
        if (ParseStep(parts[0]) is not { } first || ParseStep(parts[1]) is not { } end) return null;
        if (end <= first || end - first > MemberCodeMath.MaxDaySteps) return null;
        return (first, end);
    }

    private static long? ParseStep(string text)
    {
        if (text.Length is 0 or > 10) return null;
        foreach (var ch in text)
        {
            if (ch is < '0' or > '9') return null;
        }
        var value = long.Parse(text, CultureInfo.InvariantCulture);
        return value > uint.MaxValue ? null : value;
    }
}
