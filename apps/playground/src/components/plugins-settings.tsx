"use client";

import { useCallback, useEffect, useState } from "react";
import {
  type AttachedPlugin,
  api,
  type PluginInfo,
  type PluginSecretDescriptor,
} from "@/lib/api";

interface Props {
  projectId: string;
}

export function PluginsSettings({ projectId }: Props) {
  const [attached, setAttached] = useState<AttachedPlugin[] | null>(null);
  const [catalog, setCatalog] = useState<PluginInfo[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [attachedList, catalogList] = await Promise.all([
        api.getAttachedPlugins(projectId),
        api.getPluginCatalog().catch(() => [] as PluginInfo[]),
      ]);
      setAttached(attachedList);
      setCatalog(catalogList);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const attachedNames = new Set(attached?.map((p) => p.packageName) ?? []);
  const available = (catalog ?? []).filter(
    (p) => !attachedNames.has(p.packageName),
  );

  const handleAttach = async (packageName: string) => {
    setError(null);
    try {
      await api.attachPlugin(projectId, packageName);
      setPicking(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDetach = async (packageName: string) => {
    setError(null);
    try {
      await api.detachPlugin(projectId, packageName);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="mb-10">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold">Plugins</h2>
          <p className="text-xs text-neutral-500 mt-1">
            Attach packages that expose triggers and actions for this project.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setPicking((v) => !v)}
          className="h-9 cursor-pointer rounded border border-neutral-700 bg-neutral-900 px-3 text-sm font-medium text-neutral-200 transition-colors hover:border-neutral-500"
        >
          {picking ? "Cancel" : "Add plugin"}
        </button>
      </div>

      {error ? (
        <div className="mb-4 rounded border border-red-800 bg-red-950/40 p-3 text-sm text-red-300">
          {error}
        </div>
      ) : null}

      {picking ? (
        <div className="mb-4 rounded border border-neutral-800 p-4">
          {available.length === 0 ? (
            <p className="text-sm text-neutral-500">
              No plugins found in the local catalog. Set
              <code className="ml-1 rounded bg-neutral-900 px-1">
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
                    <p className="text-sm text-neutral-200">
                      {plugin.displayName}{" "}
                      <span className="text-neutral-500 font-mono text-xs">
                        {plugin.packageName}
                      </span>
                    </p>
                    {plugin.description ? (
                      <p className="text-xs text-neutral-500 mt-1">
                        {plugin.description}
                      </p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => handleAttach(plugin.packageName)}
                    className="h-8 cursor-pointer rounded border border-blue-600 bg-blue-600/20 px-3 text-xs font-medium text-blue-300 transition-colors hover:bg-blue-600/30"
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
        <div className="text-sm text-neutral-500">Loading…</div>
      ) : null}

      {attached && attached.length === 0 ? (
        <div className="border border-dashed border-neutral-800 rounded-lg p-6 text-center text-neutral-500 text-sm">
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
              onDetach={() => handleDetach(plugin.packageName)}
              onSaved={refresh}
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
  onDetach,
  onSaved,
}: {
  projectId: string;
  plugin: AttachedPlugin;
  onDetach: () => void | Promise<void>;
  onSaved: () => void | Promise<void>;
}) {
  const hasValue = new Map(
    plugin.secretStatus.map((s) => [s.name, s.hasValue]),
  );

  return (
    <li className="rounded-lg border border-neutral-800 p-4">
      <header className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h3 className="text-sm font-medium">{plugin.displayName}</h3>
          <p className="text-xs font-mono text-neutral-500">
            {plugin.packageName}
            {plugin.version ? `@${plugin.version}` : ""}
          </p>
          {plugin.description ? (
            <p className="text-xs text-neutral-500 mt-1">
              {plugin.description}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onDetach}
          className="h-8 cursor-pointer rounded border border-neutral-700 px-2 text-xs text-neutral-400 transition-colors hover:border-red-700 hover:text-red-300"
        >
          Detach
        </button>
      </header>

      {plugin.secrets.length === 0 ? (
        <p className="text-xs text-neutral-500">
          This plugin doesn&apos;t require any secrets.
        </p>
      ) : (
        <div className="grid gap-3">
          {plugin.secrets.map((secret) => (
            <SecretField
              key={secret.name}
              projectId={projectId}
              secret={secret}
              hasValue={hasValue.get(secret.name) ?? false}
              onSaved={onSaved}
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
  hasValue,
  onSaved,
}: {
  projectId: string;
  secret: PluginSecretDescriptor;
  hasValue: boolean;
  onSaved: () => void | Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputId = `secret-${projectId}-${secret.name}`;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!value) return;
    setSaving(true);
    setErr(null);
    try {
      await api.setSecret(projectId, secret.name, value);
      setValue("");
      await onSaved();
    } catch (caught) {
      setErr(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSave} className="grid gap-1">
      <label
        htmlFor={inputId}
        className="text-xs text-neutral-300 flex items-center gap-2"
      >
        <span>{secret.label}</span>
        {secret.required ? (
          <span className="text-[10px] uppercase tracking-wider text-amber-400">
            required
          </span>
        ) : null}
        {hasValue ? (
          <span className="text-[10px] uppercase tracking-wider text-emerald-400">
            set
          </span>
        ) : null}
      </label>
      {secret.description ? (
        <p className="text-[11px] text-neutral-500">{secret.description}</p>
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
          className="flex-1 h-8 rounded border border-neutral-700 bg-neutral-950 px-2 text-sm font-mono text-neutral-200 focus:border-blue-600 focus:outline-none"
        />
        <button
          type="submit"
          disabled={!value || saving}
          className="h-8 cursor-pointer rounded border border-neutral-700 bg-neutral-900 px-3 text-xs font-medium text-neutral-200 transition-colors hover:border-neutral-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {err ? <p className="text-[11px] text-red-400">{err}</p> : null}
      <code className="text-[10px] text-neutral-600 font-mono">
        {secret.name}
      </code>
    </form>
  );
}
