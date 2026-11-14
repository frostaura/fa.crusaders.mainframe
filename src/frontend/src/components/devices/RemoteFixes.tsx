import type { AdminDevice, AdminSettings } from "../../lib/api";
import { AutoGrid } from "../ui/auto-grid";
import { Section } from "../ui/page-shell";
import { ClubNetworkPanel } from "./ClubNetworkPanel";
import { MemberCodesPanel } from "./MemberCodesPanel";

/**
 * Boards › What reaches the boards without a cable (device-api §8; member-code §8).
 *
 * <p>
 * Everything an operator may need to change on a board without a cable is here: the club network
 * the boards join and the member-code rollout. Firmware is not among it — the boards have no remote
 * update (device-api §7), so a firmware change is a cable flash. Each panel reads on its own and
 * is absent against an API that does not serve it (a 404 is "not served", never an empty answer).
 * </p>
 */
export function RemoteFixes({ devices, settings, outOfServiceWords, onChanged }: {
  devices: AdminDevice[];
  settings: AdminSettings | null;
  /** The page's consequence sentence for taking one board out of service. */
  outOfServiceWords: (deviceId: string) => string;
  onChanged: () => void;
}) {
  return (
    <Section title="Changing boards without a cable">
      <AutoGrid min="panel" max={2} gap="md" className="items-start">
        <ClubNetworkPanel devices={devices} fallbackMinutes={settings?.device_net_fallback_minutes ?? null} onChanged={onChanged} />
        <MemberCodesPanel devices={devices} outOfServiceWords={outOfServiceWords} onChanged={onChanged} />
      </AutoGrid>
    </Section>
  );
}
