import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ContextBar } from "../context-bar";
import { Button } from "../button";

/**
 * Go-live BM-08 — "Invite a player" was a 640px docked panel, mostly empty, lying over a guest's
 * Remove button. A bar holding one verb and nothing else hugs it; a bar with a summary keeps the
 * full panel, because the summary needs the row.
 */
const panel = (container: HTMLElement) => container.querySelector("[data-context-bar='bottom'] > div")!;

describe("a docked bar's width (BM-08)", () => {
  it("one verb alone: the panel hugs it, on the right", () => {
    const { container } = render(<ContextBar position="bottom" label="Booking actions" primary={<Button>Invite a player</Button>} />);
    expect(panel(container).className.split(" ")).toEqual(expect.arrayContaining(["w-fit", "mr-0"]));
  });

  it("a summary beside the verb: the full panel stays", () => {
    const { container } = render(<ContextBar position="bottom" label="Wallet actions" summary={<span>2 h</span>} primary={<Button>Buy minutes</Button>} />);
    expect(panel(container).className.split(" ")).not.toContain("w-fit");
    expect(panel(container).className.split(" ")).toContain("w-full");
  });

  it("content of its own (a block button): the full panel stays", () => {
    const { container } = render(<ContextBar position="bottom" label="Wallet actions"><Button block>Buy minutes to start booking</Button></ContextBar>);
    expect(panel(container).className.split(" ")).not.toContain("w-fit");
  });
});
