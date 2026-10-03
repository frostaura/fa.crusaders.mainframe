using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// The desk selling a package over the counter (P13 §3.7): the member's shelf as they see it, and
/// the sale itself. It replaced the three top-up codes on <c>/adjust</c>, so a sale's package and
/// its default rand can never be mixed with a signed goodwill amount.
/// </summary>
public static partial class WalletEndpoints
{
    /// <summary>The largest rand figure a desk sale may state — well past any counter, well short of a typo's reach.</summary>
    public const decimal MaxZarReceived = 1_000_000m;

    /// <summary>
    /// <c>GET /api/v1/admin/minutes/{userId}/packages</c> — the member's shelf exactly as the
    /// member sees it (discount and all), without their open checkouts. 404 for a member this club
    /// does not have: the tenant filter makes another club's member simply not exist here.
    /// </summary>
    private static async Task<IResult> DeskShelfAsync(Guid userId, MainframeDbContext db, CancellationToken ct)
    {
        if (!await db.Users.AnyAsync(u => u.Id == userId, ct)) return Results.NotFound();
        var shelf = await PackageShelf.ForAsync(db, userId, ct);
        return Results.Ok(new
        {
            discount = PackageShelf.DiscountWire(shelf.Tariff),
            packages = shelf.Items.Select(PackageShelf.ItemWire).ToList(),
        });
    }

    /// <summary>
    /// <c>POST /api/v1/admin/minutes/{userId}/sell</c> — one <c>AdminTopUp</c> row for the
    /// package's minutes, with the rand the desk took (by default the member's shelf price).
    /// Idempotent on the caller's key exactly like an adjustment.
    /// </summary>
    private static async Task<IResult> SellAsync(
        Guid userId, SellRequest req, HttpContext ctx, [AsParameters] AdjustServices services, CancellationToken ct)
    {
        if (RefuseSale(req) is { } refusal) return refusal;
        var kind = AdminCreditReasons.ResolveSale(req.ReasonCodeEither)!.Value;

        var reference = IdempotencyReference(services.Tenant.TenantId, req.IdempotencyKey);
        if (reference is { Length: 0 }) return Results.BadRequest(new { error = "idempotency_key_invalid" });
        if (!await services.Db.Users.AnyAsync(u => u.Id == userId, ct)) return Results.NotFound();

        var shelf = await PackageShelf.ForAsync(services.Db, userId, ct);
        if (shelf.Find(req.PackageId!.Value) is not { } item)
            return Results.Json(new { error = "package_unavailable" }, statusCode: StatusCodes.Status409Conflict);

        // J7-10: "given at no charge" is only true of a package that costs this member nothing.
        var free = kind.Code == AdminCreditReasons.PackageFree;
        if (free && item.PriceZar != 0m)
            return Results.BadRequest(new { error = "reason_code_invalid", valid = AdminCreditReasons.PaidSaleCodes });

        var reason = req.Reason!.Trim();
        var movement = new DeskMovement(
            userId, kind, item.Package.Minutes, free ? 0m : req.ZarReceivedEither ?? item.PriceZar,
            $"{reason} — {item.Package.Name}", reason)
        {
            IdempotencyKey = req.IdempotencyKey,
            Reference = reference,
            Package = item,
        };
        return await MoveAsync(movement, ctx, services, ct);
    }

    /// <summary>
    /// A sale's answer (P13 §3.7): the adjustment's shape, plus the package sold at the member's
    /// shelf price. Block body for the lizard reason <see cref="AdjustmentResult"/> gives.
    /// </summary>
    private static IResult SaleResult(
        LedgerEntry entry, AdminCreditReasons.Kind kind, ShelfItem item, (int Before, int After) balance, User user)
    {
        return Results.Ok(new
        {
            entry_id = entry.Id,
            type = entry.Type.ToString(),
            reason_code = kind.Code,
            amount_minutes = entry.AmountMinutes,
            zar_received = entry.ZarPaid,
            balance_before_minutes = balance.Before,
            balance_after_minutes = balance.After,
            member = new { user_id = user.Id, email = user.Email },
            package = new { id = item.Package.Id, name = item.Package.Name, minutes = item.Package.Minutes, price_zar = item.PriceZar },
        });
    }

    /// <summary>Everything that refuses a sale before the database is read.</summary>
    private static IResult? RefuseSale(SellRequest req)
    {
        if (req.PackageId is null) return Results.BadRequest(new { error = "package_id_required" });
        if (AdminCreditReasons.ResolveSale(req.ReasonCodeEither) is null)
            return Results.BadRequest(new { error = "reason_code_invalid", valid = AdminCreditReasons.SaleCodes });
        if (string.IsNullOrWhiteSpace(req.Reason)) return Results.BadRequest(new { error = "reason_required" });

        // J7-10: nothing was taken for a package given free, so a rand figure other than 0 is a contradiction.
        if (req.ReasonCodeEither?.Trim() == AdminCreditReasons.PackageFree && req.ZarReceivedEither is { } zar && zar != 0m)
            return Results.BadRequest(new { error = "zar_received_out_of_range", max = 0m });
        return RefuseZar(req.ZarReceivedEither);
    }

    /// <summary>
    /// The rand a sale states (B7), when it states one: not negative, whole cents, bounded. It may
    /// differ from the package price — a club rounding a cash sale is the desk's call to record.
    /// </summary>
    private static IResult? RefuseZar(decimal? zar)
    {
        if (zar is not { } value) return null;
        if (value < 0 || value > MaxZarReceived) return Results.BadRequest(new { error = "zar_received_out_of_range", max = MaxZarReceived });
        if (decimal.Round(value, 2, MidpointRounding.AwayFromZero) != value) return Results.BadRequest(new { error = "zar_received_not_whole_cents" });
        return null;
    }
}

/// <summary>
/// A package sold at the desk (P13 §3.7). <paramref name="ZarReceived"/> is optional and defaults
/// to the member's shelf price; both spellings of the code and the rand bind, for the reason
/// <see cref="AdjustRequest"/> gives.
/// </summary>
public sealed record SellRequest(
    Guid? PackageId,
    string? ReasonCode = null,
    string? Reason = null,
    decimal? ZarReceived = null,
    string? IdempotencyKey = null,
    [property: System.Text.Json.Serialization.JsonPropertyName("reason_code")] string? ReasonCodeSnake = null,
    [property: System.Text.Json.Serialization.JsonPropertyName("zar_received")] decimal? ZarReceivedSnake = null)
{
    /// <summary>The rand the desk took, under either spelling; null to take the shelf price.</summary>
    public decimal? ZarReceivedEither => ZarReceived ?? ZarReceivedSnake;

    /// <summary>The sale code under either spelling.</summary>
    public string? ReasonCodeEither => ReasonCode ?? ReasonCodeSnake;
}
