import { useId } from "react";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { MemberCombobox } from "@/components/ui/member-combobox";
import { RadioCard, RadioGroup } from "@/components/ui/radio-group";
import { BOOK_SHEET } from "@/lib/bookingsCopy";
import type { BookAs } from "./bookFlow";
import type { BookFlow } from "./useBookFlow";

/**
 * The desk's "book as" choice — self, a member, or a club hold — out of `BookSheet` so that only
 * an admin's sheet fetches it (R5, lane B's measured lead: the member combobox, cmdk and the
 * radio cards rode on every member's first Bookings visit). Loaded through `lazyParts`.
 */
export function BookAsChoice({ flow }: { flow: BookFlow }) {
  const { who, setWho } = flow;
  const pick = (kind: string) => {
    if (kind === who.kind) return;
    if (kind === "member") setWho({ kind: "member", userId: null });
    else if (kind === "hold") setWho({ kind: "hold", label: "" });
    else setWho({ kind: "self" });
  };
  const labelId = useId();
  return (
    <div className="grid gap-3">
      <p id={labelId} className="text-sm font-semibold text-text-primary">{BOOK_SHEET.bookAs}</p>
      <RadioGroup value={who.kind} onValueChange={pick} aria-labelledby={labelId}>
        <RadioCard value="self" title={BOOK_SHEET.asSelf} description={BOOK_SHEET.asSelfHint} />
        <RadioCard value="member" title={BOOK_SHEET.asMember} description={BOOK_SHEET.asMemberHint} />
        <RadioCard value="hold" title={BOOK_SHEET.asHold} description={BOOK_SHEET.asHoldHint} />
      </RadioGroup>
      <WhoDetail flow={flow} who={who} />
    </div>
  );
}

function WhoDetail({ flow, who }: { flow: BookFlow; who: BookAs }) {
  if (who.kind === "member") {
    return (
      <MemberCombobox
        members={flow.members.list}
        loading={flow.members.loading}
        value={who.userId}
        onChange={(id) => flow.setWho({ kind: "member", userId: id })}
        label={BOOK_SHEET.memberLabel}
        placeholder={BOOK_SHEET.memberPlaceholder}
        error={flow.problem === "member" ? BOOK_SHEET.memberMissing : null}
      />
    );
  }
  if (who.kind === "hold") {
    return (
      <Field invalid={flow.problem === "hold"}>
        <FieldLabel>{BOOK_SHEET.holdLabel}</FieldLabel>
        <Input
          value={who.label}
          maxLength={128}
          placeholder={BOOK_SHEET.holdPlaceholder}
          onChange={(e) => flow.setWho({ kind: "hold", label: e.target.value })}
        />
        {flow.problem === "hold" ? <FieldError>{BOOK_SHEET.holdMissing}</FieldError> : null}
      </Field>
    );
  }
  return null;
}
