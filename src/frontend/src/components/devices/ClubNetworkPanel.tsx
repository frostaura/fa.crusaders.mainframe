import { useCallback, useState } from "react";
import { endpoints, ApiError, type AdminDevice, type DeviceNetwork, type DeviceNetworkSave } from "../../lib/api";
import { BASE_URL_WORDS, checkBaseUrl, pskProblem, ssidProblem } from "../../lib/deviceProvision";
import { NETWORK_COPY, at, boardName, describeV3Refusal, networkProgress } from "../../lib/deviceV3Copy";
import { unsureSentence, writeOrReadBack } from "../../lib/lostReply";
import { LOST_REPLY, unsureWords } from "../../lib/lostReplyCopy";
import { ConfirmDialog } from "../admin/ConfirmDialog";
import { useToast } from "../toastContext";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Checkbox } from "../ui/checkbox";
import { Field, FieldDescription, FieldError, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import { StateBlock } from "../ui/state-block";
import { useServedRead } from "./useServedRead";

/**
 * Boards › Club network (device-api §8): the two WiFi profiles the boards join and the server
 * address they call, changed without a cable.
 *
 * <p>
 * <b>Passwords are write-only.</b> The API says only whether one is stored; the form keeps it
 * unless the admin types a new one or ticks "open network". A blank box is never sent as an empty
 * password, because the board reads `""` as an open network and would then fail to join.
 * </p>
 *
 * <p>
 * <b>A typo cannot strand the fleet.</b> Each board keeps the previous set and goes back to it
 * when the new address yields no answer within `device_net_fallback_minutes`; the confirm step
 * says so in those words, with the club's own number of minutes.
 * </p>
 */
const isNetwork = (data: unknown): boolean => typeof data === "object" && data !== null
  && typeof (data as DeviceNetwork).ver === "number" && Array.isArray((data as DeviceNetwork).wifi);

export function ClubNetworkPanel({ devices, fallbackMinutes, onChanged }: {
  devices: AdminDevice[];
  fallbackMinutes: number | null;
  onChanged: () => void;
}) {
  const read = useServedRead(endpoints.adminDeviceNetwork, isNetwork);
  const [editing, setEditing] = useState(false);
  if (read.absent) return null;
  return (
    <Card data-panel="club-network">
      <CardHeader>
        <CardTitle>Club network</CardTitle>
        <CardDescription>{NETWORK_COPY.lede}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <StateBlock
          loading={read.loading && read.data === null} error={read.data === null ? read.error : null}
          action="read the club network" onRetry={() => void read.reload()}
        >
          {read.data && !editing && (
            <NetworkSummary network={read.data} devices={devices} onEdit={() => setEditing(true)} />
          )}
          {read.data && editing && (
            <NetworkForm
              network={read.data} fallbackMinutes={fallbackMinutes}
              onSaved={(next) => { read.set(next); setEditing(false); onChanged(); }}
              onStale={() => void read.reload()}
              onClose={() => setEditing(false)}
            />
          )}
        </StateBlock>
      </CardContent>
    </Card>
  );
}

function NetworkSummary({ network, devices, onEdit }: { network: DeviceNetwork; devices: AdminDevice[]; onEdit: () => void }) {
  const progress = networkProgress(devices, network.ver);
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="text-text-primary">
        {network.base ? NETWORK_COPY.calls(network.base) : NETWORK_COPY.noBase}
      </p>
      <ul className="flex flex-col gap-0.5 text-text-secondary">
        {network.wifi.length === 0 && <li>{NETWORK_COPY.noWifi}</li>}
        {network.wifi.map((profile, i) => (
          <li key={i}>{NETWORK_COPY.profile(i, profile.ssid, profile.psk_set)}</li>
        ))}
      </ul>
      <p className="text-text-secondary">
        {NETWORK_COPY.version(network.ver)}
        {network.updated_at ? ` ${NETWORK_COPY.savedAt(at(network.updated_at), network.updated_by)}` : ""}
      </p>
      {progress.behind.length > 0 && (
        <p className="text-text-secondary" data-network-behind="">{NETWORK_COPY.behind(progress.behind.map(boardName))}</p>
      )}
      {progress.local.length > 0 && (
        <p className="text-warning" data-network-local="">{NETWORK_COPY.local(progress.local.map(boardName))}</p>
      )}
      <Button variant="outline" size="sm" className="self-start" onClick={onEdit}>Change the network</Button>
    </div>
  );
}

type ProfileDraft = { ssid: string; psk: string; keep: boolean; open: boolean };

function profileDraft(profile: DeviceNetwork["wifi"][number] | undefined): ProfileDraft {
  return { ssid: profile?.ssid ?? "", psk: "", keep: profile?.psk_set === true, open: profile !== undefined && !profile.psk_set };
}

/** What the save sends for one profile: null keeps the stored password, "" is an open network. */
function profileWire(draft: ProfileDraft): { ssid: string; psk: string | null } {
  if (draft.open) return { ssid: draft.ssid.trim(), psk: "" };
  if (draft.psk === "" && draft.keep) return { ssid: draft.ssid.trim(), psk: null };
  return { ssid: draft.ssid.trim(), psk: draft.psk };
}

function profileProblem(draft: ProfileDraft, required: boolean): string | null {
  if (draft.ssid.trim() === "") return required ? NETWORK_COPY.ssidRequired : null;
  const ssid = ssidProblem(draft.ssid.trim());
  if (ssid) return ssid;
  if (draft.open) return null;
  if (draft.psk === "" && !draft.keep) return NETWORK_COPY.pskRequired;
  return draft.psk === "" ? null : pskProblem(draft.psk);
}

export function NetworkForm({ network, fallbackMinutes, onSaved, onStale, onClose }: {
  network: DeviceNetwork;
  fallbackMinutes: number | null;
  onSaved: (next: DeviceNetwork) => void;
  onStale: () => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [base, setBase] = useState(network.base ?? "");
  const [first, setFirst] = useState(() => profileDraft(network.wifi[0]));
  const [second, setSecond] = useState(() => profileDraft(network.wifi[1]));
  const baseReason = checkBaseUrl(base.trim());
  const baseProblem = baseReason === "ok" ? null : BASE_URL_WORDS[baseReason];
  const firstProblem = profileProblem(first, true);
  const secondProblem = profileProblem(second, false);
  const ready = baseProblem === null && firstProblem === null && secondProblem === null;

  const save = useCallback(async () => {
    const body: DeviceNetworkSave = {
      ver: network.ver, base: base.trim(),
      wifi: [profileWire(first), ...(second.ssid.trim() === "" ? [] : [profileWire(second)])],
    };
    try {
      const { value, proven, answered } = await writeOrReadBack(
        () => endpoints.adminDeviceNetworkSave(body),
        async () => {
          const now = await endpoints.adminDeviceNetwork();
          return now.ver > network.ver && now.base === body.base ? now : null;
        },
      );
      toast.push({ tone: "success", text: proven ? LOST_REPLY.proven(NETWORK_COPY.saved(value.ver), answered) : NETWORK_COPY.saved(value.ver) });
      onSaved(value);
    } catch (e) {
      if (e instanceof ApiError && e.code === "network_changed") onStale();
      throw e;
    }
  }, [network.ver, base, first, second, toast, onSaved, onStale]);

  return (
    <div className="flex flex-col gap-4" data-network-form="">
      <Field invalid={baseProblem !== null}>
        <FieldLabel>{NETWORK_COPY.baseLabel} <span className="text-text-muted">(required)</span></FieldLabel>
        <Input value={base} onChange={(e) => setBase(e.target.value)} autoComplete="off" spellCheck={false}
          inputMode="url" />
        {baseProblem ? <FieldError>{baseProblem}</FieldError> : <FieldDescription>{NETWORK_COPY.baseHint}</FieldDescription>}
      </Field>
      <ProfileFields title={NETWORK_COPY.firstTitle} draft={first} onChange={setFirst} problem={firstProblem} />
      <ProfileFields title={NETWORK_COPY.secondTitle} draft={second} onChange={setSecond} problem={secondProblem} />
      <div className="flex flex-wrap gap-2">
        <ConfirmDialog
          trigger={<Button>Save the network</Button>}
          title={NETWORK_COPY.confirmTitle}
          description={NETWORK_COPY.confirm(fallbackMinutes)}
          confirmLabel="Send it to the boards"
          cancelLabel="Not yet"
          tone="primary"
          onConfirm={save}
          action="save the club network"
          notReady={!ready}
          notReadyMessage={baseProblem ?? firstProblem ?? secondProblem ?? undefined}
          describe={(e) => unsureSentence(e, unsureWords("the boards keep the network they have", "the network was saved", "the Boards page"))
            ?? describeV3Refusal(e) ?? networkRefusal(e)}
        />
        <Button variant="outline" onClick={onClose}>Cancel</Button>
      </div>
    </div>
  );
}

/** The API's refusals are the `provision/` corpus reasons; say the base URL ones in the form's words. */
function networkRefusal(e: unknown): string | null {
  if (!(e instanceof ApiError) || !e.code) return null;
  const reason = e.code.replace(/^base_/, "") as keyof typeof BASE_URL_WORDS;
  return BASE_URL_WORDS[reason] ?? null;
}

function ProfileFields({ title, draft, onChange, problem }: {
  title: string; draft: ProfileDraft; onChange: (next: ProfileDraft) => void; problem: string | null;
}) {
  return (
    <fieldset className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <legend className="px-1 text-sm font-medium text-text-primary">{title}</legend>
      <Field>
        <FieldLabel>{NETWORK_COPY.ssidLabel}</FieldLabel>
        <Input value={draft.ssid} onChange={(e) => onChange({ ...draft, ssid: e.target.value })} autoComplete="off" spellCheck={false} />
      </Field>
      <Field>
        <FieldLabel>{NETWORK_COPY.pskLabel}</FieldLabel>
        <Input type="password" value={draft.psk} disabled={draft.open} autoComplete="new-password"
          onChange={(e) => onChange({ ...draft, psk: e.target.value })} />
        <FieldDescription>{draft.keep && !draft.open ? NETWORK_COPY.pskKept : NETWORK_COPY.pskHint}</FieldDescription>
      </Field>
      <label className="flex min-h-touch items-center gap-2 text-sm text-text-secondary">
        <Checkbox checked={draft.open} onCheckedChange={(checked) => onChange({ ...draft, open: checked === true, psk: "" })} />
        {NETWORK_COPY.openNetwork}
      </label>
      {problem && <p role="alert" className="text-sm text-danger-strong">{problem}</p>}
    </fieldset>
  );
}
