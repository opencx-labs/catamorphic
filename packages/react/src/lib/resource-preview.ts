/** Host-resolved, bounded preview data. Loading files and URLs belongs to the host. */
export interface ResourcePreview {
  name: string;
  location?: string;
  typeLabel: string;
  sizeBytes?: number;
  content:
    | { kind: "image"; src: string }
    | { kind: "audio"; src: string; mediaType: string }
    | { kind: "video"; src: string; mediaType: string }
    | { kind: "text"; text: string; format?: "markdown"; truncated?: boolean }
    | { kind: "summary"; text: string }
    | { kind: "unavailable"; message: string };
}
