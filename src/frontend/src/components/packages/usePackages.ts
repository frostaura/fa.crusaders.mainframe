import { useCallback, useEffect, useState } from "react";
import { adminEndpoints, type AdminPackage, type MemberGroup, type PackageStatus } from "@/lib/adminApi";

/**
 * The Packages page's two reads: the packages in the chosen view, and the club's groups (for the
 * shelf headings and the "who can buy it" choice). A failed refresh keeps what is on screen
 * (R4: `StaleNotice`); only a view never read is a failure in its place.
 */
export type PackagesRead = {
  packages: AdminPackage[] | null;
  /** Every package on sale, whichever view is shown — the shelf a draft's saving is measured on. */
  active: AdminPackage[] | null;
  error: unknown;
  loading: boolean;
  readAt: number | null;
  load: () => Promise<void>;
  /** The server's answer to a save, put on screen at once (the re-read follows). */
  settle: (saved: AdminPackage) => void;
};

export function usePackages(view: PackageStatus): PackagesRead {
  const [all, setAll] = useState<AdminPackage[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [readAt, setReadAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // "all": one read serves both views and the saving preview, which needs the active shelf.
      setAll((await adminEndpoints.packages("all")).packages);
      setReadAt(Date.now());
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount loader; sync loading flag is the house idiom
  useEffect(() => { void load(); }, [load]);

  const settle = useCallback((saved: AdminPackage) => {
    setAll((rows) => {
      if (!rows) return rows;
      return rows.some((p) => p.id === saved.id) ? rows.map((p) => (p.id === saved.id ? saved : p)) : [...rows, saved];
    });
  }, []);

  return {
    packages: all ? all.filter((p) => p.status === view) : null,
    active: all ? all.filter((p) => p.status === "active") : null,
    error,
    loading,
    readAt,
    load,
    settle,
  };
}

/** The club's active groups, or a failure — never an empty list standing in for one. */
export type GroupsRead = { status: "loading" } | { status: "failed"; error: unknown } | { status: "ready"; groups: MemberGroup[] };

export function useActiveGroups(): GroupsRead {
  const [state, setState] = useState<GroupsRead>({ status: "loading" });
  useEffect(() => {
    let live = true;
    adminEndpoints.memberGroups()
      .then((r) => { if (live) setState({ status: "ready", groups: r.groups.filter((g) => (g.status ?? "active") === "active") }); })
      .catch((error: unknown) => { if (live) setState({ status: "failed", error }); });
    return () => { live = false; };
  }, []);
  return state;
}
