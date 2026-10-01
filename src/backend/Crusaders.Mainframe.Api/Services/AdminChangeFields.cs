namespace Crusaders.Mainframe.Api.Services;

/// <summary>Shared by the writers that snapshot an entity whole and store only what an edit changed.</summary>
public static class AdminChangeFields
{
    /// <summary>
    /// Only the fields whose values differ, each side — an edit that changed nothing comes back
    /// empty, and its writer records nothing.
    /// </summary>
    public static (Dictionary<string, object?> Before, Dictionary<string, object?> After) Changed(
        IReadOnlyDictionary<string, object?> before, IReadOnlyDictionary<string, object?> after)
    {
        var keys = after.Keys.Where(k => !Equals(before.GetValueOrDefault(k), after[k])).ToList();
        return (keys.ToDictionary(k => k, k => before.GetValueOrDefault(k)), keys.ToDictionary(k => k, k => after[k]));
    }
}
