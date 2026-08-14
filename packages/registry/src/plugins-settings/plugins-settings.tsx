"use client";

import {
  type AttachedPlugin,
  type PluginSecretDescriptor,
  useAttachPlugin,
  useDetachPlugin,
  usePluginCatalog,
  useProjectPlugins,
  useProjectSecrets,
  useUpsertProjectSecret,
} from "@catamorphic/react";
import { useState } from "react";

interface Props {
  projectId: string;
}

export function PluginsSettings({ projectId }: Props) {
  const attachedQuery = useProjectPlugins(projectId);
  const catalogQuery = usePluginCatalog();
  const attachMutation = useAttachPlugin(projectId);
  const detachMutation = useDetachPlugin(projectId);
  const [environment, setEnvironment] = useState<"test" | "production">("test");
  const secretsQuery = useProjectSecrets(projectId, environment);

  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const attached = attachedQuery.data ?? null;
  const catalog = catalogQuery.data ?? [];
  const loading = attachedQuery.isLoading;
  const secretValues = new Map(
    (secretsQuery.data ?? []).map((secret) => [secret.name, secret.hasValue]),
  );

  const attachedNames = new Set(attached?.map((p) => p.packageName) ?? []);
  const available = catalog.filter((p) => !attachedNames.has(p.packageName));

  const handleAttach = async (packageName: string) => {
    setError(null);
    try {
      await attachMutation.mutateAsync({ packageName });
      setPicking(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDetach = async (packageName: string) => {
    setError(null);
    try {
      await detachMutation.mutateAsync({ packageName });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="mb-10">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold">Plugins</h2>
          <p className="text-xs text-fg-muted mt-1">
            Attach packages that expose triggers and actions for this project.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setPicking((v) => !v)}
          className="h-9 cursor-pointer rounded border border-border-strong bg-bg-overlay px-3 text-sm font-medium text-fg transition-colors hover:border-border-strong"
        >
          {picking ? "Cancel" : "Add plugin"}
        </button>
      </div>

      {error ? (
        <div className="mb-4 rounded border border-danger/60 bg-danger/10 p-3 text-sm text-danger">
          {error}
        </div>
      ) : null}

      <div className="mb-4 flex items-center gap-2">
        {(["test", "production"] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setEnvironment(value)}
            className={`h-8 rounded border px-3 text-xs font-medium ${
              environment === value
                ? "border-accent bg-accent/15 text-accent"
                : "border-border-strong text-fg-muted"
            }`}
          >
            {value === "test" ? "Test secrets" : "Production secrets"}
          </button>
        ))}
      </div>

      {picking ? (
        <div className="mb-4 rounded border border-border p-4">
          {available.length === 0 ? (
            <p className="text-sm text-fg-muted">
              No plugins found in the local catalog. Set
              <code className="ml-1 rounded bg-bg-overlay px-1">
                CATAMORPHIC_LOCAL_PLUGINS_DIR
              </code>{" "}
              on the server and drop plugin packages in that directory.
            </p>
          ) : (
            <ul className="grid gap-2">
              {available.map((plugin) => (
                <li
                  key={plugin.packageName}
                  className="flex items-center justify-between gap-4"
                >
                  <div>
                    <p className="text-sm text-fg">
                      {plugin.displayName}{" "}
                      <span className="text-fg-muted font-mono text-xs">
                        {plugin.packageName}
                      </span>
                    </p>
                    {plugin.description ? (
                      <p className="text-xs text-fg-muted mt-1">
                        {plugin.description}
                      </p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => handleAttach(plugin.packageName)}
                    className="h-8 cursor-pointer rounded border border-blue-600 bg-blue-600/20 px-3 text-xs font-medium text-blue-300 transition-colors hover:bg-accent/25"
                  >
                    Attach
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {loading && !attached ? (
        <div className="text-sm text-fg-muted">Loading…</div>
      ) : null}

      {attached && attached.length === 0 ? (
        <div className="border border-dashed border-border rounded-lg p-6 text-center text-fg-muted text-sm">
          No plugins attached yet.
        </div>
      ) : null}

      {attached && attached.length > 0 ? (
        <ul className="grid gap-3">
          {attached.map((plugin) => (
            <AttachedPluginCard
              key={plugin.packageName}
              projectId={projectId}
              plugin={plugin}
              environment={environment}
              secretValues={secretValues}
              onDetach={() => handleDetach(plugin.packageName)}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function AttachedPluginCard({
  projectId,
  plugin,
  environment,
  secretValues,
  onDetach,
}: {
  projectId: string;
  plugin: AttachedPlugin;
  environment: "test" | "production";
  secretValues: Map<string, boolean>;
  onDetach: () => void | Promise<void>;
}) {
  return (
    <li className="rounded-lg border border-border p-4">
      <header className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h3 className="text-sm font-medium">{plugin.displayName}</h3>
          <p className="text-xs font-mono text-fg-muted">
            {plugin.packageName}
            {plugin.version ? `@${plugin.version}` : ""}
          </p>
          {plugin.description ? (
            <p className="text-xs text-fg-muted mt-1">{plugin.description}</p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onDetach}
          className="h-8 cursor-pointer rounded border border-border-strong px-2 text-xs text-fg-muted transition-colors hover:border-danger/60 hover:text-danger"
        >
          Detach
        </button>
      </header>

      {plugin.requires.length > 0 ? (
        <ul className="mb-3 grid gap-1">
          {plugin.requires.map((requirement) => (
            <li
              key={requirement.name}
              className="flex items-center gap-2 text-xs"
            >
              <span
                aria-hidden
                className={`inline-block size-1.5 rounded-full ${
                  requirement.fulfilled ? "bg-success" : "bg-danger"
                }`}
              />
              <span className="font-mono">{requirement.name}</span>
              <span className="text-fg-muted">
                {requirement.fulfilled
                  ? "supplied by your platform"
                  : requirement.optional
                    ? "not available on this host"
                    : "no provider registered"}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {plugin.secrets.length === 0 ? (
        <p className="text-xs text-fg-muted">
          This plugin doesn&apos;t require any secrets.
        </p>
      ) : (
        <div className="grid gap-3">
          {plugin.secrets.map((secret) => (
            <SecretField
              key={secret.name}
              projectId={projectId}
              secret={secret}
              environment={environment}
              hasValue={secretValues.get(secret.name) ?? false}
            />
          ))}
        </div>
      )}
    </li>
  );
}

function SecretField({
  projectId,
  secret,
  environment,
  hasValue,
}: {
  projectId: string;
  secret: PluginSecretDescriptor;
  environment: "test" | "production";
  hasValue: boolean;
}) {
  const [value, setValue] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const upsert = useUpsertProjectSecret(projectId, environment);
  const inputId = `secret-${projectId}-${environment}-${secret.name}`;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!value) return;
    setErr(null);
    try {
      await upsert.mutateAsync({ name: secret.name, value });
      setValue("");
    } catch (caught) {
      setErr(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return (
    <form onSubmit={handleSave} className="grid gap-1">
      <label
        htmlFor={inputId}
        className="text-xs text-fg flex items-center gap-2"
      >
        <span>{secret.label}</span>
        {secret.required ? (
          <span className="text-[10px] uppercase tracking-wider text-warning">
            required
          </span>
        ) : null}
        {hasValue ? (
          <span className="text-[10px] uppercase tracking-wider text-success">
            set
          </span>
        ) : null}
      </label>
      {secret.description ? (
        <p className="text-[11px] text-fg-muted">{secret.description}</p>
      ) : null}
      <div className="flex gap-2">
        <input
          id={inputId}
          type="password"
          value={value}
          placeholder={
            hasValue
              ? "•••••• (type to replace)"
              : secret.default
                ? `default: ${secret.default}`
                : "Enter value"
          }
          onChange={(e) => setValue(e.target.value)}
          className="flex-1 h-8 rounded border border-border-strong bg-bg-inset px-2 text-sm font-mono text-fg focus:border-accent focus:outline-none"
        />
        <button
          type="submit"
          disabled={!value || upsert.isPending}
          className="h-8 cursor-pointer rounded border border-border-strong bg-bg-overlay px-3 text-xs font-medium text-fg transition-colors hover:border-border-strong disabled:cursor-not-allowed disabled:opacity-50"
        >
          {upsert.isPending ? "Saving…" : "Save"}
        </button>
      </div>
      {err ? <p className="text-[11px] text-danger">{err}</p> : null}
      <code className="text-[10px] text-fg-faint font-mono">{secret.name}</code>
    </form>
  );
}
