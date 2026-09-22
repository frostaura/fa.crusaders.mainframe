using System.Globalization;
using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.Tokens;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The club's currency symbol — <b>the sign every amount in this product is written in</b>.
///
/// <para>
/// <b>The decision this file pins, and it changed.</b> The owner asked twice. First: "instead
/// of a <c>cr</c> suffix, have a configurable currency symbol instead which would precede
/// amounts. Like <c>R </c> for ZAR (default)." The first pass scoped that to real money only
/// and left a second formatter printing "50.00 credits" beside it, so the owner said it again:
/// "remember the wording changes from credits and cr to the currency symbol."
/// </para>
///
/// <para>
/// So there is now ONE formatter and ONE unit. Neither "cr" nor the word "credits" survives as
/// a unit on a number anywhere a member or an admin reads one.
/// </para>
///
/// <para>
/// <b>What that collapses, and the one rule it imposes.</b> The product renders two quantities
/// that are not the same size — what a member pays the gateway, and what their wallet holds,
/// which convert at <c>credits_per_zar_regular</c> (1.6) or <c>credits_per_zar_league</c>
/// (2.4). Writing both with one symbol means a wallet bought for R100 reads R160.00. The owner
/// has accepted that, on the argument that a member can never exchange a wallet back for cash;
/// the full reasoning is at the head of <c>frontend/src/lib/currency.ts</c> and in
/// <see cref="Api.Services.CurrencySymbol"/>. The rule it imposes is that the rate is now
/// invisible everywhere except at the conversion itself, so any surface spanning both legs —
/// the top-up confirmation above all — must state both in words. That is
/// <c>MoneySurfaceTests.A_topup_confirmation_names_both_legs_of_the_conversion_in_words</c>.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class CurrencySymbolTests
{
    private readonly PostgresFixture _pg;

    public CurrencySymbolTests(PostgresFixture pg) => _pg = pg;

    private const string Secret = "test-only-signing-key-not-used-in-any-real-environment";
    private const string SettingsPath = "/api/v1/admin/settings/";
    private const string ProfilePath = "/api/v1/me/profile";

    // ---- The value itself: what a club may type ---------------------------

    /// <summary>
    /// A one-character rule would have been enough for ZAR and wrong for most of the world.
    /// </summary>
    [Theory]
    [InlineData("R")]
    [InlineData("$")]
    [InlineData("€")]
    [InlineData("kr")]
    [InlineData("R$")]
    [InlineData("CHF")]
    [InlineData("US$")]
    [InlineData("₹")]
    [InlineData("zł")]
    public void A_symbol_a_real_currency_uses_is_accepted(string symbol)
    {
        Assert.True(CurrencySymbol.IsAcceptable(symbol));
        Assert.Equal(symbol, CurrencySymbol.Sanitise(symbol));
    }

    /// <summary>
    /// Bounded, and made of letters and currency signs only — which is also what makes it safe
    /// to interpolate into an HTML email body with no escaping step. No angle bracket, no
    /// ampersand, no quote and no control character can survive it, and no digit either, so
    /// "R50" cannot be saved as a symbol and then printed in front of another number.
    /// </summary>
    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("RANDS")]
    [InlineData("R 50")]
    [InlineData("50")]
    [InlineData("R50")]
    [InlineData("<b>")]
    [InlineData("\"R\"")]
    [InlineData("R&R")]
    [InlineData("R\nX")]
    [InlineData(null)]
    public void Anything_that_is_not_a_symbol_is_refused_and_falls_back(string? bad)
    {
        Assert.False(CurrencySymbol.IsAcceptable(bad));
        Assert.Equal(CurrencySymbol.Default, CurrencySymbol.Sanitise(bad));
    }

    /// <summary>
    /// Trimmed, because the owner wrote the setting as <c>"R "</c> — with the space that
    /// separates it from the amount. That space is the formatter's business, not the value's.
    /// </summary>
    [Theory]
    [InlineData("  R  ", "R")]
    [InlineData("R$ ", "R$")]
    [InlineData("\tCHF\n", "CHF")]
    public void The_packaging_around_a_pasted_symbol_is_not_part_of_it(string raw, string expected)
    {
        Assert.True(CurrencySymbol.IsAcceptable(raw));
        Assert.Equal(expected, CurrencySymbol.Sanitise(raw));
    }

    /// <summary>A club that has never said gets the rand sign — the club is in Durban North.</summary>
    [Fact]
    public void The_default_is_the_rand_sign() => Assert.Equal("R", CurrencySymbol.Default);

    // ---- The emails: EVERY amount is the club's own symbol -----------------

    [Fact]
    public void A_topup_confirmation_is_denominated_in_the_clubs_own_currency()
    {
        var mail = EmailTemplates.TopUpConfirmation("member@test.local", new TopUpConfirmationDetails(
            AmountZar: 100m, CreditsAdded: 160m, ConversionRate: 1.6m,
            BalanceAfterCredits: 210m, Reference: "1089250", CurrencySymbol: "CHF"));

        // BOTH legs, and the balance, in the club's own sign. The previous decision held the
        // wallet figures back from the symbol; this is the reversal, and it is deliberate.
        Assert.Contains("CHF100.00", mail.HtmlBody);
        Assert.Contains("CHF160.00", mail.HtmlBody);
        Assert.Contains("CHF210.00", mail.HtmlBody);
        Assert.DoesNotContain("R100.00", mail.HtmlBody);
        Assert.DoesNotContain("credits", mail.HtmlBody);

        // And because they now wear the same sign while being different sizes, the mail states
        // which leg is which — in the club's own currency, not in a hardcoded rand.
        Assert.Contains(
            "Every CHF1.00 you pay adds CHF1.60 to your wallet, which is why CHF160.00 arrived " +
            "for the CHF100.00 that left your card.",
            mail.HtmlBody);
    }

    [Fact]
    public void A_topup_that_did_not_complete_is_denominated_in_the_clubs_own_currency()
    {
        var mail = EmailTemplates.TopUpNotCompleted(
            "member@test.local", amountZar: 250m, failureReason: null,
            reference: "1089251", currencySymbol: "R$");

        Assert.Contains("R$250.00", mail.Subject);
        Assert.Contains("R$250.00", mail.HtmlBody);
        // Nothing arrived, and nothing is still an amount: R$0.00, not a blank and not a word.
        Assert.Contains("R$0.00", mail.HtmlBody);
        Assert.DoesNotContain("credits", mail.HtmlBody);
    }

    /// <summary>
    /// <b>Every money email carries the club's symbol on every figure, and none of them carries
    /// a unit word.</b>
    ///
    /// <para>
    /// This test is the inversion of the one it replaces, which asserted that the symbol must
    /// NOT reach a wallet figure. That was the earlier, narrower reading of the ask; the owner
    /// has since ruled the other way, twice. Keeping the old assertion would have frozen the
    /// decision that was overruled.
    /// </para>
    ///
    /// <para>
    /// A non-default symbol on purpose: a club on rand cannot tell a template that reads the
    /// setting from one that hardcodes <see cref="CurrencySymbol.Default"/>.
    /// </para>
    /// </summary>
    [Fact]
    public void Every_money_email_carries_the_clubs_symbol_and_no_unit_word()
    {
        var confirmation = EmailTemplates.BookingConfirmation("member@test.local", new BookingConfirmationDetails(
            CourtName: "Court 3", StartsAtLocal: "Wed 16 Sep 10:00", Duration: "15 min",
            AmountCredits: 50m, BalanceAfterCredits: 60m,
            PenaltyWindowMinutes: 15, PenaltyPct: 30m, CurrencySymbol: "CHF"));
        var cancellation = EmailTemplates.BookingCancellation("member@test.local", "Court 4", 50m, 15m, "CHF");
        var adjustment = EmailTemplates.CreditAdjustment("member@test.local", 25m, 145m, "desk credit", "CHF");
        var noShow = EmailTemplates.BookingNoShow("member@test.local", "Court 4", 50m, 15m, "CHF");
        var walkUpVoid = EmailTemplates.WalkUpNotStarted("member@test.local", "Court 4", 50m, "CHF");

        foreach (var mail in new[] { confirmation, cancellation, adjustment, noShow, walkUpVoid })
        {
            Assert.DoesNotContain("credits", mail.HtmlBody);
            Assert.DoesNotContain(" cr<", mail.HtmlBody);
            Assert.DoesNotContain("50.00 cr", mail.HtmlBody);
            Assert.Contains("CHF", mail.HtmlBody);
            // The rand sign must not have leaked in from a hardcoded default.
            Assert.DoesNotContain("R50.00", mail.HtmlBody);
            Assert.DoesNotContain("R145.00", mail.HtmlBody);
        }
    }

    /// <summary>
    /// A club that has said nothing gets exactly what a club that said "R" gets. The absent
    /// setting is the commonest case on the day this ships, and "unknown" must never mean
    /// "some other symbol" — it means the club has not chosen.
    /// </summary>
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("RANDS")]
    public void A_club_that_has_not_chosen_reads_exactly_like_a_club_on_the_default(string? unset)
    {
        var chosen = EmailTemplates.BookingCancellation(
            "member@test.local", "Court 4", 50m, 15m, CurrencySymbol.Default);
        var unchosen = EmailTemplates.BookingCancellation(
            "member@test.local", "Court 4", 50m, 15m, CurrencySymbol.Sanitise(unset));

        Assert.Equal(chosen.HtmlBody, unchosen.HtmlBody);
        Assert.Contains("R50.00", unchosen.HtmlBody);
    }

    /// <summary>
    /// A preceding symbol forces a choice a trailing unit never did: the sign goes OUTSIDE it.
    /// "-R50.00" is how a negative amount of money is written; "R-50.00" reads as a symbol
    /// followed by a malformed number.
    /// </summary>
    [Theory]
    [InlineData(100, "R", "R100.00")]
    [InlineData(0, "R", "R0.00")]
    [InlineData(-50, "R", "-R50.00")]
    [InlineData(-50, "R$", "-R$50.00")]
    [InlineData(1234567.891, "CHF", "CHF1234567.89")]
    [InlineData(-0.005, "R", "-R0.01")]
    [InlineData(99999999.99, "kr", "kr99999999.99")]
    public void A_money_figure_puts_the_sign_outside_the_symbol(double value, string symbol, string expected)
        => Assert.Equal(expected, EmailTemplates.Money((decimal)value, symbol));

    /// <summary>
    /// <b>There is exactly one amount formatter, and it never writes a unit word.</b>
    ///
    /// <para>
    /// <c>Cr</c> — which rendered "50.00 credits" — was the second one, and collapsing the two
    /// into this is the whole of the owner's second instruction. Asserted on the formatter
    /// itself rather than only through the templates, because that is the single expression a
    /// future change would have to get past.
    /// </para>
    /// </summary>
    [Fact]
    public void The_one_formatter_never_writes_a_unit_word()
    {
        foreach (var symbol in new[] { "R", "CHF", "R$", "kr" })
        {
            var rendered = EmailTemplates.Money(50m, symbol);
            Assert.Equal($"{symbol}50.00", rendered);
            Assert.DoesNotContain("credits", rendered, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("cr", rendered, StringComparison.Ordinal);
        }
    }

    /// <summary>Invariant culture, whatever the host's own is — as every money figure here is.</summary>
    [Fact]
    public void A_money_figure_ignores_the_ambient_culture()
    {
        var previous = Thread.CurrentThread.CurrentCulture;
        try
        {
            Thread.CurrentThread.CurrentCulture = new CultureInfo("af-ZA");
            Assert.Equal("R100.00", EmailTemplates.Money(100m, "R"));
            Assert.DoesNotContain(",", EmailTemplates.Money(100m, "R"));
        }
        finally { Thread.CurrentThread.CurrentCulture = previous; }
    }

    // ---- The settings surface ---------------------------------------------

    [SkippableFact]
    public async Task The_settings_page_shows_the_symbol_and_saves_it()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = AdminClient(factory, seeded);

        var shown = await client.GetFromJsonAsync<JsonElement>(SettingsPath);
        Assert.Equal("R", shown.GetProperty("currency_symbol").GetString());

        var save = await client.PutAsJsonAsync(SettingsPath, Save(("currencySymbol", "R$")));
        Assert.Equal(HttpStatusCode.OK, save.StatusCode);

        var after = await EngineSettingsAsync(factory, seeded);
        Assert.Equal("R$", CurrencySymbol.For(after));

        // What the screen shows next is what the engine holds — the round trip a settings
        // page performs is read, show, save unchanged, and a GET that invented its own
        // default here would be a silent write.
        var reshown = await client.GetFromJsonAsync<JsonElement>(SettingsPath);
        Assert.Equal("R$", reshown.GetProperty("currency_symbol").GetString());
    }

    [SkippableTheory]
    [InlineData("")]
    [InlineData("RANDS")]
    [InlineData("R 50")]
    [InlineData("R50")]
    [InlineData("<b>")]
    public async Task A_symbol_the_product_cannot_print_is_refused(string bad)
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = AdminClient(factory, seeded);

        var save = await client.PutAsJsonAsync(SettingsPath, Save(("currencySymbol", bad)));
        Assert.Equal(HttpStatusCode.BadRequest, save.StatusCode);

        var body = await save.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("currency_symbol_invalid", body.GetProperty("error").GetString());

        // Refused means unchanged, not half-written.
        Assert.Equal("R", CurrencySymbol.For(await EngineSettingsAsync(factory, seeded)));
    }

    /// <summary>
    /// Omitted means unchanged. The currency row and the economics form are different screens.
    /// </summary>
    [SkippableFact]
    public async Task A_save_that_does_not_mention_the_symbol_leaves_it_alone()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory, """{"currency_symbol":"CHF"}""");
        var client = AdminClient(factory, seeded);

        var save = await client.PutAsJsonAsync(SettingsPath, Save());
        Assert.Equal(HttpStatusCode.OK, save.StatusCode);

        Assert.Equal("CHF", CurrencySymbol.For(await EngineSettingsAsync(factory, seeded)));
    }

    // ---- The member's channel ---------------------------------------------

    /// <summary>
    /// The symbol rides on <c>/me/profile</c> beside <c>action_glyphs</c>, for the reason
    /// stated there: it is a club-wide value a MEMBER needs, and the settings surface is
    /// admin-only. A member cannot supply an id, so it is their own club's by construction.
    /// </summary>
    [SkippableFact]
    public async Task A_member_is_told_their_own_clubs_symbol()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory, """{"currency_symbol":"kr"}""");
        var client = AdminClient(factory, seeded);

        var profile = await client.GetFromJsonAsync<JsonElement>(ProfilePath);
        Assert.Equal("kr", profile.GetProperty("currency_symbol").GetString());
    }

    /// <summary>
    /// <b>Two clubs, two symbols, and neither may see the other's.</b> Tenant isolation is
    /// structural here and a leak is a P0 — but this one would also be a MONEY leak on the
    /// reading a member makes of their own top-up screen. Both directions are asserted, on
    /// both surfaces, because a filter that catches one may not catch the other.
    /// </summary>
    [SkippableFact]
    public async Task Two_clubs_symbols_do_not_leak_into_each_other()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var durban = await SeedAsync(factory, """{"currency_symbol":"R"}""");
        var zurich = await SeedAsync(factory, """{"currency_symbol":"CHF"}""");

        var durbanClient = AdminClient(factory, durban);
        var zurichClient = AdminClient(factory, zurich);

        var durbanProfile = await durbanClient.GetFromJsonAsync<JsonElement>(ProfilePath);
        var zurichProfile = await zurichClient.GetFromJsonAsync<JsonElement>(ProfilePath);
        Assert.Equal("R", durbanProfile.GetProperty("currency_symbol").GetString());
        Assert.Equal("CHF", zurichProfile.GetProperty("currency_symbol").GetString());

        var durbanSettings = await durbanClient.GetFromJsonAsync<JsonElement>(SettingsPath);
        var zurichSettings = await zurichClient.GetFromJsonAsync<JsonElement>(SettingsPath);
        Assert.Equal("R", durbanSettings.GetProperty("currency_symbol").GetString());
        Assert.Equal("CHF", zurichSettings.GetProperty("currency_symbol").GetString());

        // And one club changing its own does not move the other's.
        Assert.Equal(HttpStatusCode.OK, (await zurichClient.PutAsJsonAsync(SettingsPath, Save(("currencySymbol", "€")))).StatusCode);
        Assert.Equal("€", CurrencySymbol.For(await EngineSettingsAsync(factory, zurich)));
        Assert.Equal("R", CurrencySymbol.For(await EngineSettingsAsync(factory, durban)));
    }

    /// <summary>
    /// <b>Two clubs, two symbols, and one process.</b> The HTTP test above proves the SETTINGS
    /// do not leak; this proves the RENDERING does not — a formatter that cached the last
    /// symbol it saw, or a template that fell back to "whatever we had", would pass that one
    /// and fail this. It is the failure mode a module-level symbol store actually has, and the
    /// frontend's own <c>setClubCurrencySymbol</c> carries the same warning.
    /// </summary>
    [Fact]
    public void One_clubs_symbol_never_reaches_another_clubs_mail()
    {
        var durban = EmailTemplates.BookingCancellation("a@durban.test", "Court 1", 50m, 15m, "R");
        var zurich = EmailTemplates.BookingCancellation("a@zurich.test", "Court 1", 50m, 15m, "CHF");
        var durbanAgain = EmailTemplates.BookingCancellation("a@durban.test", "Court 1", 50m, 15m, "R");

        Assert.Contains("R50.00", durban.HtmlBody);
        Assert.DoesNotContain("CHF", durban.HtmlBody);

        Assert.Contains("CHF50.00", zurich.HtmlBody);
        Assert.DoesNotContain("R50.00", zurich.HtmlBody);

        // And the second club's mail did not change the first's — rendered after it, byte for
        // byte the same.
        Assert.Equal(durban.HtmlBody, durbanAgain.HtmlBody);
    }

    /// <summary>
    /// The same, for the trace sentences an admin reads, which are composed on the server from
    /// a symbol carried on the resolved query rather than read a second time per row.
    /// </summary>
    [Fact]
    public void One_clubs_symbol_never_reaches_another_clubs_night_trace()
    {
        var facts = new TraceFacts { AmountCredits = 36m, CourtName = "Court 2" };

        Assert.Equal("Paid R36.00 for Court 2", TraceKinds.Headline(TraceKinds.WalletSpent, facts, "R"));
        Assert.Equal("Paid CHF36.00 for Court 2", TraceKinds.Headline(TraceKinds.WalletSpent, facts, "CHF"));
        Assert.Equal("Paid R36.00 for Court 2", TraceKinds.Headline(TraceKinds.WalletSpent, facts, "R"));
    }

    // ---- fixtures ---------------------------------------------------------

    private sealed record Seeded(Guid TenantId, string Slug, Guid AdminUserId);

    /// <summary>
    /// A settings save, with the core booking block every PUT to this endpoint requires.
    ///
    /// <para>
    /// The endpoint's first six checks read non-nullable members, so an omitted
    /// <c>sliceMinutes</c> arrives as 0 and is refused as out of range before any of the
    /// optional keys are looked at. "Omitted means unchanged" is the rule for the OPTIONAL
    /// keys only — which is exactly what
    /// <see cref="A_save_that_does_not_mention_the_symbol_leaves_it_alone"/> is about.
    /// </para>
    /// </summary>
    private static Dictionary<string, object?> Save(params (string Key, object? Value)[] overrides)
    {
        var body = new Dictionary<string, object?>
        {
            ["sliceMinutes"] = 15,
            ["slicePriceCredits"] = 8m,
            ["advanceBookingDays"] = 14,
            ["dayStartMinute"] = 360,
            ["dayEndMinute"] = 1320,
            ["penaltyPct"] = 30m,
            ["graceWindowMinutes"] = 5,
            ["penaltyWindowMinutes"] = 15,
        };
        foreach (var (key, value) in overrides) body[key] = value;
        return body;
    }

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    private static async Task<TenantSettingsView> EngineSettingsAsync(TestWebAppFactory factory, Seeded s)
    {
        using var scope = factory.Services.CreateScope();
        var tenantContext = scope.ServiceProvider.GetRequiredService<Api.Multitenancy.ITenantContext>();
        tenantContext.Set(s.TenantId, s.Slug);
        return await scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>().GetAsync(default);
    }

    private static async Task<Seeded> SeedAsync(TestWebAppFactory factory, string settingsJson = "{}")
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var slug = $"cur-{Guid.NewGuid():N}"[..20];
        var tenant = new Tenant { Slug = slug, DisplayName = "Currency Club" };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings { TenantId = tenant.Id, SettingsJson = settingsJson });

        var admin = new User
        {
            TenantId = tenant.Id,
            Email = $"{slug}@test.local",
            PasswordHash = "x",
            EmailVerified = true,
            IsAdmin = true,
        };
        db.Users.Add(admin);
        db.Memberships.Add(new Membership
        {
            TenantId = tenant.Id,
            UserId = admin.Id,
            FullName = "Currency Admin",
            MembershipNumber = slug,
            Status = MembershipStatus.Active,
            MemberClass = MemberClass.Regular,
        });

        await db.SaveChangesAsync();
        return new Seeded(tenant.Id, slug, admin.Id);
    }

    private static HttpClient AdminClient(TestWebAppFactory factory, Seeded s)
    {
        var token = new JwtSecurityToken(
            issuer: "crusaders.mainframe",
            audience: "crusaders.mainframe.app",
            claims:
            [
                new Claim(JwtRegisteredClaimNames.Sub, s.AdminUserId.ToString()),
                new Claim("tenant_id", s.TenantId.ToString()),
                new Claim("tenant_slug", s.Slug),
                new Claim("purpose", "access"),
                new Claim(ClaimTypes.Role, "admin"),
            ],
            notBefore: DateTime.UtcNow,
            expires: DateTime.UtcNow.AddMinutes(10),
            signingCredentials: new SigningCredentials(
                new SymmetricSecurityKey(Encoding.UTF8.GetBytes(Secret)), SecurityAlgorithms.HmacSha256));

        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue(
            "Bearer", new JwtSecurityTokenHandler().WriteToken(token));
        return client;
    }
}
