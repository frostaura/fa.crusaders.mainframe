using System.Collections.Generic;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <summary>
    /// A court box drives a SET of courts, not one (review C4). The scaffold dropped the
    /// old column and added the new one; the order here is reversed and a backfill put
    /// between them so no registered box loses the court it was fitted at. The list is
    /// in relay order, so a one-court box becomes <c>[n]</c> on relay A — which is what
    /// its wiring already was.
    /// </summary>
    public partial class AddDeviceCourtNumbers : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<List<int>>(
                name: "CourtNumbers",
                table: "devices",
                type: "integer[]",
                nullable: false,
                defaultValueSql: "'{}'::integer[]");

            // Every box that had a court keeps it. Gates (null) stay empty.
            migrationBuilder.Sql(
                """UPDATE devices SET "CourtNumbers" = ARRAY["CourtNumber"] WHERE "CourtNumber" IS NOT NULL;""");

            migrationBuilder.DropColumn(
                name: "CourtNumber",
                table: "devices");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "CourtNumber",
                table: "devices",
                type: "integer",
                nullable: true);

            // Lossy by construction: a multi-court box keeps only relay A's court.
            migrationBuilder.Sql(
                """UPDATE devices SET "CourtNumber" = "CourtNumbers"[1] WHERE cardinality("CourtNumbers") > 0;""");

            migrationBuilder.DropColumn(
                name: "CourtNumbers",
                table: "devices");
        }
    }
}
