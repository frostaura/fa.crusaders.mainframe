import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "@/components/Toast";
import { AuthProvider } from "@/lib/auth";
import { signOut, stubFetch } from "@/test/harness";
import { BOOK_SHEET, heldPartsLine } from "@/lib/bookingsCopy";
import { heldPartsOf } from "@/lib/bookingsApi";
import { heldLine } from "@/lib/playersCopy";
import { BookSheet } from "../BookSheet";

/**
 * C4 on the book sheet (R2, F4-18's book-sheet half): held minutes are explained part by part —
 * each share deadline with its own release — never one date for the whole amount.
 */
vi.setConfig({ testTimeout: 20_000 });

const TZ = "Africa/Johannesburg";
const PARTS = [
  { minutes: 35, until: "2030-10-04T08:30:00Z" },
  { minutes: 25, until: "2030-10-02T04:45:00Z" },
];

vi.mock("@/lib/balance", async (original) => ({
  ...(await original<typeof import("@/lib/balance")>()),
  useBalance: () => ({
    balance: 100, held: { held: 60, owedBack: 0, spendable: 40, until: "2030-10-02T04:45:00Z", parts: PARTS },
    refresh: vi.fn(), apply: vi.fn(),
  }),
}));

afterEach(() => { vi.unstubAllGlobals(); signOut(); });

function Providers({ children }: { children: ReactNode }) {
  return <MemoryRouter><AuthProvider><ToastProvider>{children}</ToastProvider></AuthProvider></MemoryRouter>;
}

describe("held parts (C4)", () => {
  it("reads the wire's held_parts, soonest first", () => {
    expect(heldPartsOf({ held_parts: PARTS })).toEqual([PARTS[1], PARTS[0]]);
    expect(heldPartsOf({ held_until: "x" })).toEqual([]);
  });

  it("the Confirm step names each part and its own release, not one date for all of it", async () => {
    stubFetch([]);
    render(
      <BookSheet
        open onOpenChange={vi.fn()} timezone={TZ} sliceMinutes={15} isAdmin={false} actorUserId="me" balanceMinutes={100}
        slots={[{ courtId: "c1", courtName: "Court 1", startsAt: "2030-10-05T16:00:00.000Z", sliceCount: 1, priceMinutes: 20 }]}
        onBooked={vi.fn()}
      />,
      { wrapper: Providers, reactStrictMode: true },
    );
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.next }));
    const line = await waitFor(() => {
      const el = document.querySelector("[data-held-line]");
      expect(el).toBeTruthy();
      return el!;
    });
    expect(line).toHaveTextContent(heldPartsLine([PARTS[1], PARTS[0]], TZ));
    expect(heldPartsLine([PARTS[1], PARTS[0]], TZ)).toBe("Held: 25 min until Wed 2 Oct, 06:45 · 35 min until Fri 4 Oct, 10:30");
    expect(line).not.toHaveTextContent(heldLine(60, PARTS[1].until, TZ));
  });
});
