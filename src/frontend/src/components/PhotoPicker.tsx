import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import { Camera, Check, Loader2, RefreshCw, X } from "lucide-react";
import { cn } from "../lib/utils";
import { preparePhoto, PhotoError, PHOTO_MESSAGES } from "../lib/photo";

/**
 * The member's photo, picked and prepared in one control.
 *
 * <p>
 * It replaces a bare <c>&lt;input type="file"&gt;</c>, which rendered the browser's own
 * "Choose File / No file chosen" chrome in the middle of an otherwise styled form. That
 * control is unstyleable, it is the one element on the screen that looks like a different
 * decade, and — the part that actually costs something — it gives no preview, so a member had
 * no idea whether they had picked the right photo, or a photo at all.
 * </p>
 *
 * <p>
 * It also moves preparation forward to the moment of picking rather than the moment of
 * submitting. On register this is the difference between learning your photo is unusable now,
 * with the file picker still fresh in your hand, and learning it after filling in four other
 * fields and pressing the button you thought was the last step.
 * </p>
 */

/**
 * Object-URL helpers that tolerate an environment without them.
 *
 * jsdom implements neither, and some locked-down browser contexts revoke access. Neither is a
 * reason for the control to throw on a file the member legitimately picked — the preview is the
 * only thing that depends on them.
 */
function objectUrl(file: File): string | null {
  try { return typeof URL?.createObjectURL === "function" ? URL.createObjectURL(file) : null; }
  catch { return null; }
}

function revoke(url: string): void {
  try { URL.revokeObjectURL?.(url); } catch { /* nothing to release */ }
}

/**
 * What a form can do to this control from outside: put the keyboard on it.
 *
 * <p>
 * The form owns "is a photo required here", because only the form knows what it is submitting.
 * When it refuses to submit for want of one, the member has to be taken to the field — and the
 * field is an `sr-only` input, so nothing else on the page can find it. A handle is the one
 * thing the parent needs and the only thing it gets.
 * </p>
 */
export type PhotoPickerHandle = {
  /** Focus the real input, scrolling it into view. The visible tile shows the ring via `peer`. */
  focus: () => void;
};

export type PhotoPickerProps = {
  /** The prepared, upload-ready file, or null. Owned by the parent so the form can submit it. */
  value: File | null;
  onChange: (file: File | null) => void;
  /**
   * The FORM's own complaint about this field — "please add a photo", and nothing else.
   *
   * <p>
   * It shares one `role="alert"` slot with this control's own preparation failures, and that
   * sharing is the point. It used to be the other way round: the picker raised its failures to
   * the parent through an `onError` callback, the parent rendered them in a page-level `Alert`
   * (which is `role="alert"`), and the picker went on rendering the same sentence in its own
   * `role="alert"` paragraph. Two assertive regions, same words, one event — the same defect
   * `Toast.tsx` records having paid for twice. One field, one message, one region.
   * </p>
   */
  error?: string | null;
  /**
   * Raised while a picked photo is being decoded and re-encoded.
   *
   * <p>
   * The parent form needs this. Preparation is asynchronous, so a member who picks a photo and
   * presses submit in the same second reaches the handler with `value` still null and is told
   * to upload a photo they have visibly just chosen.
   * </p>
   */
  onBusyChange?: (busy: boolean) => void;
  label?: string;
  hint?: string;
  required?: boolean;
  disabled?: boolean;
};

export const PhotoPicker = forwardRef<PhotoPickerHandle, PhotoPickerProps>(function PhotoPicker({
  value,
  onChange,
  error,
  onBusyChange,
  label = "Photo of yourself",
  hint = "So other players can recognise you on court. Your face, clearly lit.",
  required,
  disabled,
}: PhotoPickerProps, handle) {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  // An object URL is a document-lifetime handle, not a value — without the revoke, every photo
  // a member tries stays resident for as long as the tab is open.
  useEffect(() => () => { if (preview) revoke(preview); }, [preview]);

  /*
    Deliberately NOT `preventScroll`. The whole point of the call is that the member is looking
    at a submit button that has refused to do anything, and the reason is a field they may not
    have scrolled to — on a 320 px viewport the picker is comfortably off-screen behind the
    keyboard. Bringing it into view IS the message; the ring and the sentence are the detail.
  */
  useImperativeHandle(handle, () => ({ focus: () => input.current?.focus() }), []);

  const accept = useCallback(async (file: File | null | undefined) => {
    if (!file) return;
    setBusy(true);
    onBusyChange?.(true);
    setProblem(null);
    try {
      const prepared = await preparePhoto(file);
      setPreview(previous => {
        if (previous) revoke(previous);
        return objectUrl(prepared);
      });
      onChange(prepared);
    } catch (err) {
      const message = err instanceof PhotoError
        ? PHOTO_MESSAGES[err.problem]
        : "We couldn't prepare that photo. Try a different one.";
      setProblem(message);
      onChange(null);
      setPreview(previous => {
        if (previous) revoke(previous);
        return null;
      });
    } finally {
      setBusy(false);
      onBusyChange?.(false);
      // Lets the member re-pick the SAME file after a failure. Without it the input's value is
      // unchanged, no change event fires, and the control appears dead to a second attempt.
      if (input.current) input.current.value = "";
    }
  }, [onChange, onBusyChange]);

  const clear = () => {
    setPreview(previous => {
      if (previous) revoke(previous);
      return null;
    });
    setProblem(null);
    onChange(null);
    if (input.current) input.current.value = "";
  };

  /**
   * One message, whoever noticed it. The picker's own preparation failure wins over the form's
   * "please add a photo", because it is about the file the member has just chosen and the
   * form's complaint is about the absence of one — they cannot both be current, and the
   * picker's is the newer fact.
   */
  const message = problem ?? error ?? null;

  // Deliberately NOT `value && preview`. An object URL is a rendering convenience; whether the
  // member has chosen a photo is decided by whether there IS one. Tying the two together meant
  // that anywhere URL.createObjectURL is unavailable the control accepted the file and then
  // carried on showing an empty dropzone, which reads as the pick having failed.
  const chosen = Boolean(value);

  return (
    <div>
      {/*
        The asterisk sits OUTSIDE the element referenced by aria-labelledby. Inside it, the
        input's accessible name becomes "Photo of yourself *" — the label a screen reader
        announces, and the one a test queries by, both silently acquire a punctuation mark.
      */}
      <span className="block text-sm font-medium text-text-secondary mb-1">
        <span id={`${inputId}-label`}>{label}</span>
        {required && <span className="text-danger-strong" aria-hidden="true"> *</span>}
      </span>

      {/*
        The real input stays in the DOM and keeps working — it is what opens the native picker,
        what a screen reader announces, and what the keyboard reaches. It is visually hidden
        rather than `display:none`, because a hidden input is not focusable and the control
        would then be mouse-only. `sr-only` plus a sibling label is the pairing that keeps both.
      */}
      <input
        ref={input}
        id={inputId}
        type="file"
        accept="image/*"
        /*
         * `aria-required`, NEVER the `required` attribute, and this is the whole of D4's bug 1.
         *
         * `sr-only` is `position:absolute; width:1px; height:1px; clip-path:inset(50%)` — not
         * `display:none` — so the control stays a live candidate for the browser's own
         * constraint validation. With `required` on it Chrome refused to submit the form and
         * had a 1x1 clipped element to draw its bubble on, which it will not do: measured
         * `formValid: false`, `validationMessage: "Please select a file."`, zero alerts, zero
         * console output. An applicant filled four fields, pressed Submit application, and the
         * page did not move and said nothing, for ever. The form's own sentence — kinder than
         * "Please select a file." and the one that names why a photo is wanted at all — was
         * dead code, because `onSubmit` never fired.
         *
         * `aria-required` announces exactly the same fact to a screen reader and blocks
         * nothing. The form does the checking; see `registrationCopy.PHOTO_REQUIRED`.
         */
        aria-required={required || undefined}
        aria-invalid={message ? true : undefined}
        disabled={disabled || busy}
        /*
         * Named by the FIELD label, not by whichever <label for> happens to wrap the visible
         * control. Without this the input's accessible name is the dropzone's own text — "Take
         * or choose a photo" before a pick, "Choose a different photo" after — so the field a
         * screen-reader user is sitting on renames itself mid-form, and never once says what it
         * is actually for.
         */
        aria-labelledby={`${inputId}-label`}
        aria-describedby={`${inputId}-hint${message ? ` ${inputId}-error` : ""}`}
        /*
         * `peer`, so the visible control can show this input's focus.
         *
         * The tile carried `focus-within:ring-2`, which never once fired: focus-within matches
         * an ancestor of the focused element, and the input is the label's SIBLING, not its
         * child. A keyboard user tabbing through the form reached the photo field and saw
         * absolutely nothing change — the one control on the screen with no focus indicator,
         * and the one that is not self-evidently a control. Confirmed by focusing it in a real
         * browser and reading back a computed box-shadow of `none`.
         *
         * `peer-focus-visible` matches a later sibling of the peer, which is exactly this shape.
         */
        className="peer sr-only"
        onChange={e => accept(e.target.files?.[0])}
      />

      {chosen ? (
        <div className="flex items-center gap-3 rounded-lg border border-control bg-bg-surface p-3 peer-focus-visible:ring-2 peer-focus-visible:ring-accent-strong peer-focus-visible:ring-offset-2">
          {preview ? (
            <img
              src={preview}
              alt="The photo you chose"
              className="h-16 w-16 rounded-full object-cover border border-border shrink-0"
            />
          ) : (
            <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full border border-border bg-bg-muted text-text-muted">
              <Camera size={20} aria-hidden="true" />
            </span>
          )}
          <div className="min-w-0 flex-1">
            {/*
              role="status" on the visible confirmation rather than a second, screen-reader-only
              copy of it. The duplicate announced "Photo ready" twice, and put two nodes with
              the same text in the tree.
            */}
            <p role="status" className="flex items-center gap-1.5 text-sm font-medium text-success-strong">
              <Check size={16} aria-hidden="true" /> Photo ready
            </p>
            {/* Named so the member knows WHICH photo, without needing to read the thumbnail. */}
            <p className="truncate text-xs text-text-muted">{value!.name}</p>
          </div>
          <div className="flex shrink-0 gap-1">
            <label
              htmlFor={inputId}
              className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-control text-text-secondary hover:bg-bg-muted"
              title="Choose a different photo"
            >
              <RefreshCw size={16} aria-hidden="true" />
              <span className="sr-only">Choose a different photo</span>
            </label>
            <button
              type="button"
              onClick={clear}
              disabled={disabled}
              className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-control text-text-secondary hover:bg-bg-muted"
              title="Remove this photo"
            >
              <X size={16} aria-hidden="true" />
              <span className="sr-only">Remove this photo</span>
            </button>
          </div>
        </div>
      ) : (
        <label
          htmlFor={inputId}
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => { e.preventDefault(); setDragging(false); accept(e.dataTransfer.files?.[0]); }}
          className={cn(
            "flex min-h-[7rem] w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-4 text-center",
            "peer-focus-visible:ring-2 peer-focus-visible:ring-accent-strong peer-focus-visible:ring-offset-2",
            dragging ? "border-accent-strong bg-accent-soft" : "border-control bg-bg-muted hover:bg-bg-muted/70",
            (disabled || busy) && "opacity-60",
            message && !dragging && "border-danger-strong",
          )}
        >
          {busy ? (
            <>
              <Loader2 size={22} className="animate-spin text-text-muted" aria-hidden="true" />
              <span role="status" className="text-sm text-text-secondary">Preparing your photo…</span>
            </>
          ) : (
            <>
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-accent-soft text-accent-strong">
                <Camera size={20} aria-hidden="true" />
              </span>
              <span className="text-sm font-medium text-accent-strong">Take or choose a photo</span>
              {/* Desktop-only affordance: there is nothing to drag on a phone, and offering it
                  there reads as an instruction the member cannot follow. */}
              <span className="hidden text-xs text-text-muted sm:block">or drop an image here</span>
            </>
          )}
        </label>
      )}

      <p id={`${inputId}-hint`} className="mt-1 text-xs text-text-muted">{hint}</p>

      {message && (
        <p id={`${inputId}-error`} role="alert" className="mt-1 text-sm text-danger-strong">{message}</p>
      )}
    </div>
  );
});
