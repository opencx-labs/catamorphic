import { type WebContents, webFrameMain } from "electron";

/**
 * `chrome.webNavigation` events from a tab's navigations (ADR 0203). Frame
 * ids follow Chrome: 0 for the main frame, the frame tree node id for
 * others, -1 for "no parent".
 */

type Emit = (
  profileId: string,
  name: string,
  details: Record<string, unknown>,
) => void;

export function frameIds(
  contents: WebContents,
  frame: Electron.WebFrameMain | null | undefined,
): { frameId: number; parentFrameId: number } {
  if (!frame || frame === contents.mainFrame)
    return { frameId: 0, parentFrameId: -1 };
  const parent = frame.parent;
  return {
    frameId: frame.frameTreeNodeId,
    parentFrameId:
      !parent || parent === contents.mainFrame ? 0 : parent.frameTreeNodeId,
  };
}

export function frameById(
  contents: WebContents,
  frameId: number,
): Electron.WebFrameMain | null {
  if (frameId === 0) return contents.mainFrame;
  return (
    contents.mainFrame.framesInSubtree.find(
      (frame) => frame.frameTreeNodeId === frameId,
    ) ?? null
  );
}

export class WebNavigationEvents {
  private readonly watched = new WeakSet<WebContents>();

  constructor(private readonly emit: Emit) {}

  watch(profileId: string, contents: WebContents, isTab: () => boolean): void {
    if (this.watched.has(contents)) return;
    this.watched.add(contents);
    const send = (
      name: string,
      frame: Electron.WebFrameMain | null | undefined,
      extra: Record<string, unknown>,
    ) => {
      if (contents.isDestroyed() || !isTab()) return;
      this.emit(profileId, name, {
        tabId: contents.id,
        processId: frame?.osProcessId ?? -1,
        ...frameIds(contents, frame),
        timeStamp: Date.now(),
        documentLifecycle: "active",
        frameType:
          !frame || frame === contents.mainFrame
            ? "outermost_frame"
            : "sub_frame",
        ...extra,
      });
    };
    const lookup = (processId: number, routingId: number) =>
      webFrameMain.fromId(processId, routingId);
    // Each frame's last committed address tells a fragment change from a
    // history.pushState.
    const committed = new Map<number, string>();
    contents.on("did-start-navigation", (details) => {
      if (details.isSameDocument) return;
      send("onBeforeNavigate", details.frame ?? null, {
        url: details.url,
        parentDocumentId: undefined,
      });
    });
    contents.on(
      "did-frame-navigate",
      (_event, url, _code, _status, _isMainFrame, processId, routingId) => {
        const frame = lookup(processId, routingId);
        committed.set(frameIds(contents, frame).frameId, url);
        send("onCommitted", frame, {
          url,
          transitionType: "link",
          transitionQualifiers: [],
        });
      },
    );
    contents.on("dom-ready", () => {
      send("onDOMContentLoaded", contents.mainFrame, {
        url: contents.getURL(),
      });
    });
    contents.on(
      "did-frame-finish-load",
      (_event, _isMainFrame, processId, routingId) => {
        const frame = lookup(processId, routingId);
        send("onCompleted", frame, { url: frame?.url ?? contents.getURL() });
      },
    );
    contents.on(
      "did-fail-load",
      (_event, code, description, url, _isMainFrame, processId, routingId) => {
        if (code === -3) return;
        send("onErrorOccurred", lookup(processId, routingId), {
          url,
          error: description || `net::ERR_${code}`,
        });
      },
    );
    contents.on(
      "did-navigate-in-page",
      (_event, url, _isMainFrame, processId, routingId) => {
        const frame = lookup(processId, routingId);
        const { frameId } = frameIds(contents, frame);
        const previous = committed.get(frameId) ?? "";
        committed.set(frameId, url);
        const fragmentOnly =
          previous.split("#")[0] === url.split("#")[0] && url.includes("#");
        send(
          fragmentOnly ? "onReferenceFragmentUpdated" : "onHistoryStateUpdated",
          frame,
          { url, transitionType: "link", transitionQualifiers: [] },
        );
      },
    );
  }
}
