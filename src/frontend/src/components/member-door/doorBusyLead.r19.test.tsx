import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import MyCodePage from "../../pages/MyCode";
import { forgetLastKnown, rememberDoor } from "../../lib/lastKnown";
import { DOOR_FAILURE_LEADS } from "../../lib/memberDoorCopy";
import {
  memberCodeRoutes, memberDoorBookingFixture, memberDoorsOnFixture, renderPage, signOut, stubFetch,
} from "../../test/harness";

/**
 * R19 X19-1.3 — the door card's failed-read lead had two causes, the phone's line and "the club's
 * system answered with an error". A `503 service_busy` (every connection in use), a 429 and a
 * `503 conflict_retry` (a clash that passes) are the club ANSWERING, busy or mid-clash — "an error"
 * sent a member at the door to tell the committee about a moment that passes by itself.
 */
afterEach(() => {
  vi.unstubAllGlobals();
  forgetLastKnown();
  signOut();
});

function doorAnswers(status: number, body: unknown) {
  rememberDoor(memberDoorsOnFixture({ policy: "booking_window", next_booking: memberDoorBookingFixture() }) as never);
  stubFetch([...memberCodeRoutes(), { path: "/api/v1/me/door", status, body }]);
  renderPage(<MyCodePage />);
}

describe("R19 X19-1.3 — the door card names a busy club and a clash, not an error", () => {
  it.each([
    ["503 service_busy", 503, { error: "service_busy" }, DOOR_FAILURE_LEADS.busy],
    ["429 rate_limited", 429, { error: "rate_limited", retry_after_seconds: 2 }, DOOR_FAILURE_LEADS.busy],
    ["503 conflict_retry", 503, { error: "conflict_retry" }, DOOR_FAILURE_LEADS.clash],
    ["500 (control)", 500, { error: "boom" }, DOOR_FAILURE_LEADS.server],
    ["503 with no code (a restart)", 503, null, DOOR_FAILURE_LEADS.server],
  ])("%s → its own lead on the cached line", async (_name, status, body, lead) => {
    doorAnswers(status, body);
    const said = await screen.findByText(/ago it said/);
    expect(said.textContent?.startsWith(lead)).toBe(true);
    expect(said).toHaveTextContent(/That may have changed since/);
    expect(said).not.toHaveTextContent(/Your phone can't reach the club/);
  });

  it.each([
    ["503 service_busy", { error: "service_busy" }],
    ["503 conflict_retry", { error: "conflict_retry" }],
  ])("%s: the checklist neither fails the phone's line nor calls it an error", async (_name, body) => {
    doorAnswers(503, body);
    await screen.findByLabelText("Your code");
    fireEvent.click(screen.getByRole("button", { name: "The door didn't open" }));
    await waitFor(() => expect(screen.queryByText("Checking…")).toBeNull());
    const panel = await screen.findByRole("region", { name: /door/i }).catch(() => document.body);
    const connection = [...panel.querySelectorAll("li")].find((li) => li.textContent?.includes("This phone's line"));
    expect(connection?.textContent).not.toContain("Failed");
    expect(connection?.textContent).not.toMatch(/answered with an error/);
    expect(document.body.textContent).not.toMatch(/answered with an error/);
    expect(document.body.textContent).toMatch(/not your phone/);
  });

  it("the leads are distinct sentences that never blame the phone", () => {
    const { network, server, busy, clash } = DOOR_FAILURE_LEADS;
    expect(new Set([network, server, busy, clash]).size).toBe(4);
    for (const lead of [server, busy, clash]) expect(lead).toMatch(/not your phone/);
    expect(busy).toMatch(/very busy/);
    expect(clash).not.toMatch(/error/);
  });
});
