using System.Text.Json;
using System.Text.Json.Serialization;

namespace Crusaders.Mainframe.Api.Security;

/// <summary>
/// Every instant a request BODY carries is read as UTC (review round 2, B-9).
///
/// <para>
/// <b>Why.</b> Npgsql refuses a <see cref="DateTimeOffset"/> whose offset is not zero on a
/// <c>timestamptz</c> parameter (<c>memory/gotchas-postgres-offsets.md</c>), and a client in the
/// club's own zone sends <c>2026-10-01T10:15:00+02:00</c> — so <c>POST /bookings</c> with one
/// answered 500 with an Npgsql stack trace. The instant is the same either way; only the offset
/// is dropped, at the one place every body is read, instead of a <c>.ToUniversalTime()</c> each
/// call site must remember. Writing is unchanged: an answer keeps whatever offset it was given.
/// Query-string instants are bound by <c>TryParse</c>, not JSON, and are normalised where read.
/// </para>
/// </summary>
public sealed class UtcInstantConverter : JsonConverter<DateTimeOffset>
{
    public override DateTimeOffset Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        // A JsonException, as the built-in converter throws, so a malformed instant stays a 400.
        if (reader.TokenType != JsonTokenType.String || !reader.TryGetDateTimeOffset(out var value))
        {
            throw new JsonException("not an ISO 8601 instant");
        }
        return value.ToUniversalTime();
    }

    public override void Write(Utf8JsonWriter writer, DateTimeOffset value, JsonSerializerOptions options) =>
        writer.WriteStringValue(value);
}

/// <summary>
/// The answer to an exception nothing handled (review round 2, B-9): <c>500 {"error":"internal_error"}</c>,
/// in every environment — never a stack trace, which the developer page served to anyone who could
/// reach a Development host. The exception is still logged in full by the handler middleware.
///
/// <para>
/// <b>Except a body the caller sent that cannot be read</b> (review round 15, D15-3). Every exception
/// came here, so cut JSON, a wrong type or invalid UTF-8 answered 500 on the live stack (Development,
/// where the framework THROWS on a bad body) and an empty 400 everywhere else (where it does not).
/// A 500 is the server saying it failed; a box reads it as "try again" and a member's screen as
/// "something broke". So the framework is told to throw in every environment, and a bad request is
/// answered here with a code:
/// </para>
/// <list type="bullet">
/// <item>a device route (<c>/api/v1/device/…</c>): <c>400 {"error":"malformed_body"}</c> — the code the
/// firmware and the error log already name (<see cref="Services.DeviceErrorCodes.MalformedBody"/>);
/// the fault itself is filed by <see cref="Endpoints.DeviceBody"/>, which reads those bodies;</item>
/// <item>any other route: <c>400 {"error":"invalid_body"}</c> when the body could not be read, and
/// <c>400 {"error":"bad_request"}</c> for any other binding failure (a route or query value);</item>
/// <item>a size or media-type refusal keeps its own status (<c>413 body_too_large</c>,
/// <c>415 unsupported_media_type</c>);</item>
/// <item>R16 D16-1: a value PostgreSQL refused as unstorable (SQLSTATE 22001 too long, 22021 a NUL)
/// is the same 400 — <c>malformed_body</c> on a device route, <c>invalid_body</c> elsewhere
/// (<see cref="StorableText"/>).</item>
/// <item>R16 BE16c: PostgreSQL aborting a transaction to be run again (SQLSTATE 40P01 deadlock,
/// 40001 serialization failure) that outlived the retries in <see cref="Persistence.DatabaseRetry"/>, or
/// reached a path that has none: <c>503 {"error":"conflict_retry"}</c> with <c>Retry-After</c>, on every
/// route. Nothing the request did committed — the database rolled it back — so asking again is the
/// right answer, and a box (which keeps an event on any 5xx and backs off) and a screen both read it
/// as "try again", never as a fault in the server.</item>
/// </list>
/// </summary>
public static class InternalErrors
{
    public const string Code = "internal_error";

    /// <summary>A member or admin route's body could not be read (D15-3).</summary>
    public const string InvalidBody = "invalid_body";

    /// <summary>Some other part of the request could not be bound (a route or query value).</summary>
    public const string BadRequest = "bad_request";

    public static IApplicationBuilder UseStableInternalErrors(this IApplicationBuilder app)
    {
        // Development throws on a bad body and every other environment answers an empty 400; one
        // behaviour everywhere, answered below. Set before the first request builds the endpoints,
        // which is when RouteHandlerOptions is read.
        if (app.ApplicationServices.GetService<Microsoft.Extensions.Options.IOptions<Microsoft.AspNetCore.Routing.RouteHandlerOptions>>()
            is { } routing)
        {
            routing.Value.ThrowOnBadRequest = true;
        }

        return app.UseExceptionHandler(new ExceptionHandlerOptions
        {
            ExceptionHandler = AnswerAsync,
            // A caller's bad body is not a server fault: no error-level "unhandled exception" for it.
            SuppressDiagnosticsCallback = c => Classify(c.Exception, c.HttpContext.Request).Status < 500,
        });
    }

    private static async Task AnswerAsync(HttpContext ctx)
    {
        var feature = ctx.Features.Get<Microsoft.AspNetCore.Diagnostics.IExceptionHandlerPathFeature>();
        var request = ctx.Request;
        var (status, code) = Classify(feature?.Error, request, feature?.Path);
        ctx.Response.StatusCode = status;
        if (code == Persistence.DatabaseRetry.ConflictRetry)
        {
            ctx.Response.Headers.RetryAfter = Persistence.DatabaseRetry.RetryAfterSeconds.ToString(System.Globalization.CultureInfo.InvariantCulture);
        }
        ctx.Response.ContentType = "application/json";
        await ctx.Response.WriteAsync(JsonSerializer.Serialize(new { error = code }));
    }

    /// <summary>
    /// The status and code an exception is answered with. <paramref name="originalPath"/> is the path
    /// the request was for (the handler may run with the endpoint cleared).
    /// </summary>
    internal static (int Status, string Code) Classify(Exception? error, HttpRequest request, string? originalPath = null)
    {
        var device = new PathString(originalPath ?? request.Path.Value).StartsWithSegments("/api/v1/device");
        if (error is BadHttpRequestException bad && bad.StatusCode is >= 400 and < 500)
        {
            return (bad.StatusCode, device ? Services.DeviceErrorCodes.MalformedBody : CodeOf(bad));
        }

        // A JsonException a handler let escape while reading the body it was sent (ReadFromJsonAsync).
        if (error is JsonException && CarriesBody(request))
        {
            return (StatusCodes.Status400BadRequest, device ? Services.DeviceErrorCodes.MalformedBody : InvalidBody);
        }

        // R16 D16-1: a value PostgreSQL cannot store — longer than its column, or carrying a NUL — is
        // the caller's, never the server's. The named routes refuse it up front (StorableText); this is
        // the net under every other one, so no request can turn an unstorable string into a 500.
        if (StorableText.IsUnstorable(error))
        {
            return (StatusCodes.Status400BadRequest, device ? Services.DeviceErrorCodes.MalformedBody : InvalidBody);
        }

        // R16 BE16c: the database chose this request as a deadlock's (or a serialization failure's)
        // victim and rolled it back. Not a server fault and not the caller's: ask again shortly.
        //
        // R17 J17-1: and an optimistic-concurrency miss the route did not re-decide — a booking or a
        // seat whose Version moved between the read and the write. Nothing of the save exists; the
        // same answer, so a member's screen re-reads and a box keeps the event (any 5xx) and retries.
        if (Persistence.DatabaseRetry.IsLostRace(error))
        {
            return (StatusCodes.Status503ServiceUnavailable, Persistence.DatabaseRetry.ConflictRetry);
        }

        return (StatusCodes.Status500InternalServerError, Code);
    }

    /// <remarks>Block body: a switch expression's braces trip lizard (memory/gotchas-build.md).</remarks>
    private static string CodeOf(BadHttpRequestException bad)
    {
        return bad.StatusCode switch
        {
            StatusCodes.Status413PayloadTooLarge => "body_too_large",
            StatusCodes.Status415UnsupportedMediaType => "unsupported_media_type",
            _ when bad.InnerException is JsonException
                || bad.Message.Contains("body", StringComparison.OrdinalIgnoreCase) => InvalidBody,
            _ => BadRequest,
        };
    }

    private static bool CarriesBody(HttpRequest request) =>
        HttpMethods.IsPost(request.Method) || HttpMethods.IsPut(request.Method) || HttpMethods.IsPatch(request.Method);
}
