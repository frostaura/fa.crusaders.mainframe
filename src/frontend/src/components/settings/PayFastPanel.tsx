import { useCallback, useId, useState } from "react";
import { adminEndpoints, type PayFastSettings, type PayFastSettingsSave } from "../../lib/adminApi";
import { PAYFAST_COPY, payFastRefusal, problemWords } from "../../lib/payfastCopy";
import { unsureSentence, writeOrReadBack } from "../../lib/lostReply";
import { LOST_REPLY, unsureWords } from "../../lib/lostReplyCopy";
import { ConfirmDialog } from "../admin/ConfirmDialog";
import { useServedRead } from "../devices/useServedRead";
import { useToast } from "../toastContext";
import { Button } from "../ui/button";
import { Field, FieldDescription, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { StateBlock } from "../ui/state-block";

/**
 * Settings › Money & packages › PayFast account (BM-4) — the club's own merchant credentials.
 *
 * <p>
 * <b>Its own save, not the save bar's.</b> The credentials live beside the settings document but are
 * written by their own route under the settings row lock, validated as a whole, and recorded with the
 * passphrase reduced to set / changed / cleared. A panel of its own says so, the way "Your email
 * alerts" does.
 * </p>
 *
 * <p>
 * <b>The passphrase is write-only.</b> The API says only whether one is stored. An empty box keeps it —
 * it is never sent as "" (which would clear it, and with it every payment).
 * </p>
 */
const isPayFast = (data: unknown): boolean => typeof data === "object" && data !== null
  && typeof (data as PayFastSettings).configured === "boolean" && Array.isArray((data as PayFastSettings).problems);

export function PayFastPanel() {
  const titleId = useId();
  const read = useServedRead(adminEndpoints.payFastSettings, isPayFast);
  const [editing, setEditing] = useState(false);
  if (read.absent) return null;
  return (
    <section aria-labelledby={titleId} data-payfast-panel=""
      className="flex flex-col gap-3 rounded-xl border border-border bg-bg-muted p-3 sm:p-5">
      <div className="flex min-w-0 flex-col gap-1">
        <h3 id={titleId} className="text-base font-semibold text-text-primary">{PAYFAST_COPY.title}</h3>
        <p className="max-w-prose text-sm text-text-secondary">{PAYFAST_COPY.lede}</p>
      </div>
      <StateBlock
        loading={read.loading && read.data === null} error={read.data === null ? read.error : null}
        action="read the club's PayFast account" onRetry={() => void read.reload()}
      >
        {read.data && !editing && <PayFastSummary settings={read.data} onEdit={() => setEditing(true)} />}
        {read.data && editing && (
          <PayFastForm settings={read.data} onSaved={(next) => { read.set(next); setEditing(false); }} onClose={() => setEditing(false)} />
        )}
      </StateBlock>
    </section>
  );
}

function PayFastSummary({ settings, onEdit }: { settings: PayFastSettings; onEdit: () => void }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-bg-surface p-3 text-sm sm:p-4">
      {settings.configured ? (
        <p className="font-medium text-success-strong" data-payfast-ready="">{PAYFAST_COPY.ready}</p>
      ) : (
        <div className="flex flex-col gap-1" data-payfast-problems="">
          <p className="font-medium text-danger-strong">{PAYFAST_COPY.notReady}</p>
          <ul className="list-disc pl-5 text-text-primary">
            {settings.problems.map((p) => <li key={p}>{problemWords(p)}</li>)}
          </ul>
        </div>
      )}
      {settings.merchant_id && <p className="text-text-secondary">{PAYFAST_COPY.merchantId}: {settings.merchant_id}</p>}
      {settings.environment && (
        <p className="text-text-secondary">{PAYFAST_COPY.environmentLabel} {PAYFAST_COPY.environment[settings.environment]?.toLowerCase() ?? settings.environment}.</p>
      )}
      <p className="text-text-secondary">{PAYFAST_COPY.notifyUrl(settings.notify_url)}</p>
      <Button variant="outline" size="sm" className="self-start" onClick={onEdit}>{PAYFAST_COPY.edit}</Button>
    </div>
  );
}

export function PayFastForm({ settings, onSaved, onClose }: {
  settings: PayFastSettings;
  onSaved: (next: PayFastSettings) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [merchantId, setMerchantId] = useState(settings.merchant_id ?? "");
  const [merchantKey, setMerchantKey] = useState(settings.merchant_key ?? "");
  const [passphrase, setPassphrase] = useState("");
  const [environment, setEnvironment] = useState<"test" | "live">(settings.environment === "live" ? "live" : "test");

  const save = useCallback(async () => {
    const sent: PayFastSettingsSave = {
      merchant_id: merchantId.trim(),
      merchant_key: merchantKey.trim(),
      environment,
      // Empty keeps the stored passphrase; it is never sent as "", which would clear it.
      ...(passphrase === "" ? {} : { passphrase }),
    };
    const { value, proven, answered } = await writeOrReadBack(
      () => adminEndpoints.payFastSettingsSave(sent),
      async () => {
        const now = await adminEndpoints.payFastSettings();
        return now.merchant_id === sent.merchant_id && now.environment === sent.environment ? now : null;
      },
    );
    toast.push({ tone: "success", text: proven ? LOST_REPLY.proven(PAYFAST_COPY.saved, answered) : PAYFAST_COPY.saved });
    onSaved(value);
  }, [merchantId, merchantKey, passphrase, environment, toast, onSaved]);

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-bg-surface p-3 sm:p-4" data-payfast-form="">
      <div className="grid gap-4 md:grid-cols-2">
        <Field>
          <FieldLabel>{PAYFAST_COPY.merchantId} <span className="text-text-muted">(required)</span></FieldLabel>
          <Input value={merchantId} onChange={(e) => setMerchantId(e.target.value)} autoComplete="off" spellCheck={false} inputMode="numeric" />
          <FieldDescription>{PAYFAST_COPY.merchantIdHint}</FieldDescription>
        </Field>
        <Field>
          <FieldLabel>{PAYFAST_COPY.merchantKey} <span className="text-text-muted">(required)</span></FieldLabel>
          <Input value={merchantKey} onChange={(e) => setMerchantKey(e.target.value)} autoComplete="off" spellCheck={false} />
          <FieldDescription>{PAYFAST_COPY.merchantKeyHint}</FieldDescription>
        </Field>
        <Field>
          <FieldLabel>{PAYFAST_COPY.passphrase}{!settings.passphrase_set && settings.passphrase_required && <> <span className="text-text-muted">(required)</span></>}</FieldLabel>
          <Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="new-password" spellCheck={false} />
          <FieldDescription>{settings.passphrase_set ? PAYFAST_COPY.passphraseSet : PAYFAST_COPY.passphraseUnset}</FieldDescription>
        </Field>
        <Field>
          <FieldLabel>{PAYFAST_COPY.environmentLabel}</FieldLabel>
          <Select value={environment} onValueChange={(v) => setEnvironment(v === "live" ? "live" : "test")}>
            <SelectTrigger aria-label={PAYFAST_COPY.environmentLabel}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="test">{PAYFAST_COPY.environment.test}</SelectItem>
              <SelectItem value="live">{PAYFAST_COPY.environment.live}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <ConfirmDialog
          trigger={<Button>{PAYFAST_COPY.save}</Button>}
          title={PAYFAST_COPY.confirmTitle}
          description={PAYFAST_COPY.confirm(environment === "live")}
          confirmLabel={PAYFAST_COPY.save}
          cancelLabel="Not yet"
          tone="primary"
          onConfirm={save}
          action="save the PayFast account"
          describe={(e) => unsureSentence(e, unsureWords(PAYFAST_COPY.stillTrue, PAYFAST_COPY.whether, "Settings")) ?? payFastRefusal(e)}
        />
        <Button variant="outline" onClick={onClose}>Cancel</Button>
      </div>
    </div>
  );
}
