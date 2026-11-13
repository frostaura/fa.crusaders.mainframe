using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using static Crusaders.Mainframe.Tests.PurchaseKit;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The club's PayFast credentials from the console (money lane BM-4): production had no way to
/// enter them but a hand edit of the settings JSON in Postgres.
/// </summary>
public sealed class AdminPayFastSettingsHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string NewPassphrase = "a-new-club-passphrase-2026";

    private static Task<HttpResponseMessage> PutAsync(HttpClient admin, object body) =>
        admin.PutAsJsonAsync(AdminPaymentEndpoints.Route, body);

    private static async Task<JsonElement> ReadAsync(HttpClient admin) =>
        await admin.GetFromJsonAsync<JsonElement>(AdminPaymentEndpoints.Route);

    [SkippableFact]
    public async Task A_club_with_no_payfast_settings_reads_as_not_configured()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var club = await SeedAsync(factory, "pn", payments: false);

        var read = await ReadAsync(Admin(factory, club));

        Assert.False(read.GetProperty("configured").GetBoolean());
        Assert.Equal("not_configured", Assert.Single(read.GetProperty("problems").EnumerateArray()).GetString());
        Assert.False(read.GetProperty("passphrase_set").GetBoolean());
        Assert.True(read.GetProperty("passphrase_required").GetBoolean());
        Assert.EndsWith($"/api/v1/credit/topup/callback?tenant={club.Slug}", read.GetProperty("notify_url").GetString(), StringComparison.Ordinal);
    }

    /// <summary>
    /// Saved from the console, the credentials are the ones the checkout signs with and the ITN
    /// verifies against: a purchase goes through and an ITN signed with the NEW passphrase credits.
    /// The passphrase never comes back.
    /// </summary>
    [SkippableFact]
    public async Task Credentials_saved_from_the_console_take_a_payment_end_to_end()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var club = await SeedAsync(factory, "pe", payments: false);
        var admin = Admin(factory, club);

        var saved = await PutAsync(admin, new { merchant_id = MerchantId, merchant_key = MerchantKey, passphrase = NewPassphrase, environment = "sandbox" });
        Assert.Equal(HttpStatusCode.OK, saved.StatusCode);
        var text = await saved.Content.ReadAsStringAsync();
        Assert.DoesNotContain(NewPassphrase, text, StringComparison.Ordinal);
        var body = JsonDocument.Parse(text).RootElement;
        Assert.True(body.GetProperty("configured").GetBoolean());
        Assert.True(body.GetProperty("passphrase_set").GetBoolean());
        Assert.Equal("sandbox", body.GetProperty("environment").GetString());

        var bought = await BuyAsync(Member(factory, club), club.OneHour);
        var itn = await factory.CreateClient().PostAsync($"{CallbackPath}?tenant={club.Slug}",
            Itn(bought.CheckoutId, "120.00", "9100001", passphrase: NewPassphrase));
        Assert.Equal(HttpStatusCode.OK, itn.StatusCode);
        Assert.Equal(60, (await LedgerAsync(factory, club, club.MemberUserId)).Sum(l => l.AmountMinutes));
    }

    /// <summary>Refused with every problem named; nothing stored, so the club stays as it was.</summary>
    [SkippableTheory]
    [InlineData("10000100", "46f0cd694581a", "", "test", "passphrase_required")]
    [InlineData("10000100", "46f0cd694581a", "too-short", "test", "passphrase_too_short")]
    [InlineData("REPLACE_WITH_PAYFAST_MERCHANT_ID", "46f0cd694581a", NewPassphrase, "test", "merchant_id_invalid")]
    [InlineData("10000100", "46f0cd694581a", NewPassphrase, "prod", "environment_invalid")]
    public async Task A_save_payfast_would_refuse_is_refused_and_stores_nothing(
        string id, string key, string phrase, string env, string problem)
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var club = await SeedAsync(factory, "pr", payments: false);
        var admin = Admin(factory, club);

        var res = await PutAsync(admin, new { merchant_id = id, merchant_key = key, passphrase = phrase, environment = env });

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        var body = await res.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("payfast_credentials_invalid", body.GetProperty("error").GetString());
        Assert.Contains(problem, body.GetProperty("problems").EnumerateArray().Select(p => p.GetString()));
        Assert.False((await ReadAsync(admin)).GetProperty("configured").GetBoolean());
    }

    /// <summary>
    /// An omitted passphrase keeps the stored one (the console never has it to send back), and the
    /// change record says what changed — the passphrase only as "set"/"changed", never its value.
    /// </summary>
    [SkippableFact]
    public async Task An_omitted_passphrase_is_kept_and_the_record_never_holds_it()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var club = await SeedAsync(factory, "pk");
        var admin = Admin(factory, club);

        Assert.Equal(HttpStatusCode.OK, (await PutAsync(admin, new { environment = "production" })).StatusCode);
        var read = await ReadAsync(admin);
        Assert.True(read.GetProperty("configured").GetBoolean());
        Assert.Equal("production", read.GetProperty("environment").GetString());

        Assert.Equal(HttpStatusCode.OK, (await PutAsync(admin, new { passphrase = NewPassphrase })).StatusCode);

        var rows = await PurchaseKit.ReadAsync(factory, db => db.AdminChangeLogs.IgnoreQueryFilters()
            .Where(r => r.TenantId == club.TenantId && r.Action == AdminChangeActions.PaymentsConfigured)
            .OrderBy(r => r.OccurredAt).ToListAsync());
        Assert.Equal(2, rows.Count);
        Assert.Contains("\"production\"", rows[0].AfterJson, StringComparison.Ordinal);
        Assert.DoesNotContain("passphrase", rows[0].AfterJson, StringComparison.Ordinal);
        Assert.Contains("\"changed\"", rows[1].AfterJson, StringComparison.Ordinal);
        Assert.All(rows, r =>
        {
            Assert.DoesNotContain(NewPassphrase, r.AfterJson ?? "", StringComparison.Ordinal);
            Assert.DoesNotContain(Passphrase, r.BeforeJson ?? "", StringComparison.Ordinal);
        });
    }

    /// <summary>A save that changes nothing writes no record.</summary>
    [SkippableFact]
    public async Task A_save_that_changes_nothing_records_nothing()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var club = await SeedAsync(factory, "pz");

        Assert.Equal(HttpStatusCode.OK, (await PutAsync(Admin(factory, club), new { merchant_id = MerchantId })).StatusCode);

        Assert.Empty(await PurchaseKit.ReadAsync(factory, db => db.AdminChangeLogs.IgnoreQueryFilters()
            .Where(r => r.TenantId == club.TenantId && r.Action == AdminChangeActions.PaymentsConfigured).ToListAsync()));
    }

    [SkippableFact]
    public async Task A_member_cannot_read_or_set_the_clubs_credentials()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var club = await SeedAsync(factory, "pm");
        var member = Member(factory, club);

        Assert.Equal(HttpStatusCode.Forbidden, (await member.GetAsync(AdminPaymentEndpoints.Route)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await PutAsync(member, new { passphrase = NewPassphrase })).StatusCode);
    }

    /// <summary>Cross-tenant injection: one club's admin saving PayFast settings touches no other club's.</summary>
    [SkippableFact]
    public async Task One_clubs_save_never_reaches_another_club()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var clubA = await SeedAsync(factory, "pa");
        var clubB = await SeedAsync(factory, "pb", payments: false);

        Assert.Equal(HttpStatusCode.OK,
            (await PutAsync(Admin(factory, clubA), new { merchant_id = "10000999", passphrase = NewPassphrase })).StatusCode);

        var b = await ReadAsync(Admin(factory, clubB));
        Assert.False(b.GetProperty("configured").GetBoolean());
        Assert.Equal(JsonValueKind.Null, b.GetProperty("merchant_id").ValueKind);
        var a = await ReadAsync(Admin(factory, clubA));
        Assert.Equal("10000999", a.GetProperty("merchant_id").GetString());
    }

    /// <summary>A club settings save after a PayFast save keeps the credentials — the two share one document.</summary>
    [SkippableFact]
    public async Task A_settings_save_keeps_the_payfast_credentials()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var club = await SeedAsync(factory, "ps", payments: false);
        var admin = Admin(factory, club);
        await PutAsync(admin, new { merchant_id = MerchantId, merchant_key = MerchantKey, passphrase = NewPassphrase, environment = "test" });

        Assert.Equal(HttpStatusCode.OK, (await admin.PutAsJsonAsync("/api/v1/admin/settings", new { graceWindowMinutes = 7 })).StatusCode);

        Assert.True((await ReadAsync(admin)).GetProperty("configured").GetBoolean());
    }
}
