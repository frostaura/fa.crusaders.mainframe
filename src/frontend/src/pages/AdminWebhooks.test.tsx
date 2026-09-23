import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Every `.cs` file in a tree, minus the generated and build directories.
 *
 * <p>
 * Migrations are excluded because they mention nothing relevant and are the largest files in
 * the project; `bin` and `obj` because a stale copy there would answer for source that no
 * longer exists.
 * </p>
 */
function csSources(dir: string): string[] {
  const skip = new Set(["bin", "obj", "Migrations"]);
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return skip.has(entry.name) ? [] : csSources(join(dir, entry.name));
    return entry.name.endsWith(".cs") ? [join(dir, entry.name)] : [];
  });
}
import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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
   * The URL field, found the way an admin finds it: by the example printed in it.
   *
   * The form no longer opens with a destination in it (see the prefill tests below), so
   * every test that means to CREATE something has to type one — which is the point.
   */
  const URL_PLACEHOLDER = "https://example.com/webhook?court={court_number}";
  function typeUrl(value = "https://scoreboard.example.com/court/{court_number}/lit") {
    fireEvent.change(screen.getByPlaceholderText(URL_PLACEHOLDER), { target: { value } });
  }

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

    // Waited for on the DELIVERIES region itself. `findByText("booking.created")` alone could
    // resolve on the event catalogue further down the page — which names the same event —
    // before the deliveries had rendered, and the synchronous reads after it then ran against a
    // table that was not there yet: an intermittent failure. The region only exists once the
    // attempts have been read, so everything below is read inside it.
    const deliveries = within(await screen.findByRole("region", { name: "Recent deliveries" }));
    expect(deliveries.getByText("booking.created")).toBeInTheDocument();
    expect(deliveries.getByText("2ms")).toBeInTheDocument();
    expect(deliveries.getByText("3")).toBeInTheDocument();
    // The state stands in for the status code while there is no response yet.
    expect(deliveries.getByText("pending")).toBeInTheDocument();

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
      // The last of the nine, reinstated. It was absent because §9 asserted no liveness
      // signal existed; the box pushes a heartbeat and PeripheralHealthWorker sweeps it.
      "peripheral.unhealthy", "peripheral.recovered",
    ]) {
      expect(await screen.findByRole("button", { name: new RegExp(`^${name.replace(".", "\\.")}$`) })).toBeInTheDocument();
    }

    // "And nothing the bus cannot fire" used to be asserted here, as
    // `queryByRole({ name: /peripheral\.faulted/ })).not.toBeInTheDocument()`. That string
    // occurs nowhere in the repository, so the assertion could not fail: it was a tautology
    // sitting in the slot of the check it replaced. A hard-coded phantom name always is one
    // — the property is "every class offered has an emitter", and only the backend can
    // answer that. It is the test two below, which reads the emitters.
  });

  /**
   * D-F7's residue: the spec and the picker have to agree, and nothing was checking.
   *
   * <p>
   * The list above is hand-maintained, so it can only ever say that today's picker
   * matches today's opinion of what the bus emits. <code>peripheral.unhealthy</code> sat
   * in <code>feature-spec.md</code> §9 as a flat promise with no emitter anywhere in the
   * backend and no offer here, and the divergence survived a fix round because the two
   * halves are in different languages and no gate reads both. This one does: every class
   * §9 states plainly is a class this picker must offer, and a class §9 does not intend
   * to fire has to say so <em>in §9</em> before it may be missing from here.
   * </p>
   */
  it("offers every event class the spec states plainly, and the spec marks the ones it does not", async () => {
    const spec = readFileSync(resolve(__dirname, "../../../../docs/specs/feature-spec.md"), "utf8");
    const section = spec.split(/^## 9\. Webhooks$/m)[1]?.split(/^## /m)[0];
    expect(section, "feature-spec.md has no §9. Webhooks").toBeTruthy();

    const bullets = Array.from(section!.matchAll(/^- `([a-z]+\.[a-z_]+)`(.*)$/gm));
    // Guard against the regex quietly matching nothing and the test passing on an empty set.
    expect(bullets.length).toBeGreaterThan(10);

    const promised = bullets.filter(([, , rest]) => !/not emitted/i.test(rest)).map(([, name]) => name);
    const reserved = bullets.filter(([, , rest]) => /not emitted/i.test(rest)).map(([, name]) => name);
    expect(promised.length + reserved.length).toBe(bullets.length);

    stubFetch(routes());
    renderPage(<AdminWebhooksPage />);
    fireEvent.click(await screen.findByRole("button", { name: /New endpoint/ }));

    for (const name of promised) {
      expect(
        await screen.findByRole("button", { name: new RegExp(`^${name.replace(".", "\\.")}$`) }),
        `${name} is stated in feature-spec.md §9 but the picker does not offer it`,
      ).toBeInTheDocument();
    }
    for (const name of reserved) {
      expect(
        screen.queryByRole("button", { name: new RegExp(`^${name.replace(".", "\\.")}$`) }),
        `${name} is marked not-emitted in feature-spec.md §9 but the picker offers it anyway`,
      ).toBeNull();
    }

    // The direction the first version of this test could not see, and the one that had six
    // real classes hiding in it: booking.lights_off, booking.no_show_reversed,
    // booking.displaced, booking.displacement_reversed, booking.cancelled_lights_charged and
    // member.reactivated were all offered here and absent from §9, so the catalogue a club
    // integrates against was six events short while the gate stayed green.
    const stated = new Set([...promised, ...reserved]);
    const offered = Array.from(document.querySelectorAll("button"))
      .map((b) => b.textContent?.trim() ?? "")
      .filter((t) => /^[a-z]+\.[a-z_]+$/.test(t));
    expect(offered.length).toBeGreaterThan(10);
    for (const name of offered) {
      expect(stated.has(name), `${name} is offered by the picker but feature-spec.md §9 never names it`).toBe(true);
    }
  });

  /**
   * D-F7's actual complaint, in the direction nothing was checking.
   *
   * <p>
   * The §9 gate above is spec-versus-picker, and its "must not be offered" branch only bites
   * on a bullet §9 has marked <em>not emitted</em> — there are none, so that branch iterates
   * zero times and the picker could offer a class nothing anywhere fires. Selecting one is a
   * filter an admin waits on forever. The only source that can answer is the backend, so this
   * reads it: every class the picker offers must appear as a quoted literal somewhere in the
   * API project.
   * </p>
   *
   * <p>
   * Deliberately a coarse match rather than a parse of <code>EmitAsync</code> call sites: the
   * names arrive there three different ways (a literal argument, a <code>Type:</code> member,
   * a local). A comment naming a class it does not emit would pass this, which is the known
   * weakness and is worth far less than the phantom it catches. The two self-checks below are
   * what stop it degenerating into the tautology it replaces — the search must be shown to
   * find a real emitter and to miss a name that has none.
   * </p>
   */
  it("offers no event class the backend never emits", async () => {
    const apiRoot = resolve(__dirname, "../../../backend/Crusaders.Mainframe.Api");
    const corpus = csSources(apiRoot).map((f) => readFileSync(f, "utf8")).join("\n");

    expect(corpus.length, `no C# sources found under ${apiRoot}`).toBeGreaterThan(10_000);
    expect(corpus, "the emitter search cannot find a class that is emitted").toContain('"peripheral.unhealthy"');
    expect(corpus, "the emitter search matches a class nothing emits").not.toContain('"peripheral.faulted"');

    stubFetch(routes());
    renderPage(<AdminWebhooksPage />);
    fireEvent.click(await screen.findByRole("button", { name: /New endpoint/ }));

    const offered = Array.from(document.querySelectorAll("button"))
      .map((b) => b.textContent?.trim() ?? "")
      .filter((t) => /^[a-z]+\.[a-z_]+$/.test(t));
    expect(offered.length).toBeGreaterThan(10);

    for (const name of offered) {
      expect(
        corpus.includes(`"${name}"`),
        `${name} is offered by the picker but nothing in the API project emits it`,
      ).toBe(true);
    }
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
   * R2 I-F1. The `arduino.local` default was replaced with a scoreboard host, which fixed
   * the wrong half: the defect is that the field holds a VALUE at all.
   *
   * <p>
   * Opened cold and pressed once, the form posted a live endpoint at
   * <code>scoreboard.example.com</code> — a domain the club does not own — and every
   * subsequent <code>booking.lights_on</code> then carried <code>booking_id</code>,
   * <code>court_id</code>, <code>user_id</code> and the member's slot times to it, HMAC-signed
   * so the receiver could trust them. Two clicks, nothing typed. The examples belong in the
   * placeholders, which both fields already have.
   * </p>
   */
  it("opens with no destination in it — a URL is typed, never inherited", async () => {
    stubFetch(routes());
    renderPage(<AdminWebhooksPage />);

    fireEvent.click(await screen.findByRole("button", { name: /New endpoint/ }));

    // Every field an admin could submit is empty. Placeholders may carry examples; values
    // may not — that distinction is the whole finding.
    for (const input of Array.from(document.querySelectorAll("input"))) {
      expect(input.value, `"${input.placeholder}" opened pre-filled with "${input.value}"`).toBe("");
    }
    // And the example is still on screen, where it can be read and not submitted.
    expect(screen.getByPlaceholderText(URL_PLACEHOLDER)).toBeInTheDocument();
  });

  it("creates nothing when Create is pressed with an empty form, and says what is missing", async () => {
    const stub = stubFetch(routes());
    renderPage(<AdminWebhooksPage />);

    fireEvent.click(await screen.findByRole("button", { name: /New endpoint/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create endpoint" }));

    expect(await screen.findByText(/URL template is required/)).toBeInTheDocument();
    expect(stub.calls.some((c) => c.method === "POST")).toBe(false);
  });

  /**
   * The same defect one step later: a form that reopens holding the destination just
   * created is a duplicate endpoint one click away from existing.
   */
  it("empties the form after a successful create", async () => {
    stubFetch(routes([
      { method: "POST", path: LIST, body: { ...endpointFixture(), secret: "whsec_abc123" } },
    ]));
    renderPage(<AdminWebhooksPage />);

    fireEvent.click(await screen.findByRole("button", { name: /New endpoint/ }));
    typeUrl("https://scoreboard.example.test/lit");
    fireEvent.click(screen.getByRole("button", { name: "Create endpoint" }));
    expect(await screen.findByText(/won't be shown again/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /New endpoint/ }));
    expect(screen.getByPlaceholderText(URL_PLACEHOLDER)).toHaveValue("");
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
    typeUrl();
    fireEvent.click(screen.getByRole("button", { name: "Create endpoint" }));

    expect(await screen.findByText(expected)).toBeInTheDocument();
    expect(screen.queryByText("Couldn't create endpoint.")).not.toBeInTheDocument();
  });

  /**
   * D-F8's residue. The refusal named the reason but still read like a pointer at a
   * screen somebody had forgotten to build.
   *
   * <p>
   * There is no such screen and there is deliberately not going to be one.
   * <code>Webhooks:PrivateNetworkAllowList</code> is read once, at startup, by a
   * singleton <code>OutboundAddressGuard</code> that has no tenant in scope — so a
   * club admin editing it would be moving an SSRF boundary for every other club on the
   * deployment. That is the cross-tenant escalation this codebase calls a P0, dressed
   * as a settings field. The decision is recorded in <code>docs/specs/webhooks.md</code>
   * and the copy now states it outright instead of hinting at it.
   * </p>
   */
  it("says the LAN carve-out is deployment configuration, not a screen that is missing", async () => {
    stubFetch(routes([{ method: "POST", path: LIST, status: 400, body: { error: "destination_not_permitted" } }]));
    renderPage(<AdminWebhooksPage />);

    fireEvent.click(await screen.findByRole("button", { name: /New endpoint/ }));
    typeUrl("http://127.0.0.1:9445/hook");
    fireEvent.click(screen.getByRole("button", { name: "Create endpoint" }));

    const said = await screen.findByText(/private or link-local network/);
    // Says it outright: no screen here can do it, and who can.
    expect(said).toHaveTextContent(/No admin screen can open one up/);
    expect(said).toHaveTextContent(/whoever runs the deployment/);
    // And names the setting, so the admin's request to that operator is actionable
    // rather than a description of a thing they have to go and find.
    expect(said).toHaveTextContent(/Webhooks:PrivateNetworkAllowList/);
  });

  /**
   * The copy above tells an admin to quote a configuration key to whoever runs the
   * deployment. A key that has been renamed since makes that sentence a wild goose
   * chase, and nothing else in the tree crosses the language boundary to notice.
   */
  it("names a setting the API actually reads", () => {
    const appsettings = JSON.parse(
      readFileSync(resolve(__dirname, "../../../backend/Crusaders.Mainframe.Api/appsettings.json"), "utf8"),
    ) as { Webhooks?: Record<string, unknown> };
    expect(appsettings.Webhooks).toBeDefined();
    expect(Object.keys(appsettings.Webhooks!)).toContain("PrivateNetworkAllowList");
  });

  it("still says something useful for a refusal it has no sentence for", async () => {
    stubFetch(routes([{ method: "POST", path: LIST, status: 400, body: { error: "some_future_reason" } }]));
    renderPage(<AdminWebhooksPage />);

    fireEvent.click(await screen.findByRole("button", { name: /New endpoint/ }));
    typeUrl();
    fireEvent.click(screen.getByRole("button", { name: "Create endpoint" }));

    expect(await screen.findByText(/Check the URL and try again/)).toBeInTheDocument();
  });

  it("creates an endpoint and shows the signing secret once", async () => {
    const stub = stubFetch(routes([
      { method: "POST", path: LIST, body: { ...endpointFixture(), secret: "whsec_abc123" } },
    ]));
    renderPage(<AdminWebhooksPage />);

    fireEvent.click(await screen.findByRole("button", { name: /New endpoint/ }));
    typeUrl();
    fireEvent.click(screen.getByRole("button", { name: "Create endpoint" }));

    await waitFor(() => expect(stub.calls.some((c) => c.method === "POST")).toBe(true));
    expect(await screen.findByText(/won't be shown again/)).toBeInTheDocument();
  });
});
