using System.Globalization;
using System.IdentityModel.Tokens.Jwt;
using System.Net;
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
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.EntityFrameworkCore;
using System.Threading.RateLimiting;
using Crusaders.Mainframe.Api.Security.DeviceAuth;
using Crusaders.Mainframe.Api.Security.Outbound;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.IdentityModel.Tokens;

var builder = WebApplication.CreateBuilder(args);

// Kestrel announces "Server: Kestrel" on every response by default, and the gateway announces
// its own version on top of that. Neither buys anything and both name a version to look up.
builder.WebHost.ConfigureKestrel(options => options.AddServerHeader = false);

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

        // A browser hands a page only the six CORS-safelisted response headers unless the
        // server names the rest. Both of these are read by the console — the door log's
        // export announces how many rows the FILE holds and whether it was truncated — and
        // without this line they are present on the wire, visible in a terminal, and
        // undefined in the page that needs them. That shape is worse than not sending them:
        // the console announced its own page size instead, so a 165-row export was reported
        // to the admin as "50 scans downloaded" (B3).
        .WithExposedHeaders(
            Crusaders.Mainframe.Api.Endpoints.AdminDoorLogEndpoint.RowsHeader,
            Crusaders.Mainframe.Api.Endpoints.AdminDoorLogEndpoint.TruncatedHeader)
        .AllowCredentials());
});

// ---- JWT ----
// Not a null check. The committed placeholder meant this was never null, so a production
// deployment that forgot Jwt__Secret booted clean and signed tokens with a value that is in
// the repository. See JwtSecretPolicy.
var jwtSecret = JwtSecretPolicy.Resolve(builder.Configuration, builder.Environment);
// The member-code master key (member-code §3.1): the same refusal, for the second secret this
// server holds. Production will not start without a real one; Development and Testing get the
// published development key. See MemberCodeKeyPolicy.
var memberCodeMasterKey = MemberCodeKeyPolicy.Resolve(builder.Configuration, builder.Environment);
// The same two constants the issuer uses. They were duplicated as literals here and absent
// there, so an API with no Jwt:Issuer configured minted tokens this middleware then refused.
var jwtIssuer = builder.Configuration["Jwt:Issuer"] ?? JwtIssuer.DefaultIssuer;
var jwtAudience = builder.Configuration["Jwt:Audience"] ?? JwtIssuer.DefaultAudience;
// Device authentication is a second scheme rather than a variant of the JWT one:
// a board in a cupboard has no user, no refresh cycle and no browser, and giving it
// an admin JWT was the alternative. It reads the club's one API key from the
// Authorization header — see DeviceAuthenticationHandler.
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddScheme<DeviceAuthOptions, DeviceAuthenticationHandler>(DeviceAuthenticationHandler.SchemeName, _ => { })
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
        // accepts a short-lived, stream-scoped ticket via ?ticket=... in addition to Authorization.
        options.Events = new JwtBearerEvents
        {
            OnMessageReceived = ctx =>
            {
                if (string.IsNullOrEmpty(ctx.Token)
                    && TokenPurposes.AcceptsTicketInQuery(ctx.HttpContext.Request.Path))
                {
                    // A stream TICKET, never the session token. The query string is logged verbatim
                    // by every proxy in front of this — nginx's `location /api/` records `$request`
                    // — and is re-sent on every reconnect, so what travels here has to be worth
                    // roughly nothing: one minute, one read-only stream. See TokenPurposes.
                    var qToken = ctx.Request.Query["ticket"].ToString();
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
            OnTokenValidated = async ctx =>
            {
                var purpose = ctx.Principal?.FindFirst("purpose")?.Value;
                if (!TokenPurposes.IsValidFor(purpose, ctx.HttpContext.Request.Path))
                {
                    ctx.Fail($"Token purpose '{purpose ?? "(none)"}' is not valid for API access.");
                    return;
                }

                // Sign-out has to mean the credential stops working, not that one browser stopped
                // presenting it. A revoked jti is refused here rather than per-endpoint, so a new
                // endpoint inherits the check instead of having to remember it.
                var jti = ctx.Principal?.FindFirst(JwtRegisteredClaimNames.Jti)?.Value
                       ?? ctx.Principal?.FindFirst("jti")?.Value;
                var revoked = ctx.HttpContext.RequestServices.GetRequiredService<AccessTokenRevocationList>();
                if (jti is not null && revoked.IsRevoked(jti))
                {
                    ctx.Fail("This session has been signed out.");
                    return;
                }

                // A rotation ends every session open when it happened (member-code §10): a lost
                // phone's PWA must not be able to re-enrol and fetch the new generation's secret.
                // A token below the account's session epoch is refused; the epoch is cached for
                // LiveAdminRole's fifteen seconds and evicted by the rotation. See SessionEpochs.
                if (ctx.Principal is { } session
                    && await ctx.HttpContext.RequestServices.GetRequiredService<SessionEpochs>()
                        .IsStaleAsync(session, ctx.HttpContext.RequestServices, ctx.HttpContext.RequestAborted))
                {
                    ctx.Fail("This session ended when the account's credentials were rotated.");
                    return;
                }

                // The admin role in a token is what was true when it was minted. A demoted admin's
                // token would otherwise keep every admin route open for the rest of its fifteen
                // minutes, so the role is checked against the account here — cached, and only for
                // tokens that claim it, so a member's request never reaches the database on this
                // line. See LiveAdminRole. Here rather than per-endpoint for the reason the two
                // checks above give: a new admin route inherits it without having to remember it.
                if (ctx.Principal is { } principal)
                {
                    var services = ctx.HttpContext.RequestServices;
                    await services.GetRequiredService<LiveAdminRole>()
                        .EnforceAsync(principal, services, ctx.HttpContext.RequestAborted);
                }
            },
        };
    });
builder.Services.AddAuthorization();

// ---- Reverse proxy ----
//
// Every deployment fronts the API with the nginx gateway (docker-compose.yml: the backend
// is `expose`d, never published; docker-compose.onprem.yml: host-networked, still fronted
// by the gateway on :8088). Kestrel therefore sees the gateway's bridge address as the
// remote peer of every browser request and the gateway's port-less `Host` header. Until
// the forwarded headers were honoured, two things followed from that: the rate limiter
// put the whole club in one bucket (closing re-review #7), and every URL composed from
// the request — the OTA image, provisioning's api_base_url — pointed at port 80, where
// nothing listens (#8, #18). The middleware below rewrites RemoteIpAddress, Scheme and
// Host from X-Forwarded-For / -Proto / -Host, and ONLY when the request arrived from a
// proxy this deployment trusts — anything else could otherwise forge its own client
// address and escape the limiter, or forge a Host and be handed a URL that points a
// court box at an attacker.
//
// Gateway:TrustedProxies is a list of addresses or CIDR networks, read by GatewayTrust —
// see that type for why the default is a single delimited STRING rather than a JSON array
// (indexed configuration merges by index, so an array default cannot be narrowed) and for
// why ForwardLimit is 2 rather than 1 (the cloudflared hop). The default names the compose
// bridge the gateway container actually stands on; it used to name 172.16.0.0/12, which on
// a club LAN in that range made every laptop a trusted proxy.
var trustedProxies = GatewayTrust.Parse(builder.Configuration);
var forwardLimit = builder.Configuration.GetValue("Gateway:ForwardLimit", GatewayTrust.DefaultForwardLimit);
builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto | ForwardedHeaders.XForwardedHost;
    options.ForwardLimit = forwardLimit;
    options.KnownProxies.Clear();
    options.KnownIPNetworks.Clear();
    foreach (var entry in trustedProxies)
    {
        // A malformed entry is skipped rather than thrown on, and the startup audit below
        // names it. A typo in one proxy address must not stop a club's API from booting.
        if (GatewayTrust.TryParseEntry(entry) is not { } parsed) continue;
        if (parsed.IsNetwork)
        {
            options.KnownIPNetworks.Add(new System.Net.IPNetwork(parsed.Address, parsed.PrefixLength));
        }
        else
        {
            options.KnownProxies.Add(parsed.Address);
        }
    }
});

// ---- Rate limiting ----
//
// The application had none. Four surfaces need it for different reasons, so they get
// four policies rather than one global number:
//   auth     — password and PIN guessing, which is an unbounded oracle without a limit
//   device   — a court box calls on a schedule; anything faster is a fault or a flood
//   api      — a backstop so one client cannot saturate an on-prem box at the club
//
// Partitioned by the client address as the forwarded-headers middleware above resolved
// it, falling back to a single shared partition when the address is unknown, so a proxy
// that strips it cannot be used to escape the limit. The DEVICE policy partitions by the
// club instead: every box at a club shares one NATted address on the LAN, so an
// address partition is a single bucket for the whole club however many boxes it has,
// while the club is exactly the unit the key names. The auth policy partitions by the
// authenticated user when there is one: the Court Code page refreshes its ident code on
// a timer for every member who has it open, and "ten a minute" has to mean per member,
// not per club. That is why authentication runs BEFORE the limiter — a request with no
// token costs the JWT handler nothing, and one with a bad token costs one HMAC, so an
// unauthenticated flood is still refused cheaply and never reaches the database.
//
// The ceilings stay deployment configuration (RateLimits:*), not tenant settings: the
// limiter runs before tenant resolution, and letting a club raise its own ceiling would
// move a denial-of-service control inside the blast radius it exists to contain.
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

    static string ClientKey(HttpContext ctx)
        => ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown";

    static string AuthKey(HttpContext ctx)
    {
        // By member when there is one, else by client address.
        var userId = ctx.User.Identity?.IsAuthenticated == true ? ctx.User.Id() : null;
        return userId is { } id ? $"user:{id:N}" : $"ip:{ClientKey(ctx)}";
    }

    options.AddPolicy(RateLimitPolicies.Auth, ctx =>
        RateLimitPartition.GetFixedWindowLimiter(AuthKey(ctx), _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = builder.Configuration.GetValue("RateLimits:AuthPerMinute", 10),
            Window = TimeSpan.FromMinutes(1),
            QueueLimit = 0,
        }));

    static string DeviceKey(HttpContext ctx)
    {
        // By club when the device scheme recognised the key, else by client address —
        // which is what an unauthenticated flood at this surface gets.
        var tenantId = ctx.User.DeviceTenantId();
        return tenantId is { } id ? $"tenant:{id:N}" : $"ip:{ClientKey(ctx)}";
    }

    options.AddPolicy(RateLimitPolicies.Device, ctx =>
        RateLimitPartition.GetFixedWindowLimiter(DeviceKey(ctx), _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = builder.Configuration.GetValue("RateLimits:DevicePerMinute", 120),
            Window = TimeSpan.FromMinutes(1),
            QueueLimit = 0,
        }));

    options.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(ctx =>
        RateLimitPartition.GetFixedWindowLimiter(ClientKey(ctx), _ => new FixedWindowRateLimiterOptions
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
// Which club a message is from. One source for a fact that had four.
builder.Services.AddScoped<Crusaders.Mainframe.Api.Email.ClubIdentityResolver>();
builder.Services.AddScoped<Crusaders.Mainframe.Api.Services.MemberApprovalService.MemberNotifier>();
builder.Services.AddScoped<AccessCodeService>();
builder.Services.AddSingleton(memberCodeMasterKey);
builder.Services.AddScoped<MemberCodeService>();
builder.Services.AddScoped<MemberCodeRollout>();
// The seam P11 (players and splits) replaces: organiser-only until booking_participants exists.
builder.Services.AddScoped<IBookingPlayers, OrganiserOnlyBookingPlayers>();
builder.Services.AddScoped<IdentificationResolver>();
builder.Services.AddScoped<DeviceRegistryService>();
builder.Services.AddScoped<DeviceKeyResolver>();
builder.Services.AddScoped<TenantSecretsAccessor>();
builder.Services.AddScoped<IPaymentProvider, Crusaders.Mainframe.Api.Payments.PayFast.PayFastProvider>();
// The fan-out behind every SSE stream — the member's wallet, the admin control board and the
// IoT monitoring feed. Singleton, so subscriptions survive across requests; in-process, which
// is correct for the single backend container docker-compose.prod.yml runs and which
// DeploymentPostureTests is what stops a compose file quietly contradicting. It replaced
// BalanceBroadcaster outright: one keyed-by-(tenant, scope, subject) bus rather than a
// wallet-only fan-out keyed on a bare user id.
builder.Services.AddSingleton<Crusaders.Mainframe.Api.Services.Realtime.IRealtimeBus,
    Crusaders.Mainframe.Api.Services.Realtime.InProcessRealtimeBus>();
// SCOPED, not singleton: it holds one request's unpublished frames until that request's
// transaction commits. See RealtimeOutbox for what publishing before the commit cost.
builder.Services.AddScoped<Crusaders.Mainframe.Api.Services.Realtime.RealtimeOutbox>();
// The one writer for the IoT error log. Scoped: it takes the request's DbContext and tenant,
// and its background variant opens a scope of its own.
builder.Services.AddScoped<DeviceErrorService>();
builder.Services.AddScoped<DeviceFaultSink>();
builder.Services.AddScoped<CourtLightStateService>();
builder.Services.AddScoped<ControlBoardReader>();
builder.Services.AddSingleton<AccessTokenRevocationList>();
// Singleton, like the revocation list beside it: the cache it keeps is what makes the role
// check nearly free, and the admin-role endpoint evicts from the same instance it reads.
builder.Services.AddSingleton<LiveAdminRole>();
builder.Services.AddSingleton<SessionEpochs>();
builder.Services.AddScoped<LedgerService>();
builder.Services.AddScoped<ScheduleService>();
builder.Services.AddScoped<BookingRules>();
builder.Services.AddScoped<BookingService>();
builder.Services.AddScoped<AdminBlockService>();
// The activation service's non-decision dependencies, bundled — see ActivationPlumbing.
builder.Services.AddScoped<ActivationPlumbing>();
builder.Services.AddScoped<CourtActivationService>();
// Admins:Emails — the deployment's inherent administrators. Read ONCE, at startup, and shared:
// it is deployment configuration, it cannot change while the process runs, and parsing it per
// request would put the ignored-entry warning in the log on every sign-in. The service that
// applies it is scoped, because it writes an audit row through the request's DbContext.
builder.Services.AddSingleton(InherentAdmins.From(builder.Configuration));
builder.Services.AddScoped<InherentAdminService>();
builder.Services.AddScoped<AuthService>();
builder.Services.AddScoped<MemberApprovalService>();
// The club's undeletable admin change record. Every admin mutation in every lane writes
// through this one service; see AdminChangeRecorder for why staging and recording differ.
builder.Services.AddScoped<AdminChangeRecorder>();
// Items 5 + 13 — the per-item, never-transactional bulk cancel and bulk book.
builder.Services.AddScoped<AdminBulkBookingService>();
builder.Services.AddScoped<MemberBulkBookingService>();
// Item 14 — repeating schedules, materialised as real AdminBlock rows so the GiST
// exclusion constraint is what actually reserves the court.
builder.Services.AddScoped<BookingScheduleService>();
// One person's theme, onboarding progress and opt-ins. Scoped: it writes through the
// request's DbContext and stamps the request's tenant on a row it creates.
builder.Services.AddScoped<UserPreferencesService>();
// R20 — granting and revoking a member's admin rights. The mail every such change sends goes
// through the admin notice outbox below, staged in the same save as the change.
builder.Services.AddScoped<AdminRoleService>();

// Phase 4 — webhook engine + lights cue worker + no-show worker
builder.Services.AddSingleton<IEventBus, InMemoryEventBus>();
// Webhook delivery dials whatever URL an endpoint owner configured, so it is the one
// HttpClient in the application that must not be allowed to reach the LAN it runs on.
// The guard lives in the socket's ConnectCallback rather than in URL validation —
// see GuardedHttpClient for why a pre-flight check is not a boundary.
builder.Services.AddSingleton<Crusaders.Mainframe.Api.Security.Outbound.IOutboundAddressGuard,
                              Crusaders.Mainframe.Api.Security.Outbound.OutboundAddressGuard>();
// Two clients, differing only in whether the private-network allow-list applies.
// "webhooks" honours it, because that carve-out is what lets the API reach the lights
// controller on the club LAN. "webhooks-member" does not: a member-registered endpoint
// has no business being aimed at the club's own network, and POST /api/v1/webhooks is
// authenticated but not admin-gated. See WebhookSender.PostAsync.
builder.Services.AddGuardedHttpClient("webhooks");
builder.Services.AddGuardedHttpClient("webhooks-member", honourAllowList: false);
builder.Services.AddSingleton<WebhookSender>();
builder.Services.AddHostedService<WebhookDeliveryWorker>();
builder.Services.AddHostedService<WebhookRetryWorker>();
builder.Services.AddHostedService<LightsCueWorker>();
builder.Services.AddHostedService<NoShowWorker>();

// §6a / §9 — notices a court box that has stopped heart-beating, alerts the club's admins and
// emits peripheral.unhealthy / peripheral.recovered. The outage rows it writes are also what
// lets the no-show sweep waive a penalty nobody could have avoided.
builder.Services.AddHostedService<PeripheralHealthWorker>();

// Phase 8.8 — retention worker (nightly anonymisation of records older than retention_years)
builder.Services.AddHostedService<Crusaders.Mainframe.Api.Workers.RetentionWorker>();
// Tops each club's schedule horizon up. The create and edit paths materialise
// synchronously as well, so an admin sees their own click land.
builder.Services.AddHostedService<Crusaders.Mainframe.Api.Workers.ScheduleMaterialisationWorker>();

// R23 — the admin notice outbox. Rows are staged in the same save as the event that raises
// them; the dispatcher delivers them to every active, confirmed admin who has not opted out,
// and the sweep raises the notices that are observations rather than writes. Singletons the
// worker drives, so a test can drive them too at a stated instant.
builder.Services.AddSingleton<AdminNotificationDispatcher>();
builder.Services.AddSingleton<AdminNotificationSweep>();
builder.Services.AddHostedService<Crusaders.Mainframe.Api.Workers.AdminNotificationWorker>();

// Phase 5 — biometric abstraction
builder.Services.AddSingleton<IBiometricDevice, NullBiometricDevice>();

// IRelayClient is deliberately NOT registered. The court box is pull-only — it decides
// scans against its cached roster and drives its own relays — so nothing in the container
// resolves a relay client, and a registration with no injection site is a claim that the
// API actuates lights when it does not (original review A2-16). The interface and its null
// driver stay: they hold the shape any future API-driven actuation must take, which is why
// LightsCueTests pins that every overload carries a duration.
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

builder.Services.AddHttpContextAccessor();

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

// ---- First-run bootstrap ----
//
// Runs in EVERY environment, gated on Bootstrap:Enabled rather than on the environment name.
// That distinction is the whole point: the Seeder below is dev-only, so a production stack came
// up against an empty database with no tenant row and answered 404 tenant_not_found to every
// request — no register, no sign-in, no product. See ProductionBootstrap for why it is a separate
// type rather than the seeder with the environment check taken off.
//
// Deliberately NOT wrapped in try/catch. A bootstrap that cannot do its job leaves the API in
// exactly the unusable state it exists to prevent, and a warning in a Portainer log nobody is
// reading is how that goes unnoticed for a week. Failing here stops the container instead.
{
    var logger = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Bootstrap");
    await ProductionBootstrap.RunAsync(app.Services, builder.Configuration, logger);
}

// ---- Inherent administrators ----
//
// Says what this deployment is configured to hold, and — the part worth a line in a container
// log — what it threw away doing it. A typo in Admins__Emails__1 is otherwise silent: the
// address never matches anybody, and nothing ever says so.
app.Services.GetRequiredService<InherentAdmins>()
    .Report(app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Admins"));

// Bring back the sign-outs that are still inside their token's lifetime.
//
// The revocation list is in-process, so without this a restart — a redeploy, a crash — would
// resurrect every credential a member had signed out, for the remainder of its fifteen minutes.
// Cheap: the table only ever holds sign-outs from the last quarter of an hour.
try
{
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
    var revocations = app.Services.GetRequiredService<AccessTokenRevocationList>();
    var now = DateTimeOffset.UtcNow;
    var live = await db.AuthTokens.IgnoreQueryFilters()
        .Where(t => t.Kind == Crusaders.Mainframe.Api.Domain.TokenKind.RevokedAccess && t.ExpiresAt > now)
        .Select(t => new { t.TokenHash, t.ExpiresAt })
        .ToListAsync();
    foreach (var row in live) revocations.SeedHashed(row.TokenHash, row.ExpiresAt);
}
catch (Exception ex)
{
    // A database that is not there yet is a startup-ordering problem, not a reason to refuse to
    // boot; the list simply starts empty and re-fills from the next sign-out.
    app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Revocations")
        .LogWarning(ex, "Could not rehydrate the access-token revocation list");
}

if (app.Environment.IsDevelopment())
{
    var logger = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Seed");
    try { await Seeder.SeedAsync(app.Services, logger); }
    catch (Exception ex) { logger.LogError(ex, "Seed failed (non-fatal in dev)"); }
}

// First of all, ahead even of the forwarded-headers rewrite: a static file, a 404 and an
// unhandled 500 have to carry the framing refusal too. See SecurityHeaders for what was
// reachable without it.
app.UseSecurityHeaders();

app.UseForwardedHeaders();

// Trusting a proxy network is only safe while nothing else can reach Kestrel directly, and
// the on-prem overlay puts the backend on host networking where that stops being true by
// default. Said out loud at boot rather than left to an audit: an over-broad range, an entry
// that is not an address at all, and — the combination behind review finding 15 — a trusted
// network that contains this host's own address while the server is bound to every interface.
// Skipped in Development, where the bind is a laptop and the overlap is noise.
foreach (var warning in GatewayTrust.Warnings(
             trustedProxies,
             [builder.Configuration["Urls"] ?? "", builder.Configuration["ASPNETCORE_URLS"] ?? ""],
             GatewayTrust.HostAddresses(),
             auditBinding: !app.Environment.IsDevelopment()))
{
    app.Logger.LogWarning("Gateway trust: {Warning}", warning);
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

// Authentication before the limiter, so the auth policy can partition by member — see
// the rate-limiting section above for why that is cheap. The forwarded-headers rewrite
// comes first of all: every later decision about "who is calling" reads what it wrote.
app.UseAuthentication();
app.UseRateLimiter();
app.UseMiddleware<TenantResolutionMiddleware>();
app.UseAuthorization();

// After authorization, so it is the last word: a session holding an admin-issued temporary
// password reaches nothing but the call that replaces it. See PasswordChangeGate for why the
// enforcement cannot live in the browser.
app.UseMiddleware<PasswordChangeGate>();

// ---- Anonymous endpoints ----
app.MapGet("/healthz", () => Results.Ok(new { status = "ok", service = "crusaders.mainframe", time = DateTimeOffset.UtcNow }))
   .AllowAnonymous();

// The session-bootstrap probe. `must_change_password` is here and not only on the login response
// because the browser reloads: without it a member who refreshes mid-forced-change renders the app
// and then meets PasswordChangeGate's 403 on every screen instead of the one screen they need.
app.MapGet("/api/v1/whoami", async (HttpContext ctx, ITenantContext tenant, MainframeDbContext db) =>
{
    var userId = ctx.User.Id();
    var mustChangePassword = userId is { } id
        && await db.Users.IgnoreQueryFilters().Where(u => u.Id == id).Select(u => u.MustChangePassword).FirstOrDefaultAsync(ctx.RequestAborted);
    return Results.Ok(new
    {
        tenant_slug = tenant.TenantSlug,
        tenant_id = tenant.TenantId,
        user_id = userId,
        is_authenticated = ctx.User.Identity?.IsAuthenticated ?? false,
        is_admin = ctx.User.IsInRole("admin"),
        must_change_password = mustChangePassword,
    });
}).AllowAnonymous();

// ---- Mounted endpoint groups ----
app.MapAuthEndpoints();
app.MapAdminMemberEndpoints();
app.MapAdminRoleEndpoints();
app.MapWalletEndpoints();
app.MapScheduleEndpoints();
app.MapMemberGroupEndpoints();
app.MapBookingEndpoints();
app.MapMemberBulkBookingEndpoints();
app.MapAdminConfigEndpoints();
app.MapAdminDeviceEndpoints();
app.MapAdminDoorEndpoints();
app.MapAdminLedgerEndpoints();
app.MapAdminChangeEndpoints();
app.MapAdminNotificationEndpoints();
app.MapAdminMemberTraceEndpoints();
app.MapAdminMemberDetailEndpoints();
app.MapAdminMemberGroupsEndpoint();
app.MapAdminMemberDoorEndpoints();
app.MapAdminBulkBookingEndpoints();
app.MapAdminScheduleEndpoints();
app.MapMeProfileEndpoints();
app.MapMeCodeEndpoints();
app.MapMePreferencesEndpoints();
app.MapMeDoorEndpoints();
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
app.MapAdminControlBoardEndpoints();
app.MapAdminMonitoringEndpoints();

app.Run();

public partial class Program { }
