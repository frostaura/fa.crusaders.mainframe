// Ambient module declaration for lucide-react.
//
// The installed lucide-react package ships its own .d.ts files inside `dist/esm/`, but our
// TypeScript module resolution chooses the CJS bundle at `dist/cjs/lucide-react.js` which has
// no adjacent declaration. The functional runtime is fine — every icon exports as a React
// component. This file just unblocks the type-check.
//
// If lucide-react is upgraded to a version that ships unified types, delete this file.

declare module "lucide-react" {
  import type { ComponentType, SVGProps } from "react";
  export type LucideProps = SVGProps<SVGSVGElement> & { size?: number | string; color?: string; strokeWidth?: number | string };
  export type LucideIcon = ComponentType<LucideProps>;
  // Catch-all for any named icon import.
  const _icons: { [iconName: string]: LucideIcon };
  export default _icons;
  // Re-export so `import { Camera } from "lucide-react"` works.
  export const Camera: LucideIcon;
  export const ChevronDown: LucideIcon;
  export const ChevronLeft: LucideIcon;
  export const ChevronRight: LucideIcon;
  export const ChevronUp: LucideIcon;
  export const Fingerprint: LucideIcon;
  export const Plus: LucideIcon;
  export const Search: LucideIcon;
  export const X: LucideIcon;
  export const Check: LucideIcon;
  export const Edit: LucideIcon;
  export const Eye: LucideIcon;
  export const EyeOff: LucideIcon;
  export const Mail: LucideIcon;
  export const Lock: LucideIcon;
  export const User: LucideIcon;
  export const Users: LucideIcon;
  export const Settings: LucideIcon;
  export const Trash: LucideIcon;
  export const Trash2: LucideIcon;
  export const AlertCircle: LucideIcon;
  export const AlertTriangle: LucideIcon;
  export const Info: LucideIcon;
  export const Calendar: LucideIcon;
  export const Clock: LucideIcon;
  export const CreditCard: LucideIcon;
  export const Wallet: LucideIcon;
  export const Home: LucideIcon;
  export const LogOut: LucideIcon;
  export const LogIn: LucideIcon;
  export const Loader: LucideIcon;
  export const Loader2: LucideIcon;
  export const Menu: LucideIcon;
  export const MoreHorizontal: LucideIcon;
  export const MoreVertical: LucideIcon;
  export const Filter: LucideIcon;
  export const Download: LucideIcon;
  export const Upload: LucideIcon;
  export const Image: LucideIcon;
  export const FileText: LucideIcon;
  export const Copy: LucideIcon;
  export const ExternalLink: LucideIcon;
  export const RefreshCw: LucideIcon;
  export const Save: LucideIcon;
  export const ArrowLeft: LucideIcon;
  export const ArrowRight: LucideIcon;
  export const ArrowUpDown: LucideIcon;
  export const ArrowUp: LucideIcon;
  export const ArrowDown: LucideIcon;
  export const Inbox: LucideIcon;
  export const Webhook: LucideIcon;
  export const KeyRound: LucideIcon;
  export const Key: LucideIcon;
  export const Activity: LucideIcon;
  export const BarChart: LucideIcon;
  export const PieChart: LucideIcon;
  export const LineChart: LucideIcon;
  export const Cog: LucideIcon;
  export const Tag: LucideIcon;
  export const ShieldCheck: LucideIcon;
  export const ShieldAlert: LucideIcon;
  export const Star: LucideIcon;
  export const Trophy: LucideIcon;
  export const Smartphone: LucideIcon;
  export const QrCode: LucideIcon;
  export const Cpu: LucideIcon;
  export const Radio: LucideIcon;
  export const Wifi: LucideIcon;
  export const WifiOff: LucideIcon;
  export const Ban: LucideIcon;
  export const MailWarning: LucideIcon;
  export const RotateCcw: LucideIcon;
  export const CalendarDays: LucideIcon;
  export const Facebook: LucideIcon;
  export const Instagram: LucideIcon;
  export const MapPin: LucideIcon;
  // doors: admin. `DoorClosed`, not `DoorOpen` — an open door is a state claim this product
  // cannot make, and the icon sits two lines above a page whose whole discipline is not
  // making it. `Printer` is the door card's one control.
  export const DoorClosed: LucideIcon;
  export const Printer: LucideIcon;
}

// NOTE FOR THE NEXT PERSON WHO ADDS AN ICON: you have to add it above.
//
// This file used to end with
//
//   // Fall-through for anything else — any other icon name resolves to LucideIcon.
//   const _fallback: { [icon: string]: LucideIcon };
//
// which does nothing at all. `const` inside an ambient module without `export` declares a local,
// and TypeScript has no way to express "any named export" for a module anyway. So the promised
// fall-through never existed, and importing an icon that is not listed above fails with
// "has no exported member" — pointing at lucide-react, which exports it perfectly well, rather
// than at this file, which is the thing actually refusing. That misdirection cost real time.
