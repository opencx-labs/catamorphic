import {
  type PointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ChatSignals } from "../../shared/chat.js";
import type {
  ChatEvent,
  DockData,
  DockSnapshot,
} from "../../shared/desktop-workspace.js";
import { parseDockClicks } from "../../shared/dock-clicks.js";
import { dockLanding } from "../../shared/dock-position.js";
import { fileUrlFor } from "../../shared/downloads.js";
import { localPresentations } from "../lib/chat-presentations.js";
import { desktopApi } from "../lib/desktop-api.js";
import { drawnDockRects } from "../lib/dock-shape.js";
import { matchesBinding, useKeybindings } from "../lib/keybindings.js";
import {
  applyTheme,
  ThemeScope,
  themeStyle,
  useProjectTheme,
} from "../lib/theme.js";
import { chatTabKey } from "../lib/workspace-state.js";
import { ChatBubbles } from "./chat-bubbles.js";
import { ChatDock } from "./chat-dock.js";
import { DockDialogs } from "./dock-dialogs.js";
import { DownloadsBubble } from "./downloads-bubble.js";

/** How this window lets clicks through, as the main process decided. */
const DOCK_CLICKS = parseDockClicks(
  new URLSearchParams(location.search).get("clicks"),
);

const EMPTY: DockSnapshot = {
  chats: [],
  detached: false,
  multiProject: false,
  side: "right",
  placement: "center",
  collapsed: false,
};

/** One presentation vocabulary, mounted in a workspace or in the native dock. */
export function DockHost({
  activeProjectId,
  detachedWindow = false,
}: {
  activeProjectId?: string;
  detachedWindow?: boolean;
}) {
  const keybindings = useKeybindings();
  const [remoteSnapshot, setSnapshot] = useState(EMPTY);
  const local = useSyncExternalStore(
    localPresentations.subscribe,
    localPresentations.getSnapshot,
  );
  const snapshot = {
    ...remoteSnapshot,
    chats: [
      ...remoteSnapshot.chats.filter((chat) => !chat.local),
      ...local.chats,
    ],
    activeChatId: local.pendingActivation ?? remoteSnapshot.activeChatId,
  };
  useEffect(
    () => localPresentations.acknowledge(remoteSnapshot.activeChatId),
    [remoteSnapshot.activeChatId],
  );
  const [signals, setSignals] = useState<Record<string, ChatSignals>>({});
  const dragStart = useRef<{
    x: number;
    left: number;
    max: number;
    /** The strip's width and the region's, for where it would land. */
    width: number;
    hostWidth: number;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const [dragLeft, setDragLeft] = useState<number | null>(null);
  // A drag is under way (past the click threshold). The detached window
  // holds its size until it lands: the open chat collapses as the drag
  // starts, and resizing then would move the window out from under the
  // pointer.
  const [dragging, setDragging] = useState(false);
  // The strip's handle is held: a shield covers the window so pages and
  // app frames under a quick drag never take the pointer's moves.
  const [held, setHeld] = useState(false);
  const [dragTarget, setDragTarget] = useState<
    "left" | "center" | "right" | null
  >(null);
  const positionRevision = useRef(0);
  const [positionError, setPositionError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const actions = useRef(
    new Map<
      string,
      {
        close?: () => void;
        minimize?: () => void;
        send?: (message: string) => void;
      }
    >(),
  );
  const showing = useRef(new Set<string>());
  const currentProjectId = activeProjectId ?? snapshot.activeProjectId;
  // The downloads bubble opens things in the workspace: through the
  // workspaces service when this is the detached dock window, straight
  // to this window's app otherwise (it needs no project for that).
  const navigateSurface = (surface: {
    url: string;
    title: string;
    mode: "replace" | "tab" | "side" | "floating";
    open: "page" | "browser";
  }) => {
    const nonce = crypto.randomUUID();
    if (detachedWindow && currentProjectId) {
      void desktopApi.workspaceNavigate({
        projectId: currentProjectId,
        surface: { ...surface, nonce },
      });
      return;
    }
    window.dispatchEvent(
      new CustomEvent("catamorphic:dock-navigate", {
        detail: { ...surface, nonce },
      }),
    );
  };
  const currentTheme = useProjectTheme(currentProjectId);
  useEffect(() => {
    if (currentTheme) applyTheme(currentTheme);
  }, [currentTheme]);
  const isPresentation = detachedWindow
    ? snapshot.detached
    : !snapshot.detached;
  useEffect(() => {
    void desktopApi.dockSnapshot().then(setSnapshot);
    return desktopApi.onDockSnapshot(setSnapshot);
  }, []);
  // The strip waits for the real snapshot: drawn from the placeholder, a
  // folded strip would show open, then slide shut, on every launch.
  const snapshotLoaded = snapshot !== EMPTY;
  // In the window, the dock rests on the visible workspace's chat region by
  // CSS anchoring (styles.css), so it moves in the same frame as the region
  // (a sidebar settling, a split) without measuring. While the dock floats
  // in its own window, this workspace tells the main process where that
  // region sits so the dock can rest inside it whenever this window is in
  // front.
  useLayoutEffect(() => {
    if (detachedWindow) return;
    if (!activeProjectId || !snapshot.detached) {
      void desktopApi.dockRegion(null);
      return;
    }
    const selector = `[data-project-runtime="${CSS.escape(activeProjectId)}"] [data-workspace-chat-region]`;
    // The region mounts after the project does (and remounts with it), so
    // one lookup is not enough.
    let target: HTMLElement | null = null;
    let reported: DOMRect | null = null;
    const observer = new ResizeObserver(() => measure());
    const resolve = () => {
      if (target?.isConnected) return target;
      if (target) observer.unobserve(target);
      const found = document.querySelector(selector);
      target = found instanceof HTMLElement ? found : null;
      if (target) observer.observe(target);
      return target;
    };
    const measure = () => {
      const current = resolve();
      if (!current) return;
      const bounds = current.getBoundingClientRect();
      if (
        reported?.left === bounds.left &&
        reported.top === bounds.top &&
        reported.width === bounds.width &&
        reported.height === bounds.height
      )
        return;
      reported = bounds;
      void desktopApi.dockRegion({
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height,
      });
    };
    measure();
    // Mounts and sidebar toggles move the region without resizing anything
    // observed yet; structural changes are the signal until it exists.
    const mutations = new MutationObserver(() => {
      if (!target?.isConnected) measure();
    });
    mutations.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [activeProjectId, detachedWindow, snapshot.detached]);
  useEffect(() => {
    if (detachedWindow) return;
    return () => {
      void desktopApi.dockRegion(null);
    };
  }, [detachedWindow]);
  useEffect(
    () =>
      desktopApi.onWorkspaceEvent((event) => {
        if (event.kind !== "dockAction" || !showing.current.has(event.localId))
          return;
        const action = actions.current.get(event.localId);
        if (event.action === "send" && event.message)
          action?.send?.(event.message);
        else if (event.action === "close") action?.close?.();
        else if (event.action === "minimize") action?.minimize?.();
      }),
    [],
  );
  const scoped = snapshot.chats.filter(
    (chat) =>
      snapshot.multiProject ||
      chat.projectId === currentProjectId ||
      chat.attention,
  );
  const active =
    scoped.find((chat) => chat.entry.localId === snapshot.activeChatId) ??
    (!snapshot.multiProject
      ? scoped.find((chat) => chat.selected && chat.entry.mode === "partial")
      : undefined);
  const tabbed = snapshot.chats.find(
    (chat) =>
      chat.projectId === currentProjectId &&
      chat.entry.mode === "tab" &&
      chat.tabActive,
  );
  const expanded = isPresentation && active && active.entry.mode === "partial";
  const railWidth = collapsed
    ? 100
    : Math.min(
        780,
        scoped.filter((chat) => chat.entry.mode !== "tab").length * 42 + 132,
      );
  // Transparent headroom above the strip gives hints room to open above a
  // bubble instead of being clamped onto it.
  const DOCK_HEADROOM = 48;
  // Dialogs and the downloads popover need more room than the strip.
  const roomy = expanded || dialogOpen || downloadsOpen;
  const windowWidth = roomy ? 780 : railWidth;
  const windowHeight = roomy ? 560 : 76 + DOCK_HEADROOM;
  // Collapsing the strip with a chat open plays the chat's exit first; the
  // window keeps the open placement until that chat has minimized, then
  // moves to the collapsed corner with the bubble.
  const windowExpanded = !collapsed || Boolean(expanded);
  // The size main last applied: a drag lands with its size (nativeDrag), and
  // sending it again would cut the landing's motion short.
  const sentSizeRef = useRef("");
  const sizeKey = `${windowWidth}x${windowHeight}:${windowExpanded}`;
  useEffect(() => {
    // Never while the handle is held: main took the window's bounds when
    // the press began, and resizing would move it from under the pointer.
    if (!detachedWindow || dragging || held || sentSizeRef.current === sizeKey)
      return;
    sentSizeRef.current = sizeKey;
    void desktopApi.dockResize({
      width: windowWidth,
      height: windowHeight,
      expanded: windowExpanded,
    });
  }, [
    detachedWindow,
    windowWidth,
    windowHeight,
    windowExpanded,
    sizeKey,
    dragging,
    held,
  ]);
  // Over the headroom, the margins around the chat, or any other empty
  // space, the window lets clicks through to whatever is behind it (where
  // the platform allows; the main process answers whether it did). Only
  // dock content answers a hit test there: the app root and the body are
  // pointer-transparent (styles.css), so a hit on either is empty space.
  // `data-dock-pass-through` on the root says what the window does with a
  // click right now, once the main process has applied it; while a change
  // is in flight it is absent, never stale. A click that races the change
  // lands on the other side (the native pointer tests wait for this).
  const passThroughRequest = useRef(0);
  useEffect(() => {
    if (!detachedWindow) return;
    const root = document.documentElement;
    delete root.dataset.dockPassThrough;
    let ignoring = false;
    let last: { x: number; y: number } | null = null;
    const update = (interactive: boolean) => {
      if (ignoring === !interactive) return;
      ignoring = !interactive;
      const requested = ignoring;
      const request = ++passThroughRequest.current;
      delete root.dataset.dockPassThrough;
      void desktopApi
        .dockIgnoreMouse(requested)
        .then((passesThrough) => {
          if (passThroughRequest.current === request)
            root.dataset.dockPassThrough = String(passesThrough);
        })
        .catch(() => {});
    };
    const hitTest = () => {
      if (!last) return;
      const target = document.elementFromPoint(last.x, last.y);
      update(
        Boolean(target) &&
          target !== document.body &&
          target !== document.documentElement,
      );
    };
    const move = (event: MouseEvent) => {
      last = { x: event.clientX, y: event.clientY };
      hitTest();
    };
    const leave = () => {
      last = null;
      update(true);
    };
    // The window grows and shrinks under a parked pointer (a chat opening,
    // the strip collapsing): what is under it changes without a move.
    let frame = 0;
    const resized = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(hitTest);
    };
    document.addEventListener("mousemove", move);
    document.documentElement.addEventListener("mouseleave", leave);
    window.addEventListener("resize", resized);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("mousemove", move);
      document.documentElement.removeEventListener("mouseleave", leave);
      window.removeEventListener("resize", resized);
      // Earlier answers no longer describe this window's state.
      passThroughRequest.current += 1;
      delete root.dataset.dockPassThrough;
      update(true);
    };
  }, [detachedWindow]);
  // Where the window cannot let clicks through (Linux on X11), it takes the
  // shape of what it draws, re-measured on the frame after anything changes
  // (DOM, a drawn surface's size, the pointer arriving over it) and on every
  // frame while something moves. `data-dock-shape` on the root is the shape
  // the main process applied (JSON; "null" is the whole window): absent
  // while a change is in flight, and never set when it was not applied.
  const shapeRequest = useRef(0);
  useEffect(() => {
    if (!detachedWindow || DOCK_CLICKS !== "shape") return;
    const root = document.documentElement;
    delete root.dataset.dockShape;
    let frame = 0;
    let sent: string | undefined;
    const moving = () =>
      document
        .getAnimations()
        .some(
          (animation) =>
            animation.playState === "running" &&
            animation.effect?.getTiming().iterations !== Infinity,
        );
    const sizes = new ResizeObserver(() => schedule());
    const measure = () => {
      frame = 0;
      const rects = drawnDockRects(document.body, (element) =>
        sizes.observe(element),
      );
      const key = JSON.stringify(rects);
      if (key !== sent) {
        sent = key;
        const request = ++shapeRequest.current;
        delete root.dataset.dockShape;
        void desktopApi
          .dockShape(rects)
          .then((applied) => {
            if (applied && shapeRequest.current === request)
              root.dataset.dockShape = key;
          })
          .catch(() => {});
      }
      if (moving()) schedule();
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    window.addEventListener("resize", schedule);
    document.addEventListener("transitionrun", schedule, true);
    document.addEventListener("animationstart", schedule, true);
    // Hover-only changes (a revealed action, a grown card) move no DOM.
    document.addEventListener("pointerover", schedule, true);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      mutations.disconnect();
      sizes.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("transitionrun", schedule, true);
      document.removeEventListener("animationstart", schedule, true);
      document.removeEventListener("pointerover", schedule, true);
      shapeRequest.current += 1;
      delete root.dataset.dockShape;
      void desktopApi.dockShape(null).catch(() => {});
    };
  }, [detachedWindow]);

  const invoke = (chat: DockData, event: ChatEvent) => {
    if (chat.local) {
      if (
        ["surface", "mcpApp", "link", "file", "focus", "unsplit"].includes(
          event.kind,
        ) ||
        (event.kind === "entry" && event.entry.mode === "tab")
      )
        void desktopApi.workspaceNavigate({ projectId: chat.projectId });
      if (localPresentations.invoke(chat.entry.localId, event)) return;
    }
    void desktopApi.dockCommand({
      projectId: chat.projectId,
      localId: chat.entry.localId,
      event,
    });
  };
  const toggle = (id: string) => {
    const chat = snapshot.chats.find((item) => item.entry.localId === id);
    if (!chat) return;
    if (active?.entry.localId === id && chat.entry.mode === "partial") {
      actions.current.get(id)?.minimize?.();
      return;
    }
    void desktopApi.dockActivate(id);
    invoke(chat, { kind: "reveal" });
  };
  const lastActive = useRef<string | undefined>(undefined);
  if (active) lastActive.current = active.entry.localId;
  const keyboard = useRef<(event: KeyboardEvent) => void>(() => {});
  keyboard.current = (event) => {
    if (!isPresentation || event.defaultPrevented) return;
    const chat =
      active ??
      scoped.find((chat) => chat.entry.localId === lastActive.current);
    const foreign =
      detachedWindow || (chat && chat.projectId !== currentProjectId);
    if (snapshot.multiProject || detachedWindow) {
      const direction = matchesBinding(event, keybindings["next-chat"])
        ? 1
        : matchesBinding(event, keybindings["prev-chat"])
          ? -1
          : 0;
      if (direction) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const entries = scoped.filter((chat) => chat.entry.mode !== "tab");
        const index = entries.findIndex(
          (item) => item.entry.localId === chat?.entry.localId,
        );
        const next =
          entries[
            (Math.max(index, 0) + direction + entries.length) % entries.length
          ];
        if (next && (next !== active || next.entry.mode !== "partial"))
          toggle(next.entry.localId);
        return;
      }
    }
    if (!foreign) return;
    if (matchesBinding(event, keybindings["new-floating-chat"])) {
      event.preventDefault();
      event.stopImmediatePropagation();
      void desktopApi.dockNewChat();
      return;
    }
    if (!chat) return;
    if (matchesBinding(event, keybindings["toggle-chat-minimized"])) {
      event.preventDefault();
      event.stopImmediatePropagation();
      toggle(chat.entry.localId);
    } else if (matchesBinding(event, keybindings["chat-to-tab"])) {
      event.preventDefault();
      event.stopImmediatePropagation();
      invoke(chat, { kind: "entry", entry: { ...chat.entry, mode: "tab" } });
    } else if (
      matchesBinding(event, keybindings["close-tab"]) &&
      document.activeElement?.closest("[data-dock-host]")
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      actions.current.get(chat.entry.localId)?.close?.();
    }
  };
  useEffect(() => {
    const handle = (event: KeyboardEvent) => keyboard.current(event);
    window.addEventListener("keydown", handle, true);
    return () => window.removeEventListener("keydown", handle, true);
  }, []);
  const closeFromMenu = useRef(() => {});
  closeFromMenu.current = () => {
    if (
      !isPresentation ||
      !active ||
      (!detachedWindow && active.projectId === currentProjectId)
    )
      return;
    if (detachedWindow || document.activeElement?.closest("[data-dock-host]"))
      actions.current.get(active.entry.localId)?.close?.();
  };
  useEffect(() => desktopApi.onCloseSurface(() => closeFromMenu.current()), []);
  // The person's fold of the strip, shown at once and kept in prefs, where
  // every window (and the next launch) reads it from.
  const saveFolded = (collapsed: boolean) => {
    const previous = snapshot.collapsed;
    setSnapshot((state) => ({ ...state, collapsed }));
    void desktopApi.setPrefs({ dockCollapsed: collapsed }).catch(() => {
      setSnapshot((state) => ({ ...state, collapsed: previous }));
    });
  };
  const saveSide = (side: "left" | "right") => {
    const revision = ++positionRevision.current;
    const previous = snapshot.side;
    setSnapshot((state) => ({ ...state, side }));
    setPositionError(null);
    void desktopApi.setPrefs({ dockSide: side }).catch(() => {
      if (positionRevision.current !== revision) return;
      setSnapshot((state) => ({ ...state, side: previous }));
      setPositionError(
        "Could not save the dock position. Try dragging it again.",
      );
    });
  };
  const savePlacement = (placement: "left" | "center" | "right") => {
    const revision = ++positionRevision.current;
    const previous = snapshot.placement;
    setSnapshot((state) => ({ ...state, placement }));
    setPositionError(null);
    void desktopApi.setPrefs({ dockPlacement: placement }).catch(() => {
      if (positionRevision.current !== revision) return;
      setSnapshot((state) => ({ ...state, placement: previous }));
      setPositionError(
        "Could not save the dock position. Try dragging it again.",
      );
    });
  };
  const nativeDrag = (
    phase: "start" | "move" | "end" | "cancel",
    screenX: number,
  ) => {
    const lands = phase === "end" || phase === "cancel";
    if (lands) sentSizeRef.current = sizeKey;
    void desktopApi
      .dockDrag({
        phase,
        screenX,
        reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)")
          .matches,
        ...(lands
          ? {
              size: {
                width: windowWidth,
                height: windowHeight,
                expanded: windowExpanded,
              },
            }
          : {}),
      })
      .catch(() =>
        setPositionError("Could not move the dock. Try dragging it again."),
      );
  };
  const cancelDrag = () => {
    if (detachedWindow && dragStart.current)
      nativeDrag("cancel", dragStart.current.x);
    suppressClick.current = dragStart.current?.moved ?? false;
    dragStart.current = null;
    setHeld(false);
    setDragging(false);
    setDragLeft(null);
    setDragTarget(null);
  };
  /**
   * Where the strip lands if let go now: the spot nearest its centre, past
   * 40% of the way from the one it left (shared with the detached dock).
   */
  const landing = (
    start: NonNullable<typeof dragStart.current>,
    delta: number,
    intent: "side" | "placement",
  ) => {
    const left = Math.max(32, Math.min(start.max, start.left + delta));
    const centre = left + start.width / 2;
    const corners = [
      { spot: "left", at: 32 + start.width / 2 },
      { spot: "right", at: start.hostWidth - 32 - start.width / 2 },
    ] as const;
    return intent === "side"
      ? (dockLanding({ from: snapshot.side, centre, spots: corners }) ??
          snapshot.side)
      : (dockLanding({
          from: snapshot.placement,
          centre,
          spots: [...corners, { spot: "center", at: start.hostWidth / 2 }],
        }) ?? snapshot.placement);
  };
  /**
   * Dragging the collapsed bubble picks its corner; dragging the arrows of
   * an expanded strip picks where open chats sit (left, center, right).
   * Release snaps; a short press without movement is still a click.
   */
  const dragHandlersFor = (intent: "side" | "placement") => ({
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      const host = event.currentTarget
        .closest("[data-dock-host]")
        ?.getBoundingClientRect();
      const rail = event.currentTarget
        .closest("[data-dock-host]")
        ?.querySelector("[data-dock-rail]")
        ?.getBoundingClientRect();
      if (!host || !rail) return;
      suppressClick.current = false;
      dragStart.current = {
        x: detachedWindow ? event.screenX : event.clientX,
        left: rail.left - host.left,
        max: Math.max(32, host.width - rail.width - 32),
        width: rail.width,
        hostWidth: host.width,
        moved: false,
      };
      if (detachedWindow) nativeDrag("start", event.screenX);
      event.currentTarget.setPointerCapture(event.pointerId);
      setHeld(true);
    },
    onPointerMove: (event: PointerEvent<HTMLButtonElement>) => {
      const start = dragStart.current;
      if (!start || !event.currentTarget.hasPointerCapture(event.pointerId))
        return;
      const delta = (detachedWindow ? event.screenX : event.clientX) - start.x;
      if (!start.moved && Math.abs(delta) < 5) return;
      if (!start.moved) {
        setDragging(true);
        // Dragging the open strip's arrows is using it open: a fold the
        // person made earlier (the strip only open beside a chat) gives
        // way, or minimizing the chat below would fold it mid-drag.
        if (intent === "placement" && snapshot.collapsed) saveFolded(false);
        // The open chat would sit still while the strip moves, then snap
        // to its new place on release: it collapses as the drag starts,
        // exactly as the collapse button does.
        if (expanded && active)
          actions.current.get(active.entry.localId)?.minimize?.();
      }
      start.moved = true;
      event.preventDefault();
      if (detachedWindow) nativeDrag("move", event.screenX);
      else setDragLeft(Math.max(32, Math.min(start.max, start.left + delta)));
      setDragTarget(landing(start, delta, intent));
    },
    onPointerUp: (event: PointerEvent<HTMLButtonElement>) => {
      const start = dragStart.current;
      if (!start) return;
      dragStart.current = null;
      suppressClick.current = start.moved;
      // The click a drag's release makes arrives in this same task; one
      // that never comes must not swallow the next real click.
      if (start.moved)
        setTimeout(() => {
          suppressClick.current = false;
        });
      if (detachedWindow)
        nativeDrag(start.moved ? "end" : "cancel", event.screenX);
      else if (start.moved) {
        const spot = landing(start, event.clientX - start.x, intent);
        if (intent === "side") saveSide(spot === "left" ? "left" : "right");
        else savePlacement(spot);
      }
      setHeld(false);
      setDragging(false);
      setDragLeft(null);
      setDragTarget(null);
      event.currentTarget.releasePointerCapture(event.pointerId);
    },
    onPointerCancel: cancelDrag,
    onLostPointerCapture: () => {
      if (dragStart.current) cancelDrag();
    },
    onClickCapture: (event: React.MouseEvent<HTMLButtonElement>) => {
      if (!suppressClick.current) return;
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "Escape" && dragStart.current) {
        event.preventDefault();
        cancelDrag();
      }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      if (intent === "side") {
        saveSide(event.key === "ArrowLeft" ? "left" : "right");
        return;
      }
      const order = ["left", "center", "right"] as const;
      const index = order.indexOf(snapshot.placement);
      const next =
        order[
          Math.max(
            0,
            Math.min(
              order.length - 1,
              index + (event.key === "ArrowLeft" ? -1 : 1),
            ),
          )
        ];
      if (next && next !== snapshot.placement) savePlacement(next);
    },
  });
  showing.current = new Set();
  // Where the strip rests: a corner while collapsed, its placement open.
  const railSpot = collapsed ? snapshot.side : snapshot.placement;
  return (
    <div
      data-dock-host
      data-dock-native={detachedWindow || undefined}
      data-dock-side={snapshot.side}
      data-dock-placement={snapshot.placement}
      className={`pointer-events-none absolute ${detachedWindow ? "inset-0" : ""}`}
      style={themeStyle(currentTheme)}
    >
      {detachedWindow && <DockDialogs onOpenChange={setDialogOpen} />}
      {snapshot.chats.map((chat) => {
        const isTab =
          !detachedWindow &&
          chat.projectId === currentProjectId &&
          chat.entry.mode === "tab";
        const visible =
          (isTab && chat.tabActive) ||
          (isPresentation && chat === active && chat.entry.mode === "partial");
        // The owning workspace keeps a headless/minimized surface mounted for
        // signals and queued sends; other projects are ordinary session subscribers.
        const entry = {
          ...chat.entry,
          mode: visible
            ? isTab
              ? ("tab" as const)
              : ("partial" as const)
            : ("min" as const),
          pendingMessage:
            detachedWindow || !chat.local
              ? undefined
              : chat.entry.pendingMessage,
        };
        if (visible) showing.current.add(entry.localId);
        const register = (patch: {
          close?: () => void;
          minimize?: () => void;
          send?: (message: string) => void;
        }) =>
          actions.current.set(entry.localId, {
            ...actions.current.get(entry.localId),
            ...patch,
          });
        return (
          <ThemeScope key={entry.localId} theme={chat.theme}>
            <div
              className="absolute inset-0 pointer-events-none"
              data-theme={chat.theme?.appearance}
              style={{
                ...themeStyle(chat.theme),
              }}
            >
              <ChatDock
                {...chat}
                entry={entry}
                refreshWhileIdle={visible}
                tabActive={isTab && chat.tabActive}
                bubbleClearance={collapsed ? "corner" : "strip"}
                backdropTab={!detachedWindow && chat.backdropTab}
                nativeWindow={detachedWindow}
                onEntryChange={(next) => {
                  invoke(chat, {
                    kind: "entry",
                    entry: {
                      ...next,
                      pendingMessage:
                        chat.local && !detachedWindow
                          ? next.pendingMessage
                          : chat.entry.pendingMessage,
                    },
                  });
                }}
                onClose={() => invoke(chat, { kind: "close" })}
                onCloseStarted={() => invoke(chat, { kind: "closing" })}
                onSessionCreated={(_id, sessionId) =>
                  invoke(chat, { kind: "session", sessionId })
                }
                onSignalsChange={(_id, next) => {
                  setSignals((old) =>
                    JSON.stringify(old[entry.localId]) === JSON.stringify(next)
                      ? old
                      : { ...old, [entry.localId]: next },
                  );
                  if (chat.local && !detachedWindow)
                    invoke(chat, { kind: "signals", signals: next });
                }}
                onOpenSurface={(key, mode) =>
                  invoke(chat, { kind: "surface", key, mode })
                }
                onRemoveSurface={(key) =>
                  invoke(chat, { kind: "removeSurface", key })
                }
                onOpenMcpApp={(view, mode) =>
                  invoke(chat, { kind: "mcpApp", view, mode })
                }
                onLinkClick={(url, modifiers) =>
                  invoke(chat, { kind: "link", url, modifiers })
                }
                onFileClick={(path, modifiers) =>
                  invoke(chat, { kind: "file", path, modifiers })
                }
                onFork={(messageId) =>
                  invoke(chat, { kind: "fork", messageId })
                }
                onForkCurrent={() => invoke(chat, { kind: "forkCurrent" })}
                onArchive={() => invoke(chat, { kind: "archive" })}
                onEditAgent={() => invoke(chat, { kind: "editAgent" })}
                onEditModel={() => invoke(chat, { kind: "editModel" })}
                onEditEffort={() => invoke(chat, { kind: "editEffort" })}
                onEditPermissionMode={() =>
                  invoke(chat, { kind: "editPermissionMode" })
                }
                onOpenParent={
                  chat.fork ? () => invoke(chat, { kind: "parent" }) : undefined
                }
                onFocusRequest={
                  isTab ? () => invoke(chat, { kind: "focus" }) : undefined
                }
                onUnsplit={
                  isTab && chat.slot !== "full"
                    ? () => invoke(chat, { kind: "unsplit" })
                    : undefined
                }
                onEscapeToFloating={() => invoke(chat, { kind: "escape" })}
                registerClose={(close) => register({ close })}
                registerMinimize={(minimize) => register({ minimize })}
                registerSend={(send) => register({ send })}
              />
            </div>
          </ThemeScope>
        );
      })}
      {isPresentation &&
        snapshotLoaded &&
        (currentProjectId || scoped.length > 0) && (
          <>
            {/* A browser page or app frame under the pointer would take its
              moves despite the pointer capture, stranding the drag short
              of the resting spot it was headed for. The detached window
              moves with the pointer instead. */}
            {held && !detachedWindow && (
              <div
                aria-hidden="true"
                data-dock-drag-shield
                className="pointer-events-auto fixed inset-0 z-30 cursor-grabbing"
              />
            )}
            <ChatBubbles
              attention={Object.fromEntries(
                scoped.map((chat) => [chat.entry.localId, chat.attention]),
              )}
              menus={Object.fromEntries(
                scoped.map((chat) => [chat.entry.localId, chat.menu]),
              )}
              onMenuAction={(id, entry) => {
                const chat = scoped.find((chat) => chat.entry.localId === id);
                if (chat) invoke(chat, { kind: "menu", entry });
              }}
              dragLeft={dragLeft}
              // The detached window moves natively with the drag, so resting
              // spots drawn inside it would travel with the pointer.
              dragTarget={detachedWindow ? null : dragTarget}
              detached={snapshot.detached}
              nativeMenus={detachedWindow}
              onToggleDetached={() => {
                void desktopApi.dockDetach(!snapshot.detached);
              }}
              placement={snapshot.placement}
              dragHandlers={dragHandlersFor("side")}
              placementDragHandlers={dragHandlersFor("placement")}
              newChatProjectName={
                snapshot.chats.find(
                  (chat) => chat.projectId === currentProjectId,
                )?.projectName
              }
              entries={scoped.map((chat) => chat.entry)}
              labels={Object.fromEntries(
                scoped.map((chat) => [
                  chat.entry.localId,
                  `${chat.title} · ${chat.projectName}`,
                ]),
              )}
              icons={Object.fromEntries(
                scoped.map((chat) => [chat.entry.localId, chat.icon]),
              )}
              forks={Object.fromEntries(
                scoped.map((chat) => [chat.entry.localId, chat.fork]),
              )}
              signals={signals}
              unread={Object.fromEntries(
                scoped.map((chat) => [chat.entry.localId, chat.unread]),
              )}
              themes={Object.fromEntries(
                scoped.map((chat) => [
                  chat.entry.localId,
                  themeStyle(chat.theme),
                ]),
              )}
              side={snapshot.side}
              activeLocalId={active?.entry.localId}
              // A detached dock is its own window; the main window's tab
              // focus must not fold it and move it between corner and spot.
              autoCollapse={!detachedWindow && Boolean(tabbed)}
              folded={snapshot.collapsed}
              onFoldedChange={saveFolded}
              onCollapsedChange={setCollapsed}
              onToggle={toggle}
              onOpenAs={(id, mode) => {
                const chat = scoped.find((chat) => chat.entry.localId === id);
                if (!chat) return;
                // The side transition promotes the chat to a tab itself and
                // splits it against the tab that is active now; changing the
                // entry first would make the chat the active tab and leave
                // nothing to split against.
                if (mode === "side") {
                  invoke(chat, { kind: "surface", key: chatTabKey(id), mode });
                  return;
                }
                invoke(chat, {
                  kind: "entry",
                  entry: { ...chat.entry, mode: "tab" },
                });
              }}
              onClose={(id) => actions.current.get(id)?.close?.()}
              trailing={
                <DownloadsBubble
                  // The bubble ends the strip: at a side of the screen its
                  // popover opens toward the middle.
                  align={
                    railSpot === "right"
                      ? "end"
                      : railSpot === "left"
                        ? "start"
                        : "center"
                  }
                  onOpenChange={setDownloadsOpen}
                  onOpenAll={() =>
                    navigateSurface({
                      url: "downloads",
                      title: "Downloads",
                      mode: "tab",
                      open: "page",
                    })
                  }
                  onOpenFile={(record) =>
                    navigateSurface({
                      url: fileUrlFor(record.savePath),
                      title: record.filename,
                      mode: "tab",
                      open: "browser",
                    })
                  }
                />
              }
              onNewChat={() => {
                void desktopApi.dockNewChat();
              }}
              onCollapse={() => {
                if (active)
                  actions.current.get(active.entry.localId)?.minimize?.();
              }}
            />
            {positionError && (
              <p
                role="alert"
                className="pointer-events-auto absolute bottom-16 right-3 rounded-md border border-danger/30 bg-bg-raised px-3 py-2 text-xs text-danger"
              >
                {positionError}
              </p>
            )}
          </>
        )}
    </div>
  );
}
