using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddShareReconcileDue : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "ShareReconcileDueAt",
                table: "bookings",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_bookings_TenantId_ShareReconcileDueAt",
                table: "bookings",
                columns: new[] { "TenantId", "ShareReconcileDueAt" },
                filter: "\"ShareReconcileDueAt\" IS NOT NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Rolling back FORGETS every outstanding "reconcile due" marker: a booking whose
            // reconcile failed and was never made good is then reached only by the sweep's week,
            // or the start-up catch-up if it looks at such games. Check for marked rows first:
            // SELECT "Id" FROM bookings WHERE "ShareReconcileDueAt" IS NOT NULL.
            migrationBuilder.DropIndex(
                name: "IX_bookings_TenantId_ShareReconcileDueAt",
                table: "bookings");

            migrationBuilder.DropColumn(
                name: "ShareReconcileDueAt",
                table: "bookings");
        }
    }
}
