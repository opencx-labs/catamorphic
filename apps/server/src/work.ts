#!/usr/bin/env bun
/**
 * `work`, the image's machine-local command (ADRs 0164, 0197):
 *
 *   work worker              run this machine as an enrolled worker
 *   work worker sign-in ...  members' own sign-ins on this machine
 *   work worker help         everything `work worker` does
 */
const [area, ...rest] = process.argv.slice(2);
if (area !== "worker") {
  console.error("Usage: work worker [sign-in | sign-out | sign-ins | help]");
  process.exit(2);
}
process.argv = [process.argv[0] ?? "bun", "worker.ts", ...rest];
await import("./worker.js");

export {};
