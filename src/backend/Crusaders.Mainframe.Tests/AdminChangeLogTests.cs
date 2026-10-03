using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The club's undeletable record of what its administrators did.
///
/// <para>
/// The three layers this file can reach are the vocabulary, the recorder and the posture. The
/// fourth — the database triggers that make a <c>DELETE</c> raise — can only be proven against
/// real Postgres and lives in <see cref="ApiBoundaryTests"/>, because the EF in-memory provider
/// speaks no SQL and would report every one of these as protected when none of them was.
/// </para>
/// </summary>
public sealed class AdminChangeLogTests
{
    // ------------------------------------------------------------------ the vocabulary

    /// <summary>
    /// Every action in the list belongs to an area, and every area in the list is reachable.
    ///
    /// <para>
    /// The two halves catch opposite mistakes: an action added to <c>All</c> and forgotten in
    /// <c>AreaOf</c> would throw at the moment an admin performed it, in production, on the one
    /// table that exists to still be readable in two years; an area nothing can reach is a
    /// filter the console offers that always answers empty.
    /// </para>
    /// </summary>
    [Fact]
    public void Every_action_maps_to_an_area_and_every_area_is_reachable()
    {
        foreach (var action in AdminChangeActions.All)
        {
            var area = AdminChangeActions.AreaOf(action);
            Assert.True(area is not null, $"AdminChangeActions.AreaOf has no arm for '{action}'.");
            Assert.Contains(area, AdminChangeAreas.All);
        }

        var reached = AdminChangeActions.All.Select(AdminChangeActions.AreaOf).ToHashSet();
        foreach (var area in AdminChangeAreas.All)
        {
            Assert.True(reached.Contains(area), $"No action belongs to area '{area}'.");
        }
    }

    /// <summary>A duplicated action would page twice and diff against itself.</summary>
    [Fact]
    public void The_action_list_has_no_duplicates()
        => Assert.Equal(AdminChangeActions.All.Length, AdminChangeActions.All.Distinct().Count());

    /// <summary>
    /// The actions that demand a reason are actions that exist. A typo here would silently
    /// stop demanding one, which is exactly the field a club cannot reconstruct later.
    /// </summary>
    [Fact]
    public void Every_reason_required_action_is_a_real_action()
    {
        foreach (var action in AdminChangeActions.ReasonRequired)
        {
            Assert.Contains(action, AdminChangeActions.All);
        }
    }

    /// <summary>
    /// Every action composes a sentence, and none of them composes an empty one.
    ///
    /// <para>
    /// A blank headline renders as a blank row, which an admin reads as a row about nothing.
    /// </para>
    /// </summary>
    [Fact]
    public void Every_action_composes_a_sentence()
    {
        foreach (var action in AdminChangeActions.All)
        {
            Assert.False(string.IsNullOrWhiteSpace(AdminChangeActions.Headline(action, "Tuesday league")));
            Assert.False(string.IsNullOrWhiteSpace(AdminChangeActions.Headline(action, null)));
        }
    }

    /// <summary>
    /// An action the dictionary has never heard of gets a NEUTRAL sentence naming the raw
    /// string — never a guessed one.
    ///
    /// <para>
    /// This is the <c>DoorAuditActions</c> lesson, and the reason that type exists: a console
    /// holding its own dictionary painted <c>device.updated</c> as a green "Refused" scan, and a
    /// door with thirteen admin edits read "13 refused scans". A server-composed headline moves
    /// the dictionary to the one place that knows what it wrote — and the unknown arm is what
    /// stops the same defect arriving from inside.
    /// </para>
    /// </summary>
    [Fact]
    public void An_unknown_action_gets_a_neutral_sentence_naming_it()
    {
        var headline = AdminChangeActions.Headline("something.nobody.declared", "Priya Naidoo");

        Assert.Contains("something.nobody.declared", headline);
        Assert.DoesNotContain("Cancelled", headline);
        Assert.DoesNotContain("Approved", headline);
    }

    /// <summary>
    /// Review round 8, E8-5: a desk sale the club took no rand for is GIVEN — named by its code or
    /// by the R0.00 it records — and a paid sale, an older row without the fields, or a malformed
    /// <c>after</c> still reads as a sale.
    /// </summary>
    [Theory]
    [InlineData("""{"reason_code":"package_free","zar_received":0}""", "Gave a member a package at no charge — Thandi")]
    [InlineData("""{"reason_code":"top_up_cash","zar_received":0.00}""", "Gave a member a package at no charge — Thandi")]
    [InlineData("""{"reason_code":"top_up_cash","zar_received":150.00}""", "Sold a member a package — Thandi")]
    [InlineData("""{"balance_minutes":60}""", "Sold a member a package — Thandi")]
    [InlineData("not json", "Sold a member a package — Thandi")]
    [InlineData(null, "Sold a member a package — Thandi")]
    public void A_desk_sale_with_no_rand_taken_reads_as_given(string? after, string expected)
        => Assert.Equal(expected, AdminChangeActions.Headline(AdminChangeActions.PackageSold, "Thandi", after));

    // ------------------------------------------------------------------ the recorder

    [Fact]
    public async Task A_recorded_change_carries_the_actor_the_area_and_the_diff()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.Services.CreateScope();
        var recorder = scope.ServiceProvider.GetRequiredService<AdminChangeRecorder>();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        await recorder.RecordAsync(new AdminChange(
            Action: AdminChangeActions.ScheduleCreated,
            ActorUserId: host.AdminUser.Id,
            SubjectKind: AdminChangeSubjects.Schedule,
            SubjectId: Guid.NewGuid(),
            SubjectLabel: "Tuesday league",
            Reason: "Div 1 season",
            After: new { start_minute = 1080 }), default);

        var row = await db.AdminChangeLogs.SingleAsync();
        Assert.Equal(AdminChangeAreas.Schedule, row.Area);
        Assert.Equal(AdminChangeActions.ScheduleCreated, row.Action);
        Assert.Equal("Test Admin", row.ActorName);
        Assert.Equal(host.AdminUser.Email, row.ActorEmail);
        Assert.Equal("Tuesday league", row.SubjectLabel);
        Assert.Equal("Div 1 season", row.Reason);
        Assert.Contains("1080", row.AfterJson);
        Assert.Null(row.BeforeJson);
    }

    /// <summary>
    /// A staged change is not written until the caller's own save runs — which is what ties
    /// the record to the change it describes.
    ///
    /// <para>
    /// If the change rolls back, so does the record of it. A record of something that did not
    /// happen is worse than no record: it is the one artefact a club would trust without
    /// checking.
    /// </para>
    /// </summary>
    [Fact]
    public async Task Staging_writes_nothing_until_the_caller_saves()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.Services.CreateScope();
        var recorder = scope.ServiceProvider.GetRequiredService<AdminChangeRecorder>();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        await recorder.StageAsync(
            new AdminChange(AdminChangeActions.BookingsBulkCancelled, host.AdminUser.Id), default);

        using (var reader = host.Services.CreateScope())
        {
            var fresh = reader.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Assert.Empty(await fresh.AdminChangeLogs.ToListAsync());
        }

        await db.SaveChangesAsync();
        Assert.Single(await db.AdminChangeLogs.ToListAsync());
    }

    /// <summary>
    /// An action outside the vocabulary is refused at the recorder rather than stored.
    ///
    /// <para>
    /// A row nobody can read back is not a record. Throwing here means the commit that
    /// introduces a new action and the commit that adds it to the vocabulary are the same
    /// commit, which is the only way the two stay in step.
    /// </para>
    /// </summary>
    [Fact]
    public async Task An_action_outside_the_vocabulary_is_refused()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.Services.CreateScope();
        var recorder = scope.ServiceProvider.GetRequiredService<AdminChangeRecorder>();

        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() =>
            recorder.RecordAsync(new AdminChange("booking.invented", host.AdminUser.Id), default));
    }

    /// <summary>
    /// The system is a real actor and must not render as an administrator.
    ///
    /// <para>
    /// <c>Guid.Empty</c> is what every worker in this product actually writes. Deriving
    /// "is admin" from "the actor is not the subject" — which the ledger's webhook mirror still
    /// does — makes every automatic no-show sweep claim an admin did it, and a member disputing
    /// a penalty is entitled to the true sentence.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_system_actor_is_named_as_the_system_and_not_as_an_admin()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.Services.CreateScope();
        var recorder = scope.ServiceProvider.GetRequiredService<AdminChangeRecorder>();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        await recorder.RecordAsync(
            new AdminChange(AdminChangeActions.BookingBlockLifted, Guid.Empty), default);

        var row = await db.AdminChangeLogs.SingleAsync();
        Assert.Equal(AdminChangeRecorder.SystemActorName, row.ActorName);
        Assert.Null(row.ActorEmail);
    }

    /// <summary>
    /// The actor's name survives the member's own row being anonymised.
    ///
    /// <para>
    /// <b>This is what "denormalised on purpose" buys, and it is not hypothetical.</b>
    /// <c>RetentionWorker</c> replaces subject ids with a sentinel at two years and this table
    /// is exempt from retention entirely — so a row that resolved its actor by join would, in
    /// the one table designed to outlive everything, start rendering "Unknown" for every
    /// administrator the club ever had.
    /// </para>
    /// </summary>
    [Fact]
    public async Task The_actor_name_survives_the_member_being_renamed_or_removed()
    {
        await using var host = await TestHost.CreateAsync();
        using (var scope = host.Services.CreateScope())
        {
            var recorder = scope.ServiceProvider.GetRequiredService<AdminChangeRecorder>();
            await recorder.RecordAsync(
                new AdminChange(AdminChangeActions.MemberApproved, host.AdminUser.Id), default);
        }

        using (var scope = host.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var membership = await db.Memberships.FirstAsync(m => m.UserId == host.AdminUser.Id);
            db.Memberships.Remove(membership);
            await db.SaveChangesAsync();
        }

        using (var scope = host.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var row = await db.AdminChangeLogs.SingleAsync();
            Assert.Equal("Test Admin", row.ActorName);
        }
    }

    // ------------------------------------------------------------------ tenancy

    /// <summary>
    /// One club cannot read another's record of itself.
    ///
    /// <para>
    /// Both clubs share ONE store, which is the only arrangement under which this proves
    /// anything: with a database per host, tenant B is empty because it is a different store
    /// and the assertion holds with every query filter deleted.
    /// </para>
    /// </summary>
    [Fact]
    public async Task One_clubs_change_record_is_invisible_to_another()
    {
        var shared = $"crusaders-shared-{Guid.NewGuid():N}";
        await using var clubA = await TestHost.CreateAsync("club-a", shared);
        await using var clubB = await TestHost.CreateAsync("club-b", shared);

        using (var scope = clubA.Services.CreateScope())
        {
            scope.ServiceProvider.GetRequiredService<ITenantContext>().Set(clubA.Tenant.Id, clubA.Tenant.Slug);
            await scope.ServiceProvider.GetRequiredService<AdminChangeRecorder>().RecordAsync(
                new AdminChange(
                    AdminChangeActions.SettingsUpdated, clubA.AdminUser.Id,
                    SubjectKind: AdminChangeSubjects.Setting, SubjectLabel: "club A only"),
                default);
        }

        using (var scope = clubB.Services.CreateScope())
        {
            scope.ServiceProvider.GetRequiredService<ITenantContext>().Set(clubB.Tenant.Id, clubB.Tenant.Slug);
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Assert.Empty(await db.AdminChangeLogs.ToListAsync());
        }

        using (var scope = clubA.Services.CreateScope())
        {
            scope.ServiceProvider.GetRequiredService<ITenantContext>().Set(clubA.Tenant.Id, clubA.Tenant.Slug);
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Assert.Single(await db.AdminChangeLogs.ToListAsync());
        }
    }

    /// <summary>
    /// A row written under one club carries that club's id, even when the recorder is handed
    /// an actor who belongs to another.
    /// </summary>
    [Fact]
    public async Task A_row_carries_the_tenant_the_request_resolved_not_the_actors()
    {
        var shared = $"crusaders-shared-{Guid.NewGuid():N}";
        await using var clubA = await TestHost.CreateAsync("club-a", shared);
        await using var clubB = await TestHost.CreateAsync("club-b", shared);

        using var scope = clubA.Services.CreateScope();
        scope.ServiceProvider.GetRequiredService<ITenantContext>().Set(clubA.Tenant.Id, clubA.Tenant.Slug);
        var recorder = scope.ServiceProvider.GetRequiredService<AdminChangeRecorder>();

        var row = await recorder.RecordAsync(
            new AdminChange(AdminChangeActions.MemberApproved, clubB.AdminUser.Id), default);

        Assert.Equal(clubA.Tenant.Id, row.TenantId);
        // Club B's admin is not in club A's membership table as far as the filter is concerned,
        // so the name cannot be resolved — and the row says so rather than naming a stranger.
        Assert.Equal(AdminChangeRecorder.UnknownActorName, row.ActorName);
    }
}
