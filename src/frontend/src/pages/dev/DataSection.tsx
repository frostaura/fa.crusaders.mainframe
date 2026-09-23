import { Avatar, AvatarFallback, type AvatarSize } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Check, Lock, Warning, WifiSlash } from "@/components/ui/icons";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCredits } from "@/lib/utils";
import { Demo, Specimen, ThemePair } from "./parts";

/** Table, badges, avatars and card parts. */

type Row = { name: string; group: string; balance: number; status: "Active" | "Pending" | "Suspended" };

const ROWS: readonly Row[] = [
  { name: "Nomsa Khumalo", group: "League", balance: 274.25, status: "Active" },
  { name: "Sam Smith", group: "Social", balance: 48, status: "Pending" },
  { name: "Pieter van der Merwe", group: "Junior", balance: -16, status: "Suspended" },
];

const STATUS_TONE = { Active: "success", Pending: "warning", Suspended: "danger" } as const;

function MemberRow({ row }: { row: Row }) {
  const negative = row.balance < 0;
  return (
    <TableRow>
      <TableCell className="font-medium">{row.name}</TableCell>
      <TableCell>{row.group}</TableCell>
      <TableCell className={negative ? "text-right tabular-nums text-danger-strong" : "text-right tabular-nums"}>
        {formatCredits(row.balance)}
      </TableCell>
      <TableCell><Badge tone={STATUS_TONE[row.status]}>{row.status}</Badge></TableCell>
    </TableRow>
  );
}

function MembersTable() {
  return (
    <Table containerClassName="rounded-xl border border-border bg-bg-surface">
      <TableCaption>Three members, as an admin sees them.</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Member</TableHead>
          <TableHead scope="col">Group</TableHead>
          <TableHead scope="col" className="text-right">Balance</TableHead>
          <TableHead scope="col">Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {ROWS.map((row) => <MemberRow key={row.name} row={row} />)}
      </TableBody>
    </Table>
  );
}

function Badges() {
  return (
    <div className="flex flex-wrap gap-2">
      <Badge tone="neutral">Neutral</Badge>
      <Badge tone="success" icon={<Check size={14} weight="bold" aria-hidden="true" />}>Paid</Badge>
      <Badge tone="info">League night</Badge>
      <Badge tone="warning" icon={<Warning size={14} weight="bold" aria-hidden="true" />}>Low balance</Badge>
      <Badge tone="danger" icon={<Lock size={14} weight="bold" aria-hidden="true" />}>Suspended</Badge>
      <Badge tone="brand">Committee</Badge>
      <Badge tone="neutral" icon={<WifiSlash size={14} weight="bold" aria-hidden="true" />}>Offline · your code still works</Badge>
    </div>
  );
}

const AVATAR_SIZES: readonly AvatarSize[] = [24, 32, 40, 56, 96];

function Avatars() {
  return (
    <div className="flex flex-wrap items-end gap-4">
      {AVATAR_SIZES.map((size) => (
        <Specimen key={size} label={`${size}px`}>
          <Avatar size={size}><AvatarFallback name="Nomsa Khumalo" /></Avatar>
        </Specimen>
      ))}
    </div>
  );
}

function CardParts() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Court 2 tonight</CardTitle>
        <CardDescription>18:00 to 19:30 with Sam Smith.</CardDescription>
        <CardAction><Badge tone="info">Booked</Badge></CardAction>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-text-primary">The lights come on five minutes before your slot when you scan in.</p>
      </CardContent>
      <CardFooter>
        <Button variant="outline" size="sm">Add a partner</Button>
        <Button variant="danger-soft" size="sm">Cancel booking</Button>
      </CardFooter>
    </Card>
  );
}

export function DataSection() {
  return (
    <div className="flex flex-col gap-10">
      <Demo title="Table" note="Its own horizontal scroller, so a wide admin table never widens the page.">
        <ThemePair>{() => <MembersTable />}</ThemePair>
      </Demo>
      <Demo title="Badges" note="A word, never colour alone. Brand is solid navy in both themes.">
        <ThemePair>{() => <Badges />}</ThemePair>
      </Demo>
      <Demo title="Avatars" note="24, 32, 40, 56, 96. Initials on the soft accent until a photo loads.">
        <ThemePair>{() => <Avatars />}</ThemePair>
      </Demo>
      <Demo title="Card parts">
        <ThemePair>{() => <CardParts />}</ThemePair>
      </Demo>
    </div>
  );
}
