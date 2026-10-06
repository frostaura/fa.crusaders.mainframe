namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The stored photo files under <c>Media:StoragePath</c>, for the one caller that removes a member's
/// photo on purpose: deleting the member.
///
/// <para>
/// Only a URL this product issued is touched — <c>/uploads/{club}/photos/{one name}</c> — and only
/// inside that club's own photo directory, by the same containment rule the registration path's
/// orphan clean-up uses (<c>AuthService.RemoveOrphanedPhotoAsync</c>). A photo stored inline as a
/// data URI has no file; clearing the column is all its deletion takes. Best effort: a file that
/// cannot be removed is logged, never a failed deletion — the row no longer points at it.
/// </para>
/// </summary>
public sealed class MemberPhotoFiles
{
    private readonly IConfiguration _config;
    private readonly ILogger<MemberPhotoFiles> _logger;

    public MemberPhotoFiles(IConfiguration config, ILogger<MemberPhotoFiles> logger)
    {
        _config = config; _logger = logger;
    }

    public void TryDelete(string tenantSlug, string? photoUrl)
    {
        var prefix = $"/uploads/{tenantSlug}/photos/";
        if (string.IsNullOrWhiteSpace(photoUrl) || !photoUrl.StartsWith(prefix, StringComparison.Ordinal)) return;

        var name = photoUrl[prefix.Length..];
        if (name.Length == 0 || name.Contains('/') || name.Contains('\\') || name.Contains("..")) return;

        try
        {
            var dir = Path.GetFullPath(Path.Combine(_config["Media:StoragePath"] ?? "./media", tenantSlug, "photos"));
            var full = Path.GetFullPath(Path.Combine(dir, name));
            if (!full.StartsWith(dir + Path.DirectorySeparatorChar, StringComparison.Ordinal)) return;
            if (File.Exists(full)) File.Delete(full);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Could not remove a deleted member's photo {Url}", photoUrl);
        }
    }
}
