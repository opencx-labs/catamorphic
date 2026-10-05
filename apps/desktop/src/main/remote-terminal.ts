/*
 * A terminal in a remote chat's workspace (ADR 0208), as one more kind of
 * terminal session beside the local PTYs in terminal.ts: the shell runs in
 * the chat's sandbox on the project's server, and this side follows its
 * output with long-polling reads, batches keystrokes into ordered writes,
 * and sends only the latest size.
 */

/** What a terminal tab's session needs of its process, local or remote. */
export interface TerminalBackend {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: TerminalExit) => void): { dispose(): void };
  /** The foreground program's name, where the backend knows it. */
  readonly process?: string;
}

export interface TerminalExit {
  exitCode: number;
  /**
   * Why the terminal ended other than by its shell exiting; the tab shows
   * it instead of closing.
   */
  message?: string;
}

/** One JSON request to the chat's terminals on the project's server. */
export type RemoteTerminalRequest = (input: {
  method: "GET" | "POST" | "DELETE";
  /** Below `.../agent/sessions/:sessionId/terminals`; `""` for the collection. */
  path: string;
  body?: unknown;
  signal?: AbortSignal;
}) => Promise<{ status: number; body: unknown }>;

/** How long one read waits on the server for output. */
const READ_WAIT_MS = 15_000;
/** Keystrokes typed within this window travel in one write. */
const WRITE_BATCH_MS = 4;
const WRITE_MAX_CHARS = 64 * 1024;
/** A read that keeps failing ends the terminal after this long. */
const RECONNECT_GIVE_UP_MS = 60_000;

export class RemoteTerminalError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RemoteTerminalError";
  }
}

/** The server's own message for a failed request. */
function failure(response: { status: number; body: unknown }): string {
  const body = response.body;
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "string"
  )
    return body.error;
  return `The project's server answered ${response.status}`;
}

/** Open a terminal in the chat's workspace on the project's server. */
export async function openRemoteTerminal(input: {
  request: RemoteTerminalRequest;
  cols: number;
  rows: number;
}): Promise<RemoteTerminal> {
  const response = await input.request({
    method: "POST",
    path: "",
    body: { cols: input.cols, rows: input.rows },
  });
  const body = response.body;
  if (
    response.status !== 201 ||
    typeof body !== "object" ||
    body === null ||
    !("terminalId" in body) ||
    typeof body.terminalId !== "string"
  )
    throw new RemoteTerminalError(response.status, failure(response));
  const pty = "pty" in body && body.pty === true;
  return new RemoteTerminal({
    request: input.request,
    terminalId: body.terminalId,
    pty,
    size: { cols: input.cols, rows: input.rows },
  });
}

export class RemoteTerminal implements TerminalBackend {
  readonly terminalId: string;
  /** The shell has a pseudo-terminal; without one, resizing does nothing. */
  readonly pty: boolean;
  private readonly request: RemoteTerminalRequest;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: TerminalExit) => void>();
  private readonly reading = new AbortController();
  /** Output that arrived before anyone listened. */
  private early: string[] = [];
  private ended: TerminalExit | undefined;
  private pendingInput = "";
  private writeTimer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<void> | undefined;
  private wantedSize: { cols: number; rows: number } | undefined;
  private sentSize: { cols: number; rows: number };
  private resizing: Promise<void> | undefined;

  constructor(input: {
    request: RemoteTerminalRequest;
    terminalId: string;
    pty: boolean;
    size: { cols: number; rows: number };
  }) {
    this.request = input.request;
    this.terminalId = input.terminalId;
    this.pty = input.pty;
    this.sentSize = input.size;
    if (!this.pty)
      this.early.push(
        "\x1b[2mThis workspace has no pseudo-terminal: commands run line by line, and full-screen programs do not work.\x1b[0m\r\n",
      );
    void this.follow();
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.add(listener);
    const early = this.early;
    this.early = [];
    for (const chunk of early) listener(chunk);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: TerminalExit) => void): { dispose(): void } {
    const ended = this.ended;
    if (ended) {
      queueMicrotask(() => listener(ended));
      return { dispose: () => {} };
    }
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  write(data: string): void {
    if (this.ended) return;
    this.pendingInput += data;
    if (this.writeTimer || this.writing) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined;
      this.writing = this.flush().finally(() => {
        this.writing = undefined;
        // Typed while the last write travelled: send it now.
        if (this.pendingInput && !this.ended) this.write("");
      });
    }, WRITE_BATCH_MS);
  }

  resize(cols: number, rows: number): void {
    if (this.ended || !this.pty) return;
    this.wantedSize = { cols, rows };
    this.sendLatestSize();
  }

  private sendLatestSize(): void {
    if (this.resizing || !this.wantedSize || this.ended) return;
    this.resizing = this.sendSize().finally(() => {
      this.resizing = undefined;
      // Resized again while the last size travelled.
      this.sendLatestSize();
    });
  }

  /** Close the remote shell; the tab learns of it at once. */
  kill(): void {
    if (this.ended) return;
    this.finish({ exitCode: 0 });
    void this.request({ method: "DELETE", path: `/${this.terminalId}` }).catch(
      () => {
        // The workspace may already be gone, and its terminals with it.
      },
    );
  }

  private async flush(): Promise<void> {
    while (this.pendingInput && !this.ended) {
      const data = this.pendingInput.slice(0, WRITE_MAX_CHARS);
      this.pendingInput = this.pendingInput.slice(data.length);
      const response = await this.request({
        method: "POST",
        path: `/${this.terminalId}/input`,
        body: { data },
      }).catch((error: unknown) => ({
        status: 0,
        body: {
          error: error instanceof Error ? error.message : String(error),
        },
      }));
      if (response.status === 404) {
        this.finish({ exitCode: 1, message: failure(response) });
        return;
      }
      // A lost keystroke is visible in the terminal; the next one goes on.
    }
  }

  private async sendSize(): Promise<void> {
    while (this.wantedSize && !this.ended) {
      const wanted = this.wantedSize;
      this.wantedSize = undefined;
      if (
        wanted.cols === this.sentSize.cols &&
        wanted.rows === this.sentSize.rows
      )
        continue;
      const response = await this.request({
        method: "POST",
        path: `/${this.terminalId}/resize`,
        body: wanted,
      }).catch(() => ({ status: 0, body: null }));
      if (response.status === 200) this.sentSize = wanted;
    }
  }

  /** Follow the output until the shell ends or the terminal is closed. */
  private async follow(): Promise<void> {
    let cursor = 0;
    let failingSince: number | undefined;
    let backoff = 500;
    while (!this.ended) {
      const response = await this.request({
        method: "GET",
        path: `/${this.terminalId}/output?cursor=${cursor}&waitMs=${READ_WAIT_MS}`,
        signal: this.reading.signal,
      }).catch((error: unknown) => {
        if (this.ended) return undefined;
        return {
          status: 0,
          body: {
            error: error instanceof Error ? error.message : String(error),
          },
        };
      });
      if (!response || this.ended) return;
      if (response.status === 200 && isOutput(response.body)) {
        failingSince = undefined;
        backoff = 500;
        const output = response.body;
        if (output.data) this.emit(output.data);
        cursor = output.nextCursor;
        if (output.exited) {
          this.finish({ exitCode: output.exitCode ?? 0 });
          return;
        }
        continue;
      }
      if (response.status === 404 || response.status === 403) {
        this.finish({ exitCode: 1, message: failure(response) });
        return;
      }
      // The server or the network is away: keep trying for a while.
      failingSince ??= Date.now();
      if (Date.now() - failingSince > RECONNECT_GIVE_UP_MS) {
        this.finish({
          exitCode: 1,
          message: `Lost the connection to the project's server: ${failure(response)}`,
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, backoff));
      backoff = Math.min(backoff * 2, 5_000);
    }
  }

  private emit(data: string): void {
    if (this.dataListeners.size === 0) {
      this.early.push(data);
      return;
    }
    for (const listener of this.dataListeners) listener(data);
  }

  private finish(event: TerminalExit): void {
    if (this.ended) return;
    this.ended = event;
    clearTimeout(this.writeTimer);
    this.writeTimer = undefined;
    this.reading.abort();
    const listeners = [...this.exitListeners];
    this.exitListeners.clear();
    for (const listener of listeners) listener(event);
  }
}

interface Output {
  data: string;
  nextCursor: number;
  exited: boolean;
  exitCode: number | null;
}

function isOutput(body: unknown): body is Output {
  return (
    typeof body === "object" &&
    body !== null &&
    "data" in body &&
    typeof body.data === "string" &&
    "nextCursor" in body &&
    typeof body.nextCursor === "number" &&
    "exited" in body &&
    typeof body.exited === "boolean"
  );
}
