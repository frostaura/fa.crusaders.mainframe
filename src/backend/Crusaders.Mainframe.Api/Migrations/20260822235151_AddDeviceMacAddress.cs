using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddDeviceMacAddress : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "MacAddress",
                table: "devices",
                type: "text",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_devices_TenantId_MacAddress",
                table: "devices",
                columns: new[] { "TenantId", "MacAddress" },
                unique: true,
                filter: "\"MacAddress\" IS NOT NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_devices_TenantId_MacAddress",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "MacAddress",
                table: "devices");
        }
    }
}
