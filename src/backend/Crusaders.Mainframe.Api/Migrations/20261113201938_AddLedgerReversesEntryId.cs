using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddLedgerReversesEntryId : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(
                name: "ReversesEntryId",
                table: "ledger_entries",
                type: "uuid",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_ledger_entries_TenantId_ReversesEntryId",
                table: "ledger_entries",
                columns: new[] { "TenantId", "ReversesEntryId" },
                filter: "\"ReversesEntryId\" IS NOT NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_ledger_entries_TenantId_ReversesEntryId",
                table: "ledger_entries");

            migrationBuilder.DropColumn(
                name: "ReversesEntryId",
                table: "ledger_entries");
        }
    }
}
