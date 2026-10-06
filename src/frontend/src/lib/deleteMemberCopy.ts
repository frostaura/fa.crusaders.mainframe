import { minutesSpoken } from "./minutes";

/**
 * Deleting a member (Dean, 2026-10-06: "should be able to delete an account, not just suspend it"),
 * in the words the members list's ⋯ and the member page's ⋯ both use.
 *
 * <p>
 * The confirm step says what the delete will actually do, read from the club first
 * (`GET …/delete-preview`): a member with history is erased and their bookings and minutes stay on
 * the books as "Deleted member"; one without is removed outright. Every refusal the server can
 * give is a sentence here, named from the admin's side.
 * </p>
 */
export const DELETE_MEMBER_COPY = {
  menu: "Delete member",
  title: (name: string) => `Delete ${name}?`,
  checking: "Checking what deleting them changes…",
  checkFailed: "Couldn't check what deleting them changes. Close this and try again.",
  erase:
    "Their name, email address, photo and sign-in are wiped, and they can't sign in again. Their bookings and minutes stay on the club's books as “Deleted member”, so the reports still add up. This can't be undone.",
  remove:
    "They have no bookings and no minutes, so their account is removed completely. This can't be undone.",
  bookings: (n: number) =>
    n === 1
      ? "1 booking of theirs that hasn't started is cancelled and refunded in full."
      : `${n} bookings of theirs that haven't started are cancelled and refunded in full.`,
  partnerGames: (n: number) => `They're taken off ${n === 1 ? "1 game" : `${n} games`} other members booked.`,
  purchases: (n: number) => `${n === 1 ? "1 package payment" : `${n} package payments`} still open at the payment page ${n === 1 ? "is" : "are"} closed.`,
  told: "They're emailed to say so before their address is wiped.",
  notTold: "They aren't emailed: the club never admitted them at an address they confirmed.",
  typeName: (name: string) => `Type ${name} to confirm`,
  reasonLabel: "Why are they being deleted?",
  reasonPlaceholder: "For the club's change record",
  reasonHint: "It goes on the club's change record, and in their email when they are sent one.",
  writeOff: (minutes: number) =>
    minutes > 0
      ? `Write off the ${minutesSpoken(minutes)} left on their balance`
      : `Clear the ${minutesSpoken(-minutes)} they owe`,
  writeOffHint: "It is recorded on the ledger as a correction, with your reason.",
  confirm: "Delete member",
  action: "delete the member",
  notReadyName: (name: string) => `Type ${name} exactly as shown to confirm.`,
  notReadyReason: "Say why they are being deleted — it goes on the club's change record.",
  notReadyWriteOff: "Tick the write-off — what is left on their balance can't stay on a deleted account.",
  deleted: (name: string) => `${name} has been deleted.`,
  deletedUnnotified: (name: string) => `${name} has been deleted, but the email couldn't be sent.`,
  alreadyDeleted: (name: string) => `${name} had already been deleted.`,
} as const;

/** The server's refusals, each in words (`AdminMemberDeleteEndpoints`). */
export const DELETE_MEMBER_REFUSALS: Readonly<Record<string, string>> = {
  cannot_delete_self: "You can't delete your own account. Ask another administrator.",
  admin_inherited_from_config:
    "This person is an administrator through the server's configuration, so they can't be deleted here. Ask whoever runs the server to remove them from it first.",
  last_admin: "They are the club's only administrator. Make somebody else an administrator first.",
  share_return_uncovered:
    "They have paid into a game whose organiser can't cover handing it back. Sort that game out on its booking first.",
  balance_write_off_required: "Their balance changed while you were deciding. Check the write-off below and try again.",
  member_not_found: "That member is no longer on the club's books.",
};
