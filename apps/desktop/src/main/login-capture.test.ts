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
    tracker.submit(1, {
      frameId: 0,
      origin,
      username: "alice",
      password: "pw",
    });
    expect(
      tracker.formsReported(1, {
        frameId: 0,
        origin: "https://app.example.com",
        passwordForms: 0,
        load: true,
      }),
    ).toEqual({ origin, username: "alice", password: "pw", generated: false });
    // Offered once.
    expect(
      tracker.formsReported(1, {
        frameId: 0,
        origin,
        passwordForms: 0,
        load: true,
      }),
    ).toBeNull();
  });

  it("drops a login when the same site loads its password form again", () => {
    const { tracker } = capture();
    tracker.submit(1, {
      frameId: 0,
      origin,
      username: "alice",
      password: "wrong",
    });
    expect(
      tracker.formsReported(1, {
        frameId: 0,
        origin,
        passwordForms: 1,
        load: true,
      }),
    ).toBeNull();
    expect(
      tracker.formsReported(1, {
        frameId: 0,
        origin,
        passwordForms: 0,
        load: true,
      }),
    ).toBeNull();
  });

  it("waits while an in-place form is still on screen, then offers when it goes", () => {
    const { tracker } = capture();
    tracker.submit(1, {
      frameId: 0,
      origin,
      username: "alice",
      password: "pw",
    });
    expect(
      tracker.formsReported(1, {
        frameId: 0,
        origin,
        passwordForms: 1,
        load: false,
      }),
    ).toBeNull();
    expect(
      tracker.formsReported(1, {
        frameId: 0,
        origin,
        passwordForms: 0,
        load: false,
      }),
    ).toMatchObject({ username: "alice" });
  });

  it("borrows the username from an email-first step", () => {
    const { tracker } = capture();
    tracker.rememberUsername(1, origin, "alice@example.com", 0);
    expect(
      tracker.submit(1, { frameId: 0, origin, username: "", password: "pw" }),
    ).toMatchObject({ username: "alice@example.com" });
    // Not across sites.
    expect(
      tracker.submit(1, {
        frameId: 0,
        origin: "https://other.example",
        username: "",
        password: "pw2",
      }),
    ).toMatchObject({ username: "" });
  });

  it("marks a generated password and ignores the duplicate submit event", () => {
    const { tracker, advance } = capture();
    tracker.markGenerated(1, origin, "Gen-3rated.pw", 0);
    expect(
      tracker.submit(1, {
        frameId: 0,
        origin,
        username: "new",
        password: "Gen-3rated.pw",
      }),
    ).toMatchObject({ generated: true });
    advance(50);
    expect(
      tracker.submit(1, {
        frameId: 0,
        origin,
        username: "new",
        password: "Gen-3rated.pw",
      }),
    ).toBeNull();
    // Generated logins save at once; nothing waits for the next page.
    expect(
      tracker.formsReported(1, {
        frameId: 0,
        origin,
        passwordForms: 0,
        load: true,
      }),
    ).toBeNull();
  });

  it("forgets a sign-in that never lands", () => {
    const { tracker, advance } = capture();
    tracker.submit(1, {
      frameId: 0,
      origin,
      username: "alice",
      password: "pw",
    });
    advance(61_000);
    expect(
      tracker.formsReported(1, {
        frameId: 0,
        origin,
        passwordForms: 0,
        load: true,
      }),
    ).toBeNull();
  });

  it("waits for the submitting frame, ignoring its parent and siblings", () => {
    const { tracker } = capture();
    tracker.submit(1, {
      origin,
      username: "alice",
      password: "pw",
      frameId: 2,
    });
    for (const frameId of [1, 3]) {
      expect(
        tracker.formsReported(1, {
          origin,
          frameId,
          passwordForms: 0,
          load: true,
        }),
      ).toBeNull();
    }
    expect(
      tracker.framesChanged(
        1,
        [1, 2, 3].map((frameId) => ({ frameId, origin })),
      ),
    ).toBeNull();
    expect(
      tracker.formsReported(1, {
        origin,
        frameId: 2,
        passwordForms: 0,
        load: false,
      }),
    ).toMatchObject({ origin, username: "alice", password: "pw" });
  });

  it("rejects a failed iframe login even after its parent reports no forms", () => {
    const { tracker } = capture();
    tracker.submit(1, {
      origin,
      username: "alice",
      password: "wrong",
      frameId: 2,
    });
    tracker.formsReported(1, {
      origin,
      frameId: 1,
      passwordForms: 0,
      load: true,
    });
    tracker.formsReported(1, {
      origin,
      frameId: 2,
      passwordForms: 1,
      load: true,
    });
    expect(
      tracker.formsReported(1, {
        origin,
        frameId: 2,
        passwordForms: 0,
        load: false,
      }),
    ).toBeNull();
  });

  it("offers a removed iframe's login only after every remaining frame reports", () => {
    const { tracker } = capture();
    const parent = "https://developer.example.com";
    const frames = [
      { frameId: 1, origin: parent },
      { frameId: 3, origin },
    ];
    tracker.submit(1, {
      origin,
      username: "alice",
      password: "pw",
      frameId: 2,
    });
    tracker.formsReported(1, {
      origin: parent,
      frameId: 1,
      passwordForms: 0,
      load: true,
    });
    expect(tracker.framesChanged(1, frames)).toBeNull();
    tracker.formsReported(1, {
      origin,
      frameId: 3,
      passwordForms: 0,
      load: true,
    });
    expect(tracker.framesChanged(1, frames)).toEqual({
      origin,
      username: "alice",
      password: "pw",
      generated: false,
    });
    expect(tracker.framesChanged(1, frames)).toBeNull();
  });

  it("does not treat a replacement login iframe as a successful landing", () => {
    const { tracker } = capture();
    tracker.submit(1, {
      origin,
      username: "alice",
      password: "wrong",
      frameId: 2,
    });
    tracker.formsReported(1, {
      origin,
      frameId: 3,
      passwordForms: 1,
      load: true,
    });
    expect(tracker.framesChanged(1, [{ frameId: 3, origin }])).toBeNull();
    tracker.formsReported(1, {
      origin,
      frameId: 3,
      passwordForms: 0,
      load: false,
    });
    expect(tracker.framesChanged(1, [{ frameId: 3, origin }])).toBeNull();
  });

  it("does not borrow an old frame report after its origin changes", () => {
    const { tracker } = capture();
    tracker.formsReported(1, {
      origin,
      frameId: 1,
      passwordForms: 0,
      load: true,
    });
    tracker.submit(1, {
      origin,
      username: "alice",
      password: "pw",
      frameId: 2,
    });
    const nextOrigin = "https://app.example.com";
    expect(
      tracker.framesChanged(1, [{ frameId: 1, origin: nextOrigin }]),
    ).toBeNull();
    tracker.formsReported(1, {
      origin: nextOrigin,
      frameId: 1,
      passwordForms: 0,
      load: true,
    });
    expect(
      tracker.framesChanged(1, [{ frameId: 1, origin: nextOrigin }]),
    ).toMatchObject({ username: "alice" });
  });

  it("keeps email-first usernames and generated passwords in their own frame", () => {
    const { tracker } = capture();
    tracker.rememberUsername(1, origin, "alice", 2);
    tracker.rememberUsername(1, origin, "bob", 3);
    tracker.markGenerated(1, origin, "generated", 2);
    expect(
      tracker.submit(1, {
        origin,
        username: "",
        password: "generated",
        frameId: 3,
      }),
    ).toMatchObject({ username: "bob", generated: false });
    expect(
      tracker.submit(1, {
        origin,
        username: "",
        password: "generated",
        frameId: 2,
      }),
    ).toMatchObject({ username: "alice", generated: true });
  });

  it("waits for a fresh report after same-origin navigation", () => {
    const { tracker } = capture();
    tracker.formsReported(1, {
      origin,
      frameId: 1,
      passwordForms: 0,
      load: true,
    });
    tracker.submit(1, {
      origin,
      frameId: 2,
      username: "alice",
      password: "wrong",
    });
    tracker.frameNavigated(1, 1);
    const frames = [{ origin, frameId: 1 }];
    expect(tracker.framesChanged(1, frames)).toBeNull();
    tracker.formsReported(1, {
      origin,
      frameId: 1,
      passwordForms: 1,
      load: true,
    });
    expect(tracker.framesChanged(1, frames)).toBeNull();
    tracker.formsReported(1, {
      origin,
      frameId: 1,
      passwordForms: 0,
      load: false,
    });
    expect(tracker.framesChanged(1, frames)).toBeNull();
  });

  it("expires removed-frame candidates and forgets a closed tab's reports", () => {
    const { tracker, advance } = capture();
    tracker.formsReported(1, {
      origin,
      frameId: 1,
      passwordForms: 0,
      load: true,
    });
    tracker.submit(1, {
      origin,
      username: "alice",
      password: "pw",
      frameId: 2,
    });
    advance(61_000);
    expect(tracker.framesChanged(1, [{ frameId: 1, origin }])).toBeNull();
    tracker.forget(1);
    tracker.submit(1, {
      origin,
      username: "alice",
      password: "pw2",
      frameId: 2,
    });
    expect(tracker.framesChanged(1, [{ frameId: 1, origin }])).toBeNull();
  });
});
