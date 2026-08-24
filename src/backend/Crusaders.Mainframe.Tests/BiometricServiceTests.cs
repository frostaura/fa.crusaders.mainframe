using Crusaders.Mainframe.Api.Biometric;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Regression tests through <see cref="BiometricService.MatchAtCourtAsync"/> itself.
///
/// <para>
/// <see cref="CourtActivationTests.The_earliest_booking_in_the_window_is_the_one_activated"/>
/// pins the ordering of <see cref="CourtActivationService.CandidatesAsync"/>, but the
/// biometric path used to build a third, unordered bookings-join-templates query of its own
/// and take <c>FirstOrDefault</c> from it — so the shared selector being ordered proved
/// nothing about the fingerprint reader. These tests drive the biometric service end to end,
/// with the store seeded latest-first so an unordered query hands back the wrong row first.
/// </para>
/// </summary>
public class BiometricServiceTests
{
    /// <summary>
    /// A device that always identifies the one configured member — the deterministic stand-in
    /// for a real fingerprint reader, so the test is about row selection, not matching.
    /// </summary>
    private sealed class FixedIdentityDevice : IBiometricDevice
    {
        private readonly Guid _userId;
        public FixedIdentityDevice(Guid userId) => _userId = userId;

        public string DeviceId => "fixed-identity-device";
        public BiometricDeviceKind Kind => BiometricDeviceKind.Fingerprint;
        public BiometricDeviceState State => BiometricDeviceState.Connected;

        public Task<BiometricCapture> CaptureAsync(CaptureOptions options, CancellationToken ct)
            => Task.FromResult(new BiometricCapture(Array.Empty<byte>(), Quality: 100, LatencyMs: 1));

        public Task<BiometricMatchResult> IdentifyAsync(
            BiometricCapture capture, IReadOnlyCollection<EnrolledTemplateRef> candidates, IdentifyOptions options, CancellationToken ct)
        {
            var self = candidates.FirstOrDefault(c => c.UserId == _userId);
            return Task.FromResult(self is null
                ? new BiometricMatchResult(false, null, null, 0, 0, 1)
                : new BiometricMatchResult(true, self.TemplateId, _userId, 0.99, 0.99, 1));
        }

        public Task<BiometricEnrollmentResult> EnrollAsync(EnrollmentRequest request, CancellationToken ct)
            => Task.FromResult(new BiometricEnrollmentResult(false, null, "not supported by the test device"));

        public Task<bool> RemoveTemplateAsync(string templateId, CancellationToken ct) => Task.FromResult(true);

        public Task<DeviceHealthSnapshot> GetHealthAsync(CancellationToken ct)
            => Task.FromResult(new DeviceHealthSnapshot(DateTimeOffset.UtcNow, 0, "test-1.0"));
    }

    /// <summary>
    /// The service under test, wired by hand so the device is controllable — TestHost
    /// registers <see cref="NullBiometricDevice"/> as a singleton, which cannot be swapped
    /// after the provider is built.
    /// </summary>
    private static BiometricService ServiceWith(IServiceScope scope, IBiometricDevice device) => new(
        scope.ServiceProvider.GetRequiredService<MainframeDbContext>(),
        scope.ServiceProvider.GetRequiredService<ITenantContext>(),
        device,
        scope.ServiceProvider.GetRequiredService<IEventBus>(),
        scope.ServiceProvider.GetRequiredService<CourtActivationService>(),
        NullLogger<BiometricService>.Instance);

    private static async Task<Booking> SeedBookingAsync(
        TestHost host, MainframeDbContext db, DateTimeOffset startsAt, bool charged = true)
    {
        var booking = new Booking
        {
            TenantId = host.Tenant.Id,
            CourtId = host.Courts[0].Id,
            UserId = host.PlayerUser.Id,
            BookedByUserId = host.PlayerUser.Id,
            PaidByUserId = host.PlayerUser.Id,
            ActorUserId = host.PlayerUser.Id,
            StartsAt = startsAt,
            EndsAt = startsAt.AddMinutes(15),
            SliceMinutes = 15,
            SliceCount = 1,
            AmountChargedCredits = 8m,
            Status = BookingStatus.Booked,
            ChargedAt = charged ? DateTimeOffset.UtcNow : null,
        };
        db.Bookings.Add(booking);
        await db.SaveChangesAsync();
        return booking;
    }

    private static async Task EnrollTemplateAsync(TestHost host, MainframeDbContext db)
    {
        db.EnrolledTemplates.Add(new EnrolledTemplate
        {
            TenantId = host.Tenant.Id,
            UserId = host.PlayerUser.Id,
            TemplateId = "tpl-test-1",
            EnrolledByAdminUserId = host.AdminUser.Id,
            ConsentReceiptHash = "v1",
        });
        await db.SaveChangesAsync();
    }

    /// <summary>
    /// The two-back-to-back-bookings bug, through the fingerprint path itself: a member
    /// holding 17:00 and 17:15 scans at 16:58, and the row they are standing on — the
    /// earlier one — must be the one checked in. The 17:15 booking is seeded FIRST, because
    /// on the InMemory provider an unordered query returns insertion order, which is exactly
    /// how the old inline query picked the wrong row deterministically.
    /// </summary>
    [Fact]
    public async Task Back_to_back_bookings_activate_the_earlier_one_through_the_biometric_path()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        await EnrollTemplateAsync(host, db);

        var now = DateTimeOffset.UtcNow;
        var earlier = now.AddMinutes(2);
        var later = earlier.AddMinutes(15);

        // Latest-first on purpose — see the test doc comment.
        var laterBooking = await SeedBookingAsync(host, db, later);
        var earlierBooking = await SeedBookingAsync(host, db, earlier);

        var svc = ServiceWith(scope, new FixedIdentityDevice(host.PlayerUser.Id));
        await svc.MatchAtCourtAsync(host.Courts[0].CourtNumber, payerOverrideUserId: null, default);

        var earlierFresh = await db.Bookings.AsNoTracking().FirstAsync(b => b.Id == earlierBooking.Id);
        var laterFresh = await db.Bookings.AsNoTracking().FirstAsync(b => b.Id == laterBooking.Id);

        Assert.NotNull(earlierFresh.CheckedInAt);
        Assert.Null(laterFresh.CheckedInAt);
    }

    /// <summary>
    /// A2-9: the activation outcome must reach the caller. The service used to discard
    /// <c>ActivateAsync</c>'s result, so an insufficient-balance refusal surfaced as a plain
    /// successful match — the kiosk told the member nothing while the lights stayed off.
    /// </summary>
    [Fact]
    public async Task An_insufficient_balance_refusal_surfaces_through_the_match_result()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        await EnrollTemplateAsync(host, db);

        // Uncharged and unfunded: activation must attempt the charge and refuse it.
        await SeedBookingAsync(host, db, DateTimeOffset.UtcNow.AddMinutes(2), charged: false);

        var svc = ServiceWith(scope, new FixedIdentityDevice(host.PlayerUser.Id));
        var (match, activation) = await svc.MatchAtCourtAsync(host.Courts[0].CourtNumber, payerOverrideUserId: null, default);

        Assert.True(match.Matched);
        var refused = Assert.IsType<ActivationResult.InsufficientBalance>(activation);
        Assert.Equal(host.PlayerUser.Id, refused.PayerUserId);
        Assert.Equal(8m, refused.Required);

        // Refused means refused: no attendance stamp, no lights.
        var fresh = await db.Bookings.AsNoTracking().SingleAsync();
        Assert.Null(fresh.CheckedInAt);
        Assert.Null(fresh.LightsOnCuedAt);
    }
}
