import { Avatar, AvatarFallback, AvatarImage, type AvatarSize } from "@/components/ui/avatar";

/**
 * A player's face, or their initials — decorative beside the name that is always written next
 * to it, so it is hidden from assistive tech rather than read twice.
 */
export function PlayerAvatar({ name, photo, size = 32 }: { name: string; photo: string | null; size?: AvatarSize }) {
  return (
    <Avatar size={size} aria-hidden="true" className="shrink-0">
      {photo ? <AvatarImage src={photo} alt="" /> : null}
      <AvatarFallback aria-hidden="true">{initials(name)}</AvatarFallback>
    </Avatar>
  );
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = Array.from(words[0])[0] ?? "";
  const last = words.length > 1 ? Array.from(words[words.length - 1])[0] ?? "" : "";
  return (first + last).toLocaleUpperCase();
}
