import {
  type AppCollectionItem,
  type AppContentState,
  type AppDisplay,
  createHostCollection,
  reportContentState,
  runCollectionAction,
  subscribeDisplay,
} from "@catamorphic/app";
import {
  CollectionItemView,
  CollectionTree,
  type ItemAction,
  type TreeRenderContext,
  useCollection,
  useCollectionItem,
} from "@catamorphic/app/ui";
import * as React from "react";

type HostCollection = ReturnType<typeof createHostCollection>;
const ROW_HEIGHT = 40;

function ColumnsIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M12 3v18" />
    </svg>
  );
}

function MonitorRow({
  item,
  context,
  selected,
  onInspect,
}: {
  item: AppCollectionItem;
  context: TreeRenderContext;
  selected: boolean;
  onInspect: (id: string) => void;
}) {
  // Only capabilities advertised by this item become host commands.
  // CollectionItemView owns action pending/error feedback and disabled handling.
  const advertised: ItemAction[] = (item.actions ?? []).map((action) => ({
    id: action.id,
    label: action.label,
    disabledReason: action.disabledReason,
    danger: action.id === "archive",
    icon: action.id === "open-side" ? <ColumnsIcon /> : undefined,
    run: () =>
      runCollectionAction({
        source: "subsessions",
        itemId: item.id,
        action: action.id,
      }),
  }));
  const inline = advertised.filter((action) => action.id === "open-side");
  const contextMenu = advertised.filter(
    (action) => action.id === "open-floating" || action.id === "archive",
  );
  const menu = advertised.filter(
    (action) =>
      action.id !== "open-side" &&
      action.id !== "open-floating" &&
      action.id !== "archive",
  );

  return (
    <div style={{ height: ROW_HEIGHT, boxSizing: "border-box" }}>
      <CollectionItemView
        id={item.id}
        label={item.label}
        active={selected}
        expanded={context.expanded}
        onToggle={context.hasChildren ? context.toggle : undefined}
        onOpen={() => onInspect(item.id)}
        actions={inline}
        menu={menu}
        contextMenu={contextMenu}
      />
    </div>
  );
}

function Inspector({
  collection,
  id,
  onClose,
}: {
  collection: HostCollection;
  id: string;
  onClose: () => void;
}) {
  // This subscribes to the selected item, without acquiring a second source lease.
  const item = useCollectionItem({ collection, id });
  return (
    <aside
      aria-label="Session inspector"
      style={{
        borderTop: "1px solid var(--color-border)",
        padding: 8,
        maxHeight: 112,
        overflow: "auto",
        overflowWrap: "anywhere",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <strong>{item?.label ?? "Session unavailable"}</strong>
        <button type="button" onClick={onClose} aria-label="Close inspector">
          ×
        </button>
      </div>
      {item ? (
        <>
          {item.description && (
            <p style={{ margin: "4px 0" }}>{item.description}</p>
          )}
          {!!item.badges?.length && (
            <p style={{ margin: "4px 0" }}>{item.badges.join(" · ")}</p>
          )}
          {item.progress !== undefined && (
            <progress
              aria-label="Session progress"
              max={1}
              value={item.progress}
            />
          )}
          <div style={{ fontSize: 11, opacity: 0.7 }}>ID: {item.id}</div>
        </>
      ) : (
        <p style={{ margin: "4px 0" }}>
          This session is no longer in the current collection.
        </p>
      )}
    </aside>
  );
}

export default function AgentMonitor() {
  // Neither visibility nor current-content updates replace this store.
  const [collection] = React.useState(() =>
    createHostCollection({ source: "subsessions" }),
  );
  const [display, setDisplay] = React.useState<AppDisplay>({
    mode: "compact",
    visible: true,
  });
  // One collection owns both availability and the full tree. Hidden leases
  // refresh only the first page; the visible tree restores loaded depth.
  const { root } = useCollection({
    collection,
    active: !display.visible,
    mode: "preview",
  });
  const [selectedId, setSelectedId] = React.useState<string>();

  React.useEffect(() => subscribeDisplay(setDisplay), []);
  React.useEffect(() => {
    setSelectedId(undefined);
  }, []);

  const contentState: AppContentState =
    root.status === "idle" || root.status === "loading"
      ? "loading"
      : root.status === "error"
        ? "error"
        : root.ids.length === 0
          ? "empty"
          : "ready";

  React.useEffect(() => {
    reportContentState(contentState);
  }, [contentState]);

  return (
    <section
      aria-label="Agent monitor"
      hidden={!display.visible}
      style={{ fontSize: 12, color: "var(--color-fg)" }}
    >
      <header style={{ padding: "6px 8px", fontWeight: 600 }}>
        Agent monitor
      </header>
      {contentState === "empty" && (
        <p role="status" style={{ padding: "0 8px" }}>
          No subsessions in this chat.
        </p>
      )}
      {/* Always mounted to preserve expansion; only a visible tree owns IO. */}
      <CollectionTree
        collection={collection}
        active={display.visible}
        label="Current chat subsessions"
        height={display.mode === "compact" ? 168 : 320}
        rowHeight={ROW_HEIGHT}
        selectedId={selectedId}
        renderItem={(item, context) => (
          <MonitorRow
            item={item}
            context={context}
            selected={item.id === selectedId}
            onInspect={setSelectedId}
          />
        )}
      />
      {selectedId !== undefined ? (
        <Inspector
          collection={collection}
          id={selectedId}
          onClose={() => setSelectedId(undefined)}
        />
      ) : contentState === "ready" ? (
        <p style={{ margin: 0, padding: 8, opacity: 0.7 }}>
          Select a session to inspect it.
        </p>
      ) : null}
    </section>
  );
}
