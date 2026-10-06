import { randomUUID } from "node:crypto";
import type { DB } from "@catamorphic/db";
import { shellQuote } from "@catamorphic/git";
import { getTracer, withSpan } from "@catamorphic/otel";
import type { Kysely } from "kysely";
import type { Identity } from "../identity.js";
import type { AgentSessionsService } from "./agent-sessions-service.js";
import {
  PREVIEW_ANSWER_MARKER,
  PREVIEW_FETCH_SCRIPT,
  PREVIEW_FETCH_SCRIPT_NAME,
  PREVIEW_RESPONSE_MAX_BYTES,
} from "./session-preview-script.js";
import { sessionDirectoryFromProject } from "./session-terminal-scripts.js";
import {
  markWorkspaceUsed,
  type SessionWorkspaceHandle,
} from "./session-workspace.js";

const tracer = getTracer("@catamorphic/core");

/** Most request body bytes a preview carries into the sandbox. */
export const PREVIEW_REQUEST_MAX_BYTES = 16 * 1024 * 1024;

/**
 * A request description up to this size rides inside the command that
 * runs it; a larger one is uploaded first. One shell argument is capped
 * at 128 KiB on Linux.
 */
const INLINE_REQUEST_BYTES = 64 * 1024;

/**
 * Request headers that never reach the sandbox: the caller's own
 * credentials (for this server, or a desktop's own API), and how the
 * request reached it.
 */
const WITHHELD_REQUEST_HEADERS = [
  "authorization",
  "x-catamorphic-runner",
  "x-work-desktop-token",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
];

/** An HTTP request a person sends to a port in a chat's workspace. */
export interface PreviewRequest {
  identity: Identity;
  projectId: string;
  sessionId: string;
  port: number;
  method: string;
  /** Path and query below the port, starting with `/`. */
  path: string;
  /** Header pairs as received; hop-by-hop ones and `host` are dropped. */
  headers: ReadonlyArray<readonly [string, string]>;
  body?: Uint8Array;
}

/** What the server in the workspace answered. */
export interface PreviewResponse {
  status: number;
  /** Header pairs, repeated names (`set-cookie`) kept apart. */
  headers: Array<[string, string]>;
  body: Uint8Array;
}

export type SessionPreviewErrorReason =
  /** Nothing listens on the port. */
  | "unreachable"
  | "too_large"
  /** The sandbox has neither Bun nor Node. */
  | "no_runtime"
  | "invalid"
  | "failed";

export class SessionPreviewError extends Error {
  constructor(
    readonly reason: SessionPreviewErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "SessionPreviewError";
  }
}

/**
 * Previews of servers running in a chat's workspace (ADR 0209): each HTTP
 * request is made inside the sandbox by its own runtime, so it works on
 * every backend and behind restricted egress. Access is as for terminals:
 * the chat's owner, or anyone with `sessions:write` for a project chat. A
 * preview never starts a workspace: nothing would listen in a new one.
 */
export class SessionPreviewsService {
  constructor(
    private readonly deps: {
      db: Kysely<DB>;
      sessions: Pick<AgentSessionsService, "personWorkspace">;
    },
  ) {}

  async request(input: PreviewRequest): Promise<PreviewResponse> {
    return withSpan(
      {
        tracer,
        name: "session.preview.request",
        attributes: {
          "catamorphic.project.id": input.projectId,
          "catamorphic.session.id": input.sessionId,
          "catamorphic.preview.port": input.port,
          "http.request.method": input.method,
        },
      },
      async (span) => {
        if (
          !Number.isInteger(input.port) ||
          input.port < 1 ||
          input.port > 65535
        )
          throw new SessionPreviewError(
            "invalid",
            "A preview port is a number from 1 to 65535.",
          );
        if (!input.path.startsWith("/") || /[\r\n]/.test(input.path))
          throw new SessionPreviewError("invalid", "Invalid preview path.");
        if (!/^[A-Z]+$/.test(input.method))
          throw new SessionPreviewError("invalid", "Invalid request method.");
        if ((input.body?.byteLength ?? 0) > PREVIEW_REQUEST_MAX_BYTES)
          throw new SessionPreviewError(
            "too_large",
            "A preview request body is at most 16 MiB.",
          );
        const workspace = await this.deps.sessions.personWorkspace({
          identity: input.identity,
          projectId: input.projectId,
          sessionId: input.sessionId,
          start: false,
        });
        // Someone looking at a preview keeps the workspace it runs in.
        await markWorkspaceUsed({
          db: this.deps.db,
          sessionId: input.sessionId,
        });
        const answer = await this.fetchInSandbox({ workspace, input });
        span.setAttribute("http.response.status_code", answer.status);
        return answer;
      },
    );
  }

  private async fetchInSandbox(args: {
    workspace: SessionWorkspaceHandle;
    input: PreviewRequest;
  }): Promise<PreviewResponse> {
    const { workspace, input } = args;
    const sessionFromProject = sessionDirectoryFromProject(workspace);
    const id = randomUUID();
    const description = JSON.stringify({
      port: input.port,
      method: input.method,
      path: input.path,
      headers: input.headers.filter(
        ([name]) => !WITHHELD_REQUEST_HEADERS.includes(name.toLowerCase()),
      ),
      ...(input.body && input.body.byteLength > 0
        ? { bodyBase64: Buffer.from(input.body).toString("base64") }
        : {}),
      responseFile: `${sessionFromProject}/preview/responses/${id}.b64`,
    });
    const inline = Buffer.byteLength(description) <= INLINE_REQUEST_BYTES;
    if (!inline)
      await workspace.provider.uploadFiles(
        workspace.sandboxId,
        { [`preview/requests/${id}.json`]: description },
        workspace.sessionDirectory,
      );
    const result = await workspace.provider.executeCommand(
      workspace.sandboxId,
      previewCommand({
        sessionFromProject,
        id,
        ...(inline ? { description } : {}),
      }),
      { cwd: workspace.projectDirectory, timeout: 120 },
    );
    const answer = parseAnswer(result.result);
    if ("error" in answer)
      throw new SessionPreviewError(
        answer.error,
        answer.error === "unreachable"
          ? `Nothing in this chat's workspace answers on port ${input.port}.`
          : answer.error === "too_large"
            ? "The preview's response is larger than 16 MiB."
            : answer.error === "no_runtime"
              ? "This chat's workspace has neither Bun nor Node to make preview requests with."
              : `The preview request failed: ${answer.message}`,
      );
    const body = answer.bodyFile
      ? Buffer.from(
          await workspace.provider.downloadFile(
            workspace.sandboxId,
            `${workspace.sessionDirectory}/preview/responses/${id}.b64`,
          ),
          "base64",
        )
      : Buffer.from(answer.bodyBase64 ?? "", "base64");
    if (body.byteLength > PREVIEW_RESPONSE_MAX_BYTES)
      throw new SessionPreviewError(
        "too_large",
        "The preview's response is larger than 16 MiB.",
      );
    return {
      status: answer.status,
      headers: answer.headers,
      body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
    };
  }
}

/**
 * Runs one preview request from the project folder: installs the script
 * once per sandbox (written aside, then moved, so a request running at
 * the same moment never reads half of it), writes the request when it
 * rides along, and runs the script with Bun or else Node. Proxy variables
 * are cleared: the request goes to the sandbox's own loopback.
 */
export function previewCommand(input: {
  sessionFromProject: string;
  id: string;
  description?: string;
}): string {
  const preview = `${input.sessionFromProject}/preview`;
  return [
    `p=${shellQuote(preview)}`,
    'mkdir -p "$p/requests" "$p/responses" || exit 1',
    `f="$p/${PREVIEW_FETCH_SCRIPT_NAME}"`,
    'if [ ! -f "$f" ]; then',
    `  cat > "$f.$$" <<'WORK_PREVIEW_SCRIPT'`,
    PREVIEW_FETCH_SCRIPT.trimEnd(),
    "WORK_PREVIEW_SCRIPT",
    '  mv -f "$f.$$" "$f"',
    "fi",
    `r="$p/requests/${input.id}.json"`,
    ...(input.description === undefined
      ? []
      : [
          `cat > "$r" <<'WORK_PREVIEW_REQUEST'`,
          input.description,
          "WORK_PREVIEW_REQUEST",
        ]),
    "unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy NODE_USE_ENV_PROXY",
    'if command -v bun >/dev/null 2>&1; then exec bun "$f" "$r"; fi',
    'if command -v node >/dev/null 2>&1; then exec node "$f" "$r"; fi',
    'rm -f "$r"',
    `echo '${PREVIEW_ANSWER_MARKER}{"error":"no_runtime"}'`,
  ].join("\n");
}

type PreviewAnswer =
  | {
      status: number;
      headers: Array<[string, string]>;
      bodyBase64?: string;
      bodyFile?: boolean;
    }
  | { error: SessionPreviewErrorReason; message: string };

/** The script's one answer line, wherever in the output it landed. */
function parseAnswer(output: string): PreviewAnswer {
  const line = output
    .split("\n")
    .filter((text) => text.startsWith(PREVIEW_ANSWER_MARKER))
    .at(-1);
  const parsed: unknown = line
    ? safeJson(line.slice(PREVIEW_ANSWER_MARKER.length))
    : undefined;
  if (typeof parsed !== "object" || parsed === null)
    return {
      error: "failed",
      message: output.trim().slice(-500) || "no answer",
    };
  if ("error" in parsed && typeof parsed.error === "string") {
    const reason = parsed.error;
    return {
      error:
        reason === "unreachable" ||
        reason === "too_large" ||
        reason === "no_runtime"
          ? reason
          : "failed",
      message:
        "message" in parsed && typeof parsed.message === "string"
          ? parsed.message
          : reason,
    };
  }
  const status =
    "status" in parsed && typeof parsed.status === "number"
      ? parsed.status
      : 502;
  const headers =
    "headers" in parsed && Array.isArray(parsed.headers)
      ? parsed.headers.flatMap(
          (pair: unknown): Array<[string, string]> =>
            Array.isArray(pair) &&
            typeof pair[0] === "string" &&
            typeof pair[1] === "string"
              ? [[pair[0], pair[1]]]
              : [],
        )
      : [];
  return {
    status,
    headers,
    ...("bodyBase64" in parsed && typeof parsed.bodyBase64 === "string"
      ? { bodyBase64: parsed.bodyBase64 }
      : {}),
    ...("bodyFile" in parsed && parsed.bodyFile === true
      ? { bodyFile: true }
      : {}),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
