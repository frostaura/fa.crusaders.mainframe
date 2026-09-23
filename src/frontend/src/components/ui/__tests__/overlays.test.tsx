import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../tooltip";
import { InfoPopover } from "../info-popover";
import { Popover, PopoverContent, PopoverTrigger } from "../popover";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../dropdown-menu";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../accordion";

const strict = { reactStrictMode: true };

describe("Tooltip", () => {
  it("names an icon button: its content appears on keyboard focus, on the tooltip layer", () => {
    render(
      <Tooltip>
        <TooltipTrigger aria-label="Refresh">↻</TooltipTrigger>
        <TooltipContent>Refresh</TooltipContent>
      </Tooltip>,
      strict,
    );
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => screen.getByRole("button", { name: "Refresh" }).focus());
    expect(screen.getByRole("tooltip")).toHaveTextContent("Refresh");
    const surface = document.querySelector<HTMLElement>('[data-slot="tooltip-content"]');
    expect(surface?.className).toContain("z-tooltip");
    expect(surface?.className).toContain("bg-bg-raised");
  });
});

describe("Popover and InfoPopover", () => {
  it("renders the popover on the popover layer with the raised surface", () => {
    render(
      <Popover>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>Body</PopoverContent>
      </Popover>,
      strict,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const panel = screen.getByRole("dialog");
    for (const token of ["z-popover", "bg-bg-raised", "border-border", "shadow-md", "rounded-xl"]) {
      expect(panel.className).toContain(token);
    }
  });

  it("is a 44px (i) button named 'More about <label>' that opens its guidance", () => {
    render(
      <InfoPopover label="Peak hours">Members in a peak group book first between 17:00 and 20:00.</InfoPopover>,
      strict,
    );
    const button = screen.getByRole("button", { name: "More about Peak hours" });
    expect(button.className).toContain("size-touch");
    expect(button).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    const panel = screen.getByRole("dialog", { name: "Peak hours" });
    expect(panel).toHaveTextContent("Members in a peak group book first");
  });
});

describe("DropdownMenu", () => {
  function RowMenu({ onSuspend }: { onSuspend: () => void }) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger aria-label="More actions for Sam">⋯</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>Sam Smith</DropdownMenuLabel>
          <DropdownMenuItem>Book for member</DropdownMenuItem>
          <DropdownMenuCheckboxItem checked>Show in directory</DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="danger" onSelect={onSuspend}>
            Suspend
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  it("opens on pointerdown into 44px no-lift menuitems, and selecting one runs it and closes", () => {
    const onSuspend = vi.fn();
    render(<RowMenu onSuspend={onSuspend} />, strict);
    const trigger = screen.getByRole("button", { name: "More actions for Sam" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    const menu = screen.getByRole("menu");
    expect(menu.className).toContain("z-popover");
    expect(menu.className).toContain("bg-bg-raised");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Book for member", "Suspend"]);
    for (const item of items) {
      expect(item.className).toContain("min-h-touch");
      expect(item.className).toContain("no-lift");
    }
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Show in directory" })).toHaveAttribute("aria-checked", "true");
    const suspend = within(menu).getByRole("menuitem", { name: "Suspend" });
    expect(suspend.className).toContain("text-danger-strong");
    fireEvent.click(suspend);
    expect(onSuspend).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens from the keyboard too", () => {
    render(<RowMenu onSuspend={() => undefined} />, strict);
    fireEvent.keyDown(screen.getByRole("button", { name: "More actions for Sam" }), { key: "Enter" });
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });
});

describe("Accordion", () => {
  it("toggles aria-expanded on a 44px trigger, with reduced-motion-safe collapse animations", () => {
    render(
      <Accordion type="single" collapsible>
        <AccordionItem value="booking">
          <AccordionTrigger>Booking rules</AccordionTrigger>
          <AccordionContent>Members may book 7 days ahead.</AccordionContent>
        </AccordionItem>
        <AccordionItem value="money">
          <AccordionTrigger>Money</AccordionTrigger>
          <AccordionContent>Top-ups convert at the group rate.</AccordionContent>
        </AccordionItem>
      </Accordion>,
      strict,
    );
    const booking = screen.getByRole("button", { name: "Booking rules" });
    expect(booking).toHaveAttribute("aria-expanded", "false");
    expect(booking.className).toContain("min-h-touch");
    expect(screen.queryByText("Members may book 7 days ahead.")).toBeNull();
    fireEvent.click(booking);
    expect(booking).toHaveAttribute("aria-expanded", "true");
    const region = screen.getByRole("region", { name: "Booking rules" });
    expect(region).toHaveTextContent("Members may book 7 days ahead.");
    expect(region.className).toContain("data-[state=open]:animate-collapse-down");
    expect(region.className).toContain("motion-reduce:animate-none");
    fireEvent.click(screen.getByRole("button", { name: "Money" }));
    expect(booking).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Money" })).toHaveAttribute("aria-expanded", "true");
  });
});
