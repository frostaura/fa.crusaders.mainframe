using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddDemoMemberView : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_users_TenantId_DemoSourceUserId",
                table: "users");

            migrationBuilder.AddColumn<bool>(
                name: "DemoMemberView",
                table: "users",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.CreateIndex(
                name: "IX_users_TenantId_DemoSourceUserId_DemoMemberView",
                table: "users",
                columns: new[] { "TenantId", "DemoSourceUserId", "DemoMemberView" },
                unique: true,
                filter: "\"DemoSourceUserId\" IS NOT NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_users_TenantId_DemoSourceUserId_DemoMemberView",
                table: "users");

            migrationBuilder.DropColumn(
                name: "DemoMemberView",
                table: "users");

            migrationBuilder.CreateIndex(
                name: "IX_users_TenantId_DemoSourceUserId",
                table: "users",
                columns: new[] { "TenantId", "DemoSourceUserId" },
                unique: true,
                filter: "\"DemoSourceUserId\" IS NOT NULL");
        }
    }
}
