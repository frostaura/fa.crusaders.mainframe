import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ConfirmDialog } from "../ConfirmDialog";
import { ActionsMenu } from "../ActionsMenu";
import { Button } from "../../ui/button";
import { ApiError } from "../../../lib/api";
import { splitQuestion } from "../../../lib/confirmCopy";

/**
 * The admin console's confirm step (P3: destructive → a dialog with ×, outcome-named verbs,
 * real pending) and the ⋯ row menu that opens it.
 */

const strict = { reactStrictMode: true };

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function Harness({ onConfirm }: { onConfirm: () => unknown }) {
  return (
    <ConfirmDialog
      trigger={<Button>Delete webhook</Button>}
      title="Delete this webhook?"
      description="It stops receiving the club's events at once."
      confirmLabel="Delete webhook"
      onConfirm={onConfirm}
    />
  );
}

describe("ConfirmDialog", () => {
  it("asks, states the consequence, and offers Cancel, the outcome-named primary and a close ×", async () => {
    render(<Harness onConfirm={vi.fn()} />, strict);
    fireEvent.click(screen.getByRole("button", { name: "Delete webhook" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete this webhook?" });
    expect(dialog).toHaveAccessibleDescription("It stops receiving the club's events at once.");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeInTheDocument();
    // Copy rules: never "OK", never "Yes".
    expect(within(dialog).queryByRole("button", { name: /^(OK|Yes)$/ })).toBeNull();
  });

  it("shows real pending on the primary, ignores a second press, and closes on success", async () => {
    const work = deferred();
    const onConfirm = vi.fn(() => work.promise);
    render(<Harness onConfirm={onConfirm} />, strict);
    fireEvent.click(screen.getByRole("button", { name: "Delete webhook" }));
    const dialog = await screen.findByRole("dialog");
    const primary = within(dialog).getByRole("button", { name: "Delete webhook" });

    fireEvent.click(primary);
    expect(primary).toHaveAttribute("aria-busy", "true");
    // Pending is aria-disabled, not disabled: focus stays on the control.
    expect(primary).not.toBeDisabled();
    fireEvent.click(primary);
    expect(onConfirm).toHaveBeenCalledTimes(1);

    work.resolve();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps the dialog open and says why when the work fails", async () => {
    const onConfirm = vi.fn(() => Promise.reject(new ApiError(409, { error: "in_use" })));
    render(<Harness onConfirm={onConfirm} />, strict);
    fireEvent.click(screen.getByRole("button", { name: "Delete webhook" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete webhook" }));

    expect((await within(dialog).findByRole("alert")).textContent?.trim()).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("returns focus to the trigger when dismissed", async () => {
    render(<Harness onConfirm={vi.fn()} />, strict);
    const trigger = screen.getByRole("button", { name: "Delete webhook" });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});

describe("ActionsMenu", () => {
  it("names its trigger, puts danger last, and opens the item's confirm", async () => {
    const onConfirm = vi.fn();
    render(
      <ActionsMenu
        label="More actions for Off-peak"
        items={[
          { label: "Delete group", danger: true, confirm: { title: "Delete Off-peak?", description: "Gone for good.", confirmLabel: "Delete group", onConfirm } },
          { label: "Archive group", onSelect: vi.fn() },
          false,
        ]}
      />,
      strict,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for Off-peak" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Archive group", "Delete group"]);

    fireEvent.click(items[1]);
    const dialog = await screen.findByRole("dialog", { name: "Delete Off-peak?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete group" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });
});

describe("splitQuestion", () => {
  it("splits the old two-tap sentence into the dialog's question and its consequence", () => {
    expect(splitQuestion("Shut this door? It hears this at once.")).toEqual({
      question: "Shut this door?", consequence: "It hears this at once.",
    });
    expect(splitQuestion("The box stops switching lights on.")).toEqual({
      question: null, consequence: "The box stops switching lights on.",
    });
  });
});
