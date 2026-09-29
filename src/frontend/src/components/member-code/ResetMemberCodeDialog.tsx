import { ConfirmDialog } from "@/components/admin/ConfirmDialog";
import { useResetMemberCodeConfirm } from "./useResetMemberCodeConfirm";

/** The same confirm, opened from somewhere other than its own trigger — the Members row ⋯. */
export function ResetMemberCodeDialog({ name, membershipId, onOpenChange, returnFocus }: {
  name: string; membershipId: string;
  onOpenChange: (open: boolean) => void;
  returnFocus?: () => HTMLElement | null | undefined;
}) {
  const confirm = useResetMemberCodeConfirm(name, membershipId, () => onOpenChange(false));
  return <ConfirmDialog open onOpenChange={onOpenChange} returnFocus={returnFocus} tone="danger" {...confirm} />;
}
