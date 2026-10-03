import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "@/components/Toast";
import { AuthProvider } from "@/lib/auth";
import { BalanceProvider } from "@/lib/balance";
import type { BalanceTransport } from "@/lib/liveBalance";
import { refuse, signIn, signOut, stubFetch } from "@/test/harness";
import { BOOK_SHEET } from "@/lib/bookingsCopy";
import { minutesCompact } from "@/lib/minutes";
import { BookSheet } from "../BookSheet";
import type { SelectedSlot } from "../types";

/**
 * R7 X7-2 — a 402 `insufficient_balance` states the payer's spendable minutes as the club sees them
 * NOW (`current_minutes`). The sheet said "Balance now 9 h / after 8 h 45 min" over a refusal for
 * want of minutes, and the chip kept 9 h, until a reload. The sheet adopts the stated figure at
 * once and the wallet is read again, so the chip follows.
 */

vi.setConfig({ testTimeout: 15_000 });

const TZ = "Africa/Johannesburg";
const ME = "44444444-4444-4444-4444-444444444444";
const C1: SelectedSlot = { courtId: "c1", courtName: "Court 1", startsAt: "2030-09-09T16:00:00.000Z", sliceCount: 1, priceMinutes: 15 };
const quietStream: BalanceTransport = { open: () => Promise.resolve({ close: () => undefined }) };

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); signOut(); });

function Providers({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter>
      <AuthProvider>
        <BalanceProvider transport={quietStream}><ToastProvider>{children}</ToastProvider></BalanceProvider>
      </AuthProvider>
    </MemoryRouter>
  );
}

const wallet = (minutes: number) => ({ balance_minutes: minutes, held_minutes: 0, spendable_minutes: minutes, held_until: null, entries: [], total_entries: 0, offset: 0, limit: 100 });

describe("X7-2 — a refusal for want of minutes makes the sheet's figures and the wallet true at once", () => {
  it("adopts current_minutes on the sheet and reads the wallet again", async () => {
    const stub = stubFetch([
      { path: "/api/v1/whoami", body: { tenant_slug: "crusaders", tenant_id: "t", user_id: ME, is_authenticated: true, is_admin: false } },
      // Stale until the re-read: 9 h, then the club's 5 minutes.
      { path: "/api/v1/wallet", sequence: [wallet(540), wallet(5)] },
      { method: "POST", path: "/api/v1/bookings/", body: refuse(402, { error: "insufficient_balance", current_minutes: 5, required_minutes: 15 }) },
    ]);
    signIn({ isAdmin: false });
    render(
      <BookSheet open onOpenChange={vi.fn()} slots={[C1]} timezone={TZ} sliceMinutes={15}
        isAdmin={false} actorUserId={ME} balanceMinutes={540} />,
      { wrapper: Providers },
    );
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.next }));
    await waitFor(() => expect(document.querySelector("dl")).toHaveTextContent(`${BOOK_SHEET.balanceNow}${minutesCompact(540)}`));
    const walletReads = () => stub.calls.filter((c) => c.method === "GET" && c.path.startsWith("/api/v1/wallet")).length;
    const before = walletReads();
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.primary(1, 15, null) }));
    // The sheet's own figures: 5 now, 10 still needed — never "after 8 h 45 min".
    await waitFor(() => expect(document.querySelector("dl")).toHaveTextContent(`${BOOK_SHEET.balanceNow}${minutesCompact(5)}`));
    expect(document.querySelector("dl")).toHaveTextContent(`${BOOK_SHEET.stillNeeded}${minutesCompact(10)}`);
    expect(document.querySelector("dl")).not.toHaveTextContent(BOOK_SHEET.balanceAfter);
    // And the wallet is asked again, so the chip says the same.
    await waitFor(() => expect(walletReads()).toBeGreaterThan(before));
  });
});
