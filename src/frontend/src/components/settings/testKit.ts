import { fireEvent, screen, type Matcher } from "@testing-library/react";
import { SETTINGS_COPY } from "@/lib/settingsCopy";

/**
 * How the Settings tests reach the page — imported by the `*settings*.test.tsx` files only.
 *
 * <p>
 * <b>Why a selector on every label lookup.</b> Each setting's (i) is a button named "More about
 * &lt;caption&gt;", so a bare `getByLabelText(/Unlock time/)` finds two elements — the control and
 * the guidance behind it. The control is the input, text box, picker or switch.
 * </p>
 */
const CONTROLS = 'input, textarea, button[role="combobox"], button[role="switch"]';

export const control = (label: Matcher) => screen.getByLabelText(label, { selector: CONTROLS });
export const findControl = (label: Matcher) => screen.findByLabelText(label, { selector: CONTROLS });
export const queryControl = (label: Matcher) => screen.queryByLabelText(label, { selector: CONTROLS });

/** Type into a field the way the old tests did. */
export const edit = (label: Matcher, value: string) => fireEvent.change(control(label), { target: { value } });

/** Choose from a design-system Select (a Radix combobox) by the option's NAME, as an admin does. */
export function choose(label: Matcher, option: string) {
  fireEvent.pointerDown(control(label), { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.click(screen.getByRole("option", { name: option }));
}

/** The names of a Select's options, opened and closed again. */
export function optionsOf(label: Matcher): string[] {
  fireEvent.pointerDown(control(label), { button: 0, ctrlKey: false, pointerType: "mouse" });
  const names = screen.getAllByRole("option").map((option) => option.textContent ?? "");
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
  return names;
}

/**
 * Everything a screen reader reads out with this control. `aria-describedby` is a LIST — the
 * guidance, the one-line description and the error join rather than replace one another — so a
 * test that read only the first id would pass against exactly the regression worth catching.
 */
export const describedBy = (field: HTMLElement) =>
  (field.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");

/** The field's own visible caption, read off the `<label for>` that points at it. */
export const captionOf = (field: HTMLElement) =>
  document.querySelector(`label[for="${field.id}"]`)?.textContent ?? "";

/** The save bar's Save. It exists only while there is something to save or something stopping one. */
export const saveButton = () => screen.getByRole("button", { name: SETTINGS_COPY.save });
export const querySaveButton = () => screen.queryByRole("button", { name: SETTINGS_COPY.save });

/** A section's header button, by the section's title. */
export const sectionTrigger = (title: string) => screen.getByRole("button", { name: title });
