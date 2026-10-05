import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "@/lib/auth";
import { tokenStore } from "@/lib/api";
import { forgetLastKnown } from "@/lib/lastKnown";
import { CONNECTION_COPY } from "@/lib/shellCopy";
import { RequireAuth } from "./RequireAuth";

/**
 * R14 X14-3 — a cold open of `/profile/results` (or any page that keeps nothing on the phone) with
 * the phone OFFLINE said "Can't reach the club right now … usually a brief interruption", which
 * blames the club for the member's own lost signal. With `navigator.onLine === false` the screen
 * says it as offline and that the page needs a connection; with it true (Wi-Fi without internet
 * leaves it true) it stays "can't reach the club".
 */

const LAST_IDENTITY_KEY = "crusaders.mainframe.last-identity";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  tokenStore.clear();
  forgetLastKnown();
  localStorage.clear();
});

function coldOffline(onLine: boolean) {
  tokenStore.set("member.jwt.value");
  localStorage.setItem(LAST_IDENTITY_KEY, "44444444-4444-4444-4444-444444444444");
  vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(onLine);
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Routes>
          <Route path="/profile/results" element={<RequireAuth><p>the results page</p></RequireAuth>} />
          <Route path="/admin/doors" element={<RequireAuth admin><p>the doors page</p></RequireAuth>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("ConnectionLost — offline is said as offline", () => {
  it.each(["/profile/results", "/admin/doors"])("%s with the phone offline says it needs a connection", async (path) => {
    coldOffline(false);
    renderAt(path);
    expect(await screen.findByRole("heading", { name: CONNECTION_COPY.offlineTitle }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText(CONNECTION_COPY.offlineBody)).toBeInTheDocument();
    expect(screen.queryByText(CONNECTION_COPY.unreachableTitle)).toBeNull();
    expect(screen.queryByText("the results page")).toBeNull();
  }, 30_000);

  it("with the phone online but the club silent, still says it can't reach the club", async () => {
    coldOffline(true);
    renderAt("/profile/results");
    expect(await screen.findByRole("heading", { name: CONNECTION_COPY.unreachableTitle }, { timeout: 5000 })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(CONNECTION_COPY.offlineTitle)).toBeNull());
  }, 30_000);
});
