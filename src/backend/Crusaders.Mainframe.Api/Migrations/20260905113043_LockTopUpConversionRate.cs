using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <inheritdoc />
    public partial class LockTopUpConversionRate : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<decimal>(
                name: "ConversionRate",
                table: "pending_topups",
                type: "numeric(8,4)",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "MemberClass",
                table: "pending_topups",
                type: "integer",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "ConversionRate",
                table: "pending_topups");

            migrationBuilder.DropColumn(
                name: "MemberClass",
                table: "pending_topups");
        }
    }
}
