"use client";

import { Check, ChevronRight, Circle, CircleDot } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

export interface AgentTodoItem {
  id: string;
  title: string;
  description: string;
  status: "pending" | "in_progress" | "completed";
}

export function TodoProgress({
  todos,
  className = "",
}: {
  todos: readonly AgentTodoItem[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [panelMounted, setPanelMounted] = useState(false);
  const [panelVisible, setPanelVisible] = useState(false);
  const [barMounted, setBarMounted] = useState(todos.length > 0);
  const [barVisible, setBarVisible] = useState(false);
  const [renderedTodos, setRenderedTodos] = useState(todos);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const panelFrameRef = useRef(0);
  const barFrameRef = useRef(0);
  const hasTodos = todos.length > 0;

  useEffect(() => {
    if (open) {
      setPanelMounted(true);
      const firstFrame = requestAnimationFrame(() => {
        const secondFrame = requestAnimationFrame(() => setPanelVisible(true));
        panelFrameRef.current = secondFrame;
      });
      panelFrameRef.current = firstFrame;
      return () => cancelAnimationFrame(panelFrameRef.current);
    }
    setPanelVisible(false);
  }, [open]);

  useEffect(() => {
    if (hasTodos) setRenderedTodos(todos);
  }, [hasTodos, todos]);

  useEffect(() => {
    if (!hasTodos) {
      setOpen(false);
      setBarVisible(false);
      return;
    }
    setBarMounted(true);
    const firstFrame = requestAnimationFrame(() => {
      const secondFrame = requestAnimationFrame(() => setBarVisible(true));
      barFrameRef.current = secondFrame;
    });
    barFrameRef.current = firstFrame;
    return () => cancelAnimationFrame(barFrameRef.current);
  }, [hasTodos]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  useEffect(() => {
    const ids = new Set(renderedTodos.map((todo) => todo.id));
    setExpanded((current) => {
      const next = new Set([...current].filter((id) => ids.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [renderedTodos]);

  if (!barMounted || renderedTodos.length === 0) return null;
  const renderedCompleted = renderedTodos.filter(
    (todo) => todo.status === "completed",
  ).length;
  const fraction = renderedCompleted / renderedTodos.length;
  const radius = 6;
  const circumference = 2 * Math.PI * radius;

  return (
    <div
      ref={rootRef}
      data-testid="todo-progress"
      onTransitionEnd={(event) => {
        if (
          event.target === event.currentTarget &&
          event.propertyName === "opacity" &&
          !barVisible &&
          !hasTodos
        ) {
          setBarMounted(false);
          setRenderedTodos([]);
        }
      }}
      className={`relative shrink-0 transition-[opacity,translate,scale] duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:translate-none motion-reduce:scale-100 motion-reduce:duration-100 ${
        barVisible
          ? "translate-y-0 scale-100 opacity-100"
          : "pointer-events-none -translate-y-1 scale-[0.98] opacity-0"
      } ${className}`}
    >
      <div className="overflow-hidden rounded-lg">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className={`flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border px-2 text-[11px] font-medium transition-colors duration-150 ${
            open
              ? "border-border-strong bg-bg-overlay text-fg"
              : "border-border bg-bg-raised/95 text-fg-muted hover:bg-bg-overlay hover:text-fg"
          }`}
          aria-label={`${renderedCompleted} of ${renderedTodos.length} todo items completed`}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={panelId}
          data-testid="todo-progress-trigger"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            className="-rotate-90"
            aria-hidden="true"
          >
            <circle
              cx="8"
              cy="8"
              r={radius}
              fill="none"
              stroke="var(--color-border-strong)"
              strokeWidth="2"
            />
            <circle
              cx="8"
              cy="8"
              r={radius}
              fill="none"
              stroke="var(--color-accent)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - fraction)}
              className="transition-[stroke-dashoffset] duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:duration-100"
            />
          </svg>
          <span className="tabular-nums">
            {renderedCompleted}/{renderedTodos.length}
          </span>
        </button>
      </div>
      {panelMounted && (
        <div
          id={panelId}
          role="dialog"
          aria-label="Todo list"
          data-testid="todo-progress-popover"
          onTransitionEnd={(event) => {
            if (
              event.target === event.currentTarget &&
              event.propertyName === "opacity" &&
              !panelVisible
            ) {
              setPanelMounted(false);
            }
          }}
          className={`absolute right-0 top-full z-30 mt-1.5 w-80 origin-top-right rounded-lg border border-border bg-bg-raised/95 p-1.5 shadow-2xl backdrop-blur-xl transition-[opacity,translate,scale] duration-150 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:translate-none motion-reduce:scale-100 motion-reduce:duration-100 ${
            panelVisible
              ? "translate-y-0 scale-100 opacity-100"
              : "pointer-events-none -translate-y-1 scale-[0.98] opacity-0"
          }`}
        >
          <div className="flex items-baseline justify-between px-2 py-1.5">
            <span className="text-xs font-semibold text-fg">Todo list</span>
            <span className="text-[11px] tabular-nums text-fg-faint">
              {renderedCompleted} of {renderedTodos.length} done
            </span>
          </div>
          <ul className="max-h-80 list-none overflow-y-auto p-0">
            {renderedTodos.map((todo) => {
              const itemOpen = expanded.has(todo.id);
              const StatusIcon =
                todo.status === "completed"
                  ? Check
                  : todo.status === "in_progress"
                    ? CircleDot
                    : Circle;
              return (
                <li key={todo.id} data-status={todo.status}>
                  <button
                    type="button"
                    onClick={() =>
                      setExpanded((current) => {
                        const next = new Set(current);
                        if (next.has(todo.id)) next.delete(todo.id);
                        else next.add(todo.id);
                        return next;
                      })
                    }
                    className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-100 hover:bg-bg-overlay"
                    aria-expanded={itemOpen}
                  >
                    <StatusIcon
                      className={`size-3.5 shrink-0 ${
                        todo.status === "completed"
                          ? "text-success"
                          : todo.status === "in_progress"
                            ? "text-accent"
                            : "text-fg-faint"
                      }`}
                      aria-hidden="true"
                    />
                    <span
                      className={`min-w-0 flex-1 text-xs ${
                        todo.status === "completed"
                          ? "text-fg-muted line-through"
                          : "text-fg"
                      }`}
                    >
                      {todo.title}
                    </span>
                    <ChevronRight
                      className={`size-3 shrink-0 text-fg-faint transition-transform duration-150 motion-reduce:duration-100 ${itemOpen ? "rotate-90" : ""}`}
                      aria-hidden="true"
                    />
                  </button>
                  <div
                    className={`grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:duration-100 ${
                      itemOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
                    }`}
                    aria-hidden={!itemOpen}
                  >
                    <div className="overflow-hidden">
                      <p className="pb-2 pl-8 pr-3 text-[11px] leading-4 text-fg-muted whitespace-pre-wrap">
                        {todo.description}
                      </p>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
