using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddDeviceFailedVersion : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "FailedVersion",
                table: "devices",
                type: "text",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "FailedVersion",
                table: "devices");
        }
    }
}
