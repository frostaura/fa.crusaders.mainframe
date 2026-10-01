using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// The club's minutes packages, as its admins define them (P13 §3.5): list, create, edit and
/// archive. A package is never deleted — purchase rows name it — and its group is fixed once it is
/// created, so a shelf never silently moves a package between audiences.
///
/// <para>
/// <b>Editing a package never changes an open checkout.</b> A checkout is locked on its own
/// <c>pending_topups</c> row (<see cref="PackageEndpoints.Lock"/>), and the ITN credits that row.
/// </para>
///
/// <para>
/// Every write records in its own save, area <c>credit</c>, subject kind <c>package</c>, the
/// package's whole <c>{name, minutes, price_zar, group, sort_order, status}</c> on each side. A
/// write that changes nothing records nothing.
/// </para>
/// </summary>
public static class AdminPackageEndpoints
{
    /// <summary>The most ACTIVE packages one club may have — a shelf, not a catalogue.</summary>
    public const int MaxActivePackages = 50;

    private const string UniqueNameIndex = "IX_minute_packages_TenantId_GroupId_Name";

    public static IEndpointRouteBuilder MapAdminPackageEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1/admin/packages")
            .RequireAuthorization(p => p.RequireRole("admin"))
            .RequireRateLimiting(Security.RateLimitPolicies.Writes);

        g.MapGet("/", ListAsync);
        g.MapPost("/", CreateAsync);
        g.MapPut("/{id:guid}", UpdateAsync);
        g.MapPost("/{id:guid}/archive", ArchiveAsync);
        return app;
    }

    private static async Task<IResult> ListAsync(string? status, MainframeDbContext db, CancellationToken ct)
    {
        var filter = (status ?? "active").Trim().ToLowerInvariant();
        if (filter is not ("active" or "archived" or "all"))
            return Results.BadRequest(new { error = "status_invalid", valid = new[] { "active", "archived", "all" } });

        var query = db.MinutePackages.AsNoTracking();
        if (filter == "active") query = query.Where(p => p.Status == MinutePackageStatus.Active);
        if (filter == "archived") query = query.Where(p => p.Status == MinutePackageStatus.Archived);
        var packages = await query.ToListAsync(ct);

        var groups = await GroupsAsync(db, packages, ct);
        var ordered = packages
            .OrderBy(p => p.GroupId is null ? 0 : 1)
            .ThenBy(p => p.GroupId is { } gid && groups.TryGetValue(gid, out var grp) ? grp.SortOrder : 0)
            .ThenBy(p => p.GroupId is { } gid2 && groups.TryGetValue(gid2, out var grp2) ? grp2.Name : "", StringComparer.Ordinal)
            .ThenBy(p => p.SortOrder).ThenBy(p => p.Minutes).ThenBy(p => p.Name, StringComparer.Ordinal)
            .Select(p => Wire(p, groups))
            .ToList();
        return Results.Ok(new { packages = ordered });
    }

    private static async Task<IResult> CreateAsync(
        PackageRequest req, HttpContext ctx, MainframeDbContext db, Multitenancy.ITenantContext tenant,
        AdminChangeRecorder changes, CancellationToken ct)
    {
        if (PackageValidation.Refuse(req) is { } refusal) return refusal;
        var fields = PackageValidation.Fields(req);

        var groupId = PackageValidation.GroupIdOf(req);
        if (await RefuseGroupAsync(db, groupId, ct) is { } badGroup) return badGroup;

        var active = await db.MinutePackages.CountAsync(p => p.Status == MinutePackageStatus.Active, ct);
        if (active >= MaxActivePackages)
            return Conflict(new { error = "package_limit_reached", max = MaxActivePackages });
        if (await NameTakenAsync(db, groupId, fields.Name, null, ct))
            return Conflict(new { error = "package_name_taken", name = fields.Name });

        var actor = ctx.User.Id() ?? Guid.Empty;
        var package = new MinutePackage
        {
            TenantId = tenant.TenantId,
            Name = fields.Name,
            Minutes = fields.Minutes,
            PriceZar = fields.PriceZar,
            SortOrder = fields.SortOrder ?? 0,
            GroupId = groupId,
            CreatedByUserId = actor,
        };
        db.MinutePackages.Add(package);

        var groups = await GroupsAsync(db, [package], ct);
        await changes.StageAsync(Change(AdminChangeActions.PackageCreated, actor, package, null, Snapshot(package, groups), req.Reason), ct);
        return await SaveAsync(db, package, fields.Name, ct) ?? Results.Created($"/api/v1/admin/packages/{package.Id}", Wire(package, groups));
    }

    private static async Task<IResult> UpdateAsync(
        Guid id, PackageRequest req, HttpContext ctx, MainframeDbContext db, AdminChangeRecorder changes, CancellationToken ct)
    {
        var package = await db.MinutePackages.FirstOrDefaultAsync(p => p.Id == id, ct);
        if (package is null) return Results.NotFound();
        if (package.Status == MinutePackageStatus.Archived) return Conflict(new { error = "package_archived" });

        if (PackageValidation.Refuse(req) is { } refusal) return refusal;
        if (PackageValidation.NamesGroup(req) && PackageValidation.GroupIdOf(req) != package.GroupId)
            return Conflict(new { error = "package_group_immutable" });

        var fields = PackageValidation.Fields(req);
        if (await NameTakenAsync(db, package.GroupId, fields.Name, package.Id, ct))
            return Conflict(new { error = "package_name_taken", name = fields.Name });

        var groups = await GroupsAsync(db, [package], ct);
        var before = Snapshot(package, groups);
        package.Name = fields.Name;
        package.Minutes = fields.Minutes;
        package.PriceZar = fields.PriceZar;
        package.SortOrder = fields.SortOrder ?? package.SortOrder;
        var after = Snapshot(package, groups);
        if (SameSnapshot(before, after)) return Results.Ok(Wire(package, groups));

        package.UpdatedAt = DateTimeOffset.UtcNow;
        var actor = ctx.User.Id() ?? Guid.Empty;
        await changes.StageAsync(Change(AdminChangeActions.PackageUpdated, actor, package, before, after, req.Reason), ct);
        return await SaveAsync(db, package, fields.Name, ct) ?? Results.Ok(Wire(package, groups));
    }

    private static async Task<IResult> ArchiveAsync(
        Guid id, ArchivePackageRequest? req, HttpContext ctx, MainframeDbContext db, AdminChangeRecorder changes, CancellationToken ct)
    {
        var package = await db.MinutePackages.FirstOrDefaultAsync(p => p.Id == id, ct);
        if (package is null) return Results.NotFound();

        var groups = await GroupsAsync(db, [package], ct);
        // Idempotent: archiving an archived package answers as it stands and records nothing twice.
        if (package.Status == MinutePackageStatus.Archived) return Results.Ok(Wire(package, groups));

        var before = Snapshot(package, groups);
        package.Status = MinutePackageStatus.Archived;
        package.UpdatedAt = DateTimeOffset.UtcNow;
        await changes.StageAsync(Change(
            AdminChangeActions.PackageArchived, ctx.User.Id() ?? Guid.Empty, package, before, Snapshot(package, groups), req?.Reason), ct);
        await db.SaveChangesAsync(ct);
        return Results.Ok(Wire(package, groups));
    }

    /// <summary>Saves, turning a lost race for the unique active name into the refusal a sequential request gets.</summary>
    private static async Task<IResult?> SaveAsync(MainframeDbContext db, MinutePackage package, string name, CancellationToken ct)
    {
        try
        {
            await db.SaveChangesAsync(ct);
            return null;
        }
        catch (DbUpdateException ex) when (ex.InnerException is Npgsql.PostgresException { SqlState: "23505", ConstraintName: UniqueNameIndex })
        {
            db.ChangeTracker.Clear();
            return Conflict(new { error = "package_name_taken", name });
        }
    }

    /// <summary>
    /// A package's group must be an ACTIVE group of this club. The tenant filter makes another
    /// club's group simply not exist here, so it is refused like any unknown id.
    /// </summary>
    private static async Task<IResult?> RefuseGroupAsync(MainframeDbContext db, Guid? groupId, CancellationToken ct)
    {
        if (groupId is not { } id) return null;
        var ok = await db.MemberGroups.AnyAsync(g => g.Id == id && g.Status == MemberGroupStatus.Active, ct);
        return ok ? null : Results.BadRequest(new { error = "package_group_invalid" });
    }

    /// <summary>Whether an ACTIVE package on the same shelf already has this name, case-insensitively.</summary>
    private static Task<bool> NameTakenAsync(MainframeDbContext db, Guid? groupId, string name, Guid? excluding, CancellationToken ct)
    {
        var lower = name.ToLowerInvariant();
        return db.MinutePackages.AnyAsync(
            p => p.Status == MinutePackageStatus.Active && p.GroupId == groupId && p.Name.ToLower() == lower
                 && (excluding == null || p.Id != excluding), ct);
    }

    private static async Task<Dictionary<Guid, MemberGroup>> GroupsAsync(
        MainframeDbContext db, IEnumerable<MinutePackage> packages, CancellationToken ct)
    {
        var ids = packages.Where(p => p.GroupId is not null).Select(p => p.GroupId!.Value).Distinct().ToList();
        if (ids.Count == 0) return [];
        return await db.MemberGroups.AsNoTracking().Where(g => ids.Contains(g.Id)).ToDictionaryAsync(g => g.Id, ct);
    }

    /// <summary>
    /// What the change record stores on each side (P13 §3.5). <c>group</c> is the group's NAME —
    /// a record is read in words, and an id means nothing to the person reading it — or null for
    /// a club package.
    /// </summary>
    internal static Dictionary<string, object?> Snapshot(MinutePackage p, IReadOnlyDictionary<Guid, MemberGroup> groups)
    {
        return new Dictionary<string, object?>
        {
            ["name"] = p.Name,
            ["minutes"] = p.Minutes,
            ["price_zar"] = p.PriceZar,
            ["group"] = p.GroupId is { } id && groups.TryGetValue(id, out var g) ? g.Name : null,
            ["sort_order"] = p.SortOrder,
            ["status"] = StatusWord(p.Status),
        };
    }

    private static bool SameSnapshot(Dictionary<string, object?> a, Dictionary<string, object?> b)
        => a.All(kv => Equals(kv.Value, b[kv.Key]));

    private static AdminChange Change(
        string action, Guid actor, MinutePackage package, object? before, object? after, string? reason)
    {
        return new AdminChange(
            Action: action,
            ActorUserId: actor,
            SubjectKind: AdminChangeSubjects.Package,
            SubjectId: package.Id,
            SubjectLabel: package.Name,
            Reason: string.IsNullOrWhiteSpace(reason) ? null : reason.Trim(),
            Before: before,
            After: after);
    }

    private static string StatusWord(MinutePackageStatus status)
        => status == MinutePackageStatus.Active ? "active" : "archived";

    /// <summary>One package as the console reads it (P13 §3.5).</summary>
    internal static object Wire(MinutePackage p, IReadOnlyDictionary<Guid, MemberGroup> groups)
    {
        return new
        {
            id = p.Id,
            name = p.Name,
            minutes = p.Minutes,
            price_zar = p.PriceZar,
            group = p.GroupId is { } id && groups.TryGetValue(id, out var g) ? new { id = g.Id, name = g.Name } : null,
            sort_order = p.SortOrder,
            status = StatusWord(p.Status),
            created_at = p.CreatedAt,
            updated_at = p.UpdatedAt,
        };
    }

    private static IResult Conflict(object body) => Results.Json(body, statusCode: StatusCodes.Status409Conflict);
}

/// <summary>
/// A package body. The numbers bind as raw JSON so a fraction of a minute (<c>30.5</c>) or a
/// price in fractions of a cent is refused with the named error, never truncated or rounded into
/// something the admin did not type. <see cref="GroupId"/> distinguishes absent (on a PUT:
/// unchanged) from an explicit null (the club shelf).
/// </summary>
public sealed record PackageRequest(
    string? Name = null,
    JsonElement Minutes = default,
    JsonElement PriceZar = default,
    JsonElement GroupId = default,
    JsonElement SortOrder = default,
    string? Reason = null);

/// <summary>The optional reason an archive carries; none is required (P13 §4.5).</summary>
public sealed record ArchivePackageRequest(string? Reason = null);

/// <summary>A validated package body.</summary>
internal sealed record PackageFields(string Name, int Minutes, decimal PriceZar, int? SortOrder);

/// <summary>Every refusal a package body can earn (P13 §3.5), in one place.</summary>
internal static class PackageValidation
{
    public static IResult? Refuse(PackageRequest req)
    {
        var name = req.Name?.Trim() ?? "";
        if (name.Length is < 1 or > MinutePackage.NameMaxLength)
            return Results.BadRequest(new { error = "package_name_invalid", min = 1, max = MinutePackage.NameMaxLength });
        if (MinutesOf(req.Minutes) is null)
            return Results.BadRequest(new { error = "package_minutes_invalid", min = MinutePackage.MinMinutes, max = MinutePackage.MaxMinutes });
        if (PriceOf(req.PriceZar) is null)
            return Results.BadRequest(new { error = "package_price_invalid", min_exclusive = 0, max = MinutePackage.MaxPriceZar, decimals = 2 });
        if (req.SortOrder.ValueKind != JsonValueKind.Undefined && SortOf(req.SortOrder) is null)
            return Results.BadRequest(new { error = "package_sort_order_invalid", min = 0 });
        if (NamesGroup(req) && req.GroupId.ValueKind is not (JsonValueKind.Null or JsonValueKind.String))
            return Results.BadRequest(new { error = "package_group_invalid" });
        if (req.GroupId.ValueKind == JsonValueKind.String && !Guid.TryParse(req.GroupId.GetString(), out _))
            return Results.BadRequest(new { error = "package_group_invalid" });
        return null;
    }

    /// <summary>The validated fields. Only called after <see cref="Refuse"/> returned null.</summary>
    public static PackageFields Fields(PackageRequest req)
        => new(req.Name!.Trim(), MinutesOf(req.Minutes)!.Value, PriceOf(req.PriceZar)!.Value,
            req.SortOrder.ValueKind == JsonValueKind.Undefined ? null : SortOf(req.SortOrder));

    /// <summary>Whether the body named a group at all (an explicit null counts).</summary>
    public static bool NamesGroup(PackageRequest req) => req.GroupId.ValueKind != JsonValueKind.Undefined;

    /// <summary>The group the body names; null for absent, JSON null, or anything unparseable.</summary>
    public static Guid? GroupIdOf(PackageRequest req)
        => req.GroupId.ValueKind == JsonValueKind.String && Guid.TryParse(req.GroupId.GetString(), out var id) ? id : null;

    private static int? MinutesOf(JsonElement e)
    {
        if (e.ValueKind != JsonValueKind.Number || !e.TryGetInt32(out var v)) return null;
        return v is >= MinutePackage.MinMinutes and <= MinutePackage.MaxMinutes ? v : null;
    }

    private static decimal? PriceOf(JsonElement e)
    {
        if (e.ValueKind != JsonValueKind.Number || !e.TryGetDecimal(out var v)) return null;
        if (v <= 0m || v > MinutePackage.MaxPriceZar) return null;
        return decimal.Round(v, 2) == v ? v : null;
    }

    private static int? SortOf(JsonElement e)
        => e.ValueKind == JsonValueKind.Number && e.TryGetInt32(out var v) && v >= 0 ? v : null;
}
