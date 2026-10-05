namespace Crusaders.Mainframe.Tests;

public abstract partial class DeviceEventHttpTests
{
    /// <summary>
    /// Review round 15, D14-3 residual: R14 named the member on a v1 code's <c>wrong_court</c>; the
    /// roster-token path (a booking's own activation code, lit on a relay wired to ANOTHER court) still
    /// wrote the refusal with no subject — so the member's Night never showed the box turning them away.
    /// </summary>
    public sealed class R15BE15a(PostgresFixture pg) : DeviceEventHttpTests(pg), IClassFixture<PostgresFixture>
    {
        [SkippableTheory]
        [InlineData(0)]   // relay 0 is court 1; the booking is on court 2
        [InlineData(7)]   // a relay the box does not have
        public async Task A_roster_token_wrong_court_names_its_member(int relay)
        {
            Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

            var factory = CreateFactory();
            var box = await SeedAsync(factory, courtNumbers: [1, 2]);
            var booked = await BookAsync(factory, box, courtNumber: 2, startsInMinutes: -2);

            var upload = await factory.CreateClient().SendAsync(FromBox(box, EventsPath, Batch(
                Activation(1, subject: booked.Code, court: relay, uptimeMs: 200_000))));
            upload.EnsureSuccessStatusCode();

            var row = Assert.Single(await AuditAsync(factory, box.TenantId, "device.activation_wrong_court"));
            Assert.Equal(box.MemberId, row.SubjectUserId);
        }
    }
}
