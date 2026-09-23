import { useCallback, useEffect, useState } from "react";
import { settingAnchorId } from "@/lib/tenantSettings";
import { sectionOfKey, type SettingsSectionId } from "@/lib/settingsSchema";

/** How long a deep-linked field stays ringed, in ms. Long enough to be seen, short enough to leave. */
const HIGHLIGHT_MS = 2500;

/**
 * Put one setting in front of the admin: scroll to it, focus its control, and ring it.
 *
 * <p>
 * The control is the field's text box or picker, never the (i) beside its caption — and for a
 * weekday row, its first time rather than the "own hours" switch, because an admin sent there by a
 * complaint about the CLOSING TIME wants the time, not the switch that would turn the row off.
 * </p>
 */
function focusSettingElement(anchorId: string): boolean {
  const wrapper = document.getElementById(anchorId);
  if (!wrapper) return false;
  wrapper.scrollIntoView?.({ block: "center" });
  const control = wrapper.querySelector<HTMLElement>('input, textarea, [role="combobox"]')
    ?? wrapper.querySelector<HTMLElement>('[role="switch"]');
  control?.focus({ preventScroll: true });
  return true;
}

/** `setting-gate-unlock-seconds` → `gate_unlock_seconds`, when it names a setting on this page. */
function keyOfAnchor(anchor: string): string | null {
  if (!anchor.startsWith("setting-")) return null;
  const key = anchor.slice("setting-".length).replaceAll("-", "_");
  return sectionOfKey(key) ? key : null;
}

/**
 * The `#setting-<key>` deep link, and the same jump the save bar's summary uses. (A9)
 *
 * <p>
 * The doors page's "may not be releasing" signal sends an admin to change the release under
 * Settings; the hash lands them ON the number rather than at the top of a long page. It is the
 * general mechanism — every field has an anchor — and now it also OPENS the section (and the
 * "advanced" disclosure) the field sits in, through `reveal`, before focusing it.
 * </p>
 *
 * <p>
 * `#settings-<section>` (`#settings-doors`) opens that section and focuses its header.
 * </p>
 */
/**
 * How long a jump waits for its section to open. Bounded by TIME, not by a count of tries: ten
 * 16 ms frames (the first version) was 160 ms, and a busy phone — or a loaded CI runner, where it
 * was measured failing — takes longer than that to commit ten sections, so the jump gave up on a
 * field that was about to appear.
 */
const REVEAL_BUDGET_MS = 2_000;

/**
 * Focus a setting once whatever hid it has opened. The section opens on the next commit, which
 * may come after this call — so it tries on the next tick and, while the target is still inside
 * something `hidden`, frame by frame until the budget runs out, rather than guessing when React
 * will have painted.
 */
function focusWhenShown(anchorId: string, onFocused: () => void, deadline = Date.now() + REVEAL_BUDGET_MS, first = true) {
  window.setTimeout(() => {
    const target = document.getElementById(anchorId);
    const stillHidden = target !== null && target.closest("[hidden]") !== null;
    if (stillHidden && Date.now() < deadline) {
      focusWhenShown(anchorId, onFocused, deadline, false);
      return;
    }
    if (focusSettingElement(anchorId)) onFocused();
  }, first ? 0 : 16);
}

export function useSettingFocus(ready: boolean, reveal: (key: string) => void, openSection: (id: SettingsSectionId) => void) {
  const [highlighted, setHighlighted] = useState<string | null>(null);

  const focusSetting = useCallback((key: string) => {
    reveal(key);
    const anchorId = settingAnchorId(key);
    focusWhenShown(anchorId, () => setHighlighted(anchorId));
  }, [reveal]);

  // An effect rather than a render-time read: the hash names an ELEMENT, and it does not exist
  // until the settings have loaded.
  useEffect(() => {
    if (!ready) return undefined;
    const fromHash = () => {
      // `slice` rather than a regex: lizard's lexer reads a regex literal in a .tsx file as
      // division and swallows the rest of the file into this function.
      const raw = window.location.hash;
      const hash = raw.startsWith("#") ? raw.slice(1) : raw;
      const key = keyOfAnchor(hash);
      if (key) {
        focusSetting(key);
        return;
      }
      const section = hash.startsWith("settings-") ? (hash.slice("settings-".length) as SettingsSectionId) : null;
      if (!section) return;
      openSection(section);
      // And focus its header, so the jump means something to a keyboard, not only to the eye.
      window.setTimeout(() => {
        const trigger = document.querySelector<HTMLElement>(`#settings-${section} h2 button`);
        trigger?.scrollIntoView?.({ block: "start" });
        trigger?.focus({ preventScroll: true });
      }, 0);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, [ready, focusSetting, openSection]);

  useEffect(() => {
    if (!highlighted) return undefined;
    const timer = window.setTimeout(() => setHighlighted(null), HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [highlighted]);

  return { highlighted, focusSetting };
}
