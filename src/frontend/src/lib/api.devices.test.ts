import { describe, expect, it, afterEach, vi } from "vitest";
import { endpoints } from "./api";
import { stubFetch } from "../test/harness";
import { applyDevicePatch, deviceFixture, DEVICE_API_KEY_FIXTURE } from "../test/harness";

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
 * claim, no manual register, no rotate-key and no revoke, because the boxes now carry
 * one static club key and register themselves. A wrapper for any of those coming back
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

  it("regenerates the club's device API key", async () => {
    const stub = stubFetch([
      { method: "POST", path: "/api/v1/admin/devices/api-key/regenerate", body: DEVICE_API_KEY_FIXTURE },
    ]);
    await endpoints.adminDeviceApiKeyRegenerate();
    expect(stub.calls[0]).toMatchObject({ method: "POST", path: "/api/v1/admin/devices/api-key/regenerate" });
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
