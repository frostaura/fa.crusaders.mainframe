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
using System.Threading.RateLimiting;
using Crusaders.Mainframe.Api.Security.Outbound;
using Microsoft.AspNetCore.RateLimiting;
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
// Device authentication is a second scheme rather than a variant of the JWT one:
// a board in a cupboard has no user, no refresh cycle and no browser, and giving it
// an admin JWT was the alternative.
builder.Services.AddSingleton<Crusaders.Mainframe.Api.Security.DeviceAuth.IDeviceKeyDeriver,
                              Crusaders.Mainframe.Api.Security.DeviceAuth.DeviceKeyDeriver>();

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddScheme<Crusaders.Mainframe.Api.Security.DeviceAuth.DeviceAuthOptions,
               Crusaders.Mainframe.Api.Security.DeviceAuth.DeviceAuthenticationHandler>(
        Crusaders.Mainframe.Api.Security.DeviceAuth.DeviceAuthenticationHandler.SchemeName, _ => { })
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

            // A bearer token must be an *access* token and nothing else.
            //
            // Every token this application issues is signed with the same key, for the
            // same issuer and audience — including the one-minute qr_ident token a
            // member's phone displays at the court, which a camera in a public room
            // photographs by design. Without this check that token is a valid
            // Authorization header for the whole API as that member: scan the screen,
            // read the wallet, book on their credits. The planned printed member-card
            // QR would have made it permanent rather than one-minute.
            //
            // Enforced here rather than per-endpoint so a new endpoint is covered by
            // default; an endpoint that genuinely wants a one-time token validates it
            // itself, out of band, as the QR match endpoint already does.
            OnTokenValidated = ctx =>
            {
                var purpose = ctx.Principal?.FindFirst("purpose")?.Value;
                if (!string.Equals(purpose, "access", StringComparison.Ordinal))
                {
                    ctx.Fail($"Token purpose '{purpose ?? "(none)"}' is not valid for API access.");
                }
                return Task.CompletedTask;
            },
        };
    });
builder.Services.AddAuthorization();

// ---- Rate limiting ----
//
// The application had none. Three surfaces need it for different reasons, so they get
// three policies rather than one global number:
//   auth   — password and PIN guessing, which is an unbounded oracle without a limit
//   device — a court box calls on a schedule; anything faster is a fault or a flood
//   api    — a backstop so one client cannot saturate an on-prem box at the club
//
// Partitioned by remote address, falling back to a single shared partition when the
// address is unknown, so a proxy that strips it cannot be used to escape the limit.
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

    static string PartitionKey(HttpContext ctx)
        => ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown";

    options.AddPolicy(RateLimitPolicies.Auth, ctx =>
        RateLimitPartition.GetFixedWindowLimiter(PartitionKey(ctx), _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = builder.Configuration.GetValue("RateLimits:AuthPerMinute", 10),
            Window = TimeSpan.FromMinutes(1),
            QueueLimit = 0,
        }));

    options.AddPolicy(RateLimitPolicies.Device, ctx =>
        RateLimitPartition.GetFixedWindowLimiter(PartitionKey(ctx), _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = builder.Configuration.GetValue("RateLimits:DevicePerMinute", 120),
            Window = TimeSpan.FromMinutes(1),
            QueueLimit = 0,
        }));

    options.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(ctx =>
        RateLimitPartition.GetFixedWindowLimiter(PartitionKey(ctx), _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = builder.Configuration.GetValue("RateLimits:GlobalPerMinute", 600),
            Window = TimeSpan.FromMinutes(1),
            QueueLimit = 0,
        }));

    options.OnRejected = async (ctx, ct) =>
    {
        ctx.HttpContext.Response.Headers.RetryAfter = "60";
        await ctx.HttpContext.Response.WriteAsJsonAsync(
            new { error = "rate_limited", message = "Too many requests. Try again shortly." }, ct);
    };
});

// ---- DI registrations ----
builder.Services.AddScoped<ITenantContext, TenantContext>();
builder.Services.AddSingleton<IPasswordHasher, Pbkdf2PasswordHasher>();
builder.Services.AddScoped<IJwtIssuer, JwtIssuer>();
// Singleton — SmtpEmailService is stateless (only depends on IConfiguration + logger),
// and keeping it singleton lets the booking/cancel hot paths fire-and-forget the send
// off the request thread without scope-disposal hazards.
builder.Services.AddSingleton<IEmailService, SmtpEmailService>();
builder.Services.AddScoped<TenantSettingsAccessor>();
builder.Services.AddSingleton<OtaCatalogue>();
builder.Services.AddSingleton<IdentificationResolver>();
builder.Services.AddScoped<DeviceRegistryService>();
builder.Services.AddSingleton<Crusaders.Mainframe.Api.Security.Discovery.ProvisioningGrants>();
builder.Services.AddScoped<Crusaders.Mainframe.Api.Security.DeviceAuth.DeviceVerifier>();
builder.Services.AddScoped<TenantSecretsAccessor>();
builder.Services.AddScoped<IPaymentProvider, Crusaders.Mainframe.Api.Payments.PayFast.PayFastProvider>();
builder.Services.AddSingleton<BalanceBroadcaster>();
builder.Services.AddScoped<LedgerService>();
builder.Services.AddScoped<ScheduleService>();
builder.Services.AddScoped<BookingService>();
builder.Services.AddScoped<CourtActivationService>();
builder.Services.AddScoped<AuthService>();
builder.Services.AddScoped<MemberApprovalService>();

// Phase 4 — webhook engine + lights cue worker + no-show worker
builder.Services.AddSingleton<IEventBus, InMemoryEventBus>();
// Webhook delivery dials whatever URL an endpoint owner configured, so it is the one
// HttpClient in the application that must not be allowed to reach the LAN it runs on.
// The guard lives in the socket's ConnectCallback rather than in URL validation —
// see GuardedHttpClient for why a pre-flight check is not a boundary.
builder.Services.AddSingleton<Crusaders.Mainframe.Api.Security.Outbound.IOutboundAddressGuard,
                              Crusaders.Mainframe.Api.Security.Outbound.OutboundAddressGuard>();
builder.Services.AddGuardedHttpClient("webhooks");
builder.Services.AddSingleton<WebhookSender>();
builder.Services.AddHostedService<WebhookDeliveryWorker>();
builder.Services.AddHostedService<WebhookRetryWorker>();
builder.Services.AddHostedService<LightsCueWorker>();
builder.Services.AddHostedService<NoShowWorker>();

// Phase 8.8 — retention worker (nightly anonymisation of records older than retention_years)
builder.Services.AddHostedService<Crusaders.Mainframe.Api.Workers.RetentionWorker>();

// Device discovery — a UDP listener on the club LAN plus the bounded store behind it.
//
// The store is a singleton independent of the listener on purpose: the admin endpoints
// have to answer "did the listener bind?" even — especially — when it did not, and a
// store that only existed once a socket was open could not report its own absence.
builder.Services.AddSingleton(sp =>
    Crusaders.Mainframe.Api.Security.Discovery.DiscoveryOptions.FromConfiguration(
        sp.GetRequiredService<IConfiguration>()));
builder.Services.AddSingleton<Crusaders.Mainframe.Api.Security.Discovery.DiscoveryStore>(sp =>
    new Crusaders.Mainframe.Api.Security.Discovery.DiscoveryStore(
        sp.GetRequiredService<Crusaders.Mainframe.Api.Security.Discovery.DiscoveryOptions>()));
builder.Services.AddSingleton<Crusaders.Mainframe.Api.Security.Discovery.IDiscoveryDeviceResolver,
                              Crusaders.Mainframe.Api.Security.Discovery.DiscoveryDeviceResolver>();
builder.Services.AddHostedService<Crusaders.Mainframe.Api.Security.Discovery.DiscoveryListener>();
builder.Services.AddScoped<DeviceDiscoveryService>();

// Phase 5 — biometric abstraction
builder.Services.AddSingleton<IBiometricDevice, NullBiometricDevice>();

// Hardware abstractions ship before drivers, and CI must pass without touching a relay.
builder.Services.AddSingleton<Crusaders.Mainframe.Api.Lights.IRelayClient,
                              Crusaders.Mainframe.Api.Lights.NullRelayClient>();
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

app.UseRateLimiter();
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
app.MapAdminDeviceEndpoints();
app.MapAdminDeviceDiscoveryEndpoints();
app.MapAdminLedgerEndpoints();
app.MapMeProfileEndpoints();
app.MapWebhookEndpoints();
app.MapBiometricEndpoints();
app.MapWebAuthnEndpoints();
app.MapReportingEndpoints();
app.MapTopUpEndpoints();
app.MapPinEndpoints();
app.MapQrEndpoints();
app.MapUploadEndpoints();
app.MapDeviceEndpoints();
app.MapDeviceEventEndpoints();

app.Run();

public partial class Program { }
