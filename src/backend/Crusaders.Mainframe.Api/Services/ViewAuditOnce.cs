using System.Collections.Concurrent;
using Crusaders.Mainframe.Api.Endpoints;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// One privacy row per VIEW, not per HTTP request (review round 1, B19).
///
/// <para>
/// <b>What was happening.</b> Opening a member's activity or door history wrote two identical
/// change-record rows: the page's data effect runs twice under React's development StrictMode,
/// and any client retry or refocus re-fetch does the same in production. The rows are
/// undeletable by design, so every duplicate is a permanent line saying an admin looked twice
/// when they looked once.
/// </para>
///
/// <para>
/// <b>The rule.</b> The same admin, asking the same question (path and query string, exactly)
/// about the same member within <see cref="Window"/> of the last time it was recorded, is the
/// same view — nothing new was learned, so nothing new is written. A different page (cursor),
/// range, filter or member is a new question and is recorded. Exports are never folded: a
/// download is its own act. Process-local, which on the single backend container is the whole
/// deployment; on any other topology the worst case is the old duplicate row, never a lost one.
/// </para>
/// </summary>
public sealed class ViewAuditOnce
{
    public static readonly TimeSpan Window = TimeSpan.FromSeconds(30);

    private readonly TimeProvider _clock;
    private readonly ConcurrentDictionary<string, DateTimeOffset> _seen = new();
    private readonly object _gate = new();

    public ViewAuditOnce(TimeProvider clock) => _clock = clock;

    /// <summary>True when this view should be recorded — the first of its kind inside the window.</summary>
    public bool ShouldRecord(HttpContext ctx, string action, Guid subjectUserId)
    {
        var now = _clock.GetUtcNow();
        var tenant = ctx.User.FindFirst("tenant_id")?.Value ?? "";
        var key = string.Join('|', tenant, ctx.User.Id()?.ToString("N") ?? "", action, subjectUserId.ToString("N"),
            ctx.Request.Path.Value ?? "", ctx.Request.QueryString.Value ?? "");

        lock (_gate)
        {
            if (_seen.Count > 4096) Prune(now);
            if (_seen.TryGetValue(key, out var at) && now - at < Window) return false;
            _seen[key] = now;
            return true;
        }
    }

    private void Prune(DateTimeOffset now)
    {
        foreach (var (key, at) in _seen)
        {
            if (now - at >= Window) _seen.TryRemove(key, out _);
        }
    }
}
