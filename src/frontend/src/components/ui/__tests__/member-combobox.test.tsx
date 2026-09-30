import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { MemberCombobox, type ComboboxMember } from "../member-combobox";
import { SM_UP } from "../use-media-query";

const strict = { reactStrictMode: true };

const MEMBERS: ComboboxMember[] = [
  { id: "m1", name: "Sam Smith", balance: 12, subtitle: "League" },
  { id: "m2", name: "Alex Nkosi", balance: -16 },
  { id: "m3", name: "Priya Naidoo", photoUrl: "/uploads/t/photos/p.png" },
];

/** The shared test setup answers `matches: false` to every query: the phone. This makes it a desktop. */
function desktop() {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query === SM_UP,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

type Props = Partial<React.ComponentProps<typeof MemberCombobox>> & { onPicked?: (id: string) => void };

function Picker({ onPicked, ...rest }: Props) {
  const [value, setValue] = useState<string | null>(null);
  return (
    <MemberCombobox
      members={MEMBERS}
      value={value}
      onChange={(id) => {
        setValue(id);
        onPicked?.(id);
      }}
      label="Book for"
      {...rest}
    />
  );
}

function trigger() {
  return screen.getByRole("combobox", { name: /^Book for/ });
}

function search() {
  return screen.getByRole("combobox", { name: "Search members" });
}

describe("MemberCombobox — phone (full-height sheet)", () => {
  it("is a labelled combobox showing the placeholder until a member is chosen", () => {
    render(<Picker />, strict);
    const combobox = trigger();
    expect(combobox).toHaveAccessibleName("Book for Choose a member");
    expect(combobox).toHaveAttribute("aria-expanded", "false");
    expect(combobox.className).toContain("min-h-touch");
    expect(combobox.className).toContain("border-control");
  });

  it("filters by the typed query and selects, closing and returning focus to the trigger", async () => {
    const onPicked = vi.fn();
    render(<Picker onPicked={onPicked} />, strict);
    fireEvent.click(trigger());
    const sheet = screen.getByRole("dialog", { name: "Book for" });
    expect(sheet.className).toContain("h-[100dvh]");
    expect(within(sheet).getAllByRole("option")).toHaveLength(3);
    fireEvent.change(search(), { target: { value: "sam" } });
    const options = within(sheet).getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Sam Smith");
    fireEvent.click(options[0]);
    expect(onPicked).toHaveBeenCalledWith("m1");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger()).toHaveAccessibleName(/Sam Smith/);
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
  });

  it("matches words in any order, and never on the member id", () => {
    render(<Picker />, strict);
    fireEvent.click(trigger());
    fireEvent.change(search(), { target: { value: "naidoo pri" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([expect.stringContaining("Priya Naidoo")]);
    fireEvent.change(search(), { target: { value: "m2" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("says so when nothing matches", () => {
    render(<Picker emptyText="Nobody by that name" />, strict);
    fireEvent.click(trigger());
    fireEvent.change(search(), { target: { value: "zzzz" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("Nobody by that name")).toBeInTheDocument();
  });
});

describe("MemberCombobox — desktop (popover)", () => {
  it("opens a popover sized to the trigger, filters by subtitle, and picks with Enter", () => {
    desktop();
    const onPicked = vi.fn();
    render(<Picker onPicked={onPicked} />, strict);
    fireEvent.click(trigger());
    expect(screen.queryByRole("dialog", { name: "Book for" })).toBeNull();
    const panel = document.querySelector<HTMLElement>('[data-slot="popover-content"]');
    expect(panel?.className).toContain("w-[--radix-popover-trigger-width]");
    fireEvent.change(search(), { target: { value: "league" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([expect.stringContaining("Sam Smith")]);
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(onPicked).toHaveBeenCalledWith("m1");
    expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();
  });

  it("opens from the keyboard with ArrowDown", () => {
    desktop();
    render(<Picker />, strict);
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(search()).toBeInTheDocument();
  });
});

describe("MemberCombobox — rows and states", () => {
  it("shows avatar, name and balance, with a negative balance in the danger ink", () => {
    render(<Picker />, strict);
    fireEvent.click(trigger());
    const [sam, alex] = screen.getAllByRole("option");
    expect(sam).toHaveTextContent("Sam Smith");
    expect(sam).toHaveTextContent("League");
    expect(within(sam).getByText("12.00 cr").className).toContain("text-text-secondary");
    expect(within(alex).getByText("−16.00 cr").className).toContain("text-danger-strong");
    expect(sam.querySelector('[data-slot="avatar"]')).toHaveAttribute("aria-hidden", "true");
  });

  it("shows a loading state instead of 'no match' while members load", () => {
    render(<Picker members={[]} loading />, strict);
    fireEvent.click(trigger());
    expect(screen.getByRole("progressbar", { name: "Loading members" })).toBeInTheDocument();
    expect(screen.queryByText("No members match")).toBeNull();
  });

  it("wires an error to the trigger as its description and marks it invalid", () => {
    render(<Picker error="Could not load members" />, strict);
    const combobox = trigger();
    expect(combobox).toHaveAccessibleDescription("Could not load members");
    expect(combobox).toHaveAttribute("aria-invalid", "true");
  });
});
