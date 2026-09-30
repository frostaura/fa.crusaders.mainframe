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
/// </summary>
public static class InternalErrors
{
    public const string Code = "internal_error";

    public static IApplicationBuilder UseStableInternalErrors(this IApplicationBuilder app) =>
        app.UseExceptionHandler(errors => errors.Run(async ctx =>
        {
            ctx.Response.StatusCode = StatusCodes.Status500InternalServerError;
            ctx.Response.ContentType = "application/json";
            await ctx.Response.WriteAsync(JsonSerializer.Serialize(new { error = Code }));
        }));
}
