using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Payments.PayFast;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using static Crusaders.Mainframe.Tests.PurchaseKit;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// What a PayFast ITN must survive before money moves (money lane BM-1/BM-2/BM-3/BM-13, platform
/// BP-01, browser BM-03) — each test varies ONE field of an otherwise genuine notification or of
/// the club's configuration, because every fixture before this one carried a passphrase, an
/// <c>amount_gross</c> and one payment id, which is exactly why the suite was green while all
/// three were reproducible on the live stack.
/// </summary>
public sealed class ItnTrustHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private static string Url(PurchaseClub club) => $"{CallbackPath}?tenant={club.Slug}";

    private static async Task<string?> ErrorOf(HttpResponseMessage res)
        => (await res.Content.ReadFromJsonAsync<JsonElement>()).TryGetProperty("error", out var e) ? e.GetString() : null;

    private static async Task<(int Balance, int Rows)> TotalsAsync(WebApplicationFactory<Program> factory, PurchaseClub club)
    {
        var rows = await LedgerAsync(factory, club, club.MemberUserId);
        return (rows.Sum(r => r.AmountMinutes), rows.Count);
    }

    private static Task<List<AdminNotification>> NoticesAsync(WebApplicationFactory<Program> factory, PurchaseClub club, string reason)
        => ReadAsync(factory, db => db.AdminNotifications.IgnoreQueryFilters()
            .Where(n => n.TenantId == club.TenantId && n.DedupeKey.StartsWith($"{AdminEventCatalogue.TopUpFailed}:{reason}:"))
            .ToListAsync());

    // ---- BM-1 / BP-01: the club must have a passphrase ----------------------------

    /// <summary>
    /// The live repro: a club with NO passphrase, a checkout id, and an unauthenticated POST of
    /// public fields signed with nothing — 300 minutes and R550 of "revenue". Now the club is not
    /// configured for payments at all, so neither the purchase nor the forge gets anywhere.
    /// </summary>
    [SkippableTheory]
    [InlineData("")]
    [InlineData("REPLACE_WITH_PAYFAST_PASSPHRASE")]
    [InlineData("short-pass")]
    public async Task A_club_without_a_real_passphrase_takes_no_payment_and_credits_no_forged_itn(string passphrase)
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var club = await SeedAsync(factory, "pp");
        // Registered while the club was configured, so a checkout id exists to forge against.
        var bought = await BuyAsync(Member(factory, club), club.FiveHours);
        await SetPayFastAsync(factory, club, PayFastJson(MerchantId, MerchantKey, passphrase, "test"));

        var forged = await factory.CreateClient().PostAsync(Url(club), Itn(bought.CheckoutId, "550.00", "7100001", passphrase: passphrase));
        Assert.Equal(HttpStatusCode.ServiceUnavailable, forged.StatusCode);
        Assert.Equal("payments_not_configured", await ErrorOf(forged));

        var again = await Member(factory, club).PostAsJsonAsync("/api/v1/minutes/purchase", new { packageId = club.OneHour, quotedPriceZar = 120m });
        Assert.Equal(HttpStatusCode.ServiceUnavailable, again.StatusCode);
        Assert.Equal((0, 0), await TotalsAsync(factory, club));
    }

    /// <summary>
    /// BM-03: the seeded <c>REPLACE_WITH_…</c> merchant passed the old emptiness check and sent the
    /// member to PayFast's "merchant_id must be 8 digits" page. A value PayFast itself would refuse
    /// is now "not configured", said by this club before the member leaves it.
    /// </summary>
    [SkippableTheory]
    [InlineData("REPLACE_WITH_PAYFAST_MERCHANT_ID", MerchantKey)]
    [InlineData("1000010", MerchantKey)]
    [InlineData(MerchantId, "REPLACE_WITH_PAYFAST_MERCHANT_KEY")]
    [InlineData(MerchantId, "46f0cd694581")]
    public async Task A_merchant_id_or_key_payfast_would_refuse_counts_as_not_configured(string merchantId, string merchantKey)
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var club = await SeedAsync(factory, "mk");
        await SetPayFastAsync(factory, club, PayFastJson(merchantId, merchantKey, Passphrase, "test"));

        var res = await Member(factory, club).PostAsJsonAsync("/api/v1/minutes/purchase", new { packageId = club.OneHour, quotedPriceZar = 120m });
        Assert.Equal(HttpStatusCode.ServiceUnavailable, res.StatusCode);
        Assert.Equal("payments_not_configured", await ErrorOf(res));
        Assert.Empty(await ReadAsync(factory, db => db.PendingTopups.IgnoreQueryFilters().Where(p => p.TenantId == club.TenantId).ToListAsync()));
    }

    // ---- BM-1: the amount must be present ------------------------------------------

    /// <summary>
    /// The live repro's second half: a COMPLETE carrying only the ids and the status, no
    /// <c>amount_gross</c>, was credited because the amount check ran only when the field was there.
    /// Refused without touching the row; the well-formed retry then credits.
    /// </summary>
    [SkippableFact]
    public async Task A_complete_with_no_amount_is_refused_and_the_purchase_stays_open()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var club = await SeedAsync(factory, "am");
        var bought = await BuyAsync(Member(factory, club), club.FiveHours);

        var bare = await factory.CreateClient().PostAsync(Url(club),
            Itn(bought.CheckoutId, "550.00", "7200001", edit: f => f.RemoveAll(x => x.Key.StartsWith("amount_", StringComparison.Ordinal))));
        Assert.Equal(HttpStatusCode.BadRequest, bare.StatusCode);
        Assert.Equal("amount_missing", await ErrorOf(bare));
        Assert.Equal((0, 0), await TotalsAsync(factory, club));
        Assert.Equal(TopUpStatus.Pending, (await RowAsync(factory, bought.Id)).Status);
        Assert.Single(await NoticesAsync(factory, club, TopUpAlerts.AmountMissing));

        var whole = await factory.CreateClient().PostAsync(Url(club), Itn(bought.CheckoutId, "550.00", "7200001"));
        Assert.Equal(HttpStatusCode.OK, whole.StatusCode);
        Assert.Equal((300, 1), await TotalsAsync(factory, club));
    }

    /// <summary>A FAILED with no amount moves no money, so it still settles the row (a decline is never stuck).</summary>
    [SkippableFact]
    public async Task A_decline_with_no_amount_still_settles_the_purchase()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var club = await SeedAsync(factory, "ad");
        var bought = await BuyAsync(Member(factory, club), club.OneHour);

        var res = await factory.CreateClient().PostAsync(Url(club),
            Itn(bought.CheckoutId, "120.00", "7250001", status: "FAILED", edit: f => f.RemoveAll(x => x.Key == "amount_gross")));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal(TopUpStatus.Failed, (await RowAsync(factory, bought.Id)).Status);
    }

    // ---- BM-1: the merchant must be this club's -----------------------------------

    [SkippableTheory]
    [InlineData("10000101")]
    [InlineData(null)]
    public async Task A_signed_itn_naming_another_merchant_or_none_is_refused(string? merchantId)
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var club = await SeedAsync(factory, "mm");
        var bought = await BuyAsync(Member(factory, club), club.FiveHours);

        var res = await factory.CreateClient().PostAsync(Url(club), Itn(bought.CheckoutId, "550.00", "7300001", edit: f =>
        {
            f.RemoveAll(x => x.Key == "merchant_id");
            if (merchantId is not null) f.Add(new("merchant_id", merchantId));
        }));

        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        Assert.Equal("merchant_mismatch", await ErrorOf(res));
        Assert.Equal((0, 0), await TotalsAsync(factory, club));
        Assert.Single(await NoticesAsync(factory, club, TopUpAlerts.MerchantMismatch));
    }

    // ---- BM-1: PayFast's validate call ---------------------------------------------

    /// <summary>
    /// PayFast's own server is asked before money moves. INVALID (a leaked passphrase, a forgery)
    /// credits nothing and tells the admins; UNREACHABLE answers 503 so PayFast retries, and the
    /// purchase stays open for that retry.
    /// </summary>
    [SkippableTheory]
    [InlineData(ItnValidation.Invalid, HttpStatusCode.Unauthorized, "validation_failed")]
    [InlineData(ItnValidation.Unavailable, HttpStatusCode.ServiceUnavailable, "payfast_unreachable")]
    public async Task A_complete_payfast_does_not_confirm_credits_nothing(ItnValidation answer, HttpStatusCode expected, string error)
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString, PayFastValidation = answer };
        var club = await SeedAsync(factory, "va");
        var bought = await BuyAsync(Member(factory, club), club.FiveHours);

        var res = await factory.CreateClient().PostAsync(Url(club), Itn(bought.CheckoutId, "550.00", "7400001"));

        Assert.Equal(expected, res.StatusCode);
        Assert.Equal(error, await ErrorOf(res));
        Assert.Equal(1, factory.ItnValidator.Calls);
        Assert.Equal((0, 0), await TotalsAsync(factory, club));
        Assert.Equal(TopUpStatus.Pending, (await RowAsync(factory, bought.Id)).Status);
        Assert.Equal(answer == ItnValidation.Invalid ? 1 : 0, (await NoticesAsync(factory, club, TopUpAlerts.ValidationFailed)).Count);
    }

    /// <summary>A forged FAILED must not close a member's open checkout either: the validate call guards every write.</summary>
    [SkippableFact]
    public async Task A_decline_payfast_does_not_confirm_leaves_the_purchase_open()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString, PayFastValidation = ItnValidation.Invalid };
        var club = await SeedAsync(factory, "vd");
        var bought = await BuyAsync(Member(factory, club), club.OneHour);

        var res = await factory.CreateClient().PostAsync(Url(club), Itn(bought.CheckoutId, "120.00", "7450001", status: "FAILED"));

        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        Assert.Equal(TopUpStatus.Pending, (await RowAsync(factory, bought.Id)).Status);
    }

    /// <summary>A retry of a payment already credited changes nothing, so it costs no call to PayFast.</summary>
    [SkippableFact]
    public async Task Only_a_notification_that_would_change_something_is_confirmed()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        var club = await SeedAsync(factory, "vc");
        var bought = await BuyAsync(Member(factory, club), club.FiveHours);

        await factory.CreateClient().PostAsync(Url(club), Itn(bought.CheckoutId, "550.00", "7460001"));
        var replay = await factory.CreateClient().PostAsync(Url(club), Itn(bought.CheckoutId, "550.00", "7460001"));

        Assert.True((await replay.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("idempotent").GetBoolean());
        Assert.Equal(1, factory.ItnValidator.Calls);
    }

    // ---- the source check ------------------------------------------------------------

    /// <summary>
    /// Advisory by default: a notification from an address that is not PayFast's is still judged on
    /// its signature and PayFast's answer, and the admins hear about the address once a day.
    /// Enforced: refused (403), nothing credited.
    /// </summary>
    [SkippableTheory]
    [InlineData("advisory", HttpStatusCode.OK, 300)]
    [InlineData("enforce", HttpStatusCode.Forbidden, 0)]
    public async Task An_itn_from_an_unknown_address_is_noted_or_refused_by_configuration(string mode, HttpStatusCode expected, int credited)
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var host = new TestWebAppFactory { ConnectionString = pg.ConnectionString, RemoteIpAddress = IPAddress.Parse("203.0.113.9") };
        await using var factory = host.WithWebHostBuilder(b => b.UseSetting(PayFastSourceCheck.ModeConfigKey, mode));
        var club = await SeedAsync(factory, "sc");
        var bought = await BuyAsync(Member(factory, club), club.FiveHours);

        var res = await factory.CreateClient().PostAsync(Url(club), Itn(bought.CheckoutId, "550.00", "7500001"));

        Assert.Equal(expected, res.StatusCode);
        Assert.Equal(credited, (await TotalsAsync(factory, club)).Balance);
        Assert.Single(await NoticesAsync(factory, club, TopUpAlerts.SourceUnrecognised));
    }

    /// <summary>PayFast's own range is recognised even when enforced: the check refuses strangers, not PayFast.</summary>
    [SkippableFact]
    public async Task An_itn_from_payfasts_published_range_passes_an_enforced_check()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var host = new TestWebAppFactory { ConnectionString = pg.ConnectionString, RemoteIpAddress = IPAddress.Parse("197.97.145.150") };
        await using var factory = host.WithWebHostBuilder(b => b.UseSetting(PayFastSourceCheck.ModeConfigKey, "enforce"));
        var club = await SeedAsync(factory, "sp");
        var bought = await BuyAsync(Member(factory, club), club.FiveHours);

        var res = await factory.CreateClient().PostAsync(Url(club), Itn(bought.CheckoutId, "550.00", "7510001"));

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Empty(await NoticesAsync(factory, club, TopUpAlerts.SourceUnrecognised));
    }

    // ---- BM-2: one checkout, credited once ------------------------------------------

    /// <summary>
    /// The live repro: eight concurrent signed COMPLETEs for ONE purchase, each with its own
    /// <c>pf_payment_id</c>, credited it three times — each built a different ledger reference, so
    /// the unique index never collided. Now exactly one credits, and every other one is a second
    /// payment the admins are told about, never a second credit.
    /// </summary>
    [SkippableTheory]
    [InlineData(2)]
    [InlineData(8)]
    public async Task Concurrent_completes_with_different_payment_ids_credit_one_checkout_once(int deliveries)
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var club = await SeedAsync(factory, "cc");
        var bought = await BuyAsync(Member(factory, club), club.OneHour);

        var answers = await Task.WhenAll(Enumerable.Range(0, deliveries).Select(i =>
            factory.CreateClient().PostAsync(Url(club), Itn(bought.CheckoutId, "120.00", $"76{deliveries}{i:D4}"))));

        Assert.All(answers, a => Assert.Equal(HttpStatusCode.OK, a.StatusCode));
        Assert.Equal((60, 1), await TotalsAsync(factory, club));

        var row = await RowAsync(factory, bought.Id);
        var entry = Assert.Single(await LedgerAsync(factory, club, club.MemberUserId));
        Assert.Equal(TopUpStatus.Completed, row.Status);
        Assert.Equal(bought.Id, entry.PurchaseId);
        Assert.Equal($"topup:{club.TenantId:N}:{row.ExternalReference}", entry.ExternalReference);
        Assert.Equal(deliveries - 1, (await NoticesAsync(factory, club, TopUpAlerts.PaidTwice)).Count);
    }

    /// <summary>The database refuses a second credit for one purchase even if the code above it were removed.</summary>
    [SkippableFact]
    public async Task The_database_refuses_a_second_top_up_row_for_one_purchase()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var club = await SeedAsync(factory, "dbc");
        var bought = await BuyAsync(Member(factory, club), club.OneHour);
        await factory.CreateClient().PostAsync(Url(club), Itn(bought.CheckoutId, "120.00", "7700001"));

        var second = new LedgerEntry
        {
            TenantId = club.TenantId,
            UserId = club.MemberUserId,
            Type = LedgerEntryType.TopUp,
            AmountMinutes = 60,
            ActorUserId = club.MemberUserId,
            ExternalReference = $"topup:{club.TenantId:N}:7700002",
            PurchaseId = bought.Id,
        };
        var ex = await Assert.ThrowsAsync<DbUpdateException>(() => WriteAsync(factory, db => { db.LedgerEntries.Add(second); return Task.CompletedTask; }));
        Assert.Equal("IX_ledger_entries_TenantId_PurchaseId", ((Npgsql.PostgresException)ex.InnerException!).ConstraintName);
    }

    /// <summary>
    /// Cross-tenant injection: club B's checkout named in an ITN posted under club A's slug is not
    /// found — the purchase lookup is tenant-filtered — and the new per-purchase index is per club,
    /// so it cannot let one club's purchase block another's.
    /// </summary>
    [SkippableFact]
    public async Task Another_clubs_checkout_cannot_be_completed_through_this_clubs_callback()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var clubA = await SeedAsync(factory, "xa");
        var clubB = await SeedAsync(factory, "xb");
        var boughtB = await BuyAsync(Member(factory, clubB), clubB.OneHour);

        var res = await factory.CreateClient().PostAsync(Url(clubA), Itn(boughtB.CheckoutId, "120.00", "7800001"));

        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        Assert.Equal((0, 0), await TotalsAsync(factory, clubA));
        Assert.Equal((0, 0), await TotalsAsync(factory, clubB));
        Assert.Equal(TopUpStatus.Pending, (await RowAsync(factory, boughtB.Id)).Status);
    }

    /// <summary>
    /// A FAILED racing a COMPLETE for one purchase: whichever lands first decides, and the loser
    /// never overwrites it — the failure write used to be an unconditional tracked save that could
    /// turn a credited purchase "Failed" and mail the member it had failed.
    /// </summary>
    [SkippableFact]
    public async Task A_decline_racing_a_completion_never_overwrites_it()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var club = await SeedAsync(factory, "rf");
        var client = Member(factory, club);

        for (var i = 0; i < 6; i++)
        {
            var bought = await BuyAsync(client, club.OneHour);
            await Task.WhenAll(
                factory.CreateClient().PostAsync(Url(club), Itn(bought.CheckoutId, "120.00", $"79{i:D5}")),
                factory.CreateClient().PostAsync(Url(club), Itn(bought.CheckoutId, "120.00", $"79{i:D5}", status: "FAILED")));

            var row = await RowAsync(factory, bought.Id);
            var credited = (await LedgerAsync(factory, club, club.MemberUserId)).Count(l => l.PurchaseId == bought.Id);
            Assert.Equal(row.Status == TopUpStatus.Completed ? 1 : 0, credited);
        }
    }

    // ---- BM-3: a second genuine payment is flagged, not swallowed --------------------

    /// <summary>
    /// The probe: pf-A credited, pf-B answered 200 "idempotent", one ledger row, nobody told. Now
    /// pf-B is acknowledged (PayFast stops retrying) as <c>paid_twice</c>, the admins get a notice
    /// naming pf-B and ITS amount, the member is mailed, and a retry of pf-B raises nothing new.
    /// </summary>
    [SkippableFact]
    public async Task A_second_payment_for_a_credited_checkout_is_flagged_and_mailed_once()
    {
        Skip.IfNot(pg.Available, Skipped);
        var mail = new StubEmailService();
        await using var factory = pg.SharedHost.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IEmailService>();
            s.AddSingleton<IEmailService>(mail);
        }));
        var club = await SeedAsync(factory, "pt");
        var bought = await BuyAsync(Member(factory, club), club.FiveHours);
        Assert.Equal(HttpStatusCode.OK, (await factory.CreateClient().PostAsync(Url(club), Itn(bought.CheckoutId, "550.00", "8100001"))).StatusCode);

        var second = await factory.CreateClient().PostAsync(Url(club), Itn(bought.CheckoutId, "550.00", "8100002"));
        var body = await second.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);
        Assert.False(body.GetProperty("ok").GetBoolean());
        Assert.Equal("paid_twice", body.GetProperty("reason").GetString());
        Assert.False(body.TryGetProperty("idempotent", out _));

        await factory.CreateClient().PostAsync(Url(club), Itn(bought.CheckoutId, "550.00", "8100002"));

        Assert.Equal((300, 1), await TotalsAsync(factory, club));
        var notice = Assert.Single(await NoticesAsync(factory, club, TopUpAlerts.PaidTwice));
        var payload = JsonSerializer.Deserialize<TopUpFailedPayload>(notice.PayloadJson, AdminEventCatalogue.Json)!;
        Assert.Equal("8100002", payload.Reference);
        Assert.Equal(550m, payload.AmountZar);
        Assert.Equal(club.MemberUserId, notice.SubjectUserId);

        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (DateTime.UtcNow < deadline && !mail.Sent.Any(m => m.Subject.Contains("second payment", StringComparison.Ordinal))) await Task.Delay(25);
        var told = Assert.Single(mail.Sent, m => m.Subject.Contains("second payment", StringComparison.Ordinal));
        Assert.Equal(club.MemberEmail, told.To);
        Assert.Contains("8100002", told.HtmlBody, StringComparison.Ordinal);
    }

    /// <summary>
    /// A genuine COMPLETE for a checkout the gateway had already CANCELLED: still not credited
    /// (D2-B04), but money moved, so the desk is told. A retry of the notification that failed a
    /// row on its amount is the exception — it was raised as <c>amount_mismatch</c> already.
    /// </summary>
    [SkippableFact]
    public async Task A_payment_after_the_gateway_closed_the_checkout_is_flagged_not_credited()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var club = await SeedAsync(factory, "pac");
        var cancelled = await BuyAsync(Member(factory, club), club.OneHour);
        var mismatched = await BuyAsync(Member(factory, club), club.OneHour);
        await factory.CreateClient().PostAsync(Url(club), Itn(cancelled.CheckoutId, "120.00", "8200001", status: "CANCELLED"));
        await factory.CreateClient().PostAsync(Url(club), Itn(mismatched.CheckoutId, "1.00", "8200002"));

        var late = await factory.CreateClient().PostAsync(Url(club), Itn(cancelled.CheckoutId, "120.00", "8200003"));
        var retry = await factory.CreateClient().PostAsync(Url(club), Itn(mismatched.CheckoutId, "1.00", "8200002"));

        Assert.Equal("already_settled", (await late.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("reason").GetString());
        Assert.Equal(HttpStatusCode.OK, retry.StatusCode);
        Assert.Equal((0, 0), await TotalsAsync(factory, club));
        var flagged = Assert.Single(await NoticesAsync(factory, club, TopUpAlerts.PaidAfterClose));
        Assert.EndsWith(":8200003", flagged.DedupeKey, StringComparison.Ordinal);
    }
}
