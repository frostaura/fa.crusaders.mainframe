import { Avatar, AvatarFallback, AvatarImage, type AvatarSize } from "@/components/ui/avatar";
import { initialsOf } from "@/lib/initials";

/**
 * A player's face, or their initials — decorative beside the name that is always written next
 * to it, so it is hidden from assistive tech rather than read twice.
 */
export function PlayerAvatar({ name, photo, size = 32 }: { name: string; photo: string | null; size?: AvatarSize }) {
  return (
    <Avatar size={size} aria-hidden="true" className="shrink-0">
      {photo ? <AvatarImage src={photo} alt="" /> : null}
      <AvatarFallback aria-hidden="true">{initialsOf(name)}</AvatarFallback>
    </Avatar>
  );
}
