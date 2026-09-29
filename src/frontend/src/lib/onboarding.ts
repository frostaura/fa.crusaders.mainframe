import { api, type MyProfile } from "./api";

/**
 * P8 — the member welcome wizard and the admin tour: the wire, the step order, the state
 * machine and the rule for when either is offered.
 *
 * <p>
 * <b>The server is the record; this device keeps a mirror.</b> Progress lives in
 * `user_preferences` (`GET /api/v1/me/preferences`, embedded in `/me/profile` as `preferences`),
 * and the three onboarding events have routes of their own — the server stamps "completed" and
 * "dismissed" with its own clock, so the PUT carries no onboarding fields at all
 * (`MePreferencesEndpoints.cs`). Every write is mirrored into `localStorage` first, per user,
 * so a member who finishes the wizard with no signal is not offered it again on the next
 * visit while the POST that failed is still owed. Storage that throws (private mode) costs the
 * mirror and nothing else.
 * </p>
 *
 * <p>
 * <b>Unknown is not "due".</b> A profile from an API that predates preferences, a read that
 * failed, or a session that is offline all answer `null`, and nothing is offered on `null`: a
 * wizard pushed at somebody because a read failed is a wizard pushed at somebody who finished
 * it last week.
 * </p>
 */

/** What `/me/preferences` answers — the onboarding half. The social flags are P11's. */
export type OnboardingPrefs = {
  member_onboarding_completed_at: string | null;
  member_onboarding_dismissed_at: string | null;
  member_onboarding_last_step: string | null;
  admin_onboarding_completed_at: string | null;
  /** The version the last COMPLETION stamped (member or admin — the server shares one column). */
  onboarding_version: number;
  /** The tour this build of the server ships. */
  current_onboarding_version: number;
};

/** The profile, as the API sends it now: it embeds the preferences object. */
export type ProfileWithPreferences = MyProfile & { preferences?: Partial<OnboardingPrefs> | null };

// --- the steps -------------------------------------------------------------------------

/**
 * Every step slot in order. A slot can be switched off here without renaming anything a
 * member's stored resume point names.
 *
 * <p>
 * <b>`privacy` is last (P11, D13).</b> Every social surface is opt-in and off by default —
 * findable in partner search, leaderboards — and the wizard is where a new member is first
 * asked. It comes after install because it is the one step that is a choice rather than a
 * setup task, and the last thing said before Finish is "these are off unless you say so".
 * </p>
 */
export const MEMBER_STEP_SLOTS = [
  { id: "welcome", enabled: true },
  { id: "code", enabled: true },
  { id: "passkey", enabled: true },
  { id: "fingerprint", enabled: true },
  { id: "topup", enabled: true },
  { id: "book", enabled: true },
  { id: "install", enabled: true },
  { id: "privacy", enabled: true },
] as const;

export type MemberStepId = (typeof MEMBER_STEP_SLOTS)[number]["id"];

/** The steps a member is actually walked through, in order. */
export function memberSteps(): MemberStepId[] {
  return MEMBER_STEP_SLOTS.filter((slot) => slot.enabled).map((slot) => slot.id);
}

export function isMemberStep(value: unknown): value is MemberStepId {
  return typeof value === "string" && memberSteps().includes(value as MemberStepId);
}

/**
 * Where the wizard opens.
 *
 * <p>
 * An explicit step (a checklist link naming one) wins; a replay starts at the beginning; an
 * ordinary visit resumes at the last step the member reached. A remembered step this build no
 * longer has — renamed, or a disabled slot — starts at the beginning rather than guessing.
 * </p>
 */
export function startingStep(input: { requested?: string | null; replay?: boolean; last?: string | null }): MemberStepId {
  const steps = memberSteps();
  if (isMemberStep(input.requested)) return input.requested;
  if (input.replay) return steps[0];
  if (isMemberStep(input.last)) return input.last;
  return steps[0];
}

// --- the state machine -----------------------------------------------------------------

/** `touched` — the member has moved at least once, so a late resume point must not yank them. */
export type WizardState = { steps: MemberStepId[]; index: number; touched: boolean };

export type WizardAction =
  | { type: "next" }
  | { type: "back" }
  | { type: "goto"; step: MemberStepId }
  /** The server's resume point, arriving after the page opened. Ignored once the member has moved. */
  | { type: "adopt"; step: MemberStepId };

export function initialWizard(step: MemberStepId): WizardState {
  const steps = memberSteps();
  return { steps, index: Math.max(0, steps.indexOf(step)), touched: false };
}

function moveTo(state: WizardState, index: number, touched: boolean): WizardState {
  if (index < 0 || index >= state.steps.length) return state;
  return index === state.index && state.touched === touched ? state : { ...state, index, touched };
}

/** Pure: next / back clamp at the ends, goto and adopt ignore a step that is not in the list. */
export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case "next":
      return moveTo(state, Math.min(state.index + 1, state.steps.length - 1), true);
    case "back":
      return moveTo(state, Math.max(state.index - 1, 0), true);
    case "goto":
      return moveTo(state, state.steps.indexOf(action.step), true);
    case "adopt":
      return state.touched ? state : moveTo(state, state.steps.indexOf(action.step), true);
  }
}

export function currentStep(state: WizardState): MemberStepId {
  return state.steps[state.index];
}

export function isLastStep(state: WizardState): boolean {
  return state.index === state.steps.length - 1;
}

// --- the local mirror ------------------------------------------------------------------

/** One user's mirror. Per user because the club desk tablet is a shared device. */
export type LocalOnboarding = {
  /** The tour version this device saw completed. */
  memberDoneVersion?: number;
  memberDismissedAt?: string;
  lastStep?: string;
  adminDoneAt?: string;
  /** The setup checklist was hidden on this device. There is no server field for it. */
  checklistHidden?: boolean;
  /** `appinstalled` fired on this device. */
  installed?: boolean;
};

export const ONBOARDING_STORAGE_KEY = "crusaders.onboarding";

function storage(kind: "local" | "session"): Storage | null {
  try {
    return kind === "local" ? window.localStorage ?? null : window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function readAll(): Record<string, LocalOnboarding> {
  try {
    const raw = storage("local")?.getItem(ONBOARDING_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, LocalOnboarding>) : {};
  } catch {
    return {};
  }
}

export function readLocalOnboarding(userId: string | null | undefined): LocalOnboarding {
  if (!userId) return {};
  const entry = readAll()[userId];
  return entry && typeof entry === "object" ? entry : {};
}

export function writeLocalOnboarding(userId: string | null | undefined, patch: Partial<LocalOnboarding>): LocalOnboarding {
  if (!userId) return {};
  const all = readAll();
  const next = { ...(all[userId] ?? {}), ...patch };
  try {
    storage("local")?.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({ ...all, [userId]: next }));
  } catch { /* the mirror is a convenience; the server is the record */ }
  return next;
}

// --- when each is offered --------------------------------------------------------------

/** Fills what an older or partial answer left out. `null` when there is nothing to read. */
export function normalisePrefs(raw: Partial<OnboardingPrefs> | null | undefined): OnboardingPrefs | null {
  if (!raw || typeof raw !== "object") return null;
  return {
    member_onboarding_completed_at: raw.member_onboarding_completed_at ?? null,
    member_onboarding_dismissed_at: raw.member_onboarding_dismissed_at ?? null,
    member_onboarding_last_step: raw.member_onboarding_last_step ?? null,
    admin_onboarding_completed_at: raw.admin_onboarding_completed_at ?? null,
    onboarding_version: typeof raw.onboarding_version === "number" ? raw.onboarding_version : 1,
    current_onboarding_version: typeof raw.current_onboarding_version === "number" ? raw.current_onboarding_version : 1,
  };
}

/**
 * Whether the member wizard is owed: `true`, `false`, or `null` for "cannot tell".
 *
 * <p>
 * A completion counts only for the version it stamped — a member who finished an older tour is
 * offered the new one. A dismissal counts whatever the version, because the server does not
 * record which tour was dismissed and "not now" is not a request to be asked again. Either
 * event on this device's mirror counts as well, so an offline finish is not undone by a stale
 * read.
 * </p>
 */
export function memberTourDue(prefs: OnboardingPrefs | null, local: LocalOnboarding = {}): boolean | null {
  if (!prefs) return null;
  const version = prefs.current_onboarding_version;
  if ((local.memberDoneVersion ?? 0) >= version || local.memberDismissedAt) return false;
  if (prefs.member_onboarding_dismissed_at) return false;
  if (prefs.member_onboarding_completed_at && prefs.onboarding_version >= version) return false;
  return true;
}

/** Whether the admin tour is owed. `null` when nothing was read. */
export function adminTourDue(prefs: OnboardingPrefs | null, local: LocalOnboarding = {}): boolean | null {
  if (!prefs) return null;
  return !prefs.admin_onboarding_completed_at && !local.adminDoneAt;
}

/**
 * The first-run gate's whole decision, pure so it can be tested without a router.
 *
 * <p>
 * Only an ACTIVE member, only on the landing, only once per signed-in tab, only when the
 * wizard is known to be owed — and never while the session is offline or gated on a password
 * change. The landing is the only screen a member did not choose: sending somebody to a wizard
 * from a page they deliberately opened is taking them away from a task.
 * </p>
 *
 * <p>
 * <b>And only on the landing a sign-in just delivered them to (F4.8).</b> The landing is My
 * Code, which is also the installed app's start URL and what a member opens at a locked door —
 * and "Step 1 of 8" there is a member who cannot get in. Opening `/my-code` directly (the app,
 * a bookmark, a link) is never interrupted; the page's setup checklist offers the wizard instead.
 * </p>
 */
export function shouldOfferWizard(input: {
  signedIn: boolean;
  mustChangePassword: boolean;
  pathname: string;
  landing: string;
  /** The landing was reached by a sign-in's own navigation (router state `signedIn`). */
  arrivedFromSignIn: boolean;
  status: string | null | undefined;
  due: boolean | null;
  alreadyOffered: boolean;
}): boolean {
  if (!input.signedIn || input.mustChangePassword) return false;
  if (input.pathname !== input.landing || !input.arrivedFromSignIn) return false;
  if ((input.status ?? "").toLowerCase() !== "active") return false;
  return input.due === true && !input.alreadyOffered;
}

/** Router state a sign-in navigates with, so the gate can tell a fresh arrival from a door visit. */
export const SIGNED_IN_ARRIVAL = { signedIn: true } as const;

export function arrivedFromSignIn(state: unknown): boolean {
  return !!state && typeof state === "object" && (state as { signedIn?: unknown }).signedIn === true;
}

/** "Offered in this tab already" — session storage, per user, so a new sign-in is a new session. */
const OFFERED_KEY = "crusaders.onboarding.offered";

export function wasOffered(userId: string | null | undefined): boolean {
  try {
    return Boolean(userId) && storage("session")?.getItem(OFFERED_KEY) === userId;
  } catch {
    return false;
  }
}

export function markOffered(userId: string | null | undefined): void {
  if (!userId) return;
  try { storage("session")?.setItem(OFFERED_KEY, userId); } catch { /* offered once per render instead */ }
}

// --- the wire --------------------------------------------------------------------------

export const onboardingEndpoints = {
  preferences: () => api.get<Partial<OnboardingPrefs>>("/api/v1/me/preferences"),
  /** 400 `invalid_step` for anything but a short slug — the step ids here all are. */
  saveStep: (step: MemberStepId) => api.put<Partial<OnboardingPrefs>>("/api/v1/me/onboarding/member/step", { step }),
  completeMember: () => api.post<Partial<OnboardingPrefs>>("/api/v1/me/onboarding/member/complete"),
  dismissMember: () => api.post<Partial<OnboardingPrefs>>("/api/v1/me/onboarding/member/dismiss"),
  /** 403 `admin_only` for a member — there is no admin tour for them to finish. */
  completeAdmin: () => api.post<Partial<OnboardingPrefs>>("/api/v1/me/onboarding/admin/complete"),
};
