import { z } from "zod";
import type { Identity } from "../identity.js";
import {
  type DocumentsService,
  normalizeDocumentPath,
} from "./documents-service.js";

export const PrivateStateKeySchema = z.string().min(1).max(400);
export const PrivateStateReadSchema = z.object({ key: PrivateStateKeySchema });
export const PrivateStateWriteSchema = PrivateStateReadSchema.extend({
  value: z.json(),
  ifVersion: z.number().int().nonnegative(),
});
export const PrivateStateDeleteSchema = PrivateStateReadSchema.extend({
  ifVersion: z.number().int().nonnegative(),
});
export const PrivateStateSchema = z.object({
  key: z.string(),
  version: z.number().int().nonnegative(),
  value: z.json(),
});

/** JSON state in the existing document version journal, partitioned by member. */
export class PrivateStateService {
  constructor(private readonly documents: DocumentsService) {}

  async read(input: {
    identity: Identity;
    projectId: string;
    key: string;
  }): Promise<{
    key: string;
    version: number;
    value: z.infer<typeof PrivateStateSchema>["value"];
  }> {
    const key = normalizeDocumentPath(input.key);
    const head = await this.documents.head({
      ...input,
      path: `store/${key}.json`,
      audience: "member",
    });
    return {
      key,
      version: head.version,
      value: head.deleted
        ? null
        : z
            .json()
            .parse(
              JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(head.bytes),
              ),
            ),
    };
  }

  async write(input: {
    identity: Identity;
    projectId: string;
    key: string;
    value: z.infer<typeof PrivateStateSchema>["value"];
    ifVersion: number;
    signal?: AbortSignal;
  }): Promise<{
    key: string;
    version: number;
    value: z.infer<typeof PrivateStateSchema>["value"];
  }> {
    const parsed = PrivateStateWriteSchema.parse(input);
    const key = normalizeDocumentPath(parsed.key);
    const document = await this.documents.write({
      ...input,
      path: `store/${key}.json`,
      audience: "member",
      content: JSON.stringify(parsed.value),
      contentType: "application/json",
    });
    return { key, version: document.version ?? 0, value: parsed.value };
  }

  async delete(input: {
    identity: Identity;
    projectId: string;
    key: string;
    ifVersion: number;
    signal?: AbortSignal;
  }): Promise<{ version: number }> {
    PrivateStateDeleteSchema.parse(input);
    return this.documents.delete({
      ...input,
      path: `store/${normalizeDocumentPath(input.key)}.json`,
      audience: "member",
    });
  }
}
