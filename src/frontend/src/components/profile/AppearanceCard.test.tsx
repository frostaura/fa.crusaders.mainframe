import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AppearanceCard } from "./AppearanceCard";
import { AuthContext, type AuthCtx } from "@/lib/useAuth";
import { STYLE_ELEMENT_ID } from "@/lib/themeOverrides";
import { APPEARANCE_COPY } from "@/lib/appearanceCopy";

const auth = { status: "authenticated", userId: "u1", isAdmin: false, mustChangePassword: false } as unknown as AuthCtx;

function setup() {
  return render(<AuthContext.Provider value={auth}><AppearanceCard /></AuthContext.Provider>);
}

describe("AppearanceCard", () => {
  beforeEach(() => { window.localStorage.clear(); document.getElementById(STYLE_ELEMENT_ID)?.remove(); });

  it("paints a chosen colour at once and offers a reset", () => {
    setup();
    fireEvent.click(screen.getByText(APPEARANCE_COPY.light));
    fireEvent.change(screen.getByLabelText(new RegExp(APPEARANCE_COPY.accentLabel)), { target: { value: "#6d28d9" } });
    expect(document.getElementById(STYLE_ELEMENT_ID)?.textContent).toContain("--color-primary:109 40 217");
    fireEvent.click(screen.getByText(APPEARANCE_COPY.resetAll));
    expect(document.getElementById(STYLE_ELEMENT_ID)).toBeNull();
  });

  it("says why a colour was not applied", () => {
    setup();
    fireEvent.click(screen.getByText(APPEARANCE_COPY.light));
    fireEvent.change(screen.getByLabelText(new RegExp(APPEARANCE_COPY.accentLabel)), { target: { value: "#ffeb3b" } });
    expect(screen.getByRole("status")).toHaveTextContent(APPEARANCE_COPY.refusedHeading);
    expect(document.getElementById(STYLE_ELEMENT_ID)).toBeNull();
  });
});
