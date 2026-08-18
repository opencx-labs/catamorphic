import {
  BadgeCheck,
  ExternalLink,
  Loader2,
  Plug,
  Puzzle,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type ConnectionInfo,
  type ConnectionProbe,
  type ConnectorSearchData,
  desktopApi,
  type InstalledConnectorInfo,
  type McpToolPolicy,
  type ToolPermission,
} from "../lib/desktop-api";
import { useListMotion } from "../lib/list-motion";
import {
  describePolicy,
  PERMISSION_LABELS,
  resolveAcross,
} from "../lib/tool-policy";
import { Modal } from "./modal";
import { PendingButton } from "./pending-button";
import { Segmented } from "./segmented";

/**
 * The one place connectors are managed: what's installed (profile MCP
 * connections and plugin connectors) plus a live search over the two open
 * ecosystems — the MCP registry and Claude Code / Cowork plugin
 * marketplaces. Reachable from the palette ("Manage connectors…") and from
 * Settings.
 *
 * Search runs as you type (debounced), and results put official
 * publications first — a DNS-verified vendor namespace on the registry
 * side, an Anthropic-maintained marketplace on the plugin side — since the
 * registry API exposes no install counts to rank by.
 *
 * Installing a remote server that answers 401 flows straight into OAuth:
 * the consent page opens as a browser tab, the loopback callback lands the
 * tokens on the connection, and the row reports the tool count. The same
 * "Authorize" path is offered whenever a probe says the server wants a
 * user (first time, or after tokens expire).
 */
const SKELETON_ROWS = ["a", "b", "c", "d", "e", "f"];

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
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ConnectorSearchData | null>(null);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [probes, setProbes] = useState<Record<string, ConnectionProbe>>({});
  // Which connection's permission editor is expanded.
  const [permissionsFor, setPermissionsFor] = useState<string | null>(null);
  // OAuth in flight / just finished, per connection id.
  const [authFlows, setAuthFlows] = useState<
    Record<string, { status: "authorizing" | "error"; message?: string }>
  >({});
  // Registry entries that need secrets before install expand a small form.
  const [secretsFor, setSecretsFor] = useState<string | null>(null);
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

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

  // Land ready to type — search is the modal's main verb.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  // An agent request seeds the search ONCE per request — after that the
  // box is the user's; re-renders, and the OAuth step-aside/return (which
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
    setQuery(agentRequest.query);
  }, [open, agentRequest, requestKey]);

  // Live search in two halves, each landing on its own: plugins answer
  // from cached marketplaces on every keystroke (no debounce — it's a
  // local filter), the registry is a ~1s network search debounced 200ms.
  // Stale responses are dropped by sequence; the previous rows stay put
  // until the new ones arrive, so typing never blanks the list. An empty
  // query still lists the browsable defaults once the modal opens.
  const requestSeq = useRef(0);
  useEffect(() => {
    if (!open) return;
    const seq = ++requestSeq.current;
    setSearching(true);
    let pluginsDone = false;
    let registryDone = false;
    const settle = () => {
      if (pluginsDone && registryDone && requestSeq.current === seq) {
        setSearching(false);
      }
    };
    void desktopApi
      .connectorsSearchPlugins(query)
      .then((plugins) => {
        if (requestSeq.current !== seq) return;
        setResults((current) => ({
          registry: current?.registry ?? [],
          plugins,
        }));
      })
      .catch(() => {})
      .finally(() => {
        pluginsDone = true;
        settle();
      });
    const timer = window.setTimeout(() => {
      desktopApi
        .connectorsSearchRegistry(query)
        .then((registry) => {
          if (requestSeq.current !== seq) return;
          setResults((current) => ({
            plugins: current?.plugins ?? [],
            registry,
          }));
          setError(null);
        })
        .catch((cause) => {
          if (requestSeq.current !== seq) return;
          setError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => {
          registryDone = true;
          settle();
        });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [open, query]);

  const probe = async (id: string): Promise<ConnectionProbe> => {
    // A stale "authorization failed" line must not outlive a fresh probe.
    setAuthFlows(({ [id]: _stale, ...rest }) => rest);
    setProbes((current) => ({ ...current, [id]: { ok: false } }));
    const result = await desktopApi.connectionsProbe(id);
    setProbes((current) => ({ ...current, [id]: result }));
    return result;
  };

  /**
   * OAuth for one connection. The modal steps aside (the consent page
   * opens as a workspace tab, which the modal would otherwise cover),
   * main runs the flow, and the modal returns with the verdict.
   */
  const authorize = async (id: string) => {
    setAuthFlows((current) => ({
      ...current,
      [id]: { status: "authorizing" },
    }));
    onStepAside();
    // Back in view, land on the row that just changed.
    const reveal = () =>
      requestAnimationFrame(() =>
        document
          .querySelector(`[data-connection-id="${id}"]`)
          ?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
      );
    try {
      await desktopApi.connectionsAuthorize(id);
      setAuthFlows(({ [id]: _done, ...rest }) => rest);
      onReturn();
      reveal();
      await probe(id);
    } catch (cause) {
      setAuthFlows((current) => ({
        ...current,
        [id]: {
          status: "error",
          message: cause instanceof Error ? cause.message : String(cause),
        },
      }));
      onReturn();
      reveal();
    }
  };

  /**
   * After an install: probe what landed, and when a remote server answers
   * "needs authorization", start OAuth right away — the user clicked
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

  const installRegistry = async (
    name: string,
    secrets: Record<string, string>,
  ) => {
    setBusy(name);
    setError(null);
    try {
      const connection = await desktopApi.connectorsInstallRegistry(
        name,
        secrets,
      );
      setSecretsFor(null);
      setSecretValues({});
      // The row reads Installed the moment busy clears: refresh first.
      await refresh();
      void settleInstalled([connection.id]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const installPlugin = async (marketplace: string, name: string) => {
    const key = `${marketplace}#${name}`;
    setBusy(key);
    setError(null);
    try {
      const installed = await desktopApi.connectorsInstallPlugin(
        marketplace,
        name,
      );
      await refresh();
      void settleInstalled(installed.connectionIds);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  // "Installed" markers derive from the LIVE lists (connections for
  // registry servers, installed connectors for plugins), never from the
  // search response — so install and uninstall both reflect immediately.
  const registryInstalled = (name: string) =>
    connections.some(
      (connection) =>
        connection.source.kind === "registry" &&
        connection.source.registryName === name,
    );
  const pluginInstalled = (marketplace: string, name: string) =>
    installed.some(
      (connector) =>
        connector.name === name && connector.marketplace === marketplace,
    );

  // One merged result list, officials first (no install counts exist to
  // rank by), each kind keeping its own row rendering. Rows glide/fade
  // between result sets with the palette's list motion — one feel for
  // every as-you-type list.
  const rows = useMemo(() => {
    if (!results) return [];
    // Plugins first (Anthropic's official marketplace at the very top),
    // then MCP registry servers; alphabetical inside each band.
    const merged = [
      ...results.plugins.map((entry) => ({
        sort: entry.official ? 0 : 1,
        label: entry.name,
        node: "plugin" as const,
        entry,
      })),
      ...results.registry.map((entry) => ({
        sort: 2,
        label: entry.displayName,
        node: "registry" as const,
        entry,
      })),
    ];
    return merged.sort(
      (a, b) => a.sort - b.sort || a.label.localeCompare(b.label),
    );
  }, [results]);
  const listMotion = useListMotion(listRef, rows, { enterOnFirstPass: true });
  const listMotionRef = useRef(listMotion);
  listMotionRef.current = listMotion;
  useEffect(() => {
    if (!open) listMotionRef.current.reset();
  }, [open]);

  const pageButton = (url: string | undefined, name: string) =>
    url ? (
      <button
        type="button"
        onClick={() => {
          onOpenUrl(url);
          onClose();
        }}
        className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md border border-border text-fg-muted hover:bg-bg-overlay hover:text-fg"
        aria-label={`Open ${name}'s page`}
        title="Open page"
      >
        <ExternalLink className="size-3.5" />
      </button>
    ) : null;

  const officialBadge = (
    <span
      className="flex shrink-0 items-center gap-0.5 rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent"
      title="Published by the vendor or Anthropic"
    >
      <BadgeCheck className="size-3" />
      Official
    </span>
  );

  return (
    <Modal open={open} onClose={onClose} width={620}>
      {/* Fixed height: the panel is the same size before and after the
          first results land, so opening never jumps mid-enter. */}
      <div className="flex h-[min(640px,80vh)] flex-col p-4">
        <h2 className="text-sm font-semibold">Connectors</h2>
        <p className="mb-3 mt-0.5 text-xs text-fg-muted">
          Tools your agents can use — MCP servers and Claude Code plugins.
          Installed connectors work with every agent; assign them per agent when
          editing it.
        </p>

        {agentRequest && (
          <div
            className="mb-3 flex items-start gap-2 rounded-md border border-accent/40 bg-accent/10 px-2.5 py-2 text-xs"
            data-testid="agent-connection-request"
          >
            <Plug className="mt-0.5 size-3.5 shrink-0 text-accent" />
            <div className="min-w-0">
              <span className="font-medium text-fg">
                Your agent asks to connect “{agentRequest.query}”.
              </span>{" "}
              <span className="text-fg-muted">
                {agentRequest.reason ??
                  "Install it below to let the agent continue, or just close this."}
              </span>
            </div>
          </div>
        )}

        <div className="relative mb-3 shrink-0">
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search the MCP registry and plugin marketplaces…"
            className="field h-8 w-full px-2 pr-8 text-[13px] text-fg placeholder:text-fg-faint"
            data-testid="connectors-search"
            spellCheck={false}
          />
          {/* Remote search: a quiet spinner says "still looking" while the
              previous results stay put — no blank flash between sets. */}
          <Loader2
            className={`pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-fg-faint transition-opacity duration-150 ${
              searching ? "opacity-100" : "opacity-0"
            }`}
            aria-hidden={!searching}
            data-testid="connectors-searching"
          />
        </div>

        {error && <p className="mb-2 text-xs text-danger">{error}</p>}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* First load: skeleton rows hold the shape the results will
              take, so the panel opens looking like itself instead of a
              void that fills in later. */}
          {!results && searching && (
            <div
              className="mb-4 flex flex-col gap-1.5"
              aria-hidden
              data-testid="connectors-skeleton"
            >
              {SKELETON_ROWS.map((row) => (
                <div
                  key={row}
                  className="flex h-[54px] animate-pulse items-center gap-2 rounded-md border border-border bg-bg-raised/40 px-2.5"
                >
                  <span className="size-6 rounded bg-bg-overlay" />
                  <span className="flex flex-1 flex-col gap-1.5">
                    <span className="h-2.5 w-1/3 rounded bg-bg-overlay" />
                    <span className="h-2 w-2/3 rounded bg-bg-overlay" />
                  </span>
                  <span className="h-7 w-16 rounded-md bg-bg-overlay" />
                </div>
              ))}
            </div>
          )}
          {/* What's already installed comes first — it's what the user
              acts on most (Test, Authorize, remove); search sits below. */}
          {(connections.length > 0 || installed.length > 0) &&
            !query.trim() && (
              <div
                className="mb-4 flex flex-col gap-1.5"
                data-testid="installed-section"
              >
                <h3 className="text-xs font-medium text-fg-muted">Installed</h3>
                {connections.map((connection) => {
                  const probeResult = probes[connection.id];
                  const authFlow = authFlows[connection.id];
                  const canAuthorize =
                    connection.transport !== "stdio" &&
                    (probeResult?.needsAuth || authFlow?.status === "error");
                  const permissionsOpen = permissionsFor === connection.id;
                  return (
                    <div
                      key={connection.id}
                      className="rounded-md border border-border bg-bg-raised/40 px-2.5 py-1.5"
                      data-testid="connection-row"
                      data-connection-id={connection.id}
                    >
                      <div className="flex items-center gap-2">
                        <ConnectorIcon
                          iconUrl={connection.iconUrl}
                          name={connection.name}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-2">
                            <span className="truncate text-[13px]">
                              {connection.name}
                            </span>
                            <span className="shrink-0 text-[11px] text-fg-faint">
                              MCP · {connection.transport}
                              {connection.source.kind === "plugin"
                                ? ` · from ${connection.source.plugin}`
                                : connection.source.kind === "registry"
                                  ? " · registry"
                                  : ""}
                            </span>
                          </div>
                          {authFlow?.status === "authorizing" ? (
                            <p
                              className="flex items-center gap-1 truncate text-[11px] text-fg-muted"
                              data-testid="connection-authorizing"
                            >
                              <Loader2 className="size-3 shrink-0 animate-spin" />
                              Finish signing in — the consent page opened in a
                              tab
                            </p>
                          ) : authFlow?.status === "error" ? (
                            <p className="truncate text-[11px] text-danger">
                              {authFlow.message ?? "Authorization failed"}
                            </p>
                          ) : probeResult ? (
                            <p
                              className={`truncate text-[11px] ${probeResult.ok ? "text-fg-muted" : probeResult.needsAuth ? "text-warning" : probeResult.error ? "text-danger" : "text-fg-faint"}`}
                            >
                              {probeResult.ok
                                ? `${probeResult.toolCount} tools${probeResult.protocolVersion ? ` · MCP ${probeResult.protocolVersion}` : ""}`
                                : (probeResult.error ?? "Checking…")}
                            </p>
                          ) : connection.authorized ? (
                            <p className="flex items-center gap-1 truncate text-[11px] text-fg-faint">
                              <ShieldCheck className="size-3 shrink-0" />
                              Authorized
                            </p>
                          ) : null}
                        </div>
                        {canAuthorize && (
                          <button
                            type="button"
                            onClick={() => void authorize(connection.id)}
                            className="shrink-0 cursor-pointer rounded-md bg-accent px-2 py-0.5 text-xs font-medium text-accent-fg transition-colors duration-150 hover:bg-accent/90"
                            data-testid="connection-authorize"
                          >
                            Authorize
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() =>
                            setPermissionsFor(
                              permissionsOpen ? null : connection.id,
                            )
                          }
                          className={`flex shrink-0 cursor-pointer items-center gap-1 text-xs transition-colors duration-150 ${
                            permissionsOpen
                              ? "text-fg"
                              : "text-fg-muted hover:text-fg"
                          }`}
                          aria-expanded={permissionsOpen}
                          data-testid="connection-permissions"
                        >
                          <ShieldCheck className="size-3.5" />
                          Permissions
                        </button>
                        <button
                          type="button"
                          onClick={() => void probe(connection.id)}
                          className="shrink-0 cursor-pointer text-xs text-fg-muted hover:text-fg"
                        >
                          Test
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void desktopApi
                              .connectionsUpdate(connection.id, {
                                enabled: !connection.enabled,
                              })
                              .then(refresh)
                          }
                          className={`shrink-0 cursor-pointer text-xs ${connection.enabled ? "text-fg-muted hover:text-fg" : "text-warning"}`}
                        >
                          {connection.enabled ? "Disable" : "Enable"}
                        </button>
                        {connection.source.kind !== "plugin" && (
                          <button
                            type="button"
                            onClick={() =>
                              void desktopApi
                                .connectionsRemove(connection.id)
                                .then(refresh)
                            }
                            className="shrink-0 cursor-pointer text-xs text-fg-muted hover:text-danger"
                            aria-label={`Remove ${connection.name}`}
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        )}
                      </div>
                      {permissionsOpen && (
                        <ToolPolicyEditor
                          connection={connection}
                          onProbe={() => void probe(connection.id)}
                          probing={
                            probes[connection.id] !== undefined &&
                            !probes[connection.id]?.ok &&
                            !probes[connection.id]?.error
                          }
                          onChange={(policy) => {
                            // Optimistic: the change event refreshes the list.
                            setConnections((current) =>
                              current.map((entry) =>
                                entry.id === connection.id
                                  ? {
                                      ...entry,
                                      toolPolicy: policy ?? undefined,
                                    }
                                  : entry,
                              ),
                            );
                            void desktopApi.connectionsSetPolicy(
                              connection.id,
                              policy,
                            );
                          }}
                        />
                      )}
                    </div>
                  );
                })}
                {installed.map((connector) => (
                  <div
                    key={connector.name}
                    className="flex items-center gap-2 rounded-md border border-border bg-bg-raised/40 px-2.5 py-1.5"
                  >
                    <ConnectorIcon name={connector.name} kind="plugin" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="truncate text-[13px]">
                          {connector.name}
                        </span>
                        <span className="shrink-0 text-[11px] text-fg-faint">
                          Plugin · {connector.marketplace}
                        </span>
                      </div>
                      <p className="truncate text-xs text-fg-muted">
                        {connector.description}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        void desktopApi
                          .connectorsRemove(connector.name)
                          .then(refresh)
                      }
                      className="shrink-0 cursor-pointer text-xs text-fg-muted hover:text-danger"
                      aria-label={`Remove ${connector.name}`}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          {results && (
            <div ref={listRef} className="mb-4 flex flex-col gap-1.5">
              {(connections.length > 0 || installed.length > 0) &&
                !query.trim() && (
                  <h3 className="text-xs font-medium text-fg-muted">
                    Available
                  </h3>
                )}
              {rows.length === 0 && !searching && (
                <p className="text-xs text-fg-faint">Nothing found.</p>
              )}
              {rows.map((row) =>
                row.node === "registry" ? (
                  <div
                    key={`registry:${row.entry.name}`}
                    data-item-id={`registry:${row.entry.name}`}
                    className="rounded-md border border-border bg-bg-raised/40 px-2.5 py-2"
                  >
                    <div className="flex items-center gap-2">
                      <ConnectorIcon
                        iconUrl={row.entry.iconUrl}
                        name={row.entry.displayName}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <span className="truncate text-[13px] font-medium">
                            {row.entry.displayName}
                          </span>
                          {row.entry.official && officialBadge}
                          <span className="shrink-0 text-[11px] text-fg-faint">
                            MCP · {row.entry.suggested?.transport ?? "manual"}
                          </span>
                        </div>
                        <p className="truncate text-xs text-fg-muted">
                          {row.entry.description}
                        </p>
                      </div>
                      {pageButton(
                        row.entry.repositoryUrl,
                        row.entry.displayName,
                      )}
                      {row.entry.suggested && (
                        <PendingButton
                          type="button"
                          pending={busy === row.entry.name}
                          done={registryInstalled(row.entry.name)}
                          doneLabel="Installed"
                          onClick={() => {
                            const inputs = row.entry.suggested?.inputs ?? [];
                            if (inputs.length > 0) {
                              setSecretsFor(
                                secretsFor === row.entry.name
                                  ? null
                                  : row.entry.name,
                              );
                              setSecretValues({});
                            } else {
                              void installRegistry(row.entry.name, {});
                            }
                          }}
                          className="h-7 shrink-0 cursor-pointer rounded-md border border-border px-2.5 text-xs text-fg transition-colors duration-150 hover:bg-bg-overlay disabled:cursor-default disabled:text-fg-faint disabled:hover:bg-transparent"
                        >
                          Install
                        </PendingButton>
                      )}
                    </div>
                    {secretsFor === row.entry.name && row.entry.suggested && (
                      <div className="mt-2 flex flex-col gap-1.5 border-t border-border pt-2">
                        {row.entry.suggested.inputs.map((input) => (
                          <label
                            key={input.name}
                            className="flex flex-col gap-0.5 text-[11px] text-fg-muted"
                          >
                            {input.name}
                            {input.required ? "" : " (optional)"}
                            <input
                              type={input.secret ? "password" : "text"}
                              value={secretValues[input.name] ?? ""}
                              onChange={(event) =>
                                setSecretValues((current) => ({
                                  ...current,
                                  [input.name]: event.target.value,
                                }))
                              }
                              placeholder={input.description}
                              className="field h-7 px-2 font-mono text-[12px] text-fg placeholder:font-sans placeholder:text-fg-faint"
                              autoComplete="off"
                            />
                          </label>
                        ))}
                        <PendingButton
                          type="button"
                          pending={busy === row.entry.name}
                          disabled={(row.entry.suggested.inputs ?? []).some(
                            (input) =>
                              input.required &&
                              !secretValues[input.name]?.trim(),
                          )}
                          onClick={() =>
                            void installRegistry(row.entry.name, secretValues)
                          }
                          className="h-7 w-fit cursor-pointer rounded-md bg-accent px-3 text-xs font-medium text-accent-fg disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Install with these values
                        </PendingButton>
                      </div>
                    )}
                  </div>
                ) : (
                  <div
                    key={`plugin:${row.entry.marketplace}#${row.entry.name}`}
                    data-item-id={`plugin:${row.entry.marketplace}#${row.entry.name}`}
                    className="flex items-center gap-2 rounded-md border border-border bg-bg-raised/40 px-2.5 py-2"
                  >
                    <ConnectorIcon name={row.entry.name} kind="plugin" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="truncate text-[13px] font-medium">
                          {row.entry.name}
                        </span>
                        {row.entry.official && officialBadge}
                        <span className="shrink-0 text-[11px] text-fg-faint">
                          Plugin · {row.entry.marketplace}
                        </span>
                      </div>
                      <p className="truncate text-xs text-fg-muted">
                        {row.entry.description}
                      </p>
                    </div>
                    {pageButton(row.entry.pageUrl, row.entry.name)}
                    <PendingButton
                      type="button"
                      pending={
                        busy === `${row.entry.marketplace}#${row.entry.name}`
                      }
                      done={pluginInstalled(
                        row.entry.marketplace,
                        row.entry.name,
                      )}
                      doneLabel="Installed"
                      onClick={() =>
                        void installPlugin(
                          row.entry.marketplace,
                          row.entry.name,
                        )
                      }
                      className="h-7 shrink-0 cursor-pointer rounded-md border border-border px-2.5 text-xs text-fg transition-colors duration-150 hover:bg-bg-overlay disabled:cursor-default disabled:text-fg-faint disabled:hover:bg-transparent"
                    >
                      Install
                    </PendingButton>
                  </div>
                ),
              )}
            </div>
          )}

          {!results &&
            connections.length === 0 &&
            installed.length === 0 &&
            !searching && (
              <p className="text-xs text-fg-faint">
                No connectors yet — search above to add tools from the MCP
                registry or a plugin marketplace.
              </p>
            )}
        </div>
      </div>
    </Modal>
  );
}

/**
 * Per-connection tool permissions: the profile's ceiling for this
 * connection (agents can only narrow it). A default for the roster
 * (Auto = read-only tools run, others ask) and a per-tool override; the
 * roster is what the last probe listed, so an unprobed connection offers
 * to fetch it. Every change saves immediately.
 */
function ToolPolicyEditor({
  connection,
  onChange,
  onProbe,
  probing,
}: {
  connection: ConnectionInfo;
  onChange: (policy: McpToolPolicy | null) => void;
  onProbe: () => void;
  probing: boolean;
}) {
  const policy = connection.toolPolicy ?? {};
  const tools = connection.tools ?? [];
  const setDefault = (value: ToolPermission | "auto") =>
    onChange(
      normalizePolicy({
        ...policy,
        default: value === "auto" ? undefined : value,
      }),
    );
  const setTool = (name: string, value: ToolPermission | "default") => {
    const next = { ...policy.tools };
    if (value === "default") delete next[name];
    else next[name] = value;
    onChange(normalizePolicy({ ...policy, tools: next }));
  };
  // Effective = provisioner ceiling (when one exists) ∩ this policy —
  // the same math the harness does, so the label never lies.
  const ceiling = connection.ceiling?.policy;
  const resolved = (tool: (typeof tools)[number]): ToolPermission =>
    resolveAcross([ceiling, policy], tool.name, tool.annotations);
  return (
    <div
      className="mt-2 flex flex-col gap-2 border-t border-border pt-2"
      data-testid="tool-policy-editor"
    >
      {connection.ceiling && (
        <p
          className="flex items-center gap-1.5 rounded-md border border-border bg-bg-overlay/60 px-2 py-1 text-[11px] text-fg-muted"
          data-testid="tool-policy-ceiling"
        >
          <ShieldCheck className="size-3 shrink-0 text-fg-faint" />
          <span className="min-w-0 truncate">
            Ceiling set by{" "}
            <span className="text-fg">{connection.ceiling.source}</span> —{" "}
            {describePolicy(connection.ceiling.policy)}. Your rules can only
            narrow it.
          </span>
        </p>
      )}
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-[11px] text-fg-muted">
          Tools without a rule
          <span className="text-fg-faint">
            {" "}
            — Auto runs read-only tools and asks about the rest
          </span>
        </span>
        <Segmented
          value={policy.default ?? "auto"}
          options={[
            { value: "auto", label: "Auto" },
            { value: "allow", label: "Allow" },
            { value: "ask", label: "Ask" },
            { value: "deny", label: "Off" },
          ]}
          onChange={(value) => setDefault(value as ToolPermission | "auto")}
          testId="tool-policy-default"
        />
      </div>
      <p className="text-[10px] text-fg-faint">
        Ask opens a consent prompt when an agent reaches for the tool. Agents
        can narrow these rules, never widen them. Codex agents can't ask — for
        them, Ask means Off.
      </p>
      {tools.length === 0 ? (
        <div className="flex items-center gap-2 text-[11px] text-fg-faint">
          {probing ? (
            <>
              <Loader2 className="size-3 animate-spin" />
              Listing tools…
            </>
          ) : (
            <>
              No tool list yet.
              <button
                type="button"
                onClick={onProbe}
                className="cursor-pointer text-fg-muted underline-offset-2 hover:text-fg hover:underline"
              >
                Fetch the server's tools
              </button>
            </>
          )}
        </div>
      ) : (
        <ul className="flex flex-col gap-1" data-testid="tool-policy-tools">
          {tools.map((tool) => {
            const explicit = policy.tools?.[tool.name];
            const effective = resolved(tool);
            return (
              <li
                key={tool.name}
                className="flex items-center gap-2"
                data-tool={tool.name}
                data-effective={effective}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5">
                    <span className="truncate font-mono text-[11px] text-fg">
                      {tool.name}
                    </span>
                    {tool.annotations?.readOnlyHint ? (
                      <span className="shrink-0 text-[10px] text-fg-faint">
                        read-only
                      </span>
                    ) : tool.annotations?.destructiveHint ? (
                      <span className="shrink-0 text-[10px] text-danger/80">
                        destructive
                      </span>
                    ) : null}
                  </div>
                  {tool.description && (
                    <p className="truncate text-[11px] text-fg-faint">
                      {tool.description}
                    </p>
                  )}
                </div>
                <Segmented
                  value={explicit ?? "default"}
                  options={[
                    {
                      value: "default",
                      label: explicit
                        ? "Default"
                        : `${PERMISSION_LABELS[effective]} ·`,
                      title: "Follow the default above",
                    },
                    { value: "allow", label: "Allow" },
                    { value: "ask", label: "Ask" },
                    { value: "deny", label: "Off" },
                  ]}
                  onChange={(value) =>
                    setTool(tool.name, value as ToolPermission | "default")
                  }
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Drop empty policies so "auto, no rules" stores as nothing. */
function normalizePolicy(policy: McpToolPolicy): McpToolPolicy | null {
  const tools = Object.fromEntries(
    Object.entries(policy.tools ?? {}).filter(([, value]) => value),
  );
  const next: McpToolPolicy = {
    ...(policy.default && policy.default !== "auto"
      ? { default: policy.default }
      : {}),
    ...(Object.keys(tools).length > 0 ? { tools } : {}),
  };
  return Object.keys(next).length > 0 ? next : null;
}

/**
 * Registry icons when present (spec `icons` field, favicon-ish sizes) with
 * a neutral plug glyph when the server exposes none. Only https/data urls
 * reach here (validated server-side per the spec's security rules).
 */
export function ConnectorIcon({
  iconUrl,
  name,
  kind = "mcp",
}: {
  iconUrl?: string;
  name: string;
  /** Glyph when there's no icon: plug for MCP servers, puzzle for plugins. */
  kind?: "mcp" | "plugin";
}) {
  const Fallback = kind === "plugin" ? Puzzle : Plug;
  return (
    <span className="grid size-6 shrink-0 place-items-center overflow-hidden rounded border border-border bg-bg-inset">
      {iconUrl ? (
        <img
          src={iconUrl}
          alt=""
          className="size-full object-contain"
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
        />
      ) : (
        <Fallback className="size-3 text-fg-faint" aria-label={name} />
      )}
    </span>
  );
}
