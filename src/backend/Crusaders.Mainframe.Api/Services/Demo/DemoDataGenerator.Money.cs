using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;

namespace Crusaders.Mainframe.Api.Services.Demo;

public sealed partial class DemoDataGenerator
{
    /// <summary>The share of purchases made at the desk rather than through the app.</summary>
    private const double DeskShare = 0.15;

    /// <summary>
    /// Replays every planned movement in time order, member by member, and writes it to the ledger.
    /// A debit that would take a member below zero is preceded by a package they bought shortly
    /// before — through the app (a completed purchase with its lock) or at the desk — so every
    /// balance is non-negative at every instant, the way the club's own refusals keep it. Then a
    /// few people buy ahead, a few checkouts are abandoned or declined, and each admin's own wallet
    /// is left with something to book with. Answers how many ledger rows it wrote.
    /// </summary>
    private int SettleMoney(DemoWorld w)
    {
        var balances = new Dictionary<Guid, int>();
        var joined = w.Players.ToDictionary(p => p.UserId, p => p.JoinedAt);
        var rows = 0;
        foreach (var m in w.Money.OrderBy(m => m.At).ThenByDescending(m => m.Minutes))
        {
            var balance = balances.GetValueOrDefault(m.UserId);
            if (m.Minutes < 0 && balance + m.Minutes < 0)
            {
                var bought = BuyBefore(w, m.UserId, m.At, -(balance + m.Minutes), joined.GetValueOrDefault(m.UserId, w.Now.AddDays(-400)));
                balance += bought.Minutes;
                rows += bought.Rows;
            }
            balances[m.UserId] = balance + m.Minutes;
            _db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = w.TenantId,
                UserId = m.UserId,
                Type = m.Type,
                AmountMinutes = m.Minutes,
                RelatedBookingId = m.BookingId,
                ActorUserId = m.ActorUserId,
                Reason = m.Reason,
                ExternalReference = m.Reference,
                CreatedAt = m.At.Storable(),
            });
            rows++;
        }
        return rows + BuyAhead(w, balances) + AbandonedCheckouts(w);
    }

    /// <summary>Packages bought just before <paramref name="at"/> until <paramref name="needed"/> minutes are covered.</summary>
    private (int Minutes, int Rows) BuyBefore(DemoWorld w, Guid userId, DateTimeOffset at, int needed, DateTimeOffset joined)
    {
        var bought = 0;
        var rows = 0;
        var when = at - w.Between(TimeSpan.FromMinutes(15), TimeSpan.FromHours(20));
        if (when < joined) when = joined.AddMinutes(30) < at ? joined.AddMinutes(30) : at.AddMinutes(-1);
        while (bought < needed && w.Packages.Count > 0)
        {
            var package = PackageFor(w, needed - bought);
            Buy(w, userId, package, when.Storable());
            bought += package.Minutes;
            rows++;
            when = when.AddSeconds(-30);
        }
        return (bought, rows);
    }

    /// <summary>The smallest package that covers what is needed, sometimes one size up; the largest when none covers it.</summary>
    private static MinutePackage PackageFor(DemoWorld w, int needed)
    {
        var covering = w.Packages.Where(p => p.Minutes >= needed).OrderBy(p => p.Minutes).ToList();
        if (covering.Count == 0) return w.Packages.OrderBy(p => p.Minutes).Last();
        return covering.Count > 1 && w.Chance(0.35) ? covering[1] : covering[0];
    }

    /// <summary>One package bought: through the app (purchase lock, completed) or sold at the desk.</summary>
    private void Buy(DemoWorld w, Guid userId, MinutePackage package, DateTimeOffset at)
    {
        if (w.Chance(DeskShare))
        {
            _db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = w.TenantId,
                UserId = userId,
                Type = LedgerEntryType.AdminTopUp,
                AmountMinutes = package.Minutes,
                ZarPaid = package.PriceZar,
                ActorUserId = w.AdminId,
                Reason = $"Paid cash at the desk — {package.Name}",
                ExternalReference = $"{WalletEndpoints.AdjustmentReferencePrefix}{w.TenantId:N}:demo-{Guid.NewGuid():N}",
                CreatedAt = at,
            });
            return;
        }

        var paymentId = $"demo-{w.Rng.Next(10_000_000, 99_999_999)}-{Guid.NewGuid().ToString("N")[..6]}";
        var pending = new PendingTopup
        {
            TenantId = w.TenantId,
            UserId = userId,
            PackageId = package.Id,
            PackageName = package.Name,
            Minutes = package.Minutes,
            ListPriceZar = package.PriceZar,
            AmountZar = package.PriceZar,
            IdempotencyKey = $"tu_{Guid.NewGuid():N}",
            GatewayCheckoutId = "demo",
            ExternalReference = paymentId,
            Status = TopUpStatus.Completed,
            CreatedAt = at.AddMinutes(-3),
            CompletedAt = at,
        };
        _db.PendingTopups.Add(pending);
        _db.LedgerEntries.Add(new LedgerEntry
        {
            TenantId = w.TenantId,
            UserId = userId,
            Type = LedgerEntryType.TopUp,
            AmountMinutes = package.Minutes,
            ZarPaid = package.PriceZar,
            ActorUserId = userId,
            Reason = TopUpEndpoints.PurchaseReason(pending, CurrencySymbol.For(w.Settings)),
            ExternalReference = TopUpEndpoints.TopUpReference(w.TenantId, paymentId),
            CreatedAt = at,
        });
    }

    /// <summary>Some players bought ahead this week; every admin has hours to book with.</summary>
    private int BuyAhead(DemoWorld w, Dictionary<Guid, int> balances)
    {
        var rows = 0;
        foreach (var p in w.Players)
        {
            var low = balances.GetValueOrDefault(p.UserId) < 120;
            // An admin always has hours to book with: shares received are held for their partners,
            // so their balance alone would leave them short of a court.
            if (!p.IsMirror && !w.Chance(low ? 0.3 : 0.12)) continue;
            Buy(w, p.UserId, PackageFor(w, p.IsMirror ? 300 : 60), (w.Now - w.Between(TimeSpan.FromHours(2), TimeSpan.FromDays(6))).Storable());
            rows++;
        }
        return rows;
    }

    /// <summary>A few checkouts that never completed — a member who backed out, a declined card — so the console's open and failed purchases are not empty.</summary>
    private int AbandonedCheckouts(DemoWorld w)
    {
        if (w.Packages.Count == 0 || w.Players.Count == 0) return 0;
        var outcomes = new[] { (TopUpStatus.Cancelled, TopUpEndpoints.FailureCodes.Cancelled), (TopUpStatus.Failed, TopUpEndpoints.FailureCodes.Declined), (TopUpStatus.Cancelled, TopUpEndpoints.FailureCodes.Cancelled) };
        foreach (var (status, reason) in outcomes)
        {
            var package = w.Pick(w.Packages);
            var at = (w.Now - w.Between(TimeSpan.FromHours(5), TimeSpan.FromDays(40))).Storable();
            _db.PendingTopups.Add(new PendingTopup
            {
                TenantId = w.TenantId,
                UserId = w.Pick(w.Players).UserId,
                PackageId = package.Id,
                PackageName = package.Name,
                Minutes = package.Minutes,
                ListPriceZar = package.PriceZar,
                AmountZar = package.PriceZar,
                IdempotencyKey = $"tu_{Guid.NewGuid():N}",
                GatewayCheckoutId = "demo",
                Status = status,
                FailureReason = reason,
                CreatedAt = at,
                CompletedAt = at.AddMinutes(4),
            });
        }
        return 0;
    }
}
