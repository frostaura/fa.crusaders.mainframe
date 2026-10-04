import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactElement } from "react";
import { PageHeader, PageShell, Section } from "../page-shell";
import { TextLink } from "../text-link";
import { buttonVariants } from "../button-variants";

const strict = { reactStrictMode: true };
const routed = (ui: ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>, strict);

describe("PageShell", () => {
  it.each([
    ["narrow", "max-w-narrow"],
    ["content", "max-w-content"],
    ["wide", "max-w-wide"],
  ] as const)("owns the %s width, the gutters, the top padding and the section gap", (width, cls) => {
    const { container } = render(<PageShell width={width}><p>body</p></PageShell>);
    const shell = container.firstElementChild as HTMLElement;
    expect(shell).toHaveAttribute("data-page-shell", width);
    for (const token of [cls, "mx-auto", "px-4", "sm:px-6", "lg:px-8", "pt-6", "lg:pt-8", "gap-8"]) {
      expect(shell.className.split(" ")).toContain(token);
    }
  });

  it("defaults to the content width", () => {
    const { container } = render(<PageShell><p>body</p></PageShell>);
    expect(container.firstElementChild).toHaveAttribute("data-page-shell", "content");
  });
});

describe("PageHeader", () => {
  it("renders the page's only h1, marked for the route announcer", () => {
    routed(
      <PageShell>
        <PageHeader title="Members" description="Everyone at the club." />
        <Section title="Pending"><p>rows</p></Section>
      </PageShell>,
    );
    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent("Members");
    expect(headings[0]).toHaveAttribute("data-route-heading");
    expect(screen.getByText("Everyone at the club.")).toBeInTheDocument();
  });

  it("puts the actions in the right-aligned slot and the freshness beside them", () => {
    routed(
      <PageHeader
        title="Control board"
        actions={<button type="button" aria-label="Refresh">R</button>}
        freshness={<time>Updated 12s ago</time>}
      />,
    );
    const actions = document.querySelector<HTMLElement>("[data-page-actions]")!;
    expect(within(actions).getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    expect(actions.className).toContain("justify-end");
    // At EVERY width the row wraps and the title's basis is its longest word — the actions drop
    // under it rather than a word being broken (R1 F1.16; R6 L6-1: the `sm` grid broke words).
    // The geometry is e2e/layout-r6's; here, that no grid column is back.
    const row = actions.parentElement!;
    expect(row.className).toContain("flex-wrap");
    expect(row.className).not.toMatch(/grid/);
    expect(screen.getByRole("heading", { level: 1 }).className).toContain("flex-[1_1_min-content]");
    expect(screen.getByText("Updated 12s ago")).toBeInTheDocument();
  });

  it("renders a back link and an eyebrow when given", () => {
    routed(<PageHeader title="Sam Ndlovu" eyebrow="People" back={{ to: "/admin/members", label: "Members" }} />);
    const back = screen.getByRole("link", { name: "Members" });
    expect(back).toHaveAttribute("href", "/admin/members");
    expect(back.className).toContain("min-h-touch");
    expect(screen.getByText("People")).toBeInTheDocument();
  });

  it("renders no action slot when there are no actions", () => {
    routed(<PageHeader title="Wallet" />);
    expect(document.querySelector("[data-page-actions]")).toBeNull();
  });
});

describe("Section", () => {
  it("is a region named by its own h2", () => {
    routed(
      <Section title="Doors" description="Every door and its lock." actions={<button type="button">Add</button>}>
        <p>list</p>
      </Section>,
    );
    const region = screen.getByRole("region", { name: "Doors" });
    const h2 = within(region).getByRole("heading", { level: 2, name: "Doors" });
    expect(region).toHaveAttribute("aria-labelledby", h2.id);
    expect(within(region).getByRole("button", { name: "Add" })).toBeInTheDocument();
    expect(within(region).getByText("Every door and its lock.")).toBeInTheDocument();
  });
});

describe("TextLink", () => {
  it("inline: an underlined accent route link", () => {
    routed(<p>See <TextLink to="/wallet">your wallet</TextLink>.</p>);
    const link = screen.getByRole("link", { name: "your wallet" });
    expect(link).toHaveAttribute("href", "/wallet");
    expect(link).toHaveAttribute("data-text-link", "inline");
    expect(link.className).toContain("underline");
    expect(link.className).toContain("text-accent-strong");
    expect(link.querySelector("svg")).toBeNull();
  });

  it("standalone: semibold, a trailing caret, a 44px target", () => {
    routed(<TextLink variant="standalone" to="/bookings">All bookings</TextLink>);
    const link = screen.getByRole("link", { name: "All bookings" });
    expect(link.className).toContain("font-semibold");
    expect(link.className).toContain("min-h-touch");
    const caret = link.querySelector("svg")!;
    expect(caret).toHaveAttribute("aria-hidden", "true");
    expect(link.lastElementChild).toBe(caret);
  });

  // L12-4 (round 12): "Open wallet" was 16px beside the 14px "Buy minutes" button on My Code.
  it("standalone: the text size of the sm/md button it sits beside", () => {
    routed(<TextLink variant="standalone" to="/wallet">Open wallet</TextLink>);
    const link = screen.getByRole("link", { name: "Open wallet" });
    const size = (classes: string) => classes.split(/\s+/).filter((c) => /^text-(xs|sm|base|lg|xl)$/.test(c));
    expect(size(link.className)).toEqual(["text-sm"]);
    expect(size(buttonVariants({ size: "sm" }))).toEqual(size(link.className));
    expect(size(buttonVariants({ size: "md" }))).toEqual(size(link.className));
  });

  it("renders a plain anchor for an href", () => {
    render(<TextLink href="mailto:committee@example.test">Email the committee</TextLink>);
    const link = screen.getByRole("link", { name: "Email the committee" });
    expect(link).toHaveAttribute("href", "mailto:committee@example.test");
    expect(link.className).toContain("no-lift");
  });
});
