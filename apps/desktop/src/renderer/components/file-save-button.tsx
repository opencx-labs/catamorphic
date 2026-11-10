import { Check, Save } from "lucide-react";
import { PendingButton } from "./pending-button.js";
import { ShortcutHint } from "./shortcut-hint.js";

/** One fixed button footprint through edits, writes and the saved check. */
export function FileSaveButton({
  dirty,
  saving,
  disabled = false,
  disabledReason,
  onSave,
  testId,
}: {
  dirty: boolean;
  saving: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onSave: () => void;
  testId?: string;
}) {
  const label = saving ? "Saving file" : dirty ? "Save file" : "File saved";
  return (
    <ShortcutHint
      label={label}
      shortcut={/Mac/.test(navigator.platform) ? "⌘S" : "Ctrl+S"}
    >
      <PendingButton
        type="button"
        pending={saving}
        done={!dirty}
        doneLabel={
          <>
            <Check className="size-3.5" />
            <span className="sr-only">Saved</span>
          </>
        }
        disabled={disabled}
        data-disabled-reason={disabledReason}
        data-testid={testId}
        data-unsaved={dirty || undefined}
        aria-label={label}
        onClick={onSave}
        className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg disabled:cursor-default"
      >
        <Save className="size-3.5" />
        <span className="sr-only">Save</span>
      </PendingButton>
    </ShortcutHint>
  );
}
