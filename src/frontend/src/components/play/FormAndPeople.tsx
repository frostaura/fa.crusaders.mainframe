import { TextLink } from "@/components/ui/text-link";
import type { FormEntry, Opponent, Partner } from "@/lib/playApi";
import { PEOPLE_COPY, playWhen } from "@/lib/playCopy";
import { cn } from "@/lib/utils";
import { PlayerAvatar } from "./PlayerAvatar";

/**
 * Form and people (§9.1.4): the last five confirmed results as W / L chips — the LETTER is the
 * signal, colour only a cue — the three members played with most, and the three toughest
 * opponents head to head. Then the way to every result.
 *
 * <p>
 * Every name here is somebody the member played with; nothing about them beyond the shared
 * games is shown, and none of this is visible to anybody else (§10).
 * </p>
 */
export function FormAndPeople({ form, partners, opponents }: { form: FormEntry[]; partners: Partner[]; opponents: Opponent[] }) {
  return (
    <div className="flex flex-col gap-5">
      <FormChips form={form} />
      <div className="grid gap-5 sm:grid-cols-2">
        <Partners partners={partners} />
        <Opponents opponents={opponents} />
      </div>
      <div>
        <TextLink to="/profile/results" variant="standalone">{PEOPLE_COPY.allResults}</TextLink>
      </div>
    </div>
  );
}

function Heading({ children }: { children: string }) {
  return <h3 className="text-sm font-semibold text-text-primary">{children}</h3>;
}

function FormChips({ form }: { form: FormEntry[] }) {
  return (
    <div className="flex flex-col gap-2">
      <Heading>{PEOPLE_COPY.formTitle}</Heading>
      {form.length === 0 ? (
        <p className="text-sm text-text-secondary">{PEOPLE_COPY.formEmpty}</p>
      ) : (
        <>
          <ol data-form="" aria-label={PEOPLE_COPY.formHint} className="flex flex-wrap gap-1.5">
            {form.map((entry) => {
              const won = entry.outcome === "won";
              return (
                <li
                  key={entry.result_id}
                  data-outcome={entry.outcome}
                  className={cn(
                    "flex size-9 items-center justify-center rounded-lg text-sm font-bold",
                    won ? "bg-success-soft text-success-strong" : "bg-bg-muted text-text-secondary",
                  )}
                >
                  <span aria-hidden="true">{won ? PEOPLE_COPY.won : PEOPLE_COPY.lost}</span>
                  <span className="sr-only">
                    {PEOPLE_COPY.formItem(won ? PEOPLE_COPY.wonWord : PEOPLE_COPY.lostWord, playWhen(entry.starts_at))}
                  </span>
                </li>
              );
            })}
          </ol>
          <p className="text-xs text-text-secondary">{PEOPLE_COPY.formHint}</p>
        </>
      )}
    </div>
  );
}

function Partners({ partners }: { partners: Partner[] }) {
  return (
    <div className="flex flex-col gap-2">
      <Heading>{PEOPLE_COPY.partnersTitle}</Heading>
      {partners.length === 0 ? <p className="text-sm text-text-secondary">{PEOPLE_COPY.partnersEmpty}</p> : (
        <ul data-partners="" className="flex flex-col gap-2">
          {partners.map((p) => (
            <li key={p.user_id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <PlayerAvatar name={p.name} photo={p.photo_url} />
              <span className="min-w-0 grow basis-24 break-words text-sm font-medium text-text-primary">{p.name}</span>
              <span className="break-words text-xs tabular-nums text-text-secondary">{PEOPLE_COPY.sessionsWith(p.sessions)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Opponents({ opponents }: { opponents: Opponent[] }) {
  return (
    <div className="flex flex-col gap-2">
      <Heading>{PEOPLE_COPY.opponentsTitle}</Heading>
      {opponents.length === 0 ? <p className="text-sm text-text-secondary">{PEOPLE_COPY.opponentsEmpty}</p> : (
        <ul data-opponents="" className="flex flex-col gap-2">
          {opponents.map((o) => (
            <li key={o.user_id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <PlayerAvatar name={o.name} photo={o.photo_url} />
              <span className="min-w-0 grow basis-24 break-words text-sm font-medium text-text-primary">{o.name}</span>
              <span aria-hidden="true" className="text-sm font-semibold tabular-nums text-text-primary">
                {PEOPLE_COPY.headToHead(o.won, o.lost)}
              </span>
              <span className="sr-only">{PEOPLE_COPY.headToHeadLabel(o.name, o.won, o.lost)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
