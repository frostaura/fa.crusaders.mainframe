import { describe, expect, it, afterEach, vi } from "vitest";
import { endpoints } from "./api";
import { stubFetch } from "../test/harness";
import { deviceFixture, DEVICE_API_KEY_FIXTURE } from "../test/harness";

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
