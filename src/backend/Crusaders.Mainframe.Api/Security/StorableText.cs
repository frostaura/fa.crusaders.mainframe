using System.Collections.Concurrent;
using System.Reflection;

namespace Crusaders.Mainframe.Api.Security;

/// <summary>
/// Text the database can store — review round 16, D16-1.
///
/// <para>
/// <b>Why.</b> PostgreSQL's <c>text</c> and <c>varchar</c> cannot hold U+0000, and a <c>varchar(n)</c>
/// refuses a value longer than <c>n</c>. Both arrived as an Npgsql exception the stable-error handler
/// answered <c>500 internal_error</c>: a NUL in an admin's board name or gate key, in a webhook's
/// description or filter, or in the email of an anonymous <c>POST /auth/login</c> (the lookup's
/// parameter alone is enough). A 500 says the server failed; it did not — the caller sent a value
/// nothing can store. So:
/// </para>
/// <list type="bullet">
/// <item>the routes that take free text from a person refuse a NUL before any work, with
/// <see cref="RefuseUnstorableText{TBuilder}"/>: <c>400 {"error":"invalid_body"}</c> for a body field and
/// <c>400 {"error":"bad_request"}</c> for a route or query value — the R15 D15-3 codes;</item>
/// <item>lengths are checked where the column is named (each route's own <c>*_too_long</c> code);</item>
/// <item>and anything that still reaches the database is answered by the safety net in
/// <see cref="InternalErrors"/> (<see cref="IsUnstorable"/>): 22001 and 22021 are the caller's,
/// never a 500.</item>
/// </list>
/// <para>
/// Device bodies are not refused here: <see cref="Endpoints.DeviceBody"/> reads a NUL as U+FFFD,
/// as it reads invalid UTF-8, because a 400 is a dropped event to the firmware.
/// </para>
/// </summary>
public static class StorableText
{
    /// <summary>SQLSTATE 22001 <c>string_data_right_truncation</c>: longer than the column.</summary>
    public const string TooLongState = "22001";

    /// <summary>SQLSTATE 22021 <c>character_not_in_repertoire</c>: a NUL in text.</summary>
    public const string NotInRepertoireState = "22021";

    /// <summary>True when <paramref name="value"/> carries a character no PostgreSQL text column can hold.</summary>
    public static bool HasNul(string? value) => value is not null && value.Contains('\0');

    /// <summary>
    /// True when <paramref name="error"/> (or anything it wraps) is PostgreSQL refusing a value as
    /// unstorable — too long for its column, or carrying a NUL.
    /// </summary>
    public static bool IsUnstorable(Exception? error)
    {
        for (var e = error; e is not null; e = e.InnerException)
        {
            if (e is Npgsql.PostgresException pg && pg.SqlState is TooLongState or NotInRepertoireState) return true;
        }
        return false;
    }

    /// <summary>
    /// Refuses, before the handler runs, any request on these routes carrying a NUL in a string
    /// argument or in a string property of a body record (one level deep, lists of strings included).
    /// </summary>
    public static TBuilder RefuseUnstorableText<TBuilder>(this TBuilder builder) where TBuilder : IEndpointConventionBuilder =>
        builder.AddEndpointFilter(new NulFilter());

    private sealed class NulFilter : IEndpointFilter
    {
        public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
        {
            foreach (var argument in context.Arguments)
            {
                if (CodeOf(argument) is { } code) return Results.BadRequest(new { error = code });
            }
            return await next(context);
        }
    }

    /// <summary>The refusal code for one handler argument, or null when it holds nothing unstorable.</summary>
    private static string? CodeOf(object? argument)
    {
        if (argument is string direct) return HasNul(direct) ? InternalErrors.BadRequest : null;
        if (argument is null || !IsBody(argument.GetType())) return null;
        foreach (var property in TextProperties.GetOrAdd(argument.GetType(), TextPropertiesOf))
        {
            if (Unstorable(property.GetValue(argument))) return InternalErrors.InvalidBody;
        }
        return null;
    }

    private static bool Unstorable(object? value)
    {
        if (value is string text) return HasNul(text);
        if (value is IEnumerable<string?> list) return list.Any(HasNul);
        return false;
    }

    /// <summary>
    /// A request record of this application's own — never a framework service, an HttpContext or a
    /// DI-bound service class, whose getters are not ours to run.
    /// </summary>
    private static bool IsBody(Type type) =>
        type.IsClass
        && type.Namespace?.StartsWith("Crusaders.Mainframe.Api", StringComparison.Ordinal) == true
        && type.GetMethod("<Clone>$") is not null;

    private static readonly ConcurrentDictionary<Type, PropertyInfo[]> TextProperties = new();

    private static PropertyInfo[] TextPropertiesOf(Type type) =>
    [
        .. type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where(p => p.GetIndexParameters().Length == 0
                && (p.PropertyType == typeof(string) || typeof(IEnumerable<string?>).IsAssignableFrom(p.PropertyType))),
    ];
}
