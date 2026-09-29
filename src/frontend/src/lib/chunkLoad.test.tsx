import { afterEach, describe, expect, it, vi } from "vitest";
import { lazy, Suspense } from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { CHUNK_RELOAD_KEY, CHUNK_RELOAD_WINDOW_MS, ChunkLoadError, loadChunk } from "./chunkLoad";
import { CHUNK_COPY } from "./shellCopy";
import { PageErrorBoundary } from "../components/shell/PageErrorBoundary";

/**
 * F4.3 — a lazy page whose code did not arrive. Offline it says so, with a Retry; online (a
 * deploy under an open tab: the old chunk hash 404s) it reloads ONCE, and a second failure in a
 * row is explained rather than reloaded again.
 */
const chromeFailure = () => Promise.reject(new TypeError("Failed to fetch dynamically imported module: https://club.example/assets/Wallet-OLD.js"));

function setOnline(online: boolean) {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(online);
}

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe("loadChunk", () => {
  it("reloads once when a chunk 404s online — a new build is waiting", async () => {
    setOnline(true);
    const reload = vi.fn();
    const pending = loadChunk(chromeFailure, reload);
    await new Promise((r) => setTimeout(r, 0));
    expect(reload).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(CHUNK_RELOAD_KEY)).not.toBeNull();
    // It never settles: the page is going away.
    expect(await Promise.race([pending.then(() => "settled", () => "settled"), Promise.resolve("pending")])).toBe("pending");
  });

  it("does not reload twice in a row — the second failure goes to the boundary", async () => {
    setOnline(true);
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now() - 1_000));
    const reload = vi.fn();
    await expect(loadChunk(chromeFailure, reload)).rejects.toMatchObject({ name: "ChunkLoadError", offline: false });
    expect(reload).not.toHaveBeenCalled();
  });

  it("never reloads offline, and says it is offline", async () => {
    setOnline(false);
    const reload = vi.fn();
    await expect(loadChunk(chromeFailure, reload)).rejects.toMatchObject({ name: "ChunkLoadError", offline: true });
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not forget the reload because some OTHER chunk arrived — that was the loop", async () => {
    setOnline(true);
    const reload = vi.fn();
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now() - 1_000));
    await expect(loadChunk(() => Promise.resolve({ default: 1 }))).resolves.toEqual({ default: 1 });
    await expect(loadChunk(chromeFailure, reload)).rejects.toMatchObject({ name: "ChunkLoadError" });
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads again for a deploy that comes after the window", async () => {
    setOnline(true);
    const reload = vi.fn();
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now() - CHUNK_RELOAD_WINDOW_MS - 1));
    void loadChunk(chromeFailure, reload);
    await new Promise((r) => setTimeout(r, 0));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("passes an error that is not a failed fetch straight through", async () => {
    const reload = vi.fn();
    const bug = new RangeError("a bug in the page module");
    await expect(loadChunk(() => Promise.reject(bug), reload)).rejects.toBe(bug);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("the page boundary and a chunk that did not arrive", () => {
  function renderLazy(load: () => Promise<{ default: () => null }>) {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Page = lazy(() => loadChunk(load, vi.fn()));
    return render(
      <MemoryRouter>
        <PageErrorBoundary resetKey="/wallet">
          <Suspense fallback={<p>loading</p>}><Page /></Suspense>
        </PageErrorBoundary>
      </MemoryRouter>,
    );
  }

  it("offline: says the page opens when the phone is back online, with a Retry — not a crash", async () => {
    setOnline(false);
    renderLazy(chromeFailure);
    expect(await screen.findByRole("heading", { name: CHUNK_COPY.offlineTitle })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: CHUNK_COPY.retry })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: CHUNK_COPY.myCode })).toHaveAttribute("href", "/my-code");
    expect(screen.queryByText("This page hit a problem")).toBeNull();
  });

  it("online, after its one reload: says the page didn't load, with a Retry", async () => {
    setOnline(true);
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
    renderLazy(chromeFailure);
    expect(await screen.findByRole("heading", { name: CHUNK_COPY.failedTitle })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: CHUNK_COPY.retry })).toBeInTheDocument();
  });

  it("keeps the generic screen for a page that genuinely threw (the fixture, varied)", async () => {
    renderLazy(() => Promise.resolve({ default: () => { throw new Error("render bug"); } }));
    expect(await screen.findByText("This page hit a problem")).toBeInTheDocument();
    expect(screen.queryByText(CHUNK_COPY.offlineTitle)).toBeNull();
  });

  it("recognises the error class itself", () => {
    expect(new ChunkLoadError(true).name).toBe("ChunkLoadError");
  });
});
