import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { APPEARANCE_COPY, ROLE_LABELS } from "@/lib/appearanceCopy";
import { useAuth } from "@/lib/useAuth";
import {
  OVERRIDABLE, accentRoles, loadOverrides, resolveOverrides, saveOverrides,
  type OverridableRole, type ThemeOverrides,
} from "@/lib/themeOverrides";
import type { Rejection } from "@/lib/themeOverrides";
import { roles, type ThemeName } from "@/lib/tokens";
import { useTheme } from "@/lib/theme";

/**
 * Per-member colour overrides (design-system.md, "Per-member theming"). Every edit is saved and
 * painted at once through `saveOverrides`, which refuses a colour that fails the contrast floors;
 * the refusals are listed here, in words, rather than silently ignored.
 */
export function AppearanceCard() {
  const auth = useAuth();
  const userId = auth.status === "authenticated" ? auth.userId : null;
  const { resolved } = useTheme();
  const [editing, setEditing] = useState<ThemeName>(resolved);
  const [requested, setRequested] = useState<ThemeOverrides>(() => (userId ? loadOverrides(userId) : {}));
  const base = roles(editing);
  const mine = requested[editing] ?? {};
  const { applied, rejected } = resolveOverrides(requested);
  const [accentRefusal, setAccentRefusal] = useState<Rejection[]>([]);
  const refused = [...rejected.filter((r) => r.theme === editing), ...accentRefusal];

  if (!userId) return null;

  const commit = (next: ThemeOverrides) => {
    const pruned: ThemeOverrides = {};
    for (const t of ["light", "dark"] as const) if (next[t] && Object.keys(next[t]!).length) pruned[t] = next[t];
    setRequested(pruned);
    saveOverrides(userId, pruned);
  };
  const setRoles = (patch: Partial<Record<OverridableRole, string | undefined>>) => {
    setAccentRefusal([]);
    const merged = { ...mine, ...patch };
    for (const k of Object.keys(merged) as OverridableRole[]) if (merged[k] === undefined) delete merged[k];
    commit({ ...requested, [editing]: merged });
  };
  /** An accent is a set of roles that only make sense together: all of it applies, or none. */
  const setAccent = (hex: string) => {
    const set = accentRoles(hex, editing);
    const { rejected: bad } = resolveOverrides({ ...requested, [editing]: { ...mine, ...set } });
    const own = bad.filter((r) => r.theme === editing && r.role in set);
    setAccentRefusal(own);
    if (own.length === 0) setRoles(set);
  };
  const shown = (role: OverridableRole) => applied[editing]?.[role] ?? mine[role] ?? base[role];

  return (
    <div className="flex flex-col gap-4" data-appearance="">
      <div role="group" aria-label={APPEARANCE_COPY.themeLabel} className="flex gap-2">
        {(["light", "dark"] as const).map((t) => (
          <Button
            key={t} size="sm" aria-pressed={editing === t}
            variant={editing === t ? "secondary" : "outline"}
            onClick={() => setEditing(t)}
          >
            {t === "light" ? APPEARANCE_COPY.light : APPEARANCE_COPY.dark}
          </Button>
        ))}
      </div>

      <ColorRow
        label={APPEARANCE_COPY.accentLabel} hint={APPEARANCE_COPY.accentHint}
        value={shown("primary")} overridden={mine.primary !== undefined}
        onChange={setAccent}
        onReset={() => setRoles({
          primary: undefined, "primary-hover": undefined, "primary-ink": undefined,
          "accent-strong": undefined, "accent-soft": undefined, ring: undefined,
        })}
      />

      <details className="flex flex-col gap-3">
        <summary className="min-h-touch cursor-pointer py-2 text-sm font-semibold text-text-primary">
          {APPEARANCE_COPY.advanced}
        </summary>
        <div className="flex flex-col gap-3 pt-2">
          {OVERRIDABLE.map((role) => (
            <ColorRow
              key={role} label={ROLE_LABELS[role]} value={shown(role)} overridden={mine[role] !== undefined}
              onChange={(hex) => setRoles({ [role]: hex })}
              onReset={() => setRoles({ [role]: undefined })}
            />
          ))}
        </div>
      </details>

      {refused.length > 0 ? (
        <div role="status" className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning-strong">
          <p className="font-semibold">{APPEARANCE_COPY.refusedHeading}</p>
          <ul className="list-disc pl-5">
            {refused.map((r) => <li key={r.role}>{ROLE_LABELS[r.role]}: {r.reason}</li>)}
          </ul>
        </div>
      ) : null}

      {Object.keys(requested).length > 0 ? (
        <div><Button variant="outline" onClick={() => commit({})}>{APPEARANCE_COPY.resetAll}</Button></div>
      ) : null}
    </div>
  );
}

function ColorRow(props: {
  label: string; hint?: string; value: string; overridden: boolean;
  onChange: (hex: string) => void; onReset: () => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <input
        id={id} type="color" value={props.value.toLowerCase()}
        onChange={(e) => props.onChange(e.target.value)}
        className="h-touch w-touch shrink-0 cursor-pointer rounded-lg border border-control bg-bg-surface p-1"
      />
      <label htmlFor={id} className="flex min-w-0 flex-1 flex-col text-sm text-text-primary">
        <span className="font-medium">{props.label}</span>
        <span className="font-mono text-xs text-text-muted">
          {props.overridden ? props.value.toUpperCase() : APPEARANCE_COPY.usingDefault}
          {props.hint ? ` · ${props.hint}` : ""}
        </span>
      </label>
      {props.overridden ? (
        <Button size="sm" variant="ghost" onClick={props.onReset} aria-label={`${APPEARANCE_COPY.reset} ${props.label}`}>
          {APPEARANCE_COPY.reset}
        </Button>
      ) : null}
    </div>
  );
}
