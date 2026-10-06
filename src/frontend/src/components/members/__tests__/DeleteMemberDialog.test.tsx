import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { DeleteMemberDialog } from "../DeleteMemberDialog";
import { refuse, renderPage, stubFetch } from "@/test/harness";
import { memberDeletePreview, memberDeleteResult } from "@/test/adminResponseFixtures";
import { DELETE_MEMBER_COPY as COPY, DELETE_MEMBER_REFUSALS } from "@/lib/deleteMemberCopy";

/**
 * Deleting a member (2026-10-06): the dialog says what the delete will do, read from the club, and
 * runs only once the name is typed, a reason given and — when a balance is left — the write-off
 * ticked. A balance that moved meanwhile comes back with its new figure, and the dialog stays open.
 */
const USER = "5c2b9e14-83d7-4f0a-b6e1-2a9c7d3f8e05";
const PREVIEW = `/api/v1/admin/members/${USER}/delete-preview`;
const DELETE = `/api/v1/admin/members/${USER}`;

function draw(onDeleted = vi.fn()) {
  renderPage(<DeleteMemberDialog userId={USER} name="Thandi Mokoena" open onOpenChange={() => {}} onDeleted={onDeleted} />);
  return onDeleted;
}

function fill() {
  fireEvent.change(screen.getByLabelText(COPY.typeName("Thandi Mokoena")), { target: { value: "thandi mokoena" } });
  fireEvent.change(screen.getByLabelText(COPY.reasonLabel), { target: { value: "Moved away" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("DeleteMemberDialog", () => {
  it("says what the delete does and runs only once the name, a reason and the write-off are given", async () => {
    const stub = stubFetch([
      { path: PREVIEW, body: memberDeletePreview() },
      { method: "DELETE", path: DELETE, body: memberDeleteResult() },
    ]);
    const onDeleted = draw();

    expect(await screen.findByText(COPY.erase)).toBeInTheDocument();
    expect(screen.getByText(COPY.bookings(1))).toBeInTheDocument();
    expect(screen.getByText(COPY.told)).toBeInTheDocument();
    expect(screen.getByText(COPY.writeOff(75))).toBeInTheDocument();

    const confirm = screen.getByRole("button", { name: COPY.confirm });
    fireEvent.click(confirm);
    expect(await screen.findByText(COPY.notReadyName("Thandi Mokoena"))).toBeInTheDocument();

    fill();
    fireEvent.click(confirm);
    expect(await screen.findByText(COPY.notReadyWriteOff)).toBeInTheDocument();
    expect(stub.calls.some((c) => c.method === "DELETE")).toBe(false);

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(confirm);

    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    const sent = stub.calls.find((c) => c.method === "DELETE");
    expect(sent?.body).toEqual({ reason: "Moved away", confirmBalanceWriteOff: true });
    expect(await screen.findByText(COPY.deleted("Thandi Mokoena"))).toBeInTheDocument();
  });

  it("keeps the dialog open with the new figure when the balance moved meanwhile", async () => {
    stubFetch([
      { path: PREVIEW, body: memberDeletePreview({ write_off_minutes: 0, future_bookings: 0 }) },
      { method: "DELETE", path: DELETE, respond: () => refuse(409, { error: "balance_write_off_required", balance_minutes: 30 }) },
    ]);
    const onDeleted = draw();

    expect(await screen.findByText(COPY.erase)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();
    fill();
    fireEvent.click(screen.getByRole("button", { name: COPY.confirm }));

    expect(await screen.findByText(DELETE_MEMBER_REFUSALS.balance_write_off_required)).toBeInTheDocument();
    expect(screen.getByText(COPY.writeOff(30))).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(onDeleted).not.toHaveBeenCalled();
  });
});
