import { describe, expect, it } from "vitest";
import { walletLabel } from "./Layout";

/**
 * The wallet chip's accessible name.
 *
 * <p>
 * It was <code>aria-label="Wallet balance"</code>. An <code>aria-label</code> REPLACES an
 * element's contents as its accessible name, so a screen reader announced "Wallet balance,
 * link" and the number — the entire reason the chip is in the chrome, and the only thing in
 * the chrome that says whether a member can afford to book — was never read out. Not quietly,
 * not abbreviated: absent.
 * </p>
 *
 * <p>
 * The low-balance state has the same shape of problem. It is carried by the chip turning
 * amber, and a colour is not an announcement.
 * </p>
 */
describe("the wallet chip says the balance out loud", () => {
  it("names the amount, not just the concept", () => {
    expect(walletLabel(472, false)).toContain("472.00");
  });

  it("says 'credits', because 'cr' is read as two letters", () => {
    expect(walletLabel(472, false)).toContain("472.00 credits");
    expect(walletLabel(472, false)).not.toMatch(/\bcr\b/);
  });

  it("announces the low-balance state that is otherwise only a colour", () => {
    expect(walletLabel(12.5, false)).toContain("12.50 credits");
    expect(walletLabel(12.5, false)).toMatch(/running low/i);
  });

  it("does not cry wolf at the threshold", () => {
    expect(walletLabel(50, false)).not.toMatch(/running low/i);
    expect(walletLabel(49.99, false)).toMatch(/running low/i);
  });

  it("distinguishes 'still loading' from 'could not be read'", () => {
    // The visible chip shows "— cr" for both, which is the same ambiguity one layer down.
    expect(walletLabel(null, true)).toMatch(/loading/i);
    expect(walletLabel(null, false)).toMatch(/unavailable/i);
    expect(walletLabel(null, false)).not.toMatch(/loading/i);
  });

  it("says what pressing it does, since the chip carries no other text", () => {
    expect(walletLabel(472, false)).toMatch(/top up/i);
  });

  it("reads a zero balance as a number rather than falling through to unavailable", () => {
    // `balance || "unavailable"` would be the natural bug here, and zero is the balance a
    // member most needs to hear.
    expect(walletLabel(0, false)).toContain("0.00 credits");
    expect(walletLabel(0, false)).toMatch(/running low/i);
  });
});
