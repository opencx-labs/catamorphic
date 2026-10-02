export { EchoAdapter } from "./echo-adapter.js";
export { InProcessRunner } from "./in-process.js";
export { AttemptRunner, type AttemptRunnerOptions } from "./runner.js";
export { runStdioRunner } from "./stdio.js";

/** Reported in `hello` frames; bumped with releases. */
export const AGENT_RUNNER_VERSION = "0.0.1";
