using System.Text;
using Crusaders.Mainframe.Api.Biometric;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Payments;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Webhooks;
using Fido2NetLib;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;

var builder = WebApplication.CreateBuilder(args);

// ---- Postgres / EF Core ----
var connectionString = builder.Configuration.GetConnectionString("DefaultConnection")
    ?? throw new InvalidOperationException("ConnectionStrings:DefaultConnection is required.");
builder.Services.AddDbContext<MainframeDbContext>(options => options.UseNpgsql(connectionString));

// ---- CORS ----
var allowedOrigins = builder.Configuration.GetSection("Cors:AllowedOrigins").Get<string[]>()
    ?? new[] { "http://localhost:8088" };
builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy => policy
        .WithOrigins(allowedOrigins)
        .AllowAnyHeader()
        .AllowAnyMethod()
        .AllowCredentials());
});

// ---- JWT ----
var jwtSecret = builder.Configuration["Jwt:Secret"] ?? throw new InvalidOperationException("Jwt:Secret is required.");
var jwtIssuer = builder.Configuration["Jwt:Issuer"] ?? "crusaders.mainframe";
var jwtAudience = builder.Configuration["Jwt:Audience"] ?? "crusaders.mainframe.app";
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidateAudience = true,
            ValidateLifetime = true,
            ValidateIssuerSigningKey = true,
            ValidIssuer = jwtIssuer,
            ValidAudience = jwtAudience,
            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwtSecret)),
            ClockSkew = TimeSpan.FromSeconds(30),
        };
        // EventSource (SSE) clients cannot set custom request headers, so the wallet stream
        // accepts the JWT via ?access_token=... query string in addition to Authorization.
        options.Events = new JwtBearerEvents
        {
            OnMessageReceived = ctx =>
            {
                if (string.IsNullOrEmpty(ctx.Token)
                    && ctx.HttpContext.Request.Path.StartsWithSegments("/api/v1/wallet/stream"))
                {
                    var qToken = ctx.Request.Query["access_token"].ToString();
                    if (!string.IsNullOrEmpty(qToken)) ctx.Token = qToken;
                }
                return Task.CompletedTask;
            },
        };
    });
builder.Services.AddAuthorization();

// ---- DI registrations ----
builder.Services.AddScoped<ITenantContext, TenantContext>();
builder.Services.AddSingleton<IPasswordHasher, Pbkdf2PasswordHasher>();
builder.Services.AddScoped<IJwtIssuer, JwtIssuer>();
// Singleton — SmtpEmailService is stateless (only depends on IConfiguration + logger),
// and keeping it singleton lets the booking/cancel hot paths fire-and-forget the send
// off the request thread without scope-disposal hazards.
builder.Services.AddSingleton<IEmailService, SmtpEmailService>();
builder.Services.AddScoped<TenantSettingsAccessor>();
builder.Services.AddScoped<TenantSecretsAccessor>();
builder.Services.AddHttpClient("peach");
builder.Services.AddScoped<IPaymentProvider, PeachPaymentsProvider>();
builder.Services.AddSingleton<BalanceBroadcaster>();
builder.Services.AddScoped<LedgerService>();
builder.Services.AddScoped<ScheduleService>();
builder.Services.AddScoped<BookingService>();
builder.Services.AddScoped<AuthService>();
builder.Services.AddScoped<MemberApprovalService>();

// Phase 4 — webhook engine + lights cue worker + no-show worker
builder.Services.AddSingleton<IEventBus, InMemoryEventBus>();
builder.Services.AddHttpClient("webhooks");
builder.Services.AddHostedService<WebhookDeliveryWorker>();
builder.Services.AddHostedService<LightsCueWorker>();
builder.Services.AddHostedService<NoShowWorker>();

// Phase 8.8 — retention worker (nightly anonymisation of records older than retention_years)
builder.Services.AddHostedService<Crusaders.Mainframe.Api.Workers.RetentionWorker>();

// Phase 5 — biometric abstraction
builder.Services.AddSingleton<IBiometricDevice, NullBiometricDevice>();
builder.Services.AddScoped<BiometricService>();

// WebAuthn / passkeys
builder.Services.AddMemoryCache();
builder.Services.AddSingleton<IFido2>(sp =>
{
    var cfg = sp.GetRequiredService<IConfiguration>();
    // Support both flat env-var names (WEBAUTHN_RP_ID) and nested config keys (WebAuthn:RpId).
    var rpId = cfg["WEBAUTHN_RP_ID"] ?? cfg["WebAuthn:RpId"] ?? "localhost";
    var rpName = cfg["WEBAUTHN_RP_NAME"] ?? cfg["WebAuthn:RpName"] ?? "Crusaders Squash";
    var originsCsv = cfg["WEBAUTHN_ORIGIN"] ?? cfg["WebAuthn:Origins"];
    var origins = !string.IsNullOrWhiteSpace(originsCsv)
        ? originsCsv.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
        : new[] { "http://localhost:8089", "https://localhost:8089" };
    return new Fido2(new Fido2Configuration
    {
        ServerDomain = rpId,
        ServerName = rpName,
        Origins = new HashSet<string>(origins),
        TimestampDriftTolerance = 300_000,
    });
});

builder.Services.AddEndpointsApiExplorer();
builder.Services.AddProblemDetails();
builder.Services.AddRouting();

var app = builder.Build();

// ---- Schema + seed ----
// Real EF migrations under Migrations/. AutoMigrate runs the InitialCreate migration on first boot
// and is a no-op thereafter. Set Database:AutoMigrateOnStartup=false in environments where migrations
// are applied externally (e.g. via `dotnet ef database update` in CD).
if (builder.Configuration.GetValue<bool>("Database:AutoMigrateOnStartup"))
{
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
    await db.Database.MigrateAsync();
}

if (app.Environment.IsDevelopment())
{
    var logger = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Seed");
    try { await Seeder.SeedAsync(app.Services, logger); }
    catch (Exception ex) { logger.LogError(ex, "Seed failed (non-fatal in dev)"); }
}

app.UseCors();

// Serve uploaded media. The /uploads/ path is in the tenant-resolution anonymous prefix list
// so static files don't require a JWT.
{
    var mediaRoot = builder.Configuration["Media:StoragePath"] ?? "/app/media";
    Directory.CreateDirectory(mediaRoot);
    app.UseStaticFiles(new Microsoft.AspNetCore.Builder.StaticFileOptions
    {
        FileProvider = new Microsoft.Extensions.FileProviders.PhysicalFileProvider(Path.GetFullPath(mediaRoot)),
        RequestPath = "/uploads",
        ServeUnknownFileTypes = false,
    });
}

app.UseAuthentication();
app.UseMiddleware<TenantResolutionMiddleware>();
app.UseAuthorization();

// ---- Anonymous endpoints ----
app.MapGet("/healthz", () => Results.Ok(new { status = "ok", service = "crusaders.mainframe", time = DateTimeOffset.UtcNow }))
   .AllowAnonymous();

app.MapGet("/api/v1/whoami", (HttpContext ctx, ITenantContext tenant) => Results.Ok(new
{
    tenant_slug = tenant.TenantSlug,
    tenant_id = tenant.TenantId,
    user_id = ctx.User.Id(),
    is_authenticated = ctx.User.Identity?.IsAuthenticated ?? false,
    is_admin = ctx.User.IsInRole("admin"),
})).AllowAnonymous();

// ---- Mounted endpoint groups ----
app.MapAuthEndpoints();
app.MapAdminMemberEndpoints();
app.MapWalletEndpoints();
app.MapScheduleEndpoints();
app.MapBookingEndpoints();
app.MapAdminConfigEndpoints();
app.MapAdminLedgerEndpoints();
app.MapMeProfileEndpoints();
app.MapWebhookEndpoints();
app.MapBiometricEndpoints();
app.MapWebAuthnEndpoints();
app.MapReportingEndpoints();
app.MapTopUpEndpoints();
app.MapPinEndpoints();
app.MapQrEndpoints();

app.Run();

public partial class Program { }
