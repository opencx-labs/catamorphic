import type { GitCloneOpts } from "./types.js";

/**
 * What a machine says about a failure is recorded and shown: in a remote
 * operation's receipt, a chat's log, a span. Credentials never travel in it
 * (ADR 0206).
 */

/** A URL's user information, `user:password@`, up to its host. */
const URL_USER_INFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@"'<>]+@/gi;
/** Shorter values are too common to cut from a message. */
const MIN_SECRET_LENGTH = 4;

/** `text` with the user information of every URL in it replaced. */
export function redactUrlCredentials(text: string): string {
  return text.replace(URL_USER_INFO, "$1[redacted]@");
}

/** The URL `git clone` is given: `url` with the clone's username and password. */
export function gitCloneUrl(url: string, opts?: GitCloneOpts): string {
  if (!opts?.username && !opts?.password) return url;
  const parsed = new URL(url);
  if (opts.username) parsed.username = opts.username;
  if (opts.password) parsed.password = opts.password;
  return parsed.toString();
}

/**
 * The error of a failed `git clone`, whose output may repeat the URL it was
 * given: never the credentialed URL, its username or its password.
 */
export function gitCloneFailure(args: {
  output: string;
  opts?: GitCloneOpts;
}): Error {
  const secrets = [args.opts?.password, args.opts?.username]
    .filter(
      (value): value is string =>
        value !== undefined && value.length >= MIN_SECRET_LENGTH,
    )
    .flatMap((value) => [value, encodeURIComponent(value)]);
  const output = secrets.reduce(
    (text, secret) => text.replaceAll(secret, "[redacted]"),
    redactUrlCredentials(args.output),
  );
  return new Error(`git clone failed: ${output}`);
}
