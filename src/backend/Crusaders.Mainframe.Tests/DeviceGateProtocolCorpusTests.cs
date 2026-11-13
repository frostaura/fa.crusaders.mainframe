using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The server half of the shared <c>gate/</c> corpus.
///
/// <para>
/// Same job as <see cref="DeviceProtocolCorpusTests"/> and a separate family for the
/// reason <c>src/contracts/device-protocol/README.md</c> gives: both sides assert that
/// the number of cases they EXECUTED equals the number their manifest declares, so a gate
/// vector living in <c>http/</c> would make the court box's C++ suite red on a board that
/// has no gate code in it.
/// </para>
///
/// <para>
/// <b>These tests do more than read the fixtures back.</b> A corpus test that only parses
/// its own JSON proves the JSON is JSON. What matters is whether the bytes in the file are
/// the bytes the server actually puts on the wire, so every response family here is
/// serialised from the REAL shape — <see cref="GateHeartbeatView"/>, <see
/// cref="GateScanResponse"/> — and compared to the vector byte for byte, and every request
/// family is bound into the REAL record the endpoint takes. A field renamed, reordered or
/// given a different JSON name in the C# fails here rather than in a doorway.
/// </para>
/// </summary>
public class DeviceGateProtocolCorpusTests
{
    private static readonly JsonElement Corpus = LoadCorpus();
    private static readonly JsonElement Manifest = LoadManifest();

    /// <summary>
    /// The instant every heartbeat vector is written at. It has to round-trip through
    /// <c>System.Text.Json</c> to exactly the string in the file, which is what makes a
    /// byte comparison of the whole body possible at all.
    /// </summary>
    private static readonly DateTimeOffset VectorNow =
        DateTimeOffset.Parse("2023-11-14T22:13:20+00:00", System.Globalization.CultureInfo.InvariantCulture);

    private const string VectorTenantSlug = "crusaders";

    /// <summary>The one <c>expect</c> key that is a bound on the body rather than a field of it.</summary>
    private const string MaxBytesKey = "max_bytes";

    private static string ContractRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var candidate = Path.Combine(dir.FullName, "src", "contracts", "device-protocol", "gate");
            if (Directory.Exists(candidate)) return candidate;
            dir = dir.Parent;
        }

        throw new DirectoryNotFoundException(
            "src/contracts/device-protocol/gate was not found above the test binary. " +
            "The corpus is the only thing keeping the gate firmware and the server in agreement; " +
            "a missing corpus must fail loudly rather than skip.");
    }

    private static JsonElement LoadCorpus() =>
        JsonDocument.Parse(File.ReadAllText(Path.Combine(ContractRoot(), "cases.json"))).RootElement;

    private static JsonElement LoadManifest() =>
        JsonDocument.Parse(File.ReadAllText(Path.Combine(ContractRoot(), "manifest.json"))).RootElement;

    private static int Declared(string section) =>
        Manifest.GetProperty("case_count").GetProperty(section).GetInt32();

    private static byte[] Hex(JsonElement e, string prop) => Convert.FromHexString(e.GetProperty(prop).GetString()!);

    private static IEnumerable<JsonElement> Section(string name) =>
        Corpus.TryGetProperty(name, out var section) && section.ValueKind == JsonValueKind.Array
            ? section.EnumerateArray()
            : [];

    private static IEnumerable<JsonElement> Of(string section, string kind) =>
        Section(section).Where(c => c.GetProperty("kind").GetString() == kind);

    private static string Id(JsonElement c) => c.GetProperty("id").GetString()!;

    // ---- Requests ----------------------------------------------------------

    /// <summary>
    /// The whole of the gate's request contract, exactly as the court box's: the club key
    /// in <c>Authorization: Bearer</c> and the board's MAC in the body, in the normalised
    /// form <c>DeviceRegistryService.NormaliseMacAddress</c> produces — a vector pinning a
    /// separated MAC would be a firmware that registers a second row for a board that
    /// already has one.
    /// </summary>
    [Fact]
    public void Request_vectors_pin_the_bearer_header_and_the_mac()
    {
        var executed = 0;
        foreach (var c in Section("requests"))
        {
            var authorization = c.GetProperty("authorization").GetString()!;
            Assert.StartsWith("Bearer ", authorization, StringComparison.Ordinal);
            Assert.True(authorization.Length > "Bearer ".Length, $"'{Id(c)}' is a bearer header with no key in it.");

            using var body = JsonDocument.Parse(Hex(c, "body_hex"));
            var mac = body.RootElement.GetProperty("mac").GetString();
            Assert.Equal(mac, Crusaders.Mainframe.Api.Services.DeviceRegistryService.NormaliseMacAddress(mac));

            executed++;
        }

        Assert.Equal(Declared("requests"), executed);
    }

    /// <summary>
    /// Every request vector binds into the record its endpoint actually takes, with the
    /// values the vector declares. This is the direction the corpus could not otherwise
    /// see: a <c>JsonPropertyName</c> that does not match the wire binds to null silently,
    /// and a null <c>kind</c> is indistinguishable from "this board is a court box".
    /// </summary>
    [Fact]
    public void Request_vectors_bind_to_the_records_the_endpoints_take()
    {
        var heartbeat = JsonSerializer.Deserialize<HeartbeatRequest>(Body("requests", "gate-heartbeat-request"))!;
        Assert.Equal("5ccf7f0a1b2c", heartbeat.Mac);
        Assert.Equal("1.0.0", heartbeat.FirmwareVersion);
        Assert.Equal(86400000, heartbeat.UptimeMs);
        Assert.Equal(DeviceKinds.Gate, heartbeat.Kind);

        // Absent means absent, not zero: a board on an older build reports no counter at all,
        // and a null is what tells the server that rather than "everything is fine".
        Assert.Null(heartbeat.NoPush);

        var diagnostic = JsonSerializer.Deserialize<HeartbeatRequest>(
            Body("requests", "gate-heartbeat-request-no-push"))!;
        Assert.Equal(4, diagnostic.NoPush);
        Assert.Equal(DeviceKinds.Gate, diagnostic.Kind);

        var scan = JsonSerializer.Deserialize<GateScanRequest>(Body("requests", "gate-scan-request"))!;
        Assert.Equal("5ccf7f0a1b2c", scan.Mac);
        Assert.Equal("qr", scan.Method);
        Assert.Equal("7Q3F9KM2XZ8B", scan.Token);

        var batch = JsonSerializer.Deserialize<DeviceEventBatch>(Body("requests", "gate-events-request-gate-open"))!;
        var queued = Assert.Single(batch.Events!);
        Assert.Equal(DeviceEventEndpoints.GateOpenKind, queued.Kind);

        // -1 is the wire's "no relay". A gate has no relay bank to index, and the receipt
        // must not carry a court index a later `release` could pair against.
        Assert.Equal(-1, queued.Court);
        Assert.Equal("7Q3F9KM2XZ8B", queued.Subject);

        // THE BOOT IDENTITY, which is the third field of the idempotency key (round G4, C2)
        // and is the whole reason this vector changed. It binds as a full unsigned 32-bit
        // number: an `int` property would have taken anything over 2147483647 to a 400 on the
        // WHOLE batch, which for a value the board draws at random is one board-life in two.
        Assert.Equal(2596069104L, batch.BootId);

        // AND ABSENT MEANS ZERO, which is exactly what (device, seq) always meant. That is
        // what lets a court box — whose renderer omits the field — and every gate image
        // flashed before this change keep deduplicating against themselves. A binding that
        // made this nullable, or that threw, would be a flag day for every board in the field.
        var legacy = JsonSerializer.Deserialize<DeviceEventBatch>(
            Body("requests", "gate-events-request-no-boot-id"))!;
        Assert.Equal(0L, legacy.BootId);
        var refusal = Assert.Single(legacy.Events!);
        Assert.Equal(DeviceEventEndpoints.UnknownScanKind, refusal.Kind);

        // And the subject the firmware ESCAPED (round G4, B1) arrives as the bytes that were
        // scanned, not as the bytes that were sent: a quote inside a token is a quote, and a
        // corpus that only ever carried safe subjects would be pinning nothing.
        Assert.Equal("A\"B", refusal.Subject);
    }

    // ---- Response bodies ---------------------------------------------------

    /// <summary>
    /// The other direction of the wire: every body parses, carries every field its
    /// <c>expect</c> declares with the declared value, and fits its declared budget.
    /// </summary>
    [Fact]
    public void Response_bodies_carry_every_field_they_declare()
    {
        var executed = 0;
        foreach (var c in Section("responses"))
        {
            var bytes = Hex(c, "body_hex");
            using var body = JsonDocument.Parse(bytes);
            var expect = c.GetProperty("expect");

            foreach (var field in expect.EnumerateObject())
            {
                // Not a field of the body but a bound on it: the gate reads the whole
                // response into a fixed 4608-byte buffer, and a roster that fills to its
                // cap has to fit alongside everything else the heartbeat carries.
                if (field.Name == MaxBytesKey)
                {
                    Assert.True(bytes.Length <= field.Value.GetInt32(),
                        $"response '{Id(c)}' is {bytes.Length} bytes, over its {field.Value.GetInt32()}-byte budget");
                    continue;
                }

                Assert.True(
                    body.RootElement.TryGetProperty(field.Name, out var actual),
                    $"response '{Id(c)}' lacks expected field '{field.Name}'");
                Assert.True(
                    JsonElement.DeepEquals(field.Value, actual),
                    $"response '{Id(c)}' field '{field.Name}': expected {field.Value.GetRawText()}, got {actual.GetRawText()}");
            }

            executed++;
        }

        Assert.Equal(Declared("responses"), executed);
    }

    /// <summary>
    /// <c>server_unix</c> went with the clock the device scheme no longer keeps, and a
    /// gate has no more of one than a court box. A vector still carrying it would mean one
    /// side is writing a field the other stopped reading.
    /// </summary>
    [Fact]
    public void No_response_body_still_carries_server_unix()
    {
        foreach (var c in Section("responses"))
        {
            using var body = JsonDocument.Parse(Hex(c, "body_hex"));
            Assert.False(
                body.RootElement.TryGetProperty("server_unix", out _),
                $"response '{Id(c)}' still carries server_unix; the gate has no clock to seed.");
        }
    }

    /// <summary>
    /// A gate is not a court box and its heartbeat must not pretend to be one. None of the
    /// three keys a court box reads may appear: a firmware that found <c>court_numbers</c>
    /// on a gate response would be reading a relay map for a device with one lock.
    /// </summary>
    [Theory]
    [InlineData("court_numbers")]
    [InlineData("config")]
    [InlineData("button_map")]
    public void A_gate_heartbeat_carries_none_of_the_court_boxs_keys(string absent)
    {
        foreach (var c in Of("responses", "heartbeat"))
        {
            using var body = JsonDocument.Parse(Hex(c, "body_hex"));
            Assert.False(
                body.RootElement.TryGetProperty(absent, out _),
                $"gate response '{Id(c)}' carries '{absent}', which belongs to a court box.");
        }
    }

    // ---- The bytes the server really emits ---------------------------------

    /// <summary>
    /// Every heartbeat vector is re-serialised from <see cref="GateHeartbeatView"/> and
    /// compared BYTE FOR BYTE.
    ///
    /// <para>
    /// This is the assertion with teeth. Everything above reads the corpus back to itself
    /// and would stay green through a rename on the C# side; this one goes red. Byte
    /// identity rather than a field walk because the gate parses this response with a
    /// hand-written scan out of a fixed buffer, so key ORDER and the absence of whitespace
    /// are part of the contract, not incidental.
    /// </para>
    /// </summary>
    [Fact]
    public void Every_heartbeat_vector_is_what_the_server_really_serialises()
    {
        var executed = 0;
        foreach (var c in Of("responses", "heartbeat"))
        {
            using var declared = JsonDocument.Parse(Hex(c, "body_hex"));
            var root = declared.RootElement;

            var device = new Device
            {
                TenantId = Guid.NewGuid(),
                DeviceCode = root.GetProperty("device_code").GetString()!,
                Name = "Door gate",
                Kind = DeviceKind.Gate,
                Hardware = DeviceHardware.Esp32,
                MacAddress = Corpus.GetProperty("device_mac").GetString()!,
                GateKey = root.GetProperty("gate_key").ValueKind == JsonValueKind.Null
                    ? null
                    : root.GetProperty("gate_key").GetString(),
            };

            var body = GateHeartbeatView.Of(
                device,
                root.GetProperty("tenant_slug").GetString()!,
                new GateTiming(root.GetProperty("heartbeat_seconds").GetInt32(), root.GetProperty("gate").GetProperty("unlock_seconds").GetInt32()),
                root.GetProperty("roster").EnumerateArray().Select(e => e.GetString()!).ToList(),
                VectorNow,
                V3PartsOf(root));

            Assert.Equal(
                System.Text.Encoding.UTF8.GetString(Hex(c, "body_hex")),
                JsonSerializer.Serialize(body));
            executed++;
        }

        Assert.True(executed >= 5, $"only {executed} heartbeat vectors executed; the gate heartbeat is under-pinned");
    }

    /// <summary>
    /// The same for the scan decision, and one refusal reason per vector. A reason string
    /// the server spells differently from the corpus is a door that answers a refusal the
    /// firmware has no screen for.
    ///
    /// <para>
    /// Counted against <c>GateAccess.Reasons.Length</c> rather than a literal, which is the
    /// stronger assertion and not merely the lower-maintenance one: the sibling test below
    /// compares the two as SETS, so a second vector for a reason that already has one is
    /// invisible to it and is caught only here.
    /// </para>
    /// </summary>
    [Fact]
    public void Every_scan_vector_is_what_the_server_really_serialises()
    {
        var executed = 0;
        foreach (var c in Of("responses", "gate"))
        {
            using var declared = JsonDocument.Parse(Hex(c, "body_hex"));
            var root = declared.RootElement;

            var response = new GateScanResponse(
                root.GetProperty("opened").GetBoolean(),
                root.GetProperty("reason").GetString()!,
                root.GetProperty("unlock_seconds").GetInt32());

            Assert.Equal(
                System.Text.Encoding.UTF8.GetString(Hex(c, "body_hex")),
                JsonSerializer.Serialize(response));
            executed++;
        }

        Assert.Equal(GateAccess.Reasons.Length, executed);
    }

    /// <summary>
    /// Every reason the endpoint can answer has a vector, and every vector's reason is one
    /// the endpoint can answer. Either direction failing is a refusal nobody has a screen
    /// for — or a screen for a refusal that never comes.
    /// </summary>
    [Fact]
    public void The_refusal_reasons_and_their_vectors_are_the_same_set()
    {
        var inCorpus = Of("responses", "gate")
            .Select(c => JsonDocument.Parse(Hex(c, "body_hex")).RootElement.GetProperty("reason").GetString()!)
            .ToHashSet();

        Assert.Equal(GateAccess.Reasons.Order(), inCorpus.Order());
    }

    // ---- The roster push -----------------------------------------------------

    /// <summary>
    /// The element grammar is the court box's, reused unchanged so the firmware's parser
    /// is — with one narrowing: the relay field on a gate is always <c>0</c>, because a
    /// door has one lock and no relay bank to index.
    /// </summary>
    [Fact]
    public void Gate_roster_vectors_match_the_firmware_grammar_and_the_cap()
    {
        var sawFull = false;
        foreach (var c in Of("responses", "heartbeat"))
        {
            using var body = JsonDocument.Parse(Hex(c, "body_hex"));
            var roster = body.RootElement.GetProperty("roster").EnumerateArray().Select(e => e.GetString()!).ToList();

            Assert.True(roster.Count <= DeviceGateRosterBuilder.GateRosterMaxEntries);
            Assert.All(roster, entry => Assert.Matches(DeviceProtocolCorpusTests.RosterEntryPattern, entry));
            Assert.All(roster, entry => Assert.Equal("0", entry.Split('|')[1]));

            var opensIn = roster.Select(e => long.Parse(e.Split('|')[2], System.Globalization.CultureInfo.InvariantCulture)).ToList();
            Assert.Equal(opensIn.OrderBy(x => x), opensIn);

            sawFull |= roster.Count == DeviceGateRosterBuilder.GateRosterMaxEntries;
        }

        Assert.True(sawFull, "no gate heartbeat vector fills the roster to GateRosterMaxEntries; the cap is not pinned");
    }

    /// <summary>
    /// The server's limits are the contract's. Both are constants on the builder because
    /// the firmware buffer is sized to them, and a tenant setting cannot resize a buffer
    /// in a doorway.
    /// </summary>
    [Fact]
    public void Gate_roster_constants_match_the_firmware_buffer()
    {
        Assert.Equal(48, DeviceGateRosterBuilder.GateRosterMaxEntries);          // Roster<48>
        Assert.Equal(20, DeviceRosterBuilder.MaxTokenLength);                    // roster::kMaxTokenLen, shared
        Assert.True(AccessCode.Length <= DeviceRosterBuilder.MaxTokenLength);
    }

    /// <summary>
    /// The byte budget is a budget for the WIDEST body the server can emit, not for a
    /// comfortable one — so the vector that declares it has to be that body.
    ///
    /// <para>
    /// Every field in <c>gate-heartbeat-response-roster-full</c> is at its column bound or
    /// its arithmetic maximum: a 64-character tenant slug and gate key, the long
    /// <c>gate-&lt;full mac&gt;</c> device code, a full 48 entries, and six-digit relative
    /// seconds. If a later edit softens any of those, this fails rather than leaving a
    /// budget that no longer bounds anything.
    /// </para>
    /// </summary>
    [Fact]
    public void The_byte_budget_is_declared_against_the_widest_body_the_server_can_emit()
    {
        var full = Of("responses", "heartbeat").Single(c => Id(c) == "gate-heartbeat-response-roster-full");
        using var body = JsonDocument.Parse(Hex(full, "body_hex"));
        var root = body.RootElement;

        Assert.Equal(4096, full.GetProperty("expect").GetProperty(MaxBytesKey).GetInt32());
        Assert.Equal(64, root.GetProperty("tenant_slug").GetString()!.Length);
        Assert.Equal(64, root.GetProperty("gate_key").GetString()!.Length);
        Assert.Equal($"gate-{Corpus.GetProperty("device_mac").GetString()}", root.GetProperty("device_code").GetString());

        var roster = root.GetProperty("roster").EnumerateArray().Select(e => e.GetString()!).ToList();
        Assert.Equal(DeviceGateRosterBuilder.GateRosterMaxEntries, roster.Count);
        Assert.All(roster, e => Assert.Equal(AccessCode.Length, e.Split('|')[0].Length));
        Assert.Contains(roster, e => e.Split('|')[3].Length >= 6);
        Assert.Contains(roster, e => e.Split('|')[2].StartsWith('-'));
    }

    // ---- The anti-drift assertion --------------------------------------------

    /// <summary>
    /// A section present in the corpus but absent from the manifest — or the other way —
    /// means someone added cases without declaring them, and a side that silently skips
    /// what it does not recognise would still pass every test above.
    /// </summary>
    [Fact]
    public void Every_corpus_section_is_declared_and_non_empty()
    {
        var sections = Corpus.EnumerateObject()
            .Where(p => p.Value.ValueKind == JsonValueKind.Array)
            .Select(p => p.Name)
            .ToList();

        var declared = Manifest.GetProperty("case_count").EnumerateObject().Select(p => p.Name).ToList();

        Assert.Equal(sections.Order(), declared.Order());
        Assert.All(sections, s =>
        {
            Assert.True(Corpus.GetProperty(s).GetArrayLength() > 0, $"Corpus section '{s}' is empty.");
            Assert.Equal(Corpus.GetProperty(s).GetArrayLength(), Declared(s));
        });
    }

    /// <summary>
    /// The gate family is its own. Adding a gate case to <c>http/</c> would make the court
    /// box's C++ suite red on a board with no gate code in it — the reason the families are
    /// split at all — so the court box's declared counts are pinned here, where a careless
    /// edit would land.
    /// </summary>
    [Fact]
    public void Adding_a_gate_case_did_not_touch_the_court_boxs_family()
    {
        var courtBox = JsonDocument.Parse(File.ReadAllText(Path.Combine(
            Directory.GetParent(ContractRoot())!.FullName, "http", "manifest.json"))).RootElement;

        // 7 and 19 since the device-link round: three request vectors (restored_relays,
        // relay_state, and the court box's event body carrying a real boot_id) and ten
        // response vectors (five for the power-dip relay restore, two for the nine `config`
        // settings, three for `member_display`). Four more requests in R15 D15-1: the activate,
        // walk-up and pay-for bodies and the event body carrying a scan with a quote, a backslash
        // and two bytes above 0x7F, escaped. 12 and 25 since scan-to-extend: the extend body, five
        // extend answers (ok, truncated, court_not_lit, no_time_available, insufficient_balance)
        // and the activate answer carrying greeting_name and balance_minutes.
        // 18 and 36 since device contract v3: the v3 heartbeat request, first beat, roll-back,
        // relight, telemetry and widest requests plus the release cause (seven), the pay-for
        // request leaving with D10 (one), and eleven v3 responses (snapshot, unacknowledged,
        // display expanded and out of range, OTA offer, key_next, net, widest, play_remaining,
        // hardware, lifeline-only).
        Assert.Equal(18, courtBox.GetProperty("case_count").GetProperty("requests").GetInt32());
        Assert.Equal(36, courtBox.GetProperty("case_count").GetProperty("responses").GetInt32());
    }

    /// <summary>
    /// A v3 vector's gate settings and lifeline objects, as the server would be handed them — null
    /// for a 1.x vector, whose bytes the server must reproduce unchanged (device-api.md §1).
    /// </summary>
    private static GateV3Parts? V3PartsOf(JsonElement root)
    {
        var gate = root.GetProperty("gate");
        GateV3Settings? settings = gate.TryGetProperty("power_restore_trust_minutes", out var trust)
            ? new GateV3Settings(
                trust.GetInt32(),
                gate.GetProperty("net_fallback_minutes").GetInt32(),
                gate.GetProperty("ota_probation_minutes").GetInt32(),
                gate.GetProperty("device_fault_reporting").GetBoolean(),
                gate.GetProperty("device_fault_max_per_hour").GetInt32())
            : null;

        System.Text.Json.Nodes.JsonObject? Obj(string name) =>
            root.TryGetProperty(name, out var o) ? System.Text.Json.Nodes.JsonNode.Parse(o.GetRawText())!.AsObject() : null;
        var lifeline = new DeviceLifeline(Obj("ota"), Obj("key_next"), Obj("net"));
        return settings is null && !lifeline.Any ? null : new GateV3Parts(settings, lifeline);
    }

    private static string Body(string section, string id) =>
        System.Text.Encoding.UTF8.GetString(Hex(Section(section).Single(c => Id(c) == id), "body_hex"));
}
