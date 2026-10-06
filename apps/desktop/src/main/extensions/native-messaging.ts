import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Native messaging (ADR 0203): an extension talking to an app installed on
 * the machine through a host the app registered. Chrome's rules hold: the
 * host's manifest must name the calling extension in `allowed_origins`, the
 * extension must have the `nativeMessaging` permission, and the host runs
 * directly (no shell) with the caller's origin as its argument. Work reads
 * registrations made for Work, then those made for Google Chrome and
 * Chromium, which is where Claude, Codex and password managers register.
 */

export const NATIVE_HOST_NAME = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;
/** Chrome's limit on one message from a host. */
const MAX_FROM_HOST = 1024 * 1024;
const MAX_TO_HOST = 64 * 1024 * 1024;

export const NATIVE_ERRORS = {
  notFound: "Specified native messaging host not found.",
  forbidden: "Access to the specified native messaging host is forbidden.",
  exited: "Native host has exited.",
  failed: "Error when communicating with the native messaging host.",
} as const;

export function nativeHostDirs(userData: string): string[] {
  const home = os.homedir();
  const own = path.join(userData, "NativeMessagingHosts");
  if (process.platform === "darwin")
    return [
      own,
      path.join(
        home,
        "Library/Application Support/Google/Chrome/NativeMessagingHosts",
      ),
      "/Library/Google/Chrome/NativeMessagingHosts",
      path.join(
        home,
        "Library/Application Support/Chromium/NativeMessagingHosts",
      ),
      "/Library/Application Support/Chromium/NativeMessagingHosts",
    ];
  return [
    own,
    path.join(home, ".config/google-chrome/NativeMessagingHosts"),
    "/etc/opt/chrome/native-messaging-hosts",
    path.join(home, ".config/chromium/NativeMessagingHosts"),
    "/etc/chromium/native-messaging-hosts",
  ];
}

export interface NativeHost {
  name: string;
  path: string;
}

/** The registered host `name` may start for `extensionId`, or an error. */
export function resolveNativeHost(
  name: string,
  extensionId: string,
  dirs: readonly string[],
): NativeHost | { error: string } {
  if (!NATIVE_HOST_NAME.test(name)) return { error: NATIVE_ERRORS.notFound };
  for (const dir of dirs) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, `${name}.json`), "utf-8");
    } catch {
      continue;
    }
    let manifest: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return { error: NATIVE_ERRORS.notFound };
      manifest = parsed as Record<string, unknown>;
    } catch {
      return { error: NATIVE_ERRORS.notFound };
    }
    if (manifest.name !== name || manifest.type !== "stdio")
      return { error: NATIVE_ERRORS.notFound };
    const executable = manifest.path;
    if (typeof executable !== "string" || !path.isAbsolute(executable))
      return { error: NATIVE_ERRORS.notFound };
    const origins = manifest.allowed_origins;
    if (
      !Array.isArray(origins) ||
      !origins.includes(`chrome-extension://${extensionId}/`)
    )
      return { error: NATIVE_ERRORS.forbidden };
    return { name, path: executable };
  }
  return { error: NATIVE_ERRORS.notFound };
}

/** Length-prefixed JSON, in this machine's byte order (always little). */
export function encodeNativeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message ?? null), "utf-8");
  if (body.length > MAX_TO_HOST) throw new Error("Message too large.");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(body.length);
  return Buffer.concat([length, body]);
}

/** Splits a host's stdout into messages; throws on a malformed stream. */
export class NativeMessageReader {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > MAX_FROM_HOST) throw new Error(NATIVE_ERRORS.failed);
      if (this.buffer.length < 4 + length) break;
      const body = this.buffer.subarray(4, 4 + length).toString("utf-8");
      this.buffer = this.buffer.subarray(4 + length);
      messages.push(JSON.parse(body));
    }
    return messages;
  }
}

export interface NativePortEvents {
  message: (message: unknown) => void;
  /** The port ended; `error` is null when the extension closed it. */
  close: (error: string | null) => void;
}

/** One running host for one port. */
export class NativePort {
  private readonly child: ChildProcess;
  private readonly reader = new NativeMessageReader();
  private closed = false;

  constructor(
    host: NativeHost,
    extensionId: string,
    private readonly events: NativePortEvents,
  ) {
    this.child = spawn(host.path, [`chrome-extension://${extensionId}/`], {
      cwd: path.dirname(host.path),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    this.child.on("error", () => this.finish(NATIVE_ERRORS.notFound));
    this.child.on("exit", () => this.finish(NATIVE_ERRORS.exited));
    this.child.stdout?.on("data", (chunk: Buffer) => {
      let messages: unknown[];
      try {
        messages = this.reader.push(chunk);
      } catch {
        this.finish(NATIVE_ERRORS.failed);
        return;
      }
      for (const message of messages) this.events.message(message);
    });
    this.child.stderr?.on("data", (chunk: Buffer) => {
      console.warn(`[extensions] ${host.name}:`, chunk.toString().trimEnd());
    });
    this.child.stdin?.on("error", () => this.finish(NATIVE_ERRORS.failed));
  }

  post(message: unknown): void {
    if (this.closed) return;
    try {
      this.child.stdin?.write(encodeNativeMessage(message));
    } catch {
      this.finish(NATIVE_ERRORS.failed);
    }
  }

  /** The extension closed the port. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin?.end();
    this.child.kill();
  }

  private finish(error: string): void {
    if (this.closed) return;
    this.closed = true;
    this.child.kill();
    this.events.close(error);
  }
}
