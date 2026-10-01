import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { renderPage } from "../../../../test/harness";
import { useMemberTopUp } from "../useMemberTopUp";
import { useMinutesAdjust } from "../../../../components/members/useMinutesAdjust";
import { doneSentence } from "../../../../lib/deskMinutesCopy";
import type { MemberRow } from "../../../../components/members/membersModel";

/**
 * Review round 5, I5-3: the desk adjustment hooks reset their in-flight ref and key when the sheet
 * closed mid-movement, and a movement landing after its page had gone was said nowhere.
 */
afterEach(() => vi.unstubAllGlobals());

/** A fetch whose one reply the test releases. */
function heldFetch() {
  let release: (body: unknown) => void = () => {};
  const fetch = vi.fn(() => new Promise((resolve) => {
    release = (body) => resolve({
      ok: true, status: 200, headers: { get: () => null },
      text: () => Promise.resolve(JSON.stringify(body)), json: () => Promise.resolve(body),
    });
  }));
  vi.stubGlobal("fetch", fetch);
  return { fetch, land: (body: unknown) => release(body) };
}

function DetailProbe() {
  const topUp = useMemberTopUp("u-1", "Sam", () => {});
  return (
    <>
      <button onClick={topUp.show}>open</button>
      <button onClick={() => void topUp.apply(50, "goodwill", "Receipt 0412")}>apply</button>
      <button onClick={topUp.close}>close</button>
      <p>{topUp.open ? "sheet open" : "sheet shut"}</p>
    </>
  );
}

function Host({ children }: { children: React.ReactNode }) {
  const [shown, setShown] = useState(true);
  return (
    <>
      <button onClick={() => setShown(false)}>leave</button>
      {shown ? children : null}
    </>
  );
}

describe("the member page's desk adjustment (R5 I5-3)", () => {
  it("will not close mid-movement, and says a landing after the page has gone", async () => {
    const { fetch, land } = heldFetch();
    renderPage(<Host><DetailProbe /></Host>);
    fireEvent.click(screen.getByText("open"));
    fireEvent.click(screen.getByText("apply"));
    expect(fetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("close"));
    expect(screen.getByText("sheet open")).toBeInTheDocument();

    fireEvent.click(screen.getByText("leave"));
    await act(async () => { land({ balance_after_minutes: 250 }); });
    expect(await screen.findByText(doneSentence("Sam", 250))).toBeInTheDocument();
  });
});

const ROW = { user_id: "u-1", full_name: "Sam", email: "sam@x.test", balance_minutes: 200 } as unknown as MemberRow;

function ListProbe() {
  const credit = useMinutesAdjust(() => {});
  return (
    <>
      <button onClick={() => credit.open(ROW)}>open</button>
      <button onClick={() => void credit.apply(50, "goodwill", "Receipt 0412")}>apply</button>
      <button onClick={credit.close}>close</button>
      <p>{credit.target ? "sheet open" : "sheet shut"}</p>
    </>
  );
}

describe("the members list's desk adjustment (R5 I5-3)", () => {
  it("will not close mid-movement, and says a landing after the list has gone", async () => {
    const { land } = heldFetch();
    renderPage(<Host><ListProbe /></Host>);
    fireEvent.click(screen.getByText("open"));
    fireEvent.click(screen.getByText("apply"));
    fireEvent.click(screen.getByText("close"));
    expect(screen.getByText("sheet open")).toBeInTheDocument();

    fireEvent.click(screen.getByText("leave"));
    await act(async () => { land({ balance_after_minutes: 250 }); });
    expect(await screen.findByText(doneSentence("Sam", 250))).toBeInTheDocument();
  });
});
