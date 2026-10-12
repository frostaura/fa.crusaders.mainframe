using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddSeatShortfall : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "ShortfallMinutes",
                table: "booking_participants",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddCheckConstraint(
                name: "ck_booking_participants_shortfall",
                table: "booking_participants",
                sql: "\"ShortfallMinutes\" >= 0");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "ck_booking_participants_shortfall",
                table: "booking_participants");

            migrationBuilder.DropColumn(
                name: "ShortfallMinutes",
                table: "booking_participants");
        }
    }
}
