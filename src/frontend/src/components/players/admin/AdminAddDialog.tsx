import { useCallback, useId, useState } from "react";
import { Alert } from "@/components/Alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { MemberCombobox } from "@/components/ui/member-combobox";
import { RadioCard, RadioGroup } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { endpoints } from "@/lib/api";
import { playersEndpoints, type AddPlayersAnswer, type AdminAddPlayer, type BookingDetail } from "@/lib/playersApi";
import { UnsureOutcome, provenBy, type ProvenBy } from "@/lib/lostReply";
import { DETAIL_ADMIN, PLAYERS_UNSURE, playersRefusal } from "@/lib/playersCopy";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { useRead } from "@/lib/useRead";
import { addOrProve } from "../detail/detailReadBack";
import { useComplaintFocus } from "./complaintFocus";

/**
 * The admin adding a player as the club: a member — invited, or placed as in without their
 * consent (which collects nothing) — a named guest, or an open link seat. A reason is required,
 * as for every god-mode act, and it lands in the change log.
 */
type Kind = "member" | "guest" | "link";

type Props = {
  detail: BookingDetail;
  onClose: () => void;
  /** `proven` — the new seat was found on the booking after an unsure reply (R3), and why (R19). */
  onAdded: (answer: AddPlayersAnswer, kind: Kind, proven: ProvenBy) => void;
  /** Read the booking again — a lost reply that did not land, or could not be checked (R3). */
  onStale?: () => void;
};

/** The seat this add would make, as the read-back looks for it. */
function pickOf(kind: Kind, form: Form) {
  if (kind === "member") return { kind: "member" as const, userId: form.userId ?? "" };
  if (kind === "guest") return { kind: "guest" as const, name: form.guest.trim() };
  return { kind: "link" as const };
}

function bodyOf(kind: Kind, form: Form): AdminAddPlayer {
  const reason = form.reason.trim();
  if (kind === "member") return { userId: form.userId ?? undefined, accepted: form.accepted, reason };
  if (kind === "guest") return { guestName: form.guest.trim(), reason };
  return { reason };
}

type Form = { userId: string | null; guest: string; accepted: boolean; reason: string };

function problemOf(kind: Kind, form: Form): "member" | "guest" | "reason" | null {
  if (kind === "member" && !form.userId) return "member";
  if (kind === "guest" && form.guest.trim() === "") return "guest";
  return form.reason.trim() === "" ? "reason" : null;
}

function useAddFlow({ detail, onAdded, onStale }: Props) {
  const [kind, setKind] = useState<Kind>("member");
  const [form, setForm] = useState<Form>({ userId: null, guest: "", accepted: false, reason: "" });
  const [tried, setTried] = useState(false);
  const [refused, setRefused] = useState(0);
  const loadMembers = useCallback(() => endpoints.adminMembers("Active"), []);
  const [members] = useRead("active-members", loadMembers);
  const onBooking = new Set(detail.players.map((p) => p.user_id).filter(Boolean));
  const list = (members.data ?? [])
    .filter((m) => !onBooking.has(m.user_id))
    // R16 J16-3 — namesakes read apart: the membership number and email under each name (admin only).
    .map((m) => ({ id: m.user_id, name: m.full_name, photoUrl: m.photo_url, subtitle: DETAIL_ADMIN.memberSubtitle(m.membership_number, m.email) }));
  // R3 lost-reply audit — a lost reply is looked for on the booking: a new seat for this pick.
  const add = useAsyncAction(
    () => addOrProve(detail, pickOf(kind, form), () => playersEndpoints.adminAdd(detail.booking_id, bodyOf(kind, form))),
    {
      success: (landed) => onAdded(landed.value, kind, provenBy(landed)),
      failure: (error) => { if (error instanceof UnsureOutcome) onStale?.(); },
    },
  );
  const problem = tried ? problemOf(kind, form) : null;
  const confirm = () => {
    setTried(true);
    if (problemOf(kind, form) === null) void add.run();
    else setRefused((n) => n + 1);
  };
  // R16 X16-3 — a refused add takes the keyboard to the first complaint.
  useComplaintFocus(refused, "[data-dialog='admin-add']");
  const patch = (next: Partial<Form>) => setForm((prev) => ({ ...prev, ...next }));
  return { kind, setKind, form, patch, members, list, add, problem, confirm };
}

type Flow = ReturnType<typeof useAddFlow>;

export function AdminAddDialog(props: Props) {
  const flow = useAddFlow(props);
  const labelId = useId();
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !flow.add.pending) props.onClose(); }}>
      <DialogContent data-dialog="admin-add">
        <DialogHeader>
          <DialogTitle>{DETAIL_ADMIN.addTitle}</DialogTitle>
          <DialogDescription>{`${DETAIL_ADMIN.addDescription} ${DETAIL_ADMIN.changeLog}`}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <p id={labelId} className="text-sm font-semibold text-text-primary">{DETAIL_ADMIN.addKind}</p>
          <RadioGroup value={flow.kind} onValueChange={(v) => flow.setKind(v as Kind)} aria-labelledby={labelId}>
            <RadioCard value="member" title={DETAIL_ADMIN.addMember} description={DETAIL_ADMIN.addMemberHint} />
            <RadioCard value="guest" title={DETAIL_ADMIN.addGuest} description={DETAIL_ADMIN.addGuestHint} />
            <RadioCard value="link" title={DETAIL_ADMIN.addLink} description={DETAIL_ADMIN.addLinkHint} />
          </RadioGroup>
          <KindDetail flow={flow} />
          <AddReason flow={flow} />
          {flow.add.error ? <Alert tone="danger">{playersRefusal(flow.add.error, { action: DETAIL_ADMIN.addAction, unsure: PLAYERS_UNSURE.adminAdd })}</Alert> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>{DETAIL_ADMIN.cancel}</Button>
          <Button pending={flow.add.pending} onClick={flow.confirm}>{DETAIL_ADMIN.addConfirm}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function KindDetail({ flow }: { flow: Flow }) {
  if (flow.kind === "guest") {
    return (
      <Field invalid={flow.problem === "guest"}>
        <FieldLabel>{DETAIL_ADMIN.guestLabel}</FieldLabel>
        <Input value={flow.form.guest} maxLength={64} onChange={(e) => flow.patch({ guest: e.target.value })} />
        {flow.problem === "guest" ? <FieldError>{DETAIL_ADMIN.guestMissing}</FieldError> : null}
      </Field>
    );
  }
  if (flow.kind !== "member") return null;
  return <MemberDetail flow={flow} />;
}

function MemberDetail({ flow }: { flow: Flow }) {
  const id = useId();
  const error = flow.members.error ? DETAIL_ADMIN.membersFailed : flow.problem === "member" ? DETAIL_ADMIN.memberMissing : null;
  return (
    <div className="flex flex-col gap-4">
      <MemberCombobox
        members={flow.list}
        loading={flow.members.loading}
        value={flow.form.userId}
        onChange={(userId) => flow.patch({ userId })}
        label={DETAIL_ADMIN.memberLabel}
        placeholder={DETAIL_ADMIN.memberPlaceholder}
        error={error}
      />
      <label htmlFor={id} className="flex min-h-touch items-start gap-3 rounded-xl border border-border bg-bg-surface p-4">
        <Checkbox id={id} checked={flow.form.accepted} onCheckedChange={(v) => flow.patch({ accepted: v === true })} className="mt-0.5" />
        <span className="grid gap-0.5 text-sm">
          <span className="font-semibold text-text-primary">{DETAIL_ADMIN.placeAccepted}</span>
          <span className="text-text-secondary">{DETAIL_ADMIN.placeAcceptedHint}</span>
        </span>
      </label>
    </div>
  );
}

function AddReason({ flow }: { flow: Flow }) {
  return (
    <Field invalid={flow.problem === "reason"}>
      <FieldLabel>{DETAIL_ADMIN.reasonLabel}</FieldLabel>
      <Textarea rows={2} maxLength={512} value={flow.form.reason} placeholder={DETAIL_ADMIN.reasonPlaceholder}
        onChange={(e) => flow.patch({ reason: e.target.value })} />
      <FieldDescription>{DETAIL_ADMIN.reasonHint}</FieldDescription>
      {flow.problem === "reason" ? <FieldError>{DETAIL_ADMIN.reasonMissing}</FieldError> : null}
    </Field>
  );
}
