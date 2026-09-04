import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import CourtCodePage from "./CourtCode";
import { encodeQr, qrPath } from "../lib/qr";
import { renderPage, stubFetch } from "../test/harness";

/**
 * The member's court code.
 *
 * <p>
 * The one thing this screen must never get wrong: the QR carries the bare code and
 * nothing else. The court box's scanner pipeline caps an argument at 24 bytes and
 * poisons anything longer — the previous JWT design could not identify anyone at a
 * court, ever. A URL prefix, a JSON wrapper or a tenant slug in the payload would
 * reintroduce that failure while looking like a perfectly good QR on the phone.
 * </p>
 */
describe("CourtCode", () => {
  afterEach(() => vi.unstubAllGlobals());

  const BOOKING = {
    code: "7K3M9XQ2RD5A",
    kind: "booking",
    expires_in_seconds: 900,
    booking_id: "33333333-3333-3333-3333-333333333333",
    court_number: 3,
    starts_at: "2026-09-04T15:00:00+00:00",
  };

  const IDENT = { code: "ZZ9P4T6WQ8HN", kind: "ident", expires_in_seconds: 60 };

  it("shows a booking code with its court and start time", async () => {
    stubFetch([{ method: "POST", path: "/api/v1/me/qr/generate", body: BOOKING }]);

    renderPage(<CourtCodePage />);

    // The code itself is printed, because it is short enough to type at the desk.
    expect(await screen.findByLabelText("Court code")).toHaveTextContent("7K3M9XQ2RD5A");
    // What presenting it does, in the member's terms. The hour is the viewer's local
    // time, so only its shape is pinned here.
    expect(screen.getByText(/^Court 3 · starts \d{2}:\d{2}$/)).toBeInTheDocument();
    expect(screen.getByText(/This code is for your booking/)).toBeInTheDocument();
    expect(screen.getByText(/Refreshes in 15m 00s/)).toBeInTheDocument();
  });

  it("encodes the bare code and nothing else", async () => {
    stubFetch([{ method: "POST", path: "/api/v1/me/qr/generate", body: BOOKING }]);

    renderPage(<CourtCodePage />);

    const svg = await screen.findByRole("img", { name: "QR code 7K3M9XQ2RD5A" });
    // Module-for-module the symbol for the twelve characters alone — not a URL around
    // them, not the booking id, not the tenant. Twelve bytes is a version-1 symbol; the
    // box's scanner has room for 24.
    expect(svg.querySelector("path")?.getAttribute("d")).toBe(qrPath(encodeQr("7K3M9XQ2RD5A")));
  });

  it("says an ident code identifies the member at any court", async () => {
    stubFetch([{ method: "POST", path: "/api/v1/me/qr/generate", body: IDENT }]);

    renderPage(<CourtCodePage />);

    expect(await screen.findByLabelText("Court code")).toHaveTextContent("ZZ9P4T6WQ8HN");
    expect(screen.getByText("Identifies you at any court")).toBeInTheDocument();
    expect(screen.getByText(/no booking coming up/)).toBeInTheDocument();
    expect(screen.getByText(/Refreshes in 1m 00s/)).toBeInTheDocument();
  });

  it("fetches a fresh code on demand", async () => {
    const stub = stubFetch([{ method: "POST", path: "/api/v1/me/qr/generate", body: IDENT }]);

    renderPage(<CourtCodePage />);
    await screen.findByLabelText("Court code");

    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));

    await waitFor(() => {
      expect(stub.calls.filter((c) => c.method === "POST" && c.path === "/api/v1/me/qr/generate")).toHaveLength(2);
    });
  });

  it("says so when a code cannot be fetched, and offers to try again", async () => {
    stubFetch([{ method: "POST", path: "/api/v1/me/qr/generate", status: 500, body: { error: "boom" } }]);

    renderPage(<CourtCodePage />);

    expect(await screen.findByText(/Couldn't get a code/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Try again/ })).toBeInTheDocument();
  });
});
