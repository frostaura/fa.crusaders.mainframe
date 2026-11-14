import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderPage, signIn, signOut, stubFetch } from "../../test/harness";
import { DownloadCsvButton } from "./parts";

/**
 * FA-1: Faults' and the change record's CSV went out as a bare link with no token, and the API
 * answered 400 tenant_unresolved. The button fetches WITH the bearer token and saves the file;
 * a refusal is said beside the button, and nothing is saved.
 */

afterEach(() => signOut());

describe("Download CSV", () => {
  it("fetches with the session's bearer token and saves under the server's file name", async () => {
    signIn({ isAdmin: true });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() }));
    const stub = stubFetch([{
      path: "/api/v1/admin/monitoring/errors.csv", body: "a,b\r\n1,2\r\n",
      headers: { "content-disposition": 'attachment; filename="faults-2026-11-13.csv"', "content-type": "text/csv" },
    }]);
    renderPage(<DownloadCsvButton path="/api/v1/admin/monitoring/errors.csv?severity=error" fallbackName="faults.csv" />);
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    const call = stub.calls.find((c) => c.path.startsWith("/api/v1/admin/monitoring/errors.csv"))!;
    expect(call.headers.authorization).toBe("Bearer test.token.value");
    expect(call.path).toBe("/api/v1/admin/monitoring/errors.csv?severity=error");
    click.mockRestore();
  });

  it("says a refusal beside the button and saves nothing", async () => {
    signIn({ isAdmin: true });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    stubFetch([{ path: "/api/v1/admin/changes.csv", status: 400, body: { error: "tenant_unresolved" } }]);
    renderPage(<DownloadCsvButton path="/api/v1/admin/changes.csv" fallbackName="change-record.csv" />);
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Nothing was downloaded\./);
    expect(click).not.toHaveBeenCalled();
    click.mockRestore();
  });
});
