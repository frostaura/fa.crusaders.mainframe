import { afterEach, describe, expect, it, vi } from "vitest";
import { api, OfflineError } from "../api";
import { outcomeUnknown } from "../bookingOutcome";
import { describeFailure } from "../errors";
import { writeOrReadBack } from "../lostReply";
import { OFFLINE_COPY } from "./offlineCopy";

/**
 * R4 wave B — writes offline say "needs a connection", and nothing is queued: a write with no
 * network at all is refused on the phone before anything is sent, and that refusal is KNOWN not
 * to have happened (no read-back, no "we can't tell").
 */

function offline(on: boolean) {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(!on);
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("a write with no network", () => {
  it("is refused before anything is sent", async () => {
    offline(true);
    const fetchSpy = vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetchSpy);
    await expect(api.post("/api/v1/bookings", { courtId: "c1" })).rejects.toBeInstanceOf(OfflineError);
    await expect(api.del("/api/v1/bookings/b1/players/p1")).rejects.toBeInstanceOf(OfflineError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not stop a read — the read fails or answers on its own", async () => {
    offline(true);
    const fetchSpy = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: 1 }), { status: 200 })));
    vi.stubGlobal("fetch", fetchSpy);
    await expect(api.get("/api/v1/wallet")).resolves.toEqual({ ok: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("online, a write is sent as ever", async () => {
    offline(false);
    const fetchSpy = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ booking_id: "b1" }), { status: 200 })));
    vi.stubGlobal("fetch", fetchSpy);
    await expect(api.post("/api/v1/bookings", {})).resolves.toEqual({ booking_id: "b1" });
  });

  it("is said as needing a connection, with nothing sent — never as the club's fault", () => {
    const said = describeFailure(new OfflineError(), { action: "book that court" });
    expect(said).toBe(`Couldn't book that court — ${OFFLINE_COPY.writeCause}`);
    expect(said).not.toMatch(/club's system/);
  });

  it("is known not to have landed: no read-back, the refusal is handed straight back", async () => {
    expect(outcomeUnknown(new OfflineError())).toBe(false);
    const readBack = vi.fn(() => Promise.resolve("landed"));
    await expect(writeOrReadBack(() => Promise.reject(new OfflineError()), readBack)).rejects.toBeInstanceOf(OfflineError);
    expect(readBack).not.toHaveBeenCalled();
  });
});
