import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiError, api, endpoints, type AdminSettings } from "@/lib/api";
import { readCurrencySymbol } from "@/lib/currency";
import { SETTINGS_COPY } from "@/lib/settingsCopy";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { useAuth } from "@/lib/auth";
import {
  forgetSettingsDraft, keepSettingsDraft, keptSettingsDraft, noteSettingsDraftSessionEnded,
} from "@/lib/settingsDraftStore";
import { settingLabel } from "@/lib/settingsSchema";
import { DAY_KEYS, DAY_NAMES } from "@/lib/tenantSettings";
import {
  SaveNotConfirmed, SettingsChanged, carryEdits, changedKeys, conflictOf, reapplyMine, saveBody, saveFailureOf,
  withVersion, type SaveFailure, type SettingsConflict,
} from "./draft";

/**
 * The settings document: the copy last saved, the copy being edited, and the two calls.
 *
 * <p>
 * <b>A failed read is a failed read.</b> The page used to toast "Couldn't load settings." and then
 * say "Loading settings…" for ever — a spinner standing in for an answer. Now the error is kept and
 * rendered with a retry, and nothing is claimed about the club's settings meanwhile.
 * </p>
 *
 * <p>
 * <b>A save commits what was SENT.</b> The baseline moves to the exact object that went over the
 * wire, not to whatever the working copy is when the answer comes back — so an edit made while a
 * save was in flight stays unsaved, and the bar says so, rather than being silently counted as
 * saved.
 * </p>
 *
 * <p>
 * <b>The pair is one state</b> (review round 2, F3-4). A read that lands while there are unsaved
 * edits carries them onto it (`carryEdits`) instead of replacing them: a kept draft was restored,
 * then StrictMode's second read replaced the working copy and the mirror erased the draft.
 * </p>
 *
 * <p>
 * <b>A lost save reply is asked about</b> (F3-4): a 5xx or a dropped connection re-reads the club,
 * and the page says it saved, that it did not, or that it is not known — never "fix what is named"
 * over a request that may well have landed.
 * </p>
 *
 * <p>
 * <b>The body is the page's own</b> (`draft.wireBody`): every row the registry shows, spelled the
 * way the API binds it — see there for why not the shared mapper.
 * </p>
 */
type Doc = { saved: AdminSettings; draft: AdminSettings };

/** A fresh read, with any unsaved edits carried onto it. */
function withFresh(prev: Doc | null, fresh: AdminSettings): Doc {
  if (!prev || prev.draft === prev.saved) return { saved: fresh, draft: fresh };
  return { saved: fresh, draft: carryEdits(prev.saved, prev.draft, fresh).merged };
}

/** Whether the club now holds every change this save made. */
function landed(base: AdminSettings, sent: AdminSettings, fresh: AdminSettings): boolean {
  const differs = new Set(changedKeys(fresh, sent));
  return changedKeys(base, sent).every((key) => !differs.has(key));
}

/** A 409 `settings_changed` with the settings in force now, or null for any other failure. */
function staleSave(err: unknown): SettingsChanged | null {
  if (!(err instanceof ApiError) || err.status !== 409 || err.code !== "settings_changed") return null;
  const current = typeof err.payload === "object" && err.payload !== null
    ? (err.payload as { settings?: unknown }).settings : null;
  if (typeof current !== "object" || current === null) return null;
  return new SettingsChanged(withVersion(current as AdminSettings, err.detail("version")));
}

async function putSettings(sent: AdminSettings, base: AdminSettings): Promise<{ sent: AdminSettings; recovered: boolean }> {
  try {
    const reply = await api.put<{ saved: true; version?: string }>("/api/v1/admin/settings/", saveBody(base, sent));
    return { sent: withVersion(sent, reply?.version), recovered: false };
  } catch (err) {
    const stale = staleSave(err);
    if (stale) throw stale;
    // A 4xx is the club's answer (a refusal, or a session that ended); anything else may have landed.
    if (err instanceof ApiError && err.status < 500) throw err;
    let fresh: AdminSettings;
    try {
      fresh = await endpoints.adminSettingsGet();
    } catch {
      throw new SaveNotConfirmed("unknown");
    }
    if (landed(base, sent, fresh)) return { sent: withVersion(sent, (fresh as { version?: unknown }).version), recovered: true };
    throw new SaveNotConfirmed("not_saved");
  }
}

function useKeptDraft(doc: Doc | null, setDoc: (next: Doc) => void) {
  const auth = useAuth();
  const userId = auth.status === "authenticated" ? auth.userId : null;
  const [lookedFor, setLookedFor] = useState<string | null>(null);
  const [restored, setRestored] = useState<{ dropped: string[]; afterSignIn: boolean } | null>(null);

  // F3.15: edits kept across a sign-in come back — once per admin, before any edit, onto the
  // settings as they are now, key by key (`carryEdits`). Adjusted during render, React's pattern
  // for state derived from a change, so the mirror below never sees — and erases — the kept draft.
  if (userId && doc && doc.draft === doc.saved && lookedFor !== userId) {
    setLookedFor(userId);
    const kept = keptSettingsDraft(userId);
    if (kept) {
      const { merged, carried, dropped } = carryEdits(kept.basis, kept.draft, doc.saved);
      if (carried.length > 0) setDoc({ saved: doc.saved, draft: merged });
      if (carried.length > 0 || dropped.length > 0) setRestored({ dropped, afterSignIn: kept.afterSessionEnd === true });
    }
  }

  // Every edit is mirrored for this tab, so a session that ends mid-save does not take it along.
  // Runs only once the read has answered, so it never erases a kept draft before `load` reads it.
  useEffect(() => {
    if (!userId || !doc) return;
    if (doc.draft === doc.saved) forgetSettingsDraft(userId);
    else keepSettingsDraft(userId, doc.saved, doc.draft);
  }, [userId, doc]);

  return { restored, setRestored, userId };
}

export function useSettingsDocument() {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [error, setError] = useState<unknown>(null);
  /** When the settings were last read: a failed re-read keeps the page (and any draft), said as of then. */
  const [readAt, setReadAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<SaveFailure | null>(null);
  /** The sentence the save bar keeps on screen after a save, until the next edit (F3-4). */
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const { restored, setRestored, userId } = useKeptDraft(doc, setDoc);
  /** A4-1: somebody else saved since this page was read, and the save was refused as stale. */
  const [conflict, setConflict] = useState<SettingsConflict | null>(null);
  const docNow = useRef(doc);
  useLayoutEffect(() => { docNow.current = doc; });

  /** The stale save's answer: theirs becomes the baseline, this admin's other edits ride on it. */
  const takeConflict = (stale: SettingsChanged) => {
    const now = docNow.current;
    if (!now) return;
    const found = conflictOf(now.saved, now.draft, stale.current);
    if (found.ours) {
      // Our own earlier press had landed (its reply was lost): nothing of anybody else's is here.
      setDoc({ saved: stale.current, draft: found.merged });
      setSavedNote(SETTINGS_COPY.savedAfterLostReply);
      return;
    }
    setDoc({ saved: stale.current, draft: found.merged });
    setConflict(found);
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const settings = await endpoints.adminSettingsGet();
      setDoc((prev) => withFresh(prev, settings));
      setReadAt(Date.now());
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount loader; sync loading flag is the house idiom
  useEffect(() => { void load(); }, [load]);

  const save = useAsyncAction(putSettings, {
    success: ({ sent, recovered }) => {
      // The version rides on the working copy too, so an edit made after this save is sent over it.
      setDoc((prev) => (prev ? { saved: sent, draft: withVersion(prev.draft, (sent as { version?: unknown }).version) } : prev));
      setFailure(null);
      setConflict(null);
      setRestored(null);
      setSavedNote(recovered ? SETTINGS_COPY.savedAfterLostReply : SETTINGS_COPY.saved);
    },
    // F3.15: on the PAGE, not in a toast that fades — the sentence, the field it is about and
    // the next step. Through the shared device-error dictionary, so a code that HAS a sentence
    // gets it and a `<key>_out_of_range` names the field by its caption.
    failure: (err, sent) => {
      if (err instanceof SettingsChanged) {
        setFailure(null);
        takeConflict(err);
        return;
      }
      const failed = saveFailureOf(err, readCurrencySymbol(sent.currency_symbol));
      // The kept draft will next be seen after a sign-in, and may say so (R3 A-9).
      if (failed.sessionEnded && userId) noteSettingsDraftSessionEnded(userId);
      setFailure(failed);
    },
  });

  const update = useCallback((patch: Partial<AdminSettings>) => {
    setSavedNote(null);
    setDoc((current) => (current ? { ...current, draft: { ...current.draft, ...patch } } : current));
  }, []);

  /** "Put my values back" on the keys both admins changed; saving is still the admin's press. */
  const reapply = useCallback(() => {
    if (!conflict) return;
    setDoc((current) => (current ? { ...current, draft: reapplyMine(current.draft, conflict) } : current));
    setConflict(null);
  }, [conflict]);

  const discard = useCallback(() => {
    setDoc((current) => (current ? { ...current, draft: current.saved } : current));
    setConflict(null);
    setFailure(null);
    setRestored(null);
  }, [setRestored]);

  const currency = readCurrencySymbol(doc?.draft.currency_symbol);
  const labelOf = (key: string) => {
    const day = DAY_KEYS.findIndex((d) => key === `operating_hours_${d}`);
    return day >= 0 ? SETTINGS_COPY.dayHoursLabel(DAY_NAMES[DAY_KEYS[day]]) : settingLabel(key, currency);
  };
  const droppedLabels = (restored?.dropped ?? []).map(labelOf);
  const conflictWords = conflict
    ? { theirs: conflict.theirs.map(labelOf), kept: conflict.kept.length, clashed: conflict.clashed.map(labelOf) }
    : null;

  return {
    saved: doc?.saved ?? null,
    draft: doc?.draft ?? null,
    error, readAt, loading, load, update, discard, save, failure,
    restored: restored !== null,
    restoredAfterSignIn: restored?.afterSignIn === true,
    droppedLabels,
    savedNote,
    dismissSavedNote: () => setSavedNote(null),
    conflict: conflictWords,
    reapply,
    dismissConflict: () => setConflict(null),
  };
}
