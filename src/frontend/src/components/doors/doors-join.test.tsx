import { afterEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { DOORS_JOIN_FRESH_MS, useDoorsStore } from "./useDoorsChrome";
import { doorFixture, doorsServer, signIn, signOut, stubFetch } from "../../test/harness";

/**
 * Perf lane (2026-09-30) — the admin frame is a lazy chunk, so a doors reader can mount just after
 * another's read LANDED. It takes that read rather than sending the same GET again (E-L6); a read
 * older than {@link DOORS_JOIN_FRESH_MS} is read again, as before.
 */
afterEach(() => { signOut(); vi.restoreAllMocks(); });

function Reader() {
  useDoorsStore(true);
  return null;
}

function Readers() {
  const [second, setSecond] = useState(false);
  return (
    <>
      <Reader />
      {second ? <Reader /> : <button type="button" onClick={() => setSecond(true)}>join</button>}
    </>
  );
}

const doorReads = (stub: { calls: { path: string }[] }) => stub.calls.filter((c) => c.path === "/api/v1/admin/doors").length;

describe("a doors reader that joins after a read landed", () => {
  it("takes a read that landed moments ago, and reads again once it is older", async () => {
    signIn({ isAdmin: true });
    const stub = stubFetch(doorsServer([doorFixture()]).routes);
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    const first = render(<Readers />);
    await waitFor(() => expect(doorReads(stub)).toBe(1));
    await new Promise((r) => setTimeout(r, 20));

    now += DOORS_JOIN_FRESH_MS - 1;
    first.getByRole("button", { name: "join" }).click();
    await new Promise((r) => setTimeout(r, 20));
    expect(doorReads(stub)).toBe(1);
    first.unmount();

    // Everyone gone, the store starts over; a lone late reader reads.
    render(<Readers />);
    await waitFor(() => expect(doorReads(stub)).toBe(2));
  });

  it("reads again for a reader joining after the window", async () => {
    signIn({ isAdmin: true });
    const stub = stubFetch(doorsServer([doorFixture()]).routes);
    let now = 2_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const view = render(<Readers />);
    await waitFor(() => expect(doorReads(stub)).toBe(1));
    await new Promise((r) => setTimeout(r, 20));
    now += DOORS_JOIN_FRESH_MS;
    view.getByRole("button", { name: "join" }).click();
    await waitFor(() => expect(doorReads(stub)).toBe(2));
    view.unmount();
  });
});
