/**
 * Where built app bundles live. Host-injectable; `S3ObjectStore` from
 * `@catamorphic/s3` satisfies this structurally, and hosts may supply anything
 * else (filesystem, KV) that honors the same contract.
 */
export interface AppBundleStore {
  get(key: string): Promise<{ data: Uint8Array; etag: string } | null>;
  put(key: string, data: Uint8Array): Promise<void>;
  /** Delete every object under a prefix. Used when pruning preview builds. */
  deletePrefix(prefix: string): Promise<void>;
}

export function appBundleKey(args: {
  tenantId: string;
  projectId: string;
  appId: string;
  versionId: string;
  file: "app.js" | "app.css";
}): string {
  return `apps/${args.tenantId}/${args.projectId}/${args.appId}/${args.versionId}/${args.file}`;
}

export function appVersionPrefix(args: {
  tenantId: string;
  projectId: string;
  appId: string;
  versionId: string;
}): string {
  return `apps/${args.tenantId}/${args.projectId}/${args.appId}/${args.versionId}/`;
}
