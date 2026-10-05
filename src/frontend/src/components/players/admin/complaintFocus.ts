import { useEffect } from "react";
import { focusFirstComplaint } from "../../members/saleFocus";

/**
 * R16 X16-3 — a refused confirm takes the keyboard to the first field with a complaint, whose
 * description says what is missing — as the desk's Sell sheet does. A reason-required dialog
 * used to refuse silently: the error appeared, the keyboard stayed on the button.
 *
 * `refused` counts the refusals; each new one moves focus once, a frame after the complaint renders.
 */
export function useComplaintFocus(refused: number, dialogSelector: string) {
  useEffect(() => {
    if (refused === 0) return undefined;
    const frame = requestAnimationFrame(() => focusFirstComplaint(dialogSelector));
    return () => cancelAnimationFrame(frame);
  }, [refused, dialogSelector]);
}
