import { createHash, randomUUID } from "node:crypto";
import { chmod, chown, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentAttachment } from "@catamorphic/agent-protocol";
import { isMediaAttachment, renderUserMessage } from "@catamorphic/sandbox";

/**
 * The prompt Claude Code reads for one input. Text attachments render into
 * it; media ride along as files under the attempt's state directory, which
 * the CLI (running beside the runner) reads with its own Read tool, which
 * renders images natively.
 */
export async function renderPrompt(input: {
  itemId: string;
  text: string;
  attachments: AgentAttachment[];
  stateDirectory: string;
  /**
   * The group of a harness running as its own user (ADR 0332): it reads
   * the files, the runner alone writes them.
   */
  readerGroup?: number;
}): Promise<string> {
  const withText = renderUserMessage(input.text, input.attachments);
  const media = input.attachments.filter(isMediaAttachment);
  if (media.length === 0) return withText;
  const directory = path.join(
    input.stateDirectory,
    "attachments",
    input.itemId.replace(/[^\w.-]+/g, "_"),
  );
  // What the person pasted stays theirs: private, like Work's own copy.
  const group = input.readerGroup;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (group !== undefined)
    for (const folder of [path.dirname(directory), directory]) {
      await chown(folder, -1, group);
      await chmod(folder, 0o750);
    }
  const lines: string[] = [];
  for (const attachment of media) {
    // Names come from the person's clipboard and files: keep them readable
    // but path-safe, and unique beside a same-named sibling.
    const safeName = `${randomUUID().slice(0, 8)}-${attachment.name.replace(/[^\w.-]+/g, "_")}`;
    const filePath = path.join(directory, safeName);
    await writeFile(filePath, Buffer.from(attachment.dataBase64, "base64"), {
      mode: 0o600,
    });
    if (group !== undefined) {
      await chown(filePath, -1, group);
      await chmod(filePath, 0o640);
    }
    lines.push(
      `- [attachment ${input.attachments.indexOf(attachment) + 1}: ${attachment.name}] ${filePath} (${attachment.mediaType})`,
    );
  }
  return `${withText}\n\n[The user attached ${media.length === 1 ? "a file" : "files"} with this message. Use the Read tool to view:\n${lines.join("\n")}]`;
}

/**
 * The SDK message uuid for a Work input item in one attempt: derived, so a
 * replayed transcript names the same uuids it was recorded with, and the
 * CLI's consumption reports map back to item ids. Each attempt names it
 * anew: a retry resends the turn's input on the same native thread, and
 * the CLI ends a uuid its transcript already answered (an API error is an
 * answer) without running it. The retry's fresh uuid adds a second copy of
 * the message to the thread, after the first one's answer.
 */
export function inputUuid(input: {
  attemptId: string;
  itemId: string;
}): `${string}-${string}-${string}-${string}-${string}` {
  const hex = createHash("sha256")
    .update(`input:${input.attemptId}:${input.itemId}`)
    .digest("hex");
  const variant = (
    (Number.parseInt(hex.slice(16, 17), 16) & 0x3) |
    0x8
  ).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
