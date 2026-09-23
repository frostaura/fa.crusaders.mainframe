import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useAuth } from "@/lib/auth";
import { useProfile } from "@/lib/profile";
import {
  adminTourDue, memberTourDue, normalisePrefs, onboardingEndpoints, readLocalOnboarding, writeLocalOnboarding,
  type LocalOnboarding, type MemberStepId, type OnboardingPrefs, type ProfileWithPreferences,
} from "@/lib/onboarding";

/**
 * The onboarding record as every surface sees it — the wizard, the first-run gate, the setup
 * checklist and the admin tour.
 *
 * <p>
 * <b>One source, three layers.</b> The profile's embedded `preferences` is the first paint;
 * the answer to any onboarding write replaces it (each route answers the whole view); and the
 * device mirror is folded in by `memberTourDue` / `adminTourDue`. The write answers live in a
 * tiny module store rather than in each caller's state, so the wizard finishing is seen by the
 * checklist on the page it returns to without a second read of the profile.
 * </p>
 */

type Snapshot = { userId: string | null; prefs: Partial<OnboardingPrefs> | null; tick: number };

let snapshot: Snapshot = { userId: null, prefs: null, tick: 0 };
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(next: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...next, tick: snapshot.tick + 1 };
  listeners.forEach((listener) => listener());
}

/** For tests: forget every answer this module has held. */
export function resetOnboardingStore() {
  snapshot = { userId: null, prefs: null, tick: 0 };
}

export type Onboarding = {
  userId: string | null;
  /** Null when nothing has been read — an older API, or no profile yet. */
  prefs: OnboardingPrefs | null;
  local: LocalOnboarding;
  memberDue: boolean | null;
  adminDue: boolean | null;
  saveStep: (step: MemberStepId) => void;
  complete: () => Promise<void>;
  dismiss: () => Promise<void>;
  completeAdmin: () => Promise<void>;
  hideChecklist: () => void;
  markInstalled: () => void;
};

/**
 * The profile, or null outside a `ProfileProvider`. The admin frame and My Code are mounted
 * bare by their own tests; a nudge must not be the thing that makes a page throw.
 */
export function useProfileOrNull() {
  try {
    return useProfile().profile;
  } catch {
    return null;
  }
}

export function useOnboarding(): Onboarding {
  const auth = useAuth();
  const profile = useProfileOrNull();
  const userId = auth.status === "authenticated" ? auth.userId : null;
  const snap = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);

  const embedded = (profile as ProfileWithPreferences | null)?.preferences ?? null;
  const answered = snap.userId === userId ? snap.prefs : null;
  const prefs = useMemo(
    () => normalisePrefs(answered ? { ...(embedded ?? {}), ...answered } : embedded),
    [answered, embedded],
  );
  // Read on every store tick: the mirror is a few bytes of JSON, and a stale copy is how a
  // finished wizard gets offered again from the same device.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `snap.tick` is the invalidation signal
  const local = useMemo(() => readLocalOnboarding(userId), [userId, snap.tick]);

  const accept = useCallback((view: Partial<OnboardingPrefs> | null | undefined) => {
    if (view && typeof view === "object") publish({ userId, prefs: { ...(snapshot.userId === userId ? snapshot.prefs : {}), ...view } });
  }, [userId]);

  const mirror = useCallback((patch: Partial<LocalOnboarding>) => {
    writeLocalOnboarding(userId, patch);
    publish({});
  }, [userId]);

  const saveStep = useCallback((step: MemberStepId) => {
    mirror({ lastStep: step });
    // Fire and forget: a step the server did not hear about costs a resume point, not the tour.
    onboardingEndpoints.saveStep(step).then(accept, () => undefined);
  }, [accept, mirror]);

  const complete = useCallback(async () => {
    mirror({ memberDoneVersion: prefs?.current_onboarding_version ?? 1 });
    accept(await onboardingEndpoints.completeMember());
  }, [accept, mirror, prefs?.current_onboarding_version]);

  const dismiss = useCallback(async () => {
    mirror({ memberDismissedAt: new Date().toISOString() });
    accept(await onboardingEndpoints.dismissMember());
  }, [accept, mirror]);

  const completeAdmin = useCallback(async () => {
    mirror({ adminDoneAt: new Date().toISOString() });
    accept(await onboardingEndpoints.completeAdmin());
  }, [accept, mirror]);

  const hideChecklist = useCallback(() => mirror({ checklistHidden: true }), [mirror]);
  const markInstalled = useCallback(() => mirror({ installed: true }), [mirror]);

  return {
    userId,
    prefs,
    local,
    memberDue: memberTourDue(prefs, local),
    adminDue: adminTourDue(prefs, local),
    saveStep,
    complete,
    dismiss,
    completeAdmin,
    hideChecklist,
    markInstalled,
  };
}
