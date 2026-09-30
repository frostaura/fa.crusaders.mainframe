import { afterEach, describe, expect, it, vi } from "vitest";
import { endpoints } from "./api";
import { signIn, signOut, stubFetch } from "../test/harness";

afterEach(() => { vi.unstubAllGlobals(); signOut(); });

describe("the day's schedule read", () => {
  it("asks for faces as photo URLs, not a base64 image per slot (perf round)", async () => {
    signIn({ isAdmin: false });
    const stub = stubFetch([{ path: "/api/v1/schedule", body: { date: "2030-09-09", courts: [], slots: [] } }]);
    await endpoints.schedule("2030-09-09");
    expect(stub.calls[0].path).toBe("/api/v1/schedule?date=2030-09-09&photos=url");
  });
});
