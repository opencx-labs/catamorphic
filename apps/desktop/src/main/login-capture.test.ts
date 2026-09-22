import { describe, expect, it } from "vitest";
import { LoginCapture } from "./login-capture.js";

const origin = "https://accounts.example.com";

function capture() {
  let now = 1_000;
  const tracker = new LoginCapture(() => now);
  return {
    tracker,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("LoginCapture", () => {
  it("offers a login once the next page has no password form", () => {
    const { tracker } = capture();
    tracker.submit(1, { origin, username: "alice", password: "pw" });
    expect(
      tracker.formsReported(1, {
        origin: "https://app.example.com",
        passwordForms: 0,
        load: true,
      }),
    ).toEqual({ origin, username: "alice", password: "pw", generated: false });
    // Offered once.
    expect(
      tracker.formsReported(1, { origin, passwordForms: 0, load: true }),
    ).toBeNull();
  });

  it("drops a login when the same site loads its password form again", () => {
    const { tracker } = capture();
    tracker.submit(1, { origin, username: "alice", password: "wrong" });
    expect(
      tracker.formsReported(1, { origin, passwordForms: 1, load: true }),
    ).toBeNull();
    expect(
      tracker.formsReported(1, { origin, passwordForms: 0, load: true }),
    ).toBeNull();
  });

  it("waits while an in-place form is still on screen, then offers when it goes", () => {
    const { tracker } = capture();
    tracker.submit(1, { origin, username: "alice", password: "pw" });
    expect(
      tracker.formsReported(1, { origin, passwordForms: 1, load: false }),
    ).toBeNull();
    expect(
      tracker.formsReported(1, { origin, passwordForms: 0, load: false }),
    ).toMatchObject({ username: "alice" });
  });

  it("borrows the username from an email-first step", () => {
    const { tracker } = capture();
    tracker.rememberUsername(1, origin, "alice@example.com");
    expect(
      tracker.submit(1, { origin, username: "", password: "pw" }),
    ).toMatchObject({ username: "alice@example.com" });
    // Not across sites.
    expect(
      tracker.submit(1, {
        origin: "https://other.example",
        username: "",
        password: "pw2",
      }),
    ).toMatchObject({ username: "" });
  });

  it("marks a generated password and ignores the duplicate submit event", () => {
    const { tracker, advance } = capture();
    tracker.markGenerated(1, origin, "Gen-3rated.pw");
    expect(
      tracker.submit(1, { origin, username: "new", password: "Gen-3rated.pw" }),
    ).toMatchObject({ generated: true });
    advance(50);
    expect(
      tracker.submit(1, { origin, username: "new", password: "Gen-3rated.pw" }),
    ).toBeNull();
    // Generated logins save at once; nothing waits for the next page.
    expect(
      tracker.formsReported(1, { origin, passwordForms: 0, load: true }),
    ).toBeNull();
  });

  it("forgets a sign-in that never lands", () => {
    const { tracker, advance } = capture();
    tracker.submit(1, { origin, username: "alice", password: "pw" });
    advance(61_000);
    expect(
      tracker.formsReported(1, { origin, passwordForms: 0, load: true }),
    ).toBeNull();
  });
});
