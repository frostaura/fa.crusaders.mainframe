import { useCallback, useEffect, useState } from "react";
import { ApiError, api, endpoints, type AdminSettings } from "@/lib/api";
import { readCurrencySymbol } from "@/lib/currency";
import { SETTINGS_COPY } from "@/lib/settingsCopy";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { useAuth } from "@/lib/auth";
import { forgetSettingsDraft, keepSettingsDraft, keptSettingsDraft } from "@/lib/settingsDraftStore";
import { settingLabel } from "@/lib/settingsSchema";
import { DAY_KEYS, DAY_NAMES } from "@/lib/tenantSettings";
import {
  SaveNotConfirmed, carryEdits, changedKeys, saveFailureOf, savePayload, wireBody, type SaveFailure,
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

async function putSettings(sent: AdminSettings, base: AdminSettings): Promise<{ sent: AdminSettings; recovered: boolean }> {
  try {
    await api.put<{ saved: true }>("/api/v1/admin/settings/", wireBody(savePayload(sent)));
    return { sent, recovered: false };
  } catch (err) {
    // A 4xx is the club's answer (a refusal, or a session that ended); anything else may have landed.
    if (err instanceof ApiError && err.status < 500) throw err;
    let fresh: AdminSettings;
    try {
      fresh = await endpoints.adminSettingsGet();
    } catch {
      throw new SaveNotConfirmed("unknown");
    }
    if (landed(base, sent, fresh)) return { sent, recovered: true };
    throw new SaveNotConfirmed("not_saved");
  }
}

function useKeptDraft(doc: Doc | null, setDoc: (next: Doc) => void) {
  const auth = useAuth();
  const userId = auth.status === "authenticated" ? auth.userId : null;
  const [lookedFor, setLookedFor] = useState<string | null>(null);
  const [restored, setRestored] = useState<{ dropped: string[] } | null>(null);

  // F3.15: edits kept across a sign-in come back — once per admin, before any edit, onto the
  // settings as they are now, key by key (`carryEdits`). Adjusted during render, React's pattern
  // for state derived from a change, so the mirror below never sees — and erases — the kept draft.
  if (userId && doc && doc.draft === doc.saved && lookedFor !== userId) {
    setLookedFor(userId);
    const kept = keptSettingsDraft(userId);
    if (kept) {
      const { merged, carried, dropped } = carryEdits(kept.basis, kept.draft, doc.saved);
      if (carried.length > 0) setDoc({ saved: doc.saved, draft: merged });
      if (carried.length > 0 || dropped.length > 0) setRestored({ dropped });
    }
  }

  // Every edit is mirrored for this tab, so a session that ends mid-save does not take it along.
  // Runs only once the read has answered, so it never erases a kept draft before `load` reads it.
  useEffect(() => {
    if (!userId || !doc) return;
    if (doc.draft === doc.saved) forgetSettingsDraft(userId);
    else keepSettingsDraft(userId, doc.saved, doc.draft);
  }, [userId, doc]);

  return { restored, setRestored };
}

export function useSettingsDocument() {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<SaveFailure | null>(null);
  /** The sentence the save bar keeps on screen after a save, until the next edit (F3-4). */
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const { restored, setRestored } = useKeptDraft(doc, setDoc);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const settings = await endpoints.adminSettingsGet();
      setDoc((prev) => withFresh(prev, settings));
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
      setDoc((prev) => (prev ? { saved: sent, draft: prev.draft } : prev));
      setFailure(null);
      setRestored(null);
      setSavedNote(recovered ? SETTINGS_COPY.savedAfterLostReply : SETTINGS_COPY.saved);
    },
    // F3.15: on the PAGE, not in a toast that fades — the sentence, the field it is about and
    // the next step. Through the shared device-error dictionary, so a code that HAS a sentence
    // gets it and a `<key>_out_of_range` names the field by its caption.
    failure: (err, sent) => setFailure(saveFailureOf(err, readCurrencySymbol(sent.currency_symbol))),
  });

  const update = useCallback((patch: Partial<AdminSettings>) => {
    setSavedNote(null);
    setDoc((current) => (current ? { ...current, draft: { ...current.draft, ...patch } } : current));
  }, []);

  const discard = useCallback(() => {
    setDoc((current) => (current ? { ...current, draft: current.saved } : current));
    setFailure(null);
    setRestored(null);
  }, [setRestored]);

  const currency = readCurrencySymbol(doc?.draft.currency_symbol);
  const droppedLabels = (restored?.dropped ?? []).map((key) => {
    const day = DAY_KEYS.findIndex((d) => key === `operating_hours_${d}`);
    return day >= 0 ? SETTINGS_COPY.dayHoursLabel(DAY_NAMES[DAY_KEYS[day]]) : settingLabel(key, currency);
  });

  return {
    saved: doc?.saved ?? null,
    draft: doc?.draft ?? null,
    error, loading, load, update, discard, save, failure,
    restored: restored !== null,
    droppedLabels,
    savedNote,
    dismissSavedNote: () => setSavedNote(null),
  };
}
