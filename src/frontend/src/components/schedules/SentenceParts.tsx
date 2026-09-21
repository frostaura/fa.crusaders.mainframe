import { useId, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";

/**
 * The inline controls the rule editor is built out of — D3 §5.2's `SentenceField`.
 *
 * <p>
 * <b>The editor is one readable sentence, not a stack of labelled boxes.</b> "Hold Courts 1, 2
 * and 3 on Tuesdays from 18:00 to 21:00, called League night, from Tue 7 Oct until Mon 30 Nov"
 * is a thing a volunteer can check by reading it. The same information as eight form rows is
 * a thing a volunteer can only check by knowing what each row was for.
 * </p>
 *
 * <p>
 * <b>Every field is a NATIVE control, and that is the accessibility decision.</b> D3 describes
 * a popover; a popover needs a focus trap, an escape handler, a return-focus path and an
 * `aria-expanded` relationship, and `Modal` in this repo is currently missing three of those
 * four (D3-B05, owned by the UI lane). A native `<select>`, `<input type="time">` and
 * `<input type="date">` are keyboard-operable, screen-reader-correct and touch-correct with no
 * code at all — which is what D3 §12's story P6 actually asks for. The two fields whose choice
 * set is genuinely multi-valued, days and courts, use a disclosure over a real `<fieldset>` of
 * checkboxes rather than a custom listbox, for the same reason.
 * </p>
 *
 * <p>
 * <b>Every field carries a real label, visually hidden.</b> Reading the sentence aloud is how
 * a sighted admin checks it; a screen-reader user tabs from control to control and hears them
 * out of that context, so "Start time, 18:00" has to be the control's name even though the
 * word "Start time" appears nowhere on screen.
 * </p>
 *
 * <p>
 * <b>Local to this surface, and described for the chrome lane rather than built there.</b>
 * Nothing in here knows about schedules; it is a sentence-shaped field. It is here because
 * `components/SentenceField.tsx` is a primitive the UI lane owns and has not landed.
 * </p>
 */

/** The dotted underline and the 44 px target that make a field read as part of a sentence. */
const FIELD_CLASS = cn(
  "inline-flex min-h-11 items-center gap-1 rounded-md border-b-2 border-dotted border-control",
  "bg-bg-muted px-2 py-1 text-left align-middle font-medium text-text-primary",
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-strong focus-visible:ring-offset-1",
);

/** Ordinary words between the fields. Kept as a component so the spacing is decided once. */
export function SentenceText({ children }: { children: ReactNode }) {
  return <span className="align-middle text-text-secondary">{children}</span>;
}

type SentenceInputProps = {
  /** The control's real name, visually hidden. See the header. */
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "time" | "date";
  /** Fixed width for the two date fields, whose value length is constant. */
  width?: string;
  placeholder?: string;
  maxLength?: number;
  min?: string;
  required?: boolean;
  invalid?: boolean;
};

export function SentenceInput({
  label, value, onChange, type = "text", width, placeholder, maxLength, min, invalid,
}: SentenceInputProps) {
  const id = useId();
  return (
    <span className="inline-block align-middle">
      <label htmlFor={id} className="sr-only">{label}</label>
      <input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        min={min}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange(e.target.value)}
        className={cn(FIELD_CLASS, width, invalid && "border-danger-strong")}
      />
    </span>
  );
}

export function SentenceSelect({
  label, value, onChange, options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  const id = useId();
  return (
    <span className="inline-block align-middle">
      <label htmlFor={id} className="sr-only">{label}</label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(FIELD_CLASS, "pr-1")}
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </span>
  );
}

/**
 * A field whose value is a SET: a button reading the current choice, and a real fieldset below.
 *
 * <p>
 * `aria-expanded` and `aria-controls` rather than a popover, and the fieldset stays in the
 * document flow: a reader who opens it and tabs forward lands in the checkboxes, and one who
 * tabs past it lands on the next word of the sentence. No trap to escape, nothing to restore
 * focus to, and nothing that behaves differently under `forced-colors` — the disclosure's
 * state is carried by `aria-expanded` and by the chevron's rotation, never by colour.
 * </p>
 */
export function SentenceDisclosure({
  label, summary, open, onToggle, children, invalid,
}: {
  label: string;
  /** What the button reads on screen — the chosen set, in words. */
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  invalid?: boolean;
}) {
  const panelId = useId();
  return (
    <span className="inline-block align-middle">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${label}: ${summary}`}
        aria-invalid={invalid || undefined}
        onClick={onToggle}
        className={cn(FIELD_CLASS, invalid && "border-danger-strong")}
      >
        {summary}
        <ChevronDown aria-hidden className={cn("h-4 w-4 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      <fieldset
        id={panelId}
        hidden={!open}
        className="mt-2 block rounded-lg border border-border bg-bg-surface p-3"
      >
        <legend className="px-1 text-sm font-medium text-text-secondary">{label}</legend>
        {children}
      </fieldset>
    </span>
  );
}

/** One checkbox inside a {@link SentenceDisclosure}, at a 44 px target including its words. */
export function SentenceCheckbox({
  checked, onChange, children,
}: { checked: boolean; onChange: (next: boolean) => void; children: ReactNode }) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-2 text-sm text-text-primary hover:bg-bg-muted">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-5 w-5 accent-accent-strong"
      />
      {children}
    </label>
  );
}
