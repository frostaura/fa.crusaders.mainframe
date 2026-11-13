import { describe, expect, it, afterEach, vi } from "vitest";
import { ApiError, endpoints } from "./api";
import { stubFetch } from "../test/harness";
import {
  applyDevicePatch, deviceFixture, deviceServer, gateFixture, refuseDevicePatch,
  DEVICE_API_KEY_FIXTURE,
} from "../test/harness";

/**
 * The device wrappers, pinned to their routes.
 *
 * <p>
 * These are the whole of the device contract as the frontend sees it, and the page tests
 * cannot pin them: a stub keyed on `startsWith("/api/v1/admin/devices/")` answers a
 * misspelt path just as happily as a correct one. What is asserted here is the exact
 * string, the method and the body shape — the three things that go silently wrong when a
 * contract is being rewritten on both sides at once.
 * </p>
 *
 * <p>
 * The removed half matters as much as the kept half. There is no discovery list, no
 * claim, no manual register and no revoke, because the boxes carry the club key and
 * register themselves; since v3 the key changes by rotation with an overlap, never by Regenerate. A wrapper for any of those coming back
 * would mean the old contract came back with it.
 * </p>
 */
describe("device API wrappers", () => {
  afterEach(() => vi.unstubAllGlobals());

  const ID = "11111111-1111-1111-1111-111111111111";

  it("lists devices", async () => {
    const stub = stubFetch([{ path: "/api/v1/admin/devices/", body: [deviceFixture()] }]);
    await endpoints.adminDevicesList();
    expect(stub.calls[0]).toMatchObject({ method: "GET", path: "/api/v1/admin/devices/" });
  });

  it("reads the club's device API key", async () => {
    const stub = stubFetch([{ path: "/api/v1/admin/devices/api-key", body: DEVICE_API_KEY_FIXTURE }]);
    const key = await endpoints.adminDeviceApiKey();
    expect(stub.calls[0]).toMatchObject({ method: "GET", path: "/api/v1/admin/devices/api-key" });
    expect(key.api_key).toBe(DEVICE_API_KEY_FIXTURE.api_key);
    expect(key.regenerated_at).toBe(DEVICE_API_KEY_FIXTURE.regenerated_at);
  });

  it("has no Regenerate: a key changes by rotation, retirement or restore (device-api §6)", async () => {
    // Regenerate killed the old key at once and forced a reflash of every board (BA-01).
    expect((endpoints as Record<string, unknown>).adminDeviceApiKeyRegenerate).toBeUndefined();
    const stub = stubFetch([
      { method: "POST", path: "/api/v1/admin/devices/api-key/rotate", body: DEVICE_API_KEY_FIXTURE },
      { method: "POST", path: "/api/v1/admin/devices/api-key/retire", body: DEVICE_API_KEY_FIXTURE },
      { method: "POST", path: "/api/v1/admin/devices/api-key/restore", body: DEVICE_API_KEY_FIXTURE },
    ]);
    await endpoints.adminDeviceApiKeyRotate();
    await endpoints.adminDeviceApiKeyRetire();
    await endpoints.adminDeviceApiKeyRetire("k1");
    await endpoints.adminDeviceApiKeyRestore("A".repeat(43), "RESTORE");
    expect(stub.calls.map((c) => [c.method, c.path])).toEqual([
      ["POST", "/api/v1/admin/devices/api-key/rotate"],
      ["POST", "/api/v1/admin/devices/api-key/retire"],
      ["POST", "/api/v1/admin/devices/api-key/retire"],
      ["POST", "/api/v1/admin/devices/api-key/restore"],
    ]);
    // Retire without a confirmation asks the API who it would strand; with one, it names the key.
    expect(stub.calls[1].raw).toBe("{}");
    expect(stub.calls[2].body).toEqual({ confirm: "k1" });
    expect(stub.calls[3].body).toEqual({ key: "A".repeat(43), confirm: "RESTORE" });
  });

  it("sends the v3 per-board overrides three-valued, and a network push", async () => {
    const stub = stubFetch([{ method: "PATCH", path: "/api/v1/admin/devices/", body: deviceFixture() }]);
    await endpoints.adminDeviceUpdate(ID, { lcd_layout: null });
    await endpoints.adminDeviceUpdate(ID, { lcd_layout: "compact", lcd_marquee_enabled: false });
    await endpoints.adminDeviceUpdate(ID, { push_network: true });
    expect(stub.calls.map((c) => c.raw)).toEqual([
      '{"lcd_layout":null}', '{"lcd_layout":"compact","lcd_marquee_enabled":false}', '{"push_network":true}',
    ]);
  });

  it("reads and saves the club network, and rolls a firmware release out", async () => {
    const stub = stubFetch([
      { path: "/api/v1/admin/devices/network", body: { ver: 1, base: null, wifi: [], updated_at: null, updated_by: null } },
      { method: "PUT", path: "/api/v1/admin/devices/network", body: { ver: 2, base: "http://10.0.0.5", wifi: [], updated_at: null, updated_by: null } },
      { path: "/api/v1/admin/devices/firmware", body: [] },
      { method: "PATCH", path: "/api/v1/admin/devices/firmware/", body: {} },
      { path: "/api/v1/admin/devices/member-codes", body: {} },
    ]);
    await endpoints.adminDeviceNetwork();
    await endpoints.adminDeviceNetworkSave({ ver: 1, base: "http://10.0.0.5", wifi: [{ ssid: "CLUB", psk: null }] });
    await endpoints.adminFirmwareList();
    await endpoints.adminFirmwareRollout("r1", { rollout: "one", device_id: ID });
    await endpoints.adminMemberCodeRollout();
    expect(stub.calls.map((c) => [c.method, c.path])).toEqual([
      ["GET", "/api/v1/admin/devices/network"],
      ["PUT", "/api/v1/admin/devices/network"],
      ["GET", "/api/v1/admin/devices/firmware"],
      ["PATCH", "/api/v1/admin/devices/firmware/r1"],
      ["GET", "/api/v1/admin/devices/member-codes"],
    ]);
    // A null password keeps the stored one: it is sent as null, never dropped.
    expect(stub.calls[1].raw).toBe('{"ver":1,"base":"http://10.0.0.5","wifi":[{"ssid":"CLUB","psk":null}]}');
  });

  it("PATCHes only the keys the caller named", async () => {
    const stub = stubFetch([{ method: "PATCH", path: "/api/v1/admin/devices/", body: deviceFixture() }]);

    await endpoints.adminDeviceUpdate(ID, { name: "Court 1 box", court_numbers: [1, 2] });
    expect(stub.calls[0].path).toBe(`/api/v1/admin/devices/${ID}`);
    // court_numbers is snake_case because the API pins that one property name.
    expect(stub.calls[0].body).toEqual({ name: "Court 1 box", court_numbers: [1, 2] });

    // Three-valued button_map: absent leaves the override alone, null clears it. A key
    // that was never sent and a key sent as undefined are indistinguishable once
    // parsed, so the assertion is on the wire text.
    await endpoints.adminDeviceUpdate(ID, { button_map: null });
    expect(stub.calls[1].raw).toBe('{"button_map":null}');

    await endpoints.adminDeviceUpdate(ID, { name: "Annex box" });
    expect(stub.calls[2].raw).toBe('{"name":"Annex box"}');
  });

  /**
   * `gate_key` is TWO-valued on the wire, and that is the correction.
   *
   * <p>
   * It was written here as three-valued "exactly as `button_map` does", and it is not.
   * `DeviceRegistryService.UpdateAsync` reads it
   * <code>if (cmd.GateKey is not null) device.GateKey = cmd.GateKey.Length == 0 ? null : cmd.GateKey</code>,
   * so `null` and ABSENT are the same instruction — leave the door's name alone — and `""`
   * is the only value that clears it. The page sent `null` to clear a name and cleared
   * nothing, silently, while this test and the page test both stayed green: each asserted
   * the wire text against a stub that answered with a cleared row whatever it was handed.
   * </p>
   *
   * <p>
   * So the assertion is now on the OUTCOME as a server that applies the API's own rule
   * produces it ({@link applyDevicePatch}), with the wire text kept beside it — a key never
   * sent and a key sent as undefined parse to the same object, so absence is only provable
   * in the serialised text.
   * </p>
   */
  it("clears a door name with an empty string, because null means unchanged", async () => {
    const named = deviceFixture({ kind: "Gate", court_numbers: [], gate_key: "front-door" });
    const stub = stubFetch([{
      method: "PATCH",
      path: "/api/v1/admin/devices/",
      respond: (request) => applyDevicePatch(named, (request.body ?? {}) as Record<string, unknown>),
    }]);

    const set = await endpoints.adminDeviceUpdate(ID, { name: "Door gate", gate_key: "side-door" });
    expect(stub.calls[0].path).toBe(`/api/v1/admin/devices/${ID}`);
    expect(stub.calls[0].raw).toBe('{"name":"Door gate","gate_key":"side-door"}');
    expect(set.gate_key).toBe("side-door");

    // The clear. `""` on the wire, and the row that comes back has no name — which is the
    // half a canned response could not have told apart from the no-op below.
    const cleared = await endpoints.adminDeviceUpdate(ID, { name: "Door gate", gate_key: "" });
    expect(stub.calls[1].raw).toBe('{"name":"Door gate","gate_key":""}');
    expect(cleared.gate_key).toBeNull();

    // A PATCH about something else must not carry the key at all — and if it did carry it as
    // null the server would ignore it, which is why null must never be how a clear is spelt.
    await endpoints.adminDeviceUpdate(ID, { enabled: false });
    expect(stub.calls[2].raw).toBe('{"enabled":false}');
    expect(stub.calls[2].raw).not.toContain("gate_key");
  });

  /**
   * And the type refuses the value that caused it. `null` is not a clear and never was, so a
   * caller that spells one that way is a compile error rather than a silent no-op a test has
   * to catch afterwards.
   */
  it("has no way to spell a clear as null", async () => {
    const stub = stubFetch([{ method: "PATCH", path: "/api/v1/admin/devices/", body: deviceFixture() }]);
    // @ts-expect-error null means "unchanged" on this field, so it is not an accepted value.
    await endpoints.adminDeviceUpdate(ID, { gate_key: null });
    expect(stub.calls[0].raw).toBe('{"gate_key":null}');
  });

  /**
   * `kind` is on neither this request nor the API's. A board's kind is set by its first
   * heartbeat and changing it means deleting the row, so a wrapper that accepted one would be
   * a field the server silently ignores — which is worse than no field, because the screen
   * would report a save that did nothing.
   */
  it("has no way to send a device kind", async () => {
    const stub = stubFetch([{ method: "PATCH", path: "/api/v1/admin/devices/", body: deviceFixture() }]);
    await endpoints.adminDeviceUpdate(ID, { name: "Door gate", gate_key: "front-door" });
    expect(stub.calls[0].raw).not.toContain("kind");
  });

  it("DELETEs one device by id", async () => {
    const stub = stubFetch([{ method: "DELETE", path: "/api/v1/admin/devices/", body: { deleted: true } }]);
    await endpoints.adminDeviceDelete(ID);
    expect(stub.calls[0]).toMatchObject({ method: "DELETE", path: `/api/v1/admin/devices/${ID}` });
  });

  it("has no wrapper left for discovery, claiming, registering, rotating or revoking", () => {
    const surface = endpoints as unknown as Record<string, unknown>;
    for (const gone of [
      "adminDevicesDiscovered",
      "adminDiscoveryStatus",
      "adminDeviceClaim",
      "adminDeviceRegister",
      "adminDeviceRotateKey",
      "adminDeviceRevoke",
    ]) {
      expect(surface[gone]).toBeUndefined();
    }
  });
});

/**
 * <b>The stateful mock has to refuse what the API refuses, or it pins a convenient API.</b>
 *
 * <p>
 * {@link deviceServer} applies the API's own patch rule, which is what caught the `gate_key`
 * no-op. It applied only the rule that had just gone wrong, though, and was otherwise a
 * server that says yes: it accepted `gate_key` on a court box, court fields on a gate and a
 * door name of any length at all. A page test written on it therefore proved that the screen
 * handles a success the real API would never send — which is the same class of green the
 * gate-key round was about, one field along.
 * </p>
 *
 * <p>
 * Mirrored from <c>AdminDeviceEndpoints.KindFieldsRefusal</c> and
 * <c>DeviceRegistryService.UpdateAsync</c>, <b>including their order</b>: the kind refusals
 * run before the length bound, and before the button map is parsed at all.
 * </p>
 */
describe("refuseDevicePatch", () => {
  const box = deviceFixture();
  const gate = gateFixture();

  /**
   * A door name on a court box. Refusing rather than ignoring is the API's own choice, and
   * the reason is that a PATCH reporting success while changing nothing is the worst of the
   * three available answers.
   */
  it("refuses a door name on a court box", () => {
    expect(refuseDevicePatch(box, { gate_key: "front-door" }))
      .toMatchObject({ status: 400, body: { error: "gate_key_not_a_gate" } });
    // Including the clear, which is a real instruction and still not one a box can take.
    expect(refuseDevicePatch(box, { gate_key: "" })?.body).toEqual({ error: "gate_key_not_a_gate" });
  });

  /**
   * And NOT when the key is null or absent. The API binds `gate_key` as a nullable string and
   * asks `req.GateKey is null` — so a JSON null and an omitted key are the same thing to it,
   * which is the whole reason `null` cannot spell a clear. A mock that refused null here
   * would make the two distinguishable and would pin a contract the API does not have.
   */
  it("reads a null door name as an absence, on either kind of board", () => {
    expect(refuseDevicePatch(box, { gate_key: null })).toBeNull();
    expect(refuseDevicePatch(box, { name: "Annex box", court_numbers: [2] })).toBeNull();
    expect(refuseDevicePatch(gate, { gate_key: null })).toBeNull();
  });

  it("refuses court numbers and button maps on a gate", () => {
    expect(refuseDevicePatch(gate, { court_numbers: [1] })?.body).toEqual({ error: "court_fields_on_a_gate" });
    expect(refuseDevicePatch(gate, { button_map: ["court:A"] })?.body).toEqual({ error: "court_fields_on_a_gate" });
    // A present-but-null button map counts as sent. On a box that means "run the club's
    // map", which is a real instruction; on a gate there is no map to run, so the request is
    // as wrong as a list would be — and the API's `ValueKind != Undefined` says exactly that.
    expect(refuseDevicePatch(gate, { button_map: null })?.body).toEqual({ error: "court_fields_on_a_gate" });
    // An empty list is still a list.
    expect(refuseDevicePatch(gate, { court_numbers: [] })?.body).toEqual({ error: "court_fields_on_a_gate" });
  });

  /**
   * The 64-character bound, measured AFTER the trim — the endpoint trims before it measures
   * (`key.Trim().Length > Device.GateKeyMaxLength`), so a name that only exceeds the column
   * because somebody pasted a trailing space is not refused.
   */
  it("bounds a door name at 64 characters, after trimming", () => {
    expect(refuseDevicePatch(gate, { gate_key: "x".repeat(64) })).toBeNull();
    expect(refuseDevicePatch(gate, { gate_key: `  ${"x".repeat(64)}  ` })).toBeNull();
    expect(refuseDevicePatch(gate, { gate_key: "x".repeat(65) }))
      .toMatchObject({ status: 400, body: { error: "gate_key_too_long", max_length: 64 } });
  });

  /**
   * <b>The order is the API's.</b> `KindFieldsRefusal` answers the court-field refusal before
   * it reaches the length check, so a request carrying both is refused for the field that
   * does not belong rather than for the length — and a screen decoding the token gets the
   * sentence that tells the admin what is actually wrong with the row.
   */
  it("answers the kind refusal before the length one when a request carries both", () => {
    expect(refuseDevicePatch(gate, { court_numbers: [1], gate_key: "x".repeat(200) })?.body)
      .toEqual({ error: "court_fields_on_a_gate" });
  });
});

/**
 * What {@link applyDevicePatch} does once nothing is refused — mirrored from
 * `DeviceRegistryService.UpdateAsync` rather than from what a page happens to need.
 */
describe("applyDevicePatch", () => {
  /**
   * <b>`auto_registered` goes false on every edit, whatever the edit was.</b>
   *
   * <p>
   * `UpdateAsync` sets it unconditionally — it is not guarded by which field changed, and it
   * is not guarded by anything changing at all. The badge it drives says "nobody has checked
   * this row yet", and an admin who has PATCHed the row has checked it. A mock that left the
   * flag alone would let a page test assert a badge the real API had already cleared.
   * </p>
   */
  it("clears auto_registered on any edit at all", () => {
    const fresh = gateFixture({ auto_registered: true });
    expect(applyDevicePatch(fresh, { gate_key: "front-door" }).auto_registered).toBe(false);
    // Including a PATCH that changes nothing else: the API does not ask what moved.
    expect(applyDevicePatch(fresh, { enabled: true }).auto_registered).toBe(false);
    expect(applyDevicePatch(fresh, {}).auto_registered).toBe(false);
    // And the fixture is not mutated, so a test can reuse it.
    expect(fresh.auto_registered).toBe(true);
  });

  /** `device.Name = cmd.Name.Trim()`, which the mock did not do. */
  it("trims the board's name the way the API stores it", () => {
    expect(applyDevicePatch(deviceFixture(), { name: "  Annex box  " }).name).toBe("Annex box");
  });
});

/**
 * And the whole thing wired up: the stateful server answers 400 and holds its row.
 */
describe("deviceServer", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("answers a refused PATCH with the API's status and token, and does not move the row", async () => {
    const server = deviceServer(gateFixture({ gate_key: "front-door" }));
    stubFetch(server.routes);

    await expect(endpoints.adminDeviceUpdate(gateFixture().id as string, { court_numbers: [1] }))
      .rejects.toBeInstanceOf(ApiError);
    // The row is untouched — a refused PATCH that half-applied would be a mock inventing a
    // failure mode the API does not have.
    expect(server.current().gate_key).toBe("front-door");
    expect(server.current().court_numbers).toEqual([]);
  });

  it("carries the refusal's payload through, so a screen can decode the token", async () => {
    const server = deviceServer(deviceFixture());
    stubFetch(server.routes);

    const error = await endpoints.adminDeviceUpdate(deviceFixture().id as string, { gate_key: "front-door" })
      .catch((e: unknown) => e as ApiError);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect((error as ApiError).payload).toMatchObject({ error: "gate_key_not_a_gate" });
  });

  /**
   * A board whose kind changed under the open form — the one legitimate route to these
   * refusals, and the reason the screen decodes them at all rather than treating them as
   * unreachable. Deleting a row and letting the board register itself again is how a
   * misconfigured board is reset, and it is the only way a row's kind changes.
   */
  it("lets a test re-kind the row the way a delete and re-register would", async () => {
    const server = deviceServer(gateFixture({ gate_key: "front-door" }));
    stubFetch(server.routes);

    server.replace(deviceFixture({ id: gateFixture().id }));
    const error = await endpoints.adminDeviceUpdate(gateFixture().id as string, { gate_key: "side-door" })
      .catch((e: unknown) => e as ApiError);
    expect((error as ApiError).payload).toMatchObject({ error: "gate_key_not_a_gate" });
  });
});

