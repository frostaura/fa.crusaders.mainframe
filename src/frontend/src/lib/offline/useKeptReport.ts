import { useCachedRead } from "./useCachedRead";
import type { MemberRead } from "./memberReads";

/**
 * R5 M5-6 — a member report read (Wallet activity) kept by `lib/offline`: the `Report` shape
 * `components/reports/range` gives its pages — `data` for THIS key only, the failure kept beside
 * it, `refresh` — drawn from the phone offline and on a revisit, with `stale`/`offline` for a
 * `StaleNotice`. Pass `memberReads.walletActivity(dayMarkers(range))`.
 */
export type KeptReport<T> = {
  data: T | null;
  error: unknown;
  loading: boolean;
  readAt: number | null;
  refresh: () => void;
  stale: boolean;
  offline: boolean;
};

export function useKeptReport<T>(read: MemberRead<T>): KeptReport<T> {
  const kept = useCachedRead<T>(read.key, read.load);
  return {
    data: kept.data,
    error: kept.error,
    loading: kept.loading,
    readAt: kept.readAt,
    refresh: kept.reload,
    stale: kept.stale,
    offline: kept.offline,
  };
}
