import type { ChatDraft } from "../../shared/desktop-workspace.js";

export interface PaletteSnapshot {
  mode: string | null;
  draft: ChatDraft;
  selection?: { anchor: number; focus: number };
}
interface Edit {
  before: PaletteSnapshot;
  after: PaletteSnapshot;
  kind: string;
  time: number;
}
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (key) =>
        Object.hasOwn(b, key) &&
        sameValue(Reflect.get(a, key), Reflect.get(b, key)),
    )
  );
}
export const samePaletteDraft = (a: PaletteSnapshot, b: PaletteSnapshot) =>
  a.mode === b.mode &&
  a.draft.message === b.draft.message &&
  sameValue(a.draft.attachments, b.draft.attachments);

/** One ordered history across the palette's editors and mode chips (ADR 0314). */
export class PaletteHistory {
  private edits: Edit[] = [];
  private cursor = 0;
  private group = false;

  breakGroup(): void {
    this.group = false;
  }
  clear(): void {
    this.edits = [];
    this.cursor = 0;
    this.group = false;
  }
  record({
    before,
    after,
    kind,
    time = performance.now(),
  }: Omit<Edit, "time"> & { time?: number }): void {
    if (samePaletteDraft(before, after)) return;
    const previous = this.edits[this.cursor - 1];
    const merge =
      this.group &&
      this.cursor === this.edits.length &&
      (kind === "insertText" ||
        kind === "deleteContentBackward" ||
        kind === "deleteContentForward") &&
      previous?.kind === kind &&
      time - previous.time < 1000 &&
      samePaletteDraft(previous.after, before) &&
      previous.after.selection?.anchor === before.selection?.anchor &&
      previous.after.selection?.focus === before.selection?.focus &&
      before.selection?.anchor === before.selection?.focus;
    this.edits.length = this.cursor;
    if (merge && previous) {
      previous.after = after;
      previous.time = time;
    } else {
      this.edits.push({ before, after, kind, time });
      this.cursor++;
    }
    this.group = true;
  }
  undo(): PaletteSnapshot | undefined {
    this.breakGroup();
    if (this.cursor === 0) return;
    return this.edits[--this.cursor]?.before;
  }
  redo(): PaletteSnapshot | undefined {
    this.breakGroup();
    const edit = this.edits[this.cursor];
    if (!edit) return;
    this.cursor++;
    return edit.after;
  }
}
