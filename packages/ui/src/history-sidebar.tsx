import { useAtom, useSetAtom } from "jotai";
import {
  activeHistoryTabAtom,
  type HistoryTab,
  historySidebarOpenAtom,
} from "./atoms.js";
import { RunsPanel } from "./runs-panel.js";

function VersionsPanel() {
  return (
    <div className="catamorphic-versions-empty">
      <div className="catamorphic-versions-empty-icon">⎇</div>
      <p>No versions yet</p>
      <p className="catamorphic-versions-empty-hint">
        Code versions will appear here as you make changes
      </p>
    </div>
  );
}

export function HistorySidebar() {
  const setOpen = useSetAtom(historySidebarOpenAtom);
  const [activeTab, setActiveTab] = useAtom(activeHistoryTabAtom);

  const tabs: { id: HistoryTab; label: string }[] = [
    { id: "runs", label: "Runs" },
    { id: "versions", label: "Versions" },
  ];

  return (
    <div className="catamorphic-history-sidebar">
      <div className="catamorphic-history-sidebar-header">
        <div className="catamorphic-detail-tabs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`catamorphic-detail-tab ${activeTab === tab.id ? "catamorphic-detail-tab-active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="catamorphic-detail-close"
          onClick={() => setOpen(false)}
          aria-label="Close history"
        >
          ✕
        </button>
      </div>
      <div className="catamorphic-history-sidebar-body">
        {activeTab === "runs" && <RunsPanel />}
        {activeTab === "versions" && <VersionsPanel />}
      </div>
    </div>
  );
}
