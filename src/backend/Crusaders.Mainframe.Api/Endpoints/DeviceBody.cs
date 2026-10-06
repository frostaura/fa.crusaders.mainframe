using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// How every court box and door gate body is read — review round 15, D15-1.
///
/// <para>
/// <b>Why the device routes do not take the framework's JSON binding.</b> The Mega passes any byte
/// its scanner reads, and the bridge put a scan into its bodies as raw bytes. A subject of
/// <c>41 E9 42</c> is not UTF-8, and the framework's answer was a 500 on the live stack (Development
/// throws on a bad body; the exception handler mapped every exception to 500) and an empty 400
/// elsewhere. The firmware treats 5xx as transient, so the box retried the head of its queue for
/// ever, its breaker tripped, and every later attendance event — the evidence the no-show sweep
/// waits on — was pinned behind one garbled scan.
/// </para>
///
/// <para>
/// <b>Invalid UTF-8 is read leniently</b>: each bad sequence becomes U+FFFD and the body is parsed
/// as usual. A garbled subject is then simply a code nobody holds — the event is receipted and the
/// drain moves on, and an online scan is refused as not recognised — which is the honest reading of
/// a scan that came off the glass garbled. The board is still told about on the club's error log
/// (<see cref="DeviceFaultSink.MalformedBody"/>), because a box sending such bytes is a firmware
/// defect worth seeing.
/// </para>
///
/// <para>
/// <b>A body that still is not JSON</b> (an unescaped quote in a token, a cut body) cannot be acted
/// on at all: <see cref="MalformedDeviceBodyException"/>, which the stable-error handler answers
/// <c>400 {"error":"malformed_body"}</c> — a 4xx the box caused, which the drain drops and moves on
/// from — after a <c>malformed_body</c> fault is filed against the board when its MAC can still be
/// read out of the bytes, and folded into one row for the club when it cannot.
/// </para>
///
/// <para>
/// Each device request record opts in with a one-line <c>BindAsync</c>, so the routes' signatures and
/// every fixture are unchanged. Authentication and the tenant have resolved before this runs (it is
/// part of the endpoint), so an unauthenticated caller never reaches it and files nothing.
/// </para>
/// </summary>
public static partial class DeviceBody
{
    /// <summary>
    /// The most a device body may carry. A full events batch is a few kilobytes; anything near this
    /// is not a board talking.
    /// </summary>
    public const int MaxBytes = 256 * 1024;

    /// <summary>
    /// The fault's detail when some characters could not be read and were replaced, and the rest of
    /// the body was read and acted on (invalid UTF-8, or a NUL — R16 D16-1). R16 D16-5: plain words,
    /// distinct from <see cref="NotJsonDetail"/>; the console keys its explanation on the two.
    /// </summary>
    public const string ReplacedDetail = "some characters could not be read and were replaced; the rest was read and used";

    /// <summary>The fault's detail when the body could not be read at all, so nothing in it was used.</summary>
    public const string NotJsonDetail = "the message could not be read at all, so nothing in it was used";

    /// <summary>Reads a device body as <typeparamref name="T"/> — see the class comment.</summary>
    public static async ValueTask<T> ReadAsync<T>(HttpContext ctx) where T : class
    {
        var bytes = await ReadBytesAsync(ctx);
        if (bytes is null) throw await RefuseAsync(ctx, [], "body too large");

        var replaced = !System.Text.Unicode.Utf8.IsValid(bytes);
        if (replaced) bytes = Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(bytes));
        // R16 D16-1: a NUL (the JSON escape \u0000) is a character no text column can hold — a version
        // or a capability carrying one answered 500. Read like a garbled byte: U+FFFD, and the fault.
        if (ReplaceNulEscapes(bytes)) replaced = true;

        T? value;
        try
        {
            var options = ctx.RequestServices.GetRequiredService<IOptions<Microsoft.AspNetCore.Http.Json.JsonOptions>>().Value.SerializerOptions;
            value = bytes.Length == 0 ? null : JsonSerializer.Deserialize<T>(bytes, options);
        }
        catch (JsonException)
        {
            value = null;
        }

        if (value is null) throw await RefuseAsync(ctx, bytes, NotJsonDetail);
        // R18 D18-5: the board the limiter charged (the FIRST "mac" in the text) must be the board the
        // route acts as (the LAST one, which the JSON reader keeps). Two, or one the limiter did not read,
        // is a body naming two boards — refused, so a flood cannot be charged to A while acting as B.
        if (NamesTwoBoards(ctx, bytes)) throw await RefuseAsync(ctx, bytes, TwoBoardsDetail);
        if (replaced) await FileAsync(ctx, bytes, ReplacedDetail);
        return value;
    }

    /// <summary>R18 D18-5: the fault's detail when a body names its board more than once, or differently from what was charged.</summary>
    public const string TwoBoardsDetail = "the message named more than one board, so nothing in it was used";

    /// <summary>
    /// R18 D18-5: whether the body's top-level <c>mac</c> appears more than once, or differs from the MAC
    /// the rate limiter charged this request to (<see cref="Security.DeviceRateKey.ChargedMac"/>).
    /// </summary>
    internal static bool NamesTwoBoards(HttpContext ctx, byte[] bytes)
    {
        var macs = TopLevelMacs(bytes);
        if (macs.Count > 1) return true;
        if (Security.DeviceRateKey.ChargedMac(ctx) is not { } charged) return false;
        return macs.Count == 1 && DeviceRegistryService.NormaliseMacAddress(macs[0]) != charged;
    }

    /// <summary>Every value of a top-level <c>"mac"</c> property (any case), in order. Empty for a body that is not an object.</summary>
    internal static List<string> TopLevelMacs(byte[] bytes)
    {
        var found = new List<string>();
        var reader = new Utf8JsonReader(bytes, new JsonReaderOptions { AllowTrailingCommas = true, CommentHandling = JsonCommentHandling.Skip });
        while (reader.Read())
        {
            // Any spelling the binder would take for it: the device routes bind case-insensitively.
            if (reader.TokenType != JsonTokenType.PropertyName || reader.CurrentDepth != 1
                || !string.Equals(reader.GetString(), "mac", StringComparison.OrdinalIgnoreCase)) continue;
            if (!reader.Read()) break;
            found.Add(reader.TokenType == JsonTokenType.String ? reader.GetString() ?? "" : "");
        }
        return found;
    }

    /// <summary>
    /// Rewrites every JSON escape <c>\u0000</c> in place as <c>\uFFFD</c> (same length), and answers
    /// whether there was one. Escapes are read in pairs, so an escaped backslash followed by
    /// <c>u0000</c> — the six characters of text, not a NUL — is left alone.
    /// </summary>
    internal static bool ReplaceNulEscapes(byte[] bytes)
    {
        var found = false;
        for (var i = 0; i < bytes.Length - 1; i++)
        {
            if (bytes[i] != (byte)'\\') continue;
            if (bytes[i + 1] == (byte)'u' && i + 5 < bytes.Length && IsNulDigits(bytes, i + 2))
            {
                bytes[i + 2] = (byte)'F';
                bytes[i + 3] = (byte)'F';
                bytes[i + 4] = (byte)'F';
                bytes[i + 5] = (byte)'D';
                found = true;
            }
            i++; // the escaped character is never the start of another escape
        }
        return found;
    }

    private static bool IsNulDigits(byte[] bytes, int at) =>
        bytes[at] == '0' && bytes[at + 1] == '0' && bytes[at + 2] == '0' && bytes[at + 3] == '0';

    /// <summary>The body's bytes, or null when it is larger than <see cref="MaxBytes"/>.</summary>
    private static async Task<byte[]?> ReadBytesAsync(HttpContext ctx)
    {
        using var buffer = new MemoryStream();
        var chunk = new byte[8192];
        int read;
        while ((read = await ctx.Request.Body.ReadAsync(chunk, ctx.RequestAborted)) > 0)
        {
            if (buffer.Length + read > MaxBytes) return null;
            buffer.Write(chunk, 0, read);
        }
        return buffer.ToArray();
    }

    private static async Task<MalformedDeviceBodyException> RefuseAsync(HttpContext ctx, byte[] bytes, string detail)
    {
        await FileAsync(ctx, bytes, detail);
        return new MalformedDeviceBodyException(detail);
    }

    /// <summary>
    /// Files the fault, against the board when the bytes still name a MAC this club registered.
    /// Never throws: a monitoring write must not decide what the box is answered.
    /// </summary>
    private static async Task FileAsync(HttpContext ctx, byte[] bytes, string detail)
    {
        var route = ctx.Request.Path.Value ?? "";
        var slash = route.LastIndexOf('/');
        var name = slash >= 0 ? route[(slash + 1)..] : route;
        try
        {
            var device = await DeviceOfAsync(ctx, bytes);
            ctx.RequestServices.GetRequiredService<DeviceFaultSink>().MalformedBody(name, detail, device);
        }
        catch (Exception ex)
        {
            ctx.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger(typeof(DeviceBody))
                .LogWarning(ex, "Could not file a malformed device body on {Route}", name);
        }
    }

    /// <summary>The registered board a body's <c>"mac"</c> names, read out of the raw text; null when it names none.</summary>
    private static async Task<Domain.Device?> DeviceOfAsync(HttpContext ctx, byte[] bytes)
    {
        var match = MacField().Match(Encoding.UTF8.GetString(bytes));
        var mac = match.Success ? DeviceRegistryService.NormaliseMacAddress(match.Groups[1].Value) : null;
        if (mac is null) return null;
        var db = ctx.RequestServices.GetRequiredService<MainframeDbContext>();
        return await db.Devices.AsNoTracking().FirstOrDefaultAsync(d => d.MacAddress == mac, ctx.RequestAborted);
    }

    [GeneratedRegex("\"mac\"\\s*:\\s*\"([0-9A-Fa-f:\\-. ]{12,17})\"")]
    internal static partial Regex MacField();
}

/// <summary>
/// A device body that could not be read as JSON (D15-1). A 400, answered
/// <c>{"error":"malformed_body"}</c> by <see cref="Security.InternalErrors"/>; the fault was filed
/// before it was thrown.
/// </summary>
public sealed class MalformedDeviceBodyException(string detail)
    : BadHttpRequestException($"Malformed device body: {detail}", StatusCodes.Status400BadRequest);
