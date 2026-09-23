import { QrSvg } from "@/components/member-door/QrSvg";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { CountdownRing } from "@/components/ui/countdown-ring";
import { Racquet, WifiSlash } from "@/components/ui/icons";
import { PassCard } from "@/components/ui/pass-card";
import { Demo, Specimen, ThemePair } from "./parts";

/**
 * The pass card in its three states, with a static QR (a real encoding of a fixed demo string, so
 * the quiet zone and module size are the real ones). The ring is frozen at a fixed time left; the
 * page that owns the code drives it once a second.
 */
type PassState = "live" | "expiring" | "offline";

const STATES: readonly PassState[] = ["live", "expiring", "offline"];

const PERIOD_MS = 30_000;

const REMAINING: Record<PassState, number> = { live: 22_000, expiring: 4_000, offline: 17_000 };

function Meta({ state }: { state: PassState }) {
  const seconds = Math.ceil(REMAINING[state] / 1000);
  return (
    <>
      <CountdownRing periodMs={PERIOD_MS} remainingMs={REMAINING[state]} />
      <span className={state === "expiring" ? "font-medium text-warning-strong" : undefined}>{`New code in ${seconds} seconds`}</span>
      {state === "offline" ? (
        <Badge tone="warning" icon={<WifiSlash size={14} weight="bold" aria-hidden="true" />}>Offline · your code still works</Badge>
      ) : null}
    </>
  );
}

function Pass({ state }: { state: PassState }) {
  return (
    <PassCard
      label={`Member pass, ${state}`}
      clubName="Crusaders Squash Club"
      crest={<Racquet size={40} weight="duotone" aria-hidden="true" />}
      memberName="Nomsa Khumalo"
      avatar={<Avatar size={40}><AvatarFallback name="Nomsa Khumalo" /></Avatar>}
      qr={<QrSvg value="CRUSADERS-DEMO-PASS" className="size-40" />}
      code="482 913"
      meta={<Meta state={state} />}
      footer="Show this at the door or the court box."
    />
  );
}

export function PassCardSection() {
  return (
    <Demo title="Live, expiring, offline" note="The QR panel is white in both themes and in forced colours; the brand band stays navy at night. No watermark, ever.">
      <ThemePair>
        {() => (
          <div className="flex flex-col gap-8">
            {STATES.map((state) => (
              <Specimen key={state} label={state} className="items-center">
                <Pass state={state} />
              </Specimen>
            ))}
          </div>
        )}
      </ThemePair>
    </Demo>
  );
}
