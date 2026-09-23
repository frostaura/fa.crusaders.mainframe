import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useRef, useState, type DragEvent } from "react";
import { cn } from "../lib/utils";
import { preparePhoto, PhotoError, PHOTO_MESSAGES } from "../lib/photo";
import { PHOTO_PICKER } from "../lib/registrationCopy";
import { IconButton } from "./ui/icon-button";
import { Spinner } from "./ui/spinner";
import { ArrowsClockwise, Camera, CheckCircle, Trash, UserFocus, WarningCircle } from "./ui/icons";

/**
 * The member's photo, picked and prepared in one control.
 *
 * <p>
 * It replaced a bare <c>&lt;input type="file"&gt;</c> — the browser's own "Choose File / No file
 * chosen" chrome, unstyleable and preview-less, so a member had no idea whether they had picked
 * the right photo or any photo at all. Preparation (decode, orient, downscale, re-encode) happens
 * at the moment of picking, so an unusable photo is reported while the file picker is still fresh
 * in the member's hand rather than after four other fields and a submit.
 * </p>
 *
 * <p>
 * <b>Anatomy.</b> Before a pick: a drop zone with an avatar-shaped placeholder, so the member can
 * see the photo will be a face in a circle. After: that circle holds the photo, with "Photo ready"
 * and two 44px icon buttons — choose a different one, remove it.
 * </p>
 */

/**
 * Object-URL helpers that tolerate an environment without them (jsdom, locked-down contexts).
 * Neither is a reason to throw on a file the member legitimately picked; only the preview needs them.
 */
function objectUrl(file: File): string | null {
  try { return typeof URL?.createObjectURL === "function" ? URL.createObjectURL(file) : null; }
  catch { return null; }
}

function revoke(url: string): void {
  try { URL.revokeObjectURL?.(url); } catch { /* nothing to release */ }
}

/**
 * What a form can do to this control from outside: put the keyboard on it. The form owns "is a
 * photo required here"; when it refuses to submit for want of one, the member has to be taken to
 * the field — an `sr-only` input nothing else on the page can find.
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
   * The FORM's complaint about this field ("please add a photo", or the upload endpoint's
   * refusal). Rendered on the field and NOT as a live region: the form announces its own summary
   * and moves focus here, and a second `role="alert"` for the same event is the double
   * announcement `Toast.tsx` records having paid for twice. This control's own preparation
   * failures — which arrive asynchronously, after the pick — are the ones that speak.
   */
  error?: string | null;
  /**
   * Raised while a picked photo is being decoded and re-encoded, so a member who picks and
   * presses submit in the same second is told to wait rather than that they have no photo.
   */
  onBusyChange?: (busy: boolean) => void;
  label?: string;
  hint?: string;
  required?: boolean;
  disabled?: boolean;
};

function Preview({ src }: { src: string | null }) {
  return (
    <span className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-full bg-bg-muted text-text-muted ring-2 ring-success-strong ring-offset-2 ring-offset-bg-surface">
      {src ? <img src={src} alt={PHOTO_PICKER.previewAlt} className="size-full object-cover" /> : <Camera size={24} aria-hidden="true" />}
    </span>
  );
}

type ChosenProps = { name: string; preview: string | null; disabled?: boolean; onReplace: () => void; onClear: () => void };

function Chosen(props: ChosenProps) {
  const { name, preview, disabled, onReplace, onClear } = props;
  return (
    <div className="flex items-center gap-4 rounded-xl border border-border bg-bg-surface p-3 shadow-xs peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent-strong">
      <Preview src={preview} />
      <div className="min-w-0 flex-1">
        {/* The visible confirmation IS the status — a second sr-only copy announced it twice. */}
        <p role="status" className="flex items-center gap-1.5 text-sm font-semibold text-success-strong">
          <CheckCircle size={16} weight="fill" aria-hidden="true" className="shrink-0" /> {PHOTO_PICKER.ready}
        </p>
        {/* Named, so the member knows WHICH photo without reading the thumbnail. */}
        <p className="truncate text-xs text-text-muted">{name}</p>
      </div>
      <div className="flex shrink-0 items-center">
        <IconButton label={PHOTO_PICKER.replace} disabled={disabled} onClick={onReplace}><ArrowsClockwise /></IconButton>
        <IconButton label={PHOTO_PICKER.remove} disabled={disabled} onClick={onClear}><Trash /></IconButton>
      </div>
    </div>
  );
}

type DropZoneProps = { htmlFor: string; busy: boolean; invalid: boolean; disabled?: boolean; onFile: (file: File | undefined) => void };

function DropZone(props: DropZoneProps) {
  const { htmlFor, busy, invalid, disabled, onFile } = props;
  const [dragging, setDragging] = useState(false);
  const over = (e: DragEvent) => { e.preventDefault(); setDragging(true); };
  const drop = (e: DragEvent) => { e.preventDefault(); setDragging(false); onFile(e.dataTransfer.files?.[0]); };
  return (
    <label
      htmlFor={htmlFor}
      onDragOver={over}
      onDragLeave={() => setDragging(false)}
      onDrop={drop}
      className={cn(
        "flex min-h-28 w-full cursor-pointer items-center gap-4 rounded-xl border-2 border-dashed p-4",
        "transition-colors duration-fast ease-standard motion-reduce:transition-none",
        "peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent-strong",
        dragging ? "border-accent-strong bg-accent-soft" : "border-control bg-bg-muted hover:border-accent-strong hover:bg-accent-soft",
        invalid && !dragging && "border-danger-strong",
        (disabled || busy) && "pointer-events-none opacity-60",
      )}
    >
      {/* Avatar-shaped, so the member sees the photo will be a face in a circle before they pick. */}
      <span className="flex size-16 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-strong ring-1 ring-accent-strong/30">
        {busy ? <Spinner className="size-6" /> : <UserFocus size={32} weight="duotone" aria-hidden="true" />}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        {busy ? (
          <span role="status" className="text-sm font-semibold text-text-primary">{PHOTO_PICKER.preparing}</span>
        ) : (
          <>
            <span className="flex items-center gap-1.5 text-sm font-semibold text-accent-strong">
              <Camera size={16} weight="bold" aria-hidden="true" className="shrink-0" />{PHOTO_PICKER.choose}
            </span>
            {/* Desktop only: there is nothing to drag on a phone. */}
            <span className="hidden text-xs text-text-secondary sm:block">{PHOTO_PICKER.drop}</span>
          </>
        )}
      </span>
    </label>
  );
}

/** One message, and only the picker's own failure is a live region — see `error` above. */
function Message({ id, text, live }: { id: string; text: string; live: boolean }) {
  return (
    <p id={id} role={live ? "alert" : undefined} className="flex items-start gap-1.5 text-sm font-medium text-danger-strong">
      <WarningCircle aria-hidden="true" size={16} weight="bold" className="mt-0.5 shrink-0" />
      <span className="min-w-0 break-words">{text}</span>
    </p>
  );
}

/** Pick, prepare, preview — the state behind the control, apart from how it is drawn. */
function usePreparedPhoto(
  resetInput: () => void,
  onChange: (file: File | null) => void,
  onBusyChange?: (busy: boolean) => void,
) {
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // An object URL is a document-lifetime handle — without the revoke, every photo tried stays resident.
  useEffect(() => () => { if (preview) revoke(preview); }, [preview]);

  const show = useCallback((next: string | null) => setPreview((previous) => {
    if (previous) revoke(previous);
    return next;
  }), []);

  const accept = useCallback(async (file: File | null | undefined) => {
    if (!file) return;
    setBusy(true);
    onBusyChange?.(true);
    setProblem(null);
    try {
      const prepared = await preparePhoto(file);
      show(objectUrl(prepared));
      onChange(prepared);
    } catch (err) {
      setProblem(err instanceof PhotoError ? PHOTO_MESSAGES[err.problem] : PHOTO_PICKER.failed);
      onChange(null);
      show(null);
    } finally {
      setBusy(false);
      onBusyChange?.(false);
      resetInput();
    }
  }, [onChange, onBusyChange, show, resetInput]);

  const clear = () => {
    show(null);
    setProblem(null);
    onChange(null);
    resetInput();
  };

  return { preview, busy, problem, accept, clear };
}

export const PhotoPicker = forwardRef<PhotoPickerHandle, PhotoPickerProps>(function PhotoPicker(props, handle) {
  const {
    value, onChange, error, onBusyChange, label = PHOTO_PICKER.label, hint = PHOTO_PICKER.hint, required, disabled,
  } = props;
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  // Lets the member re-pick the SAME file: an unchanged value fires no change event.
  const resetInput = useCallback(() => { if (input.current) input.current.value = ""; }, []);
  const photo = usePreparedPhoto(resetInput, onChange, onBusyChange);
  // Removing the photo leaves the keyboard on the field, not on a button that no longer exists.
  const clear = () => {
    photo.clear();
    input.current?.focus();
  };

  // Deliberately NOT `preventScroll`: the member is looking at a submit button that refused, and
  // bringing the field into view IS the message.
  useImperativeHandle(handle, () => ({ focus: () => input.current?.focus() }), [input]);

  // The picker's failure is about the file just chosen and wins over the form's "add a photo".
  const message = photo.problem ?? error ?? null;
  const errorId = `${inputId}-error`;

  return (
    <div className="grid gap-1.5">
      {/* No asterisk: every field on the form is required, and marking one implies the rest are not. */}
      <span id={`${inputId}-label`} className="text-sm font-medium text-text-primary">{label}</span>
      {/*
        The real input stays in the DOM: it opens the native picker, a screen reader announces it
        and the keyboard reaches it. `sr-only`, not `display:none` (which is unfocusable).

        `aria-required`, NEVER `required` — D4's bug 1. A `required` sr-only input is still a
        constraint-validation candidate, and Chrome refused to submit the form with nowhere to
        draw its bubble: the page did nothing and said nothing. The form does the checking.

        Named by the FIELD label (not the drop zone's changing text), and `peer` so the visible
        tile can show this input's focus — `focus-within` never fires on a sibling.
      */}
      <input
        ref={input}
        id={inputId}
        type="file"
        accept="image/*"
        aria-required={required || undefined}
        aria-invalid={message ? true : undefined}
        disabled={disabled || photo.busy}
        aria-labelledby={`${inputId}-label`}
        aria-describedby={`${inputId}-hint${message ? ` ${errorId}` : ""}`}
        className="peer sr-only"
        onChange={(e) => photo.accept(e.target.files?.[0])}
      />
      {value ? (
        <Chosen
          name={value.name}
          preview={photo.preview}
          disabled={disabled}
          onReplace={() => input.current?.click()}
          onClear={clear}
        />
      ) : (
        <DropZone htmlFor={inputId} busy={photo.busy} invalid={Boolean(message)} disabled={disabled} onFile={photo.accept} />
      )}
      <p id={`${inputId}-hint`} className="text-sm text-text-secondary">{hint}</p>
      {message ? <Message id={errorId} text={message} live={Boolean(photo.problem)} /> : null}
    </div>
  );
});
