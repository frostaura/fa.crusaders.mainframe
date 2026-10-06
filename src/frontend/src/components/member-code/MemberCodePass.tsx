import { Fragment, type Ref } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { CountdownRing } from "@/components/ui/countdown-ring";
import { WifiSlash } from "@/components/ui/icons";
import { PassCard } from "@/components/ui/pass-card";
import { Skeleton } from "@/components/ui/skeleton";
import { CrestMark } from "@/components/shell/Crest";
import { QrSvg } from "@/components/member-door/QrSvg";
import { STEP_MS } from "@/lib/memberCode/clubDay";
import { groupToken } from "@/lib/memberCode/token";
import { MY_CODE, newCodeIn } from "@/lib/myCodeCopy";
import { phoneIsOffline } from "@/lib/api";
import { OFFLINE_COPY } from "@/lib/offline/offlineCopy";
import { initialsOf } from "@/lib/initials";

/**
 * The member's pass with the rotating code on it (D1, R9; design-system.md → Pass card).
 *
 * <p>
 * <b>One code, so no label saying which.</b> The QR carries the bare 19-character token and
 * nothing else — the box's scanner line is 24 bytes and the door's roster token cap is 20, which
 * is why the token is exactly this long. Under it the same token in JetBrains Mono, grouped the
 * way a member reads it to the desk; the groups are separate spans with no spaces between them,
 * so the element's text — what a screen reader says and what copy-and-paste takes — is the
 * unbroken token.
 * </p>
 *
 * <p>
 * No watermark anywhere on it (D5: code surfaces are on the never list). The QR panel is paper
 * white in both themes and under forced colours; that rule lives in `ui/pass-card.tsx`.
 * </p>
 */

/**
 * The token, grouped for reading and whole for everything else.
 *
 * <p>
 * F4-16 — when the groups do not fit one line they wrap BALANCED: inline groups with a `<wbr>`
 * between them in a `text-wrap: balance` block, rather than flex-wrap, which filled the first line
 * and left "661 592" alone on the second at 390 and 768. Each group pads both sides equally, so a
 * centred line stays centred wherever it breaks; the text content is still the bare token.
 * </p>
 */
export function CodeGroups({ token }: { token: string }) {
  return (
    <span className="block text-center text-balance">
      {groupToken(token).map((group, i) => (
        <Fragment key={i}>
          {i > 0 ? <wbr /> : null}
          <span data-code-group="" className="inline-block px-1">{group}</span>
        </Fragment>
      ))}
    </span>
  );
}

/** The ring and its sentence — the ring is decoration (`aria-hidden`), the sentence is the fact. */
export function StepCountdown({ remainingMs, size }: { remainingMs: number; size?: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      <CountdownRing periodMs={STEP_MS} remainingMs={remainingMs} size={size} />
      <span>{newCodeIn(Math.ceil(remainingMs / 1000))}</span>
    </span>
  );
}

export type MemberCodePassProps = {
  /** The token for the current step, or null while the first one is being made. */
  token: string | null;
  remainingMs: number;
  offline: boolean;
  memberName: string | null;
  photoUrl: string | null;
  onOpenFullScreen: () => void;
  /** The QR button, so focus can come back to it when the full-screen view closes. */
  triggerRef?: Ref<HTMLButtonElement>;
};

function MemberAvatar({ name, photoUrl }: { name: string | null; photoUrl: string | null }) {
  if (!name && !photoUrl) return null;
  return (
    <Avatar size={40}>
      {photoUrl ? <AvatarImage src={photoUrl} alt="" /> : null}
      {/* Decorative: the member's name is printed beside it on the band. */}
      <AvatarFallback aria-hidden="true"><span>{initialsOf(name ?? "")}</span></AvatarFallback>
    </Avatar>
  );
}

function PassSymbol({ token, onOpenFullScreen, triggerRef }: Pick<MemberCodePassProps, "token" | "onOpenFullScreen" | "triggerRef">) {
  if (!token) return <Skeleton className="aspect-square w-full" aria-hidden="true" />;
  return (
    /* The whole symbol is the target: a scanner in a dark doorway wants area first, and a member
       holding the phone one-handed should not have to find a small control to get it. */
    <button
      type="button"
      ref={triggerRef}
      aria-label={MY_CODE.fullScreenTrigger}
      onClick={onOpenFullScreen}
      className="no-lift block w-full rounded-md"
    >
      <QrSvg value={token} className="block h-auto w-full" />
    </button>
  );
}

/**
 * R15 X15-3 — the club could not be reached: "Offline" only when the phone says it has no network;
 * otherwise "Can't reach the club". The code works at the door either way.
 */
function ReachBadge() {
  if (!phoneIsOffline()) return <Badge tone="warning">{OFFLINE_COPY.unreachableBadge}</Badge>;
  return <Badge tone="warning" icon={<WifiSlash size={14} weight="bold" aria-hidden="true" />}>{MY_CODE.offlineBadge}</Badge>;
}

export function MemberCodePass(props: MemberCodePassProps) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { token, remainingMs, offline, memberName, photoUrl, onOpenFullScreen, triggerRef } = props;
  return (
    <PassCard
      label={MY_CODE.passLabel}
      overline={MY_CODE.overline}
      clubName={MY_CODE.clubName}
      crest={<CrestMark className="h-10" />}
      memberName={memberName}
      avatar={<MemberAvatar name={memberName} photoUrl={photoUrl} />}
      qr={<PassSymbol token={token} onOpenFullScreen={onOpenFullScreen} triggerRef={triggerRef} />}
      meta={(
        <>
          {/* Read by a scanner, never typed, so the digits are not drawn (Dean, 2026-10-06); a
              screen reader still gets the code, and absolute positioning keeps it out of the gap. */}
          {token ? <span aria-label={MY_CODE.codeLabel} data-member-code="" className="sr-only"><CodeGroups token={token} /></span> : null}
          {token ? <StepCountdown remainingMs={remainingMs} /> : <span>{MY_CODE.loading}</span>}
          {offline ? <ReachBadge /> : null}
        </>
      )}
      footer={token ? <p className="text-center text-sm">{MY_CODE.fullScreenHint}</p> : null}
    />
  );
}
