import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { IconButton } from "@/components/ui/icon-button";
import { CheckCircle, Circle, Question, X } from "@/components/ui/icons";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { TextLink } from "@/components/ui/text-link";
import { endpoints, type WalletResponse, type WebAuthnCredentialRow } from "@/lib/api";
import { useInstallState } from "@/lib/installPrompt";
import { CHECKLIST, GET_STARTED_PATH } from "@/lib/onboardingCopy";
import {
  CHECKLIST_WALLET_PAGE, checklistProgress, deriveChecklist, type ChecklistItem, type ChecklistItemId,
} from "@/lib/setupChecklist";
import { cn } from "@/lib/utils";
import { useOnboarding, useProfileOrNull } from "./useOnboarding";

/**
 * "Finish setting up" — the card on My Code (P8).
 *
 * <p>
 * <b>Self-contained on purpose.</b> It reads what it needs itself (the passkey list and one
 * page of the wallet) rather than taking props from My Code, so the page it sits on can be
 * restructured (P7) by moving one element. It renders for an ACTIVE member only, disappears
 * once all four are done, and can be hidden on this device — there is no server field for the
 * checklist, and the wizard's own dismissal is a different decision.
 * </p>
 *
 * <p>
 * Every row is a link: each one goes where the thing is done. None carries the watermark
 * (dense list rows are on the spec's never list). A read that fails leaves its rows saying so,
 * never "not done yet" — see `lib/setupChecklist.ts`.
 * </p>
 */

type Reads = {
  passkeys: WebAuthnCredentialRow[] | null | undefined;
  wallet: WalletResponse | null | undefined;
};

function useChecklistReads(enabled: boolean): Reads {
  const [reads, setReads] = useState<Reads>({ passkeys: undefined, wallet: undefined });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const settle = (patch: Partial<Reads>) => { if (live) setReads((prev) => ({ ...prev, ...patch })); };
    endpoints.webauthnList().then((rows) => settle({ passkeys: Array.isArray(rows) ? rows : null }), () => settle({ passkeys: null }));
    endpoints.wallet(CHECKLIST_WALLET_PAGE, 0).then((wallet) => settle({ wallet }), () => settle({ wallet: null }));
    return () => { live = false; };
  }, [enabled]);
  return reads;
}

/**
 * R15 X15-4 — the last states this device read, per member. Offline (or with the club
 * unreachable) both reads fail, and the card went from "1 of 4 done" to "0 of 4" with three
 * rows of "Couldn't check just now" — telling a member who added a passkey yesterday that they
 * had not. A failed read now shows the state last read on this phone; "Couldn't check" is left
 * for an item this phone has never read. Per member because the desk tablet is shared.
 */
const CHECKLIST_KEPT_KEY = "crusaders.setup-checklist.kept";
type Kept = Partial<Record<ChecklistItemId, "done" | "todo">>;

function keptStore(): Storage | null {
  try { return window.localStorage ?? null; } catch { return null; }
}

function readKept(userId: string | null): Kept {
  if (!userId) return {};
  try {
    const all: unknown = JSON.parse(keptStore()?.getItem(CHECKLIST_KEPT_KEY) ?? "{}");
    const mine = all && typeof all === "object" ? (all as Record<string, unknown>)[userId] : null;
    return mine && typeof mine === "object" ? (mine as Kept) : {};
  } catch { return {}; }
}

function writeKept(userId: string | null, items: ChecklistItem[]) {
  if (!userId) return;
  const known: Kept = {};
  for (const item of items) if (item.state !== "unknown") known[item.id] = item.state;
  try {
    const raw: unknown = JSON.parse(keptStore()?.getItem(CHECKLIST_KEPT_KEY) ?? "{}");
    const all = raw && typeof raw === "object" ? (raw as Record<string, Kept>) : {};
    keptStore()?.setItem(CHECKLIST_KEPT_KEY, JSON.stringify({ ...all, [userId]: { ...(all[userId] ?? {}), ...known } }));
  } catch { /* the kept states are a convenience; the reads are the record */ }
}

/** A failed read's item takes the state last read on this phone, where there is one. */
function withKept(items: ChecklistItem[], kept: Kept): ChecklistItem[] {
  return items.map((item) => {
    const last = kept[item.id];
    return item.state === "unknown" && last ? { ...item, state: last } : item;
  });
}

export function SetupChecklist() {
  const profile = useProfileOrNull();
  const onboarding = useOnboarding();
  const install = useInstallState();
  const active = (profile?.status ?? "").toLowerCase() === "active";
  const hidden = onboarding.local.checklistHidden === true;
  const reads = useChecklistReads(active && !hidden);
  const loading = reads.passkeys === undefined || reads.wallet === undefined;
  const installed = install.standalone || install.installedNow || onboarding.local.installed === true;
  const read = useMemo(() => deriveChecklist({ ...reads, installed }), [reads, installed]);
  const who = onboarding.userId;
  useEffect(() => { if (!loading) writeKept(who, read); }, [loading, read, who]);

  if (!active || hidden) return null;
  const items = loading ? read : withKept(read, readKept(who));
  const progress = checklistProgress(items);
  if (!loading && progress.allDone) return null;

  return (
    <Card data-setup-checklist="" role="region" aria-labelledby="setup-checklist-title">
      <CardHeader>
        <CardTitle id="setup-checklist-title" asChild><h2>{CHECKLIST.title}</h2></CardTitle>
        <CardDescription>{loading ? " " : CHECKLIST.progress(progress.done, progress.total)}</CardDescription>
        <CardAction>
          <IconButton label={CHECKLIST.hide} size="icon" onClick={onboarding.hideChecklist}>
            <X aria-hidden="true" />
          </IconButton>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Progress value={progress.done} max={progress.total} aria-label={CHECKLIST.progress(progress.done, progress.total)} />
        {loading ? <ChecklistSkeleton /> : <ChecklistRows items={items} />}
        <TextLink variant="standalone" to={GET_STARTED_PATH} className="self-start">{CHECKLIST.resume}</TextLink>
      </CardContent>
    </Card>
  );
}

function ChecklistSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-touch" />)}
    </div>
  );
}

function ChecklistRows({ items }: { items: ChecklistItem[] }) {
  return (
    <ul className="flex flex-col gap-1">
      {items.map((item) => <ChecklistRow key={item.id} item={item} />)}
    </ul>
  );
}

function ChecklistRow({ item }: { item: ChecklistItem }) {
  const copy = CHECKLIST.items[item.id];
  const done = item.state === "done";
  const Mark = done ? CheckCircle : item.state === "unknown" ? Question : Circle;
  return (
    <li data-checklist-item={item.id} data-state={item.state}>
      <Link
        to={copy.to}
        className={cn(
          "no-lift flex min-h-touch items-center gap-3 rounded-lg px-2 text-sm",
          "transition-colors duration-fast ease-standard hover:bg-bg-muted motion-reduce:transition-none",
          done ? "text-text-secondary" : "font-semibold text-text-primary",
        )}
      >
        <Mark
          size={20}
          weight={done ? "fill" : "regular"}
          aria-hidden="true"
          className={cn("shrink-0", done ? "text-success-strong" : "text-text-muted")}
        />
        <span className="min-w-0 flex-1 break-words">
          {done ? copy.done : copy.label}
          {item.state === "unknown" ? <span className="block text-xs font-normal text-text-muted">{CHECKLIST.unknown}</span> : null}
        </span>
      </Link>
    </li>
  );
}
