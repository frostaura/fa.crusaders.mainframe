import { useId, useMemo, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { fieldClassName } from "./Button";

/**
 * A real combobox over the club's members — type-ahead, keyboard, and an honest empty state.
 *
 * <p>
 * <b>A `<select>` was the alternative and it fails at about eighty members.</b> A club's list
 * is hundreds long; a native select is a scroll with no search, and on a phone it is a wheel.
 * The desk needs to find "Thandi" by typing "tha", and that is a combobox — `role="combobox"`
 * with `aria-controls` onto a `role="listbox"`, `aria-activedescendant` for the highlighted
 * option, and arrow keys that move the highlight without moving focus off the input.
 * </p>
 *
 * <p>
 * <b>It never shows an email.</b> The booking grid's own invariant is photo and name only —
 * no email, phone or membership number visible to other players — and while an admin is not
 * another player, a picker that renders an email is a picker somebody will screenshot. The
 * membership number is offered instead, because it is what the desk actually disambiguates
 * two Thandis by, and it is searchable without being rendered on every row.
 * </p>
 *
 * <p>
 * <b>Generic on purpose.</b> Nothing here knows about traces, top-ups or groups. Described
 * for the chrome lane in the admin lane's report; built locally because three surfaces in
 * this wave need it.
 * </p>
 */

export type PickableMember = {
  user_id: string;
  full_name: string;
  membership_number?: string | null;
  /** Shown on the right of a row where the caller has one — a balance, a group, a date. */
  aside?: string | null;
};

/**
 * Match on the name and the membership number, case- and space-insensitively.
 *
 * <p>
 * Substring rather than prefix: a club has "van der Merwe" and a desk types "merwe". Prefix
 * matching is faster and would fail exactly the names it matters most for.
 * </p>
 */
export function matchMembers(members: PickableMember[], query: string, limit = 8): PickableMember[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return members.slice(0, limit);
  return members
    .filter((m) => `${m.full_name} ${m.membership_number ?? ""}`.toLowerCase().includes(needle))
    .slice(0, limit);
}

export function MemberPicker({
  members, value, onChange, label, hint, disabled = false, loading = false, failed = false,
}: {
  members: PickableMember[];
  value: PickableMember | null;
  onChange: (member: PickableMember | null) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
  /** The member list has not landed. The field stays usable and says what it is waiting for. */
  loading?: boolean;
  /**
   * The member list could not be read.
   *
   * Its own state, and not "no members": an empty listbox after a failed read tells an admin
   * the club has nobody in it, which is the trap this whole release is written against.
   */
  failed?: boolean;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const options = useMemo(() => matchMembers(members, query), [members, query]);
  const active = options[Math.min(highlight, Math.max(0, options.length - 1))] ?? null;

  const choose = (member: PickableMember) => {
    onChange(member);
    setQuery("");
    setOpen(false);
    setHighlight(0);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => {
        const next = e.key === "ArrowDown" ? h + 1 : h - 1;
        if (options.length === 0) return 0;
        return (next + options.length) % options.length;
      });
      return;
    }
    if (e.key === "Enter" && open && active) { e.preventDefault(); choose(active); return; }
    // Escape closes the list and keeps what is typed. Clearing it as well would throw away a
    // search somebody is in the middle of, for a key they pressed to dismiss a popup.
    if (e.key === "Escape" && open) { e.preventDefault(); setOpen(false); }
  };

  if (value) {
    return (
      <div>
        <p className="text-sm font-medium text-text-primary">{label}</p>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
          <p className="min-w-0 break-words text-text-primary">{value.full_name}</p>
          {value.membership_number && (
            <span className="text-sm text-text-muted">{value.membership_number}</span>
          )}
          <button
            type="button"
            className="ml-auto inline-flex min-h-11 items-center rounded-lg border border-control px-3 text-sm font-medium"
            onClick={() => { onChange(null); setTimeout(() => inputRef.current?.focus(), 0); }}
          >
            {/* Named after what it changes, not "×": a list of controls reading "×" is nothing
                at all to somebody tabbing through them. */}
            {`Choose somebody else instead of ${value.full_name}`}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium text-text-primary">{label}</label>
      {hint && <p className="text-sm text-text-muted">{hint}</p>}
      <input
        ref={inputRef}
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-listbox`}
        aria-autocomplete="list"
        aria-activedescendant={open && active ? `${id}-option-${active.user_id}` : undefined}
        autoComplete="off"
        className={cn(fieldClassName, "mt-1 min-h-11")}
        placeholder="Type a name or a member number"
        disabled={disabled}
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setHighlight(0); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {/* The listbox is always in the document once it is open, because a live region that is
          mounted by the same update that fills it announces nothing. */}
      {open && (
        <ul
          id={`${id}-listbox`}
          role="listbox"
          aria-label={label}
          className="mt-1 max-h-64 overflow-auto rounded-lg border border-border bg-bg-surface"
        >
          {failed && (
            <li className="px-3 py-2 text-sm text-danger-strong">
              Couldn&rsquo;t read the club&rsquo;s members. That is not the same as the club having none — try again.
            </li>
          )}
          {!failed && loading && (
            <li className="px-3 py-2 text-sm text-text-secondary">Reading the club&rsquo;s members…</li>
          )}
          {!failed && !loading && options.length === 0 && (
            <li className="px-3 py-2 text-sm text-text-secondary">
              {query.trim() === "" ? "No members yet." : `Nobody here matches “${query.trim()}”.`}
            </li>
          )}
          {!failed && options.map((member, index) => (
            <li key={member.user_id} id={`${id}-option-${member.user_id}`} role="option" aria-selected={member === active}>
              <button
                type="button"
                // `onMouseDown` rather than `onClick`: a click fires after blur, and blur
                // closes the list, so the option is gone before the click lands.
                onMouseDown={(e) => { e.preventDefault(); choose(member); }}
                onMouseEnter={() => setHighlight(index)}
                className={cn(
                  "flex min-h-11 w-full items-center gap-2 px-3 text-left text-sm",
                  member === active ? "bg-accent-soft text-accent-strong" : "text-text-primary",
                )}
              >
                <span className="min-w-0 break-words">{member.full_name}</span>
                {member.membership_number && (
                  <span className="shrink-0 text-text-muted">{member.membership_number}</span>
                )}
                {member.aside && <span className="ml-auto shrink-0 text-text-muted">{member.aside}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
