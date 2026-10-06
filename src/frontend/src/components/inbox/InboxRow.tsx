import { useId, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Bell, CaretRight } from "@/components/ui/icons";
import { clubInstant } from "@/lib/clubClock";
import type { MemberNotification } from "@/lib/playersApi";
import { INBOX_COPY as COPY } from "@/lib/playersCopy";
import { useToast } from "@/components/toastContext";
import { describeFailure } from "@/lib/errors";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { failureOf, knownUnchanged, markReadOrProve } from "./inboxReadBack";
import { cn } from "@/lib/utils";
import { keepFiguresWhole } from "@/components/ui/figure-text";
import { appPath, inboxWhen, KIND_ICON, kindWord } from "./notificationKinds";
import type { InboxFeed } from "./useInbox";
import type { InboxPick } from "./InboxList";

/**
 * One notice. With a link, the whole row is ONE link (it navigates) and opening it marks the
 * notice read; without one, the row is plain text with a "Mark read" button while it is unread.
 *
 * <p>
 * Unread is never colour alone: a dot, the headline in bold, and a visually hidden "Unread" in
 * the row's description.
 * </p>
 */
export function InboxRow(props: { notice: MemberNotification; now: number; feed: InboxFeed; pick?: InboxPick }) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { notice, now, feed, pick } = props;
  const unread = feed.isUnread(notice);
  const to = appPath(notice.link);
  const headlineId = useId();
  const metaId = useId();
  const action = !to && unread ? <MarkReadButton notice={notice} feed={feed} describedBy={headlineId} /> : null;
  const body = <RowBody notice={notice} now={now} unread={unread} ids={{ headlineId, metaId }} trailing={Boolean(to)} action={action} />;
  const row = cn(ROW, to ? "grid-cols-[auto_minmax(0,1fr)_auto]" : "grid-cols-[auto_minmax(0,1fr)]");
  return (
    <li data-notification={notice.kind} data-unread={unread || undefined} className={cn("[container-type:inline-size]", unread && "bg-accent-soft/40")}>
      {to ? (
        <Link
          to={to}
          onClick={(event) => {
            feed.openedUnread(notice);
            // Beside a pane the target opens there; a modified click still opens the page.
            if (pick && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
              event.preventDefault();
              pick.onPick(notice);
            }
          }}
          data-split-item=""
          aria-current={pick?.id === notice.id ? "true" : undefined}
          // R19 L19-3 — named by the notice's words as written; the headline's paint glues figures.
          aria-label={notice.headline}
          aria-describedby={metaId}
          // R5 X5-7 — the picked row is marked by an EDGE, as Invites marks its card: the tint alone
          // was ~1.15:1 and forced colours drop it; a border survives them (as CanvasText).
          className={cn(row, pick?.id === notice.id && PICKED, "no-underline transition-colors duration-fast ease-standard hover:bg-bg-muted motion-reduce:transition-none")}
        >
          {body}
        </Link>
      ) : (
        <div className={row}>{body}</div>
      )}
    </li>
  );
}

/**
 * R4 V4-4 — the row is a grid measured against its OWN width (a container query, in rem, so it
 * follows the text size). Wide enough: icon · words · caret on one line. At 200 % text on a phone
 * the 80 px icon tile left the headline ~110 px. There the icon is its bare glyph beside the kind
 * and time, the caret goes (the whole row is the link), and the headline takes the row's whole
 * width under them.
 */
/**
 * The 4px edge takes 4px of the row's start padding, so the words do not move when it is picked.
 * Only the picked row carries a border class: in forced colours `index.css` frames every link whose
 * class names a border, so an always-present `aria-[current=true]:border-…` framed EVERY row.
 */
const PICKED = "border-l-4 border-accent-strong bg-accent-soft pl-1.5 [@container(min-width:17rem)]:pl-3";
// R8 L8-11 — the gutters step down on a narrow row (a phone at 200 %): half the padding and gap,
// so they stay the pixels they are at normal text instead of doubling and taking the words' room.
const ROW = "grid min-h-touch w-full items-start gap-x-1.5 gap-y-1 px-2 py-3 text-left [@container(min-width:17rem)]:gap-x-3 [@container(min-width:17rem)]:px-4";
// Whole class names, never built from parts: Tailwind finds classes by reading the source text.
const ICON = "relative col-start-1 row-start-1 inline-flex shrink-0 items-center justify-center gap-1.5 self-center rounded-full text-text-secondary [@container(min-width:17rem)]:row-span-3 [@container(min-width:17rem)]:size-10 [@container(min-width:17rem)]:self-start [@container(min-width:17rem)]:bg-bg-muted";
// Beside the bare glyph, not over it: a rem dot on a 20 px glyph hid it at large text.
const DOT = "size-3 shrink-0 rounded-full bg-accent-strong ring-2 ring-bg-surface [@container(min-width:17rem)]:absolute [@container(min-width:17rem)]:-right-0.5 [@container(min-width:17rem)]:-top-0.5";
const HEAD = "col-span-full row-start-2 flex min-w-0 flex-col gap-1 pt-1 [@container(min-width:17rem)]:col-span-1 [@container(min-width:17rem)]:col-start-2 [@container(min-width:17rem)]:row-start-1 [@container(min-width:17rem)]:pt-0";
const META = "row-start-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 self-center text-sm text-text-secondary [grid-column:2/-1] [@container(min-width:17rem)]:row-start-2 [@container(min-width:17rem)]:self-start [@container(min-width:17rem)]:[grid-column:2/3]";
const ACTION = "col-span-full row-start-3 flex pt-1 [@container(min-width:17rem)]:col-span-1 [@container(min-width:17rem)]:col-start-2";
const CARET = "col-start-3 row-start-1 mt-3 hidden shrink-0 justify-self-end text-text-muted [@container(min-width:17rem)]:block";
// R8 L8-11 — under 17rem (a phone at 200 %) the time takes a line of its own beside the glyph and
// the "·" goes: squeezed beside the kind, the time broke after its comma and the separator was
// left dangling at the end of "Reply ·". From 17rem: "Reply · Today, 08:44" on one line.
const WHEN = "basis-full [@container(min-width:17rem)]:basis-auto [@container(min-width:17rem)]:whitespace-nowrap";
const SEPARATOR = "hidden [@container(min-width:17rem)]:inline";
// R14 L14-3 — on a narrow row the headline steps down: a 17-letter surname ("Featherstonehaugh")
// was 281px at 32px in the 222px a 320 phone's row holds at 200 %, and broke mid-word — the line was
// already its own, and Chromium's `hyphens: auto` never splits a Capitalised word. Under 10rem
// (320 / 200 %) it is text-xs, 211px; to 17rem (390 / 200 %) text-sm; from 17rem the body size.
// One rule per range (gotchas-frontend-layout), each class whole.
const HEADLINE = "break-words text-xs [@container(min-width:10rem)_and_(max-width:16.99rem)]:text-sm [@container(min-width:17rem)]:text-base";

type BodyProps = {
  notice: MemberNotification;
  now: number;
  unread: boolean;
  ids: { headlineId: string; metaId: string };
  trailing: boolean;
  /** Under the text: the "Mark read" button of a notice that opens nowhere. */
  action: ReactNode;
};

function RowBody(props: BodyProps) {
  const { notice, now, unread, ids, trailing, action } = props;
  // Unknown kinds get the bell.
  const KindIcon = KIND_ICON[notice.kind] ?? Bell;
  const resolved = Boolean(notice.resolved_at);
  const word = resolved ? COPY.resolved : kindWord(notice.kind);
  return (
    <>
      <span aria-hidden="true" className={ICON}>
        <KindIcon size="1.25rem" />
        {unread ? <span data-unread-dot="" className={DOT} /> : null}
      </span>
      <span className={HEAD}>
        <span id={ids.headlineId} className={cn(HEADLINE, resolved ? "text-text-secondary" : "text-text-primary", unread ? "font-bold" : "font-medium")}>
          {/* R19 L19-3 — "15 minutes" never ends one line with "15" and starts the next with "minutes". */}
          {keepFiguresWhole(notice.headline)}
        </span>
        {resolved ? <span data-resolved="" className="text-sm text-text-secondary">{COPY.resolvedHint}</span> : null}
      </span>
      <span id={ids.metaId} className={META}>
        {unread ? <span className="sr-only">{`${COPY.unread}. `}</span> : null}
        {word ? <Meta>{word}</Meta> : null}
        {word ? <span aria-hidden="true" className={SEPARATOR}>·</span> : null}
        <time dateTime={notice.created_at} title={clubInstant(notice.created_at)} className={WHEN}>
          {inboxWhen(notice.created_at, now)}
        </time>
      </span>
      {action ? <span className={ACTION}>{action}</span> : null}
      {trailing ? <CaretRight size="1rem" weight="bold" aria-hidden="true" className={CARET} /> : null}
    </>
  );
}

/** A kind word followed by a spoken comma, so "Invite, Today, 18:05" is not one run-on phrase. */
function Meta({ children }: { children: ReactNode }) {
  return (
    <span className="break-words">
      {children}
      <span className="sr-only">,</span>
    </span>
  );
}

function MarkReadButton({ notice, feed, describedBy }: { notice: MemberNotification; feed: InboxFeed; describedBy: string }) {
  const toast = useToast();
  // Lost-reply audit (R3): a lost reply is read back; "Nothing changed" only when it is known.
  const action = useAsyncAction(() => markReadOrProve(notice.id), {
    optimistic: { apply: () => feed.noteRead(notice, true), rollback: () => feed.noteRead(notice, false) },
    failure: (error) => {
      const unchanged = knownUnchanged(error);
      toast.push({ tone: "danger", text: unchanged ? describeFailure(failureOf(error), { action: COPY.markOneAction }) : COPY.markUnknown, unchanged });
    },
  });
  return (
    <Button
      size="sm"
      variant="outline"
      pending={action.pending}
      aria-describedby={describedBy}
      onClick={() => void action.run()}
    >
      {COPY.markOne}
    </Button>
  );
}
