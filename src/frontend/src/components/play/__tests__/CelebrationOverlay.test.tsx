import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { Link, Route, Routes, useLocation } from "react-router-dom";
import { renderPage, signOut } from "@/test/harness";
import { CelebrationOverlay } from "@/components/play/CelebrationOverlay";
import { COLLAPSE_OVER, isQuietPath, momentOf } from "@/components/play/celebrationRules";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { CELEBRATION_COPY } from "@/lib/playCopy";
import { celebration, serve } from "./playKit";

/**
 * The one-shot moment (§9.3): one at a time, oldest first; more than three collapse into one;
 * never on the pass, an invite or an auth page, never over another open sheet; acknowledged on
 * dismissal only; and every moving part stands still under reduced motion.
 */

beforeEach(() => { signOut(); });
afterEach(() => { vi.unstubAllGlobals(); });

const LIST = "/api/v1/me/play/celebrations";
const SEEN = `${LIST}/seen`;

function Where() {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.hash}`}</output>;
}

function OtherSheet() {
  const [open, setOpen] = useState(true);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent><DialogTitle>Book a court</DialogTitle></DialogContent>
    </Dialog>
  );
}

function renderAt(path: string, extra?: React.ReactNode) {
  return renderPage(
    <>
      <Routes>
        <Route path="*" element={<><Where /><Link to="/bookings">Bookings</Link>{extra}</>} />
      </Routes>
      <CelebrationOverlay />
    </>,
    { initialEntries: [path] },
  );
}

function served(items: ReturnType<typeof celebration>[]) {
  return serve([
    { path: LIST, body: { items } },
    { method: "POST", path: SEEN, respond: (req) => ({ seen: ((req.body as { ids: string[] }).ids).length }) },
  ]);
}

const seenCalls = (stub: ReturnType<typeof serve>) => stub.calls.filter((c) => c.method === "POST" && c.path === SEEN);

describe("one at a time", () => {
  it("shows the oldest first, and the next once that one is dismissed", async () => {
    const stub = served([
      celebration(),
      celebration({ id: "c2", badge: { key: "sessions_10", name: "Ten up", description: "Played 10 sessions." } }),
    ]);
    renderAt("/bookings");
    const first = await screen.findByRole("dialog", { name: /New badge.*First win/ });
    expect(first).toHaveTextContent("Won a match.");
    // Display alone acknowledges nothing: a member whose tab was hidden still gets it.
    expect(seenCalls(stub)).toHaveLength(0);
    fireEvent.click(within(first).getByRole("button", { name: CELEBRATION_COPY.keepPlaying }));
    expect(await screen.findByRole("dialog", { name: /Ten up/ })).toBeInTheDocument();
    expect(seenCalls(stub)[0].body).toEqual({ ids: ["c1"] });
  });

  it("the close × acknowledges too", async () => {
    const stub = served([celebration()]);
    renderAt("/bookings");
    const dialog = await screen.findByRole("dialog", { name: /First win/ });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(seenCalls(stub)[0].body).toEqual({ ids: ["c1"] });
  });

  it("says a goal reached with its hours", async () => {
    served([celebration({ id: "g1", kind: "goal_reached", badge: null, month: "2026-09", goal_minutes: 600 })]);
    renderAt("/bookings");
    const dialog = await screen.findByRole("dialog", { name: new RegExp(CELEBRATION_COPY.goalReached) });
    expect(dialog).toHaveTextContent(CELEBRATION_COPY.goalBody(600));
  });

  it("See my game acknowledges and goes to the section", async () => {
    const stub = served([celebration()]);
    renderAt("/bookings");
    fireEvent.click(await screen.findByRole("button", { name: CELEBRATION_COPY.seeMyGame }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/profile#my-game"));
    expect(seenCalls(stub)).toHaveLength(1);
  });
});

describe("more than three", () => {
  it("collapse into one moment, and all are acknowledged together", async () => {
    const items = [1, 2, 3, 4].map((n) => celebration({ id: `c${n}` }));
    const stub = served(items);
    renderAt("/bookings");
    const dialog = await screen.findByRole("dialog", { name: new RegExp(CELEBRATION_COPY.many(4)) });
    fireEvent.click(within(dialog).getByRole("button", { name: CELEBRATION_COPY.keepPlaying }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(seenCalls(stub)[0].body).toEqual({ ids: ["c1", "c2", "c3", "c4"] });
  });

  it("is the rule the moment is built by", () => {
    expect(COLLAPSE_OVER).toBe(3);
    expect(momentOf([celebration(), celebration({ id: "c2" }), celebration({ id: "c3" })])).toMatchObject({ kind: "one" });
    expect(momentOf([])).toBeNull();
  });
});

describe("never over the pass", () => {
  it.each(["/my-code", "/j/abc", "/invites/p1", "/login", "/change-password", "/get-started"])("%s is quiet", (path) => {
    expect(isQuietPath(path)).toBe(true);
  });

  it("waits on /my-code and shows on the next route", async () => {
    const stub = served([celebration()]);
    renderAt("/my-code");
    await waitFor(() => expect(stub.calls.some((c) => c.path === LIST)).toBe(true));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "Bookings" }));
    expect(await screen.findByRole("dialog", { name: /First win/ })).toBeInTheDocument();
  });

  it("waits while another sheet is open, and shows once it closes", async () => {
    const stub = served([celebration()]);
    renderAt("/bookings", <OtherSheet />);
    const other = await screen.findByRole("dialog", { name: "Book a court" });
    await waitFor(() => expect(stub.calls.some((c) => c.path === LIST)).toBe(true));
    expect(screen.queryByRole("dialog", { name: /First win/ })).toBeNull();
    fireEvent.click(within(other).getByRole("button", { name: "Close" }));
    expect(await screen.findByRole("dialog", { name: /First win/ })).toBeInTheDocument();
  });

  it("a failed read is silent", async () => {
    serve([{ path: LIST, respond: () => { throw new TypeError("Failed to fetch"); } }]);
    renderAt("/bookings");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("reduced motion", () => {
  it("every moving part stands still under prefers-reduced-motion", async () => {
    served([celebration({ id: "g1", kind: "goal_reached", badge: null, month: "2026-09", goal_minutes: 600 })]);
    renderAt("/bookings");
    const dialog = await screen.findByRole("dialog", { name: new RegExp(CELEBRATION_COPY.goalReached) });
    const scope = dialog.parentElement ?? dialog;
    const moving = [...scope.querySelectorAll<HTMLElement | SVGElement>("*"), dialog]
      .map((el) => el.getAttribute("class") ?? "")
      .filter((cls) => /(^|\s)(animate-|transition-)/.test(cls));
    expect(moving.length).toBeGreaterThan(2);
    for (const cls of moving) {
      if (/(^|\s)animate-(?!none)/.test(cls)) expect(cls, cls).toMatch(/motion-reduce:animate-none/);
      if (/(^|\s)transition-/.test(cls)) expect(cls, cls).toMatch(/motion-reduce:transition-none/);
    }
  });
});
