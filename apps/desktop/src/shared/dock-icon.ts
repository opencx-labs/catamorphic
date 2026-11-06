export const MAX_DOCK_ICON_BYTES = 10 * 1024 * 1024;

export interface DockIconState {
  supported: boolean;
  custom: boolean;
  /** Small PNG preview of the selected image. */
  preview: string | null;
  error?: string;
  /** Orders initial reads, replies and broadcasts across workspace windows. */
  revision: number;
}
