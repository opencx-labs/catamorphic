import { createCollection } from "@catamorphic/app";
import { CollectionTree, useCollection } from "@catamorphic/app/ui";
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
  const refresh = useCallback(() => {
    setSubscriptionError(undefined);
    return collection.load();
  }, [collection]);
  useSidebarRefresh(refresh);
  useSidebarContent({
    state:
      root.status === "error" || subscriptionError
        ? "error"
        : root.status === "idle" || root.status === "loading"
          ? "loading"
          : count
            ? "ready"
            : "empty",
    refreshing: root.fetching && root.ids.length > 0,
    error: subscriptionError ?? root.error,
    retry: refresh,
    empty: "No items yet.",
  });
  const title = section?.title ?? "Items";
  return (
    <div
      className="sidebar-live-source"
      data-sidebar-source={sectionId}
      aria-busy={Boolean(root.fetching)}
    >
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
        renderStatus={() => null}
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
