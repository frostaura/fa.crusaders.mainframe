import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { TopUpSheet } from "../TopUpSheet";
import { renderPage } from "../../../test/harness";
import { LIVE_SAID, REASON_MISSING, ZAR_RECEIVED } from "../../../lib/topUpCopy";
import { AMOUNT_COPY } from "../../../lib/amountCopy";

/**
 * The desk top-up sheet — review round 1: F3.4 (rand received), F3.5 (frozen receipt),
 * F3.17 (a ceiling at the field), F3.18 (the shared parser).
 */
afterEach(() => vi.unstubAllGlobals());

const POINTER = { button: 0, ctrlKey: false, pointerType: "mouse" } as const;

type Apply = (amount: number, code: string, reason: string, zar?: number) => Promise<{ balanceAfterCredits: number } | null>;

/** The sheet as its callers mount it: the balance prop follows the server's answer. */
function Harness({ apply }: { apply: Apply }) {
  const [balance, setBalance] = useState(200);
  return (
    <TopUpSheet
      name="Sam"
      balance={balance}
      busy={false}
      bookingError={null}
      onApply={async (...args) => {
        const r = await apply(...(args as Parameters<Apply>));
        if (r) setBalance(r.balanceAfterCredits);
        return r;
      }}
      onClose={() => {}}
    />
  );
}

function typeAmount(text: string) {
  fireEvent.change(screen.getByLabelText("Another amount"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
}

async function chooseReason(label: string) {
  fireEvent.pointerDown(screen.getByRole("combobox"), POINTER);
  fireEvent.click(await screen.findByRole("option", { name: label }));
  fireEvent.change(screen.getByLabelText("And why this one?"), { target: { value: "Receipt 0412" } });
}

async function confirm() {
  fireEvent.click(screen.getByRole("button", { name: /^Add / }), { detail: 1 });
  fireEvent.click(document.querySelector<HTMLButtonElement>("[data-confirm='go']")!, { detail: 1 });
}

describe("the amount, through the shared parser", () => {
  it("refuses 1e3 as not a number and takes 1,5 as one and a half", async () => {
    renderPage(<Harness apply={vi.fn()} />);
    typeAmount("1e3");
    expect(await screen.findByText(AMOUNT_COPY.notANumber("credits"))).toBeInTheDocument();
    typeAmount("1,5");
    expect(await screen.findByLabelText("And why this one?")).toBeInTheDocument();
  });

  it("stops 99999999999 at the field and names the ceiling", async () => {
    renderPage(<Harness apply={vi.fn()} />);
    typeAmount("99999999999");
    expect(await screen.findByText(/The most this can be is 99999999\.99 cr/)).toBeInTheDocument();
  });
});

describe("a top-up that counts as revenue asks what money was received (F3.4)", () => {
  it("requires the rand, shows it on the check, and sends it", async () => {
    const apply = vi.fn<Apply>().mockResolvedValue({ balanceAfterCredits: 440 });
    renderPage(<Harness apply={apply} />);
    typeAmount("240");
    await chooseReason("Cash paid at the desk");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText(AMOUNT_COPY.empty("rand"))).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(ZAR_RECEIVED.label), { target: { value: "150" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText(ZAR_RECEIVED.row)).toBeInTheDocument();
    expect(screen.getByText(/R150\.00 counts as money the club took/)).toBeInTheDocument();

    await confirm();
    await waitFor(() => expect(apply).toHaveBeenCalledWith(240, "top_up_cash", "Receipt 0412", 150));
  });

  it("asks nothing and promises no revenue for goodwill", async () => {
    const apply = vi.fn<Apply>().mockResolvedValue({ balanceAfterCredits: 250 });
    renderPage(<Harness apply={apply} />);
    typeAmount("50");
    await chooseReason("Goodwill — something went wrong");
    expect(screen.queryByLabelText(ZAR_RECEIVED.label)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText(/stays out of the club's revenue/)).toBeInTheDocument();
    await confirm();
    await waitFor(() => expect(apply).toHaveBeenCalledWith(50, "goodwill", "Receipt 0412", undefined));
  });
});

describe("the receipt is frozen at the press (F3.5)", () => {
  it("says what the balance WAS and became, not a sum on the new balance", async () => {
    const apply = vi.fn<Apply>().mockResolvedValue({ balanceAfterCredits: 250 });
    renderPage(<Harness apply={apply} />);
    typeAmount("50");
    await chooseReason("Goodwill — something went wrong");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await confirm();

    expect(await screen.findByText("Done. Sam now has 250.00 cr.", { selector: "[role='status']" })).toBeInTheDocument();
    expect(screen.getByText("Sam had 200.00 cr. +50.00 cr → 250.00 cr.")).toBeInTheDocument();
    expect(screen.queryByText(/After \+50\.00 cr: 300\.00 cr/)).not.toBeInTheDocument();
  });
});

/**
 * Review round 2 — A11Y F3-17 (its screenshot is the MEMBER top-up page; the desk's quick amounts
 * already chose on arrow, and this pins that they still do) and VIS F3-15 on the amount step.
 */
describe("the quick amounts are radios that choose as the arrows move", () => {
  it("selects the amount the arrow key moves to", async () => {
    renderPage(<Harness apply={vi.fn()} />);
    const first = screen.getByRole("radio", { name: "+50.00 cr" });
    fireEvent.click(first);
    expect(first).toHaveAttribute("aria-checked", "true");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });

    const second = screen.getByRole("radio", { name: "+100.00 cr" });
    await waitFor(() => expect(second).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByLabelText("Another amount")).toHaveValue("100");
  });

  it("offers taking credit back as a real button, not a line of text", () => {
    renderPage(<Harness apply={vi.fn()} />);
    const flip = screen.getByRole("button", { name: "Take credit back instead" });
    // The outline look — a bordered surface — rather than the borderless ghost it was.
    expect(flip.className).toMatch(/border-control/);
    expect(flip.querySelector("svg")).not.toBeNull();
  });
});

/**
 * Review round 3, A-4: with a revenue code chosen and the "why" left empty, the "why this one?"
 * complaint was rendered under the RAND field — aria-invalid on the wrong input — and focus
 * stayed on Next. Each field now says its own complaint, and focus goes to the first of them.
 */
describe("each field says its own complaint (R3 A-4)", () => {
  it("puts the missing reason under the reason and the missing rand under the rand, focusing the first", async () => {
    renderPage(<Harness apply={vi.fn()} />);
    typeAmount("240");
    fireEvent.pointerDown(screen.getByRole("combobox"), POINTER);
    fireEvent.click(await screen.findByRole("option", { name: "Cash paid at the desk" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    const detail = screen.getByLabelText("And why this one?");
    const zar = screen.getByLabelText(ZAR_RECEIVED.label);
    expect(detail).toHaveAttribute("aria-invalid", "true");
    expect(detail).toHaveAccessibleDescription(expect.stringContaining(REASON_MISSING.detail));
    expect(zar).toHaveAttribute("aria-invalid", "true");
    expect(zar).toHaveAccessibleDescription(expect.stringContaining(AMOUNT_COPY.empty("rand")));
    expect(zar).not.toHaveAccessibleDescription(expect.stringContaining(REASON_MISSING.detail));
    await waitFor(() => expect(detail).toHaveFocus());
  });

  it("names a missing reason code at the code, and focuses it", async () => {
    renderPage(<Harness apply={vi.fn()} />);
    typeAmount("50");
    fireEvent.change(screen.getByLabelText("And why this one?"), { target: { value: "Receipt 0412" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    const code = screen.getByRole("combobox");
    expect(code).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("And why this one?")).not.toHaveAttribute("aria-invalid");
    await waitFor(() => expect(code).toHaveFocus());
  });
});

/**
 * Review round 3, I-6: the confirm's live region said "That didn't go through." whatever the
 * caller reported — over an outcome not known yet, and over a 409 proving the movement landed.
 */
describe("the confirm says what the caller found (R3 I-6)", () => {
  it("speaks the caller's line, never 'didn't go through', when no receipt came", async () => {
    renderPage(
      <TopUpSheet name="Sam" balance={200} busy={false} bookingError={null} onClose={() => {}}
        onApply={async () => ({ said: LIVE_SAID.unknown })} />,
    );
    typeAmount("50");
    await chooseReason("Goodwill — something went wrong");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await confirm();
    const live = () => document.querySelector("[data-confirm-group] > [aria-live='polite']");
    await waitFor(() => expect(live()).toHaveTextContent(LIVE_SAID.unknown));
    expect(live()).not.toHaveTextContent(/didn't go through/);
  });

  it("stretches the confirm across the sheet beside a full-width Back (R3 V-3, A-15)", async () => {
    renderPage(<Harness apply={vi.fn()} />);
    typeAmount("50");
    await chooseReason("Goodwill — something went wrong");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByRole("button", { name: /^Add 50\.00 cr/ })).toHaveClass("w-full");
  });
});
