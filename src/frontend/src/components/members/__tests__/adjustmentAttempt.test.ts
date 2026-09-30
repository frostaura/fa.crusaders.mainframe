import { afterEach, describe, expect, it, vi } from "vitest";
import { attemptAdjustment } from "../adjustmentAttempt";
import { refuse, signIn, signOut, stubFetch } from "../../../test/harness";

/**
 * R4 I4-4: a 429 on the desk top-up read "The club refused that adjustment" — a refusal of THIS
 * movement, when the club had only turned a press away for coming too fast. It now says to wait,
 * for how long, and that nothing changed; and the ledger is not asked, because nothing was read.
 */
describe("the desk adjustment under the club's rate limit", () => {
  afterEach(() => { vi.unstubAllGlobals(); signOut(); });

  it("says to wait, with the club's own wait, and that nothing changed", async () => {
    signIn({ isAdmin: true });
    const stub = stubFetch([
      { method: "POST", path: "/api/v1/admin/credit/u1/adjust", respond: () => refuse(429, { error: "rate_limited", retry_after_seconds: 12 }) },
    ]);
    const outcome = await attemptAdjustment(
      { userId: "u1", name: "Ada", amount: 100, reasonCode: "goodwill", reason: "Court light fault" },
      { current: null },
    );
    expect(outcome).toMatchObject({
      kind: "failed", unchanged: true,
      message: "Too many requests right now — wait 12 seconds and try again. Nothing was changed.",
    });
    expect(JSON.stringify(outcome)).not.toMatch(/refused/);
    expect(stub.calls.some((c) => c.path.startsWith("/api/v1/admin/ledger"))).toBe(false);
  });
});
