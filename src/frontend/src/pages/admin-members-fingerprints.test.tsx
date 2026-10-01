import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import AdminMembersPage from "./AdminMembers";
import { memberFixture, renderPage, stubFetch } from "../test/harness";
import { ROW_ACTIONS } from "../lib/membersCopy";

/**
 * P13 §9 — the members list and court-box fingerprints, both ways of ONE switch
 * (`FEATURES.fingerprintEnrolment`). Off — the shipped value, because the box does not read
 * fingerprints yet — the row's ⋯ offers no enrolment and the list asks the club nothing about
 * enrolments. On, both come back: flipping the switch is the whole change.
 */
const flags = vi.hoisted(() => ({ fingerprintEnrolment: false }));
vi.mock("@/lib/features", () => ({ FEATURES: flags }));

afterEach(() => { vi.unstubAllGlobals(); flags.fingerprintEnrolment = false; });

const POINTER = { button: 0, ctrlKey: false, pointerType: "mouse" } as const;
const ENROLMENTS = "/api/v1/admin/biometric/enrollments";

function draw() {
  const stub = stubFetch([
    { path: "/api/v1/admin/members/", body: [memberFixture()] },
    { path: ENROLMENTS, body: [] },
  ]);
  renderPage(<AdminMembersPage />);
  return stub;
}

async function openMenu() {
  fireEvent.pointerDown(await screen.findByRole("button", { name: ROW_ACTIONS.more("Ada Lovelace") }), POINTER);
  await screen.findByRole("menu");
}

describe("the members list's fingerprints, switched off (P13 §9)", () => {
  it("offers no enrolment in the ⋯, and reads no enrolments", async () => {
    const stub = draw();
    await openMenu();
    expect(screen.queryByRole("menuitem", { name: ROW_ACTIONS.fingerprints(0) })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /fingerprint/i })).toBeNull();
    expect(stub.calls.some((c) => c.path.startsWith(ENROLMENTS))).toBe(false);
  });
});

describe("the members list's fingerprints, switched on", () => {
  it("offers the enrolment and reads the club's enrolments again", async () => {
    flags.fingerprintEnrolment = true;
    const stub = draw();
    await waitFor(() => expect(stub.calls.some((c) => c.path.startsWith(ENROLMENTS))).toBe(true));
    await openMenu();
    expect(screen.getByRole("menuitem", { name: ROW_ACTIONS.fingerprints(0) })).toBeInTheDocument();
  });
});
