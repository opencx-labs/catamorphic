import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAttachment } from "@catamorphic/sandbox";
import type { UserInput } from "@openai/codex-sdk";

/** Keep attachment bytes alive for the CLI turn, including resumed threads. */
export async function stageTurnInput(
  text: string,
  attachments?: AgentAttachment[],
) {
  const media = (attachments ?? []).filter((item) => item.kind !== "text");
  if (media.length === 0) return { input: text, cleanup: async () => {} };
  const directory = await mkdtemp(join(tmpdir(), "catamorphic-codex-input-"));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    const input: UserInput[] = [{ type: "text", text }];
    for (const [index, item] of media.entries()) {
      const extensions: Record<string, string> = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/webp": "webp",
        "image/gif": "gif",
        "application/pdf": "pdf",
      };
      const file = join(
        directory,
        `${index}.${extensions[item.mediaType] ?? "bin"}`,
      );
      await writeFile(file, Buffer.from(item.dataBase64, "base64"));
      if (item.kind === "image") {
        input.push({ type: "local_image", path: file });
      } else {
        input.push({
          type: "text",
          text: `Attached document ${JSON.stringify(item.name)} (${item.mediaType}) is available at ${JSON.stringify(file)} for this turn. Read it with your file or shell tools.`,
        });
      }
    }
    return { input, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Turn input in the app-server protocol's shape. */
export function appServerInput(input: string | UserInput[]) {
  return typeof input === "string"
    ? [{ type: "text", text: input, text_elements: [] }]
    : input.map((part) =>
        part.type === "local_image"
          ? { type: "localImage", path: part.path }
          : { type: "text", text: part.text, text_elements: [] },
      );
}
