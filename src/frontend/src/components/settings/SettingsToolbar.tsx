import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { SEARCH_FIELD } from "@/components/ui/layout";
import { cn } from "@/lib/utils";
import { MagnifyingGlass, X } from "@/components/ui/icons";
import { SETTINGS_COPY } from "@/lib/settingsCopy";

/**
 * Search, and open/close every section (plan R13: "a search box filters settings by label,
 * description and key, highlights matches, auto-expands matching sections").
 *
 * <p>
 * The search is the fastest route to any one of seventy settings for somebody who knows what they
 * want and not where it lives — which, on a page an admin visits a few times a year, is nearly
 * everybody. Escape clears it; the count of matches is announced politely so a screen reader
 * hears the filter work without being moved.
 * </p>
 */
export type SettingsToolbarProps = {
  query: string;
  onQueryChange: (next: string) => void;
  matches: number;
  allOpen: boolean;
  onToggleAll: () => void;
};

export function SettingsToolbar(props: SettingsToolbarProps) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { query, onQueryChange, matches, allOpen, onToggleAll } = props;
  const input = useRef<HTMLInputElement>(null);
  const searching = query.trim() !== "";
  return (
    <div className="flex flex-col gap-2">
      {/* R11 L11-1: the search has a rem basis, so at 200 % text it takes the whole row and
          "Open all" drops below it — a zero basis squeezed it to 54px under the button. */}
      <div className="flex flex-wrap items-center gap-2">
        <div role="search" className="relative min-w-0 flex-1 basis-40">
          <MagnifyingGlass
            size={20}
            aria-hidden="true"
            className={SEARCH_FIELD.icon}
          />
          <Input
            ref={input}
            type="search"
            aria-label={SETTINGS_COPY.searchLabel}
            placeholder={SETTINGS_COPY.searchPlaceholder}
            value={query}
            className={cn(SEARCH_FIELD.input, query && SEARCH_FIELD.clearRoom, "[&::-webkit-search-cancel-button]:hidden")}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.preventDefault();
                onQueryChange("");
              }
            }}
          />
          {query ? (
            <IconButton
              label={SETTINGS_COPY.clearSearch}
              size="icon-sm"
              className={SEARCH_FIELD.clear}
              onClick={() => { onQueryChange(""); input.current?.focus(); }}
            >
              <X />
            </IconButton>
          ) : null}
        </div>
        {searching ? null : (
          <Button variant="outline" className="shrink-0" onClick={onToggleAll}>
            {allOpen ? SETTINGS_COPY.collapseAll : SETTINGS_COPY.expandAll}
          </Button>
        )}
      </div>
      <p role="status" aria-live="polite" className="text-sm text-text-secondary">
        {searching ? SETTINGS_COPY.matchCount(matches) : SETTINGS_COPY.searchHint}
      </p>
    </div>
  );
}
