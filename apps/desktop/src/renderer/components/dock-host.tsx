import {
  type CSSProperties,
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
import { localPresentations } from "../lib/chat-presentations.js";
import { desktopApi } from "../lib/desktop-api.js";
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

const EMPTY: DockSnapshot = {
  chats: [],
  detached: false,
  multiProject: false,
  side: "right",
  placement: "center",
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
    middle: number;
    max: number;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const [dragLeft, setDragLeft] = useState<number | null>(null);
  const [dragTarget, setDragTarget] = useState<
    "left" | "center" | "right" | null
  >(null);
  const positionRevision = useRef(0);
  const [positionError, setPositionError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [region, setRegion] = useState<CSSProperties>({ inset: 0 });
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
  useLayoutEffect(() => {
    if (detachedWindow || !activeProjectId) return;
    const target = document.querySelector(
      `[data-project-runtime="${CSS.escape(activeProjectId)}"] [data-workspace-chat-region]`,
    );
    if (!(target instanceof HTMLElement)) return;
    const measure = () => {
      const bounds = target.getBoundingClientRect();
      setRegion((previous) =>
        previous.left === bounds.left &&
        previous.top === bounds.top &&
        previous.width === bounds.width &&
        previous.height === bounds.height
          ? previous
          : {
              left: bounds.left,
              top: bounds.top,
              width: bounds.width,
              height: bounds.height,
            },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [activeProjectId, detachedWindow]);
  // While the dock floats in its own window, this workspace tells the main
  // process where its chat region sits so the dock can rest inside it
  // whenever this window is in front.
  useEffect(() => {
    if (detachedWindow) return;
    const reported =
      snapshot.detached &&
      typeof region.left === "number" &&
      typeof region.top === "number" &&
      typeof region.width === "number" &&
      typeof region.height === "number"
        ? {
            left: region.left,
            top: region.top,
            width: region.width,
            height: region.height,
          }
        : null;
    void desktopApi.dockRegion(reported);
  }, [detachedWindow, snapshot.detached, region]);
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
  useEffect(() => {
    if (detachedWindow)
      void desktopApi.dockResize({
        width: expanded || dialogOpen ? 780 : railWidth,
        height: expanded || dialogOpen ? 560 : 76 + DOCK_HEADROOM,
        // Collapsing the strip with a chat open plays the chat's exit first;
        // the window keeps the open placement until that chat has minimized,
        // then moves to the collapsed corner with the bubble.
        expanded: !collapsed || Boolean(expanded),
      });
  }, [detachedWindow, expanded, dialogOpen, railWidth, collapsed]);
  // Over the headroom (or any empty space) the window lets clicks through.
  useEffect(() => {
    if (!detachedWindow) return;
    let ignoring = false;
    const update = (interactive: boolean) => {
      if (ignoring === !interactive) return;
      ignoring = !interactive;
      void desktopApi.dockIgnoreMouse(ignoring).catch(() => {});
    };
    const move = (event: MouseEvent) => {
      const target = document.elementFromPoint(event.clientX, event.clientY);
      update(
        Boolean(target) &&
          target !== document.body &&
          target !== document.documentElement,
      );
    };
    const leave = () => update(true);
    document.addEventListener("mousemove", move);
    document.documentElement.addEventListener("mouseleave", leave);
    return () => {
      document.removeEventListener("mousemove", move);
      document.documentElement.removeEventListener("mouseleave", leave);
      update(true);
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
    void desktopApi
      .dockDrag({
        phase,
        screenX,
        reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)")
          .matches,
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
    setDragLeft(null);
    setDragTarget(null);
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
        middle: host.left + host.width / 2,
        max: Math.max(32, host.width - rail.width - 32),
        moved: false,
      };
      if (detachedWindow) nativeDrag("start", event.screenX);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: PointerEvent<HTMLButtonElement>) => {
      const start = dragStart.current;
      if (!start || !event.currentTarget.hasPointerCapture(event.pointerId))
        return;
      const delta = (detachedWindow ? event.screenX : event.clientX) - start.x;
      if (!start.moved && Math.abs(delta) < 5) return;
      start.moved = true;
      event.preventDefault();
      if (detachedWindow) nativeDrag("move", event.screenX);
      else setDragLeft(Math.max(32, Math.min(start.max, start.left + delta)));
      const host = event.currentTarget
        .closest("[data-dock-host]")
        ?.getBoundingClientRect();
      const x = detachedWindow ? event.screenX : event.clientX;
      if (intent === "side" || !host)
        setDragTarget(x < start.middle ? "left" : "right");
      else
        setDragTarget(
          x < host.left + host.width / 3
            ? "left"
            : x > host.left + (host.width * 2) / 3
              ? "right"
              : "center",
        );
    },
    onPointerUp: (event: PointerEvent<HTMLButtonElement>) => {
      const start = dragStart.current;
      if (!start) return;
      dragStart.current = null;
      suppressClick.current = start.moved;
      if (detachedWindow)
        nativeDrag(start.moved ? "end" : "cancel", event.screenX);
      else if (start.moved) {
        const host = event.currentTarget
          .closest("[data-dock-host]")
          ?.getBoundingClientRect();
        if (intent === "side" || !host)
          saveSide(event.clientX < start.middle ? "left" : "right");
        else
          savePlacement(
            event.clientX < host.left + host.width / 3
              ? "left"
              : event.clientX > host.left + (host.width * 2) / 3
                ? "right"
                : "center",
          );
      }
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
  return (
    <div
      data-dock-host
      data-dock-native={detachedWindow || undefined}
      data-dock-side={snapshot.side}
      data-dock-placement={snapshot.placement}
      className={`pointer-events-none absolute ${detachedWindow ? "inset-0" : ""}`}
      style={{ ...themeStyle(currentTheme), ...(detachedWindow ? {} : region) }}
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
                onEditModel={() => invoke(chat, { kind: "editModel" })}
                onEditEffort={() => invoke(chat, { kind: "editEffort" })}
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
      {isPresentation && (currentProjectId || scoped.length > 0) && (
        <>
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
              snapshot.chats.find((chat) => chat.projectId === currentProjectId)
                ?.projectName
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
