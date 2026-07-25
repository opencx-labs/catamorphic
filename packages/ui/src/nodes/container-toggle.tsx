import { collapsedNodeIdsAtom } from "@catamorphic/react";
import { useSetAtom } from "jotai";
import { ChevronDown } from "lucide-react";
import type { MouseEvent } from "react";

export function ContainerToggle({
  nodeId,
  collapsed,
  label,
}: {
  nodeId: string;
  collapsed: boolean;
  label: string;
}) {
  const setCollapsed = useSetAtom(collapsedNodeIdsAtom);
  const toggle = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setCollapsed((current: Set<string>) => {
      const next = new Set(current);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  };

  return (
    <button
      type="button"
      className="catamorphic-container-toggle"
      data-collapsed={collapsed}
      aria-label={`${collapsed ? "Expand" : "Collapse"} ${label}`}
      onClick={toggle}
    >
      <ChevronDown aria-hidden="true" size={14} strokeWidth={2} />
    </button>
  );
}
