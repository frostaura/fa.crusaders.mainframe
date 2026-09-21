import { describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { NOTHING_CHANGED, ToastProvider, useToast } from "./Toast";

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
   * R3-28 / B10 — it is anchored to the BOTTOM, away from the line it contradicts.
   *
   * <p>
   * B13 moved it off a guessed <code>top-[100px]</code> and under the measured chrome, which
   * fixed it covering the tab strip. Under the chrome is still where the page puts the thing
   * the toast argues with: reviewer B failed a shut and read "Could not shut that door." sitting
   * on top of the door's own status line. The far edge of the screen is the one place no
   * heading, chip or status line in this product lives.
   * </p>
   *
   * <p>
   * The geometry itself — that it clears the header and does not cover the page's heading — is
   * measured in a real engine by `e2e/app-chrome.spec.ts`; jsdom has no layout.
   * </p>
   */
  it("is anchored to the bottom of the screen, clear of the safe area", () => {
    const { container } = render(<ToastProvider><Raise text="Offline." /></ToastProvider>);

    const viewport = container.parentElement!.querySelector<HTMLElement>(".fixed")!;
    expect(viewport.className).toContain("bottom-[calc(env(safe-area-inset-bottom,0px)+12px)]");
    expect(viewport.className).not.toMatch(/(^|\s)top-/);
    expect(viewport.style.top).toBe("");
  });

  /**
   * R3-28 — a failure that can say the world is unchanged. (B10)
   *
   * <p>
   * "Could not shut that door." answers the wrong question. The admin is looking at a status
   * line that still says the old thing and has no way to tell whether it is stale or correct.
   * Opt-in and never inferred from the tone: a request that timed out after the server
   * committed it failed and changed everything, so only a caller that knows may say it.
   * </p>
   */
  it("can say that nothing changed, and does not say it uninvited", () => {
    function Raiser() {
      const toast = useToast();
      return (
        <>
          <button type="button" onClick={() => toast.push({ tone: "danger", text: "Could not shut that door.", unchanged: true })}>
            Failed, unchanged
          </button>
          <button type="button" onClick={() => toast.push({ tone: "danger", text: "Could not shut that door." })}>
            Failed, unknown
          </button>
        </>
      );
    }

    render(<ToastProvider><Raiser /></ToastProvider>);

    act(() => { screen.getByRole("button", { name: "Failed, unknown" }).click(); });
    expect(screen.getByRole("status")).toHaveTextContent("Could not shut that door.");
    expect(screen.getByRole("status")).not.toHaveTextContent(NOTHING_CHANGED);

    act(() => { screen.getByRole("button", { name: "Failed, unchanged" }).click(); });
    const said = screen.getAllByRole("status").map((n) => n.textContent ?? "");
    expect(said.some((text) => text.includes(`Could not shut that door.${NOTHING_CHANGED}`))).toBe(true);
  });
});
