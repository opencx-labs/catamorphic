/**
 * The drag flavor a workspace tab carries beside its plain-text key, so a
 * tab dropped on a chat can become a tab pill (title, kind, address).
 */
export const TAB_DRAG_TYPE = "application/x-catamorphic-tab";

export interface TabDragPayload {
  key: string;
  kind: string;
  title: string;
  /** Per-kind detail: page URL for browsers, file path for editors. */
  detail?: string;
}
