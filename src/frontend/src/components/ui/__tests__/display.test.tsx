import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Avatar, AvatarFallback, AvatarImage } from "../avatar";
import { Badge, badgeVariants } from "../badge";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../card";
import { Progress } from "../progress";
import { Separator } from "../separator";
import { Skeleton } from "../skeleton";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "../table";

const strict = { reactStrictMode: true };

describe("Badge", () => {
  it("keeps the label in its own min-w-0 break-words span (flex text cannot shrink otherwise)", () => {
    render(<Badge tone="success">Checked in</Badge>, strict);
    const label = screen.getByText("Checked in");
    expect(label.tagName).toBe("SPAN");
    expect(label.className).toBe("min-w-0 break-words");
    const badge = label.parentElement!;
    expect(badge).toHaveAttribute("data-tone", "success");
    expect(badge.className).toContain("bg-success-soft text-success-strong");
  });

  it("has the six tones and nothing else, neutral by default", () => {
    expect(badgeVariants({})).toContain("bg-bg-muted");
    expect(badgeVariants({ tone: "info" })).toContain("text-info-strong");
    expect(badgeVariants({ tone: "warning" })).toContain("text-warning-strong");
    expect(badgeVariants({ tone: "danger" })).toContain("text-danger-strong");
    expect(badgeVariants({ tone: "brand" })).toContain("bg-brand-strong text-brand-ink");
  });
});

describe("Card", () => {
  it("renders every part, an h3 title by default and an h2 via asChild, with the action in the header", () => {
    render(
      <>
        <Card data-testid="card">
          <CardHeader>
            <CardTitle>Wallet</CardTitle>
            <CardDescription>Your credits.</CardDescription>
            <CardAction><button type="button">Top up</button></CardAction>
          </CardHeader>
          <CardContent>160 cr</CardContent>
          <CardFooter>Updated now</CardFooter>
        </Card>
        <Card><CardHeader><CardTitle asChild><h2>Section</h2></CardTitle></CardHeader></Card>
      </>,
      strict,
    );
    expect(screen.getByRole("heading", { level: 3, name: "Wallet" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Section" }).className).toContain("font-semibold");
    const card = screen.getByTestId("card");
    expect(card.className).toContain("rounded-xl border border-border bg-bg-surface");
    expect(card.className).toContain("shadow-xs");
    expect(screen.getByRole("button", { name: "Top up" }).closest("[data-slot=card-action]")).not.toBeNull();
  });
});

describe("Avatar", () => {
  it("falls back to initials, read as the full name", () => {
    render(
      <Avatar size={56}>
        <AvatarImage src="/nope.png" alt="Dean Martin" />
        <AvatarFallback name="Dean van der Martin" />
      </Avatar>,
      strict,
    );
    const fallback = screen.getByRole("img", { name: "Dean van der Martin" });
    expect(fallback).toHaveTextContent("DM");
    expect(fallback.closest("[data-slot=avatar]")).toHaveAttribute("data-size", "56");
  });

  it("maps each of the five sizes to its box", () => {
    const boxes = { 24: "size-6", 32: "size-8", 40: "size-10", 56: "size-14", 96: "size-24" } as const;
    for (const [size, cls] of Object.entries(boxes)) {
      const { unmount } = render(<Avatar size={Number(size) as 24}><AvatarFallback name="A" /></Avatar>, strict);
      expect(screen.getByRole("img", { name: "A" }).closest("[data-slot=avatar]")!.className).toContain(cls);
      unmount();
    }
  });

  it("single names and blanks still render something", () => {
    render(<><Avatar><AvatarFallback name="cher" /></Avatar><Avatar><AvatarFallback name="  " /></Avatar></>, strict);
    expect(screen.getByRole("img", { name: "cher" })).toHaveTextContent("C");
    expect(screen.getByRole("img", { name: "" })).toHaveTextContent("?");
  });
});

describe("Separator, Skeleton, Progress", () => {
  it("separator is decorative by default and a real separator on request", () => {
    const { container } = render(<><Separator /><Separator decorative={false} orientation="vertical" /></>, strict);
    expect(container.querySelector("[data-slot=separator]")).toHaveAttribute("role", "none");
    expect(screen.getByRole("separator")).toHaveAttribute("aria-orientation", "vertical");
  });

  it("skeleton is hidden from assistive tech and still under reduced motion", () => {
    const { container } = render(<Skeleton className="h-12" />, strict);
    const bone = container.querySelector("[data-slot=skeleton]")!;
    expect(bone).toHaveAttribute("aria-hidden", "true");
    expect(bone.className).toContain("motion-reduce:animate-none");
  });

  it("progress reports n of N and draws the fraction", () => {
    render(<Progress aria-label="Booking slots" value={3} max={8} />, strict);
    const bar = screen.getByRole("progressbar", { name: "Booking slots" });
    expect(bar).toHaveAttribute("aria-valuenow", "3");
    expect(bar).toHaveAttribute("aria-valuemax", "8");
    const indicator = bar.querySelector("[data-slot=progress-indicator]") as HTMLElement;
    expect(indicator.style.transform).toBe("translateX(-62.5%)");
  });
});

describe("Table", () => {
  it("renders a captioned table with column headers and cells in a scroller", () => {
    render(
      <Table>
        <TableCaption>Recent top-ups</TableCaption>
        <TableHeader><TableRow><TableHead>Member</TableHead><TableHead>Amount</TableHead></TableRow></TableHeader>
        <TableBody><TableRow><TableCell>Sam</TableCell><TableCell>160 cr</TableCell></TableRow></TableBody>
      </Table>,
      strict,
    );
    const table = screen.getByRole("table", { name: "Recent top-ups" });
    expect(table.parentElement).toHaveAttribute("data-slot", "table-container");
    expect(table.parentElement!.className).toContain("overflow-x-auto");
    expect(screen.getAllByRole("columnheader")).toHaveLength(2);
    expect(screen.getByRole("cell", { name: "160 cr" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Member" }).className).not.toContain("sticky");
  });

  it("stickyHeader pins the heads to the scroller", () => {
    render(
      <Table stickyHeader containerClassName="max-h-96">
        <TableHeader><TableRow><TableHead>Court</TableHead></TableRow></TableHeader>
        <TableBody><TableRow><TableCell>A</TableCell></TableRow></TableBody>
      </Table>,
      strict,
    );
    const head = screen.getByRole("columnheader", { name: "Court" });
    expect(head.className).toContain("sticky top-0 z-sticky");
    expect(head.className).toContain("bg-bg-muted");
    expect(screen.getByRole("table").parentElement!.className).toContain("max-h-96");
  });
});
