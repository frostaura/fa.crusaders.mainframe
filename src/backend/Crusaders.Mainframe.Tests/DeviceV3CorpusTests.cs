using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Device contract v3 against the corpus (<c>src/contracts/device-protocol</c>): every <c>ota/</c>
/// and <c>provision/</c> vector executed by the server's own copy of the rules (executed ==
/// declared), the <c>compat/</c> budgets naming <c>csharp</c> held equal to the server's constants,
/// and every v3 heartbeat response vector re-serialised from the REAL views, byte for byte.
///
/// <para>
/// Why the server runs the board's rules at all: an image no board would boot, a network no board
/// would adopt and a key no board would accept are refused at the console with the board's own
/// reason, rather than saved and then silently ignored by every board in the club.
/// </para>
/// </summary>
public sealed class DeviceV3CorpusTests
{
    private static string ContractRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var candidate = Path.Combine(dir.FullName, "src", "contracts", "device-protocol");
            if (Directory.Exists(candidate)) return candidate;
            dir = dir.Parent;
        }
        throw new DirectoryNotFoundException("src/contracts/device-protocol was not found above the test binary.");
    }

    private static JsonElement Load(string family, string file = "cases.json") =>
        JsonDocument.Parse(File.ReadAllText(Path.Combine(ContractRoot(), family, file))).RootElement.Clone();

    private static int Declared(string family, string section) =>
        Load(family, "manifest.json").GetProperty("case_count").GetProperty(section).GetInt32();

    private static readonly JsonElement Ota = Load("ota");
    private static readonly JsonElement Provision = Load("provision");
    private static readonly JsonElement Compat = Load("compat");
    private static readonly JsonElement Http = Load("http");
    private static readonly JsonElement Gate = Load("gate");

    private static byte[] Modulus(string key) => Convert.FromHexString(Ota.GetProperty(key).GetProperty("n_hex").GetString()!);

    // ---- ota/ ------------------------------------------------------------------------------------

    [Fact]
    public void The_ota_constants_are_the_servers()
    {
        var c = Ota.GetProperty("constants");
        Assert.Equal(DeviceOta.ManifestMagic, c.GetProperty("manifest_magic").GetString());
        Assert.Equal(DeviceOta.PathPrefix, c.GetProperty("path_prefix").GetString());
        Assert.Equal(DeviceOta.SigB64Length, c.GetProperty("sig_b64_len").GetInt32());
        foreach (var t in c.GetProperty("target_max_bytes").EnumerateObject())
        {
            Assert.Equal(t.Value.GetInt32(), DeviceOta.TargetMaxBytes[t.Name]);
        }
        Assert.Equal(c.GetProperty("target_max_bytes").EnumerateObject().Count(), DeviceOta.TargetMaxBytes.Count);
    }

    [Fact]
    public void Every_manifest_vector_is_the_text_the_server_builds_and_its_digest()
    {
        var executed = 0;
        foreach (var m in Ota.GetProperty("manifests").EnumerateArray())
        {
            var f = m.GetProperty("fields");
            var text = DeviceOta.ManifestText(
                f.GetProperty("target").GetString()!, f.GetProperty("version").GetString()!,
                f.GetProperty("size").GetInt64(), f.GetProperty("sha256").GetString()!);
            Assert.Equal(m.GetProperty("text_hex").GetString(), Convert.ToHexStringLower(Encoding.ASCII.GetBytes(text)));
            Assert.Equal(m.GetProperty("digest_hex").GetString(), Convert.ToHexStringLower(SHA256.HashData(Encoding.ASCII.GetBytes(text))));
            executed++;
        }
        Assert.Equal(Declared("ota", "manifests"), executed);
    }

    /// <summary>Every signature vector through <see cref="System.Security.Cryptography.RSA"/>, PKCS#1 v1.5, SHA-256 — the reason, not only valid/invalid.</summary>
    [Fact]
    public void Every_signature_vector_verifies_or_is_refused_with_the_boards_reason()
    {
        var executed = 0;
        foreach (var v in Ota.GetProperty("signatures").EnumerateArray())
        {
            var f = v.GetProperty("fields");
            var text = DeviceOta.ManifestText(
                f.GetProperty("target").GetString()!, f.GetProperty("version").GetString()!,
                f.GetProperty("size").GetInt64(), f.GetProperty("sha256").GetString()!);
            var reason = DeviceOta.Verify(text, v.GetProperty("sig").GetString()!, Modulus(v.GetProperty("key").GetString()!));
            Assert.True(v.GetProperty("reason").GetString() == reason, $"{v.GetProperty("id")}: expected {v.GetProperty("reason")}, got {reason}");
            Assert.Equal(v.GetProperty("valid").GetBoolean(), reason == "ok");
            executed++;
        }
        Assert.Equal(Declared("ota", "signatures"), executed);
    }

    [Fact]
    public void Every_version_vector_is_the_servers_version_gate()
    {
        var executed = 0;
        foreach (var v in Ota.GetProperty("versions").EnumerateArray())
        {
            var failed = v.GetProperty("failed").EnumerateArray().Select(e => e.GetString()!).ToList();
            var reason = DeviceOta.AcceptVersion(v.GetProperty("running").GetString(), v.GetProperty("offered").GetString(), failed);
            Assert.True(v.GetProperty("reason").GetString() == reason, $"{v.GetProperty("id")}: expected {v.GetProperty("reason")}, got {reason}");
            Assert.Equal(v.GetProperty("accept").GetBoolean(), reason == "ok");
            executed++;
        }
        Assert.Equal(Declared("ota", "versions"), executed);
    }

    /// <summary>
    /// Every offer vector through the board's grammar — and every ACCEPTED shape is one the server
    /// renders byte for byte (its six fields in the wire's order; an extra field is the board's to
    /// ignore and never the server's to send).
    /// </summary>
    [Fact]
    public void Every_offer_vector_is_the_grammar_and_every_accepted_one_is_what_the_server_renders()
    {
        var executed = 0;
        foreach (var v in Ota.GetProperty("offers").EnumerateArray())
        {
            var ota = v.GetProperty("ota");
            var reason = DeviceOta.ParseOffer(ota, v.GetProperty("own_target").GetString()!);
            Assert.True(v.GetProperty("reason").GetString() == reason, $"{v.GetProperty("id")}: expected {v.GetProperty("reason")}, got {reason}");
            Assert.Equal(v.GetProperty("accept").GetBoolean(), reason == "ok");
            if (reason == "ok")
            {
                var rendered = FirmwareService.OfferObject(
                    ota.GetProperty("target").GetString()!, ota.GetProperty("version").GetString()!, ota.GetProperty("size").GetInt64(),
                    ota.GetProperty("sha256").GetString()!, ota.GetProperty("sig").GetString()!, ota.GetProperty("path").GetString()!);
                var known = new JsonObject();
                foreach (var key in (string[])["target", "version", "size", "sha256", "sig", "path"]) known[key] = JsonNode.Parse(ota.GetProperty(key).GetRawText());
                Assert.Equal(known.ToJsonString(), rendered.ToJsonString());
            }
            executed++;
        }
        Assert.Equal(Declared("ota", "offers"), executed);
    }

    /// <summary>The image vectors: an upload of these bytes with this manifest is accepted under the corpus key — and a single flipped byte is not.</summary>
    [Fact]
    public void Every_image_vector_hashes_to_its_offer_and_verifies_under_the_corpus_key()
    {
        var executed = 0;
        foreach (var v in Ota.GetProperty("images").EnumerateArray())
        {
            var image = Convert.FromHexString(v.GetProperty("image_hex").GetString()!);
            var offer = v.GetProperty("offer");
            Assert.Equal(v.GetProperty("size").GetInt32(), image.Length);
            var sha = Convert.ToHexStringLower(SHA256.HashData(image));
            Assert.Equal(v.GetProperty("sha256").GetString(), sha);
            Assert.Equal(offer.GetProperty("sha256").GetString(), sha);
            var text = DeviceOta.ManifestText(offer.GetProperty("target").GetString()!, offer.GetProperty("version").GetString()!, image.Length, sha);
            Assert.Equal("ok", DeviceOta.Verify(text, offer.GetProperty("sig").GetString()!, Modulus("public_key")));

            image[0] ^= 0x01;
            var tampered = DeviceOta.ManifestText(offer.GetProperty("target").GetString()!, offer.GetProperty("version").GetString()!,
                image.Length, Convert.ToHexStringLower(SHA256.HashData(image)));
            Assert.Equal("sig", DeviceOta.Verify(tampered, offer.GetProperty("sig").GetString()!, Modulus("public_key")));
            executed++;
        }
        Assert.Equal(Declared("ota", "images"), executed);
    }

    /// <summary>Both corpus TEST moduli are recognised, so a deployment configured with either is refused outside Development.</summary>
    [Fact]
    public void The_corpus_test_keys_are_recognised_as_test_keys()
    {
        Assert.True(DeviceOta.IsCorpusTestKey(Modulus("public_key")));
        Assert.True(DeviceOta.IsCorpusTestKey(Modulus("other_public_key")));
        using var rsa = RSA.Create(2048);
        Assert.False(DeviceOta.IsCorpusTestKey(rsa.ExportParameters(false).Modulus!));
    }

    // ---- provision/ -------------------------------------------------------------------------------

    [Fact]
    public void Every_base_url_vector_is_the_servers_save_rule()
    {
        Assert.Equal(DeviceProvision.BaseUrlMax, Provision.GetProperty("constants").GetProperty("base_url_max").GetInt32());
        var executed = 0;
        foreach (var v in Provision.GetProperty("base_urls").EnumerateArray())
        {
            var reason = DeviceProvision.BaseUrl(v.GetProperty("url").GetString());
            Assert.True(v.GetProperty("reason").GetString() == reason, $"{v.GetProperty("id")}: expected {v.GetProperty("reason")}, got {reason}");
            Assert.Equal(v.GetProperty("accept").GetBoolean(), reason == "ok");
            executed++;
        }
        Assert.Equal(Declared("provision", "base_urls"), executed);
    }

    [Fact]
    public void Every_net_vector_is_adopted_or_refused_whole_with_the_boards_reason()
    {
        var executed = 0;
        foreach (var v in Provision.GetProperty("nets").EnumerateArray())
        {
            var (adopt, reason, result) = DeviceProvision.AdoptNet(v.GetProperty("net"), v.GetProperty("applied_ver").GetInt64());
            Assert.True(v.GetProperty("reason").GetString() == reason, $"{v.GetProperty("id")}: expected {v.GetProperty("reason")}, got {reason}");
            Assert.Equal(v.GetProperty("adopt").GetBoolean(), adopt);
            if (adopt)
            {
                var expected = v.GetProperty("result");
                Assert.Equal(expected.GetProperty("ver").GetInt64(), result!.Ver);
                Assert.Equal(expected.GetProperty("base").ValueKind == JsonValueKind.Null ? null : expected.GetProperty("base").GetString(), result.Base);
                Assert.Equal(
                    expected.GetProperty("wifi").EnumerateArray().Select(p => (p[0].GetString()!, p[1].GetString()!)),
                    result.Wifi);
            }
            executed++;
        }
        Assert.Equal(Declared("provision", "nets"), executed);
    }

    [Fact]
    public void Every_key_vector_is_adopted_or_refused_with_the_boards_reason()
    {
        var executed = 0;
        foreach (var v in Provision.GetProperty("keys").EnumerateArray())
        {
            var held = v.GetProperty("held_ids").EnumerateArray().Select(e => e.GetString()!).ToList();
            var reason = DeviceProvision.AdoptKey(v.GetProperty("key_next"), v.GetProperty("current_id").GetString()!, held);
            Assert.True(v.GetProperty("reason").GetString() == reason, $"{v.GetProperty("id")}: expected {v.GetProperty("reason")}, got {reason}");
            Assert.Equal(v.GetProperty("adopt").GetBoolean(), reason == "ok");
            executed++;
        }
        Assert.Equal(Declared("provision", "keys"), executed);
    }

    /// <summary>
    /// The link supervisor is the boards' alone — the server runs no WiFi — but its constants are
    /// contract constants the console's network warning quotes, so this suite executes the
    /// vectors against the generator's rule, written out once here, rather than skip a section.
    /// </summary>
    [Fact]
    public void Every_supervisor_vector_follows_the_contracts_rule()
    {
        var c = Provision.GetProperty("constants");
        var grace = c.GetProperty("supervisor_grace_seconds").GetInt32();
        var backoff = c.GetProperty("supervisor_backoff_seconds").EnumerateArray().Select(e => e.GetInt32()).ToArray();
        var restart = c.GetProperty("supervisor_restart_seconds").GetInt32();
        Assert.Equal([30, 60, 120, 240, 300], backoff);

        string Supervise(int down, int since, int attempts)
        {
            if (down >= restart) return "restart";
            if (down < grace) return "none";
            var wait = attempts > 0 ? backoff[Math.Min(attempts - 1, backoff.Length - 1)] : 0;
            return attempts > 0 && since < wait ? "none" : "reconnect_next_profile";
        }

        var executed = 0;
        foreach (var v in Provision.GetProperty("supervisor").EnumerateArray())
        {
            Assert.Equal(v.GetProperty("action").GetString(), Supervise(
                v.GetProperty("down_seconds").GetInt32(), v.GetProperty("since_attempt_seconds").GetInt32(), v.GetProperty("attempts").GetInt32()));
            executed++;
        }
        Assert.Equal(Declared("provision", "supervisor"), executed);
    }

    // ---- compat/ budgets --------------------------------------------------------------------------

    /// <summary>
    /// Every <c>budgets</c> row (each is read by <c>csharp</c>, compat manifest): a RESPONSE row's
    /// <c>server_max</c> is the constant the server fits to, and at most 80% of the board's buffer;
    /// a REQUEST row's <c>server_min_accept</c> is at most what the server's body reader takes.
    /// </summary>
    [Fact]
    public void Every_budget_row_is_the_servers_constant()
    {
        var readers = Load("compat", "manifest.json").GetProperty("read_by").GetProperty("budgets").EnumerateArray().Select(e => e.GetString());
        Assert.Contains("csharp", readers);

        var executed = 0;
        foreach (var row in Compat.GetProperty("budgets").EnumerateArray())
        {
            var id = row.GetProperty("id").GetString()!;
            var buffer = row.GetProperty("firmware_buffer").GetInt32();
            if (row.GetProperty("direction").GetString() == "response")
            {
                var max = row.GetProperty("server_max").GetInt32();
                Assert.True(ServerMax(row) == max, $"{id}: the server fits this endpoint to {ServerMax(row)}, the contract says {max}");
                if (row.GetProperty("firmware").GetString()!.StartsWith("bridge-3", StringComparison.Ordinal)
                    || row.GetProperty("firmware").GetString()!.StartsWith("gate-2", StringComparison.Ordinal))
                {
                    Assert.True(max * 5 <= buffer * 4, $"{id}: {max} is over 80% of the board's {buffer}");
                }
            }
            else
            {
                Assert.True(DeviceBody.MaxBytes >= row.GetProperty("server_min_accept").GetInt32(),
                    $"{id}: the server's body reader takes {DeviceBody.MaxBytes}, the contract needs {row.GetProperty("server_min_accept")}");
            }
            executed++;
        }
        Assert.Equal(Declared("compat", "budgets"), executed);
    }

    private static int ServerMax(JsonElement row)
    {
        var v3 = row.GetProperty("firmware").GetString()!.StartsWith("bridge-3", StringComparison.Ordinal)
                 || row.GetProperty("firmware").GetString()!.StartsWith("gate-2", StringComparison.Ordinal);
        return (row.GetProperty("device").GetString(), row.GetProperty("endpoint").GetString()) switch
        {
            ("court_box", "heartbeat") => v3 ? DeviceHeartbeatBudget.CourtBoxV3 : DeviceHeartbeatBudget.CourtBox2x,
            ("door_gate", "heartbeat") => v3 ? DeviceHeartbeatBudget.GateV3 : DeviceHeartbeatBudget.Gate1x,
            ("court_box", "activate" or "walkup" or "extend") => DeviceHeartbeatBudget.ScanReplyMax,
            ("door_gate", "gate") => DeviceHeartbeatBudget.GateReplyMax,
            (_, "events") => DeviceHeartbeatBudget.EventsReplyMax,
            var other => throw new InvalidOperationException($"no server budget for {other}"),
        };
    }

    // ---- http/ v3 heartbeat responses, from the real views ----------------------------------------

    private static IEnumerable<JsonElement> V3Responses(string kind) =>
        Http.GetProperty("responses").EnumerateArray()
            .Where(c => c.GetProperty("id").GetString()!.StartsWith("v3-", StringComparison.Ordinal) && c.GetProperty("kind").GetString() == kind);

    private static string Text(JsonElement c) => Encoding.UTF8.GetString(Convert.FromHexString(c.GetProperty("body_hex").GetString()!));

    /// <summary>The club's settings as a vector's <c>config</c> states them — the 2.x keys and, read by the server's own reader, the v3 ones.</summary>
    internal static TenantSettingsView ViewOf(JsonElement root)
    {
        var config = root.GetProperty("config");
        var wire = config.GetProperty("button_map").EnumerateArray().Select(e => e.GetString()!).ToList();
        Assert.True(ButtonMap.TryParse(wire, out var buttons, out _));
        return new TenantSettingsView(
            config.GetProperty("slice_minutes").GetInt32(), 0, config.GetProperty("grace_window_minutes").GetInt32(), 0, 14,
            "UTC", 0, "16:00-19:00", 0, 7, 0, 1440, 7, buttons!)
        {
            WalkUpMaxMinutes = config.GetProperty("walk_up_max_minutes").GetInt32(),
            HeartbeatSeconds = root.GetProperty("heartbeat_seconds").GetInt32(),
            LcdRevertSeconds = config.GetProperty("lcd_revert_seconds").GetInt32(),
            LcdChoiceSeconds = config.GetProperty("lcd_choice_seconds").GetInt32(),
            LcdCardSeconds = config.GetProperty("lcd_card_seconds").GetInt32(),
            LcdHintSeconds = config.GetProperty("lcd_hint_seconds").GetInt32(),
            ScanMemorySeconds = config.GetProperty("scan_memory_seconds").GetInt32(),
            ClockTrustMinutes = config.GetProperty("clock_trust_minutes").GetInt32(),
            RelayRestoreEnabled = config.GetProperty("relay_restore_enabled").GetBoolean(),
            DeviceFaultReporting = config.GetProperty("device_fault_reporting").GetBoolean(),
            DeviceFaultMaxPerHour = config.GetProperty("device_fault_max_per_hour").GetInt32(),
            Device = DeviceSettings.Read(config),
        };
    }

    private static JsonObject? Obj(JsonElement root, string name) =>
        root.TryGetProperty(name, out var o) ? JsonNode.Parse(o.GetRawText())!.AsObject() : null;

    private static List<string>? Strings(JsonElement root, string name) =>
        root.TryGetProperty(name, out var a) ? [.. a.EnumerateArray().Select(e => e.GetString()!)] : null;

    private static Device BoxOf(JsonElement root) => new()
    {
        DeviceCode = root.GetProperty("device_code").GetString()!,
        Name = "Court box",
        MacAddress = "5ccf7f0a1b2c",
        CourtNumbers = root.TryGetProperty("court_numbers", out var n) ? [.. n.EnumerateArray().Select(e => e.GetInt32())] : [1, 2, 3, 4],
        Capabilities = ["codes:m1", "hb:3", "ota:1", "key:1", "net:1", "lcd:2"],
    };

    /// <summary>The server's body for a vector, with the vector's own clock string (its formatting is not v3's subject).</summary>
    private static string Serialise(Device device, JsonElement root, TenantSettingsView s, int extraKeys = 0)
    {
        MemberCodeSync? sync = null;
        if (root.TryGetProperty("code_keys", out _))
        {
            var keys = Strings(root, "code_keys")!;
            // Lower-priority keys after the vector's own: the budget must shed exactly these.
            keys.AddRange(Enumerable.Range(0, extraKeys).Select(i => MemberCodeWire.KeyElement(MemberCodeMath.RefText(0x50000 + i), 1, new byte[12])));
            sync = new MemberCodeSync(root.GetProperty("code_step").GetInt64(), root.GetProperty("code_step_ms").GetInt32(),
                Strings(root, "code_days")!, keys)
            { Wanted = keys.Count };
        }

        var lifeline = new DeviceLifeline(Obj(root, "ota"), Obj(root, "key_next"), Obj(root, "net"));
        var body = DeviceHeartbeatBudget.Fit(
            codes => DeviceEndpoints.CourtBoxView(device, root.GetProperty("tenant_slug").GetString()!, s,
                new CourtBoxLists(Strings(root, "roster")!, Strings(root, "relays"), codes) { Courts = Strings(root, "courts"), Lifeline = lifeline },
                DateTimeOffset.UnixEpoch),
            sync, DeviceHeartbeatBudget.For(device), lifeline, () => throw new InvalidOperationException("no vector needs the lifeline-only body"),
            lifelineTurn: false);
        body["server_time"] = root.GetProperty("server_time").GetDateTimeOffset();
        return JsonSerializer.Serialize(body);
    }

    [Theory]
    [InlineData("v3-heartbeat-response-snapshot")]
    [InlineData("v3-heartbeat-response-unacknowledged")]
    [InlineData("v3-heartbeat-response-display-expanded")]
    [InlineData("v3-heartbeat-response-ota-offer")]
    [InlineData("v3-heartbeat-response-key-next")]
    [InlineData("v3-heartbeat-response-net")]
    public void A_v3_heartbeat_vector_is_what_the_server_serialises(string id)
    {
        var c = V3Responses("heartbeat").Single(v => v.GetProperty("id").GetString() == id);
        using var doc = JsonDocument.Parse(Text(c));
        Assert.Equal(Text(c), Serialise(BoxOf(doc.RootElement), doc.RootElement, ViewOf(doc.RootElement)));
    }

    /// <summary>
    /// The hardware vector through the PER-BOARD overrides (HW-1, HW-2, HW-5): the club's settings
    /// are the defaults, the board's own five <c>hw_*</c> values resolve into its config.
    /// </summary>
    [Fact]
    public void The_hardware_vector_is_a_boards_own_overrides_resolved_into_its_config()
    {
        var c = V3Responses("heartbeat").Single(v => v.GetProperty("id").GetString() == "v3-heartbeat-response-hardware");
        using var doc = JsonDocument.Parse(Text(c));
        var config = doc.RootElement.GetProperty("config");
        var device = BoxOf(doc.RootElement);
        device.HwRelayActiveLevel = config.GetProperty("hw_relay_active_level").GetString();
        device.HwLcdI2cAddress = config.GetProperty("hw_lcd_i2c_address").GetInt32();
        device.HwScannerBaud = config.GetProperty("hw_scanner_baud").GetInt32();
        device.HwScannerLineEnd = config.GetProperty("hw_scanner_line_end").GetString();
        device.HwScannerGapMs = config.GetProperty("hw_scanner_gap_ms").GetInt32();

        var club = ViewOf(doc.RootElement) with { Device = DeviceSettingsRaw.Defaults };
        Assert.Equal(Text(c), Serialise(device, doc.RootElement, club));

        // And the club's own value, with no override, is what an un-overridden board is sent.
        var plain = Serialise(BoxOf(doc.RootElement), doc.RootElement, club);
        Assert.Contains("\"hw_relay_active_level\":\"high\",\"hw_lcd_i2c_address\":0,\"hw_scanner_baud\":0,\"hw_scanner_line_end\":\"auto\",\"hw_scanner_gap_ms\":150", plain);
    }

    /// <summary>
    /// The out-of-range vector is a body the BOARD must tolerate; the server never sends it. Stored
    /// raw in the club's settings, every value comes out clamped or closed-set independently.
    /// </summary>
    [Fact]
    public void Out_of_range_stored_values_leave_the_server_clamped_each_on_its_own()
    {
        var c = V3Responses("heartbeat").Single(v => v.GetProperty("id").GetString() == "v3-heartbeat-response-display-out-of-range");
        using var doc = JsonDocument.Parse(Text(c));
        var body = Serialise(BoxOf(doc.RootElement), doc.RootElement, ViewOf(doc.RootElement));
        Assert.Contains(
            "\"lcd_layout\":\"compact\",\"lcd_marquee_enabled\":true,\"lcd_marquee_step_ms\":250,\"lcd_landing_page_seconds\":15," +
            "\"lcd_screen_ceiling_seconds\":120,\"lcd_landing_dwell_seconds\":10,\"lcd_after_lights_on_seconds\":5,\"lcd_reinit_seconds\":30," +
            "\"relay_authorisation_cap_minutes\":90,\"relay_reconcile_min_seconds\":30,\"device_power_restore_trust_minutes\":120," +
            "\"device_net_fallback_minutes\":3,\"device_ota_probation_minutes\":3,\"hw_relay_active_level\":\"high\",\"hw_lcd_i2c_address\":0," +
            "\"hw_scanner_baud\":0,\"hw_scanner_line_end\":\"auto\",\"hw_scanner_gap_ms\":50,\"button_map\"", body);
        Assert.NotEqual(Text(c), body);
    }

    /// <summary>
    /// The widest v3 body (4086 of 4096): the server, offered the vector's 42 keys plus 22 of lower
    /// priority, sheds exactly the 22 and writes the vector's bytes — every value one the server can
    /// really send. The vector once wrote <c>device_fault_max_per_hour</c> as 1000, a value the
    /// server's 1–120 bound (BoxSettings) never emits; it is now the bound itself.
    /// </summary>
    [Fact]
    public void The_widest_v3_vector_is_the_servers_fit_at_4096()
    {
        var c = V3Responses("heartbeat").Single(v => v.GetProperty("id").GetString() == "v3-heartbeat-response-widest");
        var text = Text(c);
        Assert.Equal(4086, Encoding.UTF8.GetByteCount(text));
        Assert.True(Encoding.UTF8.GetByteCount(text) <= DeviceHeartbeatBudget.CourtBoxV3);
        using var doc = JsonDocument.Parse(text);
        Assert.Equal(42, doc.RootElement.GetProperty("code_keys").GetArrayLength());
        Assert.Equal(BoxSettings.MaxDeviceFaultMaxPerHour,
            doc.RootElement.GetProperty("config").GetProperty("device_fault_max_per_hour").GetInt32());
        Assert.Equal(text, Serialise(BoxOf(doc.RootElement), doc.RootElement, ViewOf(doc.RootElement), extraKeys: 22));
    }

    /// <summary>The lifeline-only body (§11.1) is the server's, byte for byte — and Fit sends it only on the lifeline's turn of an over-budget body.</summary>
    [Fact]
    public void The_lifeline_only_vector_is_the_servers_and_alternates_only_when_nothing_else_fits()
    {
        var c = V3Responses("heartbeat").Single(v => v.GetProperty("id").GetString() == "v3-heartbeat-response-lifeline-only");
        using var doc = JsonDocument.Parse(Text(c));
        var root = doc.RootElement;
        var device = BoxOf(root);
        var lifeline = new DeviceLifeline(Obj(root, "ota"), null, null);
        var only = DeviceHeartbeatBudget.LifelineOnly(root.GetProperty("server_time").GetDateTimeOffset(), root.GetProperty("tenant_slug").GetString()!,
            device, root.GetProperty("heartbeat_seconds").GetInt32(), lifeline);
        Assert.Equal(Text(c), JsonSerializer.Serialize(only));

        Dictionary<string, object?> Huge(MemberCodeSync? _) => new() { ["pad"] = new string('x', 5000) };
        Assert.Same(only, DeviceHeartbeatBudget.Fit(Huge, null, 4096, lifeline, () => only, lifelineTurn: true));
        Assert.True(DeviceHeartbeatBudget.Fit(Huge, null, 4096, lifeline, () => only, lifelineTurn: false).ContainsKey("pad"));
        // Without a lifeline to deliver there is nothing to alternate to.
        Assert.True(DeviceHeartbeatBudget.Fit(Huge, null, 4096, DeviceLifeline.None, () => only, lifelineTurn: true).ContainsKey("pad"));
    }

    [Fact]
    public void The_play_remaining_vector_is_what_the_activate_answer_serialises()
    {
        var c = V3Responses("activate").Single(v => v.GetProperty("id").GetString() == "v3-activate-response-play-remaining");
        var parsed = JsonSerializer.Deserialize<DeviceActivateResponse>(Text(c))!;
        Assert.Equal(6300, parsed.PlayRemainingSeconds);
        Assert.Equal(Text(c), JsonSerializer.Serialize(parsed));
    }

    /// <summary>Every v3 http response vector is executed by one of the tests above, by id.</summary>
    [Fact]
    public void Every_v3_http_response_vector_is_bound_here()
    {
        var bound = new[]
        {
            "v3-heartbeat-response-snapshot", "v3-heartbeat-response-unacknowledged", "v3-heartbeat-response-display-expanded",
            "v3-heartbeat-response-display-out-of-range", "v3-heartbeat-response-ota-offer", "v3-heartbeat-response-key-next",
            "v3-heartbeat-response-net", "v3-heartbeat-response-widest", "v3-activate-response-play-remaining",
            "v3-heartbeat-response-hardware", "v3-heartbeat-response-lifeline-only",
        };
        var v3 = Http.GetProperty("responses").EnumerateArray().Select(c => c.GetProperty("id").GetString()!)
            .Where(id => id.StartsWith("v3-", StringComparison.Ordinal)).Order();
        Assert.Equal(bound.Order(), v3);
    }

    /// <summary>Every v3 heartbeat REQUEST vector binds into the server's record without a refusal, its telemetry read 64-bit.</summary>
    [Fact]
    public void Every_v3_request_vector_binds_and_its_telemetry_is_read()
    {
        var web = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        var executed = 0;
        foreach (var c in Http.GetProperty("requests").EnumerateArray().Concat(Gate.GetProperty("requests").EnumerateArray())
                     .Where(c => c.GetProperty("id").GetString()!.Contains("v3", StringComparison.Ordinal)))
        {
            var bytes = Convert.FromHexString(c.GetProperty("body_hex").GetString()!);
            if (c.GetProperty("path_and_query").GetString() == "/api/v1/device/events")
            {
                var batch = JsonSerializer.Deserialize<DeviceEventBatch>(bytes, web)!;
                Assert.Equal("mega_reset", Assert.Single(batch.Events!).Cause);
                executed++;
                continue;
            }
            var req = JsonSerializer.Deserialize<HeartbeatRequest>(bytes, web)!;
            Assert.NotNull(req.Caps);
            if (req.Diag.ValueKind == JsonValueKind.Object) Assert.NotEmpty(DeviceTelemetry.ReadDiag(req.Diag));
            executed++;
        }
        Assert.True(executed >= 10, $"only {executed} v3 request vectors bound");
    }

    /// <summary>
    /// The widest v3 door body the server can write — <c>membercode/gate.json</c>'s full body plus
    /// every v3 object at its bound and the two fault settings — stays inside 6144 (measured 5085).
    /// </summary>
    [Fact]
    public void The_widest_v3_door_body_the_server_can_write_fits_6144()
    {
        var device = new Device
        {
            DeviceCode = "gate-" + new string('c', 12),
            Name = "x",
            MacAddress = "5ccf7f0a1b2c",
            Kind = DeviceKind.Gate,
            GateKey = new string('g', 64),
            Capabilities = ["codes:m1", "ota:1", "key:1", "net:1"],
        };
        var roster = Enumerable.Range(0, 48)
            .Select(i => $"m{MemberCodeMath.RefText(0x40000 + (i * 4))}{MemberCodeMath.RefText(0x40001 + (i * 4))}{MemberCodeMath.RefText(0x40002 + (i * 4))}{MemberCodeMath.RefText(0x40003 + (i * 4))}|0|-864000|999999")
            .ToList();
        var keys = Enumerable.Range(0, MemberCodeWire.GateKeyCap).Select(i => MemberCodeWire.KeyElement(MemberCodeMath.RefText(0x40000 + i), i % 2, new byte[12])).ToList();
        var sync = new MemberCodeSync(4_294_967_295L / 2, 29_999, ["4294960000|4294963120", "4294963120|4294966240"], keys) { Wanted = keys.Count };
        var widest = Load("http").GetProperty("responses").EnumerateArray().Single(c => c.GetProperty("id").GetString() == "v3-heartbeat-response-widest");
        using var doc = JsonDocument.Parse(Text(widest));
        var lifeline = new DeviceLifeline(Obj(doc.RootElement, "ota"), Obj(doc.RootElement, "key_next"), Obj(doc.RootElement, "net"));
        var parts = new GateV3Parts(new GateV3Settings(120, 60, 60, false, 1000), lifeline);

        var body = DeviceHeartbeatBudget.Fit(
            codes => GateHeartbeatView.WithCodes(device, new string('w', 64), new GateTiming(300, 30), roster, DateTimeOffset.UtcNow, new GateTail(codes, parts)),
            sync, DeviceHeartbeatBudget.GateV3, lifeline, () => throw new InvalidOperationException("must fit"), lifelineTurn: true);
        var bytes = JsonSerializer.SerializeToUtf8Bytes(body).Length;
        Assert.True(bytes <= DeviceHeartbeatBudget.GateV3, $"widest v3 door body is {bytes} bytes");
        Assert.Equal(MemberCodeWire.GateKeyCap, ((IReadOnlyList<string>)body["code_keys"]!).Count);
    }
}
