import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import AdminWebhooksPage from "./AdminWebhooks";
import { renderPage, stubFetch, type StubRoute } from "../test/harness";

/**
 * The webhooks console.
 *
 * <p>
 * Three defects lived on this one screen and each was invisible in a different way. The
 * delivery log — the only place that says whether webhooks are reaching anyone — read
 * PascalCase field names the API has never sent, so every cell rendered "Invalid Date" and
 * "undefinedms" while the data behind it was fine. The event picker offered seven of the
 * fifteen classes the spec names, including none of the member lifecycle, so a club could
 * not get a webhook on the one thing they most want one for. And every refusal from the
 * create endpoint — five distinct, named reasons — was collapsed into "Couldn't create
 * endpoint.", so a typo'd scheme and a deliberate LAN address looked identical.
 * </p>
 */
describe("AdminWebhooks", () => {
  afterEach(() => vi.unstubAllGlobals());

  const ENDPOINT_ID = "77777777-7777-7777-7777-777777777777";
  const LIST = "/api/v1/admin/webhooks";
  const DELIVERIES = `/api/v1/admin/webhooks/${ENDPOINT_ID}/deliveries`;

  const endpointFixture = () => ({
    id: ENDPOINT_ID,
    url_template: "https://scoreboard.example.com/court/{court_number}/lit",
    event_filter: "booking.lights_on",
    description: "Scoreboard",
    enabled: true,
    failure_count: 0,
    last_success_at: null,
    last_failure_at: null,
    created_at: "2026-09-01T08:00:00Z",
    secret: null,
  });

  /** Exactly what the API sends: snake_case, the same as every other admin projection. */
  const deliveryFixture = () => ({
    id: "c064e357-0000-4000-8000-000000000001",
    event_type: "booking.created",
    url: "https://scoreboard.example.com/court/3/lit",
    response_status: null,
    latency_ms: 2,
    attempt: 3,
    final_state: "pending" as const,
    created_at: "2026-09-05T10:47:20.752793Z",
    response_body_excerpt: "exception:HttpRequestException:nodename nor servname provided",
  });

  const routes = (extra: StubRoute[] = []): StubRoute[] => [
    { path: LIST, body: [endpointFixture()] },
    ...extra,
  ];

  /**
   * D-F2. The five cells of the one row read
   * <code>["Invalid Date", "", "", "", "undefinedms"]</code> and React logged a duplicate-key
   * warning on every render, because <code>rowKey</code> resolved to <code>undefined</code>
   * for all of them.
   */
  it("renders a delivery attempt instead of Invalid Date and undefinedms", async () => {
    stubFetch(routes([{ path: DELIVERIES, body: [deliveryFixture()] }]));
    renderPage(<AdminWebhooksPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Deliveries" }));

    expect(await screen.findByText("booking.created")).toBeInTheDocument();
    expect(screen.getByText("2ms")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    // The state stands in for the status code while there is no response yet.
    expect(screen.getByText("pending")).toBeInTheDocument();

    expect(screen.queryByText("Invalid Date")).not.toBeInTheDocument();
    expect(screen.queryByText("undefinedms")).not.toBeInTheDocument();
  });

  /**
   * D-F7. Seven of fifteen classes were offered, and the whole member lifecycle — the two
   * the spec names inside the registration flow by name — was missing.
   */
  it("offers every event class the bus emits, the member lifecycle included", async () => {
    stubFetch(routes());
    renderPage(<AdminWebhooksPage />);

    fireEvent.click(await screen.findByRole("button", { name: /New endpoint/ }));

    for (const name of [
      "booking.created", "booking.cancelled", "booking.late_cancellation",
      "booking.lights_on", "booking.lights_off", "booking.no_show",
      "booking.completed", "booking.no_show_reversed",
      "booking.displaced", "booking.displacement_reversed",
      "booking.cancelled_lights_charged",
      "credit.topped_up", "credit.refunded", "credit.penalty_applied", "credit.adjusted",
      "member.registered", "member.approved", "member.rejected",
      "member.suspended", "member.reactivated",
    ]) {
      expect(await screen.findByRole("button", { name: new RegExp(`^${name.replace(".", "\\.")}$`) })).toBeInTheDocument();
    }

    // And nothing the bus cannot fire: an event offered here that nothing emits is a filter
    // an admin can select and then wait on forever.
    expect(screen.queryByRole("button", { name: /peripheral\.unhealthy/ })).not.toBeInTheDocument();
  });

  /**
   * The court box is pull-only, has no inbound HTTP listener and no <code>arduino.local</code>
   * name; <code>docs/specs/webhooks.md</code> says the superseded lights-controller URL "must
   * not be used as a templating example". It was this form's prefilled value, so the one
   * example every admin started from was the forbidden one.
   */
  it("does not seed the form with the court box as a destination", async () => {
    stubFetch(routes());
    renderPage(<AdminWebhooksPage />);

    fireEvent.click(await screen.findByRole("button", { name: /New endpoint/ }));

    expect(document.body.textContent).not.toMatch(/arduino\.local/);
    const inputs = Array.from(document.querySelectorAll("input")).map((i) => `${i.value} ${i.placeholder}`);
    expect(inputs.join(" ")).not.toMatch(/arduino/i);
  });

  /**
   * D-F8. Five distinct refusals, one four-word toast.
   *
   * The <code>destination_not_permitted</code> case matters most: the guard is correct and
   * must not be loosened, but a club pointing a webhook at its own LAN scoreboard is a
   * supported case reached through the private-network allow-list, which is deployment
   * configuration and not something this screen can change. The copy has to say which of
   * those two situations the admin is in.
   */
  const refusalCases: [string, RegExp][] = [
    ["destination_not_permitted", /private or link-local network/],
    ["scheme_must_be_http_or_https", /have to be http:\/\/ or https:\/\//],
    ["url_invalid", /isn't a URL/],
    ["template_variable_not_allowed_in_host", /can't appear in the host/],
  ];

  it.each(refusalCases)("says why a destination was refused: %s", async (error, expected) => {
    stubFetch(routes([{ method: "POST", path: LIST, status: 400, body: { error } }]));
    renderPage(<AdminWebhooksPage />);

    fireEvent.click(await screen.findByRole("button", { name: /New endpoint/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create endpoint" }));

    expect(await screen.findByText(expected)).toBeInTheDocument();
    expect(screen.queryByText("Couldn't create endpoint.")).not.toBeInTheDocument();
  });

  it("still says something useful for a refusal it has no sentence for", async () => {
    stubFetch(routes([{ method: "POST", path: LIST, status: 400, body: { error: "some_future_reason" } }]));
    renderPage(<AdminWebhooksPage />);

    fireEvent.click(await screen.findByRole("button", { name: /New endpoint/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create endpoint" }));

    expect(await screen.findByText(/Check the URL and try again/)).toBeInTheDocument();
  });

  it("creates an endpoint and shows the signing secret once", async () => {
    const stub = stubFetch(routes([
      { method: "POST", path: LIST, body: { ...endpointFixture(), secret: "whsec_abc123" } },
    ]));
    renderPage(<AdminWebhooksPage />);

    fireEvent.click(await screen.findByRole("button", { name: /New endpoint/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create endpoint" }));

    await waitFor(() => expect(stub.calls.some((c) => c.method === "POST")).toBe(true));
    expect(await screen.findByText(/won't be shown again/)).toBeInTheDocument();
  });
});
