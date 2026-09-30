import { StrictMode } from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { resetRefreshBackoff, tokenStore } from "@/lib/api";
import { rateLimitedSentence } from "@/lib/errors";
import { CONNECTION_COPY } from "@/lib/shellCopy";

/**
 * V-10 (review round 3) — the club's rate limit is not an outage.
 *
 * <p>
 * The reviewers shared one admin and hit the per-account limit: the bootstrap probe came back
 * `429 { error: "rate_limited", retry_after_seconds }` and the app said "Can't reach the club
 * right now … once the connection is back" — a connection that was fine, to a club that had
 * answered. `lib/errors` has had the true sentence since B-10; the session screen now says it.
 * </p>
 */

function answering(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
    ok: status < 400,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as unknown as Response)));
}

describe("the session screen while the club is not confirming a session", () => {
  beforeEach(() => {
    localStorage.clear();
    resetRefreshBackoff();
    tokenStore.set("member.jwt.value");
    window.history.pushState({}, "", "/wallet");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    tokenStore.clear();
    resetRefreshBackoff();
    window.history.pushState({}, "", "/");
  });

  it("says the club is busy, with its wait, when it answers 429", async () => {
    answering(429, { error: "rate_limited", retry_after_seconds: 12 });
    render(<StrictMode><App /></StrictMode>);

    expect(await screen.findByRole("heading", { name: CONNECTION_COPY.busyTitle }, { timeout: 4_000 })).toBeInTheDocument();
    expect(screen.getByText(rateLimitedSentence(12), { exact: false })).toBeInTheDocument();
    expect(screen.queryByText(/Can't reach the club/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/connection is back/i)).not.toBeInTheDocument();
    // Still signed in, and still a way to ask again.
    expect(screen.getByRole("button", { name: CONNECTION_COPY.retry })).toBeInTheDocument();
  });

  it("still says it cannot reach the club when the club is down", async () => {
    answering(503, { error: "unavailable" });
    render(<StrictMode><App /></StrictMode>);

    expect(await screen.findByRole("heading", { name: CONNECTION_COPY.unreachableTitle }, { timeout: 4_000 })).toBeInTheDocument();
    expect(screen.queryByText(/Too many requests/i)).not.toBeInTheDocument();
  });
});
