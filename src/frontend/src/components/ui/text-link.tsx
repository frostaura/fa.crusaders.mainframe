import type { ComponentProps, ReactNode } from "react";
import { Link, type LinkProps } from "react-router-dom";
import { cn } from "@/lib/utils";
import { CaretRight } from "./icons";

/**
 * A link that looks like a link (design-system.md, Patterns → Buttons vs links).
 *
 * <p>
 * Navigation is a link; an action is a button. The product once dressed links as buttons and
 * buttons as links, and a member could not tell which would take them away from a half-filled
 * form. So there are exactly two looks for a link:
 * </p>
 * <ul>
 *   <li><b>inline</b> — in running text: underlined, accent, medium weight. The underline is the
 *   non-colour cue (colour is never the only signal).</li>
 *   <li><b>standalone</b> — on its own line ("See all bookings"): semibold, accent, trailing caret,
 *   a 44px-tall hit area, and the buttons' text size (`text-sm`), so it matches a button beside it.</li>
 * </ul>
 * <p>
 * A link that must look like a button is a navigation CTA only, and is written
 * `<Button asChild><Link …/></Button>` — never this component. `no-lift`: a link is not a card,
 * and the affordance layer's hover lift and shadow on a run of text read as a rendering fault.
 * Focus is the house `:focus-visible` outline.
 * </p>
 */
export type TextLinkVariant = "inline" | "standalone";

type Common = { variant?: TextLinkVariant; className?: string; children: ReactNode };

/** An in-app route, through react-router. */
export type TextLinkRouteProps = Common & Omit<LinkProps, "className" | "children"> & { href?: undefined };
/** A plain `<a href>` — a download, `mailto:`, another site. */
export type TextLinkAnchorProps = Common & Omit<ComponentProps<"a">, "className" | "children"> & { href: string };
export type TextLinkProps = TextLinkRouteProps | TextLinkAnchorProps;

const VARIANT: Record<TextLinkVariant, string> = {
  inline: "no-lift font-medium text-accent-strong underline decoration-1 underline-offset-2 hover:decoration-2",
  // text-sm (L12-4, round 12): the button scale's size. A standalone link sits beside buttons
  // ("Buy minutes" · "Open wallet") and inherited the body's 16px against their 14px.
  standalone: "no-lift inline-flex min-h-touch items-center gap-1 text-sm font-semibold text-accent-strong underline-offset-2 hover:underline",
};

function Content({ variant, label }: { variant: TextLinkVariant; label: ReactNode }) {
  if (variant === "inline") return <>{label}</>;
  return (
    <>
      <span className="min-w-0 break-words">{label}</span>
      <CaretRight size="1rem" weight="bold" aria-hidden="true" className="shrink-0" />
    </>
  );
}

export function TextLink(props: TextLinkProps) {
  const { variant = "inline", className, children, ...rest } = props;
  const classes = cn(VARIANT[variant], className);
  if (typeof rest.href === "string") {
    const anchor = rest as Omit<TextLinkAnchorProps, keyof Common>;
    return (
      <a {...anchor} className={classes} data-text-link={variant}>
        <Content variant={variant} label={children} />
      </a>
    );
  }
  const route = rest as Omit<TextLinkRouteProps, keyof Common>;
  return (
    <Link {...route} className={classes} data-text-link={variant}>
      <Content variant={variant} label={children} />
    </Link>
  );
}
