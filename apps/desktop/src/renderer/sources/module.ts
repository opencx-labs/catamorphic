import type { CollectionPage } from "@catamorphic/app";
import type { ModuleAccessRequest } from "../../shared/code-access.js";
import type { WorkSourceName } from "../../shared/sidebar.js";
import type {
  SidebarSourceCapabilities,
  SidebarSourceItem,
  SidebarSourceRequest,
} from "../../shared/sidebar-source.js";
import { sidebarSourceEffect } from "../../shared/sidebar-source.js";
import { desktopApi } from "../lib/desktop-api.js";
import {
  invalidateBranches,
  type SectionSource,
  type SourceAccess,
} from "./contract.js";

/** How long a burst of changes to Work's lists waits to read a module once. */
const FOLLOW_MS = 150;

/**
 * What a module's section follows of the Work lists it reads: Work's lists
 * for a section or a palette mode, the chat's chips for a chips module.
 */
export interface ModuleWork<Name extends string = WorkSourceName> {
  watchReads: (ownerId: string, onRead: (name: Name) => void) => () => void;
  get: (name: Name) => SectionSource;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Main validated every row (sanitizeSidebarSourcePage); this reads the shape. */
const isItem = (value: unknown): value is SidebarSourceItem =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.label === "string";

/** Main's request in place of a page (ADR 0277), as main shaped it. */
function readAccess(value: unknown): ModuleAccessRequest | null {
  if (!isRecord(value) || !isRecord(value.access)) return null;
  const { module, beyond, all, network, fingerprint } = value.access;
  const lines = (list: unknown) =>
    Array.isArray(list)
      ? list.filter((line): line is string => typeof line === "string")
      : [];
  return typeof module === "string" && typeof fingerprint === "string"
    ? {
        module,
        beyond: lines(beyond),
        all: lines(all),
        network: network === true,
        fingerprint,
      }
    : null;
}

function readPage(value: unknown): CollectionPage<SidebarSourceItem> & {
  capabilities?: SidebarSourceCapabilities;
} {
  if (!isRecord(value) || !Array.isArray(value.items))
    throw new Error("Source returned no collection page.");
  const capabilities = isRecord(value.capabilities)
    ? {
        move: value.capabilities.move === true,
        drop: value.capabilities.drop === true,
        reveal: value.capabilities.reveal === true,
      }
    : undefined;
  return {
    items: value.items.filter(isItem),
    ...(typeof value.cursor === "string" ? { cursor: value.cursor } : {}),
    ...(capabilities ? { capabilities } : {}),
  };
}

const failure = (cause: unknown) =>
  cause instanceof Error ? cause : new Error(String(cause));

/**
 * A module in the project (ADR 0140), run in its Bun process by section or
 * palette mode id. What it may ask Work for is its section's grants, checked
 * in main; the window answers through `answerSourceWork`.
 */
export function moduleSource<Name extends string = WorkSourceName>({
  projectId,
  ownerId,
  title = "Items",
  empty = "No items yet.",
  onCapabilities,
  work,
}: {
  projectId: string;
  /** The section or palette mode id that names the module. */
  ownerId: string;
  title?: string;
  empty?: string;
  /** A page tells what the module exports, for the drags it accepts. */
  onCapabilities?: (capabilities: SidebarSourceCapabilities) => void;
  /** Work's lists, so a module that reads one reads again as it changes. */
  work?: ModuleWork<Name>;
}): SectionSource {
  let capabilities: SidebarSourceCapabilities = {
    move: false,
    drop: false,
    reveal: false,
  };
  /** What the module asked at its last read, until the person allows it. */
  let asking: SourceAccess | null = null;
  const request = async (
    input: Omit<SidebarSourceRequest, "projectId" | "sectionId" | "requestId">,
    signal: AbortSignal,
  ): Promise<unknown> => {
    const requestId = crypto.randomUUID();
    const cancel = () => void desktopApi.sidebarSourceCancel(requestId);
    signal.addEventListener("abort", cancel, { once: true });
    try {
      signal.throwIfAborted();
      const result = await desktopApi.sidebarSourceRequest({
        projectId,
        sectionId: ownerId,
        requestId,
        ...input,
      });
      signal.throwIfAborted();
      return result;
    } catch (cause) {
      throw failure(cause);
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  };
  return {
    title,
    empty,
    capabilities: () => capabilities,
    access: () => asking,
    load: async ({ parentId, cursor, query, session, signal }) => {
      const answer = await request(
        {
          method: "load",
          parentId,
          cursor,
          ...(query !== undefined ? { query } : {}),
          ...(session ? { session } : {}),
        },
        signal,
      );
      const wanted = readAccess(answer);
      asking = wanted
        ? {
            request: wanted,
            allow: () =>
              desktopApi.sidebarSourceAllow({
                projectId,
                sectionId: ownerId,
                fingerprint: wanted.fingerprint,
              }),
          }
        : null;
      const page = readPage(answer);
      const reported = page.capabilities;
      if (
        reported &&
        (reported.move !== capabilities.move ||
          reported.drop !== capabilities.drop ||
          reported.reveal !== capabilities.reveal)
      ) {
        capabilities = reported;
        onCapabilities?.(reported);
      }
      return {
        items: page.items,
        ...(page.cursor ? { cursor: page.cursor } : {}),
      };
    },
    subscribe: (publish, { fail, branches, session }) => {
      let released = false;
      // A module that read Work's tabs (to sort them) reads again when the
      // tabs change, and so for every list it reads.
      const following = new Map<Name, () => void>();
      let follow: ReturnType<typeof setTimeout> | undefined;
      const changed = () => {
        clearTimeout(follow);
        follow = setTimeout(
          () => invalidateBranches(publish, branches(), { quiet: true }),
          FOLLOW_MS,
        );
      };
      const stopWatching = work?.watchReads(ownerId, (name) => {
        if (following.has(name)) return;
        following.set(
          name,
          work.get(name).subscribe?.(changed, {
            ...(session ? { session } : {}),
            branches: () => [null],
            branchSize: () => 0,
            fail: () => {},
          }) ?? (() => {}),
        );
      });
      const leaseId = crypto.randomUUID();
      const unsubscribe = desktopApi.onSidebarSourceChanged((event) => {
        if (event.leaseId !== leaseId) return;
        // A failed subscription is the section's error until Retry; reading
        // again at once would restart a broken module in a loop.
        fail(event.error);
        if (!event.error) publish({ type: "invalidate" });
      });
      fail(undefined);
      void desktopApi
        .sidebarSourceSubscribe({ projectId, sectionId: ownerId, leaseId })
        .catch((cause: unknown) => {
          if (!released) fail(failure(cause).message);
        });
      return () => {
        released = true;
        clearTimeout(follow);
        stopWatching?.();
        for (const stop of following.values()) stop();
        unsubscribe();
        void desktopApi.sidebarSourceUnsubscribe(leaseId);
      };
    },
    action: async ({ itemId, action, values, session, signal }) =>
      sidebarSourceEffect(
        await request(
          {
            method: "action",
            itemId,
            action,
            ...(values ? { values } : {}),
            ...(session ? { session } : {}),
          },
          signal,
        ),
      ),
    move: async ({ itemId, parentId, beforeId, session, signal }) => {
      await request(
        {
          method: "move",
          itemId,
          parentId,
          beforeId,
          ...(session ? { session } : {}),
        },
        signal,
      );
    },
    drop: async ({ parentId, beforeId, payload, session, signal }) => {
      await request(
        {
          method: "drop",
          parentId,
          beforeId,
          payload,
          ...(session ? { session } : {}),
        },
        signal,
      );
    },
    reveal: async ({ url, after, session, signal }) => {
      if (!capabilities.reveal) return null;
      const row = await request(
        {
          method: "reveal",
          url,
          ...(after ? { after } : {}),
          ...(session ? { session } : {}),
        },
        signal,
      );
      return isItem(row) ? row : null;
    },
  };
}
