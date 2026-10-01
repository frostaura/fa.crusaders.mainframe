using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Payments;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// A member buying minutes (P13 §3.4): their shelf, the purchase that hands them to PayFast, the
/// purchase's status, and the cancel return. The ITN that settles a purchase is still
/// <c>POST /api/v1/credit/topup/callback</c> (<see cref="TopUpEndpoints"/>) — an external contract
/// PayFast already holds for every checkout in flight.
///
/// <para>
/// <b>There is no cap and no block</b> (Dean, 2026-10-01): a member buys whole packages the club
/// defined, as many as they like. What survived the cap is what protects the member, not the club:
/// open checkouts are listed so an abandoned one can be cancelled, the cancel return closes one at
/// once, and the one-hour expiry closes the rest — each reopenable by a late signed COMPLETE.
/// </para>
/// </summary>
public static class PackageEndpoints
{
    /// <summary>PayFast truncates nothing for us; 100 characters is its documented <c>item_name</c> limit.</summary>
    internal const int MaxItemNameLength = 100;

    public static IEndpointRouteBuilder MapPackageEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1/minutes").RequireAuthorization();

        g.MapGet("/packages", ShelfAsync);
        g.MapPost("/purchase", PurchaseAsync);
        g.MapGet("/purchase/{purchaseId:guid}", async (Guid purchaseId, HttpContext ctx, MainframeDbContext db, CancellationToken ct) =>
        {
            var userId = ctx.User.Id() ?? Guid.Empty;
            var p = await db.PendingTopups.AsNoTracking().FirstOrDefaultAsync(x => x.Id == purchaseId && x.UserId == userId, ct);
            return p is null ? Results.NotFound() : Results.Ok(TopUpEndpoints.StatusWire(p));
        });

        // M4-1: the member came back through the cancel URL (TopUpEndpoints.Abandoned.cs).
        TopUpEndpoints.MapCancelReturn(g);
        return app;
    }

    /// <summary><c>GET /api/v1/minutes/packages</c> — the member's shelf and their open checkouts.</summary>
    private static async Task<IResult> ShelfAsync(HttpContext ctx, MainframeDbContext db, CancellationToken ct)
    {
        var userId = ctx.User.Id() ?? Guid.Empty;
        var shelf = await PackageShelf.ForAsync(db, userId, ct);
        var open = await TopUpEndpoints.OpenCheckoutsAsync(db, userId, ct);
        return Results.Ok(new
        {
            discount = PackageShelf.DiscountWire(shelf.Tariff),
            packages = shelf.Items.Select(PackageShelf.ItemWire).ToList(),
            open_checkouts = open.Select(TopUpEndpoints.OpenWire).ToList(),
        });
    }

    /// <summary>
    /// <c>POST /api/v1/minutes/purchase</c>. The purchase lock — package, minutes, list price,
    /// discount, the discount's group and the price — is written from the LIVE shelf before the
    /// gateway is called, and is all the ITN ever reads (P13 §4.4).
    /// </summary>
    private static async Task<IResult> PurchaseAsync(
        PurchaseRequest req, HttpContext ctx, [AsParameters] PurchaseServices services, CancellationToken ct)
    {
        if (req.PackageId is not { } packageId) return Results.BadRequest(new { error = "package_id_required" });
        if (req.QuotedPriceZar is not { } quoted) return Results.BadRequest(new { error = "quoted_price_required" });

        var db = services.Db;
        var userId = ctx.User.Id() ?? Guid.Empty;
        var shelf = await PackageShelf.ForAsync(db, userId, ct);
        if (shelf.Find(packageId) is not { } item)
            return Results.Json(new { error = "package_unavailable" }, statusCode: StatusCodes.Status409Conflict);

        // Exact, like the rate check it replaces: both sides are the same numeric(10,2) through
        // the same rule, so an unedited price round-trips identically and any edit is caught.
        if (quoted != item.PriceZar)
        {
            return Results.Json(
                new { error = "package_price_changed", package = PackageShelf.ItemWire(item) },
                statusCode: StatusCodes.Status409Conflict);
        }
        if (item.PriceZar < 0.01m)
            return Results.Json(new { error = "package_price_zero" }, statusCode: StatusCodes.Status409Conflict);

        var creds = await services.Secrets.GetPaymentsAsync(ct);
        if (creds is null) return Results.Json(new { error = "payments_not_configured" }, statusCode: 503);

        var user = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Id == userId, ct);
        if (user is null) return Results.Unauthorized();

        var pending = Lock(services.Tenant.TenantId, userId, item, shelf.Tariff);
        db.PendingTopups.Add(pending);
        await db.SaveChangesAsync(ct);

        var club = await services.Club.GetAsync(ct);
        var register = await services.Provider.RegisterCheckoutAsync(
            CheckoutRequest(new CheckoutParts(creds, user, pending, club.Name), services), ct);

        if (!register.Ok)
        {
            pending.Status = TopUpStatus.Failed;
            pending.FailureReason = TopUpEndpoints.FailureCodes.ProviderRegisterFailed;
            await TopUpAlerts.StageAsync(db, services.Tenant.TenantId, pending, ct);
            await db.SaveChangesAsync(ct);
            return Results.Json(new { error = "provider_register_failed", reason = register.FailureReason }, statusCode: 502);
        }

        pending.GatewayCheckoutId = register.CheckoutId;
        await db.SaveChangesAsync(ct);

        // form_fields is the payment: PayFast has no server-side registration, the browser POSTs
        // this signed form to redirect_url.
        return Results.Ok(new
        {
            purchase_id = pending.Id,
            checkout_id = register.CheckoutId,
            redirect_url = register.RedirectUrl,
            form_fields = register.FormFields.Select(f => new { name = f.Key, value = f.Value }).ToList(),
            package = new { id = pending.PackageId, name = pending.PackageName, minutes = pending.Minutes },
            amount_zar = pending.AmountZar,
        });
    }

    /// <summary>
    /// The purchase lock (P13 §2.3): a copy of the shelf item as the member was offered it. The
    /// discount's group is recorded only when a discount actually applied.
    /// </summary>
    internal static PendingTopup Lock(Guid tenantId, Guid userId, ShelfItem item, MemberTariff tariff)
    {
        var discounted = item.Source == ShelfSource.Club && item.DiscountBps > 0;
        return new PendingTopup
        {
            TenantId = tenantId,
            UserId = userId,
            PackageId = item.Package.Id,
            PackageName = item.Package.Name,
            Minutes = item.Package.Minutes,
            ListPriceZar = item.Package.PriceZar,
            DiscountBps = item.DiscountBps,
            GroupId = discounted ? tariff.DiscountGroup?.Id : null,
            AmountZar = item.PriceZar,
            IdempotencyKey = $"tu_{Guid.NewGuid():N}",
            Status = TopUpStatus.Pending,
        };
    }

    private static RegisterCheckoutRequest CheckoutRequest(CheckoutParts parts, PurchaseServices services)
    {
        var (creds, user, pending, clubName) = parts;
        var publicBase = services.Config["App:PublicBaseUrl"] ?? "http://localhost:8089";
        return new RegisterCheckoutRequest(
            creds, services.Tenant.TenantId, user.Id, user.Email, pending.AmountZar,
            pending.IdempotencyKey,
            ReturnUrl: $"{publicBase}/wallet/buy/{pending.Id}",
            NotificationUrl: $"{publicBase}/api/v1/credit/topup/callback?tenant={services.Tenant.TenantSlug}")
        {
            // PayFast requires a cancel_url; the same page polls the status and shows what happened.
            CancelUrl = $"{publicBase}/wallet/buy/{pending.Id}?cancelled=1",
            ItemName = ItemName(clubName, pending.PackageName, pending.Minutes),
        };
    }

    /// <summary>
    /// <c>"{club} - {package} ({compact minutes})"</c>, at most 100 characters. An ASCII hyphen,
    /// never a dash: PayFast's signature is PHP <c>urlencode</c> over these bytes, and nothing
    /// outside ASCII belongs in a string whose encoding two implementations must agree on.
    /// </summary>
    internal static string ItemName(string clubName, string packageName, int minutes)
    {
        var name = $"{clubName.Trim()} - {packageName.Trim()} ({MoneyFormat.MinutesCompact(minutes)})";
        return name.Length <= MaxItemNameLength ? name : name[..MaxItemNameLength];
    }
}

/// <summary>
/// <c>POST /api/v1/minutes/purchase</c>. Both nullable so a missing field is a named 400 rather
/// than a binding failure. <paramref name="QuotedPriceZar"/> is the shelf's <c>price_zar</c> the
/// member was shown; a different live price is refused, never honoured — a posted price is a
/// number the client chose.
/// </summary>
public sealed record PurchaseRequest(Guid? PackageId, decimal? QuotedPriceZar);

/// <summary>The collaborators a purchase needs, bound as one parameter for the complexity gate.</summary>
public sealed record PurchaseServices(
    MainframeDbContext Db,
    IPaymentProvider Provider,
    TenantSecretsAccessor Secrets,
    IConfiguration Config,
    Crusaders.Mainframe.Api.Multitenancy.ITenantContext Tenant,
    ClubIdentityResolver Club);

/// <summary>What a checkout is registered from, bundled for the parameter gate.</summary>
internal sealed record CheckoutParts(PerTenantCredentials Creds, User User, PendingTopup Pending, string ClubName);
