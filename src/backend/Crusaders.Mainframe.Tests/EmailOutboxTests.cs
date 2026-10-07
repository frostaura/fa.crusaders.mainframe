using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Services.Demo;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The email outbox on the in-process host: queueing never touches the mail server, demo mail is
/// never stored, the sender backs off and retries, and a mail that finally cannot go tells the
/// club's admins.
///
/// <para>
/// What the in-memory provider cannot show — the <c>FOR UPDATE SKIP LOCKED</c> claim, and an
/// approval that returns while SMTP hangs — is <c>EmailOutboxHttpTests</c>.
/// </para>
/// </summary>
public class EmailOutboxTests
{
    private static EmailOutboxService Outbox(TestHost host) => new(
        host.Services.GetRequiredService<IServiceScopeFactory>(),
        host.Services.GetRequiredService<EmailOutboxSignal>(),
        NullLogger<EmailOutboxService>.Instance);

    private static EmailMessage Mail(string to, string subject = "Booking confirmed") =>
        new(to, subject, "<p>Hello</p>", "Hello", [new EmailAttachment("receipt.pdf", "application/pdf", [1, 2, 3, 4])], HighPriority: true, FromName: "Riverside");

    private static async Task<List<EmailOutboxMessage>> RowsAsync(TestHost host)
    {
        using var scope = host.NewScope();
        return await scope.ServiceProvider.GetRequiredService<MainframeDbContext>().EmailOutbox.AsNoTracking().ToListAsync();
    }

    [Fact]
    public async Task Queueing_stores_the_message_and_never_reaches_the_mail_server()
    {
        await using var host = await TestHost.CreateAsync();
        host.EmailService.FailWhen = _ => throw new InvalidOperationException("the transport must not be touched while queueing");

        await Outbox(host).SendAsync(Mail("ada@riverside.review.test"));

        var row = Assert.Single(await RowsAsync(host));
        Assert.Equal(EmailOutboxState.Pending, row.State);
        Assert.Equal("ada@riverside.review.test", row.ToAddress);
        Assert.Equal("Booking confirmed", row.Subject);
        Assert.Empty(host.EmailService.Sent);
    }

    [Fact]
    public async Task A_queued_message_is_sent_whole_and_its_body_is_dropped_from_the_row()
    {
        await using var host = await TestHost.CreateAsync();
        await Outbox(host).SendAsync(Mail("ada@riverside.review.test"));

        Assert.Equal(1, await host.DeliverEmailOutboxAsync());

        var sent = Assert.Single(host.EmailService.Sent);
        Assert.Equal("ada@riverside.review.test", sent.To);
        Assert.True(sent.HighPriority);
        Assert.Equal("Riverside", sent.FromName);
        Assert.Equal("<p>Hello</p>", sent.HtmlBody);
        Assert.Equal("receipt.pdf", Assert.Single(sent.Attachments!).FileName);
        Assert.Equal(new byte[] { 1, 2, 3, 4 }, sent.Attachments![0].Content);

        var row = Assert.Single(await RowsAsync(host));
        Assert.Equal(EmailOutboxState.Sent, row.State);
        Assert.Equal("{}", row.PayloadJson);
        Assert.NotNull(row.FinishedAt);

        Assert.Equal(0, await host.DeliverEmailOutboxAsync());
        Assert.Single(host.EmailService.Sent);
    }

    [Fact]
    public async Task Demo_mail_is_dropped_before_it_is_stored()
    {
        await using var host = await TestHost.CreateAsync();
        var outbox = Outbox(host);

        await outbox.SendAsync(Mail("nobody@demo.crusaders.invalid"));
        Assert.Empty(await RowsAsync(host));

        // A REAL address typed onto a made-up member, while the flow acts for a demo club.
        var demoClub = Guid.NewGuid();
        DemoTenants.Register(demoClub);
        DemoTenants.Enter(demoClub);
        try { await outbox.SendAsync(Mail("real.person@riverside.review.test")); }
        finally { DemoTenants.Enter(Guid.NewGuid()); }
        Assert.Empty(await RowsAsync(host));

        await outbox.SendAsync(Mail("real.person@riverside.review.test"));
        Assert.Single(await RowsAsync(host));
    }

    [Fact]
    public async Task A_refused_send_backs_off_and_is_retried_without_a_duplicate()
    {
        await using var host = await TestHost.CreateAsync();
        await Outbox(host).SendAsync(Mail("ada@riverside.review.test"));
        var t0 = TestHost.Storable(DateTimeOffset.UtcNow);

        host.EmailService.FailWhen = _ => true;
        Assert.Equal(0, await host.DeliverEmailOutboxAsync(t0));

        var row = Assert.Single(await RowsAsync(host));
        Assert.Equal(EmailOutboxState.Pending, row.State);
        Assert.Equal(1, row.Attempts);
        Assert.Equal(t0 + EmailOutboxDispatcher.Backoffs[0], row.DueAt);
        Assert.Contains("Refused", row.LastError);
        Assert.Empty(host.EmailService.Sent);

        // Not due yet: nothing is claimed.
        Assert.Equal(0, await host.DeliverEmailOutboxAsync(t0 + TimeSpan.FromSeconds(5)));
        Assert.Equal(1, Assert.Single(await RowsAsync(host)).Attempts);

        host.EmailService.FailWhen = null;
        Assert.Equal(1, await host.DeliverEmailOutboxAsync(t0 + EmailOutboxDispatcher.Backoffs[0]));
        Assert.Single(host.EmailService.Sent);
        Assert.Equal(EmailOutboxState.Sent, Assert.Single(await RowsAsync(host)).State);
    }

    [Fact]
    public async Task A_mail_that_never_goes_is_given_up_and_the_clubs_admins_are_told()
    {
        await using var host = await TestHost.CreateAsync();
        var admin = host.AdminUser;
        host.EmailService.FailWhen = _ => true;

        // The flow that queued it was acting for the host's club.
        AmbientTenant.Enter(host.Tenant.Id);
        await Outbox(host).SendAsync(Mail("ada@riverside.review.test", "Your court is booked"));

        var now = TestHost.Storable(DateTimeOffset.UtcNow);
        for (var attempt = 1; attempt <= EmailOutboxDispatcher.MaxAttempts; attempt++)
        {
            await host.DeliverEmailOutboxAsync(now);
            now += TimeSpan.FromDays(1);
        }

        var row = Assert.Single(await RowsAsync(host));
        Assert.Equal(EmailOutboxState.Failed, row.State);
        Assert.Equal(EmailOutboxDispatcher.MaxAttempts, row.Attempts);
        Assert.Equal("{}", row.PayloadJson);

        using var scope = host.NewScope();
        var notice = await scope.ServiceProvider.GetRequiredService<MainframeDbContext>()
            .AdminNotifications.IgnoreQueryFilters().AsNoTracking().SingleAsync(n => n.Kind == AdminEventCatalogue.EmailUndeliverable);
        Assert.Equal(host.Tenant.Id, notice.TenantId);
        Assert.Contains("Your court is booked", notice.Headline);

        // And the notice itself is mailed straight through the transport, not queued behind the dead server.
        host.EmailService.FailWhen = null;
        await host.DeliverAdminNoticesAsync(now);
        var told = Assert.Single(host.EmailService.Sent, m => m.Subject.Contains("could not be delivered"));
        Assert.Equal(admin.Email, told.To);
        Assert.DoesNotContain(await RowsAsync(host), r => r.State == EmailOutboxState.Pending);
    }

    [Fact]
    public async Task Finished_rows_are_purged_on_their_own_horizons()
    {
        await using var host = await TestHost.CreateAsync();
        var now = TestHost.Storable(DateTimeOffset.UtcNow);
        using (var scope = host.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            EmailOutboxMessage Row(EmailOutboxState s, TimeSpan age) => new()
            {
                ToAddress = "a@x.review.test",
                Subject = "s",
                State = s,
                CreatedAt = now - age,
                DueAt = now - age,
                FinishedAt = now - age,
            };
            db.EmailOutbox.AddRange(
                Row(EmailOutboxState.Sent, TimeSpan.FromDays(8)), Row(EmailOutboxState.Sent, TimeSpan.FromDays(1)),
                Row(EmailOutboxState.Failed, TimeSpan.FromDays(31)), Row(EmailOutboxState.Failed, TimeSpan.FromDays(10)));
            db.EmailOutbox.Add(new EmailOutboxMessage { ToAddress = "a@x.review.test", Subject = "waiting", CreatedAt = now - TimeSpan.FromDays(60), DueAt = now });
            await db.SaveChangesAsync();
            Assert.Equal(2, await EmailOutboxRetention.PurgeAsync(db, now, default));
        }

        Assert.Equal(3, (await RowsAsync(host)).Count);
        Assert.Contains(await RowsAsync(host), r => r.Subject == "waiting");
    }
}
