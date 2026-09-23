import { CalendarBlank, QrCode, ShieldCheck, Wallet, type Icon } from "@/components/ui/icons";

/**
 * The product's top-level destinations, in order (R15: My Code is the landing, then Bookings,
 * then Wallet, then Admin). One list drives the desktop top bar and the phone's bottom tab bar —
 * they are the same `<nav>` restyled at `md`, so the two can never disagree.
 */
export type PrimaryDestination = {
  to: string;
  label: string;
  icon: Icon;
  adminOnly?: boolean;
};

export const PRIMARY_DESTINATIONS: readonly PrimaryDestination[] = [
  { to: "/my-code", label: "My Code", icon: QrCode },
  { to: "/bookings", label: "Bookings", icon: CalendarBlank },
  { to: "/wallet", label: "Wallet", icon: Wallet },
  { to: "/admin", label: "Admin", icon: ShieldCheck, adminOnly: true },
];

export function destinationsFor(isAdmin: boolean): PrimaryDestination[] {
  return PRIMARY_DESTINATIONS.filter((d) => isAdmin || !d.adminOnly);
}

/** Where a signed-in session lands (R15), and where the crest goes. */
export const LANDING_PATH = "/my-code";
