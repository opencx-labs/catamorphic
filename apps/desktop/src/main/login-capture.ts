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
    { origin: string; username: string; at: number }
  >();
  private generated = new Map<number, { origin: string; password: string }>();
  private recent = new Map<number, Pending>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A step that submitted a username with no password (email first). */
  rememberUsername(guestId: number, origin: string, username: string): void {
    if (!username) return;
    this.usernames.set(guestId, { origin, username, at: this.now() });
  }

  /** The user accepted a generated password for this page. */
  markGenerated(guestId: number, origin: string, password: string): void {
    this.generated.set(guestId, { origin, password });
  }

  /**
   * Record a submitted login. Returns the submission, or null when it
   * repeats the one just recorded (a click and its submit event).
   */
  submit(
    guestId: number,
    input: { origin: string; username: string; password: string },
  ): LoginSubmission | null {
    const now = this.now();
    const remembered = this.usernames.get(guestId);
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
        generated?.origin === input.origin &&
        generated.password === input.password,
      at: now,
    };
    const last = this.recent.get(guestId);
    this.recent.set(guestId, submission);
    if (
      last &&
      now - last.at < DUPLICATE_WINDOW_MS &&
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
    report: { origin: string; passwordForms: number; load: boolean },
  ): LoginSubmission | null {
    const pending = this.pending.get(guestId);
    if (!pending) return null;
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

  forget(guestId: number): void {
    this.pending.delete(guestId);
    this.usernames.delete(guestId);
    this.generated.delete(guestId);
    this.recent.delete(guestId);
  }
}

function strip({ at: _at, ...submission }: Pending): LoginSubmission {
  return submission;
}
