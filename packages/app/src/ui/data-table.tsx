import type { ComponentProps, ReactNode } from "react";
import { useMemo, useState } from "react";
import { cx } from "./cx.js";
import { EmptyState } from "./empty-state.js";
import { Skeleton } from "./skeleton.js";

export interface DataTableColumn<Row> {
  /** Row property this column shows (and sorts by). */
  key: Extract<keyof Row, string> | (string & {});
  header: ReactNode;
  align?: "left" | "right" | "center";
  /** CSS width (number = px). Unset columns share the rest. */
  width?: number | string;
  /** Enables click-to-sort on this column (client-side). */
  sortable?: boolean;
  /** Custom cell renderer; defaults to `String(row[key])`. */
  render?: (row: Row) => ReactNode;
}

export type SortDirection = "asc" | "desc";

/**
 * The kit's data table: typed columns, client-side sorting (click a
 * sortable header to cycle asc/desc; `aria-sort` announced; the sort
 * affordance appears on hover and stays while sorted), sticky header on
 * the raised surface with a hairline, 28px rows with a hover tint — and
 * the three data states built in: `loading` renders skeleton rows, an
 * empty `rows` renders the quiet empty state, `truncated` appends a muted
 * "Showing first N" footer row.
 *
 * The wrapper scrolls horizontally on its own (`overflow: auto`) so wide
 * tables never make the page scroll sideways. For fully hand-rolled cases
 * use the plain {@link Table} set instead.
 */
export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  loading = false,
  loadingRows = 5,
  empty,
  truncated = false,
  defaultSort,
  maxHeight,
  className,
}: {
  columns: Array<DataTableColumn<Row>>;
  rows: readonly Row[];
  /** Stable key per row (index fallback if omitted — fine for static lists). */
  rowKey?: (row: Row) => string | number;
  /** Renders skeleton rows in place of data. */
  loading?: boolean;
  /** How many skeleton rows while loading. */
  loadingRows?: number;
  /** Empty-state content: a string becomes the quiet one-liner; a node renders as-is. */
  empty?: ReactNode;
  /** Marks the list as cut off: muted "Showing first N" footer row. */
  truncated?: boolean;
  /** Initial sort. */
  defaultSort?: { key: string; direction: SortDirection };
  /** Constrains height (CSS value); the sticky header earns its keep here. */
  maxHeight?: number | string;
  className?: string;
}) {
  const [sort, setSort] = useState<{
    key: string;
    direction: SortDirection;
  } | null>(defaultSort ?? null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const { key, direction } = sort;
    const factor = direction === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const left = (a as Record<string, unknown>)[key];
      const right = (b as Record<string, unknown>)[key];
      if (left == null && right == null) return 0;
      if (left == null) return 1; // nulls last, both directions
      if (right == null) return -1;
      if (typeof left === "number" && typeof right === "number") {
        return (left - right) * factor;
      }
      return String(left).localeCompare(String(right)) * factor;
    });
  }, [rows, sort]);

  const cycleSort = (key: string) => {
    setSort((current) =>
      current?.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: "asc" },
    );
  };

  const columnCount = columns.length;
  const showEmpty = !loading && sorted.length === 0;

  return (
    <div
      className={cx("cat-table-wrap", className)}
      style={maxHeight != null ? { maxHeight } : undefined}
    >
      <table className="cat-table">
        <thead>
          <tr>
            {columns.map((column) => {
              const active = sort?.key === column.key;
              return (
                <th
                  key={column.key}
                  data-align={column.align}
                  style={
                    column.width != null ? { width: column.width } : undefined
                  }
                  aria-sort={
                    active
                      ? sort?.direction === "asc"
                        ? "ascending"
                        : "descending"
                      : undefined
                  }
                >
                  {column.sortable ? (
                    <button
                      type="button"
                      className="cat-table-sort"
                      onClick={() => cycleSort(column.key)}
                    >
                      {column.header}
                      <span className="cat-table-arrow" aria-hidden="true">
                        {active && sort?.direction === "desc" ? "▼" : "▲"}
                      </span>
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading
            ? Array.from({ length: loadingRows }, (_, rowIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows have no identity
                <tr key={rowIndex}>
                  {columns.map((column, columnIndex) => (
                    <td key={column.key} data-align={column.align}>
                      <Skeleton
                        height={11}
                        width={`${55 + ((rowIndex * 7 + columnIndex * 13) % 36)}%`}
                      />
                    </td>
                  ))}
                </tr>
              ))
            : sorted.map((row, index) => (
                <tr key={rowKey ? rowKey(row) : index}>
                  {columns.map((column) => (
                    <td key={column.key} data-align={column.align}>
                      {column.render
                        ? column.render(row)
                        : formatCell(
                            (row as Record<string, unknown>)[column.key],
                          )}
                    </td>
                  ))}
                </tr>
              ))}
          {showEmpty ? (
            <tr>
              <td className="cat-table-state" colSpan={columnCount}>
                {typeof empty === "string" || empty == null ? (
                  <EmptyState message={empty ?? "Nothing to show."} />
                ) : (
                  empty
                )}
              </td>
            </tr>
          ) : null}
        </tbody>
        {truncated && !loading && sorted.length > 0 ? (
          <tfoot>
            <tr className="cat-table-foot">
              <td colSpan={columnCount}>Showing first {sorted.length}</td>
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}

function formatCell(value: unknown): ReactNode {
  if (value == null) return null;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value as string | number | boolean);
}

/* ------------------------------------------------------------------ */
/* Plain styled table set, for hand-rolled cases the typed DataTable   */
/* doesn't fit. Same classes, so the two look identical.               */
/* ------------------------------------------------------------------ */

/** Scrolling wrapper + `<table>`; children are the plain sections below. */
export function Table({
  className,
  wrapClassName,
  maxHeight,
  children,
  ...rest
}: {
  /** Class for the outer scrolling wrapper. */
  wrapClassName?: string;
  /** Constrains height; header sticks. */
  maxHeight?: number | string;
} & ComponentProps<"table">) {
  return (
    <div
      className={cx("cat-table-wrap", wrapClassName)}
      style={maxHeight != null ? { maxHeight } : undefined}
    >
      <table {...rest} className={cx("cat-table", className)}>
        {children}
      </table>
    </div>
  );
}

export function TableHead(props: ComponentProps<"thead">) {
  return <thead {...props} />;
}

export function TableBody(props: ComponentProps<"tbody">) {
  return <tbody {...props} />;
}

export function TableRow(props: ComponentProps<"tr">) {
  return <tr {...props} />;
}

export function TableHeaderCell({
  align,
  ...rest
}: { align?: "left" | "right" | "center" } & ComponentProps<"th">) {
  return <th {...rest} data-align={align} />;
}

export function TableCell({
  align,
  ...rest
}: { align?: "left" | "right" | "center" } & ComponentProps<"td">) {
  return <td {...rest} data-align={align} />;
}
