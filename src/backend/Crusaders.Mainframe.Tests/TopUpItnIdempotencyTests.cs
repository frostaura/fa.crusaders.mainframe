using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Microsoft.EntityFrameworkCore;
using static Crusaders.Mainframe.Tests.PurchaseKit;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The ITN's idempotency, tested the way PayFast actually behaves rather than the way the
/// fixtures assumed it does.
///
/// <para>
/// <b>Every fixture in <see cref="TopUpFlowTests"/> sends a <c>pf_payment_id</c>.</b> That one
/// setup field is why D2-B01 through D2-B04 survived a suite with full coverage of this path:
/// the only idempotency guard on the money-in route is a unique index filtered
/// <c>WHERE "ExternalReference" IS NOT NULL</c>, and <c>PaymentId</c> is
/// <c>Field("pf_payment_id")</c>, which is <b>null when the field is missing</b>. Vary that one
/// field and the guard is simply not there — two deliveries of the same payment both credit.
/// This file varies it.
/// </para>
/// </summary>
public sealed class TopUpItnIdempotencyTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg = pg;

    private static async Task<(int Balance, int Rows)> TotalsAsync(TestWebAppFactory factory, PurchaseClub club)
    {
        var rows = await LedgerAsync(factory, club, club.MemberUserId);
        return (rows.Sum(r => r.AmountMinutes), rows.Count);
    }

    // ---- D2-B01: an ITN with no pf_payment_id --------------------------------

    /// <summary>
    /// <b>D2-B01.</b> <c>ExternalReference: interp.PaymentId</c>, and <c>PaymentId</c> is
    /// <c>Field("pf_payment_id")</c> — null when the field is missing. A null reference is
    /// excluded by the index filter, so the ONE idempotency guard on the money-in path
    /// disappears, and the <c>Status == Completed</c> short-circuit does not help because two
    /// deliveries racing each other both read <c>Pending</c>.
    ///
    /// <para>
    /// Answered <c>400 payment_id_missing</c> rather than credited-once: a notification with no
    /// payment id cannot be made idempotent by anything, and PayFast retrying into a 400 is a
    /// club that has not been paid rather than a member credited twice. The refusal is visible;
    /// the double credit was not.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task An_ITN_with_no_payment_id_is_refused_rather_than_credited()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        var factory = _pg.SharedHost;
        var seeded = await SeedAsync(factory, "itn");
        var client = Member(factory, seeded);
        var checkoutId = (await BuyAsync(client, seeded.FiveHours)).CheckoutId;

        var first = await client.PostAsync($"{CallbackPath}?tenant={seeded.Slug}", Itn(checkoutId, "550.00", pfPaymentId: ""));
        Assert.Equal(HttpStatusCode.BadRequest, first.StatusCode);
        Assert.Equal("payment_id_missing",
            (await first.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());

        // The delivery PayFast will make again.
        var second = await client.PostAsync($"{CallbackPath}?tenant={seeded.Slug}", Itn(checkoutId, "550.00", pfPaymentId: ""));
        Assert.Equal(HttpStatusCode.BadRequest, second.StatusCode);

        var (balance, rows) = await TotalsAsync(factory, seeded);
        Assert.Equal(0, rows);
        Assert.Equal(0, balance);

        // And the row is still Pending, so a properly-formed retry can still complete it.
        var pending = await ReadAsync(factory, db => db.PendingTopups.IgnoreQueryFilters().FirstAsync(p => p.IdempotencyKey == checkoutId));
        Assert.Equal(TopUpStatus.Pending, pending.Status);
    }

    /// <summary>A well-formed retry of the same payment credits exactly once.</summary>
    [SkippableFact]
    public async Task A_retried_ITN_for_one_payment_credits_once()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        var factory = _pg.SharedHost;
        var seeded = await SeedAsync(factory, "itn");
        var client = Member(factory, seeded);
        var checkoutId = (await BuyAsync(client, seeded.FiveHours)).CheckoutId;

        for (var attempt = 0; attempt < 3; attempt++)
        {
            var res = await client.PostAsync($"{CallbackPath}?tenant={seeded.Slug}", Itn(checkoutId, "550.00", "5150001"));
            Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        }

        var (balance, rows) = await TotalsAsync(factory, seeded);
        Assert.Equal(1, rows);
        Assert.Equal(300, balance);
    }

    /// <summary>
    /// <b>D2-B03.</b> Two deliveries of one payment IN FLIGHT AT ONCE. The read-then-write
    /// short-circuit loses this race by construction — under READ COMMITTED neither can see the
    /// other's uncommitted row — so the filtered unique index is the only thing that decides it,
    /// and the ITN was the one <c>PostAsync</c> caller with no <c>DbUpdateException</c> catch.
    /// The loser escaped as a 500 and PayFast retried into it.
    /// </summary>
    [SkippableFact]
    public async Task Two_concurrent_deliveries_of_one_payment_credit_once_and_neither_is_a_500()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        var factory = _pg.SharedHost;
        var seeded = await SeedAsync(factory, "itn");
        var client = Member(factory, seeded);
        var checkoutId = (await BuyAsync(client, seeded.FiveHours)).CheckoutId;

        var both = await Task.WhenAll(
            client.PostAsync($"{CallbackPath}?tenant={seeded.Slug}", Itn(checkoutId, "550.00", "5150002")),
            client.PostAsync($"{CallbackPath}?tenant={seeded.Slug}", Itn(checkoutId, "550.00", "5150002")));

        Assert.All(both, r => Assert.Equal(HttpStatusCode.OK, r.StatusCode));

        var (balance, rows) = await TotalsAsync(factory, seeded);
        Assert.Equal(1, rows);
        Assert.Equal(300, balance);
    }

    /// <summary>
    /// The duplicate catch, provoked DETERMINISTICALLY rather than by hoping two requests race.
    ///
    /// <para>
    /// Two separate registrations by one member reporting the same <c>pf_payment_id</c>. The
    /// first credits; the second cannot — the reference is taken — and the read-then-write
    /// short-circuit cannot see it, because it keys on the pending row's own status and this is
    /// a different pending row. So the filtered unique index is the only thing that decides it,
    /// which is precisely the shape two concurrent deliveries produce and which the TestServer
    /// will not reliably reproduce by running them at once.
    /// </para>
    ///
    /// <para>
    /// The answer is a 409 naming the collision rather than an idempotent 200: two
    /// registrations are two intents, and quietly marking the second Completed would tell the
    /// member their second R100 had been credited when it had not.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_second_registration_reusing_a_payment_id_is_refused_rather_than_500ing()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        var factory = _pg.SharedHost;
        var seeded = await SeedAsync(factory, "itn");
        var client = Member(factory, seeded);

        var firstCheckout = (await BuyAsync(client, seeded.FiveHours)).CheckoutId;
        var secondCheckout = (await BuyAsync(client, seeded.FiveHours)).CheckoutId;

        Assert.Equal(HttpStatusCode.OK, (await client.PostAsync(
            $"{CallbackPath}?tenant={seeded.Slug}", Itn(firstCheckout, "550.00", "5150030"))).StatusCode);

        var collided = await client.PostAsync(
            $"{CallbackPath}?tenant={seeded.Slug}", Itn(secondCheckout, "550.00", "5150030"));

        // Not a 500. That is the whole assertion: the ITN was the one PostAsync caller in the
        // tree with no DbUpdateException catch, so this escaped as an unhandled 500 and PayFast
        // retried into it until a retry happened to find the row Completed.
        Assert.NotEqual(HttpStatusCode.InternalServerError, collided.StatusCode);

        // 409 rather than an idempotent 200, because this is NOT a retry: it is a second
        // registration whose payment id is already spent, and it has not been paid for. Telling
        // the member it was credited would be the more comfortable lie.
        Assert.Equal(HttpStatusCode.Conflict, collided.StatusCode);
        Assert.Equal("payment_id_conflict",
            (await collided.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());

        // And the member was credited exactly once for the one payment that exists.
        var (balance, rows) = await TotalsAsync(factory, seeded);
        Assert.Equal(1, rows);
        Assert.Equal(300, balance);
    }

    // ---- D2-B02: the reference is not tenant-namespaced -----------------------

    /// <summary>
    /// <b>D2-B02.</b> The unique index on <c>ExternalReference</c> carries no
    /// <c>TenantId</c> — <c>WalletEndpoints.IdempotencyReference</c> prefixes adjustments by
    /// hand precisely to avoid this, and the purchase path did not. Two clubs on one PayFast
    /// merchant account, or a sandbox with small repeating ids, collide: the second club's
    /// post raises, and with D2-B03's missing catch that is a 500, a <c>PendingTopup</c> stuck
    /// at <c>Pending</c>, and <b>a member never credited for money PayFast took</b>.
    /// </summary>
    [SkippableFact]
    public async Task Two_clubs_sharing_a_payment_id_are_both_credited()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        var factory = _pg.SharedHost;
        var clubA = await SeedAsync(factory, "itna");
        var clubB = await SeedAsync(factory, "itnb");

        const string sharedPaymentId = "1000001";

        var checkoutA = (await BuyAsync(Member(factory, clubA), clubA.FiveHours)).CheckoutId;
        var checkoutB = (await BuyAsync(Member(factory, clubB), clubB.FiveHours)).CheckoutId;

        var a = await factory.CreateClient().PostAsync(
            $"{CallbackPath}?tenant={clubA.Slug}", Itn(checkoutA, "550.00", sharedPaymentId));
        var b = await factory.CreateClient().PostAsync(
            $"{CallbackPath}?tenant={clubB.Slug}", Itn(checkoutB, "550.00", sharedPaymentId));

        Assert.Equal(HttpStatusCode.OK, a.StatusCode);
        Assert.Equal(HttpStatusCode.OK, b.StatusCode);

        Assert.Equal((300, 1), await TotalsAsync(factory, clubA));
        Assert.Equal((300, 1), await TotalsAsync(factory, clubB));
    }

    /// <summary>The reference actually stored carries the tenant, so the two clubs' keys can never meet.</summary>
    [SkippableFact]
    public async Task A_purchase_reference_is_namespaced_by_tenant()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        var factory = _pg.SharedHost;
        var seeded = await SeedAsync(factory, "itn");
        var client = Member(factory, seeded);
        var checkoutId = (await BuyAsync(client, seeded.FiveHours)).CheckoutId;

        Assert.Equal(HttpStatusCode.OK,
            (await client.PostAsync($"{CallbackPath}?tenant={seeded.Slug}", Itn(checkoutId, "550.00", "5150003"))).StatusCode);

        var entry = await ReadAsync(factory, db => db.LedgerEntries.IgnoreQueryFilters()
            .FirstAsync(l => l.TenantId == seeded.TenantId && l.Type == LedgerEntryType.TopUp));

        Assert.Equal($"topup:{seeded.TenantId:N}:5150003", entry.ExternalReference);
    }

    // ---- D2-B04: Failed is terminal -------------------------------------------

    /// <summary>
    /// <b>D2-B04.</b> The short-circuit covered <c>Completed</c> only. The amount-mismatch path
    /// sets <c>Failed</c> and <b>keeps the original AmountZar and the locked minutes</b>, so a later
    /// signed COMPLETE for the same <c>m_payment_id</c> fell straight through and credited at
    /// the originally-quoted figure — for a purchase the member had already been emailed about as
    /// failed. Combined with D2-B01 it was repeatable.
    ///
    /// <para>
    /// Every terminal state is now terminal. <c>200</c>, not an error: PayFast retries until it
    /// is acknowledged, and a club that answers 4xx for ever gets retried for ever.
    /// </para>
    /// </summary>
    [SkippableTheory]
    [InlineData("FAILED")]
    [InlineData("CANCELLED")]
    public async Task A_terminal_purchase_is_not_resurrected_by_a_later_complete(string terminalStatus)
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        var factory = _pg.SharedHost;
        var seeded = await SeedAsync(factory, "itn");
        var client = Member(factory, seeded);
        var checkoutId = (await BuyAsync(client, seeded.FiveHours)).CheckoutId;

        Assert.Equal(HttpStatusCode.OK, (await client.PostAsync(
            $"{CallbackPath}?tenant={seeded.Slug}", Itn(checkoutId, "550.00", "5150004", terminalStatus))).StatusCode);

        var resurrect = await client.PostAsync(
            $"{CallbackPath}?tenant={seeded.Slug}", Itn(checkoutId, "550.00", "5150005"));

        Assert.Equal(HttpStatusCode.OK, resurrect.StatusCode);
        var body = await resurrect.Content.ReadFromJsonAsync<JsonElement>();
        Assert.False(body.GetProperty("ok").GetBoolean());
        Assert.Equal("already_settled", body.GetProperty("reason").GetString());

        var (balance, rows) = await TotalsAsync(factory, seeded);
        Assert.Equal(0, rows);
        Assert.Equal(0, balance);
    }

    /// <summary>
    /// The mismatch half of the same bug, which is the one that reached a member: R1 reported
    /// against a R1000 registration fails the row, and a later COMPLETE then credited the whole
    /// purchase for one rand. P13: still refused, against the LOCKED <c>AmountZar</c>.
    /// </summary>
    [SkippableFact]
    public async Task A_purchase_failed_for_an_amount_mismatch_cannot_later_be_completed()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        var factory = _pg.SharedHost;
        var seeded = await SeedAsync(factory, "itn");
        var client = Member(factory, seeded);
        var checkoutId = (await BuyAsync(client, seeded.TenHours)).CheckoutId;

        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsync(
            $"{CallbackPath}?tenant={seeded.Slug}", Itn(checkoutId, "1.00", "5150006"))).StatusCode);

        var later = await client.PostAsync(
            $"{CallbackPath}?tenant={seeded.Slug}", Itn(checkoutId, "1000.00", "5150007"));
        Assert.Equal(HttpStatusCode.OK, later.StatusCode);

        var (balance, rows) = await TotalsAsync(factory, seeded);
        Assert.Equal(0, rows);
        Assert.Equal(0, balance);
    }

    // ---- the cap is gone (P13 §3.6) -------------------------------------------

    /// <summary>
    /// A declined card is not money the member paid and costs them nothing: they may buy again at
    /// once. (It once guarded a per-member ceiling; with the cap gone it guards the member's
    /// way back to the shelf.)
    /// </summary>
    [SkippableFact]
    public async Task A_failed_purchase_leaves_the_member_free_to_buy_again()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        var factory = _pg.SharedHost;
        var seeded = await SeedAsync(factory, "itnf");
        var client = Member(factory, seeded);

        var checkoutId = (await BuyAsync(client, seeded.TenHours)).CheckoutId;
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsync(
            $"{CallbackPath}?tenant={seeded.Slug}", Itn(checkoutId, "1000.00", "5150020", "FAILED"))).StatusCode);

        await BuyAsync(client, seeded.TenHours);
    }

    /// <summary>
    /// There is nothing left to exempt an admin from (P13 §3.6): an admin buying for themselves
    /// takes the same shelf at the same price, and a member buys any number of packages.
    /// </summary>
    [SkippableFact]
    public async Task An_admin_buys_on_the_same_terms_as_a_member()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        var factory = _pg.SharedHost;
        var seeded = await SeedAsync(factory, "itnad");
        var admin = Admin(factory, seeded);

        var bought = await BuyAsync(admin, seeded.TenHours);
        Assert.Equal(1000m, bought.AmountZar);
        var wrong = await admin.PostAsJsonAsync("/api/v1/minutes/purchase", new { packageId = seeded.TenHours, quotedPriceZar = 5000m });
        Assert.Equal(HttpStatusCode.Conflict, wrong.StatusCode);
        Assert.Equal("package_price_changed", (await wrong.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());
    }
}
