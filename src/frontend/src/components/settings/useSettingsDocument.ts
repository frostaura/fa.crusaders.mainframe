import { useCallback, useEffect, useState } from "react";
import { useToast } from "@/components/Toast";
import { endpoints, type AdminSettings } from "@/lib/api";
import { describeDeviceError } from "@/lib/deviceErrors";
import { SETTINGS_COPY } from "@/lib/settingsCopy";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { savePayload } from "./draft";

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
 */
export function useSettingsDocument() {
  const toast = useToast();
  const [saved, setSaved] = useState<AdminSettings | null>(null);
  const [draft, setDraft] = useState<AdminSettings | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

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
      await endpoints.adminSettingsSave(savePayload(sent));
      return sent;
    },
    {
      success: (sent) => {
        setSaved(sent);
        toast.push({ tone: "success", text: SETTINGS_COPY.saved });
      },
      // Through the shared device-error dictionary: a code that HAS a sentence gets it ("Unlock
      // time has to be between 1 and 30 seconds…"), and every other token keeps the old
      // underscores-to-spaces fallback.
      failure: (err) => toast.push({ tone: "danger", text: describeDeviceError(err, SETTINGS_COPY.saveFailed), durationMs: 8000 }),
    },
  );

  const update = useCallback((patch: Partial<AdminSettings>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }, []);

  const discard = useCallback(() => setDraft(saved), [saved]);

  return { saved, draft, error, loading, load, update, discard, save };
}
