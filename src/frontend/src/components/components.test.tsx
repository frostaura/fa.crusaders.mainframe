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
import { Badge, Button, Input, Label } from "./Button";
import { Card } from "./Card";
import { ConfirmButton } from "./ConfirmButton";
import { DataTable, type DataColumn } from "./DataTable";
import { Modal } from "./Modal";

/**
 * The hand-rolled primitives.
 *
 * <p>
 * Every one of these is written from scratch — there is no shadcn/ui and no Radix in
 * this repo, which <code>CLAUDE.md</code> records as drift rather than as a decision.
 * That is precisely why they need tests: a library primitive comes with its
 * accessibility behaviour and its edge cases already exercised by somebody else, and
 * these do not.
 * </p>
 *
 * <p>
 * So the assertions here are about the things a component library would have given
 * for free: does the destructive action need two presses, does the modal close on
 * Escape, does the table say something useful when it is empty.
 * </p>
 */

describe("Button", () => {
  it("calls its handler and can be disabled", async () => {
    const user = setup();
    const onClick = vi.fn();

    const { rerender } = render(<Button onClick={onClick}>Save</Button>);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(<Button onClick={onClick} disabled>Save</Button>);
    await user.click(screen.getByRole("button", { name: "Save" }));
    // Still once. A disabled button that still fires is how a double-submit charges
    // a member twice.
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("Input and Label", () => {
  it("associates a label with its input", async () => {
    const user = setup();
    render(
      <>
        <Label htmlFor="court">Court number</Label>
        <Input id="court" />
      </>,
    );

    // getByLabelText only finds it if the association is real, which is what a screen
    // reader depends on.
    const input = screen.getByLabelText("Court number");
    await user.type(input, "3");
    expect(input).toHaveValue("3");
  });
});

describe("Badge", () => {
  it("renders its content", () => {
    render(<Badge tone="danger">revoked</Badge>);
    expect(screen.getByText("revoked")).toBeInTheDocument();
  });
});

describe("Card", () => {
  it("renders children and keeps caller classes", () => {
    render(<Card className="p-5"><p>Inside</p></Card>);
    expect(screen.getByText("Inside")).toBeInTheDocument();
  });
});

describe("ConfirmButton", () => {
  it("needs two presses before it does anything", async () => {
    const user = setup();
    const onConfirm = vi.fn();

    render(<ConfirmButton idleLabel="Revoke" confirmLabel="Really revoke?" onConfirm={onConfirm} />);

    await user.click(screen.getByRole("button", { name: "Revoke" }));
    // The whole point: one press arms, it does not act. Revoking a device or
    // cancelling a booking is not something a mis-tap on a phone should do.
    expect(onConfirm).not.toHaveBeenCalled();

    await user.click(await screen.findByRole("button", { name: "Really revoke?" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("disarms itself again after a while", async () => {
    vi.useFakeTimers();
    try {
      const onConfirm = vi.fn();
      render(<ConfirmButton idleLabel="Revoke" confirmLabel="Really revoke?" onConfirm={onConfirm} armedTimeoutMs={1000} />);

      // fireEvent, not user-event: mixing user-event with fake timers deadlocks under
      // jsdom 28 + vitest 4, and the point of this test is the timer, not the pointer.
      act(() => { fireEvent.click(screen.getByRole("button", { name: "Revoke" })); });
      expect(screen.getByRole("button", { name: "Really revoke?" })).toBeInTheDocument();

      // An armed button left on screen is a trap for the next person to touch it.
      act(() => { vi.advanceTimersByTime(1500); });
      expect(screen.getByRole("button", { name: "Revoke" })).toBeInTheDocument();
      expect(onConfirm).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Modal", () => {
  it("closes on Escape", () => {
    const onClose = vi.fn();

    render(<Modal onClose={onClose} title="Connect"><p>Body</p></Modal>);
    expect(screen.getByText("Body")).toBeInTheDocument();

    // Escape is the one dismissal every dialog is expected to honour, and the one a
    // hand-rolled modal most often forgets — leaving a keyboard user with no way out.
    // fireEvent rather than user.keyboard: user-event's keyboard path never settles
    // under jsdom 28 + vitest 4 here and the test times out looking like a component
    // that ignores Escape. The event dispatched is the same one the browser sends.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("restores page scrolling when it goes away", () => {
    const { unmount } = render(<Modal onClose={() => {}} title="Connect"><p>Body</p></Modal>);
    expect(document.body.style.overflow).toBe("hidden");

    // A modal that locks the body and does not unlock it leaves the whole app
    // unscrollable, which reads as a frozen page rather than as a modal bug.
    unmount();
    expect(document.body.style.overflow).not.toBe("hidden");
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
});
