import { Skeleton } from "@/components/ui/skeleton";

/** The booking page's shape while it is read: four seat chips, two a side, and the money card. */
export function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-8">
      <div className="grid gap-4 sm:grid-cols-2">
        {[0, 1].map((team) => (
          <div key={team} className="flex flex-col gap-2">
            <Skeleton className="h-4 w-16" />
            {[0, 1].map((seat) => (
              <div key={seat} className="flex items-center gap-3 rounded-xl border border-border p-3">
                <Skeleton className="size-10 rounded-full" />
                <div className="flex flex-1 flex-col gap-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-4 w-16" />
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
      <Skeleton className="h-40 w-full rounded-xl" />
    </div>
  );
}
