using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <summary>
    /// Backend-platform pass, 2026-11-13.
    /// <list type="bullet">
    /// <item><c>tenants.PublicBaseUrl</c> — a club's own address when it is not the derived one
    /// (BP-03; see <c>Services/TenantLinks.cs</c>).</item>
    /// <item><c>users.IsPlatformAdmin</c> dropped — minted into a role no policy read (BP-13). No
    /// row was ever true: nothing seeded or set one.</item>
    /// <item>Member-registered webhooks deleted with their deliveries (BP-08): the route that
    /// created them had no caller, no cap and shared one serial queue with every club; it is gone,
    /// and an endpoint nothing can list, edit or delete any more must not keep receiving events.</item>
    /// </list>
    /// </summary>
    public partial class PlatformTenantOnboarding : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                DELETE FROM webhook_deliveries
                 WHERE "EndpointId" IN (SELECT "Id" FROM webhook_endpoints WHERE "OwnerKind" = 1);
                DELETE FROM webhook_endpoints WHERE "OwnerKind" = 1;
                """);

            migrationBuilder.DropColumn(
                name: "IsPlatformAdmin",
                table: "users");

            migrationBuilder.AddColumn<string>(
                name: "PublicBaseUrl",
                table: "tenants",
                type: "character varying(512)",
                maxLength: 512,
                nullable: true);
        }

        /// <summary>Restores the columns. The deleted member endpoints are not restored: nothing can recreate them.</summary>
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "PublicBaseUrl",
                table: "tenants");

            migrationBuilder.AddColumn<bool>(
                name: "IsPlatformAdmin",
                table: "users",
                type: "boolean",
                nullable: false,
                defaultValue: false);
        }
    }
}
