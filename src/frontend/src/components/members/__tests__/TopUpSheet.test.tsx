import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { TopUpSheet } from "../TopUpSheet";
import { renderPage } from "../../../test/harness";
import { ADJUST_SHEET, LIVE_SAID, NOT_REVENUE, REASON_MISSING, TAKE_BACK_LINK } from "../../../lib/deskMinutesCopy";
import { AMOUNT_COPY } from "../../../lib/amountCopy";

/**
 * The desk's "Adjust minutes" sheet (P13 §3.7) — goodwill and corrections only: whole minutes,
 * no rand (a desk SALE is `SellPackageSheet`), two paths, never one signed field. Carries the
 * review-round pins: F3.5 (frozen receipt), F3.17 (a ceiling at the field), F3.18 (the shared
 * parser), R3 A-4 / I-6, R5 I5-3.
 */
afterEach(() => vi.unstubAllGlobals());

const POINTER = { button: 0, ctrlKey: false, pointerType: "mouse" } as const;

type Apply = (amount: number, code: string, reason: string) => Promise<{ balanceAfterMinutes: number } | null>;

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
        if (r) setBalance(r.balanceAfterMinutes);
        return r;
      }}
      onClose={() => {}}
    />
  );
}

function typeAmount(text: string) {
  fireEvent.change(screen.getByLabelText(ADJUST_SHEET.amountLabel), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
}

async function chooseReason(label: string) {
  fireEvent.pointerDown(screen.getByRole("combobox"), POINTER);
  fireEvent.click(await screen.findByRole("option", { name: label }));
  fireEvent.change(screen.getByLabelText(ADJUST_SHEET.detailLabel), { target: { value: "Lights failed" } });
}

async function confirm() {
  fireEvent.click(screen.getByRole("button", { name: /^Add / }), { detail: 1 });
  fireEvent.click(document.querySelector<HTMLButtonElement>("[data-confirm='go']")!, { detail: 1 });
}

describe("the amount, in whole minutes through the shared parser", () => {
  it("refuses 1e3 as not a number, and a fraction of a minute as too precise", async () => {
    renderPage(<Harness apply={vi.fn()} />);
    typeAmount("1e3");
    expect(await screen.findByText(AMOUNT_COPY.notANumber("minutes"))).toBeInTheDocument();
    typeAmount("1,5");
    expect(await screen.findByText(AMOUNT_COPY.tooPrecise("minutes"))).toBeInTheDocument();
  });

  it("stops 99999999999 at the field and names the ceiling", async () => {
    renderPage(<Harness apply={vi.fn()} />);
    typeAmount("99999999999");
    expect(await screen.findByText(/^The most this can be is /)).toBeInTheDocument();
  });

  it("says typed minutes back as an amount, so 90 is seen to be an hour and a half", () => {
    renderPage(<Harness apply={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(ADJUST_SHEET.amountLabel), { target: { value: "90" } });
    expect(screen.getByText(ADJUST_SHEET.amountEcho(90))).toHaveTextContent("= 1 hour 30 minutes");
  });
});

describe("an adjustment is not money taken (P13 §3.7)", () => {
  it("offers only the four adjustment reasons — never a desk payment — and asks no rand", async () => {
    renderPage(<Harness apply={vi.fn()} />);
    typeAmount("30");
    fireEvent.pointerDown(screen.getByRole("combobox"), POINTER);
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(options).toEqual(["Goodwill — something went wrong", "Correcting a mistake", "Something else"]);
    expect(screen.queryByText(/Cash paid|EFT|Card paid/)).toBeNull();
    expect(screen.queryByLabelText(/money/i)).toBeNull();
  });

  it("sends the signed whole minutes, the code and the reason — and promises no revenue", async () => {
    const apply = vi.fn<Apply>().mockResolvedValue({ balanceAfterMinutes: 230 });
    renderPage(<Harness apply={apply} />);
    typeAmount("30");
    await chooseReason("Goodwill — something went wrong");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText(NOT_REVENUE)).toBeInTheDocument();
    await confirm();
    await waitFor(() => expect(apply).toHaveBeenCalledWith(30, "goodwill", "Lights failed"));
  });

  it("takes minutes back as a negative movement, with its own reasons", async () => {
    const apply = vi.fn<Apply>().mockResolvedValue({ balanceAfterMinutes: 155 });
    renderPage(<Harness apply={apply} />);
    fireEvent.click(screen.getByRole("button", { name: TAKE_BACK_LINK }));
    typeAmount("45");
    await chooseReason("Refunded outside the system");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Take back 45 minutes/ }), { detail: 1 });
    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-confirm='go']")!, { detail: 1 });
    await waitFor(() => expect(apply).toHaveBeenCalledWith(-45, "refund_outside_system", "Lights failed"));
  });
});

describe("the receipt is frozen at the press (F3.5)", () => {
  it("says what the balance WAS and became, in minutes, not a sum on the new balance", async () => {
    const apply = vi.fn<Apply>().mockResolvedValue({ balanceAfterMinutes: 230 });
    renderPage(<Harness apply={apply} />);
    typeAmount("30");
    await chooseReason("Goodwill — something went wrong");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await confirm();

    expect(await screen.findByText("Done. Sam now has 3 hours 50 minutes.", { selector: "[role='status']" })).toBeInTheDocument();
    expect(screen.getByText("Sam had 3 hours 20 minutes. +30 minutes → 3 hours 50 minutes.")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\bcr\b|\.00|credit/i);
  });
});

/** Review round 2 — A11Y F3-17 and VIS F3-15 on the amount step. */
describe("the quick amounts are radios that choose as the arrows move", () => {
  it("selects the amount the arrow key moves to", async () => {
    renderPage(<Harness apply={vi.fn()} />);
    const first = screen.getByRole("radio", { name: "+15 minutes" });
    fireEvent.click(first);
    expect(first).toHaveAttribute("aria-checked", "true");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });

    const second = screen.getByRole("radio", { name: "+30 minutes" });
    await waitFor(() => expect(second).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByLabelText(ADJUST_SHEET.amountLabel)).toHaveValue("30");
    expect(screen.getByRole("radio", { name: "+1 hour" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "+2 hours" })).toBeInTheDocument();
  });

  it("offers taking minutes back as a real button, not a line of text", () => {
    renderPage(<Harness apply={vi.fn()} />);
    const flip = screen.getByRole("button", { name: TAKE_BACK_LINK });
    expect(flip.className).toMatch(/border-control/);
    expect(flip.querySelector("svg")).not.toBeNull();
  });
});

/** Review round 3, A-4: each field says its own complaint, and focus goes to the first. */
describe("each field says its own complaint (R3 A-4)", () => {
  it("puts the missing reason under the reason, focusing it", async () => {
    renderPage(<Harness apply={vi.fn()} />);
    typeAmount("30");
    fireEvent.pointerDown(screen.getByRole("combobox"), POINTER);
    fireEvent.click(await screen.findByRole("option", { name: "Correcting a mistake" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    const detail = screen.getByLabelText(ADJUST_SHEET.detailLabel);
    expect(detail).toHaveAttribute("aria-invalid", "true");
    expect(detail).toHaveAccessibleDescription(expect.stringContaining(REASON_MISSING.detail));
    await waitFor(() => expect(detail).toHaveFocus());
  });

  it("names a missing reason code at the code, and focuses it", async () => {
    renderPage(<Harness apply={vi.fn()} />);
    typeAmount("30");
    fireEvent.change(screen.getByLabelText(ADJUST_SHEET.detailLabel), { target: { value: "Lights failed" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    const code = screen.getByRole("combobox");
    expect(code).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText(ADJUST_SHEET.detailLabel)).not.toHaveAttribute("aria-invalid");
    await waitFor(() => expect(code).toHaveFocus());
  });
});

/** Review round 3, I-6: the confirm's live region says what the caller found. */
describe("the confirm says what the caller found (R3 I-6)", () => {
  it("speaks the caller's line, never 'didn't go through', when no receipt came", async () => {
    renderPage(
      <TopUpSheet name="Sam" balance={200} busy={false} bookingError={null} onClose={() => {}}
        onApply={async () => ({ said: LIVE_SAID.unknown })} />,
    );
    typeAmount("30");
    await chooseReason("Goodwill — something went wrong");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await confirm();
    const live = () => document.querySelector("[data-confirm-group] > [aria-live='polite']");
    await waitFor(() => expect(live()).toHaveTextContent(LIVE_SAID.unknown));
    expect(live()).not.toHaveTextContent(/didn't go through/);
  });

  it("stretches the confirm across the sheet beside a full-width Back (R3 V-3, A-15)", async () => {
    renderPage(<Harness apply={vi.fn()} />);
    typeAmount("30");
    await chooseReason("Goodwill — something went wrong");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByRole("button", { name: /^Add 30 minutes/ })).toHaveClass("w-full");
  });
});

/** Review round 5, I5-3: the sheet stays open while the movement is on its way. */
describe("the sheet stays open while the movement is on its way (R5 I5-3)", () => {
  it("refuses Escape mid-movement and says it is waiting, again on the refusal", async () => {
    const onClose = vi.fn();
    let land: (r: { balanceAfterMinutes: number }) => void = () => {};
    renderPage(
      <TopUpSheet name="Sam" balance={200} busy={false} bookingError={null} onClose={onClose}
        onApply={() => new Promise((resolve) => { land = resolve; })} />,
    );
    typeAmount("30");
    await chooseReason("Goodwill — something went wrong");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await confirm();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector("[data-sheet='top-up']")).toBeInTheDocument();
    land({ balanceAfterMinutes: 230 });
    expect(await screen.findByText("Done. Sam now has 3 hours 50 minutes.", { selector: "[role='status']" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("says why Add waits when it opens over a movement still in flight", () => {
    renderPage(<TopUpSheet name="Sam" balance={200} busy bookingError={null} onClose={() => {}} onApply={vi.fn()} />);
    expect(document.querySelector("[data-sending-note]")).toHaveTextContent(ADJUST_SHEET.sending("Sam"));
  });
});
