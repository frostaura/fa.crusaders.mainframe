import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Alert } from "./Alert";
import { DoorShutControl } from "./doors/DoorShutControl";

/**
 * How loudly an alert speaks, and who decides.
 *
 * <p>
 * <b>The tone is what it LOOKS like; the urgency is what it DOES.</b> `Alert` derived the
 * second from the first — `danger` and `warning` became `role="alert"`, everything else
 * `role="status"` — and for a refusal that arrives because somebody just pressed something
 * that is right: assertive interrupts whatever the screen reader was saying, which is what a
 * refusal needs.
 * </p>
 *
 * <p>
 * It is wrong for a STANDING notice. "This door is shut" is a fact about the screen a person
 * has just arrived at, not an event; announced assertively it cuts across the heading and the
 * first paragraph the reader was working through, and it does it again on every re-render and
 * every route change. An assertive region used for the state of things is one people learn to
 * talk over, and the refusals go with it — which is the failure this whole distinction exists
 * to prevent.
 * </p>
 *
 * <p>
 * The default stays exactly as it was, deliberately: fifteen call sites across the product
 * pass no `live` at all, and a component that changes what every one of them announces is a
 * change nobody reviewed. Only a call site that knows its notice is standing says so.
 * </p>
 */
describe("Alert — how loudly it speaks", () => {
  it("still interrupts for a danger a member has just caused", () => {
    render(<Alert tone="danger">Wrong password.</Alert>);
    expect(screen.getByRole("alert")).toHaveTextContent("Wrong password.");
  });

  it("still interrupts for a warning", () => {
    render(<Alert tone="warning">That court is about to close.</Alert>);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("still informs, rather than interrupting, for the quiet tones", () => {
    render(<Alert tone="info">Kept for 90 days.</Alert>);
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("lets a standing danger notice be polite without giving up the danger treatment", () => {
    render(<Alert tone="danger" live="polite">Front door is shut.</Alert>);

    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("Front door is shut.");
    expect(screen.queryByRole("alert"), "a standing fact still interrupts").not.toBeInTheDocument();
    // The look is the tone's, and it does not travel with the urgency: a shut door is still
    // shown in the danger treatment, it simply stops shouting about it.
    expect(notice.className).toContain("text-danger-strong");
  });

  it("can be given no live region at all", () => {
    render(<Alert tone="danger" live="off">Printed on a card in a cupboard.</Alert>);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("Printed on a card in a cupboard.")).toBeInTheDocument();
  });

  it("can make a quiet tone assertive, which is the other direction", () => {
    render(<Alert tone="info" live="assertive">Your code just expired.</Alert>);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  /**
   * The prop wins over a `role` in the spread, and that ordering is the point of the change.
   * A call site that wanted a polite standing notice had to reach past the component with
   * `role="status"` in `...props` — which worked only because the spread happened to come
   * after the role, i.e. by accident of line order rather than by design.
   */
  it("is not something a call site has to reach past the component to set", () => {
    render(<Alert tone="danger" live="polite" role="alert">Front door is shut.</Alert>);
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

/**
 * R3-26 / C-M1, C-M2 — a STANDING fact, said once.
 *
 * <p>
 * Reviewer C sat on the doors pages with a screen reader for three minutes. The shut banner was
 * mirrored into a `role="alert"` and a `role="status"` at once, so every announcement arrived
 * twice; the alert region was emptied to `""` between polls, which is a third event and an
 * interruption to a braille reader; and a door page re-rendering every fifteen seconds re-spoke
 * its fifty-word advisory each time. `polite` does not fix that — a live region announces on a
 * REMOUNT too, and these blocks are conditional on a payload that is re-read on a timer.
 * </p>
 */
describe("Alert — a standing fact, said once", () => {
  /** What a screen reader would actually be handed: the live region's text, not the banner's. */
  const spoken = () => [...document.querySelectorAll("[aria-live='polite']")]
    .map((n) => n.textContent ?? "").join("");

  it("says it once, in a region the banner's own re-render cannot touch", () => {
    const { rerender } = render(
      <Alert tone="danger" live="standing" announceKey="front-door">Front door is shut.</Alert>,
    );

    // The visible banner, and the invisible region that speaks for it — two nodes with the
    // same words, which is the shape: the words on screen never move, and the announcement is
    // a separate thing that happens once.
    expect(screen.getAllByText("Front door is shut.")).toHaveLength(2);
    // Not on the visible banner. A re-render of the banner is not an announcement.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(spoken()).toBe("Front door is shut.");

    // Twelve polls' worth of re-renders with the same fact. Still one announcement.
    for (let i = 0; i < 12; i += 1) {
      rerender(<Alert tone="danger" live="standing" announceKey="front-door">Front door is shut.</Alert>);
    }
    expect(spoken()).toBe("Front door is shut.");
  });

  it("survives the remount, which is what a poll actually does to a conditional block", () => {
    const banner = <Alert tone="danger" live="standing" announceKey="front-door">Front door is shut.</Alert>;
    const first = render(banner);
    expect(spoken()).toBe("Front door is shut.");
    first.unmount();

    // The payload comes back, the block mounts again, and a fresh live region with text in it
    // is an announcement — which is the defect. Component state cannot see this; the memory
    // has to outlive the component.
    render(banner);
    expect(spoken()).toBe("");
  });

  it("speaks again when the fact itself changes, including back to one it said before", () => {
    const shut = <Alert tone="danger" live="standing" announceKey="front-door">Front door is shut.</Alert>;
    const { rerender } = render(shut);
    expect(spoken()).toBe("Front door is shut.");

    rerender(<Alert tone="success" live="standing" announceKey="front-door">Front door is open again.</Alert>);
    expect(spoken()).toBe("Front door is open again.");

    // Shut, reopened, shut again in one evening: the second shut is news, and keying on the
    // text rather than on the channel would swallow it.
    rerender(shut);
    expect(spoken()).toBe("Front door is shut.");
  });

  it("never churns the region to an empty string", () => {
    const { rerender } = render(
      <Alert tone="danger" live="standing" announceKey="front-door">Front door is shut.</Alert>,
    );
    expect(spoken()).toBe("Front door is shut.");
    // A poll that briefly hands the banner nothing must not blank the region: emptying a live
    // region announces nothing and interrupts everything (C-M1).
    rerender(<Alert tone="danger" live="standing" announceKey="front-door">{"   "}</Alert>);
    expect(spoken()).toBe("Front door is shut.");
  });

  it("reads a sentence with markup in the middle of it as one sentence", () => {
    render(
      <Alert tone="danger" live="standing">
        <strong>Front door</strong> is shut. <a href="/admin/doors">Reopen it</a>
      </Alert>,
    );
    expect(spoken()).toBe("Front door is shut. Reopen it");
  });
});

/**
 * And the one call site this lane changed, because a prop nobody passes is a prop that
 * changed nothing.
 *
 * <p>
 * Found by mutation: reverting `DoorShutControl`'s `live="polite"` left the whole suite green.
 * The doors surface is another lane's, so this asserts the single line rather than the screen
 * around it — which is also the honest scope, since what is being held is that the prop above
 * is actually in use somewhere the finding was about.
 * </p>
 */
describe("the one standing notice on the doors surface", () => {
  const SHUT_DOOR = {
    id: "99999999-9999-9999-9999-999999999999", device_code: "gate-0a1b2c",
    name: "Front door", kind: "Gate", hardware: "Esp32", court_numbers: [],
    gate_key: "front-door", mac_address: "5ccf7f0a1b2c", enabled: false,
    last_seen_at: new Date().toISOString(), last_ip_address: "192.168.68.160",
    running_version: "1.0.0", mega_version: null, created_at: new Date().toISOString(),
    auto_registered: false, effective_heartbeat_seconds: 60, location_note: null,
    power_loss_behaviour: "not_established", out_of_service_since: new Date().toISOString(),
  };

  it("announces that a door is shut politely, not over whatever is being read", () => {
    render(
      <DoorShutControl
        door={SHUT_DOOR as Parameters<typeof DoorShutControl>[0]["door"]}
        onDone={() => Promise.resolve()}
        shutAt="09:48"
        online
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(/Front door/);
    expect(screen.queryByRole("alert"), "a shut door shouts over the page it is describing")
      .not.toBeInTheDocument();
  });
});
