#!/usr/bin/env bun
/**
 * A stand-in for the Codex CLI on a member's own ChatGPT sign-in (ADRs
 * 0199, 0213). Tests put it on a machine's PATH as `codex`.
 *
 * - `codex login --device-auth` prints a link and a one-time code as
 *   Codex 0.160.0 does, then waits in the machine's sign-in root (the
 *   parent of its staged home's directory): a file named `approve` there
 *   completes the login with the access token it holds, one named `deny`
 *   fails it.
 * - `codex app-server ...` speaks enough of the app-server protocol for
 *   real turns. It calls no model: it runs the command of a `run: <command>`
 *   line itself, and otherwise answers with a report of the sign-in it was
 *   given, so tests see what reached the CLI.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

type Json = Record<string, unknown>;

function record(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

const [command, ...rest] = process.argv.slice(2);
const home = process.env.CODEX_HOME ?? "";

if (command === "login") {
  if (rest[0] !== "--device-auth") {
    console.error("This stand-in signs in with --device-auth only");
    process.exit(2);
  }
  process.stdout.write(
    "\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n" +
      "1. Open this link in your browser and sign in to your account\n" +
      "   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n\n" +
      "2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m\n" +
      "   \u001b[94mTEST-12345\u001b[0m\n\n",
  );
  const outcome = path.dirname(path.dirname(home));
  for (;;) {
    const approve = path.join(outcome, "approve");
    if (fs.existsSync(approve)) {
      fs.writeFileSync(
        path.join(home, "auth.json"),
        JSON.stringify({
          tokens: { access_token: fs.readFileSync(approve, "utf8").trim() },
        }),
        { mode: 0o600 },
      );
      console.log("Successfully logged in");
      process.exit(0);
    }
    if (fs.existsSync(path.join(outcome, "deny"))) {
      console.error("Error: the request was denied");
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

if (command !== "app-server") {
  console.error(`This stand-in does not do ${command ?? "that"}`);
  process.exit(2);
}

function emit(message: Json): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** What reached this CLI of the member's sign-in: facts, never the value. */
function report(): string {
  const auth = path.join(home, "auth.json");
  const token = fs.existsSync(auth)
    ? String(
        record(record(JSON.parse(fs.readFileSync(auth, "utf8"))).tokens)
          .access_token ?? "",
      )
    : "";
  return JSON.stringify({
    codexHome: Boolean(home),
    signedIn: Boolean(token),
    accessTokenSha256: token
      ? createHash("sha256").update(token).digest("hex")
      : null,
    apiKey: process.env.OPENAI_API_KEY ?? null,
  });
}

function answer(prompt: string): string {
  const line = prompt
    .split("\n")
    .map((entry) => entry.trim())
    .reverse()
    .find((entry) => entry.startsWith("run:"));
  if (!line) return report();
  const run = spawnSync("bash", ["-c", line.slice("run:".length).trim()], {
    encoding: "utf8",
  });
  return `Done: ${run.stdout}${run.stderr}`;
}

const threadId = randomUUID();

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const message = record(JSON.parse(line));
  const id = message.id;
  const method = String(message.method ?? "");
  if (id === undefined) continue;
  const params = record(message.params);
  switch (method) {
    case "initialize":
      emit({
        id,
        result: { userAgent: "fake-codex/0.160.0", codexHome: home },
      });
      break;
    case "thread/start":
    case "thread/resume":
    case "thread/fork":
      emit({ id, result: { thread: { id: threadId }, model: "gpt-test" } });
      break;
    case "turn/start": {
      const turnId = randomUUID();
      const prompt = (Array.isArray(params.input) ? params.input : [])
        .map((part) => String(record(part).text ?? ""))
        .join("\n");
      emit({ id, result: { turn: { id: turnId, status: "inProgress" } } });
      const text = answer(prompt);
      const itemId = `msg_${randomUUID()}`;
      emit({
        method: "item/started",
        params: {
          threadId,
          turnId,
          item: { type: "agentMessage", id: itemId, text: "" },
        },
      });
      emit({
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: { type: "agentMessage", id: itemId, text },
        },
      });
      emit({
        method: "turn/completed",
        params: { threadId, turn: { id: turnId, status: "completed" } },
      });
      break;
    }
    default:
      emit({ id, result: {} });
  }
}
