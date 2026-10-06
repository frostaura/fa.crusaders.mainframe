import { useCallback, useState } from "react";
import { playersEndpoints, type SocialPrefs } from "@/lib/playersApi";
import { ApiError } from "@/lib/api";
import { describeFailure } from "@/lib/errors";
import { unsureSentence, writeOrReadBack, type UnsureWords } from "@/lib/lostReply";
import { PLAYERS_UNSURE, PRIVACY_COPY as COPY } from "@/lib/playersCopy";
import { useRead, type Read } from "@/lib/useRead";

/**
 * The D13 switches shown, in order. "Show me on leaderboards" is HIDDEN until leaderboards exist
 * (R1, F4): a switch for something the club does not have yet reads as a broken promise. Its
 * stored value is left exactly as it is — never shown, never sent — so a member's earlier choice
 * survives until the switch returns (add it back here).
 */
export type PrivacyKey = keyof SocialPrefs;
export const PRIVACY_KEYS: readonly PrivacyKey[] = ["findable"];

export const PRIVACY_LABEL: Record<PrivacyKey, { label: string; hint: string }> = {
  findable: { label: COPY.findableLabel, hint: COPY.findableHint },
  show_in_leaderboards: { label: COPY.leaderboardsLabel, hint: COPY.leaderboardsHint },
};

export type PrivacyPrefs = {
  read: Read<Partial<SocialPrefs>>;
  retry: () => void;
  /** What the switch shows: the member's own flip first, then the server's, then OFF. */
  value: (key: PrivacyKey) => boolean;
  pending: (key: PrivacyKey) => boolean;
  /** The sentence for a flip that did not land, until the next flip. */
  error: (key: PrivacyKey) => string | null;
  set: (key: PrivacyKey, on: boolean) => Promise<void>;
};

/**
 * The words for a privacy write that each cause has (R18 X18-1, R19 X19-1.4): after a look that
 * found nothing changed, and after a look that failed — for silence, a clash, a busy club and the
 * club's system answering with an error (R19 X19-2: a plain 500 is an answer, not silence).
 * Said through `unsureSentence`, so a cause `lostReply` learns is worded there, never dropped here.
 */
function privacyWords(label: string): UnsureWords {
  return {
    checked: COPY.saveFailed(label),
    unchecked: PLAYERS_UNSURE.privacy(label),
    busy: { checked: COPY.saveBusy(label), unchecked: PLAYERS_UNSURE.privacyBusy(label) },
    conflict: { checked: COPY.saveConflict(label), unchecked: PLAYERS_UNSURE.privacyConflict(label) },
    error: { checked: COPY.saveError(label), unchecked: PLAYERS_UNSURE.privacyError(label) },
  };
}

/**
 * Why a flip went back. An unknown outcome is said by its cause (R19 X19-1.4 — a busy club, read back
 * unchanged, said a bare "Try again" into a club that had just said it was busy); a rate limit says
 * the wait the club gave; any other refusal keeps the plain sentence.
 */
function flipFailure(error: unknown, label: string): string {
  const unsure = unsureSentence(error, privacyWords(label));
  if (unsure) return unsure;
  if (error instanceof ApiError && error.status === 429) return COPY.saveRefused(label, describeFailure(error));
  return COPY.saveFailed(label);
}

/**
 * The member's own social switches (D13), read from and written to `/me/preferences`.
 *
 * <p>
 * <b>Off unless the server says on.</b> A missing field, an older API or a read still in
 * flight all read as OFF — an opt-in that defaults on because we could not ask is not an opt-in.
 * </p>
 *
 * <p>
 * <b>Optimistic, with the rollback said.</b> A flip shows at once and is written as a one-field
 * PUT (the endpoint patches; an absent field is left alone). A refusal puts the switch back and
 * leaves a sentence beside it — a switch that silently jumps back reads as a broken switch.
 * The member's own flip is kept after a success so a re-read racing the write cannot undo it.
 * </p>
 */
export function usePrivacyPrefs(): PrivacyPrefs {
  const [read, retry] = useRead("social-prefs", playersEndpoints.socialPrefs);
  const [wanted, setWanted] = useState<Partial<SocialPrefs>>({});
  const [busy, setBusy] = useState<ReadonlySet<PrivacyKey>>(new Set());
  const [errors, setErrors] = useState<Partial<Record<PrivacyKey, string>>>({});

  const value = useCallback(
    (key: PrivacyKey) => wanted[key] ?? read.data?.[key] === true,
    [wanted, read.data],
  );

  const mark = (key: PrivacyKey, on: boolean) => setBusy((current) => {
    const next = new Set(current);
    if (on) next.add(key); else next.delete(key);
    return next;
  });

  const set = async (key: PrivacyKey, on: boolean) => {
    if (busy.has(key)) return;
    const before = wanted[key];
    setWanted((current) => ({ ...current, [key]: on }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    mark(key, true);
    try {
      // Lost-reply audit (R3): a lost reply is read back — a switch that did save stays on.
      await writeOrReadBack(
        () => playersEndpoints.saveSocialPrefs({ [key]: on }),
        async () => ((await playersEndpoints.socialPrefs())[key] === on ? { [key]: on } : null),
      );
    } catch (error) {
      setWanted((current) => ({ ...current, [key]: before }));
      setErrors((current) => ({ ...current, [key]: flipFailure(error, PRIVACY_LABEL[key].label) }));
    } finally {
      mark(key, false);
    }
  };

  return {
    read,
    retry,
    value,
    pending: (key) => busy.has(key),
    error: (key) => errors[key] ?? null,
    set,
  };
}
