import {
  BadgeCheck,
  Check,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  LayoutGrid,
  Loader2,
  type LucideIcon,
  Plug,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  Server,
} from "lucide-react";
import {
  Fragment,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  brandPage,
  categoryLabel,
  categoryOf,
  groupByCategory,
  marketplaceLabel,
  type PluginEntry,
  pluginKey,
  pluginTitle,
  registryPublisher,
  repeatedNames,
  type ServerEntry,
  searchCatalog,
} from "../lib/connector-catalog";
import {
  type ConnectionInfo,
  type ConnectionProbe,
  desktopApi,
  type InstalledConnectorInfo,
} from "../lib/desktop-api";
import { useListMotion } from "../lib/list-motion";
import { ConnectionPermissions } from "./connection-permissions";
import { ConnectorIcon } from "./connector-icon";
import { Modal } from "./modal";
import { PendingButton } from "./pending-button";
import { ShortcutHint } from "./shortcut-hint";

/**
 * The one place connectors are managed, laid out like an app store: a
 * rail with the catalog's views and everything installed, a browse page
 * of plugins by category and MCP registry servers, and a page per
 * connector. Reachable from the palette ("Manage connectors…"), from
 * Settings, and from an agent's request_connection.
 *
 * Plugins come from the configured marketplaces as one catalog, searched
 * here as you type; the registry is a remote search, debounced, whose
 * previous rows stay put until the next ones land. Nothing ranks by
 * installs (neither source publishes counts): categories keep the
 * marketplaces' order with vendor-named entries first.
 *
 * Installing a remote server that answers 401 flows straight into OAuth:
 * the dialog steps aside while the consent page opens as a browser tab,
 * the loopback callback lands the tokens, and the dialog returns on that
 * connection's page with its tool count. The same Authorize path is
 * offered whenever a probe says the server wants a user.
 */

type Scope = "browse" | "plugins" | "servers";

const SCOPES: Record<
  Scope,
  { label: string; icon: LucideIcon; summary: string; placeholder: string }
> = {
  browse: {
    label: "Browse",
    icon: LayoutGrid,
    summary:
      "Tools your agents can use in every project, from plugin marketplaces and the MCP registry.",
    placeholder: "Search connectors",
  },
  plugins: {
    label: "Plugins",
    icon: Puzzle,
    summary:
      "Bundles of tools, skills and commands from Claude plugin marketplaces.",
    placeholder: "Search plugins",
  },
  servers: {
    label: "MCP servers",
    icon: Server,
    summary:
      "Servers from the public MCP registry. Each one adds its own tools.",
    placeholder: "Search the MCP registry",
  },
};

type Detail =
  | { kind: "plugin"; marketplace: string; name: string }
  | { kind: "server"; entry: ServerEntry }
  | { kind: "connection"; id: string };

const detailKey = (detail: Detail) =>
  detail.kind === "plugin"
    ? `plugin:${pluginKey(detail)}`
    : detail.kind === "server"
      ? `server:${detail.entry.name}`
      : `connection:${detail.id}`;

/** Codex's own computer-use runtime, offered before any catalog entry. */
const CODEX = {
  name: "codex-computer-use",
  marketplace: "Installed Codex",
  title: "Codex Computer Use",
  description:
    "Lets agents see and use the apps on this computer through your Codex installation.",
} as const;
const isCodex = (entry: { marketplace: string; name: string }) =>
  entry.marketplace === CODEX.marketplace && entry.name === CODEX.name;

/** Rows a browse section shows before "Show all". */
const PREVIEW = 6;
/** Plugin matches Browse shows before handing over to Plugins. */
const SEARCH_PREVIEW = 12;
const SKELETON_ROWS = ["a", "b", "c", "d", "e", "f"];

type Tone = "ok" | "warn" | "error" | "muted" | "busy";
const TONE_DOTS: Record<Exclude<Tone, "busy">, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  error: "bg-danger",
  muted: "bg-fg-faint",
};

const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

export function ConnectorsModal({
  open,
  onClose,
  onStepAside,
  onReturn,
  onOpenUrl,
  agentRequest,
}: {
  open: boolean;
  onClose: () => void;
  /**
   * Hide the modal WITHOUT treating it as the user closing it: an OAuth
   * consent page is about to open as a browser tab and must be visible.
   * `onReturn` shows the modal again once the flow settles.
   */
  onStepAside: () => void;
  onReturn: () => void;
  /** Open a connector's page (repo/readme) in a browser tab. */
  onOpenUrl: (url: string) => void;
  /**
   * Set while an agent's request_connection is waiting on this modal:
   * seeds the search with the agent's query (on open) and shows why the
   * agent asked. The user stays in charge of what actually installs.
   */
  agentRequest?: { query: string; reason?: string } | null;
}) {
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [installed, setInstalled] = useState<InstalledConnectorInfo[]>([]);
  // The whole plugin catalog (null until the first answer) and the
  // registry's browse list; searches narrow these.
  const [catalog, setCatalog] = useState<PluginEntry[] | null>(null);
  const [servers, setServers] = useState<ServerEntry[] | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [serverResults, setServerResults] = useState<ServerEntry[] | null>(
    null,
  );
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>("browse");
  const [category, setCategory] = useState<string | null>(null);
  // The pages opened from the current view, deepest last.
  const [trail, setTrail] = useState<Detail[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [probes, setProbes] = useState<Record<string, ConnectionProbe>>({});
  // OAuth in flight / just finished, per connection id.
  const [authFlows, setAuthFlows] = useState<
    Record<string, { status: "authorizing" | "error"; message?: string }>
  >({});
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rootScroll = useRef(0);
  const pluginListRef = useRef<HTMLUListElement>(null);
  const serverListRef = useRef<HTMLUListElement>(null);
  const trimmed = query.trim();
  const current = trail.at(-1);

  const refresh = () =>
    Promise.all([
      desktopApi.connectionsList().then(setConnections),
      desktopApi.connectorsList().then(setInstalled),
    ]).catch(() => {});
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is stable per mount
  useEffect(() => {
    if (!open) return;
    refresh();
    return desktopApi.onConnectionsChanged(setConnections);
  }, [open]);

  // Closing is the person's; stepping aside for OAuth is not. A dialog the
  // person closed opens fresh, on Browse, before its first frame.
  const closedRef = useRef(false);
  const close = () => {
    closedRef.current = true;
    onClose();
  };
  useLayoutEffect(() => {
    if (!open || !closedRef.current) return;
    closedRef.current = false;
    setTrail([]);
    setScope("browse");
    setCategory(null);
    setQuery("");
    setError(null);
    rootScroll.current = 0;
  }, [open]);

  // Land ready to type: search is the modal's main verb.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  // An agent request seeds the search ONCE per request; after that the
  // box is the user's. Re-renders, and the OAuth step-aside/return (which
  // toggles `open` without the user closing), must not clobber their
  // typing. Keyed on the request's content, so a NEW request seeds again
  // and the same one never re-seeds; no request (closed for good) forgets.
  const seededForRef = useRef<string | null>(null);
  const requestKey = agentRequest
    ? `${agentRequest.query}\u0000${agentRequest.reason ?? ""}`
    : null;
  useEffect(() => {
    if (!agentRequest) {
      seededForRef.current = null;
      return;
    }
    if (!open || seededForRef.current === requestKey) return;
    seededForRef.current = requestKey;
    setTrail([]);
    setScope("browse");
    setQuery(agentRequest.query);
  }, [open, agentRequest, requestKey]);

  // The catalog and the registry's browse list, on every open (main
  // caches both, so a reopen answers at once). What is showing stays
  // until the new lists land, and an empty answer (offline: main reports
  // a failed catalog as none) never replaces a list already shown.
  const catalogSeq = useRef(0);
  const loadCatalog = () => {
    const seq = ++catalogSeq.current;
    const fresh = () => catalogSeq.current === seq;
    const keep =
      <T,>(next: T[]) =>
      (shown: T[] | null) =>
        next.length === 0 && shown?.length ? shown : next;
    setLoadingCatalog(true);
    void Promise.all([
      desktopApi
        .connectorsSearchPlugins("")
        .catch(() => [])
        .then((list) => fresh() && setCatalog(keep(list))),
      desktopApi
        .connectorsSearchRegistry("")
        .catch(() => [])
        .then((list) => fresh() && setServers(keep(list))),
    ]).finally(() => fresh() && setLoadingCatalog(false));
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: loadCatalog is stable per mount
  useEffect(() => {
    if (open) loadCatalog();
  }, [open]);

  // The registry half of a search: a ~1s network round trip, debounced
  // 200ms. Stale answers are dropped by sequence.
  const requestSeq = useRef(0);
  useEffect(() => {
    const seq = ++requestSeq.current;
    if (!open || !trimmed) {
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(() => {
      desktopApi
        .connectorsSearchRegistry(trimmed)
        .then((entries) => {
          if (requestSeq.current === seq) setServerResults(entries);
        })
        .catch((cause) => {
          if (requestSeq.current === seq) setError(message(cause));
        })
        .finally(() => {
          if (requestSeq.current === seq) setSearching(false);
        });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [open, trimmed]);

  const probe = async (id: string): Promise<ConnectionProbe> => {
    // A stale "authorization failed" line must not outlive a fresh probe.
    setAuthFlows(({ [id]: _stale, ...rest }) => rest);
    setProbes((current) => ({ ...current, [id]: { ok: false } }));
    const result = await desktopApi.connectionsProbe(id);
    setProbes((current) => ({ ...current, [id]: result }));
    return result;
  };

  /** Show a connection's page, unless it is already the one in front. */
  const reveal = (id: string) =>
    setTrail((current) => {
      const top = current.at(-1);
      return top?.kind === "connection" && top.id === id
        ? current
        : [...current, { kind: "connection", id }];
    });

  /**
   * OAuth for one connection. The modal steps aside (the consent page
   * opens as a workspace tab, which the modal would otherwise cover),
   * main runs the flow, and the modal returns on that connection's page.
   */
  const authorize = async (id: string) => {
    setAuthFlows((current) => ({
      ...current,
      [id]: { status: "authorizing" },
    }));
    onStepAside();
    try {
      await desktopApi.connectionsAuthorize(id);
      setAuthFlows(({ [id]: _done, ...rest }) => rest);
      reveal(id);
      onReturn();
      await probe(id);
    } catch (cause) {
      setAuthFlows((current) => ({
        ...current,
        [id]: { status: "error", message: message(cause) },
      }));
      reveal(id);
      onReturn();
    }
  };

  /**
   * After an install: probe what landed, and when a remote server answers
   * "needs authorization", start OAuth right away. The user clicked
   * Install expecting a working connection, and the consent page IS the
   * next step, not an error to read.
   */
  const settleInstalled = async (connectionIds: string[]) => {
    for (const id of connectionIds) {
      const result = await probe(id);
      // One consent flow at a time: two tabs at once (and two loopback
      // listeners on the same pre-registered port) would collide.
      if (result.needsAuth) await authorize(id);
    }
  };

  /** Run one install-like action under a busy key, reporting failures. */
  const act = async (key: string, run: () => Promise<string[] | undefined>) => {
    setBusy(key);
    setError(null);
    try {
      const connectionIds = await run();
      // The row reads Installed the moment busy clears: refresh first.
      await refresh();
      if (connectionIds) void settleInstalled(connectionIds);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(null);
    }
  };
  const installRegistry = (name: string, secrets: Record<string, string>) =>
    act(name, async () => {
      const connection = await desktopApi.connectorsInstallRegistry(
        name,
        secrets,
      );
      setSecretValues({});
      return [connection.id];
    });
  const installPlugin = (marketplace: string, name: string) =>
    act(pluginKey({ marketplace, name }), async () => {
      const plugin = await desktopApi.connectorsInstallPlugin(
        marketplace,
        name,
      );
      return plugin.connectionIds;
    });
  const connectCodex = () =>
    act(pluginKey(CODEX), async () => {
      const plugin = await desktopApi.connectorsCodexComputerUse();
      return plugin.connectionIds;
    });
  const removePlugin = (name: string) =>
    act(`remove:${name}`, async () => {
      await desktopApi.connectorsRemove(name);
      return undefined;
    });
  const removeConnection = (id: string) =>
    act(`remove:${id}`, async () => {
      await desktopApi.connectionsRemove(id);
      setTrail((current) =>
        current.filter(
          (detail) => !(detail.kind === "connection" && detail.id === id),
        ),
      );
      return undefined;
    });
  // A switch moves at once; a failed change moves it back and says why.
  const setEnabled = (connection: ConnectionInfo, enabled: boolean) => {
    const apply = (value: boolean) =>
      setConnections((list) =>
        list.map((entry) =>
          entry.id === connection.id ? { ...entry, enabled: value } : entry,
        ),
      );
    apply(enabled);
    setError(null);
    desktopApi
      .connectionsUpdate(connection.id, { enabled })
      .then(refresh)
      .catch((cause) => {
        apply(!enabled);
        setError(message(cause));
      });
  };

  // "Installed" derives from the LIVE lists (connections for registry
  // servers, installed connectors for plugins), never from a search
  // answer, so install and uninstall both show at once.
  const serverConnection = (name: string) =>
    connections.find(
      (connection) =>
        connection.source.kind === "registry" &&
        connection.source.registryName === name,
    );
  const ownedPlugin = (entry: { marketplace: string; name: string }) =>
    installed.find(
      (plugin) =>
        plugin.name === entry.name && plugin.marketplace === entry.marketplace,
    );
  const catalogEntry = (entry: { marketplace: string; name: string }) =>
    catalog?.find(
      (candidate) =>
        candidate.name === entry.name &&
        candidate.marketplace === entry.marketplace,
    );

  const statusOf = (
    connection: ConnectionInfo,
  ): { tone: Tone; text: string } => {
    const flow = authFlows[connection.id];
    const probed = probes[connection.id];
    if (flow?.status === "authorizing")
      return {
        tone: "busy",
        text: "Finish signing in. The consent page opened in a tab.",
      };
    if (flow?.status === "error")
      return { tone: "error", text: flow.message ?? "Authorization failed" };
    if (connection.authorizationError)
      return { tone: "warn", text: connection.authorizationError };
    if (probed) {
      if (probed.ok) {
        const count = probed.toolCount ?? 0;
        return {
          tone: "ok",
          text: `${count} ${count === 1 ? "tool" : "tools"}${probed.protocolVersion ? ` · MCP ${probed.protocolVersion}` : ""}`,
        };
      }
      if (!probed.error) return { tone: "busy", text: "Checking…" };
      return { tone: probed.needsAuth ? "warn" : "error", text: probed.error };
    }
    if (!connection.enabled)
      return { tone: "muted", text: "Off for every agent" };
    if (connection.authorized) return { tone: "ok", text: "Signed in" };
    return { tone: "muted", text: "Not checked yet" };
  };
  const needsAttention = (id: string) => {
    const connection = connections.find((entry) => entry.id === id);
    const tone = connection ? statusOf(connection).tone : "muted";
    return tone === "warn" || tone === "error";
  };

  // Everything installed, by name: plugins (their servers live on their
  // pages) and connections that stand alone.
  const railItems = useMemo(() => {
    const plugins = installed.map((plugin) => {
      const entry = catalog?.find(
        (candidate) =>
          candidate.name === plugin.name &&
          candidate.marketplace === plugin.marketplace,
      );
      return {
        key: `plugin:${pluginKey(plugin)}`,
        detail: {
          kind: "plugin",
          marketplace: plugin.marketplace,
          name: plugin.name,
        } satisfies Detail,
        title: isCodex(plugin) ? CODEX.title : pluginTitle(entry ?? plugin),
        iconUrl: undefined,
        url: brandPage(entry?.homepage),
        kind: "plugin" as const,
        connectionIds: plugin.connectionIds,
        off: false,
      };
    });
    const standalone = connections
      .filter((connection) => connection.source.kind !== "plugin")
      .map((connection) => ({
        key: `connection:${connection.id}`,
        detail: { kind: "connection", id: connection.id } satisfies Detail,
        title: connection.name,
        iconUrl: connection.iconUrl,
        url: connection.url,
        kind: "mcp" as const,
        connectionIds: [connection.id],
        off: !connection.enabled,
      }));
    return [...plugins, ...standalone].sort((a, b) =>
      a.title.localeCompare(b.title),
    );
  }, [installed, connections, catalog]);

  const groups = useMemo(() => groupByCategory(catalog ?? []), [catalog]);
  const pluginMatches = useMemo(() => {
    const matches = searchCatalog(catalog ?? [], trimmed);
    return scope === "plugins" && category
      ? matches.filter((entry) => categoryOf(entry) === category)
      : matches;
  }, [catalog, trimmed, scope, category]);
  const serverMatches = trimmed ? (serverResults ?? []) : (servers ?? []);
  const shownPluginMatches =
    scope === "browse" ? pluginMatches.slice(0, SEARCH_PREVIEW) : pluginMatches;

  // Search results glide between sets with the palette's list motion,
  // one feel for every as-you-type list.
  const pluginMotion = useListMotion(pluginListRef, shownPluginMatches, {
    enterOnFirstPass: true,
  });
  const serverMotion = useListMotion(serverListRef, serverMatches, {
    enterOnFirstPass: true,
  });
  const motionRef = useRef([pluginMotion, serverMotion]);
  motionRef.current = [pluginMotion, serverMotion];
  useEffect(() => {
    if (!open) for (const motion of motionRef.current) motion.reset();
  }, [open]);

  // Each view is its own page: a fresh one starts at the top, and the
  // browse page comes back where it was left.
  const viewKey = current ? detailKey(current) : `${scope}:${category ?? ""}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: restores on view change only
  useLayoutEffect(() => {
    if (!current && scrollRef.current)
      scrollRef.current.scrollTop = rootScroll.current;
  }, [viewKey]);

  /** Open a page: deeper by default, or in place of the one in front. */
  const openDetail = (detail: Detail, sideways = false) => {
    if (trail.length === 0)
      rootScroll.current = scrollRef.current?.scrollTop ?? 0;
    if (detail.kind === "server") setSecretValues({});
    setError(null);
    setTrail((list) =>
      sideways && list.length > 0
        ? [...list.slice(0, -1), detail]
        : [...list, detail],
    );
  };
  const showRoot = (next: Scope, nextCategory: string | null = null) => {
    if (next !== scope || nextCategory !== category) rootScroll.current = 0;
    setScope(next);
    setCategory(nextCategory);
    setTrail([]);
    setError(null);
  };
  const openPage = (url: string) => {
    onOpenUrl(url);
    close();
  };

  const titleOf = (detail: Detail): string => {
    if (detail.kind === "plugin")
      return isCodex(detail)
        ? CODEX.title
        : pluginTitle(catalogEntry(detail) ?? detail);
    if (detail.kind === "server") return detail.entry.displayName;
    return (
      connections.find((connection) => connection.id === detail.id)?.name ??
      "Connection"
    );
  };

  // ---------------------------------------------------------------- rows

  /**
   * Plugin rows for one list; a related one (on another plugin's page)
   * swaps pages. Names the list shows twice also show their source.
   */
  const pluginRows = (entries: PluginEntry[], related = false) => {
    const shared = repeatedNames(entries.map((entry) => pluginTitle(entry)));
    return entries.map((entry) => pluginRow(entry, shared, related));
  };

  const pluginRow = (
    entry: PluginEntry,
    shared: Set<string>,
    related: boolean,
  ) => {
    const key = pluginKey(entry);
    const title = pluginTitle(entry);
    const source = shared.has(title)
      ? marketplaceLabel(entry.marketplace)
      : undefined;
    return (
      <CatalogRow
        key={`plugin:${key}`}
        id={`plugin:${key}`}
        heading={title}
        source={source}
        description={entry.description}
        icon={
          <ConnectorIcon
            size="lg"
            kind="plugin"
            name={title}
            url={brandPage(entry.homepage)}
          />
        }
        onOpen={() =>
          openDetail(
            {
              kind: "plugin",
              marketplace: entry.marketplace,
              name: entry.name,
            },
            related,
          )
        }
        action={
          <RowAction
            label="Install"
            subject={source ? `${title} from ${source}` : title}
            pending={busy === key}
            done={Boolean(ownedPlugin(entry))}
            onPress={() => void installPlugin(entry.marketplace, entry.name)}
          />
        }
      />
    );
  };

  /** Server rows for one list, named as plugin rows are. */
  const serverRows = (entries: ServerEntry[]) => {
    const shared = repeatedNames(entries.map((entry) => entry.displayName));
    return entries.map((entry) => serverRow(entry, shared));
  };

  const serverRow = (entry: ServerEntry, shared: Set<string>) => {
    const needsSetup = (entry.suggested?.inputs.length ?? 0) > 0;
    const source = shared.has(entry.displayName)
      ? registryPublisher(entry.name)
      : undefined;
    return (
      <CatalogRow
        key={`registry:${entry.name}`}
        id={`registry:${entry.name}`}
        heading={entry.displayName}
        source={source}
        description={entry.description}
        icon={
          <ConnectorIcon
            size="lg"
            name={entry.displayName}
            iconUrl={entry.iconUrl}
            url={entry.websiteUrl}
          />
        }
        onOpen={() => openDetail({ kind: "server", entry })}
        action={
          entry.suggested ? (
            <RowAction
              label={needsSetup ? "Set up" : "Install"}
              subject={
                source
                  ? `${entry.displayName} from ${source}`
                  : entry.displayName
              }
              pending={busy === entry.name}
              done={Boolean(serverConnection(entry.name))}
              onPress={() =>
                needsSetup
                  ? openDetail({ kind: "server", entry })
                  : void installRegistry(entry.name, {})
              }
            />
          ) : null
        }
      />
    );
  };

  const codexOwned = Boolean(ownedPlugin(CODEX));
  const codexRow = (
    <CatalogRow
      id="builtin:codex"
      testId="codex-computer-use"
      heading={CODEX.title}
      description={CODEX.description}
      icon={<ConnectorIcon size="lg" kind="plugin" name={CODEX.title} />}
      onOpen={() =>
        openDetail({
          kind: "plugin",
          marketplace: CODEX.marketplace,
          name: CODEX.name,
        })
      }
      action={
        <RowAction
          label={codexOwned ? "Reconnect" : "Connect"}
          subject={CODEX.title}
          icon={codexOwned ? RefreshCw : Plus}
          pending={busy === pluginKey(CODEX)}
          disabledReason={
            busy !== null && busy !== pluginKey(CODEX)
              ? "A connector is being updated"
              : undefined
          }
          onPress={() => void connectCodex()}
        />
      }
    />
  );

  // --------------------------------------------------------------- views

  const skeleton = (
    <ul
      aria-hidden="true"
      className="-mx-2.5 grid grid-cols-1 gap-x-6 @2xl:grid-cols-2"
      data-testid="connectors-skeleton"
    >
      {SKELETON_ROWS.map((row) => (
        <li key={row} className="flex items-center gap-3.5 p-2.5">
          <span className="size-10 shrink-0 animate-pulse rounded-[10px] bg-bg-overlay" />
          <span className="flex flex-1 flex-col gap-2">
            <span className="h-3 w-1/3 animate-pulse rounded bg-bg-overlay" />
            <span className="h-2.5 w-2/3 animate-pulse rounded bg-bg-overlay" />
          </span>
        </li>
      ))}
    </ul>
  );

  const unavailable = catalog !== null &&
    catalog.length === 0 &&
    !loadingCatalog && (
      <div className="flex flex-col items-start gap-3">
        <p className="text-[13px] text-fg-faint">
          The plugin marketplaces did not answer. Check your connection, then
          try again.
        </p>
        <button
          type="button"
          className="button-secondary button-sm"
          onClick={loadCatalog}
        >
          Try again
        </button>
      </div>
    );

  const browseHome = () => {
    const sections = groups.map((group) => (
      <BrowseSection
        key={group.category}
        heading={group.label}
        count={group.entries.length}
        onMore={
          group.entries.length > PREVIEW
            ? () => showRoot("plugins", group.category)
            : undefined
        }
      >
        <Grid>{pluginRows(group.entries.slice(0, PREVIEW))}</Grid>
      </BrowseSection>
    ));
    const serverSection = servers && servers.length > 0 && (
      <BrowseSection
        key="servers"
        heading="MCP servers"
        onMore={() => showRoot("servers")}
      >
        <Grid>{serverRows(servers.slice(0, PREVIEW))}</Grid>
      </BrowseSection>
    );
    return (
      <>
        <BrowseSection heading="Built in">
          <Grid>{codexRow}</Grid>
        </BrowseSection>
        {catalog === null ? (
          skeleton
        ) : (
          <>
            {sections.slice(0, 2)}
            {serverSection}
            {sections.slice(2)}
            {unavailable}
          </>
        )}
      </>
    );
  };

  const pluginsHome = () => (
    <>
      <div className="-mx-1 flex gap-1 overflow-x-auto pr-8 [mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)] [scrollbar-width:none]">
        <Pill active={!category} onPress={() => showRoot("plugins")}>
          All
        </Pill>
        {groups.map((group) => (
          <Pill
            key={group.category}
            active={category === group.category}
            onPress={() => showRoot("plugins", group.category)}
          >
            {group.label}
          </Pill>
        ))}
      </div>
      {catalog === null ? (
        skeleton
      ) : category ? (
        <Grid>
          {pluginRows(
            groups.find((group) => group.category === category)?.entries ?? [],
          )}
        </Grid>
      ) : (
        groups.map((group) => (
          <BrowseSection
            key={group.category}
            heading={group.label}
            count={group.entries.length}
          >
            <Grid>{pluginRows(group.entries)}</Grid>
          </BrowseSection>
        ))
      )}
      {unavailable}
    </>
  );

  const serversHome = () =>
    servers === null ? (
      skeleton
    ) : servers.length === 0 ? (
      <p className="text-[13px] text-fg-faint">
        The MCP registry did not answer. Check your connection, then search
        again.
      </p>
    ) : (
      <>
        <Grid>{serverRows(servers)}</Grid>
        <p className="text-[13px] text-fg-faint">
          The registry lists thousands of servers. Search to find one by name.
        </p>
      </>
    );

  const results = () => {
    const showPlugins = scope !== "servers";
    const showServers = scope !== "plugins";
    const nothing =
      (!showPlugins || pluginMatches.length === 0) &&
      (!showServers || serverMatches.length === 0) &&
      !searching;
    if (nothing)
      return (
        <p className="text-[13px] text-fg-faint">
          Nothing matches “{trimmed}”. Try a product name, like Linear or
          Postgres.
        </p>
      );
    return (
      <>
        {showPlugins && pluginMatches.length > 0 && (
          <BrowseSection
            heading={
              scope === "plugins" && category
                ? categoryLabel(category)
                : "Plugins"
            }
            count={pluginMatches.length}
            onMore={
              scope === "browse" && pluginMatches.length > SEARCH_PREVIEW
                ? () => showRoot("plugins")
                : undefined
            }
          >
            <ul ref={pluginListRef} className="-mx-2.5 flex flex-col">
              {pluginRows(shownPluginMatches)}
            </ul>
          </BrowseSection>
        )}
        {showServers && serverMatches.length > 0 && (
          <BrowseSection heading="MCP servers" count={serverMatches.length}>
            <ul ref={serverListRef} className="-mx-2.5 flex flex-col">
              {serverRows(serverMatches)}
            </ul>
          </BrowseSection>
        )}
      </>
    );
  };

  // ------------------------------------------------------------- details

  const connectionPage = (connection: ConnectionInfo, title?: string) => {
    const probed = probes[connection.id];
    const flow = authFlows[connection.id];
    const status = statusOf(connection);
    const canAuthorize =
      connection.transport !== "stdio" &&
      (probed?.needsAuth || flow?.status === "error");
    const probing = probed !== undefined && !probed.ok && !probed.error;
    const source =
      connection.source.kind === "plugin"
        ? `from ${pluginTitle({ name: connection.source.plugin })}`
        : connection.source.kind === "registry"
          ? "from the MCP registry"
          : "added by you";
    const address =
      connection.url ??
      (connection.command
        ? [connection.command, ...(connection.args ?? [])].join(" ")
        : undefined);
    const tools = connection.tools ?? [];
    return (
      <div
        className="flex flex-col gap-8"
        data-testid="connection-detail"
        data-connection-id={connection.id}
      >
        <DetailHeader
          icon={
            <ConnectorIcon
              size="xl"
              name={connection.name}
              iconUrl={connection.iconUrl}
              url={connection.url}
            />
          }
          heading={title ?? connection.name}
          byline={`MCP server · ${connection.transport} · ${source}`}
          actions={
            <>
              {connection.source.kind !== "plugin" && (
                <PendingButton
                  type="button"
                  pending={busy === `remove:${connection.id}`}
                  onClick={() => void removeConnection(connection.id)}
                  className="button-secondary"
                >
                  Remove
                </PendingButton>
              )}
              <PendingButton
                type="button"
                pending={probing}
                onClick={() => void probe(connection.id)}
                className="button-secondary"
              >
                Test
              </PendingButton>
              {canAuthorize && (
                <PendingButton
                  type="button"
                  pending={flow?.status === "authorizing"}
                  onClick={() => void authorize(connection.id)}
                  className="button-primary"
                  data-testid="connection-authorize"
                >
                  Authorize
                </PendingButton>
              )}
            </>
          }
        >
          <StatusLine
            tone={status.tone}
            text={status.text}
            testId={
              flow?.status === "authorizing"
                ? "connection-authorizing"
                : "connection-status"
            }
          />
        </DetailHeader>
        <Facts
          items={[
            address
              ? [
                  connection.url ? "Address" : "Command",
                  <span key="address" className="font-mono text-xs">
                    {address}
                  </span>,
                ]
              : null,
            ["Transport", connection.transport],
            [
              "Tools",
              tools.length > 0 ? String(tools.length) : "Not listed yet",
            ],
          ]}
        />
        <DetailSection heading="Availability">
          <label className="flex cursor-pointer items-start gap-4">
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] text-fg">
                Available to agents
              </span>
              <span className="mt-0.5 block text-xs/5 text-fg-muted">
                Installed connectors work with every agent. Narrow them per
                agent when editing it.
              </span>
            </span>
            <input
              type="checkbox"
              role="switch"
              name={`connection-enabled-${connection.id}`}
              aria-checked={connection.enabled}
              checked={connection.enabled}
              onChange={(event) => setEnabled(connection, event.target.checked)}
              data-testid="connection-enabled"
            />
          </label>
        </DetailSection>
        <DetailSection
          heading="Permissions"
          count={tools.length > 0 ? tools.length : undefined}
        >
          <ConnectionPermissions
            connection={connection}
            onProbe={() => void probe(connection.id)}
            probing={probing}
            onChange={(policy) => {
              // Optimistic: the change event refreshes the list.
              setConnections((list) =>
                list.map((entry) =>
                  entry.id === connection.id
                    ? { ...entry, toolPolicy: policy ?? undefined }
                    : entry,
                ),
              );
              void desktopApi.connectionsSetPolicy(connection.id, policy);
            }}
          />
        </DetailSection>
      </div>
    );
  };

  const pluginPage = (detail: { marketplace: string; name: string }) => {
    const codex = isCodex(detail);
    const entry = catalogEntry(detail);
    const owned = ownedPlugin(detail);
    const key = pluginKey(detail);
    const title = codex ? CODEX.title : pluginTitle(entry ?? detail);
    const description = codex
      ? CODEX.description
      : entry?.description || owned?.description;
    const page = entry?.homepage ?? entry?.pageUrl;
    const pluginServers = (owned?.connectionIds ?? []).flatMap((id) => {
      const connection = connections.find((entry) => entry.id === id);
      return connection ? [connection] : [];
    });
    // Neighbours from the same shelf, so a page leads somewhere.
    const related = entry
      ? (
          groups.find((group) => group.category === categoryOf(entry))
            ?.entries ?? []
        )
          .filter((other) => pluginKey(other) !== key)
          .slice(0, 4)
      : [];
    const byline = codex
      ? "From your Codex installation"
      : entry?.author
        ? `By ${entry.author}`
        : `From ${marketplaceLabel(detail.marketplace)}`;
    return (
      <div className="flex flex-col gap-8" data-testid="plugin-detail">
        <DetailHeader
          icon={
            <ConnectorIcon
              size="xl"
              kind="plugin"
              name={title}
              url={brandPage(entry?.homepage)}
            />
          }
          heading={title}
          byline={byline}
          badges={
            <>
              {owned && <Badge icon={Check}>Installed</Badge>}
              {entry?.official && <Badge icon={BadgeCheck}>Official</Badge>}
            </>
          }
          actions={
            <>
              {page && <PageButton url={page} onOpen={openPage} />}
              {owned && (
                <PendingButton
                  type="button"
                  pending={busy === `remove:${detail.name}`}
                  onClick={() => void removePlugin(detail.name)}
                  className="button-secondary"
                >
                  Remove
                </PendingButton>
              )}
              {codex ? (
                <PendingButton
                  type="button"
                  pending={busy === key}
                  onClick={() => void connectCodex()}
                  className="button-primary"
                >
                  {owned ? "Reconnect" : "Connect"}
                </PendingButton>
              ) : (
                !owned && (
                  <PendingButton
                    type="button"
                    pending={busy === key}
                    onClick={() =>
                      void installPlugin(detail.marketplace, detail.name)
                    }
                    className="button-primary"
                    data-testid="plugin-install"
                  >
                    Install
                  </PendingButton>
                )
              )}
            </>
          }
        />
        {description && (
          <p className="max-w-[68ch] text-[13px]/6 text-pretty text-fg">
            {description}
          </p>
        )}
        <Facts
          items={[
            entry?.category
              ? ["Category", categoryLabel(entry.category)]
              : null,
            entry?.author ? ["Publisher", entry.author] : null,
            entry?.version || owned?.version
              ? ["Version", entry?.version ?? owned?.version ?? ""]
              : null,
            [
              "Source",
              codex
                ? "Your Codex installation"
                : marketplaceLabel(detail.marketplace),
            ],
          ]}
        />
        {owned && (
          <DetailSection
            heading="MCP servers"
            count={pluginServers.length}
            testId="plugin-connections"
          >
            {pluginServers.length === 0 ? (
              <p className="text-[13px] text-fg-faint">
                This plugin adds no MCP servers.
              </p>
            ) : (
              <ul className="-mx-2.5 flex flex-col">
                {pluginServers.map((connection) => {
                  const status = statusOf(connection);
                  return (
                    <li
                      key={connection.id}
                      className="relative flex items-center gap-3.5 rounded-xl p-2.5 hover:bg-bg-overlay/60"
                    >
                      <button
                        type="button"
                        aria-label={connection.name}
                        onClick={() =>
                          openDetail({ kind: "connection", id: connection.id })
                        }
                        className="focus-ring-inset absolute inset-0 cursor-pointer rounded-xl"
                      />
                      <ConnectorIcon
                        size="lg"
                        name={connection.name}
                        iconUrl={connection.iconUrl}
                        url={connection.url}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-fg">
                          {connection.name}
                        </p>
                        <StatusLine tone={status.tone} text={status.text} />
                      </div>
                      <ChevronRight
                        className="size-4 shrink-0 text-fg-faint"
                        aria-hidden="true"
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </DetailSection>
        )}
        {related.length > 0 && entry && (
          <DetailSection
            heading={`More in ${categoryLabel(categoryOf(entry))}`}
          >
            <Grid>{pluginRows(related, true)}</Grid>
          </DetailSection>
        )}
      </div>
    );
  };

  const serverPage = (entry: ServerEntry) => {
    const connection = serverConnection(entry.name);
    if (connection) return connectionPage(connection, entry.displayName);
    const inputs = entry.suggested?.inputs ?? [];
    const page = entry.websiteUrl ?? entry.repositoryUrl;
    const missing = inputs.some(
      (input) => input.required && !secretValues[input.name]?.trim(),
    );
    const install = (
      <PendingButton
        type="button"
        pending={busy === entry.name}
        disabled={missing}
        data-disabled-reason="Fill in the required values first"
        onClick={() => void installRegistry(entry.name, secretValues)}
        className="button-primary"
        data-testid="server-install"
      >
        Install
      </PendingButton>
    );
    return (
      <div className="flex flex-col gap-8" data-testid="server-detail">
        <DetailHeader
          icon={
            <ConnectorIcon
              size="xl"
              name={entry.displayName}
              iconUrl={entry.iconUrl}
              url={entry.websiteUrl}
            />
          }
          heading={entry.displayName}
          byline="From the MCP registry"
          actions={
            <>
              {page && <PageButton url={page} onOpen={openPage} />}
              {entry.suggested && inputs.length === 0 && install}
            </>
          }
        />
        {entry.description && (
          <p className="max-w-[68ch] text-[13px]/6 text-pretty text-fg">
            {entry.description}
          </p>
        )}
        <Facts
          items={[
            ["Connects over", entry.suggested?.transport ?? "Set up by hand"],
            entry.version ? ["Version", entry.version] : null,
            [
              "Registry name",
              <span key="name" className="font-mono text-xs">
                {entry.name}
              </span>,
            ],
          ]}
        />
        {!entry.suggested && (
          <p className="text-[13px] text-fg-faint">
            Work cannot run this server by itself. Its page explains how to set
            it up.
          </p>
        )}
        {entry.suggested && inputs.length > 0 && (
          <DetailSection heading="Setup">
            <p className="text-xs/5 text-fg-muted">
              This server needs these values before it can connect. They stay on
              this computer.
            </p>
            <div className="flex max-w-md flex-col gap-3">
              {inputs.map((input) => (
                <label
                  key={input.name}
                  className="flex flex-col gap-1 text-xs text-fg-muted"
                >
                  <span className="font-mono text-fg">
                    {input.name}
                    {input.required ? "" : " (optional)"}
                  </span>
                  <input
                    type={input.secret ? "password" : "text"}
                    name={input.name}
                    value={secretValues[input.name] ?? ""}
                    onChange={(event) =>
                      setSecretValues((values) => ({
                        ...values,
                        [input.name]: event.target.value,
                      }))
                    }
                    placeholder={input.description}
                    className="field h-8 px-2.5 font-mono text-xs text-fg placeholder:font-sans placeholder:text-fg-faint"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
              ))}
            </div>
            <div>{install}</div>
          </DetailSection>
        )}
      </div>
    );
  };

  const detailPage = (detail: Detail) => {
    if (detail.kind === "plugin") return pluginPage(detail);
    if (detail.kind === "server") return serverPage(detail.entry);
    const connection = connections.find((entry) => entry.id === detail.id);
    return connection ? (
      connectionPage(connection)
    ) : (
      <p className="text-[13px] text-fg-faint">This connection was removed.</p>
    );
  };

  // -------------------------------------------------------------- layout

  return (
    <Modal
      open={open}
      onClose={close}
      width={1040}
      labelledBy="connectors-title"
    >
      <div className="flex h-[min(720px,calc(100dvh-96px))] min-h-0">
        <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-bg">
          <h2
            id="connectors-title"
            className="px-5 pt-5 pb-4 text-[15px] font-semibold text-fg"
          >
            Connectors
          </h2>
          <nav aria-label="Catalog" className="flex flex-col gap-0.5 px-3">
            {(Object.keys(SCOPES) as Scope[]).map((key) => {
              const Icon = SCOPES[key].icon;
              return (
                <RailButton
                  key={key}
                  active={!current && scope === key}
                  onPress={() => showRoot(key)}
                  icon={<Icon className="size-4 shrink-0" aria-hidden="true" />}
                >
                  {SCOPES[key].label}
                </RailButton>
              );
            })}
          </nav>
          <p
            id="connectors-installed"
            className="mt-6 px-5 pb-1.5 text-xs text-fg-faint"
          >
            Installed
          </p>
          <ul
            aria-labelledby="connectors-installed"
            className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-3 pb-4"
            data-testid="installed-section"
          >
            {railItems.map((item) => {
              const authorizing = item.connectionIds.some(
                (id) => authFlows[id]?.status === "authorizing",
              );
              const attention = item.connectionIds.some(needsAttention);
              return (
                <li key={item.key}>
                  <RailButton
                    active={
                      current !== undefined &&
                      detailKey(current) === detailKey(item.detail)
                    }
                    onPress={() => {
                      if (trail.length === 0)
                        rootScroll.current = scrollRef.current?.scrollTop ?? 0;
                      setError(null);
                      setTrail([item.detail]);
                    }}
                    icon={
                      <ConnectorIcon
                        size="sm"
                        kind={item.kind}
                        name={item.title}
                        iconUrl={item.iconUrl}
                        url={item.url}
                      />
                    }
                    testId="installed-item"
                    connectionId={
                      item.detail.kind === "connection"
                        ? item.detail.id
                        : undefined
                    }
                    trailing={
                      authorizing ? (
                        <Loader2
                          className="size-3.5 shrink-0 animate-spin text-fg-faint"
                          aria-label="Signing in"
                        />
                      ) : attention ? (
                        <span
                          className="size-1.5 shrink-0 rounded-full bg-warning"
                          role="img"
                          aria-label="Needs attention"
                        />
                      ) : item.off ? (
                        <span className="shrink-0 text-[11px] text-fg-faint">
                          Off
                        </span>
                      ) : null
                    }
                  >
                    {item.title}
                  </RailButton>
                </li>
              );
            })}
            {railItems.length === 0 && (
              <li className="px-2 py-1.5 text-xs text-fg-faint">
                Nothing installed yet.
              </li>
            )}
          </ul>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-16 shrink-0 items-center gap-4 px-8">
            <div className="min-w-0 flex-1">
              {current ? (
                <nav
                  aria-label="Location"
                  className="flex min-w-0 items-center gap-1.5 text-[13px]"
                >
                  <button
                    type="button"
                    onClick={() => setTrail([])}
                    className="shrink-0 cursor-pointer rounded text-fg-muted hover:text-fg"
                  >
                    {SCOPES[scope].label}
                  </button>
                  {trail.map((detail, index) => (
                    <Fragment key={detailKey(detail)}>
                      <ChevronRight
                        className="size-3.5 shrink-0 text-fg-faint"
                        aria-hidden="true"
                      />
                      {index === trail.length - 1 ? (
                        <span aria-current="page" className="truncate text-fg">
                          {titleOf(detail)}
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setTrail(trail.slice(0, index + 1))}
                          className="min-w-0 cursor-pointer truncate rounded text-fg-muted hover:text-fg"
                        >
                          {titleOf(detail)}
                        </button>
                      )}
                    </Fragment>
                  ))}
                </nav>
              ) : (
                <h3 className="truncate text-xl font-semibold tracking-tight text-fg">
                  {SCOPES[scope].label}
                </h3>
              )}
            </div>
            <div className="relative w-64 shrink-0">
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-faint"
                aria-hidden="true"
              />
              <input
                ref={inputRef}
                name="connectors-search"
                aria-label={SCOPES[scope].placeholder}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setTrail([]);
                  rootScroll.current = 0;
                  if (scrollRef.current) scrollRef.current.scrollTop = 0;
                }}
                placeholder={SCOPES[scope].placeholder}
                className="field h-8 w-full rounded-full pr-8 pl-9 text-[13px] text-fg placeholder:text-fg-faint"
                data-testid="connectors-search"
                spellCheck={false}
                autoComplete="off"
              />
              {/* Remote search: a quiet spinner says "still looking" while
                  the previous results stay put, no blank flash between sets. */}
              <Loader2
                className={`pointer-events-none absolute top-1/2 right-3 size-3.5 -translate-y-1/2 text-fg-faint transition-opacity duration-150 ${
                  searching ? "animate-spin opacity-100" : "opacity-0"
                }`}
                aria-hidden={!searching}
                data-testid="connectors-searching"
              />
            </div>
          </div>

          {(agentRequest || error) && (
            <div className="flex shrink-0 flex-col gap-2 px-8 pb-4">
              {agentRequest && (
                <div
                  className="flex items-start gap-3 rounded-xl bg-bg-inset px-4 py-3 text-[13px]/5"
                  data-testid="agent-connection-request"
                >
                  <Plug
                    className="h-lh size-4 shrink-0 text-accent"
                    aria-hidden="true"
                  />
                  <p className="min-w-0 text-pretty">
                    <span className="font-medium text-fg">
                      Your agent asks to connect “{agentRequest.query}”.
                    </span>{" "}
                    <span className="text-fg-muted">
                      {agentRequest.reason ??
                        "Install it to let the agent continue, or close Connectors to decline."}
                    </span>
                  </p>
                </div>
              )}
              {error && (
                <p
                  role="alert"
                  className="flex items-start gap-2 rounded-xl bg-bg-inset px-4 py-3 text-[13px]/5 text-fg-muted"
                >
                  <CircleAlert
                    className="h-lh size-4 shrink-0 text-danger"
                    aria-hidden="true"
                  />
                  <span className="min-w-0">{error}</span>
                </p>
              )}
            </div>
          )}

          <div
            key={viewKey}
            ref={scrollRef}
            className="@container min-h-0 flex-1 animate-fade-in overflow-y-auto px-8 pb-10"
          >
            {current ? (
              detailPage(current)
            ) : (
              <div className="flex flex-col gap-8">
                <p className="max-w-[68ch] text-[13px] text-pretty text-fg-muted">
                  {SCOPES[scope].summary}
                </p>
                {trimmed
                  ? results()
                  : scope === "browse"
                    ? browseHome()
                    : scope === "plugins"
                      ? pluginsHome()
                      : serversHome()}
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ primitives

function RailButton({
  active,
  onPress,
  icon,
  trailing,
  testId,
  connectionId,
  children,
}: {
  active: boolean;
  onPress: () => void;
  icon: ReactNode;
  trailing?: ReactNode;
  testId?: string;
  connectionId?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      aria-current={active ? "page" : undefined}
      data-testid={testId}
      data-connection-id={connectionId}
      className={`focus-ring-inset flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-md px-2 text-left text-[13px] transition-colors duration-150 ${
        active
          ? "bg-bg-overlay text-fg"
          : "text-fg-muted hover:bg-bg-overlay/60 hover:text-fg"
      }`}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </button>
  );
}

function Pill({
  active,
  onPress,
  children,
}: {
  active: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onPress}
      className={`h-8 shrink-0 cursor-pointer rounded-full px-3.5 text-[13px] transition-colors duration-150 ${
        active ? "bg-bg-overlay text-fg" : "text-fg-muted hover:text-fg"
      }`}
    >
      {children}
    </button>
  );
}

function Grid({ children }: { children: ReactNode }) {
  return (
    <ul className="-mx-2.5 grid grid-cols-1 gap-x-6 @2xl:grid-cols-2">
      {children}
    </ul>
  );
}

/** A browse shelf: its title opens everything in it when there is more. */
function BrowseSection({
  heading,
  count,
  onMore,
  children,
}: {
  heading: string;
  count?: number;
  onMore?: () => void;
  children: ReactNode;
}) {
  const label = (
    <>
      {heading}
      {count !== undefined && (
        <span className="font-normal text-fg-faint tabular-nums">{count}</span>
      )}
    </>
  );
  return (
    <section className="flex flex-col gap-2">
      {onMore ? (
        <h4 className="text-[15px] font-semibold text-fg">
          <button
            type="button"
            onClick={onMore}
            className="group flex cursor-pointer items-center gap-1.5 rounded"
          >
            {label}
            <ChevronRight
              className="size-4 shrink-0 text-fg-faint group-hover:text-fg-muted"
              aria-hidden="true"
            />
          </button>
        </h4>
      ) : (
        <h4 className="flex items-center gap-1.5 text-[15px] font-semibold text-fg">
          {label}
        </h4>
      )}
      {children}
    </section>
  );
}

/**
 * One catalog entry: the whole row opens its page, and its one action
 * (install, set up, connect) sits above that at the far end. `source`
 * tells apart entries that go by the same name.
 */
function CatalogRow({
  id,
  testId,
  heading,
  source,
  description,
  icon,
  onOpen,
  action,
}: {
  id: string;
  testId?: string;
  heading: string;
  source?: string;
  description: string;
  icon: ReactNode;
  onOpen: () => void;
  action: ReactNode;
}) {
  return (
    <li
      data-item-id={id}
      data-testid={testId}
      className="relative flex items-center gap-3.5 rounded-xl p-2.5 hover:bg-bg-overlay/60"
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={source ? `${heading} from ${source}` : heading}
        className="focus-ring-inset absolute inset-0 cursor-pointer rounded-xl"
      />
      {icon}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-fg">
          {heading}
          {source && (
            <span className="font-normal text-fg-faint"> · {source}</span>
          )}
        </p>
        <p className="truncate text-[13px] text-fg-muted">
          {description || "No description."}
        </p>
      </div>
      {action && <div className="relative flex shrink-0">{action}</div>}
    </li>
  );
}

/** A row's quiet round action: + until done, then a check. */
function RowAction({
  label,
  subject,
  icon: Icon = Plus,
  pending,
  done = false,
  disabledReason,
  onPress,
}: {
  label: string;
  subject: string;
  icon?: LucideIcon;
  pending: boolean;
  done?: boolean;
  disabledReason?: string;
  onPress: () => void;
}) {
  return (
    <ShortcutHint label={label}>
      <PendingButton
        type="button"
        pending={pending}
        done={done}
        doneLabel={
          <Check className="size-4" strokeWidth={1.75} aria-label="Installed" />
        }
        disabled={disabledReason !== undefined}
        data-disabled-reason={disabledReason}
        onClick={onPress}
        aria-label={`${label} ${subject}`}
        className="grid size-8 cursor-pointer place-items-center rounded-full text-fg-muted transition-colors duration-150 hover:bg-fg/8 hover:text-fg disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-fg-muted"
      >
        <Icon className="size-4" strokeWidth={1.75} aria-hidden="true" />
      </PendingButton>
    </ShortcutHint>
  );
}

function PageButton({
  url,
  onOpen,
}: {
  url: string;
  onOpen: (url: string) => void;
}) {
  return (
    <ShortcutHint label="Open page">
      <button
        type="button"
        onClick={() => onOpen(url)}
        aria-label="Open page"
        className="grid size-8 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
      >
        <ExternalLink className="size-4" aria-hidden="true" />
      </button>
    </ShortcutHint>
  );
}

function Badge({
  icon: Icon,
  children,
}: {
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <span className="flex shrink-0 items-center gap-1 rounded-full bg-bg-overlay py-0.5 pr-2 pl-1.5 text-[11px] text-fg-muted">
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      {children}
    </span>
  );
}

function DetailHeader({
  icon,
  heading,
  byline,
  badges,
  actions,
  children,
}: {
  icon: ReactNode;
  heading: string;
  byline: string;
  badges?: ReactNode;
  actions: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 pt-2">
      {icon}
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-xl font-semibold tracking-tight text-balance text-fg">
            {heading}
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <p className="text-[13px] text-fg-muted">{byline}</p>
            {badges}
          </div>
          {children}
        </div>
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      </div>
    </div>
  );
}

function StatusLine({
  tone,
  text,
  testId,
}: {
  tone: Tone;
  text: string;
  testId?: string;
}) {
  return (
    <p
      className="mt-2 flex items-center gap-2 text-[13px] text-fg-muted"
      data-testid={testId}
    >
      {tone === "busy" ? (
        <Loader2
          className="size-3.5 shrink-0 animate-spin text-fg-faint"
          aria-hidden="true"
        />
      ) : (
        <span
          className={`size-1.5 shrink-0 rounded-full ${TONE_DOTS[tone]}`}
          aria-hidden="true"
        />
      )}
      <span className="min-w-0 truncate">{text}</span>
    </p>
  );
}

function Facts({ items }: { items: Array<[string, ReactNode] | null> }) {
  const shown = items.filter(
    (item): item is [string, ReactNode] => item !== null,
  );
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-4 border-y border-border py-4 @2xl:grid-cols-4">
      {shown.map(([term, value]) => (
        <div key={term} className="min-w-0">
          <dt className="text-xs text-fg-faint">{term}</dt>
          <dd className="mt-1 truncate text-[13px] text-fg">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function DetailSection({
  heading,
  count,
  testId,
  children,
}: {
  heading: string;
  count?: number;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3" data-testid={testId}>
      <h4 className="flex items-center gap-1.5 text-[15px] font-semibold text-fg">
        {heading}
        {count !== undefined && (
          <span className="font-normal text-fg-faint tabular-nums">
            {count}
          </span>
        )}
      </h4>
      {children}
    </section>
  );
}
