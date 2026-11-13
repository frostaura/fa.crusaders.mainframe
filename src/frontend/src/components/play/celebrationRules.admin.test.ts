import { describe, expect, it } from "vitest";
import { isQuietPath } from "./celebrationRules";

/** BA-24: a member's badge moment never covers the admin console; it waits until the admin leaves. */
describe("where a celebration may not appear", () => {
  it("is quiet across the admin console", () => {
    for (const path of ["/admin", "/admin/members", "/admin/settings", "/admin/monitoring/devices"]) {
      expect(isQuietPath(path), path).toBe(true);
    }
  });

  it("still celebrates on a member's own pages, and is not fooled by a lookalike", () => {
    for (const path of ["/book", "/play", "/wallet", "/administrator", "/admins"]) {
      expect(isQuietPath(path), path).toBe(false);
    }
  });
});
