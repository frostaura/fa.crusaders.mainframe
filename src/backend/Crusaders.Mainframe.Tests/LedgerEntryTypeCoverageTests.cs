using Crusaders.Mainframe.Api.Domain;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The test that makes adding a ledger type safe.
///
/// <para>
/// Before this, adding an enum member was silently dangerous. There is no database CHECK
/// constraint on the column, <c>LedgerRow.type</c> is a bare <c>string</c> in TypeScript,
/// and <c>LedgerService.PostAsync</c> is type-blind — so a new member moved balances
/// correctly and appeared in <c>net_credits</c>, while being invisible in fifteen
/// <c>Where(Type == X)</c> bucket sums across two endpoint files. Nothing failed to
/// compile. No test failed. The month-end columns simply stopped summing to the total, and
/// the first person to notice would be an admin reconciling by hand.
/// </para>
///
/// <para>
/// So the buckets are declared once in <see cref="LedgerEntryTypes"/> and this asserts the
/// declaration is total. Add a member without classifying it and this goes red with a
/// message naming it.
/// </para>
/// </summary>
public class LedgerEntryTypeCoverageTests
{
    private static LedgerEntryType[] AllMembers => Enum.GetValues<LedgerEntryType>();

    /// <summary>
    /// The load-bearing one. Every member must be in a bucket, or it vanishes from every
    /// report while still moving the balance.
    /// </summary>
    [Fact]
    public void Every_ledger_type_belongs_to_a_bucket()
    {
        var classified = LedgerEntryTypes.All.SelectMany(b => b.Members).ToHashSet();
        var unclassified = AllMembers.Where(t => !classified.Contains(t)).ToList();

        Assert.True(unclassified.Count == 0,
            $"These ledger types are in no report bucket: {string.Join(", ", unclassified)}. " +
            "They will move member balances while being invisible in every report. " +
            "Add each to a bucket in LedgerEntryTypes, and check whether the frontend " +
            "AdminLedger filter and the TypeScript union need it too.");
    }

    /// <summary>
    /// And in exactly one, or it is double-counted. A type in both Spend and Penalty would
    /// be subtracted twice and the report would understate the member's balance.
    /// </summary>
    [Fact]
    public void No_ledger_type_belongs_to_two_buckets()
    {
        var duplicates = LedgerEntryTypes.All
            .SelectMany(b => b.Members.Select(m => (Bucket: b.Name, Member: m)))
            .GroupBy(x => x.Member)
            .Where(g => g.Count() > 1)
            .Select(g => $"{g.Key} is in {string.Join(" and ", g.Select(x => x.Bucket))}")
            .ToList();

        Assert.True(duplicates.Count == 0,
            $"Double-counted ledger types: {string.Join("; ", duplicates)}");
    }

    /// <summary>Buckets must not name a type that no longer exists.</summary>
    [Fact]
    public void No_bucket_names_a_type_outside_the_enum()
    {
        var all = AllMembers.ToHashSet();

        Assert.All(LedgerEntryTypes.All, bucket =>
            Assert.All(bucket.Members, m => Assert.Contains(m, all)));
    }

    /// <summary>
    /// Light time bought at the court is money spent on court time, so it must sit
    /// alongside a booking charge in the spend bucket rather than in a category of its own
    /// — otherwise "what did this member spend" answers differently depending on how they
    /// happened to buy the time.
    /// </summary>
    [Fact]
    public void Lights_purchases_count_as_spend()
    {
        Assert.Contains(LedgerEntryType.LightsPurchase, LedgerEntryTypes.Spend);
        Assert.Contains(LedgerEntryType.BookingCharge, LedgerEntryTypes.Spend);
    }

    /// <summary>
    /// The enum's numeric values are persisted as plain integers, so reordering or
    /// renumbering silently reinterprets every historical row. Pinned explicitly.
    /// </summary>
    [Theory]
    [InlineData(LedgerEntryType.TopUp, 0)]
    [InlineData(LedgerEntryType.BookingCharge, 1)]
    [InlineData(LedgerEntryType.CancellationRefund, 2)]
    [InlineData(LedgerEntryType.NoShowPenalty, 3)]
    [InlineData(LedgerEntryType.LateCancellationPenalty, 4)]
    [InlineData(LedgerEntryType.AdminAdjustment, 5)]
    [InlineData(LedgerEntryType.PaymentReversal, 6)]
    [InlineData(LedgerEntryType.LightsPurchase, 7)]
    [InlineData(LedgerEntryType.AdminTopUp, 8)]
    [InlineData(LedgerEntryType.ShareTransfer, 9)]
    public void Ledger_type_values_are_stable(LedgerEntryType type, int expected)
    {
        Assert.Equal(expected, (int)type);
    }

    /// <summary>
    /// A guard on the count itself. Adding a member forces a deliberate edit here, which is
    /// the prompt to check the frontend filter list and the report buckets — neither of
    /// which the compiler can check.
    /// </summary>
    [Fact]
    public void The_number_of_ledger_types_is_pinned()
    {
        // 10 since D11's ShareTransfer. The frontend's ledger-type filter list is the other place
        // that must learn it (the players frontend lane).
        Assert.Equal(10, AllMembers.Length);
    }
}
