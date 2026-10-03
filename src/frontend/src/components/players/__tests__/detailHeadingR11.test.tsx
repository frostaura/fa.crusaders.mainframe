import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { signOut } from "@/test/harness";
import { renderDetail, serve } from "./detailKit";

vi.mock("@/components/players/PlayerPicker", () => ({ PlayerPicker: () => null, PlayerPickerDialog: () => null }));

/**
 * R11 (FA11's ask) — at 320 px / 200 % the booking's heading broke "Sun 4 / Oct": a figure split
 * from its unit. The day number is glued to its month (and every digit to the word after it).
 */
beforeEach(() => { signOut(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("R11 — the booking heading keeps its figures whole", () => {
  it("holds the day number and its month on one line, and keeps the heading's name", async () => {
    serve();
    renderDetail();
    const h1 = await screen.findByRole("heading", { level: 1, name: "Court 1 · Wed 30 Sep, 18:00–18:45" });
    const kept = [...h1.querySelectorAll("[data-kept-figure]")].map((n) => n.textContent);
    expect(kept).toContain("30 Sep");
    for (const n of h1.querySelectorAll("[data-kept-figure]")) expect(n.className).toContain("whitespace-nowrap");
  });
});
