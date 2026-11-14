using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddLedgerPurchaseId : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(
                name: "PurchaseId",
                table: "ledger_entries",
                type: "uuid",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_ledger_entries_TenantId_PurchaseId",
                table: "ledger_entries",
                columns: new[] { "TenantId", "PurchaseId" },
                unique: true,
                filter: "\"PurchaseId\" IS NOT NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_ledger_entries_TenantId_PurchaseId",
                table: "ledger_entries");

            migrationBuilder.DropColumn(
                name: "PurchaseId",
                table: "ledger_entries");
        }
    }
}
