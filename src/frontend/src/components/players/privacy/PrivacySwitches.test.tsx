import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { PRIVACY_COPY as COPY } from "@/lib/playersCopy";
import { refuse, renderPage, signIn, signOut, stubFetch, type StubRoute } from "@/test/harness";
import { PrivacySwitches } from "./PrivacySwitches";

/**
 * D13 — the two social switches: off by default, a flip shows at once and is written as a
 * one-field PUT, and a refusal puts the switch back and says so beside it.
 */

function routes(prefs: Record<string, unknown>, put: StubRoute["respond"]): StubRoute[] {
  return [
    { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
    { path: "/api/v1/me/preferences", body: prefs },
    { method: "PUT", path: "/api/v1/me/preferences", respond: put },
  ];
}

const switchNamed = (label: string) => screen.findByRole("switch", { name: label });

afterEach(() => { vi.unstubAllGlobals(); signOut(); });

describe("the privacy switches", () => {
  it("is off by default, labelled and described — and the leaderboards switch waits for leaderboards", async () => {
    stubFetch(routes({ theme: "system" }, () => ({})));
    renderPage(<PrivacySwitches />, { reactStrictMode: true });
    const findable = await switchNamed(COPY.findableLabel);
    expect(findable).toHaveAttribute("aria-checked", "false");
    expect(findable).toHaveAccessibleDescription(COPY.findableHint);
    expect(screen.queryByRole("switch", { name: COPY.leaderboardsLabel })).toBeNull();
    expect(screen.getAllByRole("switch")).toHaveLength(1);
  });

  it("never sends the hidden leaderboards preference — what is stored stays as it is", async () => {
    const stub = stubFetch(routes({ findable: false, show_in_leaderboards: true }, () => ({ findable: true })));
    renderPage(<PrivacySwitches />);
    fireEvent.click(await switchNamed(COPY.findableLabel));
    await waitFor(() => expect(stub.calls.some((c) => c.method === "PUT")).toBe(true));
    expect(stub.calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([{ findable: true }]);
  });

  it("shows what the server holds", async () => {
    stubFetch(routes({ findable: true, show_in_leaderboards: false }, () => ({})));
    renderPage(<PrivacySwitches />);
    expect(await switchNamed(COPY.findableLabel)).toHaveAttribute("aria-checked", "true");
  });

  it("flips at once and sends only the field it changed", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const stub = stubFetch(routes({ findable: false, show_in_leaderboards: false }, () => ({ findable: true })));
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => (init?.method === "PUT"
      ? gate.then(() => realFetch(input, init))
      : realFetch(input, init)));
    renderPage(<PrivacySwitches />);

    const findable = await switchNamed(COPY.findableLabel);
    fireEvent.click(findable);
    // Optimistic: on before the server has answered, and marked busy.
    expect(findable).toHaveAttribute("aria-checked", "true");
    expect(findable).toHaveAttribute("aria-busy", "true");
    release();
    await waitFor(() => expect(findable).not.toHaveAttribute("aria-busy"));
    expect(findable).toHaveAttribute("aria-checked", "true");
    const put = stub.calls.find((c) => c.method === "PUT")!;
    expect(put.body).toEqual({ findable: true });
  });

  it("puts the switch back on a refusal, and says so beside it", async () => {
    stubFetch(routes({ findable: false, show_in_leaderboards: false }, () => refuse(500, { error: "server_error" })));
    renderPage(<PrivacySwitches />);
    const findable = await switchNamed(COPY.findableLabel);
    fireEvent.click(findable);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(COPY.saveFailed(COPY.findableLabel));
    expect(findable).toHaveAttribute("aria-checked", "false");
    expect(within(findable.closest("li")!).getByRole("alert")).toBe(alert);
  });

  it("says a failed read failed rather than showing two switches that are guessing", async () => {
    stubFetch(routes({}, () => ({})).map((r) => (r.method === undefined && r.path === "/api/v1/me/preferences" ? { ...r, status: 500, body: { error: "down" } } : r)));
    renderPage(<PrivacySwitches />);
    expect(await screen.findByText(new RegExp(`Couldn't ${COPY.readAction}`))).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
  });
});
