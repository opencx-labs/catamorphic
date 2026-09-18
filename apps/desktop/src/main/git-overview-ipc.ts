import { app, ipcMain, type WebContents } from "electron";
import type { GitOverview, GitOverviewSubscription } from "../shared/git.js";
import { GitOverviewMonitor } from "./git-overview-monitor.js";

/** Every renderer owns its leases; closing/reloading it also cancels pending setup. */
export function registerGitOverviewSubscriptions({
  resolve,
}: {
  resolve: (
    input: GitOverviewSubscription,
  ) => Promise<{ root: string; paths?: string[] | "all" }>;
}): void {
  const gitMonitor = new GitOverviewMonitor();
  const gitOwners = new WeakSet<WebContents>();
  const gitConsumers = new Map<
    WebContents,
    Map<string, { stop: () => void }>
  >();
  const clearGitConsumers = (sender: WebContents) => {
    const consumers = gitConsumers.get(sender);
    gitConsumers.delete(sender);
    for (const consumer of consumers?.values() ?? []) consumer.stop();
    consumers?.clear();
  };
  app.once("before-quit", () => {
    for (const sender of gitConsumers.keys()) clearGitConsumers(sender);
    gitMonitor.dispose();
  });
  ipcMain.on("catamorphic:git-overview-unsubscribe", (event, id: string) => {
    const consumers = gitConsumers.get(event.sender);
    consumers?.get(id)?.stop();
    consumers?.delete(id);
  });
  ipcMain.on(
    "catamorphic:git-overview-subscribe",
    (event, id: string, input: GitOverviewSubscription) => {
      const sender = event.sender;
      let consumers = gitConsumers.get(sender);
      if (!consumers) {
        consumers = new Map();
        gitConsumers.set(sender, consumers);
        if (!gitOwners.has(sender)) {
          gitOwners.add(sender);
          sender.once("destroyed", () => clearGitConsumers(sender));
          sender.on(
            "did-start-navigation",
            (_event, _url, inPlace, mainFrame) => {
              if (mainFrame && !inPlace) clearGitConsumers(sender);
            },
          );
        }
      }
      consumers.get(id)?.stop();
      const consumer = { stop: () => {} };
      consumers.set(id, consumer);
      const retained = consumers;
      const publish = (snapshot: GitOverview) => {
        if (!sender.isDestroyed() && retained.get(id) === consumer)
          sender.send("catamorphic:git-overview-snapshot", { id, snapshot });
      };
      void (async () => {
        if (
          input.paths !== undefined &&
          input.paths !== "all" &&
          (!Array.isArray(input.paths) ||
            input.paths.some((value) => typeof value !== "string"))
        )
          throw new Error("Invalid checkout scope");
        const { root, paths } = await resolve(input);
        if (
          retained.get(id) !== consumer ||
          gitConsumers.get(sender) !== retained ||
          sender.isDestroyed()
        )
          return;
        consumer.stop = gitMonitor.subscribe({
          root,
          paths,
          listener: publish,
        });
      })().catch((error: unknown) =>
        publish({
          available: true,
          worktrees: [],
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    },
  );
}
