import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * `delay: null` on every setup.
 *
 * user-event's default inserts a real setTimeout between each low-level event. Under
 * jsdom 28 + vitest 4 that never resolves here, so a click hangs until the 5s test
 * timeout — which looks exactly like a component that does not respond to clicks and
 * is not. Disabling the delay makes the interaction synchronous and the failures
 * honest.
 */
const setup = () => userEvent.setup({ delay: null });
import { ConfirmButton } from "./ConfirmButton";
import { DataTable, type DataColumn } from "./DataTable";

/**
 * The two composite controls that are ours rather than shadcn's: the two-press ConfirmButton and
 * the DataTable. The `ui/*` primitives have their own suites in `ui/__tests__/`.
 */

describe("ConfirmButton", () => {
  /**
   * R2 I-F6, and what B5 did to it.
   *
   * <p>
   * The width sentinel that made the button size to max(idle, confirm) held that measurement
   * on ONE unbreakable line, so a confirm label that is a sentence — Devices' "Delete? The box
   * re-registers on its next heartbeat." — measured 319 px and pushed the whole page to 435 px
   * inside a 375 px phone.
   * </p>
   *
   * <p>
   * The sentinel is <b>gone</b> rather than fixed: the consequence is no longer a label, so
   * there is nothing for the control to resize to when it arms — it shows the same words in
   * both states. The guarantee it bought (the page does not widen) is now a property of the
   * consequence being an ordinary wrapping paragraph, which is what this holds.
   * </p>
   */
  it("lets a sentence-long consequence wrap instead of widening the page", () => {
    render(<ConfirmButton idleLabel="Delete" confirmLabel="Delete? The box re-registers on its next heartbeat." onConfirm={() => {}} />);

    const button = screen.getByRole("button", { name: "Delete" });
    expect(button.className).toContain("max-w-full");
    // Nothing invisible inside the control carrying a second copy of anything.
    expect(button.querySelector("span[aria-hidden].invisible")).toBeNull();

    fireEvent.click(button);
    const consequence = screen.getByText("Delete? The box re-registers on its next heartbeat.");
    expect(consequence.tagName).toBe("P");
    // A sentence may wrap: nothing pins it to one line, and nothing clips it.
    expect(consequence.className).not.toContain("whitespace-nowrap");
    expect(consequence.className).not.toContain("truncate");
    expect(consequence.className).not.toContain("overflow-hidden");
  });

  it("needs two presses before it does anything", async () => {
    const user = setup();
    const onConfirm = vi.fn();

    render(<ConfirmButton idleLabel="Revoke" confirmLabel="Really revoke?" onConfirm={onConfirm} />);

    await user.click(screen.getByRole("button", { name: "Revoke" }));
    // The whole point: one press arms, it does not act. Revoking a device or
    // cancelling a booking is not something a mis-tap on a phone should do.
    expect(onConfirm).not.toHaveBeenCalled();

    // B5 — the second press is on a DIFFERENT button. It shows the same words the trigger
    // did, with the consequence above it and a Cancel beside it, so its accessible name is
    // the label plus the consequence rather than the consequence alone.
    await user.click(await screen.findByRole("button", { name: "Revoke — Really revoke?" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  /**
   * <b>There is no timer, and this is the third position this file has held on that.</b>
   *
   * <p>
   * 3000 ms first: on the booking grid a member who paused to read "Reserve for 50.00 cr?"
   * tapped a control that had already gone back to idle, so the second tap re-armed instead
   * of confirming and a slow reader could tap for ever without booking anything. Removed,
   * which left an armed destructive control on an admin screen loaded indefinitely. Then
   * 8000 ms, which reviewers B and C measured on the real screens: a 45-word confirm takes
   * about thirteen seconds to hear and the window was 8.07 s, with no countdown — the 3000 ms
   * defect again with a bigger number.
   * </p>
   *
   * <p>
   * So: no clock. What the clock was guarding against is closed by four disarms that do not
   * need one — Escape, the visible Cancel, focus leaving the control, and a route change —
   * and the last two are what actually clear an abandoned screen. A confirmation exists to be
   * read, and this one now waits.
   * </p>
   */
  it("stays armed for as long as it takes to read, with no timer to run out", async () => {
    vi.useFakeTimers();
    try {
      const onConfirm = vi.fn();
      // The prop is kept so no call site has to change to compile; it does nothing.
      render(<ConfirmButton idleLabel="Revoke" confirmLabel="Really revoke?" onConfirm={onConfirm} armedTimeoutMs={1000} />);

      // fireEvent, not user-event: mixing user-event with fake timers deadlocks under
      // jsdom 28 + vitest 4, and the point here is the absence of a timer.
      act(() => { fireEvent.click(screen.getByRole("button", { name: "Revoke" })); });
      act(() => { vi.advanceTimersByTime(60_000); });

      const confirm = screen.getByRole("button", { name: "Revoke — Really revoke?" });
      expect(confirm).toBeInTheDocument();
      expect(onConfirm).not.toHaveBeenCalled();

      act(() => { fireEvent.click(confirm); });
      expect(onConfirm).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("goes back to idle after the action instead of sticking on Working…", async () => {
    const user = setup();
    const onConfirm = vi.fn().mockResolvedValue(undefined);

    // StrictMode is what reproduces it, and it is what the dev server runs. The effect
    // lifecycle is mount → cleanup → mount, and the component only ever wrote `false` on
    // cleanup — so `mounted.current` was false before the first click ever happened.
    // Rendering without StrictMode here would pass against the broken component.
    render(
      <StrictMode>
        <ConfirmButton idleLabel="Revoke" confirmLabel="Really revoke?" onConfirm={onConfirm} />
      </StrictMode>,
    );
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    await user.click(await screen.findByRole("button", { name: "Revoke — Really revoke?" }));

    // The `mounted` ref was only ever written on UNMOUNT, so React's development
    // double-invoke (mount → cleanup → mount) left it false from the first render — and
    // the `finally` that clears `pending` was then skipped for ever. The button stuck on
    // "Working…" after its first successful action, on every screen that uses it, and it
    // reads as a hung request rather than as a lifecycle bug.
    const settled = await screen.findByRole("button", { name: "Revoke" });
    expect(settled).toHaveAttribute("aria-busy", "false");
    expect(settled).toBeEnabled();
  });
});

describe("DataTable", () => {
  type Row = { id: string; name: string; credits: number };
  const columns: DataColumn<Row>[] = [
    { key: "name", header: "Name", cell: (r) => r.name },
    { key: "credits", header: "Credits", align: "right", cell: (r) => r.credits.toFixed(2) },
  ];
  const rows: Row[] = [
    { id: "1", name: "Alice", credits: 240 },
    { id: "2", name: "Bob", credits: 92 },
  ];

  it("renders rows and headers", () => {
    render(<DataTable rows={rows} columns={columns} rowKey={(r) => r.id} />);
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("92.00")).toBeInTheDocument();
  });

  it("says something useful when there is nothing to show", () => {
    render(
      <DataTable
        rows={[]}
        columns={columns}
        rowKey={(r) => r.id}
        emptyTitle="No members yet"
        emptyHint="Approve a registration to see one here."
      />,
    );
    // An empty table with no message reads as a broken screen.
    expect(screen.getByText("No members yet")).toBeInTheDocument();
    expect(screen.getByText("Approve a registration to see one here.")).toBeInTheDocument();
  });

  it("filters on the search box when one is offered", () => {
    render(
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(r) => r.id}
        search={{ placeholder: "Search members", fields: (r) => r.name }}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("Search members"), { target: { value: "ali" } });
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.queryByText("Bob")).not.toBeInTheDocument();
  });

  /**
   * P3 — on `ui/table`: the search box is a NAMED field (a placeholder alone is no label), each
   * sortable header says its direction in `aria-sort` rather than by caret alone, and a filter
   * that matches nothing is not confused with an empty table.
   */
  it("names its search, says its sort, and tells a filtered-out table from an empty one", () => {
    render(
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(r) => r.id}
        defaultSort={{ key: "credits", dir: "desc" }}
        emptyTitle="No members yet"
        search={{ placeholder: "Search members", fields: (r) => r.name }}
      />,
    );
    expect(screen.getByRole("searchbox", { name: "Search members" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Credits/ })).toHaveAttribute("aria-sort", "descending");
    expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute("aria-sort", "none");
    fireEvent.click(screen.getByRole("button", { name: /Name/ }));
    expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute("aria-sort", "ascending");

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzz" } });
    expect(screen.getByText("No matches for that search.")).toBeInTheDocument();
    expect(screen.queryByText("No members yet")).not.toBeInTheDocument();
  });
});
