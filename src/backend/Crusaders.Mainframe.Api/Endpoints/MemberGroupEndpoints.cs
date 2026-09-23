using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// GOAL item 3's admin surface: create a group, give it windows, a rate and caps, and put
/// members in it.
///
/// <para>
/// <b>A member never calls any of these.</b> Their own rules reach them through
/// <c>GET /api/v1/schedule</c>'s <c>rules</c> block, which carries group NAME and DESCRIPTION
/// only — never who else is in a group. That is the booking grid's standing rule ("photo + name
/// only") applied to a second kind of fact about other members.
/// </para>
///
/// <para>
/// <b>Deleting a group with members is refused, not cascaded.</b> A cascade silently changes what
/// every one of those members may book and what they pay, with no screen showing it. Archiving is
/// the escape: an archived group stops contributing to a member's rules while keeping its rows,
/// so the change is reversible and a later reader can say what it was.
/// </para>
/// </summary>
public static class MemberGroupEndpoints
{
    public static IEndpointRouteBuilder MapMemberGroupEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1/admin/member-groups")
            .RequireAuthorization(p => p.RequireRole("admin"));

        g.MapGet("/", ListAsync);
        g.MapPost("/", CreateAsync);
        g.MapPatch("/{id:guid}", PatchAsync);
        g.MapDelete("/{id:guid}", DeleteAsync);
        g.MapGet("/{id:guid}/members", MembersAsync);
        g.MapPost("/{id:guid}/members", AddMembersAsync);
        g.MapDelete("/{id:guid}/members/{userId:guid}", RemoveMemberAsync);

        // What WOULD apply, saved nothing. §4.3's third mitigation for the empty-intersection
        // hazard: the console can show an admin the result of a membership change before they
        // commit it, rather than a member discovering it as a grid on which nothing is bookable.
        app.MapPost("/api/v1/admin/member-groups/preview", PreviewAsync)
            .RequireAuthorization(p => p.RequireRole("admin"));

        app.MapGet("/api/v1/admin/members/{userId:guid}/booking-rules", RulesForMemberAsync)
            .RequireAuthorization(p => p.RequireRole("admin"));

        return app;
    }

    private static async Task<IResult> ListAsync(
        MainframeDbContext db, TenantSettingsAccessor settings, CancellationToken ct)
    {
        var groups = await db.MemberGroups.AsNoTracking()
            .OrderBy(x => x.SortOrder).ThenBy(x => x.Name).ToListAsync(ct);
        var ids = groups.Select(x => x.Id).ToList();

        var windows = await db.MemberGroupWindows.AsNoTracking()
            .Where(w => ids.Contains(w.GroupId)).ToListAsync(ct);
        var counts = await db.MemberGroupMembers.AsNoTracking()
            .Where(m => ids.Contains(m.GroupId))
            .GroupBy(m => m.GroupId)
            .Select(x => new { GroupId = x.Key, Count = x.Count() })
            .ToDictionaryAsync(x => x.GroupId, x => x.Count, ct);

        var s = await settings.GetAsync(ct);
        var exampleCourtPrice = MoneySettings.SlicePriceCredits(s);

        return Results.Ok(new
        {
            groups = groups.Select(x => Wire(x, windows, counts, exampleCourtPrice)).ToList(),
        });
    }

    private static object Wire(
        MemberGroup group,
        IReadOnlyList<MemberGroupWindow> windows,
        IReadOnlyDictionary<Guid, int> counts,
        decimal exampleCourtPrice)
    {
        var rules = ToRules(group, windows);
        return new
        {
            id = group.Id,
            name = group.Name,
            description = group.Description,
            status = group.Status.ToString().ToLowerInvariant(),
            sort_order = group.SortOrder,
            is_system_default = group.IsSystemDefault,
            // D2: the tariff a group carries now that it replaced the member class. A null rate
            // inherits the club's credits_per_zar_regular; system_key is "league" on the group
            // that replaced LeagueOrSenior, null on every group an admin made.
            system_key = group.SystemKey,
            credits_per_zar = group.CreditsPerZar,
            peak_priority = group.PeakPriority,
            pricing = new
            {
                mode = ModeName(group.PricingMode),
                multiplier_bps = group.PriceMultiplierBps,
                flat_slice_price_credits = group.FlatSlicePriceCredits,
                // What this group would actually charge on a court at the club's default price —
                // so an admin editing a multiplier reads credits rather than basis points.
                effective_example_credits = GroupRules.PriceFor(rules, exampleCourtPrice),
            },
            caps = new
            {
                max_slots_per_day = group.MaxSlotsPerDay,
                max_minutes_per_day = group.MaxMinutesPerDay,
                advance_booking_days = group.AdvanceBookingDays,
            },
            windows = windows.Where(w => w.GroupId == group.Id)
                .OrderBy(w => w.DayOfWeek).ThenBy(w => w.StartMinute)
                .Select(w => new
                {
                    day = OperatingHours.DayKeys[(int)w.DayOfWeek],
                    start = BookingService.MinutesToHhmm(w.StartMinute),
                    end = BookingService.MinutesToHhmm(w.EndMinute),
                }).ToList(),
            member_count = counts.GetValueOrDefault(group.Id),
        };
    }

    private static MemberGroupRules ToRules(MemberGroup g, IReadOnlyList<MemberGroupWindow> windows)
        => new(g.Id, g.Name, g.Description, g.PricingMode, g.PriceMultiplierBps, g.FlatSlicePriceCredits,
            g.MaxSlotsPerDay, g.MaxMinutesPerDay, g.AdvanceBookingDays,
            HasAnyWindows: windows.Any(w => w.GroupId == g.Id),
            WindowsForDay: []);

    // Block body, not an expression one: lizard's C# parser reads the `{` of a switch or an
    // object initialiser as the END of the function and dumps the rest of the file into a
    // *global* pseudo-function whose length trips `-L 200`. See memory/gotchas.md.
    private static string ModeName(GroupPricingMode mode)
    {
        return mode switch
        {
            GroupPricingMode.Multiplier => "multiplier",
            GroupPricingMode.FlatPerSlice => "flat_per_slice",
            _ => "inherit_court",
        };
    }

    private static async Task<IResult> CreateAsync(
        MemberGroupRequest req, [AsParameters] GroupDeps deps, HttpContext ctx, CancellationToken ct)
    {
        var (db, tenant, changes) = (deps.Db, deps.Tenant, deps.Changes);
        if (MemberGroupValidation.Refuse(req, forCreate: true) is { } bad) return bad;

        if (await db.MemberGroups.CountAsync(ct) >= GroupRules.MaxGroupsPerTenant)
        {
            return Results.BadRequest(new { error = "group_limit_reached", max = GroupRules.MaxGroupsPerTenant });
        }

        var name = req.Name!.Trim();
        if (await NameTakenAsync(db, name, excluding: null, ct))
        {
            return Results.Json(new { error = "group_name_taken", name }, statusCode: StatusCodes.Status409Conflict);
        }

        var group = new MemberGroup
        {
            TenantId = tenant.TenantId,
            Name = name,
            Description = req.Description?.Trim(),
            SortOrder = await db.MemberGroups.CountAsync(ct),
            CreatedByUserId = ctx.User.Id() ?? Guid.Empty,
        };
        Apply(group, req);
        db.MemberGroups.Add(group);

        var windows = MemberGroupValidation.Windows(req, tenant.TenantId, group.Id).ToList();
        foreach (var window in windows)
        {
            db.MemberGroupWindows.Add(window);
        }

        // Staged, so the record flushes with the group it describes.
        await changes.StageAsync(new AdminChange(
            Action: AdminChangeActions.GroupCreated,
            ActorUserId: ctx.User.Id() ?? Guid.Empty,
            SubjectKind: AdminChangeSubjects.Group,
            SubjectId: group.Id,
            SubjectLabel: group.Name,
            Reason: req.Reason?.Trim(),
            After: MemberGroupChanges.Snapshot(group, windows)), ct);

        await db.SaveChangesAsync(ct);
        return Results.Created($"/api/v1/admin/member-groups/{group.Id}", new { id = group.Id, name = group.Name });
    }

    private static async Task<IResult> PatchAsync(
        Guid id, MemberGroupRequest req, [AsParameters] GroupDeps deps, HttpContext ctx, CancellationToken ct)
    {
        var (db, tenant) = (deps.Db, deps.Tenant);
        if (MemberGroupValidation.Refuse(req, forCreate: false) is { } bad) return bad;

        var group = await db.MemberGroups.FirstOrDefaultAsync(x => x.Id == id, ct);
        if (group is null) return Results.NotFound();
        if (RefuseArchivingSystemGroup(group, req) is { } refused) return refused;

        // Read BEFORE anything is applied, windows only when this PATCH names them — a PATCH
        // that leaves the windows alone must not record them as changed or unchanged.
        var existingWindows = req.Windows is null
            ? null
            : await db.MemberGroupWindows.Where(w => w.GroupId == id).ToListAsync(ct);
        var before = MemberGroupChanges.Snapshot(group, existingWindows);
        var wasArchived = group.Status == MemberGroupStatus.Archived;

        if (req.Name is not null)
        {
            var name = req.Name.Trim();
            if (await NameTakenAsync(db, name, excluding: id, ct))
            {
                return Results.Json(new { error = "group_name_taken", name }, statusCode: StatusCodes.Status409Conflict);
            }
            group.Name = name;
        }
        if (req.Description is not null) group.Description = req.Description.Trim();
        if (req.Status is not null)
        {
            group.Status = req.Status.Trim().Equals("archived", StringComparison.OrdinalIgnoreCase)
                ? MemberGroupStatus.Archived
                : MemberGroupStatus.Active;
        }
        Apply(group, req);
        group.UpdatedAt = DateTimeOffset.UtcNow;

        // Windows replace wholesale when they are named at all, and are left alone when they are
        // not — the same omitted-means-unchanged rule the settings PUT uses, for the same reason:
        // the rates screen and the times screen are different forms.
        List<MemberGroupWindow>? newWindows = null;
        if (existingWindows is not null)
        {
            db.MemberGroupWindows.RemoveRange(existingWindows);
            newWindows = MemberGroupValidation.Windows(req, tenant.TenantId, id).ToList();
            foreach (var window in newWindows)
            {
                db.MemberGroupWindows.Add(window);
            }
        }

        await StagePatchChangeAsync(
            deps.Changes, ctx, new GroupPatchChange(group, req.Reason, before, newWindows, wasArchived), ct);

        await db.SaveChangesAsync(ct);
        return Results.Ok(new { id = group.Id, name = group.Name });
    }

    /// <summary>
    /// The league group cannot be archived, as it cannot be deleted (review D2-P2). Since D2 it
    /// carries the league top-up rate and peak priority, and an archived group contributes
    /// nothing — so one bare <c>{"status":"archived"}</c> would move every league member to the
    /// regular rate and out of the peak window, club-wide, with no reason asked for, while DELETE
    /// of the same group is refused. Same refusal as the delete. The seeded non-league group has
    /// no system key, carries no tariff, and stays archivable as it always was.
    /// </summary>
    private static IResult? RefuseArchivingSystemGroup(MemberGroup group, MemberGroupRequest req)
    {
        if (group.SystemKey is null || req.Status is null) return null;
        if (!req.Status.Trim().Equals("archived", StringComparison.OrdinalIgnoreCase)) return null;
        return Results.Json(new { error = "group_is_system_default" }, statusCode: StatusCodes.Status409Conflict);
    }

    /// <summary>
    /// One change-record row for one PATCH: <c>group.archived</c> when this edit archived the
    /// group, <c>group.updated</c> otherwise, and nothing at all when nothing changed.
    ///
    /// <para>
    /// <b>The archive's reason is recorded when sent, not yet demanded.</b>
    /// <see cref="AdminChangeActions.ReasonRequired"/> lists <c>group.archived</c>, but the
    /// Groups page in production archives with a bare <c>{status:"archived"}</c> and would start
    /// failing the moment this deployed. The facelift's Groups rebuild (P6) sends
    /// <c>reason</c>; enforcing it belongs to that change, in the same commit as the screen that
    /// asks for it.
    /// </para>
    /// </summary>
    private static async Task StagePatchChangeAsync(
        AdminChangeRecorder changes, HttpContext ctx, GroupPatchChange patch, CancellationToken ct)
    {
        var group = patch.Group;
        var (changedBefore, changedAfter) = MemberGroupChanges.Diff(
            patch.Before, MemberGroupChanges.Snapshot(group, patch.NewWindows));
        if (changedAfter.Count == 0) return;

        var archived = !patch.WasArchived && group.Status == MemberGroupStatus.Archived;
        await changes.StageAsync(new AdminChange(
            Action: archived ? AdminChangeActions.GroupArchived : AdminChangeActions.GroupUpdated,
            ActorUserId: ctx.User.Id() ?? Guid.Empty,
            SubjectKind: AdminChangeSubjects.Group,
            SubjectId: group.Id,
            SubjectLabel: group.Name,
            Reason: patch.Reason?.Trim(),
            Before: changedBefore,
            After: changedAfter), ct);
    }

    private static void Apply(MemberGroup group, MemberGroupRequest req)
    {
        // D2's two tariff fields. Both distinguish ABSENT (unchanged) from an explicit JSON null
        // (the rate: back to the club's default; peak: no say), because both are things an
        // admin means.
        if (req.EffectiveCreditsPerZar is { } rate) group.CreditsPerZar = rate.Value;
        if (req.EffectivePeakPriority is { } peak) group.PeakPriority = peak.Value;
        if (req.Pricing is { } pricing)
        {
            group.PricingMode = pricing.Mode switch
            {
                "multiplier" => GroupPricingMode.Multiplier,
                "flat_per_slice" => GroupPricingMode.FlatPerSlice,
                _ => GroupPricingMode.InheritCourt,
            };
            group.PriceMultiplierBps = pricing.MultiplierBps ?? 10_000;
            group.FlatSlicePriceCredits = pricing.FlatSlicePriceCredits;
        }
        if (req.Caps is { } caps)
        {
            group.MaxSlotsPerDay = caps.MaxSlotsPerDay;
            group.MaxMinutesPerDay = caps.MaxMinutesPerDay;
            group.AdvanceBookingDays = caps.AdvanceBookingDays;
        }
    }

    /// <summary>
    /// Case-insensitively, per tenant — the same test the functional unique index enforces, so
    /// the refusal an admin reads and the constraint that would fire cannot disagree.
    /// </summary>
    private static Task<bool> NameTakenAsync(MainframeDbContext db, string name, Guid? excluding, CancellationToken ct)
        => db.MemberGroups.AnyAsync(
            x => x.Name.ToLower() == name.ToLower() && (excluding == null || x.Id != excluding), ct);

    private static async Task<IResult> DeleteAsync(
        Guid id, MainframeDbContext db, AdminChangeRecorder changes, HttpContext ctx, CancellationToken ct)
    {
        var group = await db.MemberGroups.FirstOrDefaultAsync(x => x.Id == id, ct);
        if (group is null) return Results.NotFound();

        // A group with a system key is one the product itself relies on — the league group
        // replaced a member class (D2) — so it is protected exactly like the seeded pair.
        if (group.IsSystemDefault || group.SystemKey is not null)
        {
            return Results.Json(new { error = "group_is_system_default" }, statusCode: StatusCodes.Status409Conflict);
        }

        var memberCount = await db.MemberGroupMembers.CountAsync(m => m.GroupId == id, ct);
        if (memberCount > 0)
        {
            return Results.Json(
                new { error = "group_has_members", member_count = memberCount },
                statusCode: StatusCodes.Status409Conflict);
        }

        var windows = await db.MemberGroupWindows.Where(w => w.GroupId == id).ToListAsync(ct);
        await changes.StageAsync(new AdminChange(
            Action: AdminChangeActions.GroupDeleted,
            ActorUserId: ctx.User.Id() ?? Guid.Empty,
            SubjectKind: AdminChangeSubjects.Group,
            SubjectId: group.Id,
            SubjectLabel: group.Name,
            Before: MemberGroupChanges.Snapshot(group, windows)), ct);

        db.MemberGroupWindows.RemoveRange(windows);
        db.MemberGroups.Remove(group);
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    private static async Task<IResult> MembersAsync(Guid id, MainframeDbContext db, CancellationToken ct)
    {
        if (!await db.MemberGroups.AnyAsync(x => x.Id == id, ct)) return Results.NotFound();

        var rows = await db.MemberGroupMembers.AsNoTracking()
            .Where(m => m.GroupId == id)
            .OrderBy(m => m.AddedAt)
            .ToListAsync(ct);

        var userIds = rows.Select(r => r.UserId).ToList();
        var members = await db.Memberships.AsNoTracking()
            .Where(m => userIds.Contains(m.UserId))
            .ToDictionaryAsync(m => m.UserId, ct);

        return Results.Ok(new
        {
            members = rows.Select(r => new
            {
                user_id = r.UserId,
                name = members.GetValueOrDefault(r.UserId)?.FullName,
                membership_number = members.GetValueOrDefault(r.UserId)?.MembershipNumber,
                added_at = r.AddedAt,
            }).ToList(),
            total = rows.Count,
        });
    }

    private static async Task<IResult> AddMembersAsync(
        Guid id, GroupMembersRequest req, [AsParameters] GroupDeps deps, TenantSettingsAccessor settings,
        HttpContext ctx, CancellationToken ct)
    {
        var (db, tenant) = (deps.Db, deps.Tenant);
        var group = await db.MemberGroups.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id, ct);
        if (group is null) return Results.NotFound();

        var wanted = (req.UserIds ?? []).Distinct().ToList();
        if (wanted.Count > GroupRules.MaxMembersPerCall)
        {
            return Results.BadRequest(new { error = "too_many_members", max = GroupRules.MaxMembersPerCall });
        }

        // Per-item results, never all-or-nothing: an admin pasting forty membership numbers must
        // be told which one was not a member of this club rather than having the other
        // thirty-nine silently discarded.
        var already = await db.MemberGroupMembers.Where(m => m.GroupId == id).Select(m => m.UserId).ToListAsync(ct);
        var real = await db.Users.Where(u => wanted.Contains(u.Id)).Select(u => u.Id).ToListAsync(ct);

        var results = new List<object>(wanted.Count);
        var added = new List<Guid>();
        foreach (var userId in wanted)
        {
            if (!real.Contains(userId)) { results.Add(new { user_id = userId, result = "member_not_found" }); continue; }
            if (already.Contains(userId)) { results.Add(new { user_id = userId, result = "already_a_member" }); continue; }

            db.MemberGroupMembers.Add(new MemberGroupMember
            {
                TenantId = tenant.TenantId,
                GroupId = id,
                UserId = userId,
                AddedByUserId = ctx.User.Id() ?? Guid.Empty,
            });
            results.Add(new { user_id = userId, result = "added" });
            added.Add(userId);
        }

        // ONE row per call, naming everybody it added — the bulk-cancel discipline: one
        // decision, one row. A call that added nobody changed nobody's rules and records nothing.
        if (added.Count > 0)
        {
            await StageMembersChangedAsync(deps, ctx, group, added, removed: [], ct);
            await StageMemberSideAsync(deps, ctx, settings, new GroupMoveSide(group, added, Joined: true), ct);
        }

        await db.SaveChangesAsync(ct);
        return Results.Ok(new { results });
    }

    private static async Task<IResult> RemoveMemberAsync(
        Guid id, Guid userId, [AsParameters] GroupDeps deps, TenantSettingsAccessor settings,
        HttpContext ctx, CancellationToken ct)
    {
        var db = deps.Db;
        var row = await db.MemberGroupMembers.FirstOrDefaultAsync(m => m.GroupId == id && m.UserId == userId, ct);
        if (row is null) return Results.NotFound();

        var group = await db.MemberGroups.AsNoTracking().FirstAsync(x => x.Id == id, ct);
        await StageMembersChangedAsync(deps, ctx, group, added: [], removed: [userId], ct);
        await StageMemberSideAsync(deps, ctx, settings, new GroupMoveSide(group, [userId], Joined: false), ct);

        db.MemberGroupMembers.Remove(row);
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    /// <summary>
    /// The member-side <c>member.groups_changed</c> row for each member this call moved into or
    /// out of one group (review D2-P2): the group surface moves tariffs too, so it records under
    /// the member exactly as <c>PUT /admin/members/{userId}/groups</c> does. Read BEFORE the
    /// save, so "before" is the membership as it stood; "after" is the same set plus or minus
    /// this group, resolved by the one tariff rule.
    /// </summary>
    private static async Task StageMemberSideAsync(
        GroupDeps deps, HttpContext ctx, TenantSettingsAccessor settings, GroupMoveSide move, CancellationToken ct)
    {
        var s = await settings.GetAsync(ct);
        var current = await MemberTariffs.GroupsOfManyAsync(deps.Db, move.UserIds, ct);
        var counts = move.Group.Status == MemberGroupStatus.Active;
        foreach (var userId in move.UserIds)
        {
            var had = current.TryGetValue(userId, out var list) ? list : [];
            var will = move.Joined
                ? (counts ? had.Append(MemberTariffs.From(move.Group)).ToList() : had)
                : had.Where(g => g.Id != move.Group.Id).ToList();
            MemberGroupAudit.Stage(deps.Db, new MemberGroupMove(
                deps.Tenant.TenantId, ctx.User.Id() ?? Guid.Empty, userId,
                Added: move.Joined ? [move.Group] : [], Removed: move.Joined ? [] : [move.Group],
                Before: MemberTariffs.Resolve(had, s.CreditsPerZarRegular),
                After: MemberTariffs.Resolve(will, s.CreditsPerZarRegular),
                Reason: null));
        }
    }

    /// <summary>
    /// <c>group.members_changed</c>, naming who went in and who came out — by id AND by name,
    /// because the row must still read correctly after a member is anonymised.
    /// </summary>
    private static async Task StageMembersChangedAsync(
        GroupDeps deps, HttpContext ctx, MemberGroup group,
        IReadOnlyList<Guid> added, IReadOnlyList<Guid> removed, CancellationToken ct)
    {
        var names = await PersonNames.ForAsync(deps.Db, added.Concat(removed).Select(g => (Guid?)g), ct);

        await deps.Changes.StageAsync(new AdminChange(
            Action: AdminChangeActions.GroupMembersChanged,
            ActorUserId: ctx.User.Id() ?? Guid.Empty,
            SubjectKind: AdminChangeSubjects.Group,
            SubjectId: group.Id,
            SubjectLabel: group.Name,
            After: new
            {
                added = added.Select(u => new { user_id = u, name = PersonNames.Of(u, names) }).ToList(),
                removed = removed.Select(u => new { user_id = u, name = PersonNames.Of(u, names) }).ToList(),
            }), ct);
    }

    private static async Task<IResult> RulesForMemberAsync(
        Guid userId, DateOnly? day, MainframeDbContext db, TenantSettingsAccessor settings,
        BookingRules rules, CancellationToken ct)
    {
        if (!await db.Users.AnyAsync(u => u.Id == userId, ct)) return Results.NotFound();

        var s = await settings.GetAsync(ct);
        var d = day ?? ClubClock.Today(s);
        return Results.Ok(await ResolvedAsync(rules, db, s, userId, d, ct));
    }

    /// <summary>A tariff as the admin reads it — the rate, where it came from, and the peak standing.</summary>
    internal static object TariffWire(MemberTariff tariff)
    {
        return new
        {
            top_up_credits_per_zar = tariff.TopUpRate,
            rate_group_id = tariff.RateGroup?.Id,
            peak_priority = tariff.PeakPriority,
            peak_withheld_by = tariff.PeakWithheldBy,
        };
    }

    private static async Task<IResult> PreviewAsync(
        PreviewRequest req, MainframeDbContext db, TenantSettingsAccessor settings,
        BookingRules rules, CancellationToken ct)
    {
        if (!await db.Users.AnyAsync(u => u.Id == req.UserId, ct)) return Results.NotFound();

        var s = await settings.GetAsync(ct);
        var d = req.Day ?? ClubClock.Today(s);
        var current = await ResolvedAsync(rules, db, s, req.UserId, d, ct);

        // The PROPOSED set, read straight off the named groups rather than off the member's
        // current membership — nothing is saved, which is the whole point of the endpoint.
        var proposedIds = (req.ProposedGroupIds ?? []).Distinct().ToList();
        var groups = await db.MemberGroups.AsNoTracking()
            .Where(x => proposedIds.Contains(x.Id) && x.Status == MemberGroupStatus.Active)
            .ToListAsync(ct);
        var windows = await db.MemberGroupWindows.AsNoTracking()
            .Where(w => proposedIds.Contains(w.GroupId)).ToListAsync(ct);

        var proposed = groups.Select(x => new MemberGroupRules(
            x.Id, x.Name, x.Description, x.PricingMode, x.PriceMultiplierBps, x.FlatSlicePriceCredits,
            x.MaxSlotsPerDay, x.MaxMinutesPerDay, x.AdvanceBookingDays,
            HasAnyWindows: windows.Any(w => w.GroupId == x.Id),
            WindowsForDay: GroupRules.WindowsFor(windows.Where(w => w.GroupId == x.Id), d.DayOfWeek)))
            .ToList();

        // D2: what the proposed set would do to the member's top-up rate and peak standing, by
        // the same MemberTariffs rule the top-up and the booking path read.
        var wouldBeTariff = MemberTariffs.Resolve(groups.Select(MemberTariffs.From).ToList(), s.CreditsPerZarRegular);

        return Results.Ok(new { current, would_be = Resolved(s, proposed, d, wouldBeTariff) });
    }

    private static async Task<object> ResolvedAsync(
        BookingRules rules, MainframeDbContext db, TenantSettingsView s, Guid userId, DateOnly day, CancellationToken ct)
        => Resolved(s, await rules.GroupsForAsync(userId, day.DayOfWeek, s, ct), day,
            await MemberTariffs.ForAsync(db, userId, s, ct));

    private static object Resolved(
        TenantSettingsView s, IReadOnlyList<MemberGroupRules> groups, DateOnly day, MemberTariff tariff)
    {
        var (openMinute, closeMinute) = s.HoursFor(day.DayOfWeek);
        var allowed = GroupRules.AllowedWindows(groups, new MinuteWindow(openMinute, closeMinute));

        return new
        {
            day = day.ToString("yyyy-MM-dd"),
            groups = groups.Select(g => new { id = g.Id, name = g.Name, description = g.Description }).ToList(),
            allowed_windows = allowed.Select(w => new
            {
                start = BookingService.MinutesToHhmm(w.Start),
                end = BookingService.MinutesToHhmm(w.End),
            }).ToList(),
            slice_price_credits = GroupRules.PriceFor(groups, MoneySettings.SlicePriceCredits(s)),
            max_slots_per_day = GroupRules.SlotCapFor(groups, BookingLimits.MaxSlotsPerDay(s)),
            max_minutes_per_day = GroupRules.MinuteCapFor(groups, BookingLimits.MaxMinutesPerDay(s)),
            advance_booking_days = GroupRules.AdvanceDaysFor(groups, s.AdvanceBookingDays),
            // Named, not implied. An admin about to put somebody into a second group has to be
            // able to see that the result is a member who can book nothing at all.
            empty_window_groups = allowed.Count == 0 ? groups.Select(g => g.Name).ToList() : null,
            // D2: the top-up rate and peak standing these groups add up to — additive, so every
            // field above keeps its meaning for the screens already reading them.
            tariff = TariffWire(tariff),
        };
    }
}

/// <summary>The group body, every field optional so the PATCH and the POST share one shape.</summary>
/// <param name="Reason">
/// The admin's own words for the change record. Optional today, and recorded whenever it is
/// sent — see <c>MemberGroupEndpoints.StagePatchChangeAsync</c> for why an archive does not yet
/// demand one.
/// </param>
/// <param name="CreditsPerZar">
/// D2's top-up rate, <c>creditsPerZar</c> or <c>credits_per_zar</c>. A <see cref="JsonElement"/>
/// rather than a <c>decimal?</c> because the PATCH has to tell three things apart: ABSENT
/// (unchanged), <c>null</c> (inherit the club's default rate again) and a number.
/// </param>
/// <param name="PeakPriority">
/// D2's peak say, <c>peakPriority</c> or <c>peak_priority</c>: <c>true</c> grants, <c>false</c>
/// withholds, <c>null</c> has no say, ABSENT is unchanged — a <see cref="JsonElement"/> for the
/// same three-way reason as the rate.
/// </param>
public sealed record MemberGroupRequest(
    string? Name = null,
    string? Description = null,
    string? Status = null,
    GroupPricingRequest? Pricing = null,
    GroupCapsRequest? Caps = null,
    IReadOnlyList<GroupWindowRequest>? Windows = null,
    string? Reason = null,
    JsonElement CreditsPerZar = default,
    [property: JsonPropertyName("credits_per_zar")] JsonElement CreditsPerZarSnake = default,
    JsonElement PeakPriority = default,
    [property: JsonPropertyName("peak_priority")] JsonElement PeakPrioritySnake = default)
{
    /// <summary>The rate element under either spelling; <see cref="JsonValueKind.Undefined"/> when neither was sent.</summary>
    public JsonElement RateElement
        => CreditsPerZar.ValueKind != JsonValueKind.Undefined ? CreditsPerZar : CreditsPerZarSnake;

    /// <summary>
    /// The rate to write, or null when the body did not name one; a change whose
    /// <see cref="RateChange.Value"/> is null clears the rate. Only called after
    /// <see cref="MemberGroupValidation.Refuse"/> has accepted the element.
    /// </summary>
    // Block body: the lizard switch-expression trap in memory/gotchas.md.
    public RateChange? EffectiveCreditsPerZar
    {
        get
        {
            if (RateElement.ValueKind == JsonValueKind.Undefined) return null;
            return RateElement.ValueKind == JsonValueKind.Null ? new RateChange(null) : new RateChange(RateElement.GetDecimal());
        }
    }

    /// <summary>The peak element under either spelling; <see cref="JsonValueKind.Undefined"/> when neither was sent.</summary>
    public JsonElement PeakElement
        => PeakPriority.ValueKind != JsonValueKind.Undefined ? PeakPriority : PeakPrioritySnake;

    /// <summary>
    /// The peak say to write, or null when the body did not name one; a change whose
    /// <see cref="PeakChange.Value"/> is null means "no say". Only called after
    /// <see cref="MemberGroupValidation.Refuse"/> has accepted the element.
    /// </summary>
    // Block body: the lizard switch-expression trap in memory/gotchas.md.
    public PeakChange? EffectivePeakPriority
    {
        get
        {
            if (PeakElement.ValueKind == JsonValueKind.Undefined) return null;
            return PeakElement.ValueKind == JsonValueKind.Null ? new PeakChange(null) : new PeakChange(PeakElement.GetBoolean());
        }
    }
}

/// <summary>A top-up rate the request names: a number, or null for "inherit the club's default".</summary>
public readonly record struct RateChange(decimal? Value);

/// <summary>A peak say the request names: true grants, false withholds, null has no say.</summary>
public readonly record struct PeakChange(bool? Value);

/// <summary>
/// What the group writes resolve from the container, bound as one parameter — the complexity
/// gate caps a signature at six arguments, and recording to the change record added a seventh.
/// </summary>
public sealed record GroupDeps(MainframeDbContext Db, ITenantContext Tenant, AdminChangeRecorder Changes);

public sealed record GroupPricingRequest(string Mode, int? MultiplierBps = null, decimal? FlatSlicePriceCredits = null);

public sealed record GroupCapsRequest(int? MaxSlotsPerDay = null, int? MaxMinutesPerDay = null, int? AdvanceBookingDays = null);

public sealed record GroupWindowRequest(string Day, string Start, string End);

public sealed record GroupMembersRequest(IReadOnlyList<Guid>? UserIds);

/// <summary>Members moved into (<paramref name="Joined"/>) or out of one group, for the member-side audit row.</summary>
internal sealed record GroupMoveSide(MemberGroup Group, IReadOnlyList<Guid> UserIds, bool Joined);

public sealed record PreviewRequest(Guid UserId, DateOnly? Day, IReadOnlyList<Guid>? ProposedGroupIds);
