/**
 * `@catamorphic/app/ui` — the Catamorphic app UI kit.
 *
 * Polished, dependency-free React components for apps that render inside
 * the Catamorphic shell. Styling is class-based (`cat-*`): the host injects
 * the kit stylesheet (`APP_KIT_CSS`, exported from the package root) into
 * every app guest document, so app authors import components and nothing
 * else — no CSS imports, no theme plumbing. Every color flows through the
 * host theme's `--color-*` tokens; light, dark, and user themes come free.
 */
export { AnimatedList } from "./animated-list.js";
export { Badge } from "./badge.js";
export { Button } from "./button.js";
export { Calendar, type CalendarProps } from "./calendar.js";
export { Card } from "./card.js";
export { Checkbox } from "./checkbox.js";
export {
  DataTable,
  type DataTableColumn,
  type SortDirection,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "./data-table.js";
export { DatePicker, DateRangePicker } from "./date-picker.js";
export {
  addDays,
  addMonths,
  type DateRange,
  formatIsoDate,
  fromIsoDate,
  todayIso,
  toIsoDate,
} from "./dates.js";
export { Dialog } from "./dialog.js";
export { EmptyState } from "./empty-state.js";
export {
  ERROR_STATE_COPY,
  ERROR_STATE_DEFAULT_COPY,
  ErrorState,
} from "./error-state.js";
export { Field, type FieldContextValue, useFieldContext } from "./field.js";
export { Input } from "./input.js";
export { KeyValueList, KeyValueRow } from "./key-value.js";
export { ScrollHint } from "./scroll-hint.js";
export { Select } from "./select.js";
export { Skeleton } from "./skeleton.js";
export { Spinner } from "./spinner.js";
export { Switch } from "./switch.js";
export { Tab, TabList, TabPanel, Tabs } from "./tabs.js";
export { Textarea } from "./textarea.js";
export { Tooltip } from "./tooltip.js";
export { type AsyncState, useAsync } from "./use-async.js";
