/**
 * When a submitted login is worth saving, Chrome-style. A submission is
 * only a candidate: it becomes an offer once the sign-in evidently worked
 * (the next page has no password form, or the form went away in place),
 * and a page that comes back with the same password form means it failed.
 * Multi-step sign-ins (email first, password next) borrow the username
 * the earlier step submitted. Pure bookkeeping, keyed by guest
 * WebContents id, so it runs without Electron in tests.
 */

export interface LoginSubmission {
  origin: string;
  username: string;
  password: string;
  /** The password is one this browser generated for the page. */
  generated: boolean;
}

interface Pending extends LoginSubmission {
  at: number;
  frameId: number;
}

/** A sign-in that takes longer than this to land is not tracked. */
const PENDING_LIFETIME_MS = 60_000;
/** An email-first step's username stays usable this long. */
const USERNAME_LIFETIME_MS = 10 * 60_000;
/** The click and the submit event of one sign-in arrive together. */
const DUPLICATE_WINDOW_MS = 2_000;

export class LoginCapture {
  private pending = new Map<number, Pending>();
  private usernames = new Map<
    number,
    Map<number, { origin: string; username: string; at: number }>
  >();
  private generated = new Map<
    number,
    { origin: string; password: string; frameId: number }
  >();
  private recent = new Map<number, Pending>();
  private forms = new Map<
    number,
    Map<number, { origin: string; passwordForms: number }>
  >();

  constructor(private readonly now: () => number = Date.now) {}

  /** A step that submitted a username with no password (email first). */
  rememberUsername(
    guestId: number,
    origin: string,
    username: string,
    frameId: number,
  ): void {
    if (!username) return;
    const usernames = this.usernames.get(guestId) ?? new Map();
    usernames.set(frameId, { origin, username, at: this.now() });
    this.usernames.set(guestId, usernames);
  }

  /** The user accepted a generated password for this page. */
  markGenerated(
    guestId: number,
    origin: string,
    password: string,
    frameId: number,
  ): void {
    this.generated.set(guestId, { origin, password, frameId });
  }

  /**
   * Record a submitted login. Returns the submission, or null when it
   * repeats the one just recorded (a click and its submit event).
   */
  submit(
    guestId: number,
    input: {
      origin: string;
      username: string;
      password: string;
      frameId: number;
    },
  ): LoginSubmission | null {
    const now = this.now();
    const frameId = input.frameId;
    const remembered = this.usernames.get(guestId)?.get(frameId);
    const username =
      input.username ||
      (remembered &&
      remembered.origin === input.origin &&
      now - remembered.at < USERNAME_LIFETIME_MS
        ? remembered.username
        : "");
    const generated = this.generated.get(guestId);
    const submission: Pending = {
      origin: input.origin,
      username,
      password: input.password,
      generated:
        generated?.frameId === frameId &&
        generated.origin === input.origin &&
        generated.password === input.password,
      at: now,
      frameId,
    };
    const last = this.recent.get(guestId);
    this.recent.set(guestId, submission);
    if (
      last &&
      now - last.at < DUPLICATE_WINDOW_MS &&
      last.frameId === frameId &&
      last.origin === submission.origin &&
      last.username === submission.username &&
      last.password === submission.password
    ) {
      return null;
    }
    if (submission.generated) {
      // Saved at once; nothing left to confirm.
      this.generated.delete(guestId);
      this.pending.delete(guestId);
    } else {
      this.pending.set(guestId, submission);
    }
    return strip(submission);
  }

  /**
   * The guest reported its password forms. `load` marks the first report
   * of a newly loaded document; later reports follow DOM changes. Returns
   * the pending submission when this report shows the sign-in worked.
   */
  formsReported(
    guestId: number,
    report: {
      origin: string;
      passwordForms: number;
      load: boolean;
      frameId: number;
    },
  ): LoginSubmission | null {
    const frameId = report.frameId;
    const forms = this.forms.get(guestId) ?? new Map();
    forms.set(frameId, {
      origin: report.origin,
      passwordForms: report.passwordForms,
    });
    this.forms.set(guestId, forms);
    const pending = this.pending.get(guestId);
    if (!pending || pending.frameId !== frameId) return null;
    if (this.now() - pending.at > PENDING_LIFETIME_MS) {
      this.pending.delete(guestId);
      return null;
    }
    if (report.passwordForms > 0) {
      // The same site loading a password form again: the sign-in failed.
      // A form that is still there after a DOM change: still deciding.
      if (report.load && report.origin === pending.origin)
        this.pending.delete(guestId);
      return null;
    }
    this.pending.delete(guestId);
    return strip(pending);
  }

  /** A committed document must report for itself, even at the same origin. */
  frameNavigated(guestId: number, frameId: number): void {
    this.forms.get(guestId)?.delete(frameId);
  }

  /** A submitted frame left the page. Wait for every remaining web frame's report. */
  framesChanged(
    guestId: number,
    frames: ReadonlyArray<{ frameId: number; origin: string }>,
  ): LoginSubmission | null {
    const live = new Set(frames.map((frame) => frame.frameId));
    const forms = this.forms.get(guestId);
    for (const frameId of forms?.keys() ?? []) {
      if (!live.has(frameId)) forms?.delete(frameId);
    }
    const usernames = this.usernames.get(guestId);
    for (const frameId of usernames?.keys() ?? []) {
      if (!live.has(frameId)) usernames?.delete(frameId);
    }
    const pending = this.pending.get(guestId);
    if (!pending) return null;
    if (this.now() - pending.at > PENDING_LIFETIME_MS) {
      this.pending.delete(guestId);
      return null;
    }
    if (live.has(pending.frameId) || frames.length === 0) return null;
    const reports = frames.map((frame) => {
      const report = forms?.get(frame.frameId);
      return report?.origin === frame.origin ? report : undefined;
    });
    if (reports.some((report) => !report)) return null;
    // A replacement login frame is a rejection, not a successful landing.
    if (reports.some((report) => report && report.passwordForms > 0)) {
      if (
        reports.some(
          (report) =>
            report?.origin === pending.origin && report.passwordForms > 0,
        )
      )
        this.pending.delete(guestId);
      return null;
    }
    this.pending.delete(guestId);
    return strip(pending);
  }

  forget(guestId: number): void {
    this.pending.delete(guestId);
    this.usernames.delete(guestId);
    this.generated.delete(guestId);
    this.recent.delete(guestId);
    this.forms.delete(guestId);
  }
}

function strip({
  at: _at,
  frameId: _frameId,
  ...submission
}: Pending): LoginSubmission {
  return submission;
}
