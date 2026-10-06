import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { signOut } from "@/test/harness";
import { DETAIL_COPY } from "@/lib/playersCopy";
import { DETAIL_PATH, renderDetail, serve } from "@/components/players/__tests__/detailKit";

vi.mock("@/components/players/PlayerPicker", () => ({ PlayerPicker: () => null, PlayerPickerDialog: () => null }));

/**
 * R19 X19-1.2 — the booking page's READ failed with `503 conflict_retry` and was worded with the
 * players WRITE refusals: "Someone else was changing this booking at the same moment. The page has
 * the latest — try again now." There is no page — the read is what failed. A read is said as a read:
 * "Couldn't read this booking — someone else was changing the same thing at that exact moment. Try
 * again now." — and a busy club as busy.
 */

beforeEach(() => { signOut(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("the booking page's failed read (R19 X19-1.2)", () => {
  it("a read clash is a read's sentence, never 'The page has the latest'", async () => {
    serve({ detail: { path: DETAIL_PATH, status: 503, body: { error: "conflict_retry" } } });
    renderDetail();
    const said = await screen.findByText(/Couldn't read this booking/, {}, { timeout: 10_000 });
    expect(said.textContent).toMatch(/someone else was changing the same thing at that exact moment\. Try again now\./);
    expect(document.body.textContent).not.toMatch(/has the latest/);
    expect(screen.getByRole("button", { name: /Try again/ })).toBeInTheDocument();
  });

  it("a busy club is busy, on the same read", async () => {
    serve({ detail: { path: DETAIL_PATH, status: 503, body: { error: "service_busy" } } });
    renderDetail();
    const said = await screen.findByText(new RegExp(`Couldn't ${DETAIL_COPY.readAction}`), {}, { timeout: 10_000 });
    expect(said.textContent).toMatch(/very busy right now\. Try again in a moment\./);
    expect(said.textContent).not.toMatch(/down or restarting|has the latest/);
  });
});
