import { describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { ToastProvider, useToast } from "./Toast";

/**
 * C10 — a toast was announced twice, and nothing in the DOM looked wrong.
 *
 * <p>
 * The viewport carried <code>aria-live="polite"</code> and every toast inside it carries
 * <code>role="status"</code>, which is the same live region nested in itself: a screen
 * reader announced the download toast once because a node was inserted into a live region,
 * and once more because the node inserted was itself a live region. One live ancestor is the
 * rule, and the toast is the better place for it — it is the thing that arrives, it carries
 * the text, and it keeps announcing correctly if the viewport is ever moved or split.
 * </p>
 */

function Raise({ text }: { text: string }) {
  const toast = useToast();
  return <button type="button" onClick={() => toast.push({ text })}>Raise</button>;
}

/** Everything in the document that a screen reader would treat as a live region. */
function liveRegions(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[aria-live], [role="status"], [role="alert"], [role="log"]')];
}

describe("the toast viewport", () => {
  it("puts exactly one live ancestor over each toast", () => {
    render(<ToastProvider><Raise text="Download started." /></ToastProvider>);

    act(() => { screen.getByRole("button", { name: "Raise" }).click(); });

    const regions = liveRegions();
    expect(regions.length).toBeGreaterThan(0);
    for (const region of regions) {
      const nested = regions.filter((other) => other !== region && region.contains(other));
      expect(nested, `${region.outerHTML.slice(0, 80)} holds another live region`).toHaveLength(0);
    }
    // And the one that remains is the toast itself, which is what carries the words.
    expect(screen.getByRole("status")).toHaveTextContent("Download started.");
  });

  /**
   * B13 — it sits BELOW the chrome rather than on top of it.
   *
   * <p>
   * <code>top-[100px]</code> was a guess at the header's height. At a 32 px root font size
   * the header plus the section tab strip is taller than that, so the offline error toast
   * covered the tab bar — the only way between sections a phone has. `Layout` measures its
   * own header and publishes `--app-chrome-height`; a constant is right on exactly one
   * device, and it was not the one the finding was raised on. The fallback of 0 is correct
   * for the screens with no chrome at all — login, the public landing — which are the
   * screens where 100 px had nothing to clear.
   * </p>
   */
  it("is anchored below whatever the chrome actually measures", () => {
    const { container } = render(<ToastProvider><Raise text="Offline." /></ToastProvider>);

    const viewport = container.parentElement!.querySelector<HTMLElement>(".fixed")!;
    expect(viewport.style.top).toBe("calc(var(--app-chrome-height, 0px) + 12px)");
    expect(viewport.className).not.toContain("top-[100px]");
  });
});
