using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <summary>
    /// <c>pending_topups.ExternalReference</c> becomes unique PER TENANT rather than globally,
    /// and every existing <c>TopUp</c> ledger reference is namespaced with its tenant.
    ///
    /// <para>
    /// Both halves of D2-B02. A PayFast <c>pf_payment_id</c> is unique inside a merchant
    /// account and says nothing about any other club's, but both indexes that carry it were
    /// global and tenant-blind while every read of both tables is tenant-filtered. Two clubs on
    /// one merchant account — or any two sandboxes with small repeating ids — collided: the
    /// second club's completion raised 23505, and with the missing catch (D2-B03) that was a
    /// 500, a <c>PendingTopup</c> stuck at <c>Pending</c>, and a member never credited for money
    /// PayFast took.
    /// </para>
    ///
    /// <para>
    /// The two tables are fixed differently on purpose. <c>ledger_entries.ExternalReference</c>
    /// is shared by four reference namespaces (<c>topup:</c>, <c>adjust:</c>, <c>walkup:</c> and
    /// the settlement references) and a prefix is already what keeps them apart, so the top-up
    /// path joins that convention. <c>pending_topups.ExternalReference</c> holds one kind of
    /// value and is the reference quoted to a member in the failure email, so it stays the raw
    /// gateway id and the INDEX carries the tenant instead.
    /// </para>
    ///
    /// <para>
    /// <b>Run the data half in a maintenance window.</b> It rewrites the very keys PayFast
    /// retries against: an ITN landing between the rewrite and the deploy would find no row
    /// under its old reference and credit a second time. The window is the mitigation and it is
    /// stated rather than engineered around — the alternative is dual-reading both spellings for
    /// ever, which is a permanent cost to avoid a one-off one.
    /// </para>
    /// </summary>
    public partial class ScopeTopUpReferenceToTenant : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_pending_topups_ExternalReference",
                table: "pending_topups");

            migrationBuilder.CreateIndex(
                name: "IX_pending_topups_TenantId_ExternalReference",
                table: "pending_topups",
                columns: new[] { "TenantId", "ExternalReference" },
                unique: true,
                filter: "\"ExternalReference\" IS NOT NULL");

            // The ledger half. Guarded so it is re-runnable and cannot touch a row that has
            // already been namespaced, and scoped to Type = 0 (TopUp) so the adjust:, walkup:
            // and settlement references sharing this column are left alone.
            migrationBuilder.Sql(
                """
                UPDATE ledger_entries
                   SET "ExternalReference" = 'topup:' || replace("TenantId"::text, '-', '') || ':' || "ExternalReference"
                 WHERE "Type" = 0
                   AND "ExternalReference" IS NOT NULL
                   AND "ExternalReference" NOT LIKE 'topup:%';
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(
                """
                UPDATE ledger_entries
                   SET "ExternalReference" = substring(
                           "ExternalReference"
                           from length('topup:' || replace("TenantId"::text, '-', '') || ':') + 1)
                 WHERE "Type" = 0
                   AND "ExternalReference" LIKE 'topup:' || replace("TenantId"::text, '-', '') || ':%';
                """);

            migrationBuilder.DropIndex(
                name: "IX_pending_topups_TenantId_ExternalReference",
                table: "pending_topups");

            migrationBuilder.CreateIndex(
                name: "IX_pending_topups_ExternalReference",
                table: "pending_topups",
                column: "ExternalReference",
                unique: true,
                filter: "\"ExternalReference\" IS NOT NULL");
        }
    }
}
