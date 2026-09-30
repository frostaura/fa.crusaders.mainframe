import { useCallback, useEffect, useState } from "react";
import { useToast } from "@/components/Toast";
import { api, endpoints, type AdminSettings } from "@/lib/api";
import { readCurrencySymbol } from "@/lib/currency";
import { SETTINGS_COPY } from "@/lib/settingsCopy";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { useAuth } from "@/lib/auth";
import { forgetSettingsDraft, keepSettingsDraft, keptSettingsDraft } from "@/lib/settingsDraftStore";
import { changedKeys, saveFailureOf, savePayload, wireBody, type SaveFailure } from "./draft";

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
 * <b>The body is the page's own</b> (`draft.wireBody`): every row the registry shows, spelled the
 * way the API binds it — see there for why not the shared mapper.
 * </p>
 */
export function useSettingsDocument() {
  const toast = useToast();
  const [saved, setSaved] = useState<AdminSettings | null>(null);
  const [draft, setDraft] = useState<AdminSettings | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<SaveFailure | null>(null);
  const [restored, setRestored] = useState(false);
  const auth = useAuth();
  const userId = auth.status === "authenticated" ? auth.userId : null;
  const [lookedFor, setLookedFor] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const settings = await endpoints.adminSettingsGet();
      setSaved(settings);
      setDraft(settings);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount loader; sync loading flag is the house idiom
  useEffect(() => { void load(); }, [load]);

  const save = useAsyncAction(
    async (sent: AdminSettings) => {
      await api.put<{ saved: true }>("/api/v1/admin/settings/", wireBody(savePayload(sent)));
      return sent;
    },
    {
      success: (sent) => {
        setSaved(sent);
        setFailure(null);
        setRestored(false);
        toast.push({ tone: "success", text: SETTINGS_COPY.saved });
      },
      // F3.15: on the PAGE, not in a toast that fades — the sentence, the field it is about and
      // the next step. Through the shared device-error dictionary, so a code that HAS a sentence
      // gets it and a `<key>_out_of_range` names the field by its caption.
      failure: (err, sent) => setFailure(saveFailureOf(err, readCurrencySymbol(sent.currency_symbol))),
    },
  );

  const update = useCallback((patch: Partial<AdminSettings>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }, []);

  // F3.15: edits kept across a sign-in come back — once per admin, before any edit, and only over
  // the very settings they were edited from (`changedKeys`, not a byte compare: the read
  // normalises what it serves). Adjusted during render, React's pattern for state derived from a
  // change, so the mirror below never sees — and erases — the kept draft first.
  if (userId && saved && draft === saved && lookedFor !== userId) {
    setLookedFor(userId);
    const kept = keptSettingsDraft(userId);
    if (kept && changedKeys(kept.basis, saved).length === 0) {
      setDraft({ ...saved, ...kept.draft });
      setRestored(true);
    }
  }

  // Every edit is mirrored for this tab, so a session that ends mid-save does not take it along.
  // Runs only once the read has answered, so it never erases a kept draft before `load` reads it.
  useEffect(() => {
    if (!userId || !saved || !draft) return;
    if (draft === saved) forgetSettingsDraft(userId);
    else keepSettingsDraft(userId, saved, draft);
  }, [userId, saved, draft]);

  const discard = useCallback(() => {
    setDraft(saved);
    setFailure(null);
    setRestored(false);
  }, [saved]);

  return { saved, draft, error, loading, load, update, discard, save, failure, restored };
}
