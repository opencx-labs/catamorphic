/**
 * "files" finds filenames, "content" text inside files, and "paths" files
 * and the folders holding them (a composer's @ mention, ADR 0273); an
 * empty "paths" query lists the top level.
 */
export type FileSearchMode = "files" | "content" | "paths";

export interface FileSearchInput {
  projectId: string;
  query: string;
  mode: FileSearchMode;
  worktreePath?: string;
}
export interface FileSearchMatch {
  /** Relative to the searched checkout; a folder's ends with "/". */
  path: string;
  line?: number;
  text?: string;
  directory?: boolean;
}
export interface FileSearchResult {
  matches: FileSearchMatch[];
  truncated: boolean;
}
