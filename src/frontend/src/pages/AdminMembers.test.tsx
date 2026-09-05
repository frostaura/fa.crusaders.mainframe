import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import AdminMembersPage from "./AdminMembers";
import { ledgerRowFixture, memberFixture, renderPage, stubFetch, type StubRoute } from "../test/harness";

/**
 * The members screen — the credit-adjustment form specifically.
 *
 * <p>
 * An admin adjustment can name the booking it compensates for (`relatedBookingId` on
 * `AdjustRequest`). That is not decoration: the no-show reversal reads this booking's
 * ledger and nets what it finds, so a positive adjustment already sitting there is
 * counted rather than paid a second time. These tests hold the wire shape both ways —
 * the id goes when picked, and no key goes when it is not — and the shape of the id,
 * because the endpoint binds a Guid? and answers a bare 400 for anything else.
 * </p>
 *
 * <p>
 * They also hold the <em>copy</em>, which is the part that went wrong twice (review
 * finding 17, then its own fix). The field first read as though a credit were the repair
 * for a wrongly-recorded no-show; the repair for that then read as though a credit on
 * top left the member "holding both". Both are wrong under settlement-model I3: the
 * reversal always runs, and the hand adjustment is netted into it one leg at a time —
 * a positive one reduces the penalty the reversal gives back, a negative one reduces the
 * refund it takes away. A wrong steer here costs real money on every league night, so
 * the copy is pinned like any other contract.
 * </p>
 *
 * <p>
 * And they hold the two refusals the endpoint answers when the named booking is not
 * this member's to name (I4): they are different mistakes with different repairs, they
 * are shown at the field rather than as a toast, and the form stays open on both.
 * </p>
 */
describe("AdminMembers — adjust credit", () => {
  afterEach(() => vi.unstubAllGlobals());

  const USER = "44444444-4444-4444-4444-444444444444";
  const BOOKING = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

  const routes = () => [
    { path: "/api/v1/admin/members/", body: [memberFixture()] },
    { path: "/api/v1/admin/biometric/enrollments", body: [] },
    {
      path: "/api/v1/admin/ledger/",
      // Three rows, two bookings' worth: the penalty and the charge are the same booking,
      // and a top-up is not a booking at all. One option, then.
      body: [
        ledgerRowFixture({ id: "1", type: "NoShowPenalty", amountCredits: 7.2, signedAmountCredits: -7.2, relatedBookingId: BOOKING, at: "2026-09-02T18:00:00Z" }),
        ledgerRowFixture({ id: "2", type: "BookingCharge", amountCredits: 24, signedAmountCredits: -24, relatedBookingId: BOOKING, at: "2026-09-01T10:00:00Z" }),
        ledgerRowFixture({ id: "3", type: "TopUp", amountCredits: 160, signedAmountCredits: 160, relatedBookingId: null }),
      ],
    },
    { method: "POST", path: `/api/v1/admin/credit/${USER}/adjust`, body: { entry_id: "9", amount_credits: 24, balance_after_credits: 144 } },
  ];

  async function openAdjustAndFill(amount: string, reason: string) {
    fireEvent.click(await screen.findByRole("button", { name: "Adjust credit" }));
    fireEvent.change(await screen.findByLabelText(/Amount \(credits/), { target: { value: amount } });
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: reason } });
  }

  it("offers the member's recent bookings from the ledger and sends the picked one as relatedBookingId", async () => {
    const stub = stubFetch(routes());
    renderPage(<AdminMembersPage />);

    await openAdjustAndFill("24", "Box was offline; no-show was wrong");

    // No admin endpoint lists a member's bookings; the ledger filtered to them is the
    // list of bookings money has moved on, which is what an adjustment could be for.
    const option = await screen.findByRole("option", { name: /No-show penalty 7\.20 cr · aaaaaaaa/ });
    expect(option).toHaveValue(BOOKING);
    // One option per booking — the charge row for the same booking does not repeat it.
    expect(screen.queryByRole("option", { name: /Booking charge/ })).not.toBeInTheDocument();
    const ledgerCall = stub.calls.find((c) => c.path.startsWith("/api/v1/admin/ledger/"));
    expect(ledgerCall?.path).toContain(`userId=${USER}`);

    fireEvent.change(screen.getByLabelText("For booking (optional)"), { target: { value: BOOKING } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => {
      const post = stub.calls.find((c) => c.method === "POST");
      expect(post?.path).toBe(`/api/v1/admin/credit/${USER}/adjust`);
      // objectContaining, plus the key checked by name: every adjustment now also carries
      // an idempotencyKey naming the movement, so a retry cannot become a second one.
      expect(post?.body).toEqual(expect.objectContaining({ amountCredits: 24, reason: "Box was offline; no-show was wrong", relatedBookingId: BOOKING }));
      expect(typeof (post?.body as Record<string, unknown>).idempotencyKey).toBe("string");
    });
    // The row's balance follows the API's answer, and the toast names the booking.
    expect(await screen.findByText(/Credited Ada Lovelace 24\.00 cr for booking aaaaaaaa/)).toBeInTheDocument();
    expect(screen.getByText("144.00 cr")).toBeInTheDocument();
  });

  it("sends no relatedBookingId key at all when the adjustment is not for a booking", async () => {
    const stub = stubFetch(routes());
    renderPage(<AdminMembersPage />);

    await openAdjustAndFill("-10", "Bar tab");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => {
      const post = stub.calls.find((c) => c.method === "POST");
      expect(post?.body).toEqual(expect.objectContaining({ amountCredits: -10, reason: "Bar tab" }));
      // Absent, not null: plain money, invisible to the no-show reversal by design.
      expect(post?.raw).not.toContain("relatedBookingId");
    });
  });

  it("says the adjustment is netted per leg against the reversal, not that it replaces it", async () => {
    stubFetch(routes());
    renderPage(<AdminMembersPage />);

    await openAdjustAndFill("24", "Goodwill");
    await screen.findByRole("option", { name: /No-show penalty/ });

    // What the field is for, and what it is not for.
    expect(screen.getByText(/genuinely compensates this member/)).toBeInTheDocument();
    expect(screen.getByText(/does not stand in for/)).toBeInTheDocument();
    expect(screen.getByText(/reversed on their own/)).toBeInTheDocument();

    // I3, both directions and the cap. The direction is not a detail: the reversal has
    // exactly one leg that gives money back and one that takes it, and the desk needs to
    // know which of the two their sign lands on before they post it.
    expect(screen.getByText(/netted against that reversal one leg at a time/)).toBeInTheDocument();
    expect(screen.getByText(/positive adjustment reduces the penalty the reversal gives back/)).toBeInTheDocument();
    expect(screen.getByText(/negative one reduces the refund it takes away/)).toBeInTheDocument();
    expect(screen.getByText(/Netting stops at zero per leg/)).toBeInTheDocument();

    // The two claims this copy has already been wrong with, in order.
    expect(screen.queryByText(/makes up for a wrongly-recorded no-show/)).not.toBeInTheDocument();
    expect(screen.queryByText(/leaves them holding both/)).not.toBeInTheDocument();
  });

  /** The same screen, with the adjust POST refused for the named reason. */
  const refusedRoutes = (error: string) => [
    ...routes().filter((r) => r.method !== "POST"),
    { method: "POST", path: `/api/v1/admin/credit/${USER}/adjust`, status: 400, body: { error } },
  ];

  async function applyForBooking() {
    await openAdjustAndFill("24", "Compensation");
    fireEvent.change(await screen.findByLabelText("For booking (optional)"), { target: { value: BOOKING } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  }

  it("shows booking_not_found at the field, keeping the form and the typed values", async () => {
    const stub = stubFetch(refusedRoutes("booking_not_found"));
    renderPage(<AdminMembersPage />);
    await applyForBooking();

    // At the field, not as a toast: the booking is the one input the admin has to change,
    // and the message names what to do instead of saying the adjustment failed.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/No booking with that ID exists at this club/);
    expect(alert).toHaveTextContent(/pick one from the list/);
    expect(screen.queryByText("Credit adjustment failed.")).not.toBeInTheDocument();

    // Form still open, amount and reason intact — nothing to re-type, and no second POST.
    expect(screen.getByLabelText(/Amount \(credits/)).toHaveValue("24");
    expect(stub.calls.filter((c) => c.method === "POST")).toHaveLength(1);

    // Choosing a different booking clears the verdict; it was about the old one.
    fireEvent.change(screen.getByLabelText("For booking (optional)"), { target: { value: "" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows booking_not_members as the different mistake it is", async () => {
    stubFetch(refusedRoutes("booking_not_members"));
    renderPage(<AdminMembersPage />);
    await applyForBooking();

    // The dangerous one (I4): a real booking, the wrong member. Before the server checked
    // this, it silently netted against a third party's settlement with nothing on their
    // ledger to explain it — so the message says whose money it would have moved.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/belongs to another member/);
    expect(alert).toHaveTextContent(/change what they are owed/);
    expect(alert).not.toHaveTextContent(/does not exist/);
  });

  it("says whose booking a typed ID has to be, because the server refuses another member's", async () => {
    stubFetch(routes());
    renderPage(<AdminMembersPage />);

    await openAdjustAndFill("24", "Goodwill");
    await screen.findByRole("option", { name: /No-show penalty/ });

    // The picker only ever offers this member's bookings; the free-text escape hatch is
    // the only way to name somebody else's, and naming somebody else's suppresses THEIR
    // reversal. The option itself says whose it must be.
    expect(screen.getByRole("option", { name: /Another booking of this member's/ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("For booking (optional)"), { target: { value: "other" } });
    expect(screen.getByText(/The server refuses another member's/)).toBeInTheDocument();
  });

  it("takes a booking ID the ledger has not seen, and refuses one that is not a GUID", async () => {
    const stub = stubFetch(routes());
    renderPage(<AdminMembersPage />);

    await openAdjustAndFill("24", "Compensation");
    await screen.findByRole("option", { name: /No-show penalty/ });
    fireEvent.change(screen.getByLabelText("For booking (optional)"), { target: { value: "other" } });

    // The API binds it as a Guid? and answers a bare 400 otherwise; the check is here,
    // where the admin can fix it.
    fireEvent.change(screen.getByLabelText("Booking ID"), { target: { value: "last tuesday" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText(/That booking ID is not one/)).toBeInTheDocument();
    expect(stub.calls.some((c) => c.method === "POST")).toBe(false);

    const other = "12345678-1234-4123-8123-123456789abc";
    fireEvent.change(screen.getByLabelText("Booking ID"), { target: { value: other } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => {
      expect(stub.calls.find((c) => c.method === "POST")?.body).toEqual(expect.objectContaining({ amountCredits: 24, reason: "Compensation", relatedBookingId: other }));
    });
  });
});

/**
 * The double-click on Apply.
 *
 * <p>
 * A normal impatient double-click posted the adjustment twice: two identical
 * <code>AdminAdjustment</code> rows, a member moved 444 → 458 where 7 credits were typed,
 * and on a slow connection four clicks granted 44 credits where 11 were typed. Money is
 * ledger-only, so a duplicated row <b>is</b> the wrong balance and nothing on the ledger
 * says which of two identical rows was the mistake.
 * </p>
 *
 * <p>
 * The screen's half of the fix is two guards. A synchronous ref stops the second click
 * (a <code>disabled</code> driven by React state is read by the second click before the
 * re-render commits), and an idempotency key naming this one movement is what the server
 * uses to answer a retry with the row it already wrote. The key is the load-bearing half,
 * pinned in <code>AdminCreditAdjustHttpTests</code> against real Postgres; this file holds
 * that the screen actually sends one, and sends the same one on a retry.
 * </p>
 */
describe("AdminMembers — an adjustment is not posted twice", () => {
  afterEach(() => vi.unstubAllGlobals());

  const USER = "44444444-4444-4444-4444-444444444444";
  const ADJUST = `/api/v1/admin/credit/${USER}/adjust`;

  const routes = (adjust: Partial<StubRoute> = {}): StubRoute[] => [
    { path: "/api/v1/admin/members/", body: [memberFixture()] },
    { path: "/api/v1/admin/biometric/enrollments", body: [] },
    { path: "/api/v1/admin/ledger/", body: [] },
    {
      method: "POST", path: ADJUST,
      body: { entry_id: "9", amount_credits: 7, balance_after_credits: 127 },
      ...adjust,
    },
  ];

  async function fill(amount: string, reason: string) {
    fireEvent.click(await screen.findByRole("button", { name: "Adjust credit" }));
    fireEvent.change(await screen.findByLabelText(/Amount \(credits/), { target: { value: amount } });
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: reason } });
  }

  it("posts once for a double-click, and names the movement so a retry cannot duplicate it", async () => {
    const stub = stubFetch(routes());
    renderPage(<AdminMembersPage />);

    await fill("7", "fast dblclick probe");
    const apply = screen.getByRole("button", { name: "Apply" });
    fireEvent.click(apply);
    fireEvent.click(apply);

    await waitFor(() => expect(screen.getByText(/Credited Ada Lovelace 7\.00 cr/)).toBeInTheDocument());

    const posts = stub.calls.filter((c) => c.method === "POST" && c.path === ADJUST);
    expect(posts).toHaveLength(1);
    // And the one that went carries a key, so a retry the screen cannot see — a browser
    // replay, a second tab — is still one movement on the ledger.
    const body = posts[0].body as Record<string, unknown>;
    expect(typeof body.idempotencyKey).toBe("string");
    expect((body.idempotencyKey as string).length).toBeGreaterThan(8);
  });

  it("retries a failed adjustment under the SAME key, so the retry cannot become a second movement", async () => {
    // The dangerous shape: the request reached the server and the answer did not come
    // back. The desk sees a failure, presses Apply again, and without a stable key that
    // second press is a second movement on a ledger that already has the first.
    const stub = stubFetch(routes({ status: 500, body: { error: "boom" } }));
    renderPage(<AdminMembersPage />);

    await fill("7", "coaching credit");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText("Credit adjustment failed.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(stub.calls.filter((c) => c.method === "POST").length).toBe(2));

    const [first, second] = stub.calls.filter((c) => c.method === "POST");
    const key = (b: unknown) => (b as Record<string, unknown>).idempotencyKey;
    expect(key(first.body)).toBe(key(second.body));
    expect(typeof key(first.body)).toBe("string");
  });

  it("gives a second, deliberate adjustment its own key", async () => {
    const stub = stubFetch(routes());
    renderPage(<AdminMembersPage />);

    await fill("7", "coaching credit");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(screen.getByText(/Credited Ada Lovelace 7\.00 cr/)).toBeInTheDocument());

    // Reopened form, same member, same amount, same reason — and a different movement. A
    // guard keyed on the member or the amount would refuse this, which is the same bug
    // pointing the other way: money that should have moved and did not.
    await fill("7", "coaching credit");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(stub.calls.filter((c) => c.method === "POST").length).toBe(2));

    const [first, second] = stub.calls.filter((c) => c.method === "POST");
    expect((first.body as Record<string, unknown>).idempotencyKey)
      .not.toBe((second.body as Record<string, unknown>).idempotencyKey);
  });
});

/**
 * The member's class, on the screen the admin is already looking at.
 *
 * <p>
 * <code>POST /admin/members/{id}/class</code> existed, a typed client for it existed, and
 * nothing called either — one grep hit, the definition, zero call sites. So every member
 * onboarded through the product was permanently <code>Regular</code> while the class
 * decides what R100 buys (160 credits or 240) and whether they may take a peak slot.
 * </p>
 */
describe("AdminMembers — member class", () => {
  afterEach(() => vi.unstubAllGlobals());

  const MEMBERSHIP = "33333333-3333-3333-3333-333333333333";
  const CLASS_PATH = `/api/v1/admin/members/${MEMBERSHIP}/class`;

  const routes = (member: Record<string, unknown> = {}, classRoute: Partial<StubRoute> = {}): StubRoute[] => [
    { path: "/api/v1/admin/members/", body: [memberFixture(member)] },
    { path: "/api/v1/admin/biometric/enrollments", body: [] },
    { path: "/api/v1/admin/ledger/", body: [] },
    { method: "POST", path: CLASS_PATH, body: { member_class: "LeagueOrSenior", changed: true }, ...classRoute },
  ];

  it("shows the class the API returned and sends a change", async () => {
    const stub = stubFetch(routes({ member_class: "LeagueOrSenior" }));
    renderPage(<AdminMembersPage />);

    const select = await screen.findByLabelText("Member class for Ada Lovelace");
    expect(select).toHaveValue("LeagueOrSenior");

    fireEvent.change(select, { target: { value: "Regular" } });
    await waitFor(() => {
      const post = stub.calls.find((c) => c.path === CLASS_PATH);
      expect(post?.body).toEqual({ memberClass: "Regular" });
    });
    expect(await screen.findByText(/Ada Lovelace is now regular\./)).toBeInTheDocument();
  });

  it("puts the old class back when the server refuses, rather than showing a rate that is not real", async () => {
    stubFetch(routes({}, { status: 400, body: { error: "invalid_member_class" } }));
    renderPage(<AdminMembersPage />);

    const select = await screen.findByLabelText("Member class for Ada Lovelace");
    fireEvent.change(select, { target: { value: "LeagueOrSenior" } });

    expect(await screen.findByText(/Couldn't change Ada Lovelace's class\./)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Member class for Ada Lovelace")).toHaveValue("Regular"));
  });
});

/**
 * Suspension, and the verification state that decides whether a member can sign in at all.
 *
 * <p>
 * The Status filter offered <b>Suspended</b> and no member could ever be in it: the enum
 * value was the only thing that existed. And an approved, active member who never clicked
 * their verification link is refused at sign-in with "your account isn't approved yet" —
 * a sentence that is not true and points at nothing they or the admin can act on. The
 * console now shows the state and offers the one action that fixes it.
 * </p>
 */
describe("AdminMembers — suspend, reactivate and verification", () => {
  afterEach(() => vi.unstubAllGlobals());

  const MEMBERSHIP = "33333333-3333-3333-3333-333333333333";

  const routes = (member: Record<string, unknown> = {}, extra: StubRoute[] = []): StubRoute[] => [
    { path: "/api/v1/admin/members/", body: [memberFixture(member)] },
    { path: "/api/v1/admin/biometric/enrollments", body: [] },
    { path: "/api/v1/admin/ledger/", body: [] },
    ...extra,
  ];

  it("suspends with a reason, and says the member's money and bookings are untouched", async () => {
    const stub = stubFetch(routes({}, [
      { method: "POST", path: `/api/v1/admin/members/${MEMBERSHIP}/suspend`, body: { suspended: true } },
    ]));
    renderPage(<AdminMembersPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Suspend member" }));

    // The reason is not optional: the member is emailed it, and "you are suspended" with
    // no reason is the worst version of this message a club can send.
    const confirm = screen.getByRole("button", { name: "Suspend" });
    expect(confirm).toBeDisabled();
    expect(screen.getByText(/credit balance/)).toBeInTheDocument();
    expect(screen.getByText(/reactivating restores/)).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/Membership dues unpaid/), { target: { value: "Dues unpaid since March." } });
    fireEvent.click(screen.getByRole("button", { name: "Suspend" }));

    await waitFor(() => {
      const post = stub.calls.find((c) => c.path.endsWith("/suspend"));
      expect(post?.body).toEqual({ reason: "Dues unpaid since March." });
    });
  });

  it("offers reactivate — and only reactivate-shaped actions — on a suspended member", async () => {
    const stub = stubFetch(routes({ status: "Suspended" }, [
      { method: "POST", path: `/api/v1/admin/members/${MEMBERSHIP}/reactivate`, body: { reactivated: true } },
    ]));
    renderPage(<AdminMembersPage />);

    expect(await screen.findByRole("button", { name: "Reactivate member" })).toBeInTheDocument();
    // A suspended member is not bookable, so offering to adjust their credit or enrol a
    // finger would be offering an action the box will refuse.
    expect(screen.queryByRole("button", { name: "Adjust credit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Suspend member" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reactivate member" }));
    await waitFor(() => expect(stub.calls.some((c) => c.path.endsWith("/reactivate"))).toBe(true));
  });

  it("marks an unverified member and resends the verification email on request", async () => {
    const stub = stubFetch(routes({ email_verified: false }, [
      { method: "POST", path: "/api/v1/auth/resend-verification", body: { ok: true } },
    ]));
    renderPage(<AdminMembersPage />);

    // The badge is the answer to "the app won't let me in" from a member whose row says
    // Active — which is exactly the case that used to have no answer on this screen.
    expect(await screen.findByText("Unverified")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Resend verification email" }));
    await waitFor(() => {
      const post = stub.calls.find((c) => c.path === "/api/v1/auth/resend-verification");
      expect(post?.body).toEqual({ email: "ada@example.com" });
    });
    expect(await screen.findByText(/Verification email sent to ada@example\.com/)).toBeInTheDocument();
  });

  it("says nothing about verification for a member who has verified", async () => {
    stubFetch(routes());
    renderPage(<AdminMembersPage />);

    await screen.findByText("Ada Lovelace");
    expect(screen.queryByText("Unverified")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resend verification email" })).not.toBeInTheDocument();
  });
});
