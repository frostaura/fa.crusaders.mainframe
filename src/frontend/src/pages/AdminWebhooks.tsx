import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Plus, X } from "lucide-react";
import { endpoints, type WebhookEndpointDto, type WebhookDeliveryDto } from "../lib/api";
import { Card } from "../components/Card";
import { Badge, Button, Input, Label } from "../components/Button";
import { ConfirmButton } from "../components/ConfirmButton";
import { DataTable, type DataColumn } from "../components/DataTable";
import { useToast } from "../components/Toast";
import { cn } from "../lib/utils";

type EventDef = { name: string; label: string; description: string; vars: string[] };

const ENVELOPE_VARS = [
  "id",
  "type",
  "tenant_id",
  "tenant_slug",
  "occurred_at",
  "occurred_at_unix",
] as const;

const EVENTS: EventDef[] = [
  {
    name: "booking.created",
    label: "Booking created",
    description: "A member (or admin on their behalf) booked a court slot.",
    vars: ["booking_id", "court_id", "court_number", "court_name", "user_id", "starts_at", "ends_at", "slice_count", "amount_charged_credits", "balance_after_credits"],
  },
  {
    name: "booking.cancelled",
    label: "Booking cancelled",
    description: "A booking was cancelled with no penalty.",
    vars: ["booking_id", "court_id", "court_number", "user_id", "refund_credits", "penalty_credits"],
  },
  {
    name: "booking.late_cancellation",
    label: "Late cancellation",
    description: "Cancelled inside the penalty window — penalty applied.",
    vars: ["booking_id", "court_id", "court_number", "user_id", "refund_credits", "penalty_credits"],
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
    description: "Player did not biometric-authenticate within the grace window.",
    vars: ["booking_id", "court_id", "court_number", "user_id", "penalty_credits", "refund_credits"],
  },
  {
    name: "credit.topped_up",
    label: "Credit topped up",
    description: "A successful PeachPayments top-up cleared.",
    vars: ["topup_id", "zar_paid", "credits", "conversion_rate", "member_class", "external_reference"],
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

export default function AdminWebhooksPage() {
  const toast = useToast();
  const [list, setList] = useState<WebhookEndpointDto[]>([]);
  const [creating, setCreating] = useState(false);
  const [url, setUrl] = useState("http://arduino.local/court/{court_number}/turn/on");
  const [filterTokens, setFilterTokens] = useState<string[]>(["booking.lights_on"]);
  const [description, setDescription] = useState("Lights on (Arduino)");
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [openDeliveriesId, setOpenDeliveriesId] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDeliveryDto[]>([]);

  const load = async () => setList(await endpoints.adminWebhooksList());
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount loader; sync loading flag is the house idiom
  useEffect(() => { load().catch(() => {}); }, []);

  const create = async () => {
    if (!url.trim()) { toast.push({ tone: "warning", text: "URL template is required." }); return; }
    try {
      const created = await endpoints.adminWebhooksCreate({
        urlTemplate: url.trim(),
        eventFilter: formatFilter(filterTokens),
        description: description.trim() || undefined,
      });
      setCreatedSecret(created.secret);
      setCreating(false);
      await load();
      toast.push({ tone: "success", text: "Endpoint created." });
    } catch {
      toast.push({ tone: "danger", text: "Couldn't create endpoint." });
    }
  };

  const remove = async (id: string) => {
    try {
      await endpoints.adminWebhooksDelete(id);
      await load();
      toast.push({ tone: "success", text: "Endpoint removed." });
    } catch { toast.push({ tone: "danger", text: "Delete failed." }); }
  };

  const openDeliveries = async (id: string) => {
    if (openDeliveriesId === id) { setOpenDeliveriesId(null); return; }
    try {
      const rows = await endpoints.adminWebhookDeliveries(id);
      setDeliveries(rows);
      setOpenDeliveriesId(id);
    } catch { toast.push({ tone: "danger", text: "Couldn't load deliveries." }); }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Admin · Webhooks</h1>
        <p className="text-sm text-text-secondary">
          Outbound HTTP cues — lights, downstream integrations, audit pipes. URL templates substitute event
          variables; the catalog below is searchable.
        </p>
      </div>

      {createdSecret && (
        <Card className="border-warning-soft bg-warning-soft/40">
          <p className="text-sm font-medium text-warning-strong">
            Endpoint created — save this signing secret. It won't be shown again.
          </p>
          <SecretBlock secret={createdSecret} onDismiss={() => setCreatedSecret(null)} />
        </Card>
      )}

      {creating && (
        <Card className="space-y-5">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold">New webhook endpoint</h3>
            <button onClick={() => setCreating(false)} className="text-text-muted hover:text-text-primary" aria-label="Close">
              <X size={18} />
            </button>
          </div>

          <div>
            <Label>Events</Label>
            <EventFilterPicker tokens={filterTokens} onChange={setFilterTokens} />
            <p className="text-xs text-text-muted mt-2">
              Pick one or more. Choose <strong>Any (*)</strong> to fire for everything.
            </p>
          </div>

          <div>
            <Label>URL template</Label>
            <TemplateInput
              value={url}
              onChange={setUrl}
              variables={variablesForEvents(filterTokens)}
              placeholder="https://example.com/webhook?court={court_number}"
            />
          </div>

          <div>
            <Label>Description</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Lights on (Arduino)" />
          </div>

          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
            <Button
              variant="outline"
              className="bg-info-soft border-info-soft text-info-strong hover:bg-info-soft/70"
              onClick={create}
            >
              Create endpoint
            </Button>
          </div>
        </Card>
      )}

      <Card>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-semibold">Endpoints</h3>
          {!creating && (
            <Button
              variant="outline"
              className="shrink-0 whitespace-nowrap bg-info-soft border-info-soft text-info-strong hover:bg-info-soft/70"
              onClick={() => { setCreating(true); setCreatedSecret(null); }}
            >
              <Plus size={16} className="mr-1" /> New endpoint
            </Button>
          )}
        </div>
        {list.length === 0 ? (
          <div className="border border-dashed border-border rounded-lg py-12 text-center text-sm text-text-secondary">
            No webhook endpoints yet. Create one above to start firing events.
          </div>
        ) : (
          <ul className="divide-y divide-border -mx-4 sm:-mx-6">
            {list.map((w) => {
              const tokens = parseFilter(w.event_filter);
              const isOpen = openDeliveriesId === w.id;
              return (
                <li key={w.id} className="px-4 sm:px-6 py-4">
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0 space-y-1.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium">{w.description ?? "(no description)"}</p>
                        <Badge tone={w.enabled ? "success" : "muted"}>{w.enabled ? "enabled" : "disabled"}</Badge>
                        {w.failure_count > 0 && <Badge tone="warning">failures: {w.failure_count}</Badge>}
                      </div>
                      <p className="text-xs font-mono break-all text-text-secondary">{w.url_template}</p>
                      <div className="flex gap-1.5 flex-wrap pt-0.5">
                        {tokens.length === 0 || tokens.includes("*") ? (
                          <Badge tone="info">any event</Badge>
                        ) : (
                          tokens.map((t) => <Badge key={t} tone="info">{t}</Badge>)
                        )}
                      </div>
                    </div>
                    <div className="flex flex-col gap-2 shrink-0">
                      <Button variant="outline" onClick={() => openDeliveries(w.id)}>
                        {isOpen ? "Hide" : "Deliveries"}
                      </Button>
                      <ConfirmButton
                        idleLabel="Delete"
                        confirmLabel="Tap to confirm"
                        onConfirm={() => remove(w.id)}
                        idleClassName="bg-danger-soft text-danger-strong hover:bg-danger-soft/70"
                        className="h-11 px-4"
                      />
                    </div>
                  </div>
                  {isOpen && <DeliveriesTable rows={deliveries} />}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <VariableCatalogCard />
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
    <div className="mt-2 flex items-stretch gap-2">
      <code className="flex-1 font-mono text-xs break-all bg-bg-surface border border-border rounded px-2 py-2 select-all">
        {secret}
      </code>
      <button
        type="button"
        onClick={copy}
        title="Copy to clipboard"
        className="inline-flex items-center gap-1.5 px-3 rounded-md border border-border bg-bg-surface hover:bg-bg-muted text-sm text-text-primary"
      >
        {copied ? <Check size={14} className="text-success-strong" /> : <Copy size={14} />}
        <span>{copied ? "Copied" : "Copy"}</span>
      </button>
      <button
        type="button"
        onClick={onDismiss}
        title="Dismiss"
        className="inline-flex items-center justify-center w-9 rounded-md border border-border bg-bg-surface hover:bg-bg-muted text-text-secondary"
        aria-label="Dismiss"
      >
        <X size={14} />
      </button>
    </div>
  );
}

/* ============================================================================
   Event filter — chip multi-select with "Any (*)" toggle.
   ============================================================================ */

function EventFilterPicker({ tokens, onChange }: { tokens: string[]; onChange: (next: string[]) => void }) {
  const isAny = tokens.length === 0 || tokens.includes("*");

  const toggle = (name: string) => {
    if (tokens.includes(name)) onChange(tokens.filter((t) => t !== name));
    else onChange([...tokens.filter((t) => t !== "*"), name]);
  };

  const setAny = () => onChange(["*"]);

  return (
    <div className="flex flex-wrap gap-2">
      <Chip active={isAny} onClick={setAny} tone="info">
        {isAny && <Check size={12} className="mr-1" />} Any event (*)
      </Chip>
      {EVENTS.map((e) => {
        const active = !isAny && tokens.includes(e.name);
        return (
          <Chip key={e.name} active={active} onClick={() => toggle(e.name)} title={e.description}>
            {active && <Check size={12} className="mr-1" />} {e.name}
          </Chip>
        );
      })}
    </div>
  );
}

function Chip({
  active, onClick, children, title,
}: {
  active: boolean;
  onClick?: () => void;
  children: React.ReactNode;
  title?: string;
  tone?: "default" | "info";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "inline-flex items-center px-3 py-1.5 rounded-full text-xs font-medium border transition",
        active
          ? "bg-info-soft text-info-strong border-info-soft"
          : "bg-bg-surface border-border text-text-secondary hover:bg-bg-muted",
      )}
    >
      {children}
    </button>
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
      <input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        className={cn(
          "w-full h-11 px-3 rounded-lg border border-border bg-bg-surface text-text-primary placeholder:text-text-muted",
          "focus:outline-none focus:ring-2 focus:ring-accent-strong focus:border-accent-strong",
          "font-mono text-sm",
        )}
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
          className="absolute z-20 left-0 right-0 mt-1 max-h-60 overflow-auto rounded-md border border-border bg-bg-surface shadow-lg"
        >
          {suggestions.map((s, i) => (
            <li
              key={s}
              role="option"
              aria-selected={i === activeIdx}
              onMouseDown={(e) => { e.preventDefault(); insertAtCaret(s); }}
              onMouseEnter={() => setActiveIdx(i)}
              className={cn(
                "px-3 py-2 text-sm font-mono cursor-pointer flex items-center justify-between",
                i === activeIdx ? "bg-info-soft text-info-strong" : "text-text-primary hover:bg-bg-muted",
              )}
            >
              <span>{s}</span>
              <span className="text-[10px] uppercase tracking-wide text-text-muted">insert</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 flex flex-wrap gap-1.5">
        <span className="text-xs text-text-muted self-center mr-1">Insert:</span>
        {variables.slice(0, 16).map((v) => (
          <button
            key={v}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => insertAtCaret(v)}
            className="font-mono text-[11px] px-2 py-0.5 rounded border border-border bg-bg-muted/40 text-text-secondary hover:bg-info-soft hover:text-info-strong hover:border-info-soft transition"
          >
            {`{${v}}`}
          </button>
        ))}
      </div>
      <p className="text-xs text-text-muted mt-2">
        Type <code className="font-mono">{"{"}</code> for inline autocomplete. Values are URL-encoded on send.
      </p>
    </div>
  );
}

/* ============================================================================
   Deliveries — light DataTable.
   ============================================================================ */

function DeliveriesTable({ rows }: { rows: WebhookDeliveryDto[] }) {
  const cols: DataColumn<WebhookDeliveryDto>[] = [
    {
      key: "when", header: "When", width: 170,
      cell: (r) => new Date(r.CreatedAt).toLocaleString(),
      sortValue: (r) => new Date(r.CreatedAt).getTime(),
    },
    { key: "event", header: "Event", cell: (r) => <span className="font-mono text-xs">{r.EventType}</span>, sortValue: (r) => r.EventType },
    {
      key: "status", header: "Status", width: 130,
      cell: (r) => {
        const s = r.ResponseStatus;
        const tone = s == null ? (r.FinalState === "delivered" ? "success" : r.FinalState === "failed" || r.FinalState === "abandoned" ? "danger" : "muted") : s >= 200 && s < 300 ? "success" : "danger";
        return <Badge tone={tone}>{s ?? r.FinalState}</Badge>;
      },
      sortValue: (r) => r.ResponseStatus ?? -1,
    },
    { key: "attempt", header: "Try", width: 70, align: "right", cell: (r) => r.Attempt, sortValue: (r) => r.Attempt },
    { key: "latency", header: "Latency", width: 100, align: "right", cell: (r) => `${r.LatencyMs}ms`, sortValue: (r) => r.LatencyMs },
  ];
  return (
    <div className="mt-3">
      <DataTable
        rows={rows}
        columns={cols}
        rowKey={(r) => r.Id}
        defaultSort={{ key: "when", dir: "desc" }}
        emptyTitle="No deliveries yet"
        emptyHint="Once an event matches this endpoint, attempts will appear here."
      />
    </div>
  );
}

/* ============================================================================
   Variable catalog — discoverability for admins.
   ============================================================================ */

function VariableCatalogCard() {
  return (
    <Card className="space-y-4">
      <div>
        <h3 className="text-base font-semibold">Variable catalog</h3>
        <p className="text-sm text-text-secondary">
          Available <code className="font-mono text-xs">{"{placeholders}"}</code> per event. Envelope variables
          below are present on every event.
        </p>
      </div>

      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-text-muted mb-2">Envelope (every event)</p>
        <div className="flex flex-wrap gap-1.5">
          {ENVELOPE_VARS.map((v) => (
            <span key={v} className="font-mono text-[11px] px-2 py-0.5 rounded border border-border bg-bg-muted/40 text-text-secondary">
              {`{${v}}`}
            </span>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <thead className="bg-bg-muted/40 text-xs uppercase tracking-wide text-text-muted">
            <tr>
              <th className="text-left px-4 py-2 font-medium">Event</th>
              <th className="text-left px-4 py-2 font-medium">What it means</th>
              <th className="text-left px-4 py-2 font-medium">Extra variables</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border bg-bg-surface">
            {EVENTS.map((e) => (
              <tr key={e.name}>
                <td className="px-4 py-2 align-top"><span className="font-mono text-xs">{e.name}</span></td>
                <td className="px-4 py-2 align-top text-text-secondary">{e.description}</td>
                <td className="px-4 py-2 align-top">
                  <div className="flex flex-wrap gap-1.5">
                    {e.vars.map((v) => (
                      <span key={v} className="font-mono text-[11px] px-2 py-0.5 rounded border border-border bg-bg-muted/40 text-text-secondary">
                        {`{${v}}`}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
