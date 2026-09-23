import { Section } from "@/components/ui/page-shell";
import { NIGHT_TAB_COPY } from "@/lib/memberDetailCopy";
import { MemberNight } from "../../monitoring/MemberNight";
import { useMemberDetail } from "./useMemberDetail";

/**
 * Night — a person's evening at the club, in the order it happened, on the person's own page
 * (R17). The founder: "a person's night should be navigated from clicking member in grid". The
 * surface itself — its privacy notice, its audit promise, its club-day default — is
 * `MemberNight`, unchanged in what it promises; this tab only supplies who.
 */
export function MemberNightTab() {
  const { userId, name } = useMemberDetail();
  return (
    <Section title={NIGHT_TAB_COPY.title}>
      <MemberNight userId={userId} name={name} />
    </Section>
  );
}
