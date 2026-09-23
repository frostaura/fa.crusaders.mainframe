import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Button } from "./Button";
import { ConfirmButton, confirmSubject } from "./ConfirmButton";
import { glyphKindFor, outcomeClassName, pressClassName, useActionFeedback } from "./useActionFeedback";
import { CLUB_UI_FALLBACK, ClubUiContext, readActionGlyphSet } from "../lib/clubUi";

/** The marks a button shows, by name — never the hidden spinner the primitive keeps for width. */
const marks = (root: ParentNode) => [...root.querySelectorAll("[data-glyph]")].map((el) => el.getAttribute("data-glyph"));
/** Whether the width-locking pending layer (spinner) is the one on show. */
const working = (button: HTMLElement) =>
  !button.querySelector('[data-slot="button-pending"]')!.className.includes("opacity-0");

/**
 * Item 12 — the system-wide action feedback theme.
 *
 * <p>
 * The tests that matter here are the ones about what the theme does NOT do. It is installed
 * inside two primitives with well over a hundred call sites across four lanes editing in
 * parallel, so the assertions worth having are: a neutral button is byte-identical to what it
 * was, a deletion does not celebrate, the hook renders no live region, and a rejected action
 * reaches a failure phase instead of the console.
 * </p>
 */

describe("a neutral button is exactly the button it was", () => {
  it("renders the same classes with no intent as with intent=neutral", () => {
    const { container: bare } = render(<Button>Save</Button>);
    const { container: neutral } = render(<Button intent="neutral">Save</Button>);
    expect(neutral.querySelector("button")!.className)
      .toBe(bare.querySelector("button")!.className);
  });

  it("carries no data-fb, so the e2e count of acting controls stays meaningful", () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).not.toHaveAttribute("data-fb");
  });

  it("draws no mark at all", () => {
    const { container } = render(<Button intent="neutral">Save</Button>);
    expect(marks(container)).toEqual([]);
    // The primitive keeps a spinner in its hidden, width-locking pending layer; that is the only
    // svg, and it is not on show.
    expect(container.querySelectorAll("svg")).toHaveLength(1);
    expect(working(screen.getByRole("button", { name: "Save" }))).toBe(false);
  });
});

/**
 * R8 / D5 — the thumbs are retired. A button at rest is its word; the thumbs-up/down that affirm
 * and decline once wore at rest are gone for every club, and the club's `action_glyphs` choice
 * between thumbs and ✓/✕ is read but has no effect.
 */
describe("no glyph at rest (R8)", () => {
  it.each(["affirm", "decline", "destructive"] as const)("an %s button at rest wears no mark", (intent) => {
    const { container } = render(<Button intent={intent}>Book for 50.00 cr</Button>);
    expect(marks(container)).toEqual([]);
    // WCAG 2.5.3: the name is the words.
    expect(screen.getByRole("button", { name: "Book for 50.00 cr" })).toBeInTheDocument();
  });

  it("no phase before the work wears a mark, for any intent", () => {
    for (const intent of ["affirm", "decline", "destructive", "neutral"] as const) {
      expect(glyphKindFor(intent, "rest")).toBeNull();
      expect(glyphKindFor(intent, "press")).toBeNull();
    }
  });

  it("ignores the club's retired glyph setting: the same button under either value", () => {
    const under = (actionGlyphs: "thumbs" | "marks") => render(
      <ClubUiContext.Provider value={{ ...CLUB_UI_FALLBACK, actionGlyphs }}>
        <Button intent="affirm">Book</Button>
      </ClubUiContext.Provider>,
    ).container.innerHTML;
    expect(under("marks")).toBe(under("thumbs"));
  });

  /** Still tolerant, so an old payload parses — unknown is the default, never "the other one". */
  it.each([undefined, null, "", "THUMBS", "check_cross", 1, {}, []])(
    "still reads %p as the default, and nothing draws from it",
    (raw) => { expect(readActionGlyphSet(raw)).toBe("thumbs"); },
  );
});

describe("a destructive action never celebrates", () => {
  it("draws no mark of its own on success — the call site's icon is what it wears", () => {
    expect(glyphKindFor("destructive", "rest")).toBeNull();
    expect(glyphKindFor("destructive", "success")).toBeNull();
  });

  it("still says so when it fails, and still shows it is working", () => {
    expect(glyphKindFor("destructive", "failure")).toBe("failure");
    expect(glyphKindFor("destructive", "working")).toBe("working");
  });

  it("shows no tick when a deletion lands", async () => {
    const { container } = render(
      <Button intent="destructive" feedbackAnnouncement="Deleted." onAction={() => {}}>Delete</Button>,
    );
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Delete/ })); });
    expect(screen.getByRole("button", { name: /Delete/ })).toHaveAttribute("data-fb", "success");
    expect(marks(container)).toEqual([]);
  });

  it("settles to muted, never to the success pair", () => {
    const settled = outcomeClassName("destructive", "success");
    expect(settled).toContain("bg-bg-muted");
    expect(settled).not.toContain("success-soft");
    expect(settled).not.toContain("fb-pop");
  });

  it("presses slowly and does not compress", () => {
    expect(pressClassName("destructive", "press")).not.toContain("scale-");
    expect(pressClassName("affirm", "press")).toContain("scale-[0.97]");
  });

  it("is what tone=danger means on a ConfirmButton, with no call site change", () => {
    render(
      <ConfirmButton tone="danger" idleLabel="Delete" confirmLabel="Gone for good." onConfirm={() => {}} />,
    );
    const trigger = screen.getByRole("button", { name: "Delete" });
    expect(trigger).toHaveAttribute("data-intent", "destructive");
    // No thumbs-up over a deletion — ruling 4, asserted rather than trusted.
    expect(trigger.querySelector("svg")).toBeNull();
  });
});

describe("the outcome phases", () => {
  it("passes press -> working -> success", async () => {
    let release: () => void = () => {};
    render(
      <Button intent="affirm" feedbackAnnouncement="Saved." onAction={() => new Promise<void>((r) => { release = r; })}>
        Save
      </Button>,
    );
    const button = screen.getByRole("button", { name: /Save/ });
    expect(button).toHaveAttribute("data-fb", "rest");
    // Through the compat shim the pending layer takes no room at rest (B12 widths), and is laid
    // out only while working — asserted as the class, since jsdom has no layout.
    const RESTING = "[&_[data-slot=button-pending]]:hidden";
    expect(button.className).toContain(RESTING);

    act(() => { fireEvent.pointerDown(button); });
    expect(button).toHaveAttribute("data-fb", "press");

    act(() => { fireEvent.click(button); });
    expect(button).toHaveAttribute("data-fb", "working");
    expect(button).toHaveAttribute("aria-busy", "true");
    // Working = the spinner, and nothing else (R8).
    expect(working(button)).toBe(true);
    expect(button.className).not.toContain(RESTING);
    expect(marks(button)).toEqual([]);

    await act(async () => { release(); });
    expect(button).toHaveAttribute("data-fb", "success");
    // Success = the hand-drawn tick, drawn on arrival; the spinner is gone.
    expect(working(button)).toBe(false);
    expect(marks(button)).toEqual(["check"]);
    expect(button.querySelector('[data-glyph="check"]')).toHaveAttribute("aria-hidden", "true");
  });

  it("ignores a second press while it is working, so the work never runs twice", async () => {
    let release: () => void = () => {};
    const work = vi.fn(() => new Promise<void>((r) => { release = r; }));
    render(<Button intent="affirm" feedbackAnnouncement="Saved." onAction={work}>Save</Button>);
    const button = screen.getByRole("button", { name: /Save/ });
    act(() => { fireEvent.click(button); });
    act(() => { fireEvent.click(button); });
    expect(work).toHaveBeenCalledTimes(1);
    await act(async () => { release(); });
  });

  /**
   * The press releases itself, because the commonest press in this product unmounts the
   * button it landed on — `ConfirmButton`'s trigger arms the control and disappears.
   */
  it("does not stay compressed waiting for a pointerup that never comes", async () => {
    vi.useFakeTimers();
    try {
      render(<Button intent="affirm">Save</Button>);
      const button = screen.getByRole("button", { name: "Save" });
      act(() => { fireEvent.pointerDown(button); });
      expect(button).toHaveAttribute("data-fb", "press");
      act(() => { vi.advanceTimersByTime(200); });
      expect(button).toHaveAttribute("data-fb", "rest");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reaches failure on a rejection rather than letting it reach the button's caller", async () => {
    render(
      <Button intent="affirm" feedbackAnnouncement="Saved." onAction={() => Promise.reject(new Error("nope"))}>
        Save
      </Button>,
    );
    const button = screen.getByRole("button", { name: /Save/ });
    await act(async () => { fireEvent.click(button); });
    await waitFor(() => expect(button).toHaveAttribute("data-fb", "failure"));
    // Failure = the alert mark, plus the shake below.
    expect(marks(button)).toEqual(["alert"]);
    expect(button.className).toContain("animate-fb-shake");
  });

  /**
   * The same fact from the hook's own side, as a VALUE.
   *
   * <p>
   * A `process.on("unhandledRejection")` probe was the first cut and it is a trap in this
   * runner: vitest shares a worker process between test FILES, so the listener catches
   * whatever a neighbouring file rejects and the test fails for a reason that has nothing to
   * do with it. Measured — it went red once in a mixed run and passed five times alone.
   * Asserting the resolved outcome proves the same thing deterministically.
   * </p>
   */
  it("hands the error back instead of throwing it", async () => {
    const seen: unknown[] = [];
    function Probe() {
      const fb = useActionFeedback("affirm");
      return (
        <button onClick={() => { void fb.run(() => Promise.reject(new Error("nope"))).then((o) => seen.push(o)); }}>
          Go
        </button>
      );
    }
    render(<Probe />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Go" })); });
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toMatchObject({ ok: false });
    expect((seen[0] as { error: Error }).error.message).toBe("nope");
  });

  it("shakes once on failure, and the shake carries its own reduced-motion sibling", () => {
    const failed = outcomeClassName("affirm", "failure");
    expect(failed).toContain("animate-fb-shake");
    // The global block in index.css cannot cover a Tailwind `animation` shorthand; the class
    // at the use site is what does. Dropping it is mutant #7 in the design's hunt list.
    expect(failed).toContain("motion-reduce:animate-none");
  });
});

describe("the theme is not what speaks", () => {
  it("renders no live region of its own on a themed button with nothing to say", () => {
    const { container } = render(<Button intent="affirm">Book</Button>);
    expect(container.querySelectorAll("[aria-live]")).toHaveLength(0);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(0);
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
  });

  it("renders exactly one polite region — never a status landmark — when it does speak", async () => {
    const { container } = render(
      <Button intent="affirm" feedbackAnnouncement="Saved." onAction={() => {}}>Save</Button>,
    );
    expect(container.querySelectorAll("[aria-live]")).toHaveLength(1);
    // `role="status"` is the same live region plus a landmark. A screen of these would put a
    // dozen empty landmarks in the tree — `getByRole("status")` on the doors overview once
    // found eleven.
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(0);

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Save/ })); });
    expect(container.querySelector("[aria-live]")!.textContent).toBe("Saved.");
  });

  it("stays silent where something else announces", () => {
    const { container } = render(
      <Button intent="affirm" announcedElsewhere onAction={() => {}}>Book</Button>,
    );
    expect(container.querySelectorAll("[aria-live]")).toHaveLength(0);
  });

  /**
   * A silent visual success is a success a blind member is never told about. This can only
   * fire on code being written now — `intent` is new and defaults to neutral — which is when
   * it is a one-line fix rather than a finding in a review.
   */
  it("refuses, in development, to do work with no announcer of any kind", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => render(<Button intent="affirm" onAction={() => {}}>Book</Button>)).toThrow(/blind member/);
    } finally {
      quiet.mockRestore();
    }
  });

  it("allows an intent with no work at all — a button that navigates announces nothing", () => {
    expect(() => render(<Button intent="affirm">Go to the wallet</Button>)).not.toThrow();
  });
});

/**
 * C-M3's other half: the way out, named after the thing it refuses to do.
 *
 * The doors console passes the door's name through `ariaLabel` rather than `subject`, so
 * those call sites fell straight through to the idle label and kept the defect.
 */
describe("the way out is named for its subject, from whichever prop the call site used", () => {
  it("takes `subject` first, because it is the one that is a noun on purpose", () => {
    expect(confirmSubject("Side door", "Shut Side door", "Shut this door")).toBe("Side door");
  });

  it("drops the words the label and the context share", () => {
    expect(confirmSubject(undefined, "Shut Side door", "Shut this door")).toBe("Side door");
  });

  it("produces the doors console's own sentence end to end", () => {
    render(
      <ConfirmButton
        tone="danger"
        idleLabel="Shut this door"
        cancelLabel="Keep it open"
        ariaLabel="Shut Side door"
        confirmLabel="Nobody gets in with a code until it is reopened."
        onConfirm={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Shut this door/ }));
    expect(screen.getByRole("button", { name: /^Keep it open/ }).getAttribute("aria-label"))
      .toBe("Keep it open — Side door");
  });

  it("never returns empty, whatever it is handed", () => {
    // Label and context identical: stripping leaves nothing, so the context stands.
    expect(confirmSubject(undefined, "Delete", "Delete")).toBe("Delete");
    // No context at all: the idle label, which is what every call site had before `subject`.
    expect(confirmSubject(undefined, undefined, "Revoke")).toBe("Revoke");
  });

  /**
   * Words, not characters. A character-wise common prefix of "Shutter" and "Shut this door"
   * is "Shut", which would leave "ter …" — half a word in an accessible name is worse than
   * none.
   */
  it("compares whole words", () => {
    expect(confirmSubject(undefined, "Shutter the clubhouse", "Shut this door"))
      .toBe("Shutter the clubhouse");
  });
});
