import { createContext, useContext } from "react";
import type { AdminSettings } from "@/lib/api";
import type { SettingContext } from "@/lib/settingsSchema";

/**
 * What every row on the Settings page needs that its own props do not carry: the working copy
 * and how to change it, the complaints, which field a deep link has ringed, and the search.
 *
 * <p>
 * One context rather than six props threaded through ten sections: every row reads the same
 * facts, and a row handed a stale copy of one of them is how a field shows yesterday's error.
 * </p>
 */
export type SettingsForm = {
  settings: AdminSettings;
  update: (patch: Partial<AdminSettings>) => void;
  /** settings key → the complaint shown on that field. */
  errors: Readonly<Record<string, string>>;
  /** The anchor id a deep link or a blocker jump has just ringed. */
  highlighted: string | null;
  /** The normalised search, or "" — rows highlight the words it matches. */
  query: string;
  /** Whether a row survives the search. */
  visible: (key: string) => boolean;
  context: SettingContext;
};

const Context = createContext<SettingsForm | null>(null);

export const SettingsFormProvider = Context.Provider;

export function useSettingsForm(): SettingsForm {
  const form = useContext(Context);
  if (!form) throw new Error("useSettingsForm outside SettingsFormProvider");
  return form;
}
