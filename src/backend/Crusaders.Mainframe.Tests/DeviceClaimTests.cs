using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security.Discovery;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Claiming a board: the security decision at the centre of discovery.
///
/// <para>
/// The question these tests answer is the one the spec poses — an admin clicks "connect
/// this board" in a list; how does the API know the key it is about to issue goes to the
/// physical box in the cupboard rather than to a laptop on the club WiFi that also
/// announced? The answer is a commitment to a code the board displays on its own LCD, and
/// every refusal below is a way that answer can be attacked or fumbled.
/// </para>
///
/// <para>
/// Driven through the service rather than over HTTP. The claim decision is the thing under
/// test, and an HTTP client between the assertion and the decision only adds ways for the
/// test to fail for reasons it is not about; the endpoint's own routing and auth are
/// covered separately.
/// </para>
/// </summary>
public class DeviceClaimTests
{
    private const string Code = "K7RM4XPT";
    private const string Nonce = "a1b2c3d4e5f60718";

    private static DiscoveredBoard Board(
        string mac = "5ccf7f1a2b3c", string nonce = Nonce, string code = Code, bool claimed = false)
        => new()
        {
            Mac = mac,
            Address = "192.168.68.150",
            Nonce = nonce,
            Hardware = "esp8266",
            Firmware = "1.0.0",
            Commitment = DiscoveryBeacon.ClaimCommitment(code, nonce),
            Claimed = claimed,
            FirstSeenAt = DateTimeOffset.UtcNow,
            LastSeenAt = DateTimeOffset.UtcNow,
        };

    /// <summary>
    /// The real hardware: one box, four relays, four courts (review C4). Four rather
    /// than one because the fixture's button map is the default — courts A–D — and a
    /// claim for a box that cannot honour every court button is refused at the claim.
    /// </summary>
    private static readonly int[] FourCourts = [1, 2, 3, 4];

    private static ClaimBoardCommand Command(string code = Code, string deviceCode = "court-box-1")
        => new(code, deviceCode, "Court 1 box", FourCourts);

    private sealed record Fixture(TestHost Host, IServiceScope Scope, DiscoveryStore Store, DeviceDiscoveryService Service, MainframeDbContext Db);

    private static async Task<Fixture> CreateAsync()
    {
        var host = await TestHost.CreateAsync();
        var scope = host.NewScope();

        return new Fixture(
            host,
            scope,
            host.Services.GetRequiredService<DiscoveryStore>(),
            scope.ServiceProvider.GetRequiredService<DeviceDiscoveryService>(),
            scope.ServiceProvider.GetRequiredService<MainframeDbContext>());
    }

    private static async Task<List<AuditLog>> AuditAsync(MainframeDbContext db, string action) =>
        await db.AuditLogs.IgnoreQueryFilters().Where(a => a.Action == action).ToListAsync();

    // ---- Happy path --------------------------------------------------------

    [Fact]
    public async Task A_matching_claim_code_registers_the_board_that_committed_to_it()
    {
        var f = await CreateAsync();
        f.Store.Upsert(Board());

        var result = await f.Service.ClaimAsync(Command(), f.Host.AdminUser.Id, default);

        Assert.True(result.Succeeded);
        Assert.Equal(ClaimFailure.None, result.Failure);
        Assert.Equal("5ccf7f1a2b3c", result.Board!.Mac);

        var device = result.Registration!.Device;
        Assert.Equal("court-box-1", device.DeviceCode);
        Assert.Equal("Court 1 box", device.Name);
        // In relay order, exactly as claimed: index 0 is relay A.
        Assert.Equal(FourCourts, device.CourtNumbers);
        Assert.Equal(DeviceKind.CourtBox, device.Kind);
        Assert.Equal(DeviceHardware.Esp8266, device.Hardware);
        Assert.Equal(f.Host.Tenant.Id, device.TenantId);

        // The key is derived, shown once and never stored. Nothing to read back later.
        Assert.Equal(43, result.Registration.DeviceKey.Length);

        Assert.NotNull(await f.Db.Devices.IgnoreQueryFilters().FirstOrDefaultAsync(d => d.Id == device.Id));
    }

    /// <summary>
    /// Both audit rows, and the division of labour between them. Registration is delegated to
    /// <c>DeviceRegistryService</c>, which writes its own <c>device.registered</c> row — the
    /// claim adds why and from where, and never re-implements the registration write.
    /// </summary>
    [Fact]
    public async Task A_successful_claim_writes_the_registration_and_the_claim_to_the_audit_log()
    {
        var f = await CreateAsync();
        f.Store.Upsert(Board());

        var result = await f.Service.ClaimAsync(Command(), f.Host.AdminUser.Id, default);

        var registered = Assert.Single(await AuditAsync(f.Db, "device.registered"));
        Assert.Equal(f.Host.AdminUser.Id, registered.ActorUserId);

        var claimed = Assert.Single(await AuditAsync(f.Db, "device.claimed"));
        Assert.Equal(f.Host.AdminUser.Id, claimed.ActorUserId);
        Assert.Equal(f.Host.Tenant.Id, claimed.TenantId);
        Assert.Null(claimed.SubjectUserId);

        var details = JsonDocument.Parse(claimed.DetailsJson!).RootElement;
        Assert.Equal("5ccf7f1a2b3c", details.GetProperty("mac").GetString());
        Assert.Equal("192.168.68.150", details.GetProperty("address").GetString());
        Assert.Equal(result.Registration!.Device.Id, details.GetProperty("device_id").GetGuid());

        // The claim code is a secret the board is displaying. An audit log is read by more
        // people than can stand in front of the cupboard.
        Assert.DoesNotContain(Code, claimed.DetailsJson!, StringComparison.Ordinal);
    }

    // ---- Refusals ----------------------------------------------------------

    /// <summary>
    /// The wrong code, typed off the wrong board. The commitment simply does not match, and
    /// nothing about the board is revealed by the refusal.
    /// </summary>
    [Fact]
    public async Task A_wrong_code_matches_nothing_even_with_a_board_announcing()
    {
        var f = await CreateAsync();
        f.Store.Upsert(Board());

        var result = await f.Service.ClaimAsync(Command(code: "ZZZZ2345"), f.Host.AdminUser.Id, default);

        Assert.Equal(ClaimFailure.NoMatch, result.Failure);
        Assert.Empty(await f.Db.Devices.IgnoreQueryFilters().ToListAsync());
        await AssertRefusalLoggedAsync(f, ClaimFailure.NoMatch);
    }

    [Fact]
    public async Task A_claim_with_nothing_announcing_is_refused()
    {
        var f = await CreateAsync();

        var result = await f.Service.ClaimAsync(Command(), f.Host.AdminUser.Id, default);

        Assert.Equal(ClaimFailure.NoMatch, result.Failure);
        Assert.Empty(await f.Db.Devices.IgnoreQueryFilters().ToListAsync());
        await AssertRefusalLoggedAsync(f, ClaimFailure.NoMatch);
    }

    /// <summary>
    /// The attack the commitment scheme is designed around, and the one case where refusing
    /// is the whole point.
    ///
    /// <para>
    /// An impostor that fabricates a commitment never matches. An impostor that <i>copies</i>
    /// a real board's nonce and commitment produces two announcers that both match — and
    /// picking one would be a coin flip on which physical box receives a working key. So the
    /// claim is refused and says why: the residual attack is denial of service, which is
    /// visible, rather than key theft, which is not.
    /// </para>
    /// </summary>
    [Fact]
    public async Task Two_announcers_sharing_a_commitment_are_refused_rather_than_guessed_between()
    {
        var f = await CreateAsync();

        f.Store.Upsert(Board(mac: "5ccf7f1a2b3c"));
        f.Store.Upsert(Board(mac: "aabbccddeeff"));   // same nonce, same commitment: a copied beacon

        var result = await f.Service.ClaimAsync(Command(), f.Host.AdminUser.Id, default);

        Assert.Equal(ClaimFailure.Ambiguous, result.Failure);
        Assert.Null(result.Registration);
        Assert.Empty(await f.Db.Devices.IgnoreQueryFilters().ToListAsync());
        await AssertRefusalLoggedAsync(f, ClaimFailure.Ambiguous);
    }

    /// <summary>
    /// A copy that also asserts <c>st=claimed</c>, in the hope that the genuine board is then
    /// the only candidate. The duplicate commitment is caught on its own terms, before the
    /// asserted state is consulted at all.
    /// </summary>
    [Fact]
    public async Task A_duplicate_commitment_is_refused_even_when_the_copy_claims_to_be_claimed()
    {
        var f = await CreateAsync();

        f.Store.Upsert(Board(mac: "5ccf7f1a2b3c"));
        f.Store.Upsert(Board(mac: "aabbccddeeff", claimed: true));

        var result = await f.Service.ClaimAsync(Command(), f.Host.AdminUser.Id, default);

        Assert.Equal(ClaimFailure.Ambiguous, result.Failure);
        Assert.Empty(await f.Db.Devices.IgnoreQueryFilters().ToListAsync());
    }

    [Fact]
    public async Task An_already_claimed_board_is_refused_by_name()
    {
        var f = await CreateAsync();
        f.Store.Upsert(Board(claimed: true));

        var result = await f.Service.ClaimAsync(Command(), f.Host.AdminUser.Id, default);

        Assert.Equal(ClaimFailure.BoardAlreadyClaimed, result.Failure);
        Assert.Empty(await f.Db.Devices.IgnoreQueryFilters().ToListAsync());
        await AssertRefusalLoggedAsync(f, ClaimFailure.BoardAlreadyClaimed);
    }

    /// <summary>
    /// The reason the store is marked on success rather than waiting for the board's next
    /// announce: without it, the same physical board could be claimed twice under two device
    /// codes in the minute before it re-announces as claimed.
    /// </summary>
    [Fact]
    public async Task Claiming_the_same_board_twice_is_refused_immediately()
    {
        var f = await CreateAsync();
        f.Store.Upsert(Board());

        Assert.True((await f.Service.ClaimAsync(Command(), f.Host.AdminUser.Id, default)).Succeeded);

        var second = await f.Service.ClaimAsync(Command(deviceCode: "court-box-2"), f.Host.AdminUser.Id, default);

        Assert.Equal(ClaimFailure.BoardAlreadyClaimed, second.Failure);
        Assert.Single(await f.Db.Devices.IgnoreQueryFilters().ToListAsync());
    }

    [Fact]
    public async Task A_device_code_already_in_use_is_refused()
    {
        var f = await CreateAsync();
        f.Store.Upsert(Board());

        var registry = f.Scope.ServiceProvider.GetRequiredService<DeviceRegistryService>();
        await registry.RegisterAsync(
            new RegisterDeviceCommand("court-box-1", "Existing", DeviceKind.CourtBox, DeviceHardware.Esp8266, [1], null),
            f.Host.AdminUser.Id, default);

        var result = await f.Service.ClaimAsync(Command(), f.Host.AdminUser.Id, default);

        Assert.Equal(ClaimFailure.DeviceCodeTaken, result.Failure);
        Assert.Single(await f.Db.Devices.IgnoreQueryFilters().ToListAsync());
        await AssertRefusalLoggedAsync(f, ClaimFailure.DeviceCodeTaken);
    }

    [Theory]
    [InlineData("K7RM4XP")]      // seven characters
    [InlineData("K7RM4XP0")]     // zero is not in the LCD alphabet
    [InlineData("k7rm4xpt")]     // lowercase
    [InlineData("")]
    public async Task A_malformed_claim_code_is_refused_before_anything_is_matched(string code)
    {
        var f = await CreateAsync();
        f.Store.Upsert(Board());

        var result = await f.Service.ClaimAsync(Command(code: code), f.Host.AdminUser.Id, default);

        Assert.Equal(ClaimFailure.InvalidClaimCode, result.Failure);
        Assert.Empty(await f.Db.Devices.IgnoreQueryFilters().ToListAsync());
    }

    /// <summary>
    /// A court box that drives no court cannot have a heartbeat routed to anything; one
    /// claiming five is asking for a relay that is not there; one listing a court twice
    /// has two relays on one court. All three are the same refusal.
    /// </summary>
    [Theory]
    [InlineData(null)]
    [InlineData(new int[0])]
    [InlineData(new[] { 1, 2, 3, 4, 5 })]
    [InlineData(new[] { 1, 2, 2, 3 })]
    public async Task A_claim_with_an_unusable_court_list_is_refused(int[]? courts)
    {
        var f = await CreateAsync();
        f.Store.Upsert(Board());

        var result = await f.Service.ClaimAsync(
            new ClaimBoardCommand(Code, "court-box-1", "Court box", courts), f.Host.AdminUser.Id, default);

        Assert.Equal(ClaimFailure.InvalidRegistration, result.Failure);
        Assert.Empty(await f.Db.Devices.IgnoreQueryFilters().ToListAsync());
    }

    /// <summary>
    /// The button map and a box's court list are edited on different screens and must
    /// agree. The fixture's map is the default — courts A–D — so a box that drives only two
    /// courts is given that map with C and D turned off, as its own override.
    ///
    /// <para>
    /// This used to be a refusal, and the discovery claim sends no <c>button_map</c> at all,
    /// so every two- or three-court box in a club with the default map was unclaimable from
    /// the discovered list until an admin either edited the club map — changing every other
    /// box — or hand-registered it (closing re-review #13 residual). The invariant the
    /// refusal protected still holds: no box is ever handed a key with buttons that select
    /// a relay it does not have.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_claim_for_fewer_courts_than_the_button_map_selects_is_trimmed_to_fit()
    {
        var f = await CreateAsync();
        f.Store.Upsert(Board());

        var result = await f.Service.ClaimAsync(
            new ClaimBoardCommand(Code, "court-box-1", "Court box", [1, 2]), f.Host.AdminUser.Id, default);

        Assert.True(result.Succeeded, $"claim failed with {result.Failure}");

        var stored = ButtonMap.FromJson(result.Registration!.Device.ButtonMapJson);
        Assert.NotNull(stored);
        Assert.Equal(
            ["court:A", "court:B", "none", "none", "minutes:15", "minutes:30", "minutes:45", "minutes:60"],
            stored.ToWire());
        Assert.Null(stored.FirstSelectionBeyond(2));
    }

    // ---- Tenant isolation --------------------------------------------------

    /// <summary>
    /// The store is process-wide — it is fed by a socket, not by a request — so the tenant
    /// boundary is drawn where it is read.
    ///
    /// <para>
    /// A board that proved its identity belongs to its device's tenant and is invisible to
    /// every other one. An <b>unclaimed</b> board is visible to whoever asks, because it
    /// belongs to nobody yet and that is the point of discovery; what it discloses is a MAC,
    /// a firmware version and an uptime, which is what anyone on the same WiFi already gets
    /// from ARP.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_verified_board_belonging_to_another_tenant_is_not_listed()
    {
        var f = await CreateAsync();

        f.Store.Upsert(Board(mac: "5ccf7f1a2b3c"));                       // unclaimed: everyone's candidate
        f.Store.Upsert(Board(mac: "111111111111") with
        {
            Claimed = true,
            SignatureVerified = true,
            OwnerTenantId = f.Host.Tenant.Id,
        });
        f.Store.Upsert(Board(mac: "222222222222") with
        {
            Claimed = true,
            SignatureVerified = true,
            OwnerTenantId = Guid.NewGuid(),                               // another club's box
        });

        var visible = f.Service.Visible().Select(b => b.Mac).ToList();

        Assert.Contains("5ccf7f1a2b3c", visible);
        Assert.Contains("111111111111", visible);
        Assert.DoesNotContain("222222222222", visible);
    }

    /// <summary>
    /// Two clubs in one database, each claiming its own board. The device rows must land on
    /// the right tenants, and neither club may see the other's.
    /// </summary>
    [Fact]
    public async Task Two_tenants_claiming_boards_stay_apart()
    {
        var shared = $"claim-shared-{Guid.NewGuid():N}";
        await using var alpha = await TestHost.CreateAsync("alpha", shared);
        await using var bravo = await TestHost.CreateAsync("bravo", shared);

        await ClaimInAsync(alpha, "5ccf7f1a2b3c", Nonce, "court-box-1");
        await ClaimInAsync(bravo, "aabbccddeeff", "0000000000000000", "court-box-1");

        using var scopeA = alpha.NewScope();
        using var scopeB = bravo.NewScope();

        var devicesA = await scopeA.ServiceProvider.GetRequiredService<DeviceRegistryService>().ListAsync(default);
        var devicesB = await scopeB.ServiceProvider.GetRequiredService<DeviceRegistryService>().ListAsync(default);

        Assert.Equal(alpha.Tenant.Id, Assert.Single(devicesA).TenantId);
        Assert.Equal(bravo.Tenant.Id, Assert.Single(devicesB).TenantId);
        Assert.NotEqual(Assert.Single(devicesA).Id, Assert.Single(devicesB).Id);
    }

    private static async Task ClaimInAsync(TestHost host, string mac, string nonce, string deviceCode)
    {
        host.Services.GetRequiredService<DiscoveryStore>().Upsert(Board(mac: mac, nonce: nonce));

        using var scope = host.NewScope();
        var result = await scope.ServiceProvider.GetRequiredService<DeviceDiscoveryService>()
            .ClaimAsync(Command(deviceCode: deviceCode), host.AdminUser.Id, default);

        Assert.True(result.Succeeded, $"Claim failed with {result.Failure}.");
    }

    private static async Task AssertRefusalLoggedAsync(Fixture f, ClaimFailure expected)
    {
        var row = Assert.Single(await AuditAsync(f.Db, "device.claim_failed"));

        Assert.Equal(f.Host.AdminUser.Id, row.ActorUserId);
        Assert.Equal(f.Host.Tenant.Id, row.TenantId);

        var details = JsonDocument.Parse(row.DetailsJson!).RootElement;
        Assert.Equal(expected.ToString(), details.GetProperty("reason").GetString());
        Assert.DoesNotContain(Code, row.DetailsJson!, StringComparison.Ordinal);
    }

    // ---- One physical board, one row ---------------------------------------

    /// <summary>
    /// A board that was reflashed, or whose key was lost, announces st=unclaimed with no
    /// device id — indistinguishable from a new board except by its MAC. Registering it
    /// again would leave two rows for one piece of hardware, both deriving working keys.
    /// Refusing was the old answer and it made a revoked box unregistrable for ever
    /// (closing re-review #9/#10); the row is re-keyed instead: same id, bumped key
    /// version, this claim's name and courts, one row for the MAC, and a fresh grant.
    /// </summary>
    [Fact]
    public async Task A_board_that_is_already_registered_is_rekeyed_rather_than_duplicated()
    {
        var f = await CreateAsync();
        f.Store.Upsert(Board());

        var first = await f.Service.ClaimAsync(Command(), f.Host.AdminUser.Id, default);
        Assert.True(first.Succeeded);
        Assert.False(first.Reclaimed);
        var firstKey = first.Registration!.DeviceKey;

        // The same physical board comes back unclaimed — reflashed, or restored from a
        // backup that predates the claim — and an admin connects it again.
        f.Store.Upsert(Board());

        var second = await f.Service.ClaimAsync(
            Command(deviceCode: "court-box-2"), f.Host.AdminUser.Id, default);

        Assert.True(second.Succeeded, $"re-claim failed with {second.Failure}");
        Assert.True(second.Reclaimed);
        Assert.Equal(first.Registration.Device.Id, second.Registration!.Device.Id);
        Assert.Equal(2, second.Registration.Device.KeyVersion);
        Assert.Equal("court-box-2", second.Registration.Device.DeviceCode);
        Assert.NotEqual(firstKey, second.Registration.DeviceKey);

        Assert.Single(await f.Db.Devices.IgnoreQueryFilters().Where(d => d.MacAddress == "5ccf7f1a2b3c").ToListAsync());
        Assert.Single(await AuditAsync(f.Db, "device.reclaimed"));
        Assert.Empty(await AuditAsync(f.Db, "device.claim_failed"));

        // The board can collect the NEW key with the code it is showing.
        var grants = f.Host.Services.GetRequiredService<ProvisioningGrants>();
        var grant = grants.Redeem("5ccf7f1a2b3c", Code);
        Assert.NotNull(grant);
        Assert.Equal(2, grant!.KeyVersion);

        f.Scope.Dispose();
        await f.Host.DisposeAsync();
    }

    /// <summary>
    /// The Revoke control is on every Devices row, and the API's own guidance told admins
    /// to press it before reconnecting a board. Revoking left <c>RevokedAt</c> set for ever,
    /// nothing cleared it, and every reconnect was refused — a box an admin had revoked was
    /// permanently unregistrable from any product surface. Now: revoke, the board falls to
    /// CLAIM CODE and announces unclaimed, the claim un-revokes and re-keys the same row.
    /// </summary>
    [Fact]
    public async Task A_revoked_board_can_be_claimed_again_and_comes_back_enabled_with_a_new_key()
    {
        var f = await CreateAsync();
        f.Store.Upsert(Board());

        var first = await f.Service.ClaimAsync(Command(), f.Host.AdminUser.Id, default);
        Assert.True(first.Succeeded);
        var device = first.Registration!.Device;

        var registry = f.Scope.ServiceProvider.GetRequiredService<DeviceRegistryService>();
        await registry.RevokeAsync(device, f.Host.AdminUser.Id, default);
        Assert.False(device.IsActive);

        // 401 strikes → Reprovision → the board announces unclaimed with a fresh code.
        const string freshCode = "PQRS4567";
        const string freshNonce = "ffeeddccbbaa9988";
        f.Store.Upsert(Board(nonce: freshNonce, code: freshCode));

        var again = await f.Service.ClaimAsync(
            new ClaimBoardCommand(freshCode, "court-box-1", "Court 1 box (back)", FourCourts), f.Host.AdminUser.Id, default);

        Assert.True(again.Succeeded, $"re-claim after revoke failed with {again.Failure}");
        Assert.True(again.Reclaimed);
        var row = await f.Db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == "5ccf7f1a2b3c");
        Assert.Equal(device.Id, row.Id);
        Assert.Null(row.RevokedAt);
        Assert.True(row.Enabled);
        Assert.True(row.IsActive);
        Assert.Equal(2, row.KeyVersion);
        Assert.Equal("Court 1 box (back)", row.Name);

        // The grant is for the code the board is showing NOW, not the one it showed first.
        var grants = f.Host.Services.GetRequiredService<ProvisioningGrants>();
        Assert.Null(grants.Redeem("5ccf7f1a2b3c", Code));      // the old code, burned or never issued: refused either way
        // (a wrong guess burns the grant — issue a fresh one to prove the right code works)
        f.Store.Upsert(Board(nonce: freshNonce, code: freshCode));
        var third = await f.Service.ClaimAsync(
            new ClaimBoardCommand(freshCode, "court-box-1", "Court 1 box (back)", FourCourts), f.Host.AdminUser.Id, default);
        Assert.True(third.Succeeded);
        var grant = grants.Redeem("5ccf7f1a2b3c", freshCode);
        Assert.NotNull(grant);
        Assert.Equal(3, grant!.KeyVersion);

        f.Scope.Dispose();
        await f.Host.DisposeAsync();
    }

    /// <summary>
    /// A re-claim may not steal a device code that belongs to a DIFFERENT row; the row's
    /// own current code is fine.
    /// </summary>
    [Fact]
    public async Task A_reclaim_keeps_its_own_device_code_but_may_not_take_anothers()
    {
        var f = await CreateAsync();
        f.Store.Upsert(Board());
        Assert.True((await f.Service.ClaimAsync(Command(), f.Host.AdminUser.Id, default)).Succeeded);

        var registry = f.Scope.ServiceProvider.GetRequiredService<DeviceRegistryService>();
        await registry.RegisterAsync(
            new RegisterDeviceCommand("court-box-other", "Other", DeviceKind.CourtBox, DeviceHardware.Esp8266, [1, 2, 3, 4], null),
            f.Host.AdminUser.Id, default);

        f.Store.Upsert(Board());
        var stolen = await f.Service.ClaimAsync(Command(deviceCode: "court-box-other"), f.Host.AdminUser.Id, default);
        Assert.Equal(ClaimFailure.DeviceCodeTaken, stolen.Failure);

        f.Store.Upsert(Board());
        var own = await f.Service.ClaimAsync(Command(deviceCode: "court-box-1"), f.Host.AdminUser.Id, default);
        Assert.True(own.Succeeded);
        Assert.True(own.Reclaimed);

        f.Scope.Dispose();
        await f.Host.DisposeAsync();
    }

    /// <summary>A court list naming a court the club does not have is refused — nothing ever checked this, so a typo registered a relay that could never light.</summary>
    [Fact]
    public async Task A_claim_naming_a_court_the_club_does_not_have_is_refused()
    {
        var f = await CreateAsync();
        f.Store.Upsert(Board());

        var result = await f.Service.ClaimAsync(
            new ClaimBoardCommand(Code, "court-box-1", "Court box", [1, 2, 3, 9]), f.Host.AdminUser.Id, default);

        Assert.Equal(ClaimFailure.CourtNumberNotFound, result.Failure);
        Assert.Empty(await f.Db.Devices.IgnoreQueryFilters().ToListAsync());
        await AssertRefusalLoggedAsync(f, ClaimFailure.CourtNumberNotFound);
    }

    /// <summary>
    /// A one-court annex box under the club's four-court map: an override the admin
    /// supplied is stored verbatim and is what the box is checked against, not the club's
    /// map. The invariant is per box, not per club (review #17).
    ///
    /// <para>
    /// Claimed with no override the box now gets one derived instead of a refusal, and the
    /// derived map is the same map the admin would have written — which is the point. What
    /// stays refused is an override the admin supplied that reaches past the box's courts:
    /// see the case below.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_claim_with_its_own_button_map_is_checked_against_that_map_not_the_clubs()
    {
        var f = await CreateAsync();

        string[] annexWire = ["court:A", "none", "none", "none", "minutes:15", "minutes:30", "minutes:45", "minutes:60"];
        Assert.True(ButtonMap.TryParse(annexWire, out var annexMap, out _));

        f.Store.Upsert(Board());
        var accepted = await f.Service.ClaimAsync(
            new ClaimBoardCommand(Code, "annex", "Annex box", [1], annexMap), f.Host.AdminUser.Id, default);

        Assert.True(accepted.Succeeded, $"claim with override failed with {accepted.Failure}");
        Assert.Equal(annexMap!.ToJson(), accepted.Registration!.Device.ButtonMapJson);

        // With no override the derived one says the same thing, so the admin never had to
        // compose it by hand to get past the claim.
        var second = await CreateAsync();
        second.Store.Upsert(Board());
        var derived = await second.Service.ClaimAsync(
            new ClaimBoardCommand(Code, "annex", "Annex box", [1]), second.Host.AdminUser.Id, default);

        Assert.True(derived.Succeeded, $"claim without override failed with {derived.Failure}");
        Assert.Equal(annexWire, ButtonMap.FromJson(derived.Registration!.Device.ButtonMapJson)!.ToWire());
    }

    /// <summary>
    /// The trim never rewrites a map the admin typed. An override that reaches past the
    /// box's courts is still refused with the map named — telling them it does not fit is
    /// the lesser failure.
    /// </summary>
    [Fact]
    public async Task A_claim_whose_own_button_map_overreaches_is_still_refused()
    {
        var f = await CreateAsync();
        f.Store.Upsert(Board());

        Assert.True(ButtonMap.TryParse(
            ["court:A", "court:C", "none", "none", "minutes:15", "minutes:30", "minutes:45", "minutes:60"],
            out var reachesTooFar, out _));

        var result = await f.Service.ClaimAsync(
            new ClaimBoardCommand(Code, "annex", "Annex box", [1, 2], reachesTooFar), f.Host.AdminUser.Id, default);

        Assert.Equal(ClaimFailure.ButtonMapMismatch, result.Failure);
        Assert.Empty(await f.Db.Devices.IgnoreQueryFilters().ToListAsync());
        await AssertRefusalLoggedAsync(f, ClaimFailure.ButtonMapMismatch);
    }

    /// <summary>A different board is still claimable while the first one is registered.</summary>
    [Fact]
    public async Task A_second_distinct_board_is_still_claimable()
    {
        var f = await CreateAsync();
        f.Store.Upsert(Board());

        Assert.True((await f.Service.ClaimAsync(Command(), f.Host.AdminUser.Id, default)).Succeeded);

        const string otherNonce = "ffeeddccbbaa9988";
        f.Store.Upsert(Board(mac: "aabbccddeeff", nonce: otherNonce, code: "PQRS4567"));

        var second = await f.Service.ClaimAsync(
            new ClaimBoardCommand("PQRS4567", "court-box-2", "Court 2 box", FourCourts), f.Host.AdminUser.Id, default);

        Assert.True(second.Succeeded);
        Assert.Equal("aabbccddeeff", second.Registration!.Device.MacAddress);

        f.Scope.Dispose();
        await f.Host.DisposeAsync();
    }
}
