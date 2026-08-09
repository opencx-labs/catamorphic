import { BadgeCheck, ExternalLink, Plug, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type ConnectionInfo,
  type ConnectionProbe,
  type ConnectorSearchData,
  desktopApi,
  type InstalledConnectorInfo,
} from "../lib/desktop-api";
import { Modal } from "./modal";
import { PendingButton } from "./pending-button";

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
 */
export function ConnectorsModal({
  open,
  onClose,
  onOpenUrl,
}: {
  open: boolean;
  onClose: () => void;
  /** Open a connector's page (repo/readme) in a browser tab. */
  onOpenUrl: (url: string) => void;
}) {
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [installed, setInstalled] = useState<InstalledConnectorInfo[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ConnectorSearchData | null>(null);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [probes, setProbes] = useState<Record<string, ConnectionProbe>>({});
  // Registry entries that need secrets before install expand a small form.
  const [secretsFor, setSecretsFor] = useState<string | null>(null);
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = () => {
    void desktopApi
      .connectionsList()
      .then(setConnections)
      .catch(() => {});
    void desktopApi
      .connectorsList()
      .then(setInstalled)
      .catch(() => {});
  };
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

  // Live search: debounce keystrokes, keep only the latest response. An
  // empty query still lists the browsable defaults once the modal opens.
  const requestSeq = useRef(0);
  // Bumped after installs so "Installed" markers in results stay honest.
  const [resultsNonce, setResultsNonce] = useState(0);
  useEffect(() => {
    if (!open) return;
    const seq = ++requestSeq.current;
    setSearching(true);
    const timer = window.setTimeout(() => {
      desktopApi
        .connectorsSearch(query)
        .then((data) => {
          if (requestSeq.current !== seq) return;
          setResults(data);
          setError(null);
        })
        .catch((cause) => {
          if (requestSeq.current !== seq) return;
          setError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => {
          if (requestSeq.current === seq) setSearching(false);
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [open, query, resultsNonce]);

  const installRegistry = async (
    name: string,
    secrets: Record<string, string>,
  ) => {
    setBusy(name);
    setError(null);
    try {
      await desktopApi.connectorsInstallRegistry(name, secrets);
      setSecretsFor(null);
      setSecretValues({});
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const installPlugin = async (marketplace: string, name: string) => {
    setBusy(`${marketplace}#${name}`);
    setError(null);
    try {
      await desktopApi.connectorsInstallPlugin(marketplace, name);
      refresh();
      setResultsNonce((nonce) => nonce + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const probe = async (id: string) => {
    setProbes((current) => ({ ...current, [id]: { ok: false } }));
    const result = await desktopApi.connectionsProbe(id);
    setProbes((current) => ({ ...current, [id]: result }));
  };

  // One merged result list, officials first (no install counts exist to
  // rank by), each kind keeping its own row rendering.
  const rows = useMemo(() => {
    if (!results) return [];
    const merged = [
      ...results.registry.map((entry) => ({
        sort: entry.official ? 0 : 1,
        label: entry.displayName,
        node: "registry" as const,
        entry,
      })),
      ...results.plugins.map((entry) => ({
        sort: entry.official ? 0 : 1,
        label: entry.name,
        node: "plugin" as const,
        entry,
      })),
    ];
    return merged.sort(
      (a, b) => a.sort - b.sort || a.label.localeCompare(b.label),
    );
  }, [results]);

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
      <div className="flex max-h-[min(640px,80vh)] flex-col p-4">
        <h2 className="text-sm font-semibold">Connectors</h2>
        <p className="mb-3 mt-0.5 text-xs text-fg-muted">
          Tools your agents can use — MCP servers and Claude Code plugins.
          Installed connectors work with every agent; assign them per agent when
          editing it.
        </p>

        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search the MCP registry and plugin marketplaces…"
          className="field mb-3 h-8 shrink-0 px-2 text-[13px] text-fg placeholder:text-fg-faint"
          data-testid="connectors-search"
          spellCheck={false}
        />

        {error && <p className="mb-2 text-xs text-danger">{error}</p>}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {results && (
            <div className="mb-4 flex flex-col gap-1.5">
              {rows.length === 0 && !searching && (
                <p className="text-xs text-fg-faint">Nothing found.</p>
              )}
              {rows.map((row) =>
                row.node === "registry" ? (
                  <div
                    key={`registry:${row.entry.name}`}
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
                          pendingLabel="Installing…"
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
                          className="h-7 shrink-0 cursor-pointer rounded-md border border-border px-2.5 text-xs text-fg hover:bg-bg-overlay"
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
                          pendingLabel="Installing…"
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
                    className="flex items-center gap-2 rounded-md border border-border bg-bg-raised/40 px-2.5 py-2"
                  >
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
                    {row.entry.installed ? (
                      <span className="shrink-0 text-xs text-fg-faint">
                        Installed
                      </span>
                    ) : (
                      <PendingButton
                        type="button"
                        pending={
                          busy === `${row.entry.marketplace}#${row.entry.name}`
                        }
                        pendingLabel="Installing…"
                        onClick={() =>
                          void installPlugin(
                            row.entry.marketplace,
                            row.entry.name,
                          )
                        }
                        className="h-7 shrink-0 cursor-pointer rounded-md border border-border px-2.5 text-xs text-fg hover:bg-bg-overlay"
                      >
                        Install
                      </PendingButton>
                    )}
                  </div>
                ),
              )}
            </div>
          )}

          {(connections.length > 0 || installed.length > 0) && (
            <div className="flex flex-col gap-1.5">
              <h3 className="mt-1 text-xs font-medium text-fg-muted">
                Installed
              </h3>
              {connections.map((connection) => {
                const probeResult = probes[connection.id];
                return (
                  <div
                    key={connection.id}
                    className="flex items-center gap-2 rounded-md border border-border bg-bg-raised/40 px-2.5 py-1.5"
                    data-testid="connection-row"
                  >
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
                          {connection.transport}
                          {connection.source.kind === "plugin"
                            ? ` · from ${connection.source.plugin}`
                            : connection.source.kind === "registry"
                              ? " · registry"
                              : ""}
                        </span>
                      </div>
                      {probeResult && (
                        <p
                          className={`truncate text-[11px] ${probeResult.ok ? "text-fg-muted" : probeResult.error ? "text-danger" : "text-fg-faint"}`}
                        >
                          {probeResult.ok
                            ? `${probeResult.toolCount} tools${probeResult.protocolVersion ? ` · MCP ${probeResult.protocolVersion}` : ""}`
                            : (probeResult.error ?? "Checking…")}
                        </p>
                      )}
                    </div>
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
                );
              })}
              {installed.map((connector) => (
                <div
                  key={connector.name}
                  className="flex items-center gap-2 rounded-md border border-border bg-bg-raised/40 px-2.5 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-[13px]">
                        {connector.name}
                      </span>
                      <span className="shrink-0 text-[11px] text-fg-faint">
                        plugin · {connector.marketplace}
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
 * Registry icons when present (spec `icons` field, favicon-ish sizes) with
 * a neutral plug glyph when the server exposes none. Only https/data urls
 * reach here (validated server-side per the spec's security rules).
 */
export function ConnectorIcon({
  iconUrl,
  name,
}: {
  iconUrl?: string;
  name: string;
}) {
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
        <Plug className="size-3 text-fg-faint" aria-label={name} />
      )}
    </span>
  );
}
