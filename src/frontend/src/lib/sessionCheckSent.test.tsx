import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { renderPage, signIn, signOut, stubFetch } from "../test/harness";
import { whenSessionCheckSent } from "./auth";

/**
 * Perf lane (2026-09-30) — the opened page's code waits for the session check to be SENT, never
 * for its answer, and never goes ahead of it on the phone's few connections.
 */
afterEach(() => { vi.unstubAllGlobals(); signOut(); });

describe("whenSessionCheckSent", () => {
  it("runs once whoami is on its way — before it has answered — and only once", async () => {
    const session = signIn({ isAdmin: false });
    let answer: (() => void) | null = null;
    const stub = stubFetch([{ path: "/api/v1/whoami", body: session }]);
    const answered = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      (String(input).startsWith("/api/v1/whoami")
        ? new Promise<Response>((resolve) => { answer = () => resolve(answered(input, init) as unknown as Response); })
        : answered(input, init)));
    const seen: number[] = [];
    whenSessionCheckSent(() => { seen.push(stub.calls.length); });
    renderPage(<p>page</p>);
    await waitFor(() => expect(seen).toHaveLength(1));
    // whoami was sent (it is the stub's first call once answered) and has NOT answered yet.
    expect(answer).not.toBeNull();
    (answer as unknown as () => void)();
    await waitFor(() => expect(stub.calls.some((c) => c.path === "/api/v1/whoami")).toBe(true));
    expect(seen).toHaveLength(1);
  });
});
