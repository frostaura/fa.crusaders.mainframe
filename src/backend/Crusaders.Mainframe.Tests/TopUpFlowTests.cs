using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Payments.PayFast;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Email;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.IdentityModel.Tokens;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The member-facing top-up path, end to end over real HTTP against real SQL.
///
/// <para>
/// Nothing covered this. <see cref="PayFastProviderTests"/> proved the provider builds and
/// signs a form and <see cref="PayFastSignatureTests"/> proved the algorithm, and between
/// them sat an endpoint that never returned the form, never set the cancel URL and settled
/// at whatever conversion rate happened to be live when the notification arrived. All three
/// were invisible to a suite that stopped at the provider's own boundary.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class TopUpFlowTests
{
    private readonly PostgresFixture _pg;

    public TopUpFlowTests(PostgresFixture pg) => _pg = pg;

    private const string Secret = "test-only-signing-key-not-used-in-any-real-environment";
    private const string Passphrase = "not-a-real-passphrase-test-fixture-only";
    private const string MerchantId = "10000100";

    private sealed record Seeded(Guid TenantId, string Slug, Guid MemberUserId, string Email);

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    /// <summary>
    /// Invariant formatting, not the ambient culture: this machine's is en-ZA, so
    /// <c>1.6m.ToString()</c> writes "1,6" and Postgres refuses the document as invalid
    /// JSON — a failure that reads as a schema problem and is a locale problem.
    /// </summary>
    private static string N(decimal v) => v.ToString(System.Globalization.CultureInfo.InvariantCulture);

    private static string SettingsJson(decimal regularRate = 1.6m, decimal blockZar = 100m, decimal maxZar = 1000m) =>
        $$"""
        {
          "credits_per_zar_regular": {{N(regularRate)}},
          "credits_per_zar_league": 2.4,
          "topup_block_zar": {{N(blockZar)}},
          "topup_max_zar_per_member": {{N(maxZar)}},
          "payfast": {
            "merchant_id": "{{MerchantId}}",
            "merchant_key": "46f0cd694581a",
            "passphrase": "{{Passphrase}}",
            "environment": "test"
          }
        }
        """;

    private static async Task<Seeded> SeedAsync(TestWebAppFactory factory, string? settingsJson = null)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var slug = $"tu-{Guid.NewGuid():N}"[..20];
        var tenant = new Tenant { Slug = slug, DisplayName = "Top-up Club" };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings { TenantId = tenant.Id, SettingsJson = settingsJson ?? SettingsJson() });

        var email = $"{slug}@test.local";
        var member = new User { TenantId = tenant.Id, Email = email, PasswordHash = "x", EmailVerified = true };
        db.Users.Add(member);
        db.Memberships.Add(new Membership
        {
            TenantId = tenant.Id,
            UserId = member.Id,
            FullName = "Naledi Khoza",
            MembershipNumber = slug,
            Status = MembershipStatus.Active,
            MemberClass = MemberClass.Regular,
        });

        await db.SaveChangesAsync();
        return new Seeded(tenant.Id, slug, member.Id, email);
    }

    private static HttpClient MemberClient(TestWebAppFactory factory, Seeded s)
    {
        var token = new JwtSecurityToken(
            issuer: "crusaders.mainframe",
            audience: "crusaders.mainframe.app",
            claims:
            [
                new Claim(JwtRegisteredClaimNames.Sub, s.MemberUserId.ToString()),
                new Claim("tenant_id", s.TenantId.ToString()),
                new Claim("tenant_slug", s.Slug),
                new Claim("purpose", "access"),
            ],
            notBefore: DateTime.UtcNow,
            expires: DateTime.UtcNow.AddMinutes(10),
            signingCredentials: new SigningCredentials(
                new SymmetricSecurityKey(Encoding.UTF8.GetBytes(Secret)), SecurityAlgorithms.HmacSha256));

        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", new JwtSecurityTokenHandler().WriteToken(token));
        return client;
    }

    /// <summary>An ITN as PayFast composes it: fields in posted order, signature last.</summary>
    private static HttpContent SignedItn(string mPaymentId, string gross, string status = "COMPLETE")
    {
        var fields = new List<KeyValuePair<string, string?>>
        {
            new("m_payment_id", mPaymentId),
            new("pf_payment_id", Random.Shared.Next(1_000_000, 9_999_999).ToString()),
            new("payment_status", status),
            new("item_name", "Crusaders credits top-up"),
            new("amount_gross", gross),
            new("amount_fee", "-2.30"),
            new("amount_net", "97.70"),
            new("merchant_id", MerchantId),
        };

        var body = string.Join("&", fields
            .Select(f => $"{f.Key}={PayFastSignature.UrlEncode(f.Value!)}")
            .Append($"signature={PayFastSignature.Compute(fields, Passphrase)}"));

        return new StringContent(body, Encoding.UTF8, "application/x-www-form-urlencoded");
    }

    private static async Task<JsonElement> RegisterAsync(HttpClient client, decimal amountZar)
    {
        // amountZar, not amountCredits. The client posted the latter for the life of the
        // screen, so AmountZar bound to 0, the positivity guard fired, and no member could
        // top up at all — the error even told them the amount was a bad multiple of R100.
        var res = await client.PostAsJsonAsync("/api/v1/credit/topup", new { amountZar });
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return await res.Content.ReadFromJsonAsync<JsonElement>();
    }

    // ---- F2: the hand-off carries a signed form -----------------------------

    /// <summary>
    /// The endpoint returned <c>redirect_url</c> alone — the bare process URL, no query
    /// string — and the frontend followed it as a GET. That is a request to PayFast with no
    /// merchant id, no amount and no signature: no payment can start from it.
    /// </summary>
    [SkippableFact]
    public async Task Registering_a_topup_returns_the_signed_form_the_browser_must_post()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = MemberClient(factory, seeded);

        var body = await RegisterAsync(client, 100m);

        var fields = body.GetProperty("form_fields").EnumerateArray()
            .Select(f => (Name: f.GetProperty("name").GetString()!, Value: f.GetProperty("value").GetString()!))
            .ToList();

        Assert.Contains(fields, f => f.Name == "merchant_id" && f.Value == MerchantId);
        Assert.Contains(fields, f => f.Name == "amount" && f.Value == "100.00");
        Assert.Contains(fields, f => f.Name == "m_payment_id" && f.Value == body.GetProperty("checkout_id").GetString());

        // PayFast requires cancel_url and it was never set, so a member who backed out at
        // the gateway had nowhere to land.
        var cancel = Assert.Single(fields, f => f.Name == "cancel_url").Value;
        Assert.Contains("/wallet/topup/", cancel);

        // And the signature must verify over the rest, in the order emitted.
        var signature = Assert.Single(fields, f => f.Name == "signature").Value;
        Assert.True(PayFastSignature.Verify(
            fields.Where(f => f.Name != "signature").Select(f => new KeyValuePair<string, string?>(f.Name, f.Value)),
            Passphrase, signature));
    }

    // ---- F3: the rate is the one quoted, not the one live at settlement -----

    /// <summary>
    /// <b>The money test.</b> A member registers at 1.6, an admin moves the club to 2.4
    /// while they are on PayFast's card page, and the ITN lands. The member paid R100
    /// against 160 credits and must receive 160.
    ///
    /// <para>
    /// Mutation-proved: reverting <c>CompleteAsync</c> to
    /// <c>settings.ConversionRateFor(memberClass)</c> makes this fail with 240 against 160.
    /// It cuts the other way too, which is the damaging direction — a member quoted 320
    /// credits for R200 was credited 200 after the rate moved down.
    /// </para>
    /// </summary>
    [SkippableTheory]
    [InlineData(1.6, 2.4, 160)]  // rate raised after checkout — the club must not over-credit
    [InlineData(1.6, 1.0, 160)]  // rate cut after checkout — the member must not be short-changed
    public async Task A_topup_settles_at_the_rate_quoted_at_checkout(double registered, double atCallback, double expectedCredits)
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory, SettingsJson(regularRate: (decimal)registered));
        var client = MemberClient(factory, seeded);

        var body = await RegisterAsync(client, 100m);
        var mPaymentId = body.GetProperty("checkout_id").GetString()!;
        Assert.Equal((decimal)registered, body.GetProperty("conversion_rate").GetDecimal());

        // The admin moves the rate while the member is at the gateway.
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var row = await db.TenantSettings.IgnoreQueryFilters().FirstAsync(x => x.TenantId == seeded.TenantId);
            row.SettingsJson = SettingsJson(regularRate: (decimal)atCallback);
            await db.SaveChangesAsync();
        }

        var itn = await factory.CreateClient().PostAsync(
            $"/api/v1/credit/topup/callback?tenant={seeded.Slug}", SignedItn(mPaymentId, "100.00"));

        Assert.Equal(HttpStatusCode.OK, itn.StatusCode);
        var settled = await itn.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal((decimal)expectedCredits, settled.GetProperty("credits").GetDecimal());
        Assert.Equal((decimal)registered, settled.GetProperty("conversion_rate").GetDecimal());

        // And the ledger agrees with what the response claimed.
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var entry = await db.LedgerEntries.IgnoreQueryFilters()
                .SingleAsync(l => l.UserId == seeded.MemberUserId && l.Type == LedgerEntryType.TopUp);
            Assert.Equal((decimal)expectedCredits, entry.AmountCredits);
            Assert.Equal((decimal)registered, entry.ConversionRate);
            Assert.Equal(100m, entry.ZarPaid);
        }
    }

    // ---- F13: failure reasons are codes, and a cancellation is not a failure

    [SkippableFact]
    public async Task A_cancelled_payment_is_cancelled_rather_than_failed()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = MemberClient(factory, seeded);

        var body = await RegisterAsync(client, 100m);
        await factory.CreateClient().PostAsync(
            $"/api/v1/credit/topup/callback?tenant={seeded.Slug}",
            SignedItn(body.GetProperty("checkout_id").GetString()!, "100.00", status: "CANCELLED"));

        var status = await client.GetFromJsonAsync<JsonElement>(
            $"/api/v1/credit/topup/{body.GetProperty("topup_id").GetGuid()}");

        Assert.Equal("Cancelled", status.GetProperty("status").GetString());
        Assert.Equal("cancelled", status.GetProperty("failure_code").GetString());
    }

    /// <summary>
    /// The status page rendered <c>amount_mismatch:reported=100,00:expected=500,00</c> to a
    /// member as the explanation for a failed R500 payment. A code, and the numbers stay in
    /// the log where the person who needs them is.
    /// </summary>
    [SkippableFact]
    public async Task An_amount_mismatch_surfaces_a_code_and_not_an_internal_string()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = MemberClient(factory, seeded);

        var body = await RegisterAsync(client, 500m);
        var itn = await factory.CreateClient().PostAsync(
            $"/api/v1/credit/topup/callback?tenant={seeded.Slug}",
            SignedItn(body.GetProperty("checkout_id").GetString()!, "100.00"));
        Assert.Equal(HttpStatusCode.BadRequest, itn.StatusCode);

        var status = await client.GetFromJsonAsync<JsonElement>(
            $"/api/v1/credit/topup/{body.GetProperty("topup_id").GetGuid()}");

        Assert.Equal("Failed", status.GetProperty("status").GetString());
        Assert.Equal("amount_mismatch", status.GetProperty("failure_code").GetString());
        Assert.DoesNotContain("reported=", status.GetRawText());
    }

    // ---- the failure email the status screen promises -----------------------

    /// <summary>
    /// The app with email captured into <paramref name="mail"/>, so the ITN's background
    /// dispatch lands somewhere a test can read instead of dialling SMTP.
    /// </summary>
    private static WebApplicationFactory<Program> WithMail(TestWebAppFactory factory, StubEmailService mail)
        => factory.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IEmailService>();
            s.AddSingleton<IEmailService>(mail);
        }));

    /// <summary>
    /// The notice is dispatched on a background task — PayFast retries an ITN until it is
    /// acknowledged, so the handler must not wait on SMTP — which means it has not
    /// necessarily arrived by the time the response has.
    /// </summary>
    private static async Task<EmailMessage?> PollMailAsync(StubEmailService mail)
    {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (DateTime.UtcNow < deadline)
        {
            var found = mail.Sent.FirstOrDefault();
            if (found is not null) return found;
            await Task.Delay(25);
        }
        return null;
    }

    /// <summary>
    /// <c>feature-spec.md</c> §11: every player-affecting event sends an email. A top-up
    /// that ends without credits is the one terminal outcome of a member handing over card
    /// details that sent nothing at all — confirmation was mailed, failure was silent — so a
    /// member who closed the tab after PayFast could only find out by hunting for the status
    /// page again. It is also the promise <c>TopUpStatus.tsx</c> makes in as many words on
    /// the branch where it cannot reach the club ("we'll email you either way"), which is
    /// precisely the branch where this mail is the only channel left.
    /// </summary>
    [SkippableFact]
    public async Task A_declined_payment_emails_the_member_that_nothing_was_charged()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = MemberClient(factory, seeded);
        var body = await RegisterAsync(client, 100m);

        var mail = new StubEmailService();
        await using var quiet = WithMail(factory, mail);
        await quiet.CreateClient().PostAsync(
            $"/api/v1/credit/topup/callback?tenant={seeded.Slug}",
            SignedItn(body.GetProperty("checkout_id").GetString()!, "100.00", status: "FAILED"));

        var notice = await PollMailAsync(mail);
        Assert.NotNull(notice);
        Assert.Equal(seeded.Email, notice!.To);
        Assert.Contains("didn't go through", notice.Subject, StringComparison.Ordinal);
        Assert.Contains("R100.00", notice.Subject, StringComparison.Ordinal);
        Assert.Contains("declined the payment", notice.HtmlBody, StringComparison.Ordinal);
        Assert.Contains("nothing was charged", notice.HtmlBody, StringComparison.Ordinal);

        // Never a code, never an internal string: the column once held
        // amount_mismatch:reported=100,00:expected=500,00 and it was shown to a member.
        Assert.DoesNotContain("amount_mismatch", notice.HtmlBody, StringComparison.Ordinal);
        Assert.DoesNotContain("gateway_error", notice.HtmlBody, StringComparison.Ordinal);
    }

    /// <summary>
    /// A member who backed out at PayFast is told nothing was taken, and is not told their
    /// payment failed — the same distinction the status badge draws.
    /// </summary>
    [SkippableFact]
    public async Task A_cancelled_payment_emails_the_member_without_calling_it_a_failure()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = MemberClient(factory, seeded);
        var body = await RegisterAsync(client, 100m);

        var mail = new StubEmailService();
        await using var quiet = WithMail(factory, mail);
        await quiet.CreateClient().PostAsync(
            $"/api/v1/credit/topup/callback?tenant={seeded.Slug}",
            SignedItn(body.GetProperty("checkout_id").GetString()!, "100.00", status: "CANCELLED"));

        var notice = await PollMailAsync(mail);
        Assert.NotNull(notice);
        Assert.Contains("cancelled", notice!.Subject, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("failed", notice.Subject, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("didn't go through", notice.Subject, StringComparison.Ordinal);
        Assert.Contains("You cancelled this payment", notice.HtmlBody, StringComparison.Ordinal);
    }

    /// <summary>
    /// The one failure where money may genuinely have moved. The member is told what to send
    /// the club rather than left to guess, and the reference is in the mail because that is
    /// what a dispute turns on.
    /// </summary>
    [SkippableFact]
    public async Task An_amount_mismatch_emails_the_member_with_the_reference_to_quote()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = MemberClient(factory, seeded);
        var body = await RegisterAsync(client, 500m);
        var checkoutId = body.GetProperty("checkout_id").GetString()!;

        var mail = new StubEmailService();
        await using var quiet = WithMail(factory, mail);
        var itn = await quiet.CreateClient().PostAsync(
            $"/api/v1/credit/topup/callback?tenant={seeded.Slug}",
            SignedItn(checkoutId, "100.00"));
        Assert.Equal(HttpStatusCode.BadRequest, itn.StatusCode);

        var notice = await PollMailAsync(mail);
        Assert.NotNull(notice);
        Assert.Contains("R500.00", notice!.Subject, StringComparison.Ordinal);
        Assert.Contains("send the club the reference below", notice.HtmlBody, StringComparison.Ordinal);
        Assert.Contains(checkoutId, notice.HtmlBody, StringComparison.Ordinal);
        Assert.DoesNotContain("reported=", notice.HtmlBody, StringComparison.Ordinal);
    }

    /// <summary>
    /// PayFast retries an ITN until it is acknowledged, and the handler's idempotency check
    /// short-circuits only on <c>Completed</c> — so an already-failed row is re-judged on
    /// every retry. One failure, one email.
    /// </summary>
    [SkippableFact]
    public async Task A_retried_notification_does_not_email_the_member_twice()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = MemberClient(factory, seeded);
        var body = await RegisterAsync(client, 100m);
        var checkoutId = body.GetProperty("checkout_id").GetString()!;

        var mail = new StubEmailService();
        await using var quiet = WithMail(factory, mail);
        var itnClient = quiet.CreateClient();
        await itnClient.PostAsync(
            $"/api/v1/credit/topup/callback?tenant={seeded.Slug}", SignedItn(checkoutId, "100.00", status: "FAILED"));
        Assert.NotNull(await PollMailAsync(mail));

        await itnClient.PostAsync(
            $"/api/v1/credit/topup/callback?tenant={seeded.Slug}", SignedItn(checkoutId, "100.00", status: "FAILED"));

        // Give the second dispatch the same window the first one was polled over.
        await Task.Delay(500);
        Assert.Single(mail.Sent);
    }

    // ---- F6: the screen's numbers come from the tenant's settings ----------

    /// <summary>
    /// Everything the top-up screen used to hardcode, served from
    /// <c>tenant_settings</c>. With a club on R50 blocks to a R300 cap at 1.0 credits/R1,
    /// the old screen still offered R100–R1000 in R100 blocks at 1.60.
    /// </summary>
    [SkippableFact]
    public async Task Topup_options_come_from_the_tenants_settings()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory, SettingsJson(regularRate: 1.0m, blockZar: 50m, maxZar: 300m));
        var client = MemberClient(factory, seeded);

        var options = await client.GetFromJsonAsync<JsonElement>("/api/v1/credit/topup/options");

        Assert.Equal(50m, options.GetProperty("block_zar").GetDecimal());
        Assert.Equal(50m, options.GetProperty("min_zar").GetDecimal());
        Assert.Equal(300m, options.GetProperty("max_zar").GetDecimal());
        Assert.Equal(1.0m, options.GetProperty("conversion_rate").GetDecimal());
        Assert.Equal("Regular", options.GetProperty("member_class").GetString());
        Assert.Equal(
            [50m, 100m, 250m, 300m],
            options.GetProperty("presets_zar").EnumerateArray().Select(x => x.GetDecimal()));

        // And what the screen offers is what the server accepts: R150 is legal here and was
        // refused by the old screen; R500 was offered by it and refused by the server.
        Assert.Equal(HttpStatusCode.OK,
            (await client.PostAsJsonAsync("/api/v1/credit/topup", new { amountZar = 150m })).StatusCode);
        var overCap = await client.PostAsJsonAsync("/api/v1/credit/topup", new { amountZar = 500m });
        Assert.Equal(HttpStatusCode.BadRequest, overCap.StatusCode);
        Assert.Equal("amount_exceeds_member_cap",
            (await overCap.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());
    }

    // ---- R3 L-F1 / N-F1 / K-F3: the rate on the screen is the rate registered ----

    /// <summary>
    /// The screen's own sentence, kept: <i>"This rate is locked in when you continue, so it
    /// can't change while you're paying."</i>
    ///
    /// <para>
    /// It was measured from the POST, and the member's figure came from a
    /// <c>/topup/options</c> fetched once on mount and never revalidated — so the half of the
    /// window the member actually looks at was unprotected. Two finders reproduced the same
    /// thing on the same day from opposite directions: an admin changing that member's class,
    /// and an admin editing <c>credits_per_zar_regular</c> for the whole club. A member offered
    /// 240 credits for R100 pressed Continue and was registered for 160, with a card form as
    /// the next thing she saw.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_topup_registers_at_exactly_the_rate_the_screen_quoted()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = MemberClient(factory, seeded);

        var options = await client.GetFromJsonAsync<JsonElement>("/api/v1/credit/topup/options");
        var quoted = options.GetProperty("conversion_rate").GetDecimal();

        var res = await client.PostAsJsonAsync(
            "/api/v1/credit/topup", new { amountZar = 100m, quotedConversionRate = quoted });
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);

        var body = await res.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(quoted, body.GetProperty("conversion_rate").GetDecimal());
        Assert.Equal(100m * quoted, body.GetProperty("quoted_credits").GetDecimal());

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var pending = await db.PendingTopups.IgnoreQueryFilters()
            .SingleAsync(x => x.UserId == seeded.MemberUserId);
        Assert.Equal(quoted, pending.ConversionRate);
    }

    /// <summary>
    /// <b>The money test.</b> The club moves the price under an open tab, and the member is
    /// stopped and shown the new figure rather than sent to the gateway at it.
    ///
    /// <para>
    /// Both triggers a finder used, because they are different code paths to the same lie: one
    /// admin editing the club's own <c>credits_per_zar_regular</c> hits <b>every</b> member with
    /// the screen open, and a per-member class change hits one. Neither reaches the tab, which
    /// keeps saying 240 credits and "this rate is locked in".
    /// </para>
    ///
    /// <para>
    /// A refusal rather than an honoured quote: the posted rate is a number the client chose, so
    /// obeying it would let anyone name their own price. And <b>no row is written</b> — a
    /// pending top-up registered at a rate the member was never shown is the defect itself, not
    /// a harmless artefact of it.
    /// </para>
    ///
    /// <para>
    /// Mutation-proved: making <see cref="Crusaders.Mainframe.Api.Endpoints.TopUpEndpoints.RefuseStaleQuote"/>
    /// return null unconditionally puts both cases back to 200 with a 160.00-credit pending row
    /// against a 240.00 quote, and this test fails on the status code. The two rows of the
    /// theory vary the fixture as well as the rule — one moves the club rate down, the other
    /// moves this member's class up — so a fixture that stopped discriminating in one direction
    /// still fails in the other.
    /// </para>
    /// </summary>
    [SkippableTheory]
    [InlineData(true, 1.0)]   // an admin edits credits_per_zar_regular: 1.6 -> 1.0, for everyone
    [InlineData(false, 2.4)]  // an admin moves this member to league/senior: 1.6 -> 2.4
    public async Task A_quote_the_club_has_moved_away_from_is_refused_rather_than_silently_repriced(
        bool moveTheClubRate, double newRate)
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = MemberClient(factory, seeded);

        var options = await client.GetFromJsonAsync<JsonElement>("/api/v1/credit/topup/options");
        var quoted = options.GetProperty("conversion_rate").GetDecimal();
        Assert.Equal(1.6m, quoted);

        // The club moves, while the member's tab sits on the quoted figure.
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            if (moveTheClubRate)
            {
                var row = await db.TenantSettings.IgnoreQueryFilters().FirstAsync(x => x.TenantId == seeded.TenantId);
                row.SettingsJson = SettingsJson(regularRate: (decimal)newRate);
            }
            else
            {
                var membership = await db.Memberships.IgnoreQueryFilters()
                    .FirstAsync(m => m.UserId == seeded.MemberUserId);
                membership.MemberClass = MemberClass.LeagueOrSenior;
            }
            await db.SaveChangesAsync();
        }

        var res = await client.PostAsJsonAsync(
            "/api/v1/credit/topup", new { amountZar = 100m, quotedConversionRate = quoted });

        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        var body = await res.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("topup_rate_changed", body.GetProperty("error").GetString());
        // The new figures, so the screen can show them instead of the stale ones.
        Assert.Equal((decimal)newRate, body.GetProperty("conversion_rate").GetDecimal());
        Assert.Equal(100m * (decimal)newRate, body.GetProperty("quoted_credits").GetDecimal());

        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Assert.Empty(await db.PendingTopups.IgnoreQueryFilters()
                .Where(x => x.UserId == seeded.MemberUserId).ToListAsync());
        }
    }

    /// <summary>
    /// A client that quotes nothing gets the live rate, as before. The field is nullable so an
    /// older build — or a script — is not answered with a 400 for omitting a field that did not
    /// exist yesterday; only a quote that is present and stale is refused.
    /// </summary>
    [SkippableFact]
    public async Task A_request_carrying_no_quote_is_registered_at_the_live_rate()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = MemberClient(factory, seeded);

        var body = await RegisterAsync(client, 100m);

        Assert.Equal(1.6m, body.GetProperty("conversion_rate").GetDecimal());
        Assert.Equal(160m, body.GetProperty("quoted_credits").GetDecimal());
    }
}
