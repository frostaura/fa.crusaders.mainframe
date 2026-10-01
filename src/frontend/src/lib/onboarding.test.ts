import { afterEach, describe, expect, it } from "vitest";
import {
  adminTourDue, currentStep, initialWizard, isLastStep, memberSteps, memberTourDue, normalisePrefs,
  ONBOARDING_STORAGE_KEY, readLocalOnboarding, shouldOfferWizard, startingStep, wasOffered, markOffered,
  wizardReducer, writeLocalOnboarding, type OnboardingPrefs,
} from "./onboarding";
import { installRoute, isIos } from "./installPrompt";
import { CODE_KEEPS_CHANGING, GET_STARTED, guideSteps, whatsNextSteps } from "./onboardingCopy";

/**
 * P8 — the rules the wizard, the gate and the tour stand on, without a DOM.
 *
 * <p>
 * The mutants worth killing: a failed read treated as "owed" (the wizard pushed at somebody who
 * finished it), a completion counted for a newer tour than it stamped, a dismissal ignored,
 * a gate that fires off the landing, and a late resume point yanking a member who has moved.
 * </p>
 */

const FRESH: OnboardingPrefs = {
  member_onboarding_completed_at: null,
  member_onboarding_dismissed_at: null,
  member_onboarding_last_step: null,
  admin_onboarding_completed_at: null,
  onboarding_version: 1,
  current_onboarding_version: 1,
};

afterEach(() => {
  window.localStorage.removeItem(ONBOARDING_STORAGE_KEY);
  window.sessionStorage.clear();
});

describe("the step list", () => {
  it("walks the eight steps in order, with the privacy choice last (P11, D13)", () => {
    expect(memberSteps()).toEqual(["welcome", "code", "passkey", "buy", "book", "install", "privacy"]);
  });

  it("has a title for every step it walks", () => {
    for (const step of memberSteps()) {
      expect(GET_STARTED.steps[step as keyof typeof GET_STARTED.steps].title.length).toBeGreaterThan(3);
    }
  });
});

describe("where the wizard opens", () => {
  it("resumes at the last step reached", () => {
    expect(startingStep({ last: "buy" })).toBe("buy");
    // P13: a resume point an older build stored as "topup" opens the step that replaced it.
    expect(startingStep({ last: "topup" })).toBe("buy");
    expect(startingStep({ requested: "topup" })).toBe("buy");
    // Only a real rename is mapped: an unknown id, or a prototype key, starts at the beginning.
    expect(startingStep({ last: "constructor" })).toBe("welcome");
  });

  it("opens at a step a link names, over the resume point", () => {
    expect(startingStep({ requested: "install", last: "buy" })).toBe("install");
  });

  it("starts from the beginning on a replay", () => {
    expect(startingStep({ replay: true, last: "buy" })).toBe("welcome");
  });

  it("resumes at the privacy step now that it is walked", () => {
    expect(startingStep({ last: "privacy" })).toBe("privacy");
  });

  it.each([["an unknown step", "nope"], ["nothing", null]])(
    "starts from the beginning for %s",
    (_why, last) => {
      expect(startingStep({ last })).toBe("welcome");
    },
  );
});

describe("the wizard's state machine", () => {
  it("moves forward and back and clamps at both ends", () => {
    let state = initialWizard("welcome");
    state = wizardReducer(state, { type: "back" });
    expect(currentStep(state)).toBe("welcome");
    state = wizardReducer(state, { type: "next" });
    expect(currentStep(state)).toBe("code");
    for (let i = 0; i < 20; i++) state = wizardReducer(state, { type: "next" });
    expect(currentStep(state)).toBe("privacy");
    expect(isLastStep(state)).toBe(true);
    state = wizardReducer(state, { type: "back" });
    expect(currentStep(state)).toBe("install");
  });

  it("ignores a goto for a step it does not walk", () => {
    const state = initialWizard("code");
    expect(wizardReducer(state, { type: "goto", step: "nope" as never })).toBe(state);
  });

  it("adopts a late resume point only while the member has not moved", () => {
    const fresh = initialWizard("welcome");
    expect(currentStep(wizardReducer(fresh, { type: "adopt", step: "book" }))).toBe("book");

    const moved = wizardReducer(fresh, { type: "next" });
    expect(currentStep(wizardReducer(moved, { type: "adopt", step: "book" }))).toBe("code");
  });

  it("marks the member as having moved, which is what lets the step be saved", () => {
    expect(initialWizard("welcome").touched).toBe(false);
    expect(wizardReducer(initialWizard("welcome"), { type: "next" }).touched).toBe(true);
  });
});

describe("whether the member wizard is owed", () => {
  it("cannot tell with nothing read, and says so", () => {
    expect(memberTourDue(null)).toBeNull();
    expect(memberTourDue(normalisePrefs(undefined))).toBeNull();
  });

  it("is owed to a member who has done nothing", () => {
    expect(memberTourDue(FRESH)).toBe(true);
  });

  it("is not owed once completed at the current version", () => {
    expect(memberTourDue({ ...FRESH, member_onboarding_completed_at: "2026-09-01T10:00:00Z" })).toBe(false);
  });

  it("is owed again when the club ships a newer tour than the one completed", () => {
    expect(memberTourDue({
      ...FRESH, member_onboarding_completed_at: "2026-09-01T10:00:00Z", onboarding_version: 1, current_onboarding_version: 2,
    })).toBe(true);
  });

  it("is not owed after a dismissal, whatever the version", () => {
    expect(memberTourDue({ ...FRESH, member_onboarding_dismissed_at: "2026-09-01T10:00:00Z", current_onboarding_version: 3 })).toBe(false);
  });

  it("honours this device's mirror when the server has not heard yet", () => {
    expect(memberTourDue(FRESH, { memberDoneVersion: 1 })).toBe(false);
    expect(memberTourDue(FRESH, { memberDismissedAt: "2026-09-01T10:00:00Z" })).toBe(false);
    // …but a mirror of an OLDER tour does not cover a newer one.
    expect(memberTourDue({ ...FRESH, current_onboarding_version: 2 }, { memberDoneVersion: 1 })).toBe(true);
  });

  it("fills an older API's missing fields rather than reading them as owed", () => {
    expect(normalisePrefs({ member_onboarding_completed_at: "2026-09-01T10:00:00Z" })).toMatchObject({
      onboarding_version: 1, current_onboarding_version: 1,
    });
  });
});

describe("whether the admin tour is owed", () => {
  it("cannot tell with nothing read", () => {
    expect(adminTourDue(null)).toBeNull();
  });

  it("is owed until the admin completes it, here or on the server", () => {
    expect(adminTourDue(FRESH)).toBe(true);
    expect(adminTourDue({ ...FRESH, admin_onboarding_completed_at: "2026-09-01T10:00:00Z" })).toBe(false);
    expect(adminTourDue(FRESH, { adminDoneAt: "2026-09-01T10:00:00Z" })).toBe(false);
  });
});

describe("the first-run gate", () => {
  const base = {
    signedIn: true, mustChangePassword: false, pathname: "/my-code", landing: "/my-code", arrivedFromSignIn: true,
    status: "active", due: true as boolean | null, alreadyOffered: false,
  };

  it("offers the wizard to an active member arriving at the landing with it owed", () => {
    expect(shouldOfferWizard(base)).toBe(true);
  });

  it.each([
    ["on any other route", { pathname: "/bookings" }],
    // F4.8 — My Code opened directly is a member at a door, not a first arrival.
    ["on a landing nobody signed in to reach", { arrivedFromSignIn: false }],
    ["on an admin route mid-task", { pathname: "/admin/members" }],
    ["when already offered in this tab", { alreadyOffered: true }],
    ["when it cannot tell", { due: null }],
    ["when it is not owed", { due: false }],
    ["to a member awaiting approval", { status: "pendingapproval" }],
    ["to an account with no membership", { status: null }],
    ["on a password-change session", { mustChangePassword: true }],
    ["when signed out or offline", { signedIn: false }],
  ])("does nothing %s", (_why, over) => {
    expect(shouldOfferWizard({ ...base, ...over })).toBe(false);
  });

  it("remembers the offer per user, for this tab only", () => {
    expect(wasOffered("u1")).toBe(false);
    markOffered("u1");
    expect(wasOffered("u1")).toBe(true);
    expect(wasOffered("u2")).toBe(false);
    expect(window.localStorage.getItem("crusaders.onboarding.offered")).toBeNull();
  });
});

describe("the device mirror", () => {
  it("keeps each user's record apart on a shared device", () => {
    writeLocalOnboarding("a", { lastStep: "buy" });
    writeLocalOnboarding("b", { lastStep: "code" });
    expect(readLocalOnboarding("a").lastStep).toBe("buy");
    expect(readLocalOnboarding("b").lastStep).toBe("code");
    expect(readLocalOnboarding(null)).toEqual({});
  });

  it("survives storage it cannot parse", () => {
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, "{not json");
    expect(readLocalOnboarding("a")).toEqual({});
  });
});

describe("the install step's four answers", () => {
  const none = { standalone: false, installed: false, canPrompt: false, ios: false };

  it("says installed when it is running as the app, or installed here", () => {
    expect(installRoute({ ...none, standalone: true, canPrompt: true })).toBe("installed");
    expect(installRoute({ ...none, installed: true })).toBe("installed");
  });

  it("offers the browser's own prompt when there is one", () => {
    expect(installRoute({ ...none, canPrompt: true, ios: true })).toBe("prompt");
  });

  it("gives iPhone instructions in words, and admits a browser that can do neither", () => {
    expect(installRoute({ ...none, ios: true })).toBe("ios");
    expect(installRoute(none)).toBe("browser");
  });

  it("recognises an iPad that says it is a Mac", () => {
    expect(isIos("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", 5)).toBe(true);
    expect(isIos("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5)).toBe(true);
    expect(isIos("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0)).toBe(false);
  });
});

/**
 * R3 M-4 — the guide and the after-booking card say nothing a layout or a club setting can make
 * false: the code's step is a club setting (30 s, not "every minute"), and My Code is in a bottom
 * tab bar on a phone (not "the menu at the top").
 */
describe("the code's words are layout- and setting-neutral (R3 M-4)", () => {
  const all = [
    ...guideSteps({ doors: "yes" }).flatMap((s) => s.body),
    ...whatsNextSteps({ courtNumber: 1, day: "Wed 30 Sep", startsClock: "18:00", endsClock: "18:15" }, { doors: "yes" }),
  ].join(" ");

  it("names no period for the code and no place for the menu", () => {
    expect(all).not.toMatch(/every (minute|\d+ seconds?)/i);
    expect(all).not.toMatch(/menu at the (top|bottom)|(top|bottom) menu/i);
    expect(all).toContain(CODE_KEEPS_CHANGING);
  });
});
