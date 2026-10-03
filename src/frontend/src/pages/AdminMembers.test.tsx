import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import AdminMembersPage from "./AdminMembers";
import { ASSIGN_COPY } from "../lib/groupsCopy";
import { ledgerRowFixture, memberFixture, refuse, renderPage, stubFetch, type StubRoute } from "../test/harness";
import { ADJUST_SHEET, LIVE_SAID, LOST_REPLY, TAKE_BACK_LINK } from "../lib/deskMinutesCopy";
import { CONFIRM_NOT_READY, REQUIRED_MARK } from "../lib/confirmDialogCopy";
import {
  OUTCOMES, PASSWORD_DIALOG, RELATED_BOOKING, REJECT_DIALOG, RESET_DIALOG, ROW_ACTIONS, SUSPEND_DIALOG, UNVERIFIED,
} from "../lib/membersCopy";

/**
 * <b>This file's cases need longer than the 5-second default, and the reason is the fix.</b>
 * An adjustment moves through three steps (D3-B08), each a render of a table that already holds every
 * row in the club; in jsdom that is seconds. Raised here, not globally, so the cost is this file's.
 */
vi.setConfig({ testTimeout: 20_000 });

/** A Radix trigger opens on pointerdown, the way a pointer opens it; options exist only while open. */
const POINTER = { button: 0, ctrlKey: false, pointerType: "mouse" } as const;

/** Open a row's ⋯ menu and pick one of its items. (P5: row actions = Sell package + ⋯.) */
async function fromMenu(item: string, member = "Ada Lovelace") {
  fireEvent.pointerDown(await screen.findByRole("button", { name: ROW_ACTIONS.more(member) }), POINTER);
  fireEvent.click(await screen.findByRole("menuitem", { name: item }));
}

async function choose(label: string, option: string | RegExp) {
  fireEvent.pointerDown(await screen.findByRole("combobox", { name: label }), POINTER);
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

/**
 * What the admin is told they have just done to a member.
 *
 * <p>
 * The temporary password used to be described as something "the member should change after
 * signing in" — the advisory wording from before the forced-change gate existed. It is now the
 * only thing that session can reach, and an admin who reads the weaker sentence cannot tell from
 * this screen that the member is locked out of everything else until they replace it.
 * </p>
 */
describe("AdminMembers — the temporary password an admin issues", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("says the temporary password unlocks one screen and nothing else", async () => {
    stubFetch([
      { path: "/api/v1/admin/members/", body: [memberFixture()] },
      { path: "/api/v1/admin/biometric/enrollments", body: [] },
      {
        method: "POST", path: "/api/v1/admin/members/33333333-3333-3333-3333-333333333333/reset-password",
        body: { temp_password: "Xk7-tempo-92", email_sent_to: "ada@example.com", member_notified: true },
      },
    ]);
    renderPage(<AdminMembersPage />);

    await fromMenu(ROW_ACTIONS.reset);
    const confirm = await screen.findByRole("dialog", { name: RESET_DIALOG.title("Ada Lovelace") });
    fireEvent.click(within(confirm).getByRole("button", { name: RESET_DIALOG.confirm }));

    const dialog = await screen.findByRole("dialog", { name: PASSWORD_DIALOG.title });
    expect(dialog).toHaveTextContent("Xk7-tempo-92");
    expect(dialog).toHaveTextContent(/only unlocks the change-password screen/i);
    expect(dialog).toHaveTextContent(/must choose a new password before they can do anything else/i);
    expect(dialog).not.toHaveTextContent(/should change it after signing in/i);
  });
});

/**
 * The Adjust minutes sheet (P13 §3.7) — the booking an adjustment names, and the copy that explains why.
 *
 * <p>
 * An admin adjustment can name the booking it compensates for (`relatedBookingId`). The no-show
 * reversal reads that booking's ledger and nets what it finds, so these hold the wire shape both
 * ways — the id goes when picked, and no key goes when it is not — and the shape of the id, because
 * the endpoint binds a Guid? and answers a bare 400 for anything else. They also hold the COPY,
 * which went wrong twice (review finding 17, then its own fix): under settlement-model I3 the
 * reversal always runs and the hand adjustment is netted into it one leg at a time.
 * </p>
 */
describe("AdminMembers — adjust minutes", () => {
  afterEach(() => vi.unstubAllGlobals());

  const USER = "44444444-4444-4444-4444-444444444444";
  const BOOKING = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

  const routes = () => [
    { path: "/api/v1/admin/members/", body: [memberFixture()] },
    { path: "/api/v1/admin/biometric/enrollments", body: [] },
    {
      path: "/api/v1/admin/ledger/",
      // Three rows, two bookings' worth: the penalty and the charge are the same booking, and a
      // top-up is not a booking at all. One option, then.
      body: [
        ledgerRowFixture({ id: "1", type: "NoShowPenalty", amountMinutes: 7, signedAmountMinutes: -7, relatedBookingId: BOOKING, at: "2026-09-02T18:00:00Z" }),
        ledgerRowFixture({ id: "2", type: "BookingCharge", amountMinutes: 24, signedAmountMinutes: -24, relatedBookingId: BOOKING, at: "2026-09-01T10:00:00Z" }),
        ledgerRowFixture({ id: "3", type: "TopUp", amountMinutes: 160, signedAmountMinutes: 160, relatedBookingId: null }),
      ],
    },
    { method: "POST", path: `/api/v1/admin/minutes/${USER}/adjust`, body: { entry_id: "9", amount_minutes: 24, balance_after_minutes: 144 } },
  ];

  /**
   * Drive the sheet to the reason step and fill it. <b>There is no sign anywhere in this flow</b>:
   * taking minutes back is its own path, reached by name, because a sign is a character somebody
   * types and not a decision they make.
   */
  async function openAdjustAndFill(amount: string, reason: string, opts: { takeBack?: boolean } = {}) {
    await fromMenu(ROW_ACTIONS.adjust);
    if (opts.takeBack) fireEvent.click(await screen.findByRole("button", { name: TAKE_BACK_LINK }));
    fireEvent.change(await screen.findByLabelText(ADJUST_SHEET.amountLabel), { target: { value: amount } });
    fireEvent.click(screen.getByRole("button", { name: ADJUST_SHEET.next }));
    await choose(ADJUST_SHEET.reasonLabel, opts.takeBack ? "Correcting a mistake" : "Goodwill — something went wrong");
    fireEvent.change(screen.getByLabelText(ADJUST_SHEET.detailLabel), { target: { value: reason } });
  }

  /** Step 2 → step 3. */
  async function toCheck() {
    fireEvent.click(await screen.findByRole("button", { name: ADJUST_SHEET.next }));
  }

  /** The confirm: arm it, then fire it. There is no bare "Apply". */
  async function apply() {
    fireEvent.click(await screen.findByRole("button", { name: /^(Add|Take back) / }));
    fireEvent.click(await screen.findByRole("button", { name: /choose again to confirm/ }));
  }

  it("offers the member's recent bookings from the ledger and sends the picked one as relatedBookingId", async () => {
    const stub = stubFetch(routes());
    renderPage(<AdminMembersPage />);

    await openAdjustAndFill("24", "Box was offline; no-show was wrong");
    await waitFor(() => expect(stub.calls.some((c) => c.path.startsWith("/api/v1/admin/ledger/"))).toBe(true));
    // No admin endpoint lists a member's bookings; the ledger filtered to them is the list of
    // bookings money has moved on, which is what an adjustment could be for.
    const ledgerCall = stub.calls.find((c) => c.path.startsWith("/api/v1/admin/ledger/"));
    expect(ledgerCall?.path).toContain(`userId=${USER}`);

    fireEvent.pointerDown(screen.getByRole("combobox", { name: RELATED_BOOKING.label }), POINTER);
    // One option per booking — the charge row for the same booking does not repeat it.
    expect(await screen.findByRole("option", { name: /No-show penalty 7 minutes · aaaaaaaa/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Booking charge/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: /No-show penalty/ }));

    await toCheck();
    // The three figures, before the press. This is the whole of what D3-B08 was missing.
    expect(screen.getByText(ADJUST_SHEET.balanceAfter)).toBeInTheDocument();
    await apply();

    await waitFor(() => {
      const post = stub.calls.find((c) => c.method === "POST");
      expect(post?.path).toBe(`/api/v1/admin/minutes/${USER}/adjust`);
      expect(post?.body).toEqual(expect.objectContaining({
        amountMinutes: 24, reason: "Box was offline; no-show was wrong",
        relatedBookingId: BOOKING, reasonCode: "goodwill",
      }));
      expect(typeof (post?.body as Record<string, unknown>).idempotencyKey).toBe("string");
    });
    // The receipt STAYS on screen — money deserves more than four seconds — and the row's balance
    // follows the API's answer.
    expect(await screen.findByText("Done. Ada Lovelace now has 2 hours 24 minutes.")).toBeInTheDocument();
    expect(screen.getByText("2 hours 24 minutes")).toBeInTheDocument();
  });

  it("sends no relatedBookingId key at all when the adjustment is not for a booking", async () => {
    const stub = stubFetch(routes());
    renderPage(<AdminMembersPage />);

    // The amount is positive on BOTH paths — the direction carries the sign — so what goes on the
    // wire is still the negative number the server expects.
    await openAdjustAndFill("10", "Bar tab", { takeBack: true });
    await toCheck();
    await apply();

    await waitFor(() => {
      const post = stub.calls.find((c) => c.method === "POST");
      expect(post?.body).toEqual(expect.objectContaining({ amountMinutes: -10, reason: "Bar tab", reasonCode: "correction" }));
      // Absent, not null: plain money, invisible to the no-show reversal by design.
      expect(post?.raw).not.toContain("relatedBookingId");
    });
  });

  it("says the adjustment is netted per leg against the reversal, not that it replaces it", async () => {
    stubFetch(routes());
    renderPage(<AdminMembersPage />);

    await openAdjustAndFill("24", "Goodwill");
    // P5 moved the rule one tap away (floating guidance, not a paragraph under the field); it is
    // the same sentence, and it is still pinned whole.
    fireEvent.click(screen.getByRole("button", { name: `More about ${RELATED_BOOKING.moreLabel}` }));
    const guidance = await screen.findByRole("dialog", { name: RELATED_BOOKING.moreLabel });

    expect(guidance).toHaveTextContent(/genuinely compensates this member/);
    expect(guidance).toHaveTextContent(/does not stand in for/);
    expect(guidance).toHaveTextContent(/reversed on their own/);
    // I3, both directions and the cap.
    expect(guidance).toHaveTextContent(/netted against that reversal one leg at a time/);
    expect(guidance).toHaveTextContent(/positive adjustment reduces the penalty the reversal gives back/);
    expect(guidance).toHaveTextContent(/negative one reduces the refund it takes away/);
    expect(guidance).toHaveTextContent(/Netting stops at zero per leg/);
    // The two claims this copy has already been wrong with, in order.
    expect(screen.queryByText(/makes up for a wrongly-recorded no-show/)).not.toBeInTheDocument();
    expect(screen.queryByText(/leaves them holding both/)).not.toBeInTheDocument();
  });

  /** The same screen, with the adjust POST refused for the named reason. */
  const refusedRoutes = (error: string) => [
    ...routes().filter((r) => r.method !== "POST"),
    { method: "POST", path: `/api/v1/admin/minutes/${USER}/adjust`, status: 400, body: { error } },
  ];

  async function applyForBooking() {
    await openAdjustAndFill("24", "Compensation");
    await choose(RELATED_BOOKING.label, /No-show penalty/);
    await toCheck();
    await apply();
  }

  it("shows booking_not_found at the field, keeping the form and the typed values", async () => {
    const stub = stubFetch(refusedRoutes("booking_not_found"));
    renderPage(<AdminMembersPage />);
    await applyForBooking();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/No booking with that ID exists at this club/);
    expect(alert).toHaveTextContent(/pick one from the list/);
    expect(screen.queryByText(ADJUST_SHEET.failed)).not.toBeInTheDocument();

    // The sheet stays on the check step with the figures intact — nothing to re-type, no second POST.
    expect(screen.getByText(ADJUST_SHEET.balanceAfter)).toBeInTheDocument();
    expect(stub.calls.filter((c) => c.method === "POST")).toHaveLength(1);

    // Choosing a different booking clears the verdict; it was about the old one.
    fireEvent.click(screen.getByRole("button", { name: ADJUST_SHEET.back }));
    await choose(RELATED_BOOKING.label, RELATED_BOOKING.none);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows booking_not_members as the different mistake it is", async () => {
    stubFetch(refusedRoutes("booking_not_members"));
    renderPage(<AdminMembersPage />);
    await applyForBooking();

    // The dangerous one (I4): a real booking, the wrong member.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/belongs to another member/);
    expect(alert).toHaveTextContent(/change what they are owed/);
    expect(alert).not.toHaveTextContent(/does not exist/);
  });

  it("says whose booking a typed ID has to be, because the server refuses another member's", async () => {
    stubFetch(routes());
    renderPage(<AdminMembersPage />);

    await openAdjustAndFill("24", "Goodwill");
    await choose(RELATED_BOOKING.label, /Another booking of this member's/);
    expect(screen.getByText(/The server refuses another member's/)).toBeInTheDocument();
  });

  it("takes a booking ID the ledger has not seen, and refuses one that is not a GUID", async () => {
    const stub = stubFetch(routes());
    renderPage(<AdminMembersPage />);

    await openAdjustAndFill("24", "Compensation");
    await choose(RELATED_BOOKING.label, /Another booking of this member's/);
    fireEvent.change(screen.getByLabelText(RELATED_BOOKING.idLabel), { target: { value: "last tuesday" } });
    await toCheck();
    await apply();
    expect(await screen.findByText(/That booking ID is not one/)).toBeInTheDocument();
    expect(stub.calls.some((c) => c.method === "POST")).toBe(false);

    const other = "12345678-1234-4123-8123-123456789abc";
    // Back to step 2: P5 keeps the field showing what is about to be sent — the typed id, under
    // "Another booking" — so correcting a mistyped id is one edit, not a re-choice.
    fireEvent.click(screen.getByRole("button", { name: ADJUST_SHEET.back }));
    expect(await screen.findByLabelText(RELATED_BOOKING.idLabel)).toHaveValue("last tuesday");
    fireEvent.change(await screen.findByLabelText(RELATED_BOOKING.idLabel), { target: { value: other } });
    await toCheck();
    await apply();
    await waitFor(() => {
      expect(stub.calls.find((c) => c.method === "POST")?.body).toEqual(expect.objectContaining({ amountMinutes: 24, reason: "Compensation", relatedBookingId: other }));
    });
  });
});

/**
 * The double-click on Apply.
 *
 * <p>
 * A normal impatient double-click posted the adjustment twice: two identical rows, a member moved
 * 444 → 458 where 7 were typed, and on a slow connection four clicks granted 44 where 11 were
 * typed. A synchronous ref stops the second click; an idempotency key naming this
 * one movement is what the server uses to answer a retry with the row it already wrote.
 * </p>
 */
describe("AdminMembers — an adjustment is not posted twice", () => {
  afterEach(() => vi.unstubAllGlobals());

  const USER = "44444444-4444-4444-4444-444444444444";
  const ADJUST = `/api/v1/admin/minutes/${USER}/adjust`;

  const routes = (adjust: Partial<StubRoute> = {}): StubRoute[] => [
    { path: "/api/v1/admin/members/", body: [memberFixture()] },
    { path: "/api/v1/admin/biometric/enrollments", body: [] },
    { path: "/api/v1/admin/ledger/", body: [] },
    { method: "POST", path: ADJUST, body: { entry_id: "9", amount_minutes: 7, balance_after_minutes: 127 }, ...adjust },
  ];

  async function fill(amount: string, reason: string) {
    await fromMenu(ROW_ACTIONS.adjust);
    fireEvent.change(await screen.findByLabelText(ADJUST_SHEET.amountLabel), { target: { value: amount } });
    fireEvent.click(screen.getByRole("button", { name: ADJUST_SHEET.next }));
    await choose(ADJUST_SHEET.reasonLabel, "Goodwill — something went wrong");
    fireEvent.change(screen.getByLabelText(ADJUST_SHEET.detailLabel), { target: { value: reason } });
    fireEvent.click(screen.getByRole("button", { name: ADJUST_SHEET.next }));
  }

  /** Arm the confirm and return the FIRED control, so a case can press it twice. */
  async function armed() {
    fireEvent.click(await screen.findByRole("button", { name: /^(Add|Take back) / }));
    return screen.findByRole("button", { name: /choose again to confirm/ });
  }

  it("posts once for a double-click, and names the movement so a retry cannot duplicate it", async () => {
    const stub = stubFetch(routes());
    renderPage(<AdminMembersPage />);

    await fill("7", "fast dblclick probe");
    const fire = await armed();
    fireEvent.click(fire);
    fireEvent.click(fire);

    await waitFor(() => expect(screen.getByText("Done. Ada Lovelace now has 2 hours 7 minutes.")).toBeInTheDocument());
    const posts = stub.calls.filter((c) => c.method === "POST" && c.path === ADJUST);
    expect(posts).toHaveLength(1);
    const body = posts[0].body as Record<string, unknown>;
    expect(typeof body.idempotencyKey).toBe("string");
    expect((body.idempotencyKey as string).length).toBeGreaterThan(8);
  });

  it("retries a failed adjustment under the SAME key, so the retry cannot become a second movement", async () => {
    // The request reached the server and the answer did not come back.
    const stub = stubFetch(routes({ status: 500, body: { error: "boom" } }));
    renderPage(<AdminMembersPage />);

    await fill("7", "coaching session");
    fireEvent.click(await armed());
    // A 500 is NOT a refusal, so the ledger is asked; it shows nothing, and the toast says so.
    expect(await screen.findByText(LOST_REPLY.absent)).toBeInTheDocument();

    fireEvent.click(await armed());
    await waitFor(() => expect(stub.calls.filter((c) => c.method === "POST").length).toBe(2));
    const [first, second] = stub.calls.filter((c) => c.method === "POST");
    const key = (b: unknown) => (b as Record<string, unknown>).idempotencyKey;
    expect(key(first.body)).toBe(key(second.body));
    expect(typeof key(first.body)).toBe("string");
  });

  /**
   * Review round 2 (F3-2): the movement LANDED and the reply was lost. The sheet said "That didn't
   * go through", and an admin who then changed the amount re-sent it under the same key — a 409
   * the sheet also called "didn't go through". The stubs below perform the movement and then
   * fail the reply, exactly as the lost reply did.
   */
  describe("a reply lost after the movement landed", () => {
    const DETAIL = `/api/v1/admin/members/${USER}`;
    function landedThenLost(ledgerStatus = 200) {
      const ledger: Array<ReturnType<typeof ledgerRowFixture>> = [];
      return [
        { path: "/api/v1/admin/members/", body: [memberFixture()] },
        { path: "/api/v1/admin/biometric/enrollments", body: [] },
        { path: DETAIL, respond: () => ({ ...memberFixture(), balance_minutes: 120 + ledger.length * 7 }) },
        {
          path: "/api/v1/admin/ledger/", status: ledgerStatus,
          respond: () => (ledgerStatus === 200 ? ledger : { error: "server_error" }),
        },
        {
          method: "POST", path: ADJUST,
          respond: (req: { body: unknown }) => {
            const b = req.body as Record<string, unknown>;
            ledger.push(ledgerRowFixture({
              id: `row-${ledger.length}`, type: "AdminAdjustment", amountMinutes: b.amountMinutes,
              signedAmountMinutes: b.amountMinutes, comment: b.reason, subjectUserId: USER,
            }));
            return refuse(504, { error: "gateway_timeout" });
          },
        },
      ] as StubRoute[];
    }

    it("reads the ledger, finds the movement and shows the receipt — never 'didn't go through'", async () => {
      const stub = stubFetch(landedThenLost());
      renderPage(<AdminMembersPage />);

      await fill("7", "lost reply probe");
      fireEvent.click(await armed());

      expect(await screen.findByText("Done. Ada Lovelace now has 2 hours 7 minutes.")).toBeInTheDocument();
      expect(screen.getByText(LOST_REPLY.landed)).toBeInTheDocument();
      expect(screen.queryByText(ADJUST_SHEET.failed)).not.toBeInTheDocument();
      expect(stub.calls.some((c) => c.method === "GET" && c.path.startsWith(`/api/v1/admin/ledger/?`)
        && c.path.includes(`userId=${USER}`))).toBe(true);
      expect(stub.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    });

    it("says it is not known — not that it failed — when the ledger cannot be read either", async () => {
      stubFetch(landedThenLost(503));
      renderPage(<AdminMembersPage />);

      await fill("7", "lost reply probe");
      fireEvent.click(await armed());

      expect(await screen.findByText(LOST_REPLY.unknown("Ada Lovelace"))).toBeInTheDocument();
    });

    it("keeps the key while the outcome is unknown, so a changed amount meets the stored movement", async () => {
      const stub = stubFetch(landedThenLost(503));
      renderPage(<AdminMembersPage />);

      await fill("7", "lost reply probe");
      fireEvent.click(await armed());
      await screen.findByText(LOST_REPLY.unknown("Ada Lovelace"));
      fireEvent.click(screen.getByRole("button", { name: ADJUST_SHEET.back }));
      fireEvent.click(screen.getByRole("button", { name: ADJUST_SHEET.back }));
      fireEvent.change(await screen.findByLabelText(ADJUST_SHEET.amountLabel), { target: { value: "9" } });
      fireEvent.click(screen.getByRole("button", { name: ADJUST_SHEET.next }));
      fireEvent.click(await screen.findByRole("button", { name: ADJUST_SHEET.next }));
      fireEvent.click(await armed());

      await waitFor(() => expect(stub.calls.filter((c) => c.method === "POST")).toHaveLength(2));
      const [first, second] = stub.calls.filter((c) => c.method === "POST");
      const key = (b: unknown) => (b as Record<string, unknown>).idempotencyKey;
      expect(key(second.body)).toBe(key(first.body));
    });
  });

  it("names what already landed when the server answers idempotency_key_reused", async () => {
    stubFetch(routes({
      status: 409,
      body: { error: "idempotency_key_reused", stored: { amount_minutes: 7, type: "AdminAdjustment", reason: "coaching session", at: "2026-09-30T08:00:00Z" } },
    }));
    renderPage(<AdminMembersPage />);

    await fill("9", "coaching session");
    fireEvent.click(await armed());

    expect(await screen.findByText(
      "An earlier press already went through: +7 minutes (“coaching session”). Nothing more was added — check the ledger before adding anything else.",
    )).toBeInTheDocument();
  });

  /**
   * Review round 3, I-6: the 409 proves the earlier movement LANDED, so the balance on the sheet
   * (and the row) was stale and the "after" figure summed onto it. The balance is re-read.
   */
  it("re-reads the balance after idempotency_key_reused, and never says it didn't go through", async () => {
    stubFetch([
      { path: "/api/v1/admin/members/", body: [memberFixture()] },
      { path: `/api/v1/admin/members/${USER}`, body: { ...memberFixture(), balance_minutes: 127 } },
      { path: "/api/v1/admin/biometric/enrollments", body: [] },
      { path: "/api/v1/admin/ledger/", body: [] },
      {
        method: "POST", path: ADJUST, status: 409,
        body: { error: "idempotency_key_reused", stored: { amount_minutes: 7, type: "AdminAdjustment", reason: "coaching session" } },
      },
    ]);
    renderPage(<AdminMembersPage />);

    await fill("9", "coaching session");
    fireEvent.click(await armed());

    await screen.findByText(/An earlier press already went through: \+7 minutes/);
    expect(await screen.findByText("2 hours 16 minutes")).toBeInTheDocument();
    const live = document.querySelector("[data-confirm-group] > [aria-live='polite']");
    expect(live).toHaveTextContent(LIVE_SAID.reused);
    expect(live).not.toHaveTextContent(/didn't go through/);
  });

  it("gives a CHANGED amount its own key once the first press was refused outright", async () => {
    const stub = stubFetch(routes({ status: [400, 200], body: { error: "amount_out_of_range", max_minutes: 8 } }));
    renderPage(<AdminMembersPage />);

    await fill("7", "coaching session");
    fireEvent.click(await armed());
    await screen.findByText(/the most is 8 minutes/);
    fireEvent.click(screen.getByRole("button", { name: ADJUST_SHEET.back }));
    fireEvent.click(screen.getByRole("button", { name: ADJUST_SHEET.back }));
    fireEvent.change(await screen.findByLabelText(ADJUST_SHEET.amountLabel), { target: { value: "9" } });
    fireEvent.click(screen.getByRole("button", { name: ADJUST_SHEET.next }));
    fireEvent.click(await screen.findByRole("button", { name: ADJUST_SHEET.next }));
    fireEvent.click(await armed());

    await waitFor(() => expect(stub.calls.filter((c) => c.method === "POST")).toHaveLength(2));
    const [first, second] = stub.calls.filter((c) => c.method === "POST");
    const key = (b: unknown) => (b as Record<string, unknown>).idempotencyKey;
    expect(key(second.body)).not.toBe(key(first.body));
  });

  it("gives a second, deliberate adjustment its own key", async () => {
    const stub = stubFetch(routes());
    renderPage(<AdminMembersPage />);

    await fill("7", "coaching session");
    fireEvent.click(await armed());
    await waitFor(() => expect(screen.getByText("Done. Ada Lovelace now has 2 hours 7 minutes.")).toBeInTheDocument());
    // The receipt stays until it is closed — P5 names that button "Done" (every sheet also has
    // its own close ×, named "Close").
    fireEvent.click(screen.getByRole("button", { name: ADJUST_SHEET.done }));

    await fill("7", "coaching session");
    fireEvent.click(await armed());
    await waitFor(() => expect(stub.calls.filter((c) => c.method === "POST").length).toBe(2));
    const [first, second] = stub.calls.filter((c) => c.method === "POST");
    expect((first.body as Record<string, unknown>).idempotencyKey)
      .not.toBe((second.body as Record<string, unknown>).idempotencyKey);
  });
});

/**
 * The member's groups — D2 deleted the rate class (`POST /admin/members/{id}/class` is gone) and
 * groups carry the package discount (P13) and the peak say now. "Change groups" in the row's ⋯ menu opens
 * GroupAssign: chips, a preview of what the move does to their money BEFORE it is saved, and one
 * `PUT /admin/members/{userId}/groups` with the whole set.
 */
/**
 * GroupAssign's picker: open it, tick one, close it. The list stays open while several are ticked
 * (a multi-select), so the test closes it the way a person does — Escape — before saving.
 */
async function pickGroup(dialog: HTMLElement, name: RegExp) {
  fireEvent.click(await within(dialog).findByRole("combobox", { name: /Add a group/ }));
  const option = await screen.findByRole("option", { name });
  fireEvent.click(option);
  fireEvent.keyDown(option, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("option", { name })).not.toBeInTheDocument());
}

describe("AdminMembers — groups (D2 retired the class)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const USER = "44444444-4444-4444-4444-444444444444";
  const LEAGUE = { id: "g-league", name: "League", status: "active", system_key: "league", package_discount_bps: 1000, peak_priority: true, member_count: 3 };
  const JUNIORS = { id: "g-juniors", name: "Juniors", status: "active", system_key: null, package_discount_bps: null, peak_priority: false, member_count: 5 };
  const TARIFF_NOW = { package_discount_bps: null, discount_group_id: null, peak_priority: false, peak_withheld_by: [] };
  const TARIFF_LEAGUE = { package_discount_bps: 1000, discount_group_id: "g-league", peak_priority: true, peak_withheld_by: [] };

  const routes = (extra: StubRoute[] = []): StubRoute[] => [
    { path: "/api/v1/admin/members/", body: [memberFixture({ member_class: undefined, groups: [] })] },
    { path: "/api/v1/admin/biometric/enrollments", body: [] },
    { path: "/api/v1/admin/member-groups", body: { groups: [LEAGUE, JUNIORS] } },
    {
      method: "POST",
      path: "/api/v1/admin/member-groups/preview",
      body: { current: { tariff: TARIFF_NOW }, would_be: { tariff: TARIFF_LEAGUE } },
    },
    ...extra,
  ];

  it("shows what the move does to their package discount before saving, then saves the whole set", async () => {
    const stub = stubFetch(routes([{
      method: "PUT",
      path: `/api/v1/admin/members/${USER}/groups`,
      body: { user_id: USER, groups: [LEAGUE], added: ["g-league"], removed: [], tariff: TARIFF_LEAGUE },
    }]));
    renderPage(<AdminMembersPage />);

    await fromMenu(ASSIGN_COPY.change);
    const dialog = await screen.findByRole("dialog", { name: ASSIGN_COPY.title("Ada Lovelace") });
    expect(within(dialog).getByText(ASSIGN_COPY.none)).toBeInTheDocument();

    await pickGroup(dialog, /League/);

    // Before anything is saved: the club's own answer to "what would this do", in words.
    expect(await within(dialog).findByText(/10% off club packages \(from League\) instead of no package discount/)).toBeInTheDocument();
    expect(within(dialog).getByText("Gains peak priority.")).toBeInTheDocument();
    const preview = stub.calls.find((c) => c.path.endsWith("/member-groups/preview"));
    expect(preview?.body).toEqual({ userId: USER, proposedGroupIds: ["g-league"] });
    expect(stub.calls.some((c) => c.method === "PUT"), "the preview wrote nothing").toBe(false);

    fireEvent.click(within(dialog).getByRole("button", { name: ASSIGN_COPY.saveLabel("Ada", 1) }));
    await waitFor(() => expect(stub.calls.find((c) => c.method === "PUT")?.body).toEqual({ groupIds: ["g-league"] }));
    expect(await screen.findByText(/Ada Lovelace is in 1 group now\. 10% off club packages \(from League\) · peak priority\./)).toBeInTheDocument();
    // The row takes the saved set at once.
    const row = document.querySelector(`[data-member-row="${USER}"]`) as HTMLElement;
    await waitFor(() => expect(within(row).getByText("League")).toBeInTheDocument());
    // The class endpoint D2 deleted is never called again.
    expect(stub.calls.some((c) => c.path.endsWith("/class"))).toBe(false);
  });

  it("keeps the dialog open and says a refusal in words, naming the group", async () => {
    stubFetch(routes([{
      method: "PUT",
      path: `/api/v1/admin/members/${USER}/groups`,
      status: 400,
      body: { error: "group_archived", group_id: "g-juniors", name: "Juniors" },
    }]));
    renderPage(<AdminMembersPage />);

    await fromMenu(ASSIGN_COPY.change);
    const dialog = await screen.findByRole("dialog", { name: ASSIGN_COPY.title("Ada Lovelace") });
    await pickGroup(dialog, /Juniors/);
    fireEvent.click(within(dialog).getByRole("button", { name: ASSIGN_COPY.saveLabel("Ada", 1) }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Juniors has been archived, so nobody can join it.");
    expect(alert).not.toHaveTextContent("group_archived");
    expect(screen.getByRole("dialog", { name: ASSIGN_COPY.title("Ada Lovelace") })).toBeInTheDocument();
  });

  it("offers no rate-class control any more", async () => {
    stubFetch(routes());
    renderPage(<AdminMembersPage />);
    fireEvent.pointerDown(await screen.findByRole("button", { name: ROW_ACTIONS.more("Ada Lovelace") }), POINTER);
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByRole("menuitemradio")).not.toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: ASSIGN_COPY.change })).toBeInTheDocument();
  });
});

/**
 * Suspension, and the verification state that decides whether a member can sign in at all.
 */
describe("AdminMembers — suspend, reactivate and verification", () => {
  afterEach(() => vi.unstubAllGlobals());

  const MEMBERSHIP = "33333333-3333-3333-3333-333333333333";

  const routes = (member: Record<string, unknown> = {}, extra: StubRoute[] = []): StubRoute[] => [
    { path: "/api/v1/admin/members/", body: [memberFixture(member)] },
    { path: "/api/v1/admin/biometric/enrollments", body: [] },
    ...extra,
  ];

  it("suspends with a reason, and says the member's money and bookings are untouched", async () => {
    const stub = stubFetch(routes({}, [
      { method: "POST", path: `/api/v1/admin/members/${MEMBERSHIP}/suspend`, body: { suspended: true, member_notified: true } },
    ]));
    renderPage(<AdminMembersPage />);

    await fromMenu(ROW_ACTIONS.suspend);
    const dialog = await screen.findByRole("dialog", { name: SUSPEND_DIALOG.title("Ada Lovelace") });

    // The reason is not optional: the member is emailed it. Review round 2 (A11Y F3-18): the
    // field says it is required, and the button stays pressable and answers instead of sitting
    // disabled with no reason given.
    const confirm = within(dialog).getByRole("button", { name: SUSPEND_DIALOG.confirm });
    expect(confirm).toBeEnabled();
    expect(within(dialog).getByPlaceholderText(/Membership dues unpaid/)).toHaveAttribute("aria-required", "true");
    expect(dialog).toHaveTextContent(REQUIRED_MARK);
    fireEvent.click(confirm);
    expect(await within(dialog).findByText(CONFIRM_NOT_READY)).toBeInTheDocument();
    expect(document.activeElement).toBe(within(dialog).getByPlaceholderText(/Membership dues unpaid/));
    expect(stub.calls.some((c) => c.path.endsWith("/suspend"))).toBe(false);
    expect(dialog).toHaveTextContent(/Their minutes and any bookings/);
    expect(dialog).not.toHaveTextContent(/credit/i);
    expect(dialog).toHaveTextContent(/reactivating restores/);

    fireEvent.change(within(dialog).getByPlaceholderText(/Membership dues unpaid/), { target: { value: "Dues unpaid since March." } });
    fireEvent.click(within(dialog).getByRole("button", { name: SUSPEND_DIALOG.confirm }));

    await waitFor(() => expect(stub.calls.find((c) => c.path.endsWith("/suspend"))?.body).toEqual({ reason: "Dues unpaid since March." }));
  });

  /**
   * The two reason fields a screen reader could not name: each was a label with no `htmlFor`
   * beside an input with no `id` — for the one field whose text is emailed verbatim.
   */
  it("names the suspend reason field to a screen reader, not just to a sighted reader", async () => {
    stubFetch(routes());
    renderPage(<AdminMembersPage />);

    await fromMenu(ROW_ACTIONS.suspend);
    const field = await screen.findByLabelText(SUSPEND_DIALOG.reasonLabel);
    expect(field).toBe(screen.getByPlaceholderText(/Membership dues unpaid/));
    expect((field as HTMLInputElement).labels).toHaveLength(1);
  });

  it("names the reject reason field too, which is the same dialog shape", async () => {
    stubFetch(routes({ status: "PendingApproval", email_verified: true }));
    renderPage(<AdminMembersPage />);

    fireEvent.click(await screen.findByRole("button", { name: ROW_ACTIONS.reject }));
    const field = await screen.findByLabelText(REJECT_DIALOG.reasonLabel);
    expect(field).toBe(screen.getByPlaceholderText(/Membership number not on file/));
    expect((field as HTMLInputElement).labels).toHaveLength(1);
  });

  it("offers reactivate — and only reactivate-shaped actions — on a suspended member", async () => {
    const stub = stubFetch(routes({ status: "Suspended" }, [
      { method: "POST", path: `/api/v1/admin/members/${MEMBERSHIP}/reactivate`, body: { reactivated: true, member_notified: true } },
    ]));
    renderPage(<AdminMembersPage />);

    // A suspended member is not bookable, so offering to sell, adjust or enrol a finger would be
    // offering an action the box will refuse.
    await screen.findByText("Ada Lovelace");
    expect(screen.queryByRole("button", { name: ROW_ACTIONS.sell })).not.toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("button", { name: ROW_ACTIONS.more("Ada Lovelace") }), POINTER);
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByRole("menuitem", { name: ROW_ACTIONS.suspend })).not.toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: /fingerprint/i })).not.toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: ROW_ACTIONS.book })).not.toBeInTheDocument();

    fireEvent.click(within(menu).getByRole("menuitem", { name: ROW_ACTIONS.reactivate }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: ROW_ACTIONS.reactivate }));
    await waitFor(() => expect(stub.calls.some((c) => c.path.endsWith("/reactivate"))).toBe(true));
  });

  it("marks an unverified member and resends the verification email on request", async () => {
    const stub = stubFetch(routes({ email_verified: false }, [
      { method: "POST", path: "/api/v1/auth/resend-verification", body: { ok: true } },
    ]));
    renderPage(<AdminMembersPage />);

    // The answer to "the app won't let me in" from a member whose row says Active.
    expect(await screen.findByText(UNVERIFIED.label)).toBeInTheDocument();
    expect(screen.getByTitle(UNVERIFIED.title)).toBeInTheDocument();

    await fromMenu(ROW_ACTIONS.resend);
    await waitFor(() => expect(stub.calls.find((c) => c.path === "/api/v1/auth/resend-verification")?.body).toEqual({ email: "ada@example.com" }));
    expect(await screen.findByText(OUTCOMES.resendSent("ada@example.com"))).toBeInTheDocument();
  });

  it("says nothing about verification for a member who has verified", async () => {
    stubFetch(routes());
    renderPage(<AdminMembersPage />);

    await screen.findByText("Ada Lovelace");
    expect(screen.queryByText(UNVERIFIED.label)).not.toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("button", { name: ROW_ACTIONS.more("Ada Lovelace") }), POINTER);
    await screen.findByRole("menu");
    expect(screen.queryByRole("menuitem", { name: ROW_ACTIONS.resend })).not.toBeInTheDocument();
  });
});

/**
 * One click, one request (R2 I-F2). On Reactivate a double-click was a 200 then a 409 and two
 * contradictory toasts; on Resend it was two emails, and because a resend spends the earlier link
 * the first mail the member read held a dead one.
 */
describe("AdminMembers — one click, one request", () => {
  afterEach(() => vi.unstubAllGlobals());

  const MEMBERSHIP = "33333333-3333-3333-3333-333333333333";

  const routes = (member: Record<string, unknown> = {}, extra: StubRoute[] = []): StubRoute[] => [
    { path: "/api/v1/admin/members/", body: [memberFixture(member)] },
    { path: "/api/v1/admin/biometric/enrollments", body: [] },
    ...extra,
  ];

  it("reactivates once on a double-click, so no 409 lands on top of the 200", async () => {
    const stub = stubFetch(routes({ status: "Suspended" }, [
      { method: "POST", path: `/api/v1/admin/members/${MEMBERSHIP}/reactivate`, status: [200, 409], body: { reactivated: true, member_notified: true } },
    ]));
    renderPage(<AdminMembersPage />);

    await fromMenu(ROW_ACTIONS.reactivate);
    const button = within(await screen.findByRole("dialog")).getByRole("button", { name: ROW_ACTIONS.reactivate });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(stub.calls.some((c) => c.path.endsWith("/reactivate"))).toBe(true));
    expect(stub.calls.filter((c) => c.path.endsWith("/reactivate"))).toHaveLength(1);
    expect(await screen.findByText(OUTCOMES.reactivated("Ada Lovelace"))).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't reactivate/)).not.toBeInTheDocument();
  });

  it("sends one verification email while one is already on its way", async () => {
    const stub = stubFetch(routes({ email_verified: false }, [
      { method: "POST", path: "/api/v1/auth/resend-verification", body: { ok: true } },
    ]));
    // Hold the send open, so the second press lands while the first is genuinely in flight — the
    // menu closes on select, so this is the double press a person can actually make.
    const answered = globalThis.fetch;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      (String(input).includes("resend-verification") ? gate.then(() => answered(input, init)) : answered(input, init)));
    renderPage(<AdminMembersPage />);

    await fromMenu(ROW_ACTIONS.resend);
    await fromMenu(ROW_ACTIONS.resend);
    release();

    expect(await screen.findByText(OUTCOMES.resendSent("ada@example.com"))).toBeInTheDocument();
    expect(stub.calls.filter((c) => c.path === "/api/v1/auth/resend-verification")).toHaveLength(1);
  });
});

/**
 * The four sentences an admin reads when the club's mail server is down — each asserted on its
 * failing branch AND absent on the succeeding one, because only the pair discriminates a mutant
 * that collapses the ternary to one arm.
 */
describe("AdminMembers — what the admin is told when the member could not be emailed", () => {
  afterEach(() => vi.unstubAllGlobals());

  const MEMBERSHIP = "33333333-3333-3333-3333-333333333333";

  const routes = (member: Record<string, unknown>, extra: StubRoute[]): StubRoute[] => [
    { path: "/api/v1/admin/members/", body: [memberFixture(member)] },
    { path: "/api/v1/admin/biometric/enrollments", body: [] },
    ...extra,
  ];

  async function suspendWith(notified: boolean) {
    stubFetch(routes({}, [
      { method: "POST", path: `/api/v1/admin/members/${MEMBERSHIP}/suspend`, body: { suspended: true, member_notified: notified } },
    ]));
    renderPage(<AdminMembersPage />);
    await fromMenu(ROW_ACTIONS.suspend);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByPlaceholderText(/Membership dues unpaid/), { target: { value: "Dues unpaid since March." } });
    fireEvent.click(within(dialog).getByRole("button", { name: SUSPEND_DIALOG.confirm }));
  }

  it("tells the admin a suspended member will find out at the door, when the email did not go", async () => {
    await suspendWith(false);
    expect(await screen.findByText(
      "Ada Lovelace is suspended, but the email couldn't be sent. They'll find out at the door unless you tell them.",
    )).toBeInTheDocument();
  });

  it("says none of that when the suspension email did go", async () => {
    await suspendWith(true);
    expect(await screen.findByText("Ada Lovelace suspended.")).toBeInTheDocument();
    expect(screen.queryByText(/find out at the door/)).not.toBeInTheDocument();
    expect(screen.queryByText(/couldn't be sent/)).not.toBeInTheDocument();
  });

  async function reactivateWith(notified: boolean) {
    stubFetch(routes({ status: "Suspended" }, [
      { method: "POST", path: `/api/v1/admin/members/${MEMBERSHIP}/reactivate`, body: { reactivated: true, member_notified: notified } },
    ]));
    renderPage(<AdminMembersPage />);
    await fromMenu(ROW_ACTIONS.reactivate);
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: ROW_ACTIONS.reactivate }));
  }

  it("tells the admin to say so themselves when a reactivation email did not go", async () => {
    await reactivateWith(false);
    expect(await screen.findByText("Ada Lovelace is active again, but the email couldn't be sent. Tell them directly.")).toBeInTheDocument();
  });

  it("says none of that when the reactivation email did go", async () => {
    await reactivateWith(true);
    expect(await screen.findByText("Ada Lovelace is active again.")).toBeInTheDocument();
    expect(screen.queryByText(/couldn't be sent/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Tell them directly/)).not.toBeInTheDocument();
  });

  async function resetWith(notified: boolean) {
    stubFetch(routes({}, [
      {
        method: "POST", path: `/api/v1/admin/members/${MEMBERSHIP}/reset-password`,
        body: { temp_password: "Xk7-tempo-92", email_sent_to: notified ? "ada@example.com" : null, member_notified: notified },
      },
    ]));
    renderPage(<AdminMembersPage />);
    await fromMenu(ROW_ACTIONS.reset);
    const confirm = await screen.findByRole("dialog", { name: RESET_DIALOG.title("Ada Lovelace") });
    fireEvent.click(within(confirm).getByRole("button", { name: RESET_DIALOG.confirm }));
  }

  it("sends the admin to the password on the screen when the reset email did not go", async () => {
    await resetWith(false);
    expect(await screen.findByText(
      "Password reset for Ada Lovelace, but the email couldn't be sent. Read them the password below.",
    )).toBeInTheDocument();
    // "below" has to be true: the password the toast points at is on the same screen.
    const dialog = await screen.findByRole("dialog", { name: PASSWORD_DIALOG.title });
    expect(dialog).toHaveTextContent("Xk7-tempo-92");
  });

  it("says none of that when the reset email did go", async () => {
    await resetWith(true);
    expect(await screen.findByText("Password reset for Ada Lovelace.")).toBeInTheDocument();
    expect(screen.queryByText(/Read them the password below/)).not.toBeInTheDocument();
  });

  it("says the temporary password was not emailed, rather than naming an address it never reached", async () => {
    await resetWith(false);
    const dialog = await screen.findByRole("dialog", { name: PASSWORD_DIALOG.title });
    expect(dialog).toHaveTextContent("Not emailed");
    expect(dialog).toHaveTextContent("the send failed, so this password only reaches the member if you pass it on");
    // The bug this branch exists for: the dialog used to print "Emailed to null".
    expect(dialog).not.toHaveTextContent(/Emailed to/);
    expect(dialog).not.toHaveTextContent(/null/);
  });

  it("names the address when the temporary password really was emailed", async () => {
    await resetWith(true);
    const dialog = await screen.findByRole("dialog", { name: PASSWORD_DIALOG.title });
    expect(dialog).toHaveTextContent("Emailed to ada@example.com");
    expect(dialog).not.toHaveTextContent(/Not emailed/);
  });
});
