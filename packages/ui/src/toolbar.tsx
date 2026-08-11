import {
  activePanelTabAtom,
  panelVisibilityAtom,
  rightPanelOpenAtom,
} from "@catamorphic/react";
import { useAtom } from "jotai";
import type { ReactNode } from "react";

export interface ToolbarProps {
  onRun?: () => void;
  isRunning?: boolean;
  /** Optional content rendered in the center of the toolbar (e.g. version label). */
  centerSlot?: ReactNode;
}

export function Toolbar({ onRun, isRunning, centerSlot }: ToolbarProps) {
  const [panelVisibility, setPanelVisibility] = useAtom(panelVisibilityAtom);
  const [rightPanelOpen, setRightPanelOpen] = useAtom(rightPanelOpenAtom);
  const [, setActiveTab] = useAtom(activePanelTabAtom);

  return (
    <div className="catamorphic-toolbar">
      <div className="catamorphic-toolbar-left">
        <button
          type="button"
          className={`catamorphic-toolbar-btn ${rightPanelOpen ? "catamorphic-toolbar-btn-active" : ""}`}
          onClick={() => {
            if (rightPanelOpen) {
              setRightPanelOpen(false);
            } else {
              setRightPanelOpen(true);
              setActiveTab("code");
            }
          }}
        >
          {rightPanelOpen ? "⌨ Hide Panel" : "⌨ Show Panel"}
        </button>
        <button
          type="button"
          className="catamorphic-toolbar-btn"
          onClick={() =>
            setPanelVisibility((v) => ({ ...v, minimap: !v.minimap }))
          }
        >
          ⊡ Minimap
        </button>
      </div>
      {centerSlot && (
        <div className="catamorphic-toolbar-center">{centerSlot}</div>
      )}
      <div className="catamorphic-toolbar-right">
        <button
          type="button"
          className={`catamorphic-toolbar-btn ${panelVisibility.runsPanel ? "catamorphic-toolbar-btn-active" : ""}`}
          onClick={() =>
            setPanelVisibility((current) => ({
              ...current,
              runsPanel: !current.runsPanel,
            }))
          }
        >
          ⏱ Runs
        </button>
        {onRun && (
          <button
            type="button"
            className="catamorphic-toolbar-btn catamorphic-toolbar-run"
            onClick={onRun}
            disabled={isRunning}
          >
            {isRunning ? "Running..." : "Run"}
          </button>
        )}
      </div>
    </div>
  );
}
