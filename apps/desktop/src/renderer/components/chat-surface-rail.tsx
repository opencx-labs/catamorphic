import {
  AppWindow,
  Bot,
  ChevronUp,
  Columns2,
  FileCode,
  GitBranch,
  GitFork,
  Globe,
  LayoutGrid,
  LoaderCircle,
  Radio,
  SquareTerminal,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ChatSurface, McpAppRef } from "../../shared/chat.js";
import type { OpenMode } from "../../shared/open-mode.js";
import { appGlyph } from "./app-icon.js";
import { OpenResourceButton } from "./open-resource-button.js";
import { PopPanel } from "./pop-panel";
import { ResourceInspector } from "./resource-inspector";
import { ShortcutHint } from "./shortcut-hint";
import { SurfacePreview } from "./surface-preview";

/** Chips group per kind once a chat collects this many surfaces. */
const SURFACE_GROUP_THRESHOLD = 3;

const SURFACE_GROUP_LABELS = {
  browser: "Pages",
  terminal: "Terminals",
  editor: "Files",
  chat: "Chats",
  subagent: "Subagents",
  watcher: "Watchers",
  app: "Apps",
  workflow: "Workflows",
  mcpapp: "App views",
} as const;

const SURFACE_ICONS = {
  browser: Globe,
  terminal: SquareTerminal,
  editor: FileCode,
  chat: GitFork,
  subagent: Bot,
  watcher: Radio,
  app: LayoutGrid,
  workflow: GitBranch,
  mcpapp: AppWindow,
} as const;

/** Stable, complementary empty-state and composer copy for each chat. */
/**
 * One surface chip: open on click, tile right on ⌘-click or the button.
 * Chips carrying `info` (subagents, watchers) open their detail popover
 * instead — they have no workspace tab behind them.
 */
function SurfaceChip({
  surface,
  onOpenSurface,
  onRemoveSurface,
  onOpenMcpApp,
  onToggleInfo,
}: {
  surface: ChatSurface;
  onOpenSurface: (key: string, mode: OpenMode | "split") => void;
  onRemoveSurface?: (key: string) => void;
  onOpenMcpApp?: (view: McpAppRef, mode: OpenMode | "split") => void;
  onToggleInfo: (key: string) => void;
}) {
  const Icon =
    surface.kind === "app"
      ? appGlyph(surface.appIcon)
      : SURFACE_ICONS[surface.kind];
  return (
    <span
      className="group/chip relative flex shrink-0 items-center overflow-hidden rounded-md border border-border bg-bg-inset text-[11px] text-fg-muted"
      data-testid="surface-chip"
      data-kind={surface.kind}
      data-active={surface.active || undefined}
      data-attention={surface.attention || undefined}
      // Chips are point_at-addressable ("chip:<surface key>") — the
      // agent can glow one on its own chat.
      data-point-key={`chip:${surface.key}`}
    >
      <ResourceInspector
        label={`Preview ${surface.label}`}
        content={<SurfacePreview surface={surface} />}
      >
        {({ onClick: dismissPreview, ...previewProps }) => (
          <OpenResourceButton
            {...previewProps}
            isResource={!surface.info}
            type="button"
            onOpen={(mode) => {
              dismissPreview();
              return surface.mcpApp
                ? onOpenMcpApp?.(surface.mcpApp, mode)
                : surface.info
                  ? onToggleInfo(surface.key)
                  : onOpenSurface(surface.key, mode);
            }}
            className="flex min-w-0 cursor-pointer items-center gap-1.5 py-1 pl-2 pr-2 transition-colors duration-100 hover:text-fg"
          >
            <span className="relative grid size-3 shrink-0 place-items-center">
              {surface.kind === "browser" && surface.faviconUrl ? (
                <img
                  src={surface.faviconUrl}
                  alt=""
                  className={`col-start-1 row-start-1 size-3 rounded-[2px] transition-opacity duration-200 ${
                    surface.active ? "opacity-0" : "opacity-100"
                  }`}
                />
              ) : (
                <Icon
                  className={`col-start-1 row-start-1 size-3 transition-opacity duration-200 ${
                    surface.active ? "opacity-0" : "opacity-100"
                  }`}
                />
              )}
              <LoaderCircle
                className={`col-start-1 row-start-1 size-3 text-accent transition-opacity duration-200 ${
                  surface.active ? "animate-spin opacity-100" : "opacity-0"
                }`}
              />
              {/* Background-opened surface waiting for the user: the unread
              dot (accent fill) with the waiting-state pulse, cleared by
              opening the chip. */}
              {surface.attention && (
                <span className="absolute -right-0.5 -top-0.5 size-1.5 animate-pulse rounded-full bg-accent" />
              )}
            </span>
            <span className="max-w-36 truncate">{surface.label}</span>
          </OpenResourceButton>
        )}
      </ResourceInspector>
      {/* The split affordance only exists under the pointer: an overlay
          on the chip's right end that fades over the label's tail (its
          left edge is a gradient into the chip background) instead of
          permanently reserving width on every chip. */}
      {!surface.info && (
        <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center bg-gradient-to-l from-bg-inset from-70% to-transparent pl-3 pr-0.5 opacity-0 transition-opacity duration-100 group-hover/chip:pointer-events-auto group-hover/chip:opacity-100">
          <ShortcutHint label="Open to the right" shortcut="⌘⇧-click">
            <button
              type="button"
              onClick={() => onOpenSurface(surface.key, "split")}
              className="grid size-6 cursor-pointer place-items-center rounded text-fg-faint transition-colors duration-100 hover:text-fg"
              aria-label={`Open ${surface.label} to the right`}
            >
              <Columns2 className="size-3" />
            </button>
          </ShortcutHint>
          {surface.removable && onRemoveSurface && (
            <ShortcutHint label="Remove from this chat">
              <button
                type="button"
                onClick={() => onRemoveSurface(surface.key)}
                className="grid size-6 cursor-pointer place-items-center rounded text-fg-faint transition-colors duration-100 hover:text-fg"
                aria-label={`Remove ${surface.label}`}
              >
                <X className="size-3" />
              </button>
            </ShortcutHint>
          )}
        </span>
      )}
    </span>
  );
}

/** The collapsed "4 terminals" chip a crowded kind folds into. */
function GroupChip({
  kind,
  group,
  open,
  onToggle,
}: {
  kind: ChatSurface["kind"];
  group: ChatSurface[];
  open: boolean;
  onToggle: () => void;
}) {
  const Icon = SURFACE_ICONS[kind];
  const anyActive = group.some((surface) => surface.active);
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border py-1 pl-2 pr-1.5 text-[11px] transition-colors duration-100 ${
        open
          ? "border-border-strong bg-bg-overlay text-fg"
          : "border-border bg-bg-inset text-fg-muted hover:text-fg"
      }`}
      aria-expanded={open}
      aria-label={`${group.length} ${SURFACE_GROUP_LABELS[kind].toLowerCase()}`}
      data-testid="surface-group"
      data-kind={kind}
      data-attention={group.some((surface) => surface.attention) || undefined}
    >
      <span className="relative grid size-3 shrink-0 place-items-center">
        <Icon
          className={`col-start-1 row-start-1 size-3 transition-opacity duration-200 ${anyActive ? "opacity-0" : "opacity-100"}`}
        />
        <LoaderCircle
          className={`col-start-1 row-start-1 size-3 text-accent transition-opacity duration-200 ${anyActive ? "animate-spin opacity-100" : "opacity-0"}`}
        />
        {/* Attention aggregates onto the group chip, like the spinner. */}
        {group.some((surface) => surface.attention) && (
          <span className="absolute -right-0.5 -top-0.5 size-1.5 animate-pulse rounded-full bg-accent" />
        )}
      </span>
      {SURFACE_GROUP_LABELS[kind]}
      <span className="text-fg-faint">{group.length}</span>
      <ChevronUp
        className={`size-3 text-fg-faint transition-transform duration-150 ${
          open ? "rotate-180" : ""
        }`}
      />
    </button>
  );
}

/** What one kind renders on the rail: chips, or the collapsed group. */
type RailItem =
  | { id: string; type: "chip"; surface: ChatSurface }
  | { id: string; type: "group"; group: ChatSurface[] };

/**
 * One kind's strip on the rail, with motion: chips (or the group chip
 * they fold into past the threshold) enter with pill-in and leave with
 * pill-out — the collapse reads as chips folding into the group, not a
 * teleport. Removed items linger until their exit animation lands.
 */
function KindStrip({
  kind,
  group,
  animateEnter,
  openGroup,
  onToggleGroup,
  onOpenSurface,
  onRemoveSurface,
  onOpenMcpApp,
  onToggleInfo,
}: {
  kind: ChatSurface["kind"];
  group: ChatSurface[];
  /** False on the rail's first paint — pre-existing chips don't animate. */
  animateEnter: boolean;
  openGroup: ChatSurface["kind"] | null;
  onToggleGroup: (kind: ChatSurface["kind"]) => void;
  onOpenSurface: (key: string, mode: OpenMode | "split") => void;
  onRemoveSurface?: (key: string) => void;
  onOpenMcpApp?: (view: McpAppRef, mode: OpenMode | "split") => void;
  onToggleInfo: (key: string) => void;
}) {
  const collapsed = group.length > SURFACE_GROUP_THRESHOLD;
  const live: RailItem[] = collapsed
    ? [{ id: `group:${kind}`, type: "group", group }]
    : group.map((surface) => ({
        id: `chip:${surface.key}`,
        type: "chip",
        surface,
      }));
  const liveIdsKey = live.map((item) => item.id).join("\u0000");
  const [exiting, setExiting] = useState<RailItem[]>([]);
  const prevIdsRef = useRef<Set<string> | null>(null);
  const prevItemsRef = useRef<RailItem[]>([]);
  // Entered ids keep their pill-in class for the element's lifetime —
  // the animation runs once on insertion, and a mid-flight re-render
  // must not strip the class and snap the tween.
  const enteredRef = useRef(new Set<string>());
  for (const item of live) {
    const prev = prevIdsRef.current;
    if (prev === null) {
      if (animateEnter) enteredRef.current.add(item.id);
    } else if (!prev.has(item.id)) {
      enteredRef.current.add(item.id);
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: diffing is keyed on the id list; item objects are re-derived each render
  useEffect(() => {
    const previous = prevItemsRef.current;
    const liveIds = new Set(live.map((item) => item.id));
    prevIdsRef.current = liveIds;
    prevItemsRef.current = live;
    for (const id of enteredRef.current) {
      if (!liveIds.has(id)) enteredRef.current.delete(id);
    }
    const removed = previous.filter((item) => !liveIds.has(item.id));
    setExiting((current) => {
      const kept = current.filter(
        (item) =>
          !liveIds.has(item.id) && !removed.some((gone) => gone.id === item.id),
      );
      const next = [...kept, ...removed];
      return next.length === current.length &&
        next.every((item, index) => item === current[index])
        ? current
        : next;
    });
  }, [liveIdsKey]);

  const renderItem = (item: RailItem, exitingItem: boolean) => (
    <span
      key={item.id}
      className={`flex shrink-0 items-center overflow-hidden ${
        exitingItem
          ? "animate-pill-out"
          : enteredRef.current.has(item.id)
            ? "animate-pill-in"
            : ""
      }`}
      onAnimationEnd={
        exitingItem
          ? (event) => {
              if (event.animationName === "pill-out") {
                setExiting((current) =>
                  current.filter((gone) => gone.id !== item.id),
                );
              }
            }
          : undefined
      }
    >
      {item.type === "group" ? (
        <GroupChip
          kind={kind}
          group={item.group}
          open={openGroup === kind}
          onToggle={() => onToggleGroup(kind)}
        />
      ) : (
        <SurfaceChip
          surface={item.surface}
          onOpenSurface={onOpenSurface}
          onRemoveSurface={onRemoveSurface}
          onOpenMcpApp={onOpenMcpApp}
          onToggleInfo={onToggleInfo}
        />
      )}
    </span>
  );

  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {exiting.map((item) => renderItem(item, true))}
      {live.map((item) => renderItem(item, false))}
    </span>
  );
}

/**
 * The surfaces rail. Kinds with many surfaces collapse into one group
 * chip ("4 pages") whose popover expands upward; kinds with few show
 * individual chips. Active surfaces (agent working, command running)
 * carry a spinner that aggregates onto their group chip. Collapse and
 * expansion animate through KindStrip; the popovers pop in and out.
 */
export function SurfacesRail({
  surfaces,
  onOpenSurface,
  onRemoveSurface,
  onOpenMcpApp,
}: {
  surfaces: ChatSurface[];
  onOpenSurface: (key: string, mode: OpenMode | "split") => void;
  onRemoveSurface?: (key: string) => void;
  onOpenMcpApp?: (view: McpAppRef, mode: OpenMode | "split") => void;
}) {
  const [openGroup, setOpenGroup] = useState<ChatSurface["kind"] | null>(null);
  const [openInfoKey, setOpenInfoKey] = useState<string | null>(null);
  const railRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!openGroup && !openInfoKey) return;
    const onDocMouseDown = (event: MouseEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-resource-inspector]")
      )
        return;
      if (!railRef.current?.contains(event.target as Node)) {
        setOpenGroup(null);
        setOpenInfoKey(null);
      }
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenGroup(null);
        setOpenInfoKey(null);
      }
    };
    document.addEventListener("mousedown", onDocMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [openGroup, openInfoKey]);

  const byKind = new Map<ChatSurface["kind"], ChatSurface[]>();
  for (const surface of surfaces) {
    byKind.set(surface.kind, [...(byKind.get(surface.kind) ?? []), surface]);
  }

  const toggleInfo = (key: string) => {
    setOpenGroup(null);
    setOpenInfoKey((current) => (current === key ? null : key));
  };
  const openInfoSurface = openInfoKey
    ? surfaces.find((surface) => surface.key === openInfoKey)
    : undefined;
  // PopPanel freezes the last open render through the exit animation,
  // so live (possibly null) content is passed straight in.
  const infoSurface = openInfoSurface?.info ? openInfoSurface : null;
  const groupSurfaces = openGroup ? byKind.get(openGroup) : undefined;
  const firstPaintRef = useRef(true);
  useEffect(() => {
    firstPaintRef.current = false;
  }, []);

  return (
    <div ref={railRef} className="relative mx-3">
      {/* Detail popover for chips that ARE their surface (subagents,
          watchers): the chip's activity feed, expanded upward. */}
      <PopPanel
        open={Boolean(infoSurface)}
        className="absolute bottom-full left-0 z-20 mb-1.5 max-h-64 w-80 overflow-y-auto rounded-lg border border-border bg-bg-raised p-2 shadow-2xl"
        testId="surface-info-popover"
      >
        {infoSurface && (
          <>
            <div className="flex items-center gap-1.5 px-1 pb-1.5 text-[11px] font-semibold text-fg">
              {(() => {
                const Icon =
                  infoSurface.kind === "app"
                    ? appGlyph(infoSurface.appIcon)
                    : SURFACE_ICONS[infoSurface.kind];
                return infoSurface.active ? (
                  <LoaderCircle className="size-3 animate-spin text-accent" />
                ) : (
                  <Icon className="size-3" />
                );
              })()}
              <span className="truncate">{infoSurface.label}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              {infoSurface.info?.map((line, index) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: static activity lines
                  key={index}
                  className="truncate px-1 font-mono text-[11px] text-fg-muted"
                >
                  {line}
                </div>
              ))}
            </div>
          </>
        )}
      </PopPanel>
      <PopPanel
        testId="surface-group-members"
        open={Boolean(groupSurfaces)}
        className="absolute bottom-full left-0 z-20 mb-1.5 max-h-64 w-72 overflow-y-auto rounded-lg border border-border bg-bg-raised p-1 shadow-2xl"
      >
        {groupSurfaces?.map((surface) => (
          <div
            key={surface.key}
            className="group/chip flex items-center rounded-md text-[12px] text-fg-muted transition-colors duration-100 hover:bg-bg-overlay"
          >
            <ResourceInspector
              label={`Preview ${surface.label}`}
              content={<SurfacePreview surface={surface} />}
            >
              {({ onClick: dismissPreview, ...previewProps }) => (
                <OpenResourceButton
                  {...previewProps}
                  isResource={!surface.info}
                  type="button"
                  onOpen={(mode) => {
                    dismissPreview();
                    if (surface.mcpApp) {
                      onOpenMcpApp?.(surface.mcpApp, mode);
                      setOpenGroup(null);
                      return;
                    }
                    if (surface.info) {
                      toggleInfo(surface.key);
                      return;
                    }
                    onOpenSurface(surface.key, mode);
                    setOpenGroup(null);
                  }}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 py-1.5 text-left hover:text-fg"
                >
                  <span className="relative grid size-3.5 shrink-0 place-items-center">
                    {surface.kind === "browser" && surface.faviconUrl ? (
                      <img
                        src={surface.faviconUrl}
                        alt=""
                        className={`col-start-1 row-start-1 size-3.5 rounded-[2px] ${surface.active ? "opacity-0" : ""}`}
                      />
                    ) : (
                      (() => {
                        const Icon =
                          surface.kind === "app"
                            ? appGlyph(surface.appIcon)
                            : SURFACE_ICONS[surface.kind];
                        return (
                          <Icon
                            className={`col-start-1 row-start-1 size-3.5 ${surface.active ? "opacity-0" : ""}`}
                          />
                        );
                      })()
                    )}
                    {surface.active && (
                      <LoaderCircle className="col-start-1 row-start-1 size-3.5 animate-spin text-accent" />
                    )}
                    {surface.attention && (
                      <span className="absolute -right-0.5 -top-0.5 size-1.5 animate-pulse rounded-full bg-accent" />
                    )}
                  </span>
                  <span className="truncate">{surface.label}</span>
                </OpenResourceButton>
              )}
            </ResourceInspector>
            {!surface.info && (
              <span className="mr-1 flex shrink-0 items-center opacity-0 transition-opacity duration-100 group-hover/chip:opacity-100">
                <ShortcutHint label="Open to the right" shortcut="⌘⇧-click">
                  <button
                    type="button"
                    onClick={() => {
                      onOpenSurface(surface.key, "split");
                      setOpenGroup(null);
                    }}
                    className="grid size-6 cursor-pointer place-items-center rounded text-fg-faint hover:text-fg"
                    aria-label={`Open ${surface.label} to the right`}
                  >
                    <Columns2 className="size-3" />
                  </button>
                </ShortcutHint>
                {surface.removable && onRemoveSurface && (
                  <ShortcutHint label="Remove from this chat">
                    <button
                      type="button"
                      onClick={() => {
                        onRemoveSurface(surface.key);
                        setOpenGroup(null);
                      }}
                      className="grid size-6 cursor-pointer place-items-center rounded text-fg-faint hover:text-fg"
                      aria-label={`Remove ${surface.label}`}
                    >
                      <X className="size-3" />
                    </button>
                  </ShortcutHint>
                )}
              </span>
            )}
          </div>
        ))}
      </PopPanel>
      <div className="flex items-center gap-1.5 overflow-x-auto pt-1">
        {[...byKind.entries()].map(([kind, group]) => (
          <KindStrip
            key={kind}
            kind={kind}
            group={group}
            animateEnter={!firstPaintRef.current}
            openGroup={openGroup}
            onToggleGroup={(toggled) =>
              setOpenGroup((current) => (current === toggled ? null : toggled))
            }
            onOpenSurface={onOpenSurface}
            onRemoveSurface={onRemoveSurface}
            onOpenMcpApp={onOpenMcpApp}
            onToggleInfo={toggleInfo}
          />
        ))}
      </div>
    </div>
  );
}
