/**
 * YAML frontmatter handling. @tiptap/markdown has no frontmatter support —
 * the `---` fences would parse as thematic breaks and the YAML as paragraph
 * text, corrupting it on round-trip. So the editor never sees it: the block
 * is split off on load, carried alongside the document, and re-joined into
 * every emitted markdown string. It is edited as plain text (no YAML
 * parsing — byte-exact preservation beats a lossy properties UI).
 */

export interface SplitMarkdown {
  /** Raw YAML between the fences, without the `---` lines. Null if absent. */
  frontmatter: string | null;
  body: string;
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function splitFrontmatter(text: string): SplitMarkdown {
  const match = FRONTMATTER_PATTERN.exec(text);
  if (!match) return { frontmatter: null, body: text };
  return { frontmatter: match[1] ?? "", body: text.slice(match[0].length) };
}

export function joinFrontmatter(
  frontmatter: string | null,
  body: string,
): string {
  if (frontmatter === null || frontmatter.trim() === "") return body;
  return `---\n${frontmatter}\n---\n${body}`;
}
