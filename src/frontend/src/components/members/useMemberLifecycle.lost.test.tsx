import { describe, expect, it } from "vitest";
import { useState } from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { memberFixture, refuse, renderPage, stubFetch } from "../../test/harness";
import { OUTCOMES } from "@/lib/membersCopy";
import { useMemberLifecycle } from "./useMemberLifecycle";
import type { MemberRow } from "./membersModel";

/**
 * FA-11: reject, suspend and reactivate were direct writes, so a lost reply read as a failure
 * over a change that may have landed. Each now asks the member's status, as Approve does (F3-3):
 * landed → said as landed and the dialog closes; unreadable → "not known yet"; not landed, or
 * refused → thrown, so the dialog stays open and says why.
 */

const ROW = memberFixture({ status: "Active" }) as unknown as MemberRow;
const MEMBERSHIP = ROW.membership_id;
const DETAIL = `/api/v1/admin/members/${ROW.user_id}`;

function Probe({ act }: { act: "reject" | "suspend" | "reactivate" }) {
  const life = useMemberLifecycle({ load: async () => undefined });
  const [threw, setThrew] = useState<string | null>(null);
  const run = () => (act === "reactivate" ? life.reactivate(ROW) : life[act](ROW, "a reason"));
  return (
    <>
      <button type="button" onClick={() => void run()?.catch((e: unknown) => setThrew(String((e as Error)?.message ?? e)))}>go</button>
      {threw && <p>threw: {threw}</p>}
    </>
  );
}

const lost = (act: string) => ({ method: "POST", path: `/api/v1/admin/members/${MEMBERSHIP}/${act}`, body: refuse(504, { error: "gateway_timeout" }) });

describe("a member transition whose reply was lost", () => {
  it.each([
    ["suspend", "Suspended", "suspended"],
    ["reactivate", "Active", "active again"],
    ["reject", "Rejected", "rejected"],
  ] as const)("%s that landed is said as landed, never as failed", async (act, status, did) => {
    stubFetch([lost(act), { path: DETAIL, body: { ...memberFixture(), status } }]);
    renderPage(<Probe act={act} />);
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    expect(await screen.findByText(OUTCOMES.transitionAfterLostReply("Ada Lovelace", did))).toBeInTheDocument();
    expect(screen.queryByText(/^threw:/)).not.toBeInTheDocument();
  });

  it("says it is not known when the member cannot be read either", async () => {
    stubFetch([lost("suspend"), { path: DETAIL, status: 503, body: { error: "down" } }]);
    renderPage(<Probe act="suspend" />);
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    expect(await screen.findByText(OUTCOMES.transitionUnknown("Ada Lovelace", "suspended"))).toBeInTheDocument();
  });

  it("throws, so the dialog stays open, when the read shows it did not land", async () => {
    stubFetch([lost("suspend"), { path: DETAIL, body: { ...memberFixture(), status: "Active" } }]);
    renderPage(<Probe act="suspend" />);
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    await waitFor(() => expect(screen.getByText(/^threw:/)).toBeInTheDocument());
  });
});
