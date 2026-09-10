export interface FileSearchInput {
  projectId: string;
  query: string;
  mode: "files" | "content";
  worktreePath?: string;
}
export interface FileSearchMatch {
  path: string;
  line?: number;
  text?: string;
}
export interface FileSearchResult {
  matches: FileSearchMatch[];
  truncated: boolean;
}
