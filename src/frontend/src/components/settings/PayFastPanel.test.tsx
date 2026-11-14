import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PayFastPanel } from "./PayFastPanel";
import { PAYFAST_COPY, PAYFAST_PROBLEM } from "../../lib/payfastCopy";
import { renderPage, signIn, stubFetch } from "../../test/harness";

const ROUTE = "/api/v1/admin/payments/payfast";

const UNSET = {
  configured: false, problems: ["merchant_id_invalid", "merchant_key_invalid", "passphrase_required"],
  merchant_id: null, merchant_key: null, passphrase_set: false, passphrase_required: true, environment: "test",
  notify_url: "https://crusaders.frostaura.net/api/v1/topup/itn",
};
const READY = {
  ...UNSET, configured: true, problems: [], merchant_id: "10000100", merchant_key: "46f0cd694581a", passphrase_set: true,
};

function render() {
  signIn({ isAdmin: true });
  renderPage(<PayFastPanel />);
}

describe("Settings › PayFast account (BM-4)", () => {
  it("says what stops members paying online, in words, while the account is not set up", async () => {
    stubFetch([{ path: ROUTE, body: UNSET }]);
    render();
    expect(await screen.findByText(PAYFAST_COPY.notReady)).toBeInTheDocument();
    for (const code of UNSET.problems) expect(screen.getByText(PAYFAST_PROBLEM[code])).toBeInTheDocument();
    expect(screen.getByText(/crusaders\.frostaura\.net\/api\/v1\/topup\/itn/)).toBeInTheDocument();
  });

  it("is absent against an API without the route, and says a failed read failed", async () => {
    stubFetch([{ path: ROUTE, status: 404, body: { error: "not_found" } }]);
    render();
    await waitFor(() => expect(screen.queryByText(PAYFAST_COPY.title)).toBeNull());
  });

  it("says a failed read failed rather than 'not set up'", async () => {
    stubFetch([{ path: ROUTE, status: 500, body: { error: "internal_error" } }]);
    render();
    expect(await screen.findByText(/read the club's PayFast account/i)).toBeInTheDocument();
    expect(screen.queryByText(PAYFAST_COPY.notReady)).toBeNull();
  });

  it("saves the account, and keeps the stored passphrase when the box is left empty", async () => {
    const stub = stubFetch([
      { path: ROUTE, body: READY },
      { method: "PUT", path: ROUTE, body: { ...READY, merchant_id: "10000200" } },
    ]);
    render();
    fireEvent.click(await screen.findByRole("button", { name: PAYFAST_COPY.edit }));
    expect(screen.getByText(PAYFAST_COPY.passphraseSet)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Merchant ID/), { target: { value: " 10000200 " } });
    fireEvent.click(screen.getByRole("button", { name: PAYFAST_COPY.save }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: PAYFAST_COPY.save }));

    await waitFor(() => expect(stub.calls.find((c) => c.method === "PUT")?.body)
      .toEqual({ merchant_id: "10000200", merchant_key: "46f0cd694581a", environment: "test" }));
    expect(await screen.findByText(`${PAYFAST_COPY.merchantId}: 10000200`)).toBeInTheDocument();
  });

  it("sends a typed passphrase, and lists every problem the API refuses the save for", async () => {
    const stub = stubFetch([
      { path: ROUTE, body: UNSET },
      { method: "PUT", path: ROUTE, status: 400, body: { error: "payfast_credentials_invalid", problems: ["passphrase_too_short", "merchant_id_invalid"] } },
    ]);
    render();
    fireEvent.click(await screen.findByRole("button", { name: PAYFAST_COPY.edit }));
    fireEvent.change(screen.getByLabelText(/Merchant ID/), { target: { value: "123" } });
    fireEvent.change(screen.getByLabelText(/Merchant key/), { target: { value: "46f0cd694581a" } });
    fireEvent.change(screen.getByLabelText(/Passphrase/), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: PAYFAST_COPY.save }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: PAYFAST_COPY.save }));

    await waitFor(() => expect(stub.calls.find((c) => c.method === "PUT")?.body)
      .toEqual({ merchant_id: "123", merchant_key: "46f0cd694581a", environment: "test", passphrase: "short" }));
    expect(await within(dialog).findByText(new RegExp(PAYFAST_PROBLEM.passphrase_too_short))).toBeInTheDocument();
    expect(within(dialog).getByText(new RegExp(PAYFAST_PROBLEM.merchant_id_invalid))).toBeInTheDocument();
  });
});
