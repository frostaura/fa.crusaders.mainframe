/**
 * The icon barrel — the ONLY module in the product that imports `@phosphor-icons/react`.
 *
 * <p>
 * Per-icon paths (`dist/csr/<Name>`), never the package root: the root re-exports all ~1 500
 * icons and leaves tree-shaking to chance. ESLint's `no-restricted-imports` forbids the package
 * everywhere except this file, and `src/icons.test.ts` scans the tree for the same rule, so a
 * second import path cannot appear without something going red.
 * </p>
 *
 * <p>
 * <b>Adding an icon:</b> append ONE line in the same shape — both the `<Name>Icon` export and the
 * short `<Name>` alias — and never reorder or delete lines other people depend on. Sizes and
 * weights by context are in `docs/specs/design-system.md` (Icons): 16 in buttons, inputs, badges
 * and menus; 20 for icon buttons and list leads (the default); 24 in the mobile tab bar.
 * </p>
 */
import type { IconProps } from "@phosphor-icons/react/dist/lib/types";

export { IconContext } from "@phosphor-icons/react/dist/lib/context";
export type { Icon, IconProps, IconWeight } from "@phosphor-icons/react/dist/lib/types";

/**
 * The product-wide defaults, provided once at the root (`main.tsx`) through `IconContext`:
 * regular weight, 20px, the text colour of whatever the icon sits in. A use site overrides
 * `size`/`weight` for its context; it never restates the defaults.
 */
export const ICON_DEFAULTS: IconProps = { size: 20, weight: "regular", color: "currentColor", mirrored: false };

export { ArrowsClockwiseIcon, ArrowsClockwiseIcon as ArrowsClockwise } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
export { CheckIcon, CheckIcon as Check } from "@phosphor-icons/react/dist/csr/Check";
export { XIcon, XIcon as X } from "@phosphor-icons/react/dist/csr/X";
export { CaretLeftIcon, CaretLeftIcon as CaretLeft } from "@phosphor-icons/react/dist/csr/CaretLeft";
export { CaretRightIcon, CaretRightIcon as CaretRight } from "@phosphor-icons/react/dist/csr/CaretRight";
export { CaretDownIcon, CaretDownIcon as CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown";
export { CaretUpIcon, CaretUpIcon as CaretUp } from "@phosphor-icons/react/dist/csr/CaretUp";
export { CalendarDotsIcon, CalendarDotsIcon as CalendarDots } from "@phosphor-icons/react/dist/csr/CalendarDots";
export { CheckSquareIcon, CheckSquareIcon as CheckSquare } from "@phosphor-icons/react/dist/csr/CheckSquare";
export { SquareIcon, SquareIcon as Square } from "@phosphor-icons/react/dist/csr/Square";
export { PlusIcon, PlusIcon as Plus } from "@phosphor-icons/react/dist/csr/Plus";
export { MinusIcon, MinusIcon as Minus } from "@phosphor-icons/react/dist/csr/Minus";
export { MagnifyingGlassIcon, MagnifyingGlassIcon as MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
export { InfoIcon, InfoIcon as Info } from "@phosphor-icons/react/dist/csr/Info";
export { WarningIcon, WarningIcon as Warning } from "@phosphor-icons/react/dist/csr/Warning";
export { WarningCircleIcon, WarningCircleIcon as WarningCircle } from "@phosphor-icons/react/dist/csr/WarningCircle";
export { CircleNotchIcon, CircleNotchIcon as CircleNotch } from "@phosphor-icons/react/dist/csr/CircleNotch";
export { FingerprintIcon, FingerprintIcon as Fingerprint } from "@phosphor-icons/react/dist/csr/Fingerprint";
export { FingerprintSimpleIcon, FingerprintSimpleIcon as FingerprintSimple } from "@phosphor-icons/react/dist/csr/FingerprintSimple";
export { UserIcon, UserIcon as User } from "@phosphor-icons/react/dist/csr/User";
export { UsersIcon, UsersIcon as Users } from "@phosphor-icons/react/dist/csr/Users";
export { UserCircleIcon, UserCircleIcon as UserCircle } from "@phosphor-icons/react/dist/csr/UserCircle";
export { GearIcon, GearIcon as Gear } from "@phosphor-icons/react/dist/csr/Gear";
export { SignOutIcon, SignOutIcon as SignOut } from "@phosphor-icons/react/dist/csr/SignOut";
export { SunIcon, SunIcon as Sun } from "@phosphor-icons/react/dist/csr/Sun";
export { MoonIcon, MoonIcon as Moon } from "@phosphor-icons/react/dist/csr/Moon";
export { DesktopIcon, DesktopIcon as Desktop } from "@phosphor-icons/react/dist/csr/Desktop";
export { HouseIcon, HouseIcon as House } from "@phosphor-icons/react/dist/csr/House";
export { QrCodeIcon, QrCodeIcon as QrCode } from "@phosphor-icons/react/dist/csr/QrCode";
export { CalendarBlankIcon, CalendarBlankIcon as CalendarBlank } from "@phosphor-icons/react/dist/csr/CalendarBlank";
export { WalletIcon, WalletIcon as Wallet } from "@phosphor-icons/react/dist/csr/Wallet";
export { ShieldCheckIcon, ShieldCheckIcon as ShieldCheck } from "@phosphor-icons/react/dist/csr/ShieldCheck";
export { BellIcon, BellIcon as Bell } from "@phosphor-icons/react/dist/csr/Bell";
export { DotsThreeIcon, DotsThreeIcon as DotsThree } from "@phosphor-icons/react/dist/csr/DotsThree";
export { DotsThreeVerticalIcon, DotsThreeVerticalIcon as DotsThreeVertical } from "@phosphor-icons/react/dist/csr/DotsThreeVertical";
export { TrashIcon, TrashIcon as Trash } from "@phosphor-icons/react/dist/csr/Trash";
export { PencilSimpleIcon, PencilSimpleIcon as PencilSimple } from "@phosphor-icons/react/dist/csr/PencilSimple";
export { CopyIcon, CopyIcon as Copy } from "@phosphor-icons/react/dist/csr/Copy";
export { EyeIcon, EyeIcon as Eye } from "@phosphor-icons/react/dist/csr/Eye";
export { EyeSlashIcon, EyeSlashIcon as EyeSlash } from "@phosphor-icons/react/dist/csr/EyeSlash";
export { LockIcon, LockIcon as Lock } from "@phosphor-icons/react/dist/csr/Lock";
export { LockOpenIcon, LockOpenIcon as LockOpen } from "@phosphor-icons/react/dist/csr/LockOpen";
export { WifiSlashIcon, WifiSlashIcon as WifiSlash } from "@phosphor-icons/react/dist/csr/WifiSlash";
export { DoorIcon, DoorIcon as Door } from "@phosphor-icons/react/dist/csr/Door";
export { LightbulbIcon, LightbulbIcon as Lightbulb } from "@phosphor-icons/react/dist/csr/Lightbulb";
export { ChartBarIcon, ChartBarIcon as ChartBar } from "@phosphor-icons/react/dist/csr/ChartBar";
export { ReceiptIcon, ReceiptIcon as Receipt } from "@phosphor-icons/react/dist/csr/Receipt";
export { ListChecksIcon, ListChecksIcon as ListChecks } from "@phosphor-icons/react/dist/csr/ListChecks";
export { FunnelIcon, FunnelIcon as Funnel } from "@phosphor-icons/react/dist/csr/Funnel";
export { DownloadSimpleIcon, DownloadSimpleIcon as DownloadSimple } from "@phosphor-icons/react/dist/csr/DownloadSimple";
export { ArrowLeftIcon, ArrowLeftIcon as ArrowLeft } from "@phosphor-icons/react/dist/csr/ArrowLeft";
export { ArrowRightIcon, ArrowRightIcon as ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";
export { ClockIcon, ClockIcon as Clock } from "@phosphor-icons/react/dist/csr/Clock";
export { RacquetIcon, RacquetIcon as Racquet } from "@phosphor-icons/react/dist/csr/Racquet";
export { HandTapIcon, HandTapIcon as HandTap } from "@phosphor-icons/react/dist/csr/HandTap";
export { KeyIcon, KeyIcon as Key } from "@phosphor-icons/react/dist/csr/Key";
export { ProhibitIcon, ProhibitIcon as Prohibit } from "@phosphor-icons/react/dist/csr/Prohibit";
export { ArrowCounterClockwiseIcon, ArrowCounterClockwiseIcon as ArrowCounterClockwise } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
export { CreditCardIcon, CreditCardIcon as CreditCard } from "@phosphor-icons/react/dist/csr/CreditCard";
export { EnvelopeIcon, EnvelopeIcon as Envelope } from "@phosphor-icons/react/dist/csr/Envelope";
export { QuestionIcon, QuestionIcon as Question } from "@phosphor-icons/react/dist/csr/Question";
export { SparkleIcon, SparkleIcon as Sparkle } from "@phosphor-icons/react/dist/csr/Sparkle";
export { TrophyIcon, TrophyIcon as Trophy } from "@phosphor-icons/react/dist/csr/Trophy";
export { FireIcon, FireIcon as Fire } from "@phosphor-icons/react/dist/csr/Fire";
export { MedalIcon, MedalIcon as Medal } from "@phosphor-icons/react/dist/csr/Medal";
export { CheckCircleIcon, CheckCircleIcon as CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
export { SquaresFourIcon, SquaresFourIcon as SquaresFour } from "@phosphor-icons/react/dist/csr/SquaresFour";
export { UsersThreeIcon, UsersThreeIcon as UsersThree } from "@phosphor-icons/react/dist/csr/UsersThree";
export { GaugeIcon, GaugeIcon as Gauge } from "@phosphor-icons/react/dist/csr/Gauge";
export { CpuIcon, CpuIcon as Cpu } from "@phosphor-icons/react/dist/csr/Cpu";
export { ClockCounterClockwiseIcon, ClockCounterClockwiseIcon as ClockCounterClockwise } from "@phosphor-icons/react/dist/csr/ClockCounterClockwise";
export { RepeatIcon, RepeatIcon as Repeat } from "@phosphor-icons/react/dist/csr/Repeat";
export { WebhooksLogoIcon, WebhooksLogoIcon as WebhooksLogo } from "@phosphor-icons/react/dist/csr/WebhooksLogo";
export { SealCheckIcon, SealCheckIcon as SealCheck } from "@phosphor-icons/react/dist/csr/SealCheck";
export { CaretUpDownIcon, CaretUpDownIcon as CaretUpDown } from "@phosphor-icons/react/dist/csr/CaretUpDown";
export { WifiHighIcon, WifiHighIcon as WifiHigh } from "@phosphor-icons/react/dist/csr/WifiHigh";
export { PrinterIcon, PrinterIcon as Printer } from "@phosphor-icons/react/dist/csr/Printer";
export { MapPinIcon, MapPinIcon as MapPin } from "@phosphor-icons/react/dist/csr/MapPin";
export { ArrowSquareOutIcon, ArrowSquareOutIcon as ArrowSquareOut } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
export { FacebookLogoIcon, FacebookLogoIcon as FacebookLogo } from "@phosphor-icons/react/dist/csr/FacebookLogo";
export { InstagramLogoIcon, InstagramLogoIcon as InstagramLogo } from "@phosphor-icons/react/dist/csr/InstagramLogo";
export { CompassIcon, CompassIcon as Compass } from "@phosphor-icons/react/dist/csr/Compass";
export { CameraIcon, CameraIcon as Camera } from "@phosphor-icons/react/dist/csr/Camera";
export { BookOpenIcon, BookOpenIcon as BookOpen } from "@phosphor-icons/react/dist/csr/BookOpen";
export { PhoneIcon, PhoneIcon as Phone } from "@phosphor-icons/react/dist/csr/Phone";
export { UserFocusIcon, UserFocusIcon as UserFocus } from "@phosphor-icons/react/dist/csr/UserFocus";
export { TrayIcon, TrayIcon as Tray } from "@phosphor-icons/react/dist/csr/Tray";
export { CoinsIcon, CoinsIcon as Coins } from "@phosphor-icons/react/dist/csr/Coins";
export { XCircleIcon, XCircleIcon as XCircle } from "@phosphor-icons/react/dist/csr/XCircle";
export { ArchiveIcon, ArchiveIcon as Archive } from "@phosphor-icons/react/dist/csr/Archive";
export { LinkBreakIcon, LinkBreakIcon as LinkBreak } from "@phosphor-icons/react/dist/csr/LinkBreak";
export { UserMinusIcon, UserMinusIcon as UserMinus } from "@phosphor-icons/react/dist/csr/UserMinus";
export { UserPlusIcon, UserPlusIcon as UserPlus } from "@phosphor-icons/react/dist/csr/UserPlus";
export { ArrowDownIcon, ArrowDownIcon as ArrowDown } from "@phosphor-icons/react/dist/csr/ArrowDown";
export { PasswordIcon, PasswordIcon as Password } from "@phosphor-icons/react/dist/csr/Password";
export { DeviceMobileIcon, DeviceMobileIcon as DeviceMobile } from "@phosphor-icons/react/dist/csr/DeviceMobile";
export { ExportIcon, ExportIcon as Export } from "@phosphor-icons/react/dist/csr/Export";
export { HandWavingIcon, HandWavingIcon as HandWaving } from "@phosphor-icons/react/dist/csr/HandWaving";
export { MapTrifoldIcon, MapTrifoldIcon as MapTrifold } from "@phosphor-icons/react/dist/csr/MapTrifold";
export { CircleIcon, CircleIcon as Circle } from "@phosphor-icons/react/dist/csr/Circle";
export { LightningIcon, LightningIcon as Lightning } from "@phosphor-icons/react/dist/csr/Lightning";
export { TagIcon, TagIcon as Tag } from "@phosphor-icons/react/dist/csr/Tag";
export { ShieldWarningIcon, ShieldWarningIcon as ShieldWarning } from "@phosphor-icons/react/dist/csr/ShieldWarning";
export { SlidersHorizontalIcon, SlidersHorizontalIcon as SlidersHorizontal } from "@phosphor-icons/react/dist/csr/SlidersHorizontal";
