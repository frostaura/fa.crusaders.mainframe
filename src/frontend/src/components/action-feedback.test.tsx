import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Button } from "./ui/button";
import { ConfirmButton, confirmSubject } from "./ConfirmButton";
import { glyphKindFor, outcomeClassName, pressClassName, useActionFeedback, type ActionIntent } from "./useActionFeedback";

/** The marks a button shows, by name — never the hidden spinner the primitive keeps for width. */
const marks = (root: ParentNode) => [...root.querySelectorAll("[data-glyph]")].map((el) => el.getAttribute("data-glyph"));
/** Whether the width-locking pending layer (spinner) is the one on show. */
const working = (button: HTMLElement) =>
  !button.querySelector('[data-slot="button-pending"]')!.className.includes("opacity-0");

/**
 * Item 12 — the action feedback theme (`useActionFeedback`), which `ConfirmButton` wears.
 *
 * <p>
 * The tests that matter are the ones about what the theme does NOT do: a deletion does not
 * celebrate, nothing is drawn at rest, the hook renders no live region, and a rejected action
 * reaches a failure phase instead of the console. {@link Themed} is the smallest button that
 * wears the hook the way `ConfirmButton` does — the design-system `Button` with the hook's
 * props, classes and mark.
 * </p>
 */
function Themed({ intent, work, children }: { intent: ActionIntent; work?: () => unknown; children: string }) {
  const fb = useActionFeedback(intent);
  const outcome = fb.phase === "success" || fb.phase === "failure" ? fb.glyph : null;
  return (
    <Button
      {...fb.props}
      variant="secondary"
      pending={fb.phase === "working"}
      icon={outcome}
      className={fb.className}
      onClick={work ? () => { void fb.run(work); } : undefined}
    >
      {children}
    </Button>
  );
}

/** R8 / D5 — the thumbs are retired. A button at rest is its word, for every club. */
describe("no glyph at rest (R8)", () => {
  it.each(["affirm", "decline", "destructive"] as const)("an %s button at rest wears no mark", (intent) => {
    const { container } = render(<Themed intent={intent}>Book for 50.00 cr</Themed>);
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
    const { container } = render(<Themed intent="destructive" work={() => {}}>Delete</Themed>);
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
    render(<Themed intent="affirm" work={() => new Promise<void>((r) => { release = r; })}>Save</Themed>);
    const button = screen.getByRole("button", { name: /Save/ });
    expect(button).toHaveAttribute("data-fb", "rest");

    act(() => { fireEvent.pointerDown(button); });
    expect(button).toHaveAttribute("data-fb", "press");

    act(() => { fireEvent.click(button); });
    expect(button).toHaveAttribute("data-fb", "working");
    expect(button).toHaveAttribute("aria-busy", "true");
    // Working = the spinner, and nothing else (R8).
    expect(working(button)).toBe(true);
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
    render(<Themed intent="affirm" work={work}>Save</Themed>);
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
      render(<Themed intent="affirm">Save</Themed>);
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
    render(<Themed intent="affirm" work={() => Promise.reject(new Error("nope"))}>Save</Themed>);
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
  it("renders no live region of its own", () => {
    const { container } = render(<Themed intent="affirm" work={() => {}}>Book</Themed>);
    expect(container.querySelectorAll("[aria-live]")).toHaveLength(0);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(0);
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
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
