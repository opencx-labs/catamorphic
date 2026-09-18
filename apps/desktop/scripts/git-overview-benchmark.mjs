// Bun-only, opt-in synthetic-repository measurement. Never point at user work.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { GitOverviewMonitor } from "../src/main/git-overview-monitor.ts";
import { gitOverview } from "../src/main/git-view.ts";

const [folder, mode, idle = "60", phase = "0"] = process.argv.slice(2);
if (!folder || !["poll", "watch"].includes(mode))
  throw new Error(
    "Usage: <disposable-git-fixture> <poll|watch> [idle-seconds] [edit-delay-ms]",
  );
const idleMs = Number(idle) * 1000;
const delayMs = Number(phase);
if (![idleMs, delayMs].every((value) => Number.isFinite(value) && value >= 0))
  throw new Error("Timings must be nonnegative numbers");
const root = await fs.realpath(folder);
const filename = "catamorphic-monitor-benchmark-probe.txt";
const target = path.join(root, filename);
const probe = await fs.open(target, "wx");
await probe.close();
await fs.rm(target);
const baseline = process.env.GIT_OVERVIEW_BASELINE;
const reader = baseline
  ? (await import(pathToFileURL(path.resolve(baseline)).href)).gitOverview
  : gitOverview;
let scans = 0;
let publications = 0;
let edited = 0;
let latency;
let timer;
let live = true;
let stop = () => {};
let ready;
let detected;
const initial = new Promise((resolve) => {
  ready = resolve;
});
const done = new Promise((resolve) => {
  detected = resolve;
});
const publish = (snapshot) => {
  if (snapshot.error) throw new Error(snapshot.error);
  if (!snapshot.available) throw new Error("Fixture must be a Git repository");
  publications++;
  ready();
  if (
    edited &&
    snapshot.worktrees.some((tree) =>
      tree.changes.some((file) => file.path === filename),
    )
  ) {
    latency = performance.now() - edited;
    detected();
  }
};
const read = async (...args) => {
  if (args[1]?.length !== 0) scans++;
  return (mode === "poll" ? reader : gitOverview)(...args);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let deadline;
try {
  if (mode === "poll") {
    const run = async () => {
      publish(await read(root));
      if (live) timer = setTimeout(run, 15_000);
    };
    await run();
    stop = () => {
      live = false;
      clearTimeout(timer);
    };
  } else {
    const monitor = new GitOverviewMonitor({ read });
    stop = () => monitor.dispose();
    monitor.subscribe({ root, listener: publish });
  }
  await initial;
  const initialScans = scans;
  await sleep(idleMs);
  const idleScans = scans - initialScans;
  await sleep(delayMs);
  edited = performance.now();
  await fs.writeFile(target, "Synthetic external edit\n", { flag: "wx" });
  await Promise.race([
    done,
    new Promise((_, reject) => {
      deadline = setTimeout(
        () => reject(new Error("No update within 30 seconds")),
        30_000,
      );
    }),
  ]);
  console.log(
    JSON.stringify({
      mode,
      idleMs,
      delayMs,
      idleScans,
      totalScans: scans,
      publications,
      latencyMs: latency,
    }),
  );
} finally {
  clearTimeout(deadline);
  stop();
  await fs.rm(target, { force: true });
}
