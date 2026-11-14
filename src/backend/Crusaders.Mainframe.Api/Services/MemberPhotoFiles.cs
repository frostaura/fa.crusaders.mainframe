using System.Text.RegularExpressions;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The stored photo files under <c>Media:StoragePath</c>: the one place that writes, names, checks
/// and removes them.
///
/// <para>
/// <b>Only a URL this product issued is ever honoured</b> — <c>/uploads/{club}/photos/{32 hex}.{ext}</c>,
/// inside that club's own photo directory. Registration and the profile accept nothing else
/// (BP-06): an applicant could store <c>https://evil.example/pixel.png</c> or <c>javascript:</c> as
/// their photo, and every admin and member whose screen drew that face fetched the stranger's URL,
/// announcing where and when they opened the console.
/// </para>
///
/// <para>
/// <b>What is stored is what the bytes are, not what the client said</b> (BP-04). The upload used to
/// trust the declared <c>Content-Type</c>, so any bytes labelled <c>image/jpeg</c> were kept; the
/// file's first bytes now decide its type, and anything that is not a JPEG, PNG, WebP or GIF is
/// refused. The anonymous upload is bounded three ways: the auth rate limit on the route, a ceiling
/// on what one club's photo directory may take in within <see cref="RecentWindow"/>
/// (<c>Uploads:RecentBytesPerClub</c>), and <see cref="PhotoOrphanSweepWorker"/>, which deletes a
/// file nobody references once it is older than <c>Uploads:OrphanAfterMinutes</c>. The two numbers
/// are deployment configuration, not <c>tenant_settings</c>, for the reason the rate limits are:
/// they protect the disk every club shares, so a club must not be able to raise its own.
/// </para>
/// </summary>
public sealed partial class MemberPhotoFiles
{
    /// <summary>The largest photo accepted. The PWA re-encodes to at most 4 MB before it uploads.</summary>
    public const long MaxBytes = 5 * 1024 * 1024;

    /// <summary>How far back the per-club intake ceiling looks.</summary>
    public static readonly TimeSpan RecentWindow = TimeSpan.FromHours(2);

    private const long DefaultRecentBytesPerClub = 100L * 1024 * 1024;
    private const int DefaultOrphanAfterMinutes = 60;

    private readonly IConfiguration _config;
    private readonly ILogger<MemberPhotoFiles> _logger;

    public MemberPhotoFiles(IConfiguration config, ILogger<MemberPhotoFiles> logger)
    {
        _config = config; _logger = logger;
    }

    [GeneratedRegex("^[0-9a-f]{32}\\.(jpg|png|webp|gif)$", RegexOptions.CultureInvariant)]
    private static partial Regex IssuedName();

    /// <summary>The media root, as configured.</summary>
    public string Root => Path.GetFullPath(_config["Media:StoragePath"] ?? "./media");

    /// <summary>How old an unreferenced file must be before the sweep removes it.</summary>
    public TimeSpan OrphanAfter =>
        TimeSpan.FromMinutes(Math.Max(5, _config.GetValue("Uploads:OrphanAfterMinutes", DefaultOrphanAfterMinutes)));

    private long RecentBytesPerClub => Math.Max(MaxBytes, _config.GetValue("Uploads:RecentBytesPerClub", DefaultRecentBytesPerClub));

    /// <summary>The URL prefix every photo of this club carries.</summary>
    public static string PrefixOf(string tenantSlug) => $"/uploads/{tenantSlug}/photos/";

    /// <summary>True for a URL this product issued to THIS club — shape only, not existence.</summary>
    public static bool IsIssued(string tenantSlug, string? url)
    {
        var prefix = PrefixOf(tenantSlug);
        return !string.IsNullOrEmpty(url) && url.StartsWith(prefix, StringComparison.Ordinal)
            && IssuedName().IsMatch(url[prefix.Length..]);
    }

    /// <summary>True when <paramref name="url"/> is issued to this club and its file is on disk.</summary>
    public bool Exists(string tenantSlug, string? url) => FullPathOf(tenantSlug, url) is { } path && File.Exists(path);

    /// <summary>
    /// Why a photo URL offered by a client cannot be a member's photo, or null when it can:
    /// <c>photo_required</c>, <c>photo_url_invalid</c> (not one we issued to this club) or
    /// <c>photo_missing</c> (issued, but the file is gone — swept, or never uploaded).
    /// </summary>
    public string? Problem(string tenantSlug, string? url)
    {
        if (string.IsNullOrWhiteSpace(url)) return "photo_required";
        if (!IsIssued(tenantSlug, url.Trim())) return "photo_url_invalid";
        return Exists(tenantSlug, url.Trim()) ? null : "photo_missing";
    }

    /// <summary>The image type the bytes are, as a file extension, or null when they are none we keep.</summary>
    public static string? Sniff(ReadOnlySpan<byte> head)
    {
        if (head.Length >= 3 && head[0] == 0xFF && head[1] == 0xD8 && head[2] == 0xFF) return "jpg";
        if (head.Length >= 8 && head[..8].SequenceEqual(new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A })) return "png";
        if (head.Length >= 6 && (head[..6].SequenceEqual("GIF87a"u8) || head[..6].SequenceEqual("GIF89a"u8))) return "gif";
        if (head.Length >= 12 && head[..4].SequenceEqual("RIFF"u8) && head[8..12].SequenceEqual("WEBP"u8)) return "webp";
        return null;
    }

    /// <summary>What a save did: the URL, or the refusal code and the status to answer it with.</summary>
    public sealed record SaveResult(string? Url, string? Error, int Status, long Bytes)
    {
        public bool Ok => Url is not null;
    }

    /// <summary>
    /// Stores one uploaded photo for the club, after checking its size, its bytes and the club's
    /// recent intake. The caller answers <see cref="SaveResult.Error"/> with <see cref="SaveResult.Status"/>.
    /// </summary>
    public async Task<SaveResult> SaveAsync(string tenantSlug, IFormFile? file, CancellationToken ct)
    {
        if (file is null || file.Length == 0) return new SaveResult(null, "file_missing", 400, 0);
        if (file.Length > MaxBytes) return new SaveResult(null, "file_too_large", 400, file.Length);

        var head = new byte[12];
        int read;
        await using (var probe = file.OpenReadStream()) read = await probe.ReadAtLeastAsync(head, head.Length, throwOnEndOfStream: false, ct);
        if (Sniff(head.AsSpan(0, read)) is not { } ext) return new SaveResult(null, "unsupported_content_type", 400, file.Length);

        var dir = DirectoryOf(tenantSlug);
        Directory.CreateDirectory(dir);
        if (RecentBytes(dir) + file.Length > RecentBytesPerClub)
        {
            _logger.LogWarning("Photo intake for club {Slug} is past its {Window} ceiling; refusing uploads for now", tenantSlug, RecentWindow);
            return new SaveResult(null, "uploads_paused", 503, file.Length);
        }

        var name = $"{Guid.NewGuid():N}.{ext}";
        await using (var fs = File.Create(Path.Combine(dir, name)))
        await using (var src = file.OpenReadStream())
        {
            await src.CopyToAsync(fs, ct);
        }

        return new SaveResult(PrefixOf(tenantSlug) + name, null, 200, file.Length);
    }

    /// <summary>Removes a photo this product issued, best effort: a file that cannot go is logged.</summary>
    public void TryDelete(string tenantSlug, string? photoUrl)
    {
        if (FullPathOf(tenantSlug, photoUrl) is not { } full) return;
        try
        {
            if (File.Exists(full)) File.Delete(full);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Could not remove photo {Url}", photoUrl);
        }
    }

    /// <summary>
    /// Every club directory under the media root that holds photos, as (slug, files older than
    /// <paramref name="olderThan"/>) — what the orphan sweep considers.
    /// </summary>
    public IEnumerable<(string Slug, IReadOnlyList<string> Names)> StaleFiles(DateTimeOffset olderThan)
    {
        if (!Directory.Exists(Root)) yield break;
        foreach (var clubDir in Directory.EnumerateDirectories(Root))
        {
            var photos = Path.Combine(clubDir, "photos");
            if (!Directory.Exists(photos)) continue;
            var names = new DirectoryInfo(photos).EnumerateFiles()
                .Where(f => f.LastWriteTimeUtc < olderThan.UtcDateTime)
                .Select(f => f.Name)
                .ToList();
            if (names.Count > 0) yield return (Path.GetFileName(clubDir), names);
        }
    }

    private string DirectoryOf(string tenantSlug) => Path.GetFullPath(Path.Combine(Root, tenantSlug, "photos"));

    private string? FullPathOf(string tenantSlug, string? url)
    {
        if (string.IsNullOrWhiteSpace(url) || !IsIssued(tenantSlug, url)) return null;
        var dir = DirectoryOf(tenantSlug);
        var full = Path.GetFullPath(Path.Combine(dir, url[PrefixOf(tenantSlug).Length..]));
        return full.StartsWith(dir + Path.DirectorySeparatorChar, StringComparison.Ordinal) ? full : null;
    }

    private static long RecentBytes(string dir)
    {
        var since = DateTime.UtcNow - RecentWindow;
        return new DirectoryInfo(dir).EnumerateFiles().Where(f => f.LastWriteTimeUtc >= since).Sum(f => f.Length);
    }
}
