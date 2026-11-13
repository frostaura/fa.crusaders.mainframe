using System.Buffers.Binary;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The arithmetic of the single rotating member code (D1) — <c>docs/specs/member-code.md</c> §3,
/// exactly, and nothing else: no database, no clock, no tenant.
///
/// <para>
/// <b>Every function here is pinned by the <c>membercode/</c> corpus</b>
/// (<c>MemberCodeCorpusTests</c>), which Python's own <c>hmac</c>, <c>hashlib</c> and
/// <c>zoneinfo</c> generated. So the server is checked against an implementation that is not
/// itself, which is the only kind of check that catches a shared misreading of an RFC.
/// </para>
/// </summary>
public static class MemberCodeMath
{
    /// <summary>Seconds in one step (RFC 6238's X). The whole contract is built on it.</summary>
    public const int StepSeconds = 30;

    /// <summary>Characters in a v1 token: <c>"1"</c> + REF(4) + ON(8) + OFF(6).</summary>
    public const int TokenLength = 19;

    /// <summary>The version character. Never normalised.</summary>
    public const char Version = '1';

    /// <summary>Characters in a REF.</summary>
    public const int RefLength = 4;

    /// <summary>Largest REF value: twenty bits. Zero is reserved.</summary>
    public const int MaxRefValue = (1 << 20) - 1;

    /// <summary>Digits of the server-and-phone half.</summary>
    public const int OnDigits = 8;

    /// <summary>Digits of the half a device can check.</summary>
    public const int OffDigits = 6;

    /// <summary>Bytes of a per-day key: 16 base64url characters exactly.</summary>
    public const int KdayBytes = 12;

    /// <summary>Bytes of a member secret.</summary>
    public const int SecretBytes = 32;

    /// <summary>The longest real club day, in steps (Antarctica/Troll's two-hour shift).</summary>
    public const int MaxDaySteps = 3120;

    /// <summary>HKDF salt (§3.2).</summary>
    public static readonly byte[] HkdfSalt = Encoding.ASCII.GetBytes("crusaders/member-code/v1");

    /// <summary>The K_day label prefix (§3.7).</summary>
    public const string KdayLabelPrefix = "crusaders/kday/v1|";

    /// <summary>Crockford base32, the same alphabet access codes use.</summary>
    public const string Crockford = AccessCodeService.Alphabet;

    // ---- Primitives ---------------------------------------------------------------------------

    /// <summary>RFC 5869 HKDF-SHA-256.</summary>
    public static byte[] Hkdf(byte[] ikm, byte[] salt, byte[] info, int length) =>
        HKDF.DeriveKey(HashAlgorithmName.SHA256, ikm, length, salt, info);

    /// <summary>
    /// RFC 4226 over HMAC-SHA-256 (RFC 6238's SHA-256 mode): the offset is the low nibble of the
    /// digest's LAST byte, byte 31.
    /// </summary>
    public static int Hotp(ReadOnlySpan<byte> key, long counter, int digits)
    {
        Span<byte> message = stackalloc byte[8];
        BinaryPrimitives.WriteInt64BigEndian(message, counter);
        Span<byte> mac = stackalloc byte[32];
        HMACSHA256.HashData(key, message, mac);

        var offset = mac[31] & 0x0F;
        var binary = ((mac[offset] & 0x7F) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
        return (int)(binary % Pow10(digits));
    }

    private static long Pow10(int digits)
    {
        long value = 1;
        for (var i = 0; i < digits; i++) value *= 10;
        return value;
    }

    /// <summary>A code rendered with its zeros, the way a phone shows it.</summary>
    public static string Digits(int value, int digits) =>
        value.ToString(new string('0', digits), CultureInfo.InvariantCulture);

    // ---- Derivations (§3.2–§3.7) --------------------------------------------------------------

    /// <summary>The HKDF info string of one member at one generation.</summary>
    // Block bodies here and on IsV1Shaped for the lizard reason in memory/gotchas-build.md.
    public static string SecretInfo(Guid tenantId, Guid userId, int generation)
    {
        return string.Create(CultureInfo.InvariantCulture, $"member-secret|{tenantId:D}|{userId:D}|{generation}");
    }

    /// <summary>S — never stored, derived on demand from the master key.</summary>
    public static byte[] MemberSecret(byte[] masterKey, Guid tenantId, Guid userId, int generation) =>
        Hkdf(masterKey, HkdfSalt, Encoding.ASCII.GetBytes(SecretInfo(tenantId, userId, generation)), SecretBytes);

    /// <summary>K_day: the first twelve bytes of HMAC(S, "crusaders/kday/v1|" + day).</summary>
    public static byte[] Kday(byte[] secret, string clubDay)
    {
        var mac = HMACSHA256.HashData(secret, Encoding.ASCII.GetBytes(KdayLabelPrefix + clubDay));
        return mac[..KdayBytes];
    }

    /// <summary>ON at a step.</summary>
    public static string On(byte[] secret, long step) => Digits(Hotp(secret, step, OnDigits), OnDigits);

    /// <summary>OFF at a step under an already-derived K_day.</summary>
    public static string Off(byte[] kday, long step) => Digits(Hotp(kday, step, OffDigits), OffDigits);

    /// <summary>OFF at a step, deriving the step's own club day.</summary>
    public static string Off(byte[] secret, long step, TimeZoneInfo zone) => Off(Kday(secret, ClubDay(step, zone)), step);

    /// <summary>A whole token at a step.</summary>
    public static string Token(string canonicalRef, byte[] secret, long step, TimeZoneInfo zone) =>
        Version + canonicalRef + On(secret, step) + Off(secret, step, zone);

    // ---- Time -----------------------------------------------------------------------------------

    /// <summary><c>floor(unix / 30)</c>, for any instant including pre-1970 (never reached).</summary>
    public static long StepOf(DateTimeOffset instant) =>
        (long)Math.Floor(instant.ToUnixTimeMilliseconds() / (StepSeconds * 1000d));

    /// <summary>The first instant of a step.</summary>
    public static DateTimeOffset StartOf(long step) => DateTimeOffset.FromUnixTimeSeconds(step * StepSeconds);

    /// <summary>
    /// The club's zone, or UTC when the stored id is one this platform does not know — the same
    /// fallback the heartbeat's wall clock takes, so a phone told "UTC" and a box synced in UTC
    /// agree about which day it is rather than the heartbeat throwing.
    /// </summary>
    public static TimeZoneInfo ZoneOf(string? tzId) =>
        !string.IsNullOrWhiteSpace(tzId) && TimeZoneInfo.TryFindSystemTimeZoneById(tzId, out var zone) ? zone : TimeZoneInfo.Utc;

    /// <summary>The id to hand a phone for <paramref name="tzId"/>: itself when known, else <c>UTC</c>.</summary>
    public static string ZoneIdFor(string? tzId) =>
        !string.IsNullOrWhiteSpace(tzId) && TimeZoneInfo.TryFindSystemTimeZoneById(tzId, out _) ? tzId : "UTC";

    /// <summary>The club-local date of a step's FIRST instant, <c>YYYY-MM-DD</c> (§3.6).</summary>
    public static string ClubDay(long step, TimeZoneInfo zone) =>
        TimeZoneInfo.ConvertTime(StartOf(step), zone).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    /// <summary>
    /// <c>[first, end)</c> of the club day holding <paramref name="step"/>, in steps.
    ///
    /// <para>
    /// Found by search rather than by converting a local midnight to UTC, because a midnight can
    /// fall inside a daylight-saving gap and a conversion of a time that does not exist is the one
    /// answer a library is free to invent. Every real UTC offset is a multiple of fifteen minutes,
    /// so every local midnight is on a fifteen-minute boundary in UTC — and so on a step boundary
    /// — and a scan in fifteen-minute strides around the estimate finds it exactly.
    /// </para>
    /// </summary>
    public static (long First, long End) DayRange(long step, TimeZoneInfo zone)
    {
        var day = ClubDay(step, zone);
        return (FirstStepOf(day, zone), FirstStepOf(NextDay(day), zone));
    }

    private static string NextDay(string day) =>
        DateOnly.ParseExact(day, "yyyy-MM-dd", CultureInfo.InvariantCulture).AddDays(1)
            .ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    private const int QuarterHourSteps = 15 * 60 / StepSeconds;

    private static long FirstStepOf(string day, TimeZoneInfo zone)
    {
        var date = DateOnly.ParseExact(day, "yyyy-MM-dd", CultureInfo.InvariantCulture);
        var noon = new DateTime(date.Year, date.Month, date.Day, 12, 0, 0, DateTimeKind.Unspecified);
        var offset = zone.GetUtcOffset(noon);
        var estimate = new DateTimeOffset(date.Year, date.Month, date.Day, 0, 0, 0, TimeSpan.Zero) - offset;

        // Quarter-hour aligned start, four hours before the estimate; the day starts at the first
        // quarter hour whose step belongs to it.
        var start = StepOf(estimate) - (4 * 60 / 15 * QuarterHourSteps);
        start -= ((start % QuarterHourSteps) + QuarterHourSteps) % QuarterHourSteps;
        for (var s = start; s <= start + (16 * 4 * QuarterHourSteps); s += QuarterHourSteps)
        {
            if (string.CompareOrdinal(ClubDay(s, zone), day) >= 0) return s;
        }

        throw new InvalidOperationException($"no midnight found for {day} in {zone.Id}");
    }

    // ---- REF (§3.3) -----------------------------------------------------------------------------

    /// <summary>A REF value as four canonical Crockford characters, most significant first.</summary>
    public static string RefText(int value)
    {
        if (value is < 1 or > MaxRefValue) throw new ArgumentOutOfRangeException(nameof(value));
        Span<char> text = stackalloc char[RefLength];
        for (var i = 0; i < RefLength; i++)
        {
            text[i] = Crockford[(value >> (5 * (RefLength - 1 - i))) & 31];
        }
        return new string(text);
    }

    /// <summary>
    /// The normalising decode a SCANNED REF gets (the token only): ASCII, case-folded, I/L read as
    /// 1, O read as 0, anything else — U, a hyphen, whitespace, a dotless ı — refused. Zero is
    /// reserved. Null on any refusal.
    /// </summary>
    public static int? DecodeScannedRef(ReadOnlySpan<char> text)
    {
        if (text.Length != RefLength) return null;
        var value = 0;
        foreach (var raw in text)
        {
            if (raw > 0x7F) return null;
            var ch = char.ToUpperInvariant(raw);
            if (ch is 'I' or 'L') ch = '1';
            else if (ch == 'O') ch = '0';
            var digit = Crockford.IndexOf(ch);
            if (digit < 0) return null;
            value = (value * 32) + digit;
        }
        return value == 0 ? null : value;
    }

    /// <summary>
    /// Whether <paramref name="text"/> is a CANONICAL REF — what the server must emit and what a
    /// device refuses to normalise: four upper-case alphabet characters, not <c>0000</c>.
    /// </summary>
    public static bool IsCanonicalRef(ReadOnlySpan<char> text)
    {
        if (text.Length != RefLength) return false;
        var zero = true;
        foreach (var ch in text)
        {
            if (Crockford.IndexOf(ch) < 0) return false;
            if (ch != '0') zero = false;
        }
        return !zero;
    }

    // ---- The token (§3.8) -----------------------------------------------------------------------

    /// <summary>Whether a scanned string is to be treated as a v1 token at all: length alone (§3.8).</summary>
    public static bool IsV1Shaped(string? token)
    {
        // MCV1-11: exactly 19 characters AND a leading `1` — `memcode::looksLikeV1`'s rule, the same
        // thing on every side (member-code §3.8). Length alone disagreed on 1,981 of 3,006 strings.
        return token is { Length: TokenLength } && token[0] == '1';
    }

    /// <summary>
    /// Parses a v1 token, or null when it is malformed. Exactly 19 characters, a literal <c>1</c>,
    /// a REF that decodes and is not reserved, fourteen ASCII digits.
    /// </summary>
    public static ParsedMemberCode? Parse(string? token)
    {
        if (token is not { Length: TokenLength } || token[0] != Version) return null;
        if (DecodeScannedRef(token.AsSpan(1, RefLength)) is not { } refValue) return null;
        for (var i = 1 + RefLength; i < TokenLength; i++)
        {
            if (token[i] is < '0' or > '9') return null;
        }
        return new ParsedMemberCode(
            refValue, RefText(refValue), token.Substring(1 + RefLength, OnDigits), token.Substring(1 + RefLength + OnDigits, OffDigits));
    }

    /// <summary>Unpadded base64url.</summary>
    public static string Base64Url(ReadOnlySpan<byte> bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    /// <summary>Unpadded base64url back to bytes, or null.</summary>
    public static byte[]? FromBase64Url(string text)
    {
        foreach (var ch in text)
        {
            var ok = ch is (>= 'A' and <= 'Z') or (>= 'a' and <= 'z') or (>= '0' and <= '9') or '-' or '_';
            if (!ok) return null;
        }
        var padded = text.Replace('-', '+').Replace('_', '/');
        padded += (padded.Length % 4) switch { 2 => "==", 3 => "=", 0 => "", _ => null };
        try { return Convert.FromBase64String(padded); }
        catch (FormatException) { return null; }
    }

    /// <summary>Constant-time comparison of two ASCII digit strings.</summary>
    public static bool SameDigits(string a, string b) =>
        a.Length == b.Length
        && CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(a), Encoding.ASCII.GetBytes(b));
}

/// <summary>A token that parsed: its REF (value and canonical text) and its two halves as digit strings.</summary>
public sealed record ParsedMemberCode(int RefValue, string Ref, string On, string Off);
