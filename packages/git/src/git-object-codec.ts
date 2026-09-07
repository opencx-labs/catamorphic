import { createHash } from "node:crypto";

export type GitObjectType = "blob" | "tree" | "commit" | "tag";

const OBJECT_TYPES: readonly GitObjectType[] = [
  "blob",
  "tree",
  "commit",
  "tag",
];

/**
 * Encode a git object in "wrapped" form (`<type> <length>\0<content>`) — the
 * uncompressed loose-object layout. Stored bodies are therefore
 * self-describing, and `sha1(wrapped)` equals the git oid, so stored objects
 * are verifiable by key alone.
 */
export function wrapObject(opts: { type: GitObjectType; data: Uint8Array }): {
  wrapped: Uint8Array;
  sha: string;
} {
  const header = new TextEncoder().encode(
    `${opts.type} ${opts.data.byteLength}\0`,
  );
  const wrapped = new Uint8Array(header.byteLength + opts.data.byteLength);
  wrapped.set(header, 0);
  wrapped.set(opts.data, header.byteLength);
  const sha = createHash("sha1").update(wrapped).digest("hex");
  return { wrapped, sha };
}

export function unwrapObject(wrapped: Uint8Array): {
  type: GitObjectType;
  data: Uint8Array;
} {
  const nullIdx = wrapped.indexOf(0);
  if (nullIdx === -1) {
    throw new Error("Malformed git object: missing header terminator");
  }
  const header = new TextDecoder().decode(wrapped.slice(0, nullIdx));
  const spaceIdx = header.indexOf(" ");
  const type = header.slice(0, spaceIdx);
  if (!OBJECT_TYPES.includes(type as GitObjectType)) {
    throw new Error(`Malformed git object: unknown type '${type}'`);
  }
  return {
    type: type as GitObjectType,
    data: wrapped.slice(nullIdx + 1),
  };
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: { name: string; email: string; timestamp: number };
  message: string;
}

/** Parse a commit object's content (author line, parents, message). */
export function parseCommit(data: Uint8Array): ParsedCommit {
  const text = new TextDecoder().decode(data);
  const headerEnd = text.indexOf("\n\n");
  const header = headerEnd === -1 ? text : text.slice(0, headerEnd);
  const message = headerEnd === -1 ? "" : text.slice(headerEnd + 2);

  const parents: string[] = [];
  const treeLine = header.split("\n").find((line) => line.startsWith("tree "));
  const authorLine = header
    .split("\n")
    .find((line) => line.startsWith("author "));
  for (const line of header.split("\n")) {
    if (line.startsWith("parent ")) parents.push(line.slice(7).trim());
  }

  // `author Name <email> <unix-ts> <tz>`
  const authorMatch = authorLine?.match(/^author (.*) <(.*)> (\d+) [+-]\d{4}$/);
  return {
    tree: treeLine?.slice(5).trim() ?? "",
    parents,
    author: {
      name: authorMatch?.[1] ?? "",
      email: authorMatch?.[2] ?? "",
      timestamp: authorMatch ? Number(authorMatch[3]) : 0,
    },
    message,
  };
}
