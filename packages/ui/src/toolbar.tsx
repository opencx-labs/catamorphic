import { useAtom } from "jotai";
import {
  activePanelTabAtom,
  panelVisibilityAtom,
  rightPanelOpenAtom,
} from "./atoms.js";

export interface ToolbarProps {
  onRun?: () => void;
}

export function Toolbar({ onRun }: ToolbarProps) {
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
          {panelVisibility.minimap ? "⊡ Minimap" : "⊡ Minimap"}
        </button>
      </div>
      <div className="catamorphic-toolbar-right">
        {onRun && (
          <button
            type="button"
            className="catamorphic-toolbar-btn catamorphic-toolbar-run"
            onClick={onRun}
          >
            ▶ Run
          </button>
        )}
      </div>
    </div>
  );
}
