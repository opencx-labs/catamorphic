import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { nativeGit } from "./native-git.js";

/*
 * A workspace's base as a Git remote (ADR 0353). A sandbox fetches the
 * commit it stands on with Git's own protocol instead of being handed a
 * pack: the transfer streams, a receiver that already holds some of it
 * (an image, a cache, an earlier base) is sent the rest, and how much
 * arrives (shallow, without blobs, a sparse cone) is the fetching
 * command's to say.
 *
 * The remote is a repository of its own, made for one request and thrown
 * away: it borrows the objects of the copy that holds the commit, ends
 * history at that commit, and advertises one branch at it. Over smart HTTP
 * `git upload-pack` serves a want only when it is reachable from what is
 * advertised, so the commit, its tree and its files can be fetched and
 * nothing else the copy holds, whatever object id a caller names.
 */

const COMMIT = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/** The one branch a checkout source advertises, at its commit. */
export const CHECKOUT_BRANCH = "base";

/** How long one `git upload-pack` may run. */
const UPLOAD_PACK_TIMEOUT_MS = 30 * 60_000;

/** A repository that serves one commit of another, and nothing else. */
export interface CheckoutSource {
  /** The bare repository `git upload-pack` serves. */
  directory: string;
  /** Remove it. Safe to call again. */
  dispose(): Promise<void>;
}

/**
 * Make a repository that serves `commit` of the repository at `repoPath`:
 * the commit with its tree, shallow there, on the branch
 * {@link CHECKOUT_BRANCH}. Nothing is written into `repoPath`.
 */
export async function openCheckoutSource(opts: {
  repoPath: string;
  commit: string;
}): Promise<CheckoutSource> {
  if (!COMMIT.test(opts.commit))
    throw new Error("A checkout source names a full commit id");
  const objects = path.resolve(
    opts.repoPath,
    (
      await nativeGit(opts.repoPath, ["rev-parse", "--git-path", "objects"])
    ).trim(),
  );
  if (/[\n"]/.test(objects))
    throw new Error("The repository's path cannot be served from");
  // The commit must be there whole before anything is advertised.
  await nativeGit(opts.repoPath, ["cat-file", "-e", `${opts.commit}^{commit}`]);
  const directory = await fs.mkdtemp(path.join(tmpdir(), "work-checkout-"));
  const dispose = () => fs.rm(directory, { recursive: true, force: true });
  try {
    await nativeGit(directory, [
      "init",
      "--bare",
      "--quiet",
      ...(opts.commit.length === 64 ? ["--object-format=sha256"] : []),
    ]);
    await fs.writeFile(
      path.join(directory, "objects", "info", "alternates"),
      `${objects}\n`,
    );
    // History ends here: nothing before the commit is reachable, so none
    // of it is served.
    await fs.writeFile(path.join(directory, "shallow"), `${opts.commit}\n`);
    await nativeGit(directory, [
      "update-ref",
      `refs/heads/${CHECKOUT_BRANCH}`,
      opts.commit,
    ]);
    await nativeGit(directory, [
      "symbolic-ref",
      "HEAD",
      `refs/heads/${CHECKOUT_BRANCH}`,
    ]);
    // A fetching command may leave blobs or trees out (`--filter`), and
    // ask for one later by its id: served when it is reachable from the
    // branch, which is all that "reachable" can mean in a repository
    // whose history ends at it.
    await nativeGit(directory, ["config", "uploadpack.allowFilter", "true"]);
    await nativeGit(directory, [
      "config",
      "uploadpack.allowReachableSHA1InWant",
      "true",
    ]);
    return { directory, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/**
 * Run `git upload-pack` on a checkout source and stream what it writes.
 * Protocol version 0 always: there the server checks that every want is
 * reachable from what it advertised, which version 2 does not. A request
 * the server refuses ends with Git's own error line for the client.
 */
async function* uploadPack(opts: {
  directory: string;
  args: readonly string[];
  request?: AsyncIterable<Uint8Array>;
  signal?: AbortSignal;
}): AsyncGenerator<Uint8Array> {
  const { GIT_PROTOCOL: _version, ...env } = process.env;
  const child = spawn(
    "git",
    ["upload-pack", "--stateless-rpc", ...opts.args, opts.directory],
    {
      env: { ...env, GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  const stop = () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  };
  const timer = setTimeout(stop, UPLOAD_PACK_TIMEOUT_MS);
  timer.unref?.();
  opts.signal?.addEventListener("abort", stop, { once: true });
  const spawned = new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
  // The request is written beside the read: a large negotiation fills
  // both pipes at once.
  const written = (async () => {
    try {
      if (opts.request)
        for await (const chunk of opts.request) {
          if (!child.stdin.write(chunk))
            await new Promise<void>((resolve) =>
              child.stdin.once("drain", () => resolve()),
            );
        }
    } catch {
      // A request that ends early ends the answer: Git says why.
    } finally {
      child.stdin.end();
    }
  })();
  child.stdin.on("error", () => {});
  try {
    await spawned;
    for await (const chunk of child.stdout)
      if (chunk instanceof Uint8Array) yield chunk;
    await written;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", stop);
    stop();
  }
}

/** What a smart HTTP `info/refs?service=git-upload-pack` answers with. */
export async function* advertiseCheckout(opts: {
  directory: string;
  signal?: AbortSignal;
}): AsyncGenerator<Uint8Array> {
  const service = "# service=git-upload-pack\n";
  yield new TextEncoder().encode(
    `${(service.length + 4).toString(16).padStart(4, "0")}${service}0000`,
  );
  yield* uploadPack({ ...opts, args: ["--advertise-refs"] });
}

/** What a smart HTTP `git-upload-pack` request answers with. */
export function serveCheckout(opts: {
  directory: string;
  /** The request's body, already decoded when it was compressed. */
  request: AsyncIterable<Uint8Array>;
  signal?: AbortSignal;
}): AsyncGenerator<Uint8Array> {
  return uploadPack({ ...opts, args: [] });
}
