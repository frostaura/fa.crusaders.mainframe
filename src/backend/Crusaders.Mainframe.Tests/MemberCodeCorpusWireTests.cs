using System.Text;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The wire half of the <c>membercode/</c> corpus: roster elements, code-sync elements, the court
/// box's and the door's HTTP bodies. See <see cref="MemberCodeCorpusTests"/> for the primitives.
/// </summary>
public partial class MemberCodeCorpusTests
{
    // ---- roster.json ----------------------------------------------------------------------------

    [Fact]
    public void Roster_elements_are_what_the_server_formats_and_refuses()
    {
        var doc = Load("roster.json");
        Assert.Equal(MemberCodeWire.RosterMarker.ToString(), Str(doc, "marker"));

        var executed = 0;
        foreach (var c in Cases(doc, "elements"))
        {
            var element = Str(c, "element");
            var id = Str(c, "id");
            var token = element.Split('|')[0];
            var isV1 = token.Length > 0 && token[0] == MemberCodeWire.RosterMarker;

            if (c.GetProperty("ok").GetBoolean() && c.GetProperty("refs").ValueKind == JsonValueKind.Array)
            {
                var refs = c.GetProperty("refs").EnumerateArray().Select(r => r.GetString()!).ToList();
                Assert.True(MemberCodeWire.IsRefList(token), $"'{id}' is a REF list");
                Assert.Equal(refs, MemberCodeWire.RefsOf(token));

                // The server's own formatter produces the element byte for byte.
                var fields = element.Split('|');
                var now = DateTimeOffset.FromUnixTimeSeconds(1_790_179_217);
                Assert.Equal(element, DeviceRosterBuilder.Entry(
                    MemberCodeWire.RosterToken(refs), int.Parse(fields[1]),
                    now.AddSeconds(long.Parse(fields[2])), now.AddSeconds(long.Parse(fields[3])), now));
            }
            else if (c.GetProperty("ok").GetBoolean())
            {
                // A legacy token (a capital M is not the marker): not a REF list, and nothing the
                // server's REF formatter could ever produce.
                Assert.False(MemberCodeWire.IsRefList(token), $"'{id}' must not read as a REF list");
            }
            else
            {
                Assert.True(isV1, $"'{id}': every refused element in this file begins with the marker");
                Assert.False(MemberCodeWire.IsRefList(token), $"'{id}' must be refused");
            }
            executed++;
        }
        Assert.Equal(Declared("roster.json", "elements"), executed);

        var decided = 0;
        foreach (var c in Cases(doc, "decide"))
        {
            var roster = c.GetProperty("roster").EnumerateArray().Select(e => e.GetString()!).ToList();
            var (verdict, court, grant) = DeviceModel.Decide(
                roster, c.GetProperty("accepted_at_ms").GetInt64(), c.GetProperty("max_age_ms").GetInt64(),
                c.GetProperty("courts").GetInt32(), c.GetProperty("at_ms").GetInt64(),
                c.TryGetProperty("ref", out var r) ? r.GetString() : null,
                c.TryGetProperty("token", out var t) ? t.GetString() : null);

            var id = Str(c, "id");
            Assert.True(Str(c, "verdict") == verdict, $"decide '{id}': expected {Str(c, "verdict")}, got {verdict}");
            if (c.TryGetProperty("court", out var cc)) Assert.Equal(cc.GetInt32(), court);
            if (c.TryGetProperty("grant_ms", out var g)) Assert.Equal(g.GetInt64(), grant);
            decided++;
        }
        Assert.Equal(Declared("roster.json", "decide"), decided);
    }

    // ---- codesync.json -------------------------------------------------------------------------

    [Fact]
    public void Code_sync_elements_and_bodies_match_every_vector()
    {
        var doc = Load("codesync.json");
        Assert.Equal(MemberCodeWire.KeyElementLength, doc.GetProperty("key_len").GetInt32());

        var keys = 0;
        foreach (var c in Cases(doc, "key_elements"))
        {
            var element = Str(c, "element");
            var parsed = MemberCodeWire.ParseKeyElement(element);
            if (c.GetProperty("ok").GetBoolean())
            {
                Assert.NotNull(parsed);
                Assert.Equal(Str(c, "ref"), parsed!.Value.Ref);
                Assert.Equal(c.GetProperty("slot").GetInt32(), parsed.Value.Slot);
                Assert.Equal(Str(c, "key_hex"), Convert.ToHexStringLower(parsed.Value.Key));
                Assert.Equal(element, MemberCodeWire.KeyElement(parsed.Value.Ref, parsed.Value.Slot, parsed.Value.Key));
            }
            else
            {
                Assert.True(parsed is null, $"key '{Str(c, "id")}' must be refused");
            }
            keys++;
        }
        Assert.Equal(Declared("codesync.json", "key_elements"), keys);

        var days = 0;
        foreach (var c in Cases(doc, "day_elements"))
        {
            var parsed = MemberCodeWire.ParseDayElement(Str(c, "element"));
            if (c.GetProperty("ok").GetBoolean())
            {
                Assert.NotNull(parsed);
                Assert.Equal(c.GetProperty("first_step").GetInt64(), parsed!.Value.First);
                Assert.Equal(c.GetProperty("end_step").GetInt64(), parsed.Value.End);
            }
            else
            {
                Assert.True(parsed is null, $"day '{Str(c, "id")}' must be refused");
            }
            days++;
        }
        Assert.Equal(Declared("codesync.json", "day_elements"), days);

        var applied = 0;
        foreach (var c in Cases(doc, "apply"))
        {
            var sync = DeviceModel.Apply(Hex(c, "body_hex"), c.GetProperty("received_at_ms").GetInt64(), c.GetProperty("key_capacity").GetInt32());
            var expect = c.GetProperty("expect");
            var id = Str(c, "id");

            var clock = expect.GetProperty("clock");
            Assert.True(clock.GetProperty("synced").GetBoolean() == sync.Synced, $"apply '{id}' clock");
            if (sync.Synced)
            {
                Assert.Equal(clock.GetProperty("step").GetInt64(), sync.Step);
                Assert.Equal(clock.GetProperty("step_ms").GetInt64(), sync.StepMs);
            }

            var k = expect.GetProperty("keys");
            Assert.True(k.GetProperty("replaced").GetBoolean() == sync.Replaced, $"apply '{id}' replaced");
            if (sync.Replaced)
            {
                Assert.Equal(k.GetProperty("accepted").GetInt32(), sync.Keys.Count);
                Assert.Equal(k.GetProperty("rejected").GetInt32(), sync.Rejected);
                Assert.Equal(k.GetProperty("dropped").GetInt32(), sync.Dropped);
                Assert.Equal(
                    k.GetProperty("entries").EnumerateArray().Select(e => $"{Str(e, "ref")}/{e.GetProperty("slot").GetInt32()}/{Str(e, "key_hex")}"),
                    sync.Keys.Select(e => $"{e.Ref}/{e.Slot}/{Convert.ToHexStringLower(e.Key)}"));
                Assert.Equal(
                    k.GetProperty("days").EnumerateArray().Select(d => d.ValueKind == JsonValueKind.Null ? "-" : $"{d.GetProperty("first_step").GetInt64()}|{d.GetProperty("end_step").GetInt64()}"),
                    sync.Days.Select(d => d is { } x ? $"{x.First}|{x.End}" : "-"));
            }
            applied++;
        }
        Assert.Equal(Declared("codesync.json", "apply"), applied);
    }

    // ---- http.json (court box) ------------------------------------------------------------------

    [Fact]
    public void Court_box_bodies_are_what_the_server_binds_and_serialises()
    {
        var doc = Load("http.json");
        var web = new JsonSerializerOptions(JsonSerializerDefaults.Web);

        var requests = 0;
        foreach (var c in Cases(doc, "requests"))
        {
            var body = Hex(c, "body_hex");
            var render = c.GetProperty("render");
            switch (Str(c, "path_and_query"))
            {
                case "/api/v1/device/heartbeat":
                    var hb = JsonSerializer.Deserialize<HeartbeatRequest>(body, web)!;
                    Assert.Equal(MemberCodeWire.Capability, Assert.Single(hb.Caps!));
                    break;
                case "/api/v1/device/activate":
                    var act = JsonSerializer.Deserialize<DeviceActivateRequest>(body, web)!;
                    Assert.Equal(Str(render, "token"), act.Token);
                    Assert.Equal(render.GetProperty("scan_age_ms").GetInt64(), act.ScanAgeMs);
                    Assert.NotNull(MemberCodeMath.Parse(act.Token));
                    break;
                case "/api/v1/device/walkup":
                    var wu = JsonSerializer.Deserialize<WalkUpRequest>(body, web)!;
                    Assert.Equal(render.GetProperty("scan_age_ms").GetInt64(), wu.ScanAgeMs);
                    Assert.Equal(render.GetProperty("court").GetInt32(), wu.Court);
                    break;
                case "/api/v1/device/pay-for":
                    var pf = JsonSerializer.Deserialize<PayForRequest>(body, web)!;
                    Assert.Equal(Str(render, "token"), pf.Token);
                    Assert.Equal(render.GetProperty("court").GetInt32(), pf.Court);
                    Assert.Equal(Str(render, "nonce"), pf.Nonce);
                    Assert.Equal(render.GetProperty("confirm").GetBoolean(), pf.Confirm);
                    Assert.Equal(render.TryGetProperty("amount_label", out var l) ? l.GetString() : null, pf.AmountLabel);
                    Assert.Equal(render.TryGetProperty("scan_age_ms", out var a) ? a.GetInt64() : null, pf.ScanAgeMs);
                    break;
                case "/api/v1/device/events":
                    var ev = JsonSerializer.Deserialize<DeviceEventBatch>(body, web)!;
                    Assert.True(MemberCodeMath.IsV1Shaped(Assert.Single(ev.Events!).Subject));
                    break;
                default:
                    Assert.Fail($"request '{Str(c, "id")}' names a path this suite does not know");
                    break;
            }
            requests++;
        }
        Assert.Equal(Declared("http.json", "requests"), requests);

        var responses = 0;
        foreach (var c in Cases(doc, "responses"))
        {
            var text = Encoding.UTF8.GetString(Hex(c, "body_hex"));
            var id = Str(c, "id");
            switch (Str(c, "kind"))
            {
                case "heartbeat":
                    AssertCodeTail(text, id, MemberCodeWire.CourtBoxMaxBytes);
                    break;
                case "activate":
                    // Review round 8 (D8-1): the vectors name which refusals arm the box's buttons;
                    // each is one the server really sends, in the server's own bytes. The unknown
                    // reason is the one the server never sends — it pins the box failing closed.
                    var act = JsonSerializer.Deserialize<DeviceActivateResponse>(text)!;
                    if (id != "activate-response-unknown-reason") Assert.Contains(act.Reason, ActivateRefusals);
                    Assert.Equal(text, JsonSerializer.Serialize(act));
                    break;
                case "walkup":
                    Assert.Equal(text, JsonSerializer.Serialize(new { error = MemberCodeIdentity.CodeUsed }));
                    break;
                case "payfor_quote":
                    Assert.Equal(text, JsonSerializer.Serialize(JsonSerializer.Deserialize<PayForQuoteResponse>(text)));
                    AssertLabelRule(text, id, c.GetProperty("expect"));
                    break;
                case "payfor_confirm":
                    Assert.Equal(text, JsonSerializer.Serialize(JsonSerializer.Deserialize<PayForConfirmResponse>(text)));
                    AssertLabelRule(text, id, c.GetProperty("expect"));
                    break;
                default:
                    Assert.Fail($"response '{id}' has a kind this suite does not know");
                    break;
            }
            responses++;
        }
        Assert.Equal(Declared("http.json", "responses"), responses);
    }

    // ---- payfor.json (server only) --------------------------------------------------------------

    /// <summary>
    /// D10 pay-for left the court box's image in v3 (the unreachable flow, removed from the last
    /// Mega flash), so its bodies moved out of <c>http.json</c> — which the firmware reads — into
    /// <c>payfor.json</c>, read by this suite alone. The server still speaks the route, and every
    /// body it binds or writes is pinned here exactly as before.
    /// </summary>
    [Fact]
    public void Pay_for_bodies_are_what_the_server_binds_and_serialises()
    {
        var doc = Load("payfor.json");
        var web = new JsonSerializerOptions(JsonSerializerDefaults.Web);

        var requests = 0;
        foreach (var c in Cases(doc, "requests"))
        {
            Assert.Equal("/api/v1/device/pay-for", Str(c, "path_and_query"));
            var render = c.GetProperty("render");
            var pf = JsonSerializer.Deserialize<PayForRequest>(Hex(c, "body_hex"), web)!;
            Assert.Equal(Str(render, "token"), pf.Token);
            Assert.Equal(render.GetProperty("court").GetInt32(), pf.Court);
            Assert.Equal(Str(render, "nonce"), pf.Nonce);
            Assert.Equal(render.GetProperty("confirm").GetBoolean(), pf.Confirm);
            Assert.Equal(render.TryGetProperty("amount_label", out var l) ? l.GetString() : null, pf.AmountLabel);
            Assert.Equal(render.TryGetProperty("scan_age_ms", out var a) ? a.GetInt64() : null, pf.ScanAgeMs);
            requests++;
        }
        Assert.Equal(Declared("payfor.json", "requests"), requests);

        var responses = 0;
        foreach (var c in Cases(doc, "responses"))
        {
            var text = Encoding.UTF8.GetString(Hex(c, "body_hex"));
            var id = Str(c, "id");
            switch (Str(c, "kind"))
            {
                case "payfor_quote":
                    Assert.Equal(text, JsonSerializer.Serialize(JsonSerializer.Deserialize<PayForQuoteResponse>(text)));
                    AssertLabelRule(text, id, c.GetProperty("expect"));
                    break;
                case "payfor_confirm":
                    Assert.Equal(text, JsonSerializer.Serialize(JsonSerializer.Deserialize<PayForConfirmResponse>(text)));
                    AssertLabelRule(text, id, c.GetProperty("expect"));
                    break;
                default:
                    Assert.Fail($"pay-for response '{id}' has a kind this suite does not know");
                    break;
            }
            responses++;
        }
        Assert.Equal(Declared("payfor.json", "responses"), responses);
    }

    /// <summary>The activation refusals the member-code corpus pins the box's reading of.</summary>
    private static readonly string[] ActivateRefusals =
        [MemberCodeIdentity.CodeUsed, "no_booking", "wrong_court", "not_recognised"];

    /// <summary>
    /// A heartbeat vector's member-code keys are the four the server writes, in its order, after
    /// <c>roster</c>, and re-serialising them through <see cref="MemberCodeSync"/> reproduces the
    /// vector's own bytes. A budget vector is inside its contract.
    /// </summary>
    private static void AssertCodeTail(string text, string id, int maxBytes)
    {
        Assert.True(Encoding.UTF8.GetByteCount(text) <= maxBytes, $"'{id}' is over its {maxBytes}-byte budget");
        using var body = JsonDocument.Parse(text);
        var root = body.RootElement;
        if (!root.TryGetProperty("code_keys", out _))
        {
            Assert.False(root.TryGetProperty("code_step", out _), $"'{id}': no keys means no code_* at all");
            return;
        }

        var sync = new MemberCodeSync(
            root.GetProperty("code_step").GetInt64(), root.GetProperty("code_step_ms").GetInt32(),
            [.. root.GetProperty("code_days").EnumerateArray().Select(e => e.GetString()!)],
            [.. root.GetProperty("code_keys").EnumerateArray().Select(e => e.GetString()!)]);
        var tail = new Dictionary<string, object?>();
        sync.WriteTo(tail);
        var rendered = JsonSerializer.Serialize(tail);
        Assert.EndsWith("," + rendered[1..], text);

        var names = root.EnumerateObject().Select(p => p.Name).ToList();
        Assert.Equal(["roster", "code_step", "code_step_ms", "code_days", "code_keys"], names.Skip(names.IndexOf("roster")));
        Assert.All(sync.Keys, k => Assert.NotNull(MemberCodeWire.ParseKeyElement(k)));
        Assert.All(sync.Days, d => Assert.NotNull(MemberCodeWire.ParseDayElement(d)));
    }

    /// <summary>
    /// A label the server writes is its own rendering of the amount in whole minutes (P13 §3.16), and
    /// ours agrees whenever it fits; a price the glass cannot show (over four digits) is in the corpus
    /// only as a body the box must refuse, never one this server would send.
    /// </summary>
    private static void AssertLabelRule(string text, string id, JsonElement expect)
    {
        using var body = JsonDocument.Parse(text);
        if (!body.RootElement.TryGetProperty("amount_minutes", out var amount)) return;
        var label = body.RootElement.GetProperty("amount_label").GetString()!;
        Assert.True(amount.TryGetInt32(out var minutes), $"'{id}': amount {amount.GetRawText()} is not whole minutes");
        Assert.Equal(amount.GetRawText(), JsonSerializer.Serialize(minutes));
        Assert.True(DevicePayForEndpoint.Label(minutes) == label, $"'{id}': label {label}");
        if (minutes > DevicePayForEndpoint.MaxLabelMinutes)
            Assert.True(expect.GetProperty("outcome").GetString() == "walkup", $"'{id}': an unshowable label must be refused by the box");
    }

    // ---- gate.json (door) ----------------------------------------------------------------------

    [Fact]
    public void Door_bodies_and_offline_decisions_match_every_vector()
    {
        var doc = Load("gate.json");
        var web = new JsonSerializerOptions(JsonSerializerDefaults.Web);

        var requests = 0;
        foreach (var c in Cases(doc, "requests"))
        {
            var body = Hex(c, "body_hex");
            switch (Str(c, "path_and_query"))
            {
                case "/api/v1/device/heartbeat":
                    var hb = JsonSerializer.Deserialize<HeartbeatRequest>(body, web)!;
                    Assert.Equal("gate", hb.Kind);
                    Assert.Equal(MemberCodeWire.Capability, Assert.Single(hb.Caps!));
                    break;
                case "/api/v1/device/gate":
                    var scan = JsonSerializer.Deserialize<GateScanRequest>(body, web)!;
                    Assert.NotNull(MemberCodeMath.Parse(scan.Token));
                    break;
                case "/api/v1/device/events":
                    var ev = JsonSerializer.Deserialize<DeviceEventBatch>(body, web)!;
                    var e = Assert.Single(ev.Events!);
                    Assert.Equal("gate_open", e.Kind);
                    Assert.True(MemberCodeMath.IsV1Shaped(e.Subject));
                    break;
                default:
                    Assert.Fail($"request '{Str(c, "id")}' names a path this suite does not know");
                    break;
            }
            requests++;
        }
        Assert.Equal(Declared("gate.json", "requests"), requests);

        var responses = 0;
        foreach (var c in Cases(doc, "responses"))
        {
            AssertCodeTail(Encoding.UTF8.GetString(Hex(c, "body_hex")), Str(c, "id"), MemberCodeWire.GateMaxBytes);
            responses++;
        }
        Assert.Equal(Declared("gate.json", "responses"), responses);

        var offline = 0;
        foreach (var c in Cases(doc, "offline"))
        {
            var door = DeviceModel.Door(Hex(c, "heartbeat_body_hex"), c.GetProperty("received_at_ms").GetInt64());
            foreach (var scan in c.GetProperty("scans").EnumerateArray())
            {
                var (released, reason) = door.Scan(Str(scan, "token"), scan.GetProperty("at_ms").GetInt64());
                Assert.True(Str(scan, "reason") == reason, $"offline '{Str(c, "id")}' {Str(scan, "token")}: expected {Str(scan, "reason")}, got {reason}");
                Assert.Equal(scan.GetProperty("released").GetBoolean(), released);
            }
            offline++;
        }
        Assert.Equal(Declared("gate.json", "offline"), offline);
    }

    // ---- The server's own bodies at the widest the contract allows -----------------------------

    /// <summary>
    /// The REAL court-box view — sixteen four-player entries at six-digit seconds, twenty-four keys
    /// over two days, a 64-character slug, four restores and every LCD setting at its widest — is
    /// inside 2048 bytes, and Fit never has to shed a key to get there.
    /// </summary>
    [Fact]
    public void The_widest_court_box_heartbeat_the_server_can_write_fits_its_contract()
    {
        var device = new Device
        {
            DeviceCode = "box-" + new string('c', 12),
            Name = "x",
            MacAddress = "5ccf7f0a1b2c",
            CourtNumbers = [1, 2, 3, 4],
        };
        var s = WidestSettings();
        var roster = Enumerable.Range(0, 16)
            .Select(i => $"m{Ref(i * 4)}{Ref((i * 4) + 1)}{Ref((i * 4) + 2)}{Ref((i * 4) + 3)}|{i % 4}|-864000|999999")
            .ToList();
        var relays = Enumerable.Range(0, 4).Select(i => $"{i}|5400|3fa85f64").ToList();
        var sync = WidestSync(MemberCodeWire.CourtBoxKeyCap);

        var body = MemberCodeHeartbeat.Fit(
            codes => DeviceEndpoints.CourtBoxView(device, new string('w', 64), s, new CourtBoxLists(roster, relays, codes), DateTimeOffset.UtcNow),
            sync, MemberCodeWire.CourtBoxMaxBytes);

        var bytes = JsonSerializer.SerializeToUtf8Bytes(body).Length;
        Assert.True(bytes <= MemberCodeWire.CourtBoxMaxBytes, $"widest court box body is {bytes} bytes");
        Assert.Equal(MemberCodeWire.CourtBoxKeyCap, ((IReadOnlyList<string>)body["code_keys"]!).Count);
    }

    [Fact]
    public void The_widest_door_heartbeat_the_server_can_write_fits_its_contract()
    {
        var device = new Device
        {
            DeviceCode = "gate-" + new string('c', 12),
            Name = "x",
            MacAddress = "5ccf7f0a1b2c",
            Kind = DeviceKind.Gate,
            GateKey = new string('g', 64),
        };
        var roster = Enumerable.Range(0, 48)
            .Select(i => $"m{Ref(i * 4)}{Ref((i * 4) + 1)}{Ref((i * 4) + 2)}{Ref((i * 4) + 3)}|0|-864000|999999")
            .ToList();
        var sync = WidestSync(MemberCodeWire.GateKeyCap);

        var body = MemberCodeHeartbeat.Fit(
            codes => GateHeartbeatView.WithCodes(device, new string('w', 64), new GateTiming(300, 30), roster, DateTimeOffset.UtcNow, codes),
            sync, MemberCodeWire.GateMaxBytes);

        var bytes = JsonSerializer.SerializeToUtf8Bytes(body).Length;
        Assert.True(bytes <= MemberCodeWire.GateMaxBytes, $"widest door body is {bytes} bytes");
        Assert.Equal(MemberCodeWire.GateKeyCap, ((IReadOnlyList<string>)body["code_keys"]!).Count);
    }

    /// <summary>A body pushed past its contract sheds keys, last first, until it fits — and only keys.</summary>
    [Fact]
    public void A_body_over_its_budget_drops_keys_from_the_end()
    {
        var sync = WidestSync(10);
        var body = MemberCodeHeartbeat.Fit(
            codes =>
            {
                var d = new Dictionary<string, object?> { ["pad"] = new string('x', 100) };
                codes?.WriteTo(d);
                return d;
            },
            sync, 300);

        var keys = (IReadOnlyList<string>)body["code_keys"]!;
        Assert.True(JsonSerializer.SerializeToUtf8Bytes(body).Length <= 300);
        Assert.InRange(keys.Count, 1, 9);
        Assert.Equal(sync.Keys.Take(keys.Count), keys);
    }

    private static string Ref(int i) => MemberCodeMath.RefText(0x40000 + i);

    private static MemberCodeSync WidestSync(int keys) => new(
        4_294_967_295L / 2, 29_999, ["4294960000|4294963120", "4294963120|4294966240"],
        [.. Enumerable.Range(0, keys).Select(i => MemberCodeWire.KeyElement(Ref(i), i % 2, new byte[12]))]);

    private static TenantSettingsView WidestSettings() => new(
        240, 30, 60, 15, 14, "Africa/Johannesburg", 60, "16:00-19:00", 1, 2, 0, 1440, 7,
        ButtonMap.Default())
    {
        WalkUpMaxMinutes = 90,
        HeartbeatSeconds = 300,
        LcdRevertSeconds = 60,
        LcdChoiceSeconds = 60,
        LcdCardSeconds = 10,
        LcdHintSeconds = 10,
        ScanMemorySeconds = 300,
        ClockTrustMinutes = 1440,
        DeviceFaultMaxPerHour = 120,
    };
}
