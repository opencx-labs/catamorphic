import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { type ObjectStore, PreconditionFailedError } from "./object-store.js";

export interface S3ObjectStoreOpts {
  bucket: string;
  /**
   * Endpoint for S3-compatible stores. For Cloudflare R2:
   * `https://<accountId>.r2.cloudflarestorage.com`. Omit for AWS S3.
   */
  endpoint?: string;
  /** R2 ignores the region; "auto" is its documented value. */
  region?: string;
  /**
   * Use path-style URLs (`endpoint/bucket/key`) instead of virtual-hosted
   * style. Required for MinIO and most self-hosted stores.
   */
  forcePathStyle?: boolean;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
  };
}

interface S3LikeError {
  name?: string;
  $metadata?: { httpStatusCode?: number };
}

function statusOf(err: unknown): number | undefined {
  return (err as S3LikeError).$metadata?.httpStatusCode;
}

function isNotFound(err: unknown): boolean {
  const name = (err as S3LikeError).name;
  return name === "NoSuchKey" || name === "NotFound" || statusOf(err) === 404;
}

function isPreconditionFailure(err: unknown): boolean {
  const name = (err as S3LikeError).name;
  return name === "PreconditionFailed" || statusOf(err) === 412;
}

/**
 * `ObjectStore` over any S3-compatible API (Cloudflare R2, AWS S3, MinIO).
 * Conditional writes rely on `If-Match` / `If-None-Match` support on
 * PutObject, which all three provide.
 */
export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(opts: S3ObjectStoreOpts) {
    this.bucket = opts.bucket;
    this.client = new S3Client({
      endpoint: opts.endpoint,
      region: opts.region ?? "auto",
      forcePathStyle: opts.forcePathStyle,
      credentials: opts.credentials,
    });
  }

  async get(key: string): Promise<{ data: Uint8Array; etag: string } | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!res.Body) return null;
      const data = await res.Body.transformToByteArray();
      return { data, etag: res.ETag ?? "" };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async has(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  async put(
    key: string,
    data: Uint8Array,
    opts?: { ifMatch?: string; ifNoneMatch?: "*" },
  ): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: data,
          IfMatch: opts?.ifMatch,
          IfNoneMatch: opts?.ifNoneMatch,
        }),
      );
    } catch (err) {
      if (isPreconditionFailure(err)) {
        throw new PreconditionFailedError(key);
      }
      throw err;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const obj of res.Contents ?? []) {
        if (obj.Key) keys.push(obj.Key);
      }
      continuationToken = res.IsTruncated
        ? res.NextContinuationToken
        : undefined;
    } while (continuationToken);
    return keys;
  }

  async deletePrefix(prefix: string): Promise<void> {
    const keys = await this.list(prefix);
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((key) => ({ Key: key })) },
        }),
      );
    }
  }
}
