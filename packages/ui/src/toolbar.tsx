import { useAtom } from "jotai";
import {
  activePanelTabAtom,
  historySidebarOpenAtom,
  panelVisibilityAtom,
  rightPanelOpenAtom,
} from "./atoms.js";

export interface ToolbarProps {
  onRun?: () => void;
  isRunning?: boolean;
}

export function Toolbar({ onRun, isRunning }: ToolbarProps) {
  const [, setPanelVisibility] = useAtom(panelVisibilityAtom);
  const [rightPanelOpen, setRightPanelOpen] = useAtom(rightPanelOpenAtom);
  const [, setActiveTab] = useAtom(activePanelTabAtom);
  const [historySidebarOpen, setHistorySidebarOpen] = useAtom(
    historySidebarOpenAtom,
  );

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
      <div className="catamorphic-toolbar-right">
        <button
          type="button"
          className={`catamorphic-toolbar-btn ${historySidebarOpen ? "catamorphic-toolbar-btn-active" : ""}`}
          onClick={() => setHistorySidebarOpen((v) => !v)}
        >
          ⏱ History
        </button>
        {onRun && (
          <button
            type="button"
            className="catamorphic-toolbar-btn catamorphic-toolbar-run"
            onClick={onRun}
            disabled={isRunning}
          >
            {isRunning ? "⟳ Running..." : "▶ Run"}
          </button>
        )}
      </div>
    </div>
  );
}
