import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ApiError } from "@/lib/api";
import { SERVICE_BUSY_CAUSE } from "@/lib/errors";
import { CONNECTION_COPY } from "@/lib/shellCopy";
import { ConnectionLost } from "./SessionScreens";

/**
 * R19 X19-1.1 — the session check answered `503 service_busy` (every connection in use) or
 * `503 conflict_retry` (a clash that passes): the club ANSWERED, busy, exactly like a 429. The
 * screen said "Can't reach the club right now … the connection is back" with a no-Wi-Fi icon,
 * blaming a connection that was fine.
 */
afterEach(() => vi.restoreAllMocks());

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

describe("ConnectionLost — a passing 503 is busy, not unreachable", () => {
  it.each(["service_busy", "conflict_retry"])("503 %s: the busy title and the busy cause", (code) => {
    render(<ConnectionLost onRetry={() => {}} cause={new ApiError(503, { error: code })} />);
    expect(screen.getByRole("heading", { name: CONNECTION_COPY.busyTitle })).toBeInTheDocument();
    expect(screen.getByText(`${capital(SERVICE_BUSY_CAUSE)} ${CONNECTION_COPY.busyBody}`)).toBeInTheDocument();
    expect(screen.queryByText(CONNECTION_COPY.unreachableTitle)).toBeNull();
    expect(screen.queryByText(CONNECTION_COPY.unreachableBody)).toBeNull();
  });

  it("a passing 503 is busy even while the phone claims to be offline (the club just answered)", () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    render(<ConnectionLost onRetry={() => {}} cause={new ApiError(503, { error: "service_busy" })} />);
    expect(screen.getByRole("heading", { name: CONNECTION_COPY.busyTitle })).toBeInTheDocument();
  });

  it("a 503 with no passing code (a restart) is still unreachable", () => {
    render(<ConnectionLost onRetry={() => {}} cause={new ApiError(503, null)} />);
    expect(screen.getByRole("heading", { name: CONNECTION_COPY.unreachableTitle })).toBeInTheDocument();
  });

  it("a 429 keeps its rate-limit sentence under the busy title", () => {
    render(<ConnectionLost onRetry={() => {}} cause={new ApiError(429, { error: "rate_limited", retry_after_seconds: 3 })} />);
    expect(screen.getByRole("heading", { name: CONNECTION_COPY.busyTitle })).toBeInTheDocument();
    expect(screen.getByText(/wait 3 seconds and try again\./)).toBeInTheDocument();
  });
});
