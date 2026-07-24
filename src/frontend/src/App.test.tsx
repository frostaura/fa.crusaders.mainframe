import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import App from "./App";

describe("App", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ tenant_slug: "crusaders", tenant_id: "00000000-0000-0000-0000-000000000000", user_id: null, is_authenticated: false, is_admin: false })),
        } as unknown as Response)
      )
    );
    localStorage.clear();
  });

  it("renders the home heading for an anonymous visitor", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: /Crusaders Mainframe/i })).toBeInTheDocument();
  });
});
