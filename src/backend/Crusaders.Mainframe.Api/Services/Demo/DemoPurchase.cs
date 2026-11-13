using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Persistence;

namespace Crusaders.Mainframe.Api.Services.Demo;

/// <summary>
/// A package bought in a demo club: no PayFast, no card, no money — the purchase completes on the
/// spot as a simulation, on the same purchase lock a real one takes, and the minutes land on the
/// ledger at once so the wallet, the reports and the top-up screen all show it.
///
/// <para>
/// The answer has a real purchase's shape with <c>simulated: true</c>, no form and a
/// <c>redirect_url</c> that is the app's own purchase page rather than a gateway, which the page
/// follows instead of posting a card form anywhere.
/// </para>
/// </summary>
public static class DemoPurchase
{
    public static async Task<IResult> CompleteAsync(
        HttpContext ctx, MainframeDbContext db, PendingTopup pending, TenantSettingsView settings, CancellationToken ct)
    {
        var paymentId = $"demo-{Guid.NewGuid():N}";
        var now = DateTimeOffset.UtcNow.Storable();
        pending.Status = TopUpStatus.Completed;
        pending.GatewayCheckoutId = "demo";
        pending.ExternalReference = paymentId;
        pending.CompletedAt = now;
        db.PendingTopups.Add(pending);
        await db.SaveChangesAsync(ct);

        var ledger = ctx.RequestServices.GetRequiredService<LedgerService>();
        var symbol = CurrencySymbol.For(settings);
        await ledger.PostAsync(new LedgerPosting(
            UserId: pending.UserId,
            Type: LedgerEntryType.TopUp,
            AmountMinutes: pending.Minutes,
            ActorUserId: pending.UserId,
            Reason: $"Demo purchase: {TopUpEndpoints.PackageWords(pending.PackageName, pending.Minutes)} for {Email.EmailTemplates.Zar(pending.AmountZar, symbol)}",
            ExternalReference: TopUpEndpoints.TopUpReference(pending.TenantId, paymentId),
            ZarPaid: pending.AmountZar)
        {
            PurchaseId = pending.Id,
        }, ct);

        return Results.Ok(new
        {
            purchase_id = pending.Id,
            checkout_id = "demo",
            simulated = true,
            redirect_url = $"/wallet/buy/{pending.Id}",
            form_fields = Array.Empty<object>(),
            package = new { id = pending.PackageId, name = pending.PackageName, minutes = pending.Minutes },
            amount_zar = pending.AmountZar,
        });
    }
}
