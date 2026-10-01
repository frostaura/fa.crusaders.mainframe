import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { signOut } from "@/test/harness";
import { ACCESS_COPY, OVERVIEW_COPY } from "@/lib/memberDetailCopy";
import { MEMBER_ID, baseRoutes, detailFixture, renderMember, serve } from "./memberKit";

/**
 * P13 §9 — court-box fingerprint enrolment behind ONE switch, `FEATURES.fingerprintEnrolment`.
 * Off by default (the box does not read fingerprints yet, Dean 2026-10-01): MemberTabs.test pins
 * that nothing is drawn. Here the switch is flipped ON, to pin that turning it back on is the
 * whole change — the section, the enrolment, the removal and the Overview fact all come back.
 */
const flags = vi.hoisted(() => ({ fingerprintEnrolment: true }));
vi.mock("@/lib/features", () => ({ FEATURES: flags }));

const at = (path: string) => `/admin/members/${MEMBER_ID}/${path}`;

describe("member detail — court-box fingerprints, with enrolment switched on", () => {
  beforeEach(() => { signOut(); flags.fingerprintEnrolment = true; });

  it("removes a fingerprint only after a confirm that says what it does", async () => {
    const stub = serve(baseRoutes(detailFixture(), [
      { method: "DELETE", path: "/api/v1/admin/biometric/templates/t1", status: 204, body: null },
    ]));
    renderMember(at("access"));
    fireEvent.click(await screen.findByRole("button", { name: ACCESS_COPY.remove("Right index") }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(ACCESS_COPY.removeBody)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: ACCESS_COPY.removeConfirm }));
    await waitFor(() => expect(stub.calls.some((c) => c.method === "DELETE" && c.path.endsWith("/templates/t1"))).toBe(true));
  });

  it("asks for consent before a capture, and enrols the first finger not yet held", async () => {
    const stub = serve(baseRoutes(detailFixture(), [
      { method: "POST", path: "/api/v1/admin/biometric/enroll", body: { template_id: "t2" } },
    ]));
    renderMember(at("access"));
    fireEvent.click(await screen.findByRole("button", { name: ACCESS_COPY.enrol }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(ACCESS_COPY.consent)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: ACCESS_COPY.capture })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: ACCESS_COPY.consentGiven }));
    fireEvent.click(within(dialog).getByRole("button", { name: ACCESS_COPY.capture }));
    await waitFor(() => expect(stub.calls.some((c) => c.path === "/api/v1/admin/biometric/enroll")).toBe(true));
    expect(stub.calls.find((c) => c.path === "/api/v1/admin/biometric/enroll")?.body)
      .toMatchObject({ userId: MEMBER_ID, fingerLabel: "right-middle", consentReceiptHash: "v1" });
  });

  it("counts the fingers enrolled on the Overview — and says nothing of them with the switch off", async () => {
    serve(baseRoutes(detailFixture()));
    const { unmount } = renderMember();
    expect(await screen.findByText(OVERVIEW_COPY.fingerprints, { selector: "dt" })).toBeInTheDocument();
    expect(screen.getByText("1 finger enrolled")).toBeInTheDocument();
    unmount();

    flags.fingerprintEnrolment = false;
    serve(baseRoutes(detailFixture()));
    renderMember();
    await screen.findByTestId("member-balance");
    expect(screen.queryByText(OVERVIEW_COPY.fingerprints, { selector: "dt" })).toBeNull();
  });
});
