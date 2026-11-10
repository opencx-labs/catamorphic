import { Save } from "lucide-react";
import { PendingButton } from "./pending-button.js";
import { ShortcutHint } from "./shortcut-hint.js";

/** One fixed save icon, with the chat-style dot while edits remain unsaved. */
export function FileSaveButton({
  dirty,
  saving,
  canSave = dirty,
  disabled = false,
  disabledReason,
  onSave,
  testId,
}: {
  dirty: boolean;
  saving: boolean;
  /** Naming a new file can remain available after its content autosaves. */
  canSave?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onSave: () => void;
  testId?: string;
}) {
  const label = saving ? "Saving file" : canSave ? "Save file" : "File saved";
  return (
    <ShortcutHint
      label={label}
      shortcut={/Mac/.test(navigator.platform) ? "⌘S" : "Ctrl+S"}
    >
      <span className="relative inline-flex">
        <PendingButton
          type="button"
          pending={saving}
          done={!canSave}
          disabled={disabled}
          data-disabled-reason={disabledReason}
          data-testid={testId}
          data-unsaved={dirty || undefined}
          aria-label={label}
          onClick={onSave}
          className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg disabled:cursor-default"
        >
          <Save className="size-3.5" aria-hidden="true" />
        </PendingButton>
        <span
          aria-hidden="true"
          data-save-dot
          className={`pointer-events-none absolute right-0.5 top-0.5 size-1.5 rounded-full bg-accent transition-[opacity,scale] duration-200 motion-reduce:transition-none ${dirty ? "scale-100 opacity-100" : "scale-0 opacity-0"}`}
        />
      </span>
    </ShortcutHint>
  );
}
