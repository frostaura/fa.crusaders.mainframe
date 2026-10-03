import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, endpoints, type WebhookEndpointDto, type WebhookDeliveryDto } from "../lib/api";
import { describeFailure } from "../lib/errors";
import { LOST_CREATE, endpointName } from "../lib/webhooksCopy";
import { ActionsMenu } from "../components/admin/ActionsMenu";
import { Alert } from "../components/Alert";
import { StaleNotice } from "../components/shell/StaleNotice";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "../components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "../components/ui/field";
import { IconButton } from "../components/ui/icon-button";
import { Input } from "../components/ui/input";
import { PageHeader, PageShell } from "../components/ui/page-shell";
import { WithAside } from "../components/ui/with-aside";
import { RefreshButton } from "../components/ui/refresh-button";
import { Skeleton } from "../components/ui/skeleton";
import { StateBlock } from "../components/ui/state-block";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { UnsureOutcome, unsureSentence, writeOrReadBack } from "../lib/lostReply";
import { LOST_REPLY, unsureWords } from "../lib/lostReplyCopy";
import { CaretDown, CaretUp, Check, Copy, Plus, Trash, WebhooksLogo, X } from "../components/ui/icons";
import { DataTable, type DataColumn } from "../components/DataTable";
import { clubDayAndClock } from "../lib/clubClock";
import { useToast } from "../components/Toast";
import { cn } from "../lib/utils";
import { useAsyncAction } from "../lib/useAsyncAction";

type EventDef = { name: string; label: string; description: string; vars: string[] };

const ENVELOPE_VARS = [
  "id",
  "type",
  "tenant_id",
  "tenant_slug",
  "occurred_at",
  "occurred_at_unix",
] as const;

/**
 * Every `member.*` event carries the same payload, so a URL template written against one
 * works against the others. `reason` is the only addition, on the two that have one.
 *
 * `member_class` is not offered (D2): the payload still carries it for one release so an old
 * template keeps working, but a new one should not be written against a field on its way out.
 * `groups` is an array, which a URL template cannot name (docs/specs/webhooks.md).
 */
const MEMBER_VARS = ["membership_id", "user_id", "full_name", "membership_number", "status"];

/**
 * Both `peripheral.*` events carry the same box, so one URL template works for either. The
 * court numbers are on it because that is what an admin acts on: a dark box on courts 1 and 2
 * means two courts nobody can light.
 */
const PERIPHERAL_VARS = [
  "device_id", "device_code", "device_name", "mac_address", "court_numbers",
  "last_seen_at", "unreachable_since", "silent_minutes", "offline_after_seconds",
];

/**
 * The events the bus actually emits.
 *
 * <p>
 * Keep this list matched to the backend's emitters, not to the spec's catalogue — an
 * event offered here that nothing fires is a filter an admin can select and then wait on
 * forever. Nine classes were missing from this picker at once, including the whole member
 * lifecycle, which is why an admin could not get a webhook on the one thing they most
 * wanted one for. `peripheral.unhealthy` was the last of the nine, absent on the stated
 * grounds that nothing could detect an unreachable box. That was false — the box PUSHES a
 * heartbeat and `PeripheralHealthWorker` sweeps it — so both peripheral classes are here.
 * </p>
 */
const EVENTS: EventDef[] = [
  {
    name: "booking.created",
    label: "Booking created",
    description: "A member (or admin on their behalf) booked a court slot.",
    vars: ["booking_id", "court_id", "court_number", "court_name", "user_id", "starts_at", "ends_at", "slice_count", "amount_charged_minutes", "balance_after_minutes"],
  },
  {
    name: "booking.cancelled",
    label: "Booking cancelled",
    description: "A booking was cancelled with no penalty.",
    vars: ["booking_id", "court_id", "court_number", "user_id", "refund_minutes", "penalty_minutes"],
  },
  {
    name: "booking.late_cancellation",
    label: "Late cancellation",
    description: "Cancelled inside the penalty window — penalty applied.",
    vars: ["booking_id", "court_id", "court_number", "user_id", "refund_minutes", "penalty_minutes"],
  },
  {
    name: "booking.lights_on",
    label: "Lights on",
    description: "Court lights turned on for a booked slot (slot start or biometric check-in).",
    vars: ["booking_id", "court_id", "court_number", "court_name", "user_id", "starts_at", "ends_at", "duration_seconds"],
  },
  {
    name: "booking.lights_off",
    label: "Lights off",
    description: "Court lights cued off at the slot end.",
    vars: ["booking_id", "court_id", "court_number", "court_name", "user_id", "starts_at", "ends_at", "duration_seconds"],
  },
  {
    name: "booking.no_show",
    label: "No-show",
    description: "Player did not biometric-authenticate within the grace window. `peripheral_outage` is true when the court's box was unreachable, in which case no penalty was charged.",
    vars: ["booking_id", "court_id", "court_number", "user_id", "penalty_minutes", "refund_minutes", "peripheral_outage"],
  },
  {
    name: "booking.completed",
    label: "Booking completed",
    description: "A slot ran to its end with the member actually there. Unlike \"lights off\", this does not fire for a no-show.",
    vars: ["booking_id", "court_id", "court_number", "court_name", "user_id", "starts_at", "ends_at", "checked_in_at", "amount_charged_minutes"],
  },
  {
    name: "booking.no_show_reversed",
    label: "No-show reversed",
    description: "A late upload from a court box proved the member did attend, so a settled no-show was undone.",
    vars: ["booking_id", "court_id", "court_number", "user_id", "attended_at", "refund_minutes", "penalty_minutes"],
  },
  {
    name: "booking.displaced",
    label: "Booking displaced",
    description: "A booking sold into a released tail was cancelled and refunded when a no-show reversal reclaimed the slot.",
    vars: ["booking_id", "court_id", "court_number", "user_id", "starts_at", "ends_at", "displaced_by_booking_id", "reason"],
  },
  {
    name: "booking.displacement_reversed",
    label: "Displacement reversed",
    description: "A box's own release proved the earlier court went dark, so a displaced booking was reinstated and re-charged.",
    vars: ["booking_id", "court_id", "court_number", "user_id", "starts_at", "ends_at"],
  },
  {
    name: "booking.cancelled_lights_charged",
    label: "Cancelled but lit",
    description: "A cancelled booking was lit anyway from an offline box's cached roster, and charged pro rata for the minutes burned.",
    vars: ["booking_id", "court_id", "court_number", "user_id", "lit_minutes", "amount_minutes", "occurred_at"],
  },
  {
    name: "minutes.purchased",
    label: "Minutes package bought",
    description: "A member's PayFast purchase of a minutes package cleared. Carries the package, the minutes added, the list price, any group discount and the rand paid.",
    vars: [
      "purchase_id", "package_id", "package_name", "minutes", "list_price_zar", "discount_bps", "zar_paid",
      "discount_group_id", "groups", "external_reference",
    ],
  },
  {
    name: "minutes.refunded",
    label: "Minutes refunded",
    description: "A refund was written to a member's ledger — by a cancellation, a no-show reversal or a displacement.",
    vars: ["entry_id", "user_id", "entry_type", "amount_minutes", "booking_id", "reason"],
  },
  {
    name: "minutes.penalty_applied",
    label: "Penalty charged",
    description: "A no-show or late-cancellation penalty was taken off a member. Says how many minutes moved, where the booking event only says what happened.",
    vars: ["entry_id", "user_id", "entry_type", "amount_minutes", "booking_id", "reason"],
  },
  {
    name: "minutes.adjusted",
    label: "Minutes adjusted by hand",
    description: "An admin added minutes to a member or took them back from the console — a goodwill gesture, a correction, or a refund made outside the system. NOT money the club took: that is minutes.sold_at_desk.",
    vars: ["entry_id", "user_id", "entry_type", "amount_minutes", "booking_id", "reason"],
  },
  {
    name: "minutes.sold_at_desk",
    label: "Package sold at the desk",
    description: "An admin sold a member a package over the counter — cash, an EFT that cleared, or a card on the club's own terminal. It is revenue, exactly like a PayFast purchase, which is why it is a separate event from minutes.adjusted.",
    vars: ["entry_id", "user_id", "entry_type", "amount_minutes", "booking_id", "reason"],
  },
  {
    name: "member.registered",
    label: "Member registered",
    description: "Somebody submitted a membership application.",
    vars: MEMBER_VARS,
  },
  {
    name: "member.approved",
    label: "Member approved",
    description: "An admin approved a pending application.",
    vars: MEMBER_VARS,
  },
  {
    name: "member.rejected",
    label: "Member rejected",
    description: "An admin rejected a pending application. Carries the reason the applicant was given.",
    vars: [...MEMBER_VARS, "reason"],
  },
  {
    name: "member.suspended",
    label: "Member suspended",
    description: "An admin suspended a member — access revoked, minutes and bookings untouched.",
    vars: [...MEMBER_VARS, "reason"],
  },
  {
    name: "peripheral.unhealthy",
    label: "Court box unreachable",
    description: "A court box stopped sending its heartbeat for longer than the club's offline threshold. Fires once per outage, not once per check.",
    vars: PERIPHERAL_VARS,
  },
  {
    name: "peripheral.recovered",
    label: "Court box back online",
    description: "A court box that had gone quiet started heart-beating again. Says how long the outage lasted.",
    vars: [...PERIPHERAL_VARS, "recovered_at", "outage_minutes"],
  },
  {
    name: "member.reactivated",
    label: "Member reactivated",
    description: "A suspension was lifted and the member has their access back.",
    vars: MEMBER_VARS,
  },
];

const EVENT_BY_NAME = new Map(EVENTS.map((e) => [e.name, e]));

/** Variables available when these events are in scope. `*` or empty = all. */
function variablesForEvents(filterTokens: string[]): string[] {
  const wantsAll = filterTokens.length === 0 || filterTokens.includes("*");
  const eventVars = wantsAll
    ? Array.from(new Set(EVENTS.flatMap((e) => e.vars)))
    : Array.from(new Set(filterTokens.flatMap((t) => EVENT_BY_NAME.get(t)?.vars ?? [])));
  return [...ENVELOPE_VARS, ...eventVars.sort()];
}

/** Comma-separated -> trimmed token list (drops empties). */
function parseFilter(s: string): string[] {
  return s.split(",").map((t) => t.trim()).filter(Boolean);
}

function formatFilter(tokens: string[]): string {
  return tokens.length === 0 ? "*" : tokens.join(",");
}

const REMOVED = "Endpoint removed.";

export default function AdminWebhooksPage() {
  const toast = useToast();
  const [list, setList] = useState<WebhookEndpointDto[]>([]);
  const [creating, setCreating] = useState(false);
  // Empty, and it has to stay empty. A destination is not a default.
  //
  // This form used to open with `http://arduino.local/court/{court_number}/turn/on` in the
  // URL field, which is the one destination `docs/specs/webhooks.md` forbids as a templating
  // example; that was replaced with a scoreboard host, which fixed the wrong half of the
  // problem. The defect is not WHICH host is prefilled, it is that a host is prefilled at
  // all: with a value rather than a placeholder in the field, an admin who opens the form and
  // presses Create publishes `booking_id`, `court_id`, `user_id` and every member's slot times
  // to a third-party domain the club does not own, in two clicks, having typed nothing. An
  // example belongs in the `placeholder` — which both fields already carry — where it can be
  // read and cannot be submitted.
  const [url, setUrl] = useState("");
  const [filterTokens, setFilterTokens] = useState<string[]>(["booking.lights_on"]);
  const [description, setDescription] = useState("");
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  // F3.16: why the last create failed, IN the dialog — a toast faded and always said "Check the URL".
  const [createError, setCreateError] = useState<CreateFailure | null>(null);
  const [openDeliveriesId, setOpenDeliveriesId] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDeliveryDto[]>([]);
  /**
   * Why the endpoint list could not be read, or null.
   *
   * <p>
   * The loader was `load().catch(() => {})`. A failed read therefore produced no toast, no log
   * and no mark on the screen — it left `list` at its initial `[]` and the page then said
   * "No webhook endpoints yet. Create one above to start firing events." An admin who does what
   * that sentence tells them adds a second endpoint pointing at the same destination, and every
   * booking from then on fires the club's lights cue twice. The empty array is the initial
   * value, not an answer from the server, and the screen has to be able to tell them apart.
   * </p>
   */
  const [loadError, setLoadError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  /** When the list was last READ — so a failed refresh can keep it, said as of then (R4). */
  const [readAt, setReadAt] = useState<number | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      setList(await endpoints.adminWebhooksList());
      setLoadError(null);
      setReadAt(Date.now());
    } catch (err) {
      setLoadError(err);
      throw err;
    } finally {
      setLoading(false);
    }
  };
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount loader; sync loading flag is the house idiom
  useEffect(() => { load().catch(() => {}); }, []);

  const create = async () => {
    if (!url.trim()) { setCreateError({ text: CREATE_REFUSAL.url_required, field: "url" }); return; }
    setCreateError(null);
    try {
      const created = await endpoints.adminWebhooksCreate({
        urlTemplate: url.trim(),
        eventFilter: formatFilter(filterTokens),
        description: description.trim() || undefined,
      });
      setCreatedSecret(created.secret);
      setCreating(false);
      // Emptied on the way out, for the same reason it starts empty: a form that reopens
      // holding the last destination is a second endpoint one click away from existing.
      setUrl("");
      setDescription("");
      await load();
      toast.push({ tone: "success", text: "Endpoint created." });
    } catch (err) {
      const known = new Set(list.map((row) => row.id));
      setCreateError(createRefusal(err)
        ?? { text: await lostCreate({ url: url.trim(), filter: formatFilter(filterTokens), known }, setList), field: null });
    }
  };

  // Create shows its own pending state and ignores a second press while it works (R12).
  const createAction = useAsyncAction(create);

  // Thrown, not swallowed: the confirm dialog keeps itself open and says what went wrong.
  // A lost reply is looked up (review round 3): the list read again without this id → it was
  // deleted; with it → nothing changed; unreadable → not known (said in the dialog, see below).
  const remove = async (id: string) => {
    try {
      const { proven } = await writeOrReadBack(
        async () => { await endpoints.adminWebhooksDelete(id); return {}; },
        async () => ((await endpoints.adminWebhooksList()).some((w) => w.id === id) ? null : {}),
      );
      await load();
      toast.push({ tone: "success", text: proven ? LOST_REPLY.proven(REMOVED) : REMOVED });
    } catch (err) {
      // The list is re-read so the page shows the record; its own failure is its own banner.
      if (err instanceof UnsureOutcome) load().catch(() => {});
      throw err;
    }
  };

  const openDeliveries = async (id: string) => {
    if (openDeliveriesId === id) { setOpenDeliveriesId(null); return; }
    try {
      const rows = await endpoints.adminWebhookDeliveries(id);
      setDeliveries(rows);
      setOpenDeliveriesId(id);
    } catch { toast.push({ tone: "danger", text: "Couldn't load deliveries." }); }
  };

  const retry = () => { load().catch(() => {}); };

  return (
    <PageShell width="full">
      <PageHeader
        title="Webhooks"
        description={"Outbound HTTP cues — lights, downstream integrations, audit pipes. URL templates "
          + "substitute event variables; the catalogue below lists them."}
        actions={<RefreshButton onRefresh={retry} loading={loading} />}
      />

      {createdSecret && <SecretBlock secret={createdSecret} onDismiss={() => setCreatedSecret(null)} />}

      {/* R4 form factor (SPEC §3.15): from a 64rem box the variable catalogue is a rail beside the
          endpoints — sticky, scrolling on its own — instead of a table that made the page 2,800–
          5,600px tall; narrower, it follows the endpoints, folded until asked for. */}
      <WithAside at="64rem" asideWidth="24rem" asideLabel="Variable catalogue" aside={<VariableCatalogCard />}>
      <Card>
        {/* On a phone the action goes UNDER the heading (R3 X-4): beside it, the heading's longest
            word plus "New endpoint" at 200% text were wider than the card and the page scrolled. */}
        <CardHeader className="max-sm:!grid-cols-1">
          <CardTitle asChild><h2>Endpoints</h2></CardTitle>
          <CardDescription>Where the club&apos;s events are sent, and whether each one is answering.</CardDescription>
          <CardAction className="max-sm:col-start-1 max-sm:row-span-1 max-sm:row-start-3 max-sm:justify-self-start">
            <Button
              onClick={() => { setCreating(true); setCreatedSecret(null); }}
              icon={<Plus aria-hidden="true" />}
              // Wraps rather than widening the page at 200% text (R3 X-4).
              className="!h-auto min-h-touch whitespace-normal py-2"
              /*
               * Not offered while the list is unknown. Leaving it live directly above a panel
               * that says "do not create one until this list loads" is an instruction and its
               * contradiction on the same screen, and the button is the one that gets pressed.
               */
              disabled={loadError !== null || loading}
              title={loadError ? "Not while the existing endpoints cannot be read — you could create a duplicate." : undefined}
            >
              New endpoint
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {/* A list read before stays, under "Couldn't refresh" (R4); New endpoint stays off until a
              read succeeds, because the list on screen may be missing one made since. */}
          {loadError && readAt === null ? <ListFailed error={loadError} retrying={loading} onRetry={retry} /> : null}
          <StaleNotice stale={loadError !== null && readAt !== null} readAt={readAt} />
          <StateBlock
            action="read the webhook endpoints"
            loading={!loadError && loading && list.length === 0}
            skeleton={<div className="flex flex-col gap-3">{[0, 1].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div>}
            empty={!loadError && list.length === 0}
            emptyIcon={WebhooksLogo}
            emptyTitle="No webhook endpoints yet."
            emptyHint="Create one to start sending the club's events to another system."
          >
            <ul hidden={loadError !== null && readAt === null} className="divide-y divide-border rounded-lg border border-border">
              {list.map((w) => (
                <EndpointRow
                  key={w.id}
                  endpoint={w}
                  open={openDeliveriesId === w.id}
                  deliveries={deliveries}
                  onDeliveries={() => void openDeliveries(w.id)}
                  onRemove={() => remove(w.id)}
                />
              ))}
            </ul>
          </StateBlock>
        </CardContent>
      </Card>

      <NewEndpointDialog
        open={creating}
        onOpenChange={(next) => { setCreating(next); if (!next) setCreateError(null); }}
        form={{ url, setUrl, filterTokens, setFilterTokens, description, setDescription }}
        pending={createAction.pending}
        error={createError}
        onCreate={() => void createAction.run()}
      />
      </WithAside>
    </PageShell>
  );
}

/**
 * The list could not be read. Not "no endpoints": an admin told there are none, on a club that
 * has one, creates a second — and the lights cue then fires twice for every booking. Always
 * with a retry, including for a 5xx: a webhook list read is idempotent and a gateway blip is
 * the commonest reason it fails.
 */
function ListFailed({ error, retrying, onRetry }: { error: unknown; retrying: boolean; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3">
      <Alert tone="danger" className="w-full">
        {describeFailure(error, { action: "load the webhook endpoints" })}
      </Alert>
      <p className="max-w-prose text-sm text-text-secondary">
        Existing endpoints are not shown below because they could not be read — this club may already
        have some. Do not create one until this list loads, or you may end up firing every event twice.
      </p>
      <Button variant="outline" pending={retrying} onClick={onRetry}>Try again</Button>
    </div>
  );
}

/** One endpoint: what it is, where it sends, what it sends — and its deliveries under it. */
function EndpointRow(props: {
  endpoint: WebhookEndpointDto;
  open: boolean;
  deliveries: WebhookDeliveryDto[];
  onDeliveries: () => void;
  onRemove: () => Promise<void>;
}) {
  const { endpoint: w, open, deliveries } = props;
  const tokens = parseFilter(w.event_filter);
  const name = endpointName(w);
  return (
    <li className="flex flex-col gap-3 p-4">
      {/* L6-5: the details have a real basis, so on a phone (or at 200 % text) the buttons wrap
          UNDER them instead of squeezing them to ~50 px beside a 140 px button pair. */}
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 flex-1 basis-72 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold text-text-primary">{name}</p>
            <Badge tone={w.enabled ? "success" : "neutral"}>{w.enabled ? "enabled" : "disabled"}</Badge>
            {w.failure_count > 0 && <Badge tone="warning">{`failures: ${w.failure_count}`}</Badge>}
          </div>
          <p className="break-all font-mono text-xs text-text-secondary">{w.url_template}</p>
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {tokens.length === 0 || tokens.includes("*") ? (
              <Badge tone="info">any event</Badge>
            ) : (
              tokens.map((t) => <Badge key={t} tone="info">{t}</Badge>)
            )}
          </div>
        </div>
        <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-1">
          {/* The name does not flip with the state — `aria-expanded` carries it, so a
              screen-reader user is not left re-finding a control after every press. */}
          <Button variant="outline" size="sm" aria-expanded={open} onClick={props.onDeliveries}>
            Deliveries
          </Button>
          <ActionsMenu
            label={`More actions for ${name}`}
            items={[{
              label: "Delete endpoint",
              icon: <Trash size={16} aria-hidden="true" />,
              danger: true,
              confirm: {
                title: "Delete this endpoint?",
                description: `${name} stops receiving the club's events at once. Its delivery history goes with it, and this cannot be undone.`,
                confirmLabel: "Delete endpoint",
                action: "delete the endpoint",
                onConfirm: props.onRemove,
                describe: (error) => unsureSentence(error, unsureWords(`${name} is still there`, `${name} was deleted`, "Webhooks")),
                focusAfter: () => document.querySelector<HTMLElement>("#main-content h1"),
              },
            }]}
          />
        </div>
      </div>
      {open && <DeliveriesTable rows={deliveries} />}
    </li>
  );
}

type EndpointForm = {
  url: string;
  setUrl: (next: string) => void;
  filterTokens: string[];
  setFilterTokens: (next: string[]) => void;
  description: string;
  setDescription: (next: string) => void;
};

/** The create form, as a dialog: events, the URL template, a description, and Create. */
function NewEndpointDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  form: EndpointForm;
  pending: boolean;
  error: CreateFailure | null;
  onCreate: () => void;
}) {
  const { open, onOpenChange, form, pending, onCreate } = props;
  const urlError = props.error?.field === "url" ? props.error.text : null;
  const urlField = useRef<HTMLDivElement>(null);
  // R4 A4-9: a refusal ABOUT the URL is said at the URL — aria-invalid, described by the error,
  // focused — not at the foot of the form, where it named no field and took no focus.
  useEffect(() => {
    if (!urlError) return;
    const input = urlField.current?.querySelector("input");
    input?.scrollIntoView?.({ block: "nearest" });
    input?.focus({ preventScroll: true });
  }, [urlError, props.error]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New webhook endpoint</DialogTitle>
          <DialogDescription>Choose what to send, and where. The signing secret is shown once, after it is created.</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-6">
          <div role="group" aria-labelledby="webhook-events-label" className="flex flex-col gap-2">
            <span id="webhook-events-label" className="text-sm font-medium text-text-primary">Events</span>
            <EventFilterPicker tokens={form.filterTokens} onChange={form.setFilterTokens} />
            <p className="text-sm text-text-secondary">
              Pick one or more. Choose <strong>Any event (*)</strong> to fire for everything.
            </p>
          </div>

          <div ref={urlField}>
            <Field invalid={urlError !== null}>
              <FieldLabel>URL template</FieldLabel>
              <TemplateInput
                value={form.url}
                onChange={form.setUrl}
                variables={variablesForEvents(form.filterTokens)}
                placeholder="https://example.com/webhook?court={court_number}"
              />
              {urlError ? <FieldError>{urlError}</FieldError> : null}
            </Field>
          </div>

          <Field>
            <FieldLabel>Description</FieldLabel>
            {/* Not "Lights on (Arduino)". docs/specs/webhooks.md is explicit that the court
                box is pull-only, has no inbound HTTP listener and no arduino.local name —
                so the placeholder cannot describe the one destination a webhook can never
                have. */}
            <Input value={form.description} onChange={(e) => form.setDescription(e.target.value)} placeholder="Scoreboard — court lit" />
            <FieldDescription>What the endpoint is for, so the list says it in words.</FieldDescription>
          </Field>
          {props.error && !urlError ? <CreateError text={props.error.text} /> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={onCreate} pending={pending}>Create endpoint</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Why the create failed, brought into view and given focus (F3-11): it sits at the foot of a
 * dialog body that scrolls, and at 1280 it was below the fold — the press looked like nothing.
 */
function CreateError({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: "nearest" });
    ref.current?.focus({ preventScroll: true });
  }, [text]);
  return (
    <div ref={ref} tabIndex={-1} data-create-error="" className="outline-none">
      <Alert tone="danger" live="assertive" announceKey={`webhook-create-${text}`}>{text}</Alert>
    </div>
  );
}

function SecretBlock({ secret, onDismiss }: { secret: string; onDismiss: () => void }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      toast.push({ tone: "success", text: "Secret copied to clipboard." });
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.push({ tone: "danger", text: "Couldn't copy — select the secret manually." });
    }
  };
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-warning-strong bg-warning-soft p-4 sm:p-6">
      <p className="text-sm font-semibold text-warning-strong">
        Endpoint created — save this signing secret. It won&apos;t be shown again.
      </p>
      <div className="flex items-stretch gap-2">
        <code className="flex-1 select-all break-all rounded-lg border border-border bg-bg-surface px-3 py-2.5 font-mono text-xs text-text-primary">
          {secret}
        </code>
        <Button
          type="button"
          variant="outline"
          onClick={copy}
          icon={copied ? <Check aria-hidden="true" className="text-success-strong" /> : <Copy aria-hidden="true" />}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
        <IconButton label="Dismiss" variant="outline" onClick={onDismiss}>
          <X aria-hidden="true" />
        </IconButton>
      </div>
    </div>
  );
}

/* ============================================================================
   Event filter — a multi-select toggle group with an "Any (*)" toggle.
   ============================================================================ */

function EventFilterPicker({ tokens, onChange }: { tokens: string[]; onChange: (next: string[]) => void }) {
  const isAny = tokens.length === 0 || tokens.includes("*");
  const chosen = isAny ? ["*"] : tokens;

  const change = (next: string[]) => {
    const added = next.filter((t) => !chosen.includes(t));
    if (added.includes("*")) { onChange(["*"]); return; }
    onChange(next.filter((t) => t !== "*"));
  };

  return (
    <ToggleGroup type="multiple" variant="outline" size="sm" value={chosen} onValueChange={change} aria-label="Events" className="gap-2">
      <ToggleGroupItem value="*" className="rounded-full px-3">
        {isAny && <Check size={14} weight="bold" aria-hidden="true" />}
        Any event (*)
      </ToggleGroupItem>
      {EVENTS.map((e) => (
        <ToggleGroupItem key={e.name} value={e.name} title={e.description} className="rounded-full px-3 font-mono text-xs">
          {!isAny && tokens.includes(e.name) && <Check size={14} weight="bold" aria-hidden="true" />}
          {e.name}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/* ============================================================================
   URL template editor — input with caret-aware variable autocomplete.
   - Typing `{` opens a popover; typing more filters by prefix.
   - Click a suggestion (or chip below) to insert `{name}` at the caret.
   - All vars also live in a clickable strip below the input for discovery.
   ============================================================================ */

function TemplateInput({
  value, onChange, variables, placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  variables: string[];
  placeholder?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  // Caret position mirrored into state from input events so token detection stays pure at render time.
  const [caret, setCaret] = useState(0);

  // Find the variable token currently being typed (after `{` and before space/`}`).
  const tokenInfo = useMemo(() => {
    const before = value.slice(0, caret);
    const openIdx = before.lastIndexOf("{");
    if (openIdx === -1) return null;
    const between = before.slice(openIdx + 1);
    if (/[}\s]/.test(between)) return null;
    return { openIdx, prefix: between, caret };
  }, [value, caret]);

  const suggestions = useMemo(() => {
    const prefix = tokenInfo?.prefix?.toLowerCase() ?? "";
    return variables.filter((v) => v.toLowerCase().startsWith(prefix)).slice(0, 8);
  }, [variables, tokenInfo]);

  const insertAtCaret = (varName: string) => {
    const el = inputRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? value.length;
    let head = value.slice(0, caret);
    const tail = value.slice(caret);

    // If we're inside a partial `{prefix`, replace from the `{` up to caret.
    const openIdx = head.lastIndexOf("{");
    if (openIdx !== -1) {
      const between = head.slice(openIdx + 1);
      if (!/[}\s]/.test(between)) head = head.slice(0, openIdx);
    }

    // If a closing `}` already follows the caret, don't double up.
    const insertion = tail.startsWith("}") ? `{${varName}` : `{${varName}}`;
    onChange(head + insertion + tail);

    // Restore caret just past the closing brace of the inserted token.
    requestAnimationFrame(() => {
      if (!inputRef.current) return;
      const pos = (head + insertion).length + (tail.startsWith("}") ? 1 : 0);
      inputRef.current.focus();
      inputRef.current.setSelectionRange(pos, pos);
      setOpen(false);
    });
  };

  const showPopover = open && tokenInfo !== null && suggestions.length > 0;

  return (
    <div className="relative">
      <Input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showPopover}
        className="font-mono"
        onChange={(e) => { onChange(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); setActiveIdx(0); setOpen(true); }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? value.length)}
        onFocus={(e) => { setCaret(e.currentTarget.selectionStart ?? value.length); setOpen(true); }}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (!showPopover) return;
          if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, suggestions.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); }
          else if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            insertAtCaret(suggestions[activeIdx]);
          } else if (e.key === "Escape") { setOpen(false); }
        }}
      />

      {showPopover && (
        <ul
          role="listbox"
          aria-label="Variables"
          className="absolute inset-x-0 z-popover mt-1 max-h-60 overflow-auto rounded-xl border border-border bg-bg-raised p-1 shadow-md"
        >
          {suggestions.map((s, i) => (
            <li
              key={s}
              role="option"
              aria-selected={i === activeIdx}
              onMouseDown={(e) => { e.preventDefault(); insertAtCaret(s); }}
              onMouseEnter={() => setActiveIdx(i)}
              className={cn(
                "flex min-h-touch cursor-pointer items-center justify-between rounded-lg px-3 font-mono text-sm",
                i === activeIdx ? "bg-accent-soft text-accent-strong" : "text-text-primary hover:bg-bg-muted",
              )}
            >
              <span>{s}</span>
              <span className="text-xs uppercase tracking-overline text-text-muted">insert</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs text-text-muted">Insert:</span>
        {variables.slice(0, 16).map((v) => (
          <button
            key={v}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => insertAtCaret(v)}
            className="no-lift rounded-md border border-border bg-bg-muted px-2 py-1 font-mono text-xs text-text-secondary transition-colors duration-fast ease-standard hover:border-accent-strong hover:bg-accent-soft hover:text-accent-strong motion-reduce:transition-none"
          >
            {`{${v}}`}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-text-muted">
        Type <code className="font-mono">{"{"}</code> for inline autocomplete. Values are URL-encoded on send.
      </p>
    </div>
  );
}

/* ============================================================================
   Why a destination was refused.
   ============================================================================ */

/**
 * The API's refusal codes, in the desk's words.
 *
 * <p>
 * The API told these apart the whole time and the screen showed "Couldn't create
 * endpoint." for all of them, so a typo'd scheme, an unparseable URL and a deliberate
 * LAN address looked identical — three different mistakes with three different repairs
 * and one four-word answer.
 * </p>
 *
 * <p>
 * <code>destination_not_permitted</code> is the one that matters most and the one it is
 * most tempting to write badly. The guard is correct and must not be loosened: a webhook
 * that can be pointed at a private address is an SSRF hole, and at the cloud metadata
 * endpoint a credential leak. But a club pointing one at its own scoreboard is a
 * <em>supported</em> case, reached by adding that address to the private-network
 * allow-list. So the copy says which of those two situations the admin is in, instead of
 * implying they typed something malformed.
 * </p>
 *
 * <p>
 * <b>And it says, outright, that the allow-list is not a screen anyone forgot to
 * build.</b> The earlier wording ("ask whoever runs the deployment to add it to the
 * webhook allow-list") read like a pointer at a missing admin surface, and the obvious
 * next move — building one — would be a defect, not the fix.
 * <code>Webhooks:PrivateNetworkAllowList</code> is read once at startup by a singleton
 * <code>OutboundAddressGuard</code> that has no tenant in scope, so a club admin editing it
 * would move an SSRF boundary for <em>every</em> club on the deployment: a cross-tenant
 * escalation dressed as a settings field. It stays deployment configuration, the
 * reasoning is written down in <code>docs/specs/webhooks.md</code>, and the sentence below
 * names the setting so the admin's request to their operator is actionable.
 * </p>
 */
const CREATE_REFUSAL: Record<string, string> = {
  url_required: "Enter a URL for this endpoint.",
  url_invalid: "That isn't a URL. It needs a scheme and a host — for example https://example.com/hook.",
  scheme_must_be_http_or_https: "Webhook URLs have to be http:// or https://. Other schemes can't be delivered to.",
  template_variable_not_allowed_in_host:
    "A {variable} can't appear in the host — only in the path or query. Variables come from event data, so a host built from one would be a destination nobody chose.",
  destination_not_permitted:
    "That address is on a private or link-local network, which is blocked by default. No admin screen can open one up \u2014 the allow-list is a server setting, Webhooks:PrivateNetworkAllowList, shared by every club on this deployment. If it's a device on the club's LAN, send that address to whoever runs the deployment and ask for it to be allow-listed; otherwise use a public address.",
};

/**
 * What a failed create says (F3.16). "Check the URL" only where the URL IS the problem: a
 * refusal code has its own sentence, a 429 says wait, a server failure says it is not the URL and
 * to look at the list before trying again (the endpoint may exist), and an unreachable server says
 * so. Anything else goes through the house `describeFailure`.
 */
function createRefusal(err: unknown): CreateFailure | null {
  // No answer, or a server failure: the outcome is not known, and `lostCreate` finds it out.
  if (!(err instanceof ApiError) || err.status >= 500) return null;
  const code = err.code ?? "";
  // Every coded refusal on this form is about the URL (R4 A4-9): said at the field.
  if (code in CREATE_REFUSAL) return { text: CREATE_REFUSAL[code], field: "url" };
  if (err.status === 429) return { text: "Too many attempts in a short time. Wait a minute, then try again — nothing was created.", field: null };
  return { text: describeFailure(err, { action: "create the endpoint" }), field: null };
}

/** Why a create failed, and the field it is about (null: the form as a whole). */
type CreateFailure = { text: string; field: "url" | null };

/**
 * A dropped connection or a server failure said "so nothing was created" — about a request that
 * may well have been (review round 2, F3-11). The list is read again and an endpoint with this
 * URL and these events is looked for; the list on screen follows what was read.
 */
async function lostCreate(
  sent: { url: string; filter: string; known: ReadonlySet<string> }, show: (rows: WebhookEndpointDto[]) => void,
): Promise<string> {
  try {
    const rows = await endpoints.adminWebhooksList();
    show(rows);
    // A NEW row with this URL and these events — one that was already listed is not this press's.
    const mine = rows.some((r) => !sent.known.has(r.id) && r.url_template === sent.url && r.event_filter === sent.filter);
    return mine ? LOST_CREATE.created : LOST_CREATE.notCreated;
  } catch {
    return LOST_CREATE.unknown;
  }
}

/* ============================================================================
   Deliveries — light DataTable.
   ============================================================================ */

function DeliveriesTable({ rows }: { rows: WebhookDeliveryDto[] }) {
  const cols: DataColumn<WebhookDeliveryDto>[] = [
    {
      key: "when", header: "When", width: 170,
      cell: (r) => clubDayAndClock(r.created_at),
      sortValue: (r) => new Date(r.created_at).getTime(),
    },
    { key: "event", header: "Event", cell: (r) => <span className="font-mono text-xs">{r.event_type}</span>, sortValue: (r) => r.event_type },
    {
      key: "status", header: "Status", width: 130,
      cell: (r) => {
        const s = r.response_status;
        const tone = s == null ? (r.final_state === "delivered" ? "success" : r.final_state === "failed" || r.final_state === "abandoned" ? "danger" : "neutral") : s >= 200 && s < 300 ? "success" : "danger";
        return <Badge tone={tone}>{s ?? r.final_state}</Badge>;
      },
      sortValue: (r) => r.response_status ?? -1,
    },
    { key: "attempt", header: "Try", width: 70, align: "right", cell: (r) => r.attempt, sortValue: (r) => r.attempt },
    { key: "latency", header: "Latency", width: 100, align: "right", cell: (r) => `${r.latency_ms}ms`, sortValue: (r) => r.latency_ms },
  ];
  return (
    <section aria-label="Recent deliveries" className="mt-3">
      <DataTable
        label="Delivery attempts"
        rows={rows}
        columns={cols}
        rowKey={(r) => r.id}
        defaultSort={{ key: "when", dir: "desc" }}
        emptyTitle="No deliveries yet"
        emptyHint="Once an event matches this endpoint, attempts will appear here."
      />
    </section>
  );
}

/* ============================================================================
   Variable catalog — discoverability for admins.
   ============================================================================ */

/**
 * The placeholders each event carries. Beside the endpoints (a 64rem box) it is always open and
 * reads as one card per event — the three-column table does not fit a 24rem rail. Narrower it is
 * folded behind its heading until asked for (it is reference, not work), and from `sm` it opens as
 * the table. Every class written whole, so the scanner sees it.
 */
function VariableCatalogCard() {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle asChild><h2>Variable catalogue</h2></CardTitle>
        <CardDescription>
          The <code className="font-mono text-xs">{"{placeholders}"}</code> each event carries. The envelope
          variables are on every event.
        </CardDescription>
      </CardHeader>
      {/* Its own row, not a CardAction: a hidden action leaves the header's second column for
          the description to flow into, and the title was squeezed to a letter a line. */}
      <CardContent className="@[64rem]/aside:hidden">
        <Button
          variant="outline"
          size="sm"
          aria-expanded={open}
          aria-controls="webhook-catalogue"
          onClick={() => setOpen((v) => !v)}
          icon={open ? <CaretUp aria-hidden="true" /> : <CaretDown aria-hidden="true" />}
          // Its words wrap at 200 % text rather than widening a 390 phone by 2px.
          className="!h-auto min-h-touch max-w-full whitespace-normal py-2"
        >
          {open ? "Hide the catalogue" : "Show the catalogue"}
        </Button>
      </CardContent>
      <CardContent id="webhook-catalogue" className={cn("flex-col gap-4", open ? "flex" : "hidden @[64rem]/aside:!flex")}>
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-overline text-text-secondary">Envelope (every event)</p>
          <div className="flex flex-wrap gap-1.5">
            {ENVELOPE_VARS.map((v) => <VarChip key={v} name={v} />)}
          </div>
        </div>
        {/* On a phone, one card per event (VIS F3-15): the three-column table at 390 made each row
            ~240px tall with "What it means" off the right edge. The table is the sm+ reading. */}
        <ul aria-label="Events and the variables each carries" className="flex flex-col divide-y divide-border rounded-lg border border-border sm:hidden @[64rem]/aside:!flex">
          {EVENTS.map((e) => (
            <li key={e.name} className="flex flex-col gap-1.5 p-3">
              <span className="font-mono text-xs font-semibold text-text-primary [overflow-wrap:anywhere]">{e.name}</span>
              <span className="text-sm text-text-secondary [overflow-wrap:anywhere]">{e.description}</span>
              <div className="flex flex-wrap gap-1.5">{e.vars.map((v) => <VarChip key={v} name={v} />)}</div>
            </li>
          ))}
        </ul>
        <div className="hidden rounded-lg border border-border sm:block @[64rem]/aside:!hidden">
          <Table label="Events and the variables each carries">
            <TableHeader>
              <TableRow>
                <TableHead>Event</TableHead>
                <TableHead>What it means</TableHead>
                <TableHead>Extra variables</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {EVENTS.map((e) => (
                <TableRow key={e.name}>
                  <TableCell className="align-top"><span className="font-mono text-xs">{e.name}</span></TableCell>
                  <TableCell className="min-w-64 align-top text-text-secondary">{e.description}</TableCell>
                  <TableCell className="align-top">
                    <div className="flex min-w-48 flex-wrap gap-1.5">
                      {e.vars.map((v) => <VarChip key={v} name={v} />)}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function VarChip({ name }: { name: string }) {
  return (
    // May break anywhere (R3 X-4): "{amount_charged_minutes}" at 200% text was wider than a phone.
    <span className="max-w-full rounded-md border border-border bg-bg-muted px-2 py-0.5 font-mono text-xs text-text-secondary [overflow-wrap:anywhere]">
      {`{${name}}`}
    </span>
  );
}
