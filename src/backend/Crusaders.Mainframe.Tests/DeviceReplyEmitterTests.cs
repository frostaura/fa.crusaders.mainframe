using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The server's REAL device replies (device-api.md §11.3, §11.5, FC-9). Drives the real endpoints
/// through the scenario matrix of §11.5 and holds every reply to what a frozen reader lives by:
/// status 200 exactly for every success (FC-4); compact ASCII with no BOM, no newline, no
/// duplicate key and nesting at most three (FC-13); every number an integer and every flag a bool
/// (FC-11); element arity — roster 4, courts 5, relays 3, code_days 2, code_keys 21 characters
/// (FC-1); <c>button_map</c> only inside <c>config</c> (FC-7); the <c>gate</c> object scalars only
/// (FC-12); the events reply exactly its two keys (FC-5); and each body inside its
/// <c>compat/</c> budget (FC-3, FC-5, FC-6).
///
/// <para>
/// When <c>DEVICE_REPLAY_DIR</c> is set it also writes each reply as
/// <c>&lt;endpoint&gt;/&lt;scenario&gt;.json</c> (<c>{device, caps, endpoint, status, body_hex,
/// expect}</c>) and an <c>index.json</c> (<c>{count, files}</c>), which the firmware suites'
/// <c>test_server_replies</c> feed through the boards' own parsers (<c>make device-replay-check</c>).
/// Without it, the same scenarios run and every assertion above still holds.
/// </para>
/// </summary>
public sealed class DeviceReplyEmitterTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string ReplayDirVariable = "DEVICE_REPLAY_DIR";

    private static readonly string[] V3Caps = ["codes:m1", "hb:3", "ota:1", "key:1", "net:1", "lcd:2"];
    private static readonly string[] GateV3Caps = ["codes:m1", "ota:1", "key:1", "net:1"];
    private static readonly RSA Signer = RSA.Create(2048);

    private sealed record Reply(string Scenario, string Device, string[] Caps, string Endpoint, int Status, byte[] Body, JsonObject Expect);

    [SkippableFact]
    public async Task Every_scenario_reply_is_one_a_frozen_reader_can_live_by()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var app = MemberCodeClub.Wired(pg.SharedHost, new StubEmailService()).WithWebHostBuilder(b =>
            b.UseSetting("DeviceOta:PublicKeyModulus", Convert.ToHexStringLower(Signer.ExportParameters(false).Modulus!)));
        var replies = new List<Reply>();
        await HeartbeatScenariosAsync(app, replies);
        await ScanScenariosAsync(app, replies);

        foreach (var r in replies) AssertFrozenReaderRules(r);
        Assert.True(replies.Count >= 20, $"only {replies.Count} scenarios ran");
        Assert.Contains(replies, r => r.Endpoint == "heartbeat" && r.Device == "door_gate");
        Assert.Contains(replies, r => r.Expect.ContainsKey("ota"));

        if (Environment.GetEnvironmentVariable(ReplayDirVariable) is { Length: > 0 } dir) Write(dir, replies);
    }

    // ---- The scenario matrix (§11.5) -------------------------------------------------------------

    private static async Task HeartbeatScenariosAsync(WebApplicationFactory<Program> app, List<Reply> replies)
    {
        var club = await MemberCodeClub.SeedAsync(app, "replayhb", MemberCodeClub.SettingsAtNoon());
        var device = app.CreateClient();
        var admin = club.Member(app, club.AdminId, "admin");

        // Empty roster, every caps combination a 2.x and a v3 board send.
        await BeatAsync(device, club, replies, "box-2x-empty", club.BoxMac, []);
        await BeatAsync(device, club, replies, "box-2x-codes-empty", club.BoxMac, ["codes:m1"]);
        await BeatAsync(device, club, replies, "box-v3-empty", club.BoxMac, V3Caps);
        await BeatAsync(device, club, replies, "gate-1x-empty", club.DoorMac, [], kind: "gate");
        await BeatAsync(device, club, replies, "gate-1x-codes-empty", club.DoorMac, ["codes:m1"], kind: "gate");
        await BeatAsync(device, club, replies, "gate-v3-empty", club.DoorMac, GateV3Caps, kind: "gate");

        // A fresh, unacknowledged box.
        var fresh = Guid.NewGuid().ToString("N")[..12];
        await BeatAsync(device, club, replies, "box-v3-fresh", fresh, V3Caps);

        // A snapshot with a chained extension, and a full roster.
        var now = DateTimeOffset.UtcNow;
        var run = await club.BookAsync(app, club.Olga, courtIndex: 1, startsInMinutes: -10, minutes: 60, checkedIn: true);
        await club.WriteAsync(app, db =>
        {
            db.Bookings.Add(new Booking
            {
                TenantId = club.TenantId, CourtId = club.Courts[1], UserId = club.Pam, BookedByUserId = club.Pam, PaidByUserId = club.Pam,
                ActorUserId = club.Pam, StartsAt = run.EndsAt, EndsAt = run.EndsAt.AddMinutes(30), SliceMinutes = 15, SliceCount = 2,
                AmountChargedMinutes = 30, Status = BookingStatus.Booked, ChargedAt = now, CheckedInAt = now.Storable(),
            });
            return Task.CompletedTask;
        });
        for (var i = 0; i < 14; i++) await club.BookAsync(app, i % 2 == 0 ? club.Olga : club.Pam, courtIndex: i % 4, startsInMinutes: 70 + (i * 60), minutes: 30);
        await BeatAsync(device, club, replies, "box-v3-chain-full", club.BoxMac, V3Caps);
        await BeatAsync(device, club, replies, "box-2x-codes-full", club.BoxMac, ["codes:m1"], uptimeMs: 30_000);
        await BeatAsync(device, club, replies, "gate-v3-full", club.DoorMac, GateV3Caps, kind: "gate");

        // The lifeline: an OTA offer, a key rotation, a network change.
        var image = RandomNumberGenerator.GetBytes(2048);
        var sha = Convert.ToHexStringLower(SHA256.HashData(image));
        var sig = Convert.ToBase64String(Signer.SignData(Encoding.ASCII.GetBytes(DeviceOta.ManifestText("court_bridge", "3.0.1", image.Length, sha)),
            HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var upload = new MultipartFormDataContent
        {
            { new ByteArrayContent(image), "image", "image.bin" },
            { new StringContent(new JsonObject { ["target"] = "court_bridge", ["version"] = "3.0.1", ["size"] = image.Length, ["sha256"] = sha, ["sig"] = sig }.ToJsonString()), "manifest" },
        };
        var release = JsonDocument.Parse(await (await admin.PostAsync("/api/v1/admin/devices/firmware", upload)).Content.ReadAsStringAsync()).RootElement;
        await admin.PatchAsync($"/api/v1/admin/devices/firmware/{release.GetProperty("id").GetGuid()}", JsonContent.Create(new { rollout = "all" }));
        await BeatAsync(device, club, replies, "box-v3-ota", club.BoxMac, V3Caps);

        await admin.PostAsync("/api/v1/admin/devices/api-key/rotate", null);
        await BeatAsync(device, club, replies, "box-v3-key-next", club.BoxMac, V3Caps);
        await BeatAsync(device, club, replies, "gate-v3-key-next", club.DoorMac, GateV3Caps, kind: "gate");

        await admin.PutAsJsonAsync("/api/v1/admin/devices/network",
            new { @base = "http://192.168.1.20:8088", wifi = new[] { new { ssid = "CRUSADERS", psk = "squash-court-4" }, new { ssid = "CRUSADERS-NEW", psk = "new-router-pass" } } });
        await BeatAsync(device, club, replies, "box-v3-net", club.BoxMac, V3Caps);
        await BeatAsync(device, club, replies, "gate-v3-net", club.DoorMac, GateV3Caps, kind: "gate");
    }

    private static async Task ScanScenariosAsync(WebApplicationFactory<Program> app, List<Reply> replies)
    {
        var club = await MemberCodeClub.SeedAsync(app, "replayscan");
        var device = app.CreateClient();
        await club.BookAsync(app, club.Olga, courtIndex: 0, startsInMinutes: -5, minutes: 120);
        await club.BookAsync(app, club.Sid, courtIndex: 3, startsInMinutes: -5, minutes: 60, checkedIn: true);
        // A fourth funded member, so each scan below spends its own code's one use.
        await club.WriteAsync(app, db =>
        {
            db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = club.TenantId, UserId = club.AdminId, Type = LedgerEntryType.TopUp, AmountMinutes = 200, ActorUserId = club.AdminId, Reason = "seed",
            });
            return Task.CompletedTask;
        });

        await SendAsync(device, replies, "activate-grant", "activate", "court_box", club.Activate(club.Code(club.Olga)));
        await SendAsync(device, replies, "activate-no-booking", "activate", "court_box", club.Activate(club.Code(club.Pam)));
        await SendAsync(device, replies, "activate-not-recognised", "activate", "court_box", club.Activate("ZZZZZZZZZZZZ"));
        await SendAsync(device, replies, "walkup-grant", "walkup", "court_box", club.WalkUp(club.Code(club.AdminId), court: 3, nonce: "replay-walkup-1"));
        await SendAsync(device, replies, "walkup-refused", "walkup", "court_box", club.WalkUp("ZZZZZZZZZZZZ", court: 3, nonce: "replay-walkup-2"), expectOk: false);
        await SendAsync(device, replies, "extend-grant", "extend", "court_box", club.Device("/api/v1/device/extend", new JsonObject
        {
            ["mac"] = club.BoxMac, ["method"] = "qr", ["token"] = club.Code(club.Pam), ["court"] = 3, ["minutes"] = 15, ["nonce"] = "replay-extend-1",
        }));
        await SendAsync(device, replies, "extend-refused", "extend", "court_box", club.Device("/api/v1/device/extend", new JsonObject
        {
            ["mac"] = club.BoxMac, ["method"] = "qr", ["token"] = club.Code(club.Pam), ["court"] = 2, ["minutes"] = 15, ["nonce"] = "replay-extend-2",
        }), expectOk: false);
        await SendAsync(device, replies, "pay-for-quote", "pay-for", "court_box", club.PayFor(club.Code(club.Pam), 4, "replay-payfor-1", confirm: false));
        await SendAsync(device, replies, "events-accepted", "events", "court_box",
            club.Events(club.BoxMac, seq: 1, kind: "activation", court: 0, subject: club.Code(club.Olga, DateTimeOffset.UtcNow.AddSeconds(-1))));
        await SendAsync(device, replies, "gate-open", "gate", "door_gate", club.Gate(club.Code(club.Olga)));
        await SendAsync(device, replies, "gate-refused", "gate", "door_gate", club.Gate("ZZZZZZZZZZZZ"));
        await SendAsync(device, replies, "gate-events-accepted", "events", "door_gate",
            club.Events(club.DoorMac, seq: 1, kind: "unknown_scan", court: 0, subject: "ZZZZZZZZZZZZ"));
    }

    private static async Task BeatAsync(
        HttpClient device, MemberCodeClub club, List<Reply> replies, string scenario, string mac, string[] caps,
        string? kind = null, long uptimeMs = 86_400_000)
    {
        var body = new JsonObject { ["mac"] = mac, ["firmware_version"] = caps.Contains("hb:3") ? "3.0.0" : "2.3.0", ["uptime_ms"] = uptimeMs };
        if (kind is not null) body["kind"] = kind;
        if (caps.Length > 0) body["caps"] = new JsonArray([.. caps.Select(c => (JsonNode)c!)]);
        var response = await device.SendAsync(club.Device("/api/v1/device/heartbeat", body));
        var bytes = await response.Content.ReadAsByteArrayAsync();
        Assert.True(response.StatusCode == HttpStatusCode.OK, $"{scenario}: {(int)response.StatusCode} {Encoding.UTF8.GetString(bytes)}");
        replies.Add(new Reply(scenario, kind == "gate" ? "door_gate" : "court_box", caps, "heartbeat", (int)response.StatusCode, bytes, ExpectOf(bytes)));
    }

    private static async Task SendAsync(
        HttpClient device, List<Reply> replies, string scenario, string endpoint, string board, HttpRequestMessage request, bool expectOk = true)
    {
        var response = await device.SendAsync(request);
        var bytes = await response.Content.ReadAsByteArrayAsync();
        if (expectOk) Assert.True(response.StatusCode == HttpStatusCode.OK, $"{scenario}: {(int)response.StatusCode} {Encoding.UTF8.GetString(bytes)}");
        replies.Add(new Reply(scenario, board, [], endpoint, (int)response.StatusCode, bytes, ExpectOf(bytes)));
    }

    /// <summary>What the server knows it sent: court numbers, snapshot elements, roster and key counts, config values, lifeline ids.</summary>
    private static JsonObject ExpectOf(byte[] body)
    {
        var expect = new JsonObject();
        if (JsonNode.Parse(body) is not JsonObject root) return expect;
        foreach (var key in (string[])["court_numbers", "courts", "config", "gate", "opened", "activated", "granted_seconds", "accepted_through"])
        {
            if (root.TryGetPropertyValue(key, out var v)) expect[key] = v?.DeepClone();
        }
        if (root["roster"] is JsonArray roster) expect["roster_count"] = roster.Count;
        if (root["code_keys"] is JsonArray keys) expect["code_keys_count"] = keys.Count;
        if (root["ota"] is JsonObject ota) expect["ota"] = new JsonObject { ["version"] = ota["version"]?.DeepClone(), ["path"] = ota["path"]?.DeepClone() };
        if (root["key_next"] is JsonObject next) expect["key_next"] = new JsonObject { ["id"] = next["id"]?.DeepClone() };
        if (root["net"] is JsonObject net) expect["net"] = new JsonObject { ["ver"] = net["ver"]?.DeepClone() };
        return expect;
    }

    // ---- The rules (§11.3) ------------------------------------------------------------------------

    private static readonly string[] Flags =
        ["relay_restore_enabled", "device_fault_reporting", "lcd_marquee_enabled", "activated", "opened", "replayed", "payable", "already_active"];

    private static void AssertFrozenReaderRules(Reply r)
    {
        var id = $"{r.Endpoint}/{r.Scenario}";
        var text = Encoding.UTF8.GetString(r.Body);

        // FC-13: compact ASCII, no BOM, no newline; FC-4 for the successes.
        Assert.False(r.Body.Length >= 3 && r.Body[0] == 0xEF && r.Body[1] == 0xBB && r.Body[2] == 0xBF, $"{id}: BOM");
        Assert.All(r.Body, b => Assert.True(b is >= 0x20 and < 0x7F, $"{id}: byte 0x{b:X2} is not printable ASCII"));
        Assert.True(IsCompact(r.Body), $"{id}: not compact");
        var (depth, duplicate) = Shape(r.Body);
        Assert.True(depth <= 3, $"{id}: nesting {depth}");
        Assert.True(duplicate is null, $"{id}: duplicate key {duplicate}");

        using var doc = JsonDocument.Parse(r.Body);
        var root = doc.RootElement;
        Assert.Equal(JsonValueKind.Object, root.ValueKind);
        AssertKinds(root, id);

        Assert.True(r.Body.Length <= BudgetOf(r), $"{id}: {r.Body.Length} bytes over its {BudgetOf(r)}-byte budget");

        switch (r.Endpoint)
        {
            case "heartbeat":
                AssertHeartbeatShape(root, id);
                break;
            case "events":
                Assert.Equal(200, r.Status);
                Assert.Equal(["accepted_through", "recorded"], root.EnumerateObject().Select(p => p.Name));
                break;
        }
    }

    private static int BudgetOf(Reply r) => (r.Device, r.Endpoint) switch
    {
        ("court_box", "heartbeat") => r.Caps.Contains("hb:3") ? DeviceHeartbeatBudget.CourtBoxV3 : DeviceHeartbeatBudget.CourtBox2x,
        ("door_gate", "heartbeat") => r.Caps.Intersect(["ota:1", "key:1", "net:1"]).Any() ? DeviceHeartbeatBudget.GateV3 : DeviceHeartbeatBudget.Gate1x,
        ("door_gate", "gate") => DeviceHeartbeatBudget.GateReplyMax,
        (_, "events") => DeviceHeartbeatBudget.EventsReplyMax,
        _ => DeviceHeartbeatBudget.ScanReplyMax,
    };

    /// <summary>FC-11: every number an integer literal and every known flag a bool, everywhere in the body.</summary>
    private static void AssertKinds(JsonElement e, string id, string? name = null)
    {
        switch (e.ValueKind)
        {
            case JsonValueKind.Object:
                foreach (var p in e.EnumerateObject())
                {
                    if (Flags.Contains(p.Name)) Assert.True(p.Value.ValueKind is JsonValueKind.True or JsonValueKind.False, $"{id}: {p.Name} is not a bool");
                    AssertKinds(p.Value, id, p.Name);
                }
                break;
            case JsonValueKind.Array:
                foreach (var item in e.EnumerateArray()) AssertKinds(item, id, name);
                break;
            case JsonValueKind.Number:
                var raw = e.GetRawText();
                Assert.True(raw.All(c => char.IsAsciiDigit(c) || c == '-'), $"{id}: {name} is {raw}, not an integer literal");
                break;
        }
    }

    /// <summary>FC-1, FC-7, FC-12: element arity, button_map only inside config, the gate object scalars only.</summary>
    private static void AssertHeartbeatShape(JsonElement root, string id)
    {
        Assert.False(root.TryGetProperty("button_map", out _), $"{id}: button_map at the top level");
        foreach (var p in root.EnumerateObject().Where(p => p.Value.ValueKind == JsonValueKind.Object && p.Name != "config"))
        {
            Assert.False(p.Value.TryGetProperty("button_map", out _), $"{id}: button_map inside {p.Name}");
        }
        if (root.TryGetProperty("gate", out var gate))
        {
            Assert.All(gate.EnumerateObject(), p => Assert.True(p.Value.ValueKind is not (JsonValueKind.Object or JsonValueKind.Array), $"{id}: gate.{p.Name} is not a scalar"));
        }

        Arity(root, "roster", 4, id);
        Arity(root, "courts", 5, id);
        Arity(root, "relays", 3, id);
        Arity(root, "code_days", 2, id);
        if (root.TryGetProperty("code_keys", out var keys))
        {
            Assert.All(keys.EnumerateArray(), k => Assert.Equal(21, k.GetString()!.Length));
        }
    }

    private static void Arity(JsonElement root, string key, int fields, string id)
    {
        if (!root.TryGetProperty(key, out var array)) return;
        Assert.All(array.EnumerateArray(), e => Assert.True(e.GetString()!.Split('|').Length == fields, $"{id}: {key} element '{e.GetString()}' is not {fields} fields"));
    }

    private static bool IsCompact(byte[] body)
    {
        var inString = false;
        for (var i = 0; i < body.Length; i++)
        {
            var b = body[i];
            if (inString)
            {
                if (b == (byte)'\\') i++;
                else if (b == (byte)'"') inString = false;
                continue;
            }
            if (b == (byte)'"') inString = true;
            else if (b is (byte)' ' or (byte)'\t' or (byte)'\r' or (byte)'\n') return false;
        }
        return true;
    }

    /// <summary>The deepest nesting (body = 1) and the first duplicate key at any level, by a token walk.</summary>
    private static (int Depth, string? Duplicate) Shape(byte[] body)
    {
        var reader = new Utf8JsonReader(body);
        var scopes = new Stack<HashSet<string>?>();
        var deepest = 0;
        while (reader.Read())
        {
            switch (reader.TokenType)
            {
                case JsonTokenType.StartObject:
                    scopes.Push(new HashSet<string>(StringComparer.Ordinal));
                    deepest = Math.Max(deepest, scopes.Count);
                    break;
                case JsonTokenType.StartArray:
                    scopes.Push(null);
                    deepest = Math.Max(deepest, scopes.Count);
                    break;
                case JsonTokenType.EndObject or JsonTokenType.EndArray:
                    scopes.Pop();
                    break;
                case JsonTokenType.PropertyName:
                    var name = reader.GetString()!;
                    if (scopes.Peek() is { } keys && !keys.Add(name)) return (deepest, name);
                    break;
            }
        }
        return (deepest, null);
    }

    // ---- The replay files (§11.5) -----------------------------------------------------------------

    private static void Write(string dir, List<Reply> replies)
    {
        var files = new List<string>();
        foreach (var r in replies)
        {
            var relative = $"{r.Endpoint}/{r.Scenario}.json";
            Directory.CreateDirectory(Path.Combine(dir, r.Endpoint));
            var file = new JsonObject
            {
                ["device"] = r.Device,
                ["caps"] = new JsonArray([.. r.Caps.Select(c => (JsonNode)c!)]),
                ["endpoint"] = r.Endpoint,
                ["status"] = r.Status,
                ["body_hex"] = Convert.ToHexStringLower(r.Body),
                ["expect"] = r.Expect.DeepClone(),
            };
            File.WriteAllText(Path.Combine(dir, relative), file.ToJsonString());
            files.Add(relative);
        }
        File.WriteAllText(Path.Combine(dir, "index.json"),
            new JsonObject { ["count"] = files.Count, ["files"] = new JsonArray([.. files.Select(f => (JsonNode)f!)]) }.ToJsonString());
    }
}
