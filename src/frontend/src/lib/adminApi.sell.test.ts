import { afterEach, describe, expect, it, vi } from "vitest";
import { adminEndpoints } from "./adminApi";
import { stubFetch } from "../test/harness";

/**
 * R9 J9-1, on the wire: the desk sheet passed `quotedPriceZar` to `sellPackage`, but the body this
 * module built dropped it, so the server never saw the price the admin confirmed and its 409
 * `package_price_changed` could not fire. The sheet's own test spied on the call's arguments, not
 * on the request — this one reads what is actually sent.
 */
afterEach(() => { vi.unstubAllGlobals(); });

describe("adminEndpoints.sellPackage", () => {
  it("sends the price the desk was shown, and the rand taken", async () => {
    const USER = "44444444-4444-4444-4444-444444444444";
    const stub = stubFetch([{ path: `/api/v1/admin/minutes/${USER}/sell`, method: "POST", body: {} }]);
    await adminEndpoints.sellPackage(USER, {
      packageId: "p1", reasonCode: "top_up_cash", reason: "", quotedPriceZar: 108, zarReceived: 108, idempotencyKey: "k1",
    });
    const call = stub.calls.find((c) => c.path.endsWith("/sell"))!;
    expect(call.body).toMatchObject({ packageId: "p1", quotedPriceZar: 108, zarReceived: 108 });
  });
});
