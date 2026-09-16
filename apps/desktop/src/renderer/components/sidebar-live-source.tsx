import { createCollection } from "@catamorphic/app";
import { CollectionTree, useCollection } from "@catamorphic/app/ui";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { SidebarSourceItem } from "../../shared/sidebar-source.js";
import { desktopApi } from "../lib/desktop-api.js";
import {
  projectSidebarItems,
  sidebarItemPresentation,
  useSidebarContent,
  useSidebarContribution,
  useSidebarItemCount,
  useSidebarRefresh,
} from "./sidebar-contribution.js";
import { SidebarItemRow } from "./sidebar-item-row.js";

function sourceError(cause: unknown): Error {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""),
  );
}

/** One collection owns cache, cancellation, subscriptions and paged branches. */
export function SidebarLiveSource({ projectId }: { projectId: string }) {
  const contribution = useSidebarContribution();
  const section = contribution?.section;
  const sectionId = section?.id ?? "";
  const api = desktopApi;
  const [subscriptionError, setSubscriptionError] = useState<string>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: switching the configured module must replace its cache and release old leases.
  const collection = useMemo(
    () =>
      createCollection<SidebarSourceItem>({
        source: {
          load: async ({ parentId, cursor, signal }) => {
            if (!api) throw new Error("Desktop connection unavailable.");
            const requestId = crypto.randomUUID();
            const cancel = () => {
              void api.sidebarSourceCancel(requestId);
            };
            signal.addEventListener("abort", cancel, { once: true });
            try {
              signal.throwIfAborted();
              const page = await api.sidebarSourceRequest({
                projectId,
                sectionId,
                requestId,
                method: "load",
                parentId,
                cursor,
              });
              signal.throwIfAborted();
              if (!page) throw new Error("Source returned no collection page.");
              return page;
            } catch (cause) {
              throw sourceError(cause);
            } finally {
              signal.removeEventListener("abort", cancel);
            }
          },
          subscribe: (publish) => {
            if (!api) return () => {};
            let released = false;
            const leaseId = crypto.randomUUID();
            const unsubscribe = api.onSidebarSourceChanged((event) => {
              if (event.leaseId !== leaseId) return;
              setSubscriptionError(event.error);
              if (!event.error) publish({ type: "invalidate" });
            });
            setSubscriptionError(undefined);
            void api
              .sidebarSourceSubscribe({ projectId, sectionId, leaseId })
              .catch((cause) => {
                if (!released) setSubscriptionError(sourceError(cause).message);
              });
            return () => {
              released = true;
              unsubscribe();
              void api.sidebarSourceUnsubscribe(leaseId);
            };
          },
        },
      }),
    [api, projectId, sectionId, section?.source?.module],
  );
  // A relevant hidden section keeps only a root availability lease. The native
  // tree owns expanded branch leases while visible, matching built-in sources.
  const { root } = useCollection({
    collection,
    active:
      (contribution?.relevant ?? true) &&
      ((contribution?.visible ?? true) || section?.hideEmpty === true),
    mode: "preview",
    projected: true,
  });
  const project = useCallback(
    (items: readonly SidebarSourceItem[]) =>
      projectSidebarItems(items, section).filter(
        (item) =>
          !sidebarItemPresentation({ section, id: item.id }).hide && !item.hide,
      ),
    [section],
  );
  const count = project(
    root.ids.flatMap((id) => {
      const item = collection.getItem(id);
      return item ? [item] : [];
    }),
  ).length;
  useSidebarItemCount(count);
  useSidebarContent(
    root.status === "error" || subscriptionError
      ? "error"
      : root.status === "idle" || root.status === "loading"
        ? "loading"
        : count
          ? "ready"
          : "empty",
  );
  const refresh = useCallback(() => {
    setSubscriptionError(undefined);
    return collection.load();
  }, [collection]);
  useSidebarRefresh(refresh);
  const title = section?.title ?? "Items";
  return (
    <div
      className="sidebar-live-source"
      data-sidebar-source={sectionId}
      aria-busy={Boolean(root.fetching)}
    >
      {subscriptionError && (
        <p role="alert" className="sidebar-empty-state">
          {subscriptionError}
        </p>
      )}
      <CollectionTree
        collection={collection}
        active={contribution?.visible ?? true}
        label={title}
        height={section?.height}
        rowHeight={section?.rowHeight}
        project={project}
        motionClasses={{
          enter: "animate-session-row-in",
          exit: "animate-session-row-out",
        }}
        renderStatus={(branch) => (
          <>
            <div className="flex min-h-7 items-center gap-2 px-2 text-xs text-fg-muted">
              {branch.fetching ? (
                <>
                  <LoaderCircle
                    aria-hidden="true"
                    className="size-3 animate-spin motion-reduce:animate-none"
                  />
                  <span role="status">
                    {branch.ids.length ? "Refreshing…" : "Loading…"}
                  </span>
                </>
              ) : (
                <span role="status" className="flex-1">
                  {branch.status === "ready"
                    ? count
                      ? `${count} ${count === 1 ? "item" : "items"}`
                      : "No items yet"
                    : "Could not load items"}
                </span>
              )}
              <button
                type="button"
                aria-label={`Refresh ${title}`}
                disabled={branch.fetching}
                data-disabled-reason={
                  branch.fetching ? "Loading items" : undefined
                }
                className="ml-auto grid size-6 place-items-center rounded hover:bg-bg-overlay disabled:opacity-40"
                onClick={() => void refresh()}
              >
                <RefreshCw className="size-3" />
              </button>
            </div>
            {branch.fetching && !branch.ids.length && (
              <div aria-hidden="true" className="sidebar-source-skeleton">
                {[62, 84, 48].map((width) => (
                  <div key={width} className="flex h-7 items-center gap-2 px-2">
                    <span className="size-3 rounded bg-bg-overlay" />
                    <span
                      className="h-2 rounded bg-bg-overlay"
                      style={{ width: `${width}%` }}
                    />
                  </div>
                ))}
              </div>
            )}
            {branch.status === "error" && (
              <div role="alert" className="sidebar-empty-state">
                <p>{branch.error}</p>
                <button
                  type="button"
                  className="mt-1 text-accent"
                  onClick={() => void refresh()}
                >
                  Retry
                </button>
              </div>
            )}
          </>
        )}
        renderItem={(item, tree) => (
          <SidebarItemRow
            itemId={item.id}
            label={item.label}
            description={item.description}
            icon={item.icon ?? "Circle"}
            badges={item.badges}
            progress={item.progress}
            menu={item.menu}
            contextMenu={item.contextMenu}
            actions={item.actions}
            preview={item.preview}
            style={{ marginLeft: tree.depth * 14 }}
            resource={Boolean(item.url)}
            disclosure={
              tree.hasChildren
                ? { open: tree.expanded, onToggle: tree.toggle }
                : undefined
            }
            supportedActions={[
              ...(item.actions ?? []),
              ...(item.menu ?? []),
              ...(item.contextMenu ?? []),
            ].map((entry) => entry.action)}
            onOpen={(mode) => {
              if (item.url) contribution?.open(item.url, mode);
              else if (tree.hasChildren) tree.toggle();
            }}
            onAction={async (entry) => {
              if (!api) throw new Error("Desktop connection unavailable.");
              if (entry.url) {
                contribution?.open(entry.url, "replace");
                return;
              }
              if (entry.action === "copy-url" && item.url) {
                await navigator.clipboard.writeText(item.url);
                return;
              }
              if (!entry.action.startsWith("run:"))
                throw new Error("This source action needs a run: name.");
              await api
                .sidebarSourceRequest({
                  projectId,
                  sectionId,
                  requestId: crypto.randomUUID(),
                  method: "action",
                  itemId: item.id,
                  action: entry.action.slice(4),
                })
                .catch((cause: unknown) => {
                  throw sourceError(cause);
                });
              // The worker publishes invalidation after a successful action.
            }}
          />
        )}
      />
    </div>
  );
}
