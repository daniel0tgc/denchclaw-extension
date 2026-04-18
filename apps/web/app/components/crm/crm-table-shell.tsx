"use client";

import { type ReactNode, useCallback, useMemo } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, type ColumnSizingState } from "../workspace/data-table";
import { ObjectFilterBar } from "../workspace/object-filter-bar";
import { ViewTypeSwitcher } from "../workspace/view-type-switcher";
import { Input } from "../ui/input";
import type { FilterGroup, SavedView, ViewType } from "@/lib/object-filters";

/**
 * Field shape consumed by ObjectFilterBar. Mirrors the local `Field` type
 * inside object-filter-bar.tsx — kept here to avoid forcing the shell's
 * callers to know the workspace internals.
 */
export type CrmField = {
  id: string;
  name: string;
  type: string;
  enum_values?: string[];
  enum_colors?: string[];
  enum_multiple?: boolean;
  related_object_name?: string;
};

export type CrmTableShellProps<TData> = {
  /** Section title shown in the header (rendered with Instrument Serif). */
  title: string;
  /** Result count shown next to the title. */
  count?: number | null;

  /** TanStack column defs. Provided by people-columns / companies-columns. */
  columns: ColumnDef<TData>[];
  data: TData[];
  loading?: boolean;

  /** Stable id selector — required for sticky active-row highlighting. */
  getRowId: (row: TData) => string;
  /** Whole-row click handler (Attio convention; profile opens on click). */
  onRowClick?: (row: TData, index: number) => void;
  /** id of the row currently active in the side panel / profile. */
  activeRowId?: string;

  /** Controlled global search; hooked to the parent's debounced fetch. */
  globalFilter: string;
  onGlobalFilterChange: (value: string) => void;
  onServerSearch?: (value: string) => void;

  /** Server-side pagination passthrough — required when total > pageSize. */
  serverPagination?: {
    totalCount: number;
    page: number;
    pageSize: number;
    onPageChange: (page: number) => void;
    onPageSizeChange: (size: number) => void;
  };

  /** Filter bar wiring. */
  fields: CrmField[];
  filters: FilterGroup;
  onFiltersChange: (filters: FilterGroup) => void;

  /** Saved views — optional; reuses ObjectFilterBar's saved-view popover. */
  savedViews?: SavedView[];
  activeViewName?: string;
  onSaveView?: (name: string) => void;
  onLoadView?: (view: SavedView) => void;
  onDeleteView?: (name: string) => void;
  onSetActiveView?: (name: string | undefined) => void;

  /**
   * View type switcher (table / kanban / calendar / etc). For now CRM only
   * supports table — but rendering the switcher keeps the visual parity
   * with ObjectView so it doesn't feel like a different product.
   */
  viewType?: ViewType;
  onViewTypeChange?: (v: ViewType) => void;

  /**
   * Quick-filter chip strip rendered above the toolbar (e.g. People's
   * "Strongest / Going cold / Recently added"). Optional.
   */
  quickFilters?: ReactNode;

  /** Column visibility persistence (URL `cols` param). */
  columnVisibility?: Record<string, boolean>;
  onColumnVisibilityChanged?: (vis: Record<string, boolean>) => void;
  initialColumnSizing?: ColumnSizingState;
  onColumnSizingChange?: (sizing: ColumnSizingState) => void;
};

/**
 * The CRM-flavored shell that gives People + Companies the same visual
 * weight as the workspace ObjectView (sortable / resizable / sticky-first
 * column / saved-views) while keeping CRM-specific affordances (whole-row
 * click → profile, quick-filter pills, no inline edit).
 *
 * Layout matches `ObjectView`: a header strip with title + count + filter
 * controls, then the table fills the remaining height (`flex-1 min-h-0`)
 * and DataTable owns vertical scroll internally.
 */
export function CrmTableShell<TData>({
  title,
  count,
  columns,
  data,
  loading,
  getRowId,
  onRowClick,
  activeRowId,
  globalFilter,
  onGlobalFilterChange,
  onServerSearch,
  serverPagination,
  fields,
  filters,
  onFiltersChange,
  savedViews,
  activeViewName,
  onSaveView,
  onLoadView,
  onDeleteView,
  onSetActiveView,
  viewType = "table",
  onViewTypeChange,
  quickFilters,
  columnVisibility,
  onColumnVisibilityChanged,
  initialColumnSizing,
  onColumnSizingChange,
}: CrmTableShellProps<TData>) {
  const noopSavedViews = useMemo<SavedView[]>(() => [], []);
  const noop = useCallback(() => {
    /* noop */
  }, []);

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden"
      style={{ background: "var(--color-main-bg)" }}
    >
      {/* Header */}
      <header
        className="shrink-0 flex flex-wrap items-center gap-3 px-6 py-3"
        style={{ borderBottom: "1px solid var(--color-border)" }}
      >
        <div className="flex items-baseline gap-3 min-w-0">
          <h1
            className="font-instrument text-2xl tracking-tight truncate"
            style={{ color: "var(--color-text)" }}
          >
            {title}
          </h1>
          {typeof count === "number" && (
            <span className="text-[12px]" style={{ color: "var(--color-text-muted)" }}>
              {count.toLocaleString()}
            </span>
          )}
        </div>
        <div className="flex-1" />
        {onViewTypeChange && (
          <ViewTypeSwitcher value={viewType} onChange={onViewTypeChange} />
        )}
        <Input
          placeholder={`Search ${title.toLowerCase()}…`}
          value={globalFilter}
          onChange={(e) => {
            const next = e.target.value;
            onGlobalFilterChange(next);
            onServerSearch?.(next);
          }}
          className="h-8 w-56 text-[13px]"
        />
      </header>

      {/* Filter bar */}
      <div
        className="shrink-0 px-6 py-2"
        style={{ borderBottom: "1px solid var(--color-border)" }}
      >
        <ObjectFilterBar
          fields={fields}
          filters={filters}
          onFiltersChange={onFiltersChange}
          savedViews={savedViews ?? noopSavedViews}
          activeViewName={activeViewName}
          onSaveView={onSaveView ?? noop}
          onLoadView={onLoadView ?? noop}
          onDeleteView={onDeleteView ?? noop}
          onSetActiveView={onSetActiveView ?? noop}
        />
      </div>

      {/* Quick filters (preset pills) — optional */}
      {quickFilters && (
        <div
          className="shrink-0 flex flex-wrap items-center gap-1 px-6 py-2"
          style={{ borderBottom: "1px solid var(--color-border)" }}
        >
          {quickFilters}
        </div>
      )}

      {/* Table — owns its own scroll */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <DataTable
          columns={columns}
          data={data}
          loading={loading}
          hideToolbar
          enableSorting
          enableGlobalFilter
          globalFilter={globalFilter}
          onGlobalFilterChange={onGlobalFilterChange}
          onServerSearch={onServerSearch}
          getRowId={getRowId}
          onRowClick={onRowClick}
          activeRowId={activeRowId}
          stickyFirstColumn
          serverPagination={serverPagination}
          initialColumnVisibility={columnVisibility}
          onColumnVisibilityChanged={onColumnVisibilityChanged}
          initialColumnSizing={initialColumnSizing}
          onColumnSizingChange={onColumnSizingChange}
        />
      </div>
    </div>
  );
}
