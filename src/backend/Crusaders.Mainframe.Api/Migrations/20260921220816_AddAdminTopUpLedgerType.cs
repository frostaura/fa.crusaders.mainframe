using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <summary>
    /// Widens <c>ck_ledger_entries_type_range</c> for <c>LedgerEntryType.AdminTopUp</c> (8).
    ///
    /// <para>
    /// The bound is computed from the enum at <c>MainframeDbContext</c>, so the C# side needs no
    /// edit beyond the member itself — but the CHECK is in the database and has to be re-issued,
    /// or the club's first cash top-up is refused by a constraint nobody edited. <b>This
    /// migration must land with or before the code that writes an AdminTopUp row.</b>
    /// </para>
    ///
    /// <para>
    /// <c>Down</c> narrows it back to 7, which will fail while any <c>AdminTopUp</c> row exists
    /// — correctly. Rolling this back means deciding what those rows are, and a migration that
    /// silently rewrote a club's money rows to some other type would be the worse answer.
    /// </para>
    /// </summary>
    public partial class AddAdminTopUpLedgerType : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "ck_ledger_entries_type_range",
                table: "ledger_entries");

            migrationBuilder.AddCheckConstraint(
                name: "ck_ledger_entries_type_range",
                table: "ledger_entries",
                sql: "\"Type\" BETWEEN 0 AND 8");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "ck_ledger_entries_type_range",
                table: "ledger_entries");

            migrationBuilder.AddCheckConstraint(
                name: "ck_ledger_entries_type_range",
                table: "ledger_entries",
                sql: "\"Type\" BETWEEN 0 AND 7");
        }
    }
}
