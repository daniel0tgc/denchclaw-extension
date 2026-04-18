"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CrmTableShell } from "./crm-table-shell";
import { buildPeopleColumns, PEOPLE_FIELDS, type PersonRow } from "./people-columns";
import type { FilterGroup, SortRule } from "@/lib/object-filters";

type Filter = "all" | "strongest" | "going_cold" | "recent";

const PRESET_FILTERS: ReadonlyArray<{ id: Filter; label: string }> = [
  { id: "strongest", label: "Strongest" },
  { id: "all", label: "All" },
  { id: "going_cold", label: "Going cold" },
  { id: "recent", label: "Recently added" },
];

const DEFAULT_PAGE_SIZE = 100;

/**
 * People list — full DataTable wrapped in CrmTableShell. Column resize,
 * sticky-first column, sorting, and ObjectFilterBar all come for free
 * from the workspace primitives. Quick-filter chips ("Strongest / Going
 * cold / Recently added") layer on top as opinionated presets.
 *
 * URL state: `?crm=people&q=…&filter=strongest&filters=<base64>&sort=<base64>&page=2&pageSize=50&cols=a,b,c`.
 * The `crm` key is read upstream in workspace-content; everything else is
 * round-tripped here via parseUrlState/serializeUrlState helpers.
 */
export function PeopleListView({
  onOpenPerson,
}: {
  onOpenPerson?: (id: string) => void;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // URL state — initialized from `searchParams` once and then owned here.
  const initial = useMemo(() => parseFromSearchParams(searchParams), []);  // eslint-disable-line react-hooks/exhaustive-deps

  const [filter, setFilter] = useState<Filter>(initial.filter);
  const [search, setSearch] = useState(initial.search);
  const [filters, setFilters] = useState<FilterGroup>(initial.filters);
  // sort is hydrated from the URL but DataTable doesn't yet propagate
  // header-click sort changes back up to us. The slot is wired on the
  // fetch + URL-write paths so a programmatic sort (e.g. saved view)
  // round-trips today.
  const [sort, _setSort] = useState<SortRule[]>(initial.sort);
  const [page, setPage] = useState<number>(initial.page);
  const [pageSize, setPageSize] = useState<number>(initial.pageSize);

  const [people, setPeople] = useState<PersonRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const columns = useMemo(buildPeopleColumns, []);

  // ─── URL sync (write) ──────────────────────────────────────────────────
  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("crm", "people");
    setOrDelete(params, "q", search.trim() || null);
    setOrDelete(params, "filter", filter !== "strongest" ? filter : null);
    setOrDelete(
      params,
      "filters",
      filters.rules.length > 0 ? safeBtoa(JSON.stringify(filters)) : null,
    );
    setOrDelete(params, "sort", sort.length > 0 ? safeBtoa(JSON.stringify(sort)) : null);
    setOrDelete(params, "page", page > 1 ? String(page) : null);
    setOrDelete(params, "pageSize", pageSize !== DEFAULT_PAGE_SIZE ? String(pageSize) : null);
    const next = `/?${params.toString()}`;
    if (next !== `${window.location.pathname}${window.location.search}`) {
      router.replace(next, { scroll: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- searchParams intentionally omitted; this effect writes, the URL is the source of truth elsewhere
  }, [filter, search, filters, sort, page, pageSize, router]);

  // ─── Fetch (debounced) ─────────────────────────────────────────────────
  const load = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (search.trim()) {params.set("q", search.trim());}
        params.set("filter", filter);
        params.set("page", String(page));
        params.set("pageSize", String(pageSize));
        if (filters.rules.length > 0) {
          params.set("filters", safeBtoa(JSON.stringify(filters)));
        }
        if (sort.length > 0) {
          params.set("sort", safeBtoa(JSON.stringify(sort)));
        }
        const res = await fetch(`/api/crm/people?${params.toString()}`, {
          cache: "no-store",
          signal,
        });
        if (!res.ok) {throw new Error(`HTTP ${res.status}`);}
        const body = (await res.json()) as { people: PersonRow[]; total: number };
        setPeople(body.people);
        setTotal(body.total);
      } catch (err) {
        if ((err as Error).name === "AbortError") {return;}
        setError(err instanceof Error ? err.message : "Failed to load people.");
      } finally {
        setLoading(false);
      }
    },
    [filter, search, filters, sort, page, pageSize],
  );

  useEffect(() => {
    if (debounceRef.current) {clearTimeout(debounceRef.current);}
    const controller = new AbortController();
    debounceRef.current = setTimeout(() => {
      void load(controller.signal);
    }, 150);
    return () => {
      controller.abort();
      if (debounceRef.current) {clearTimeout(debounceRef.current);}
    };
  }, [load]);

  const quickFilters = useMemo(() => {
    return PRESET_FILTERS.map((f) => {
      const active = filter === f.id;
      return (
        <button
          key={f.id}
          type="button"
          onClick={() => {
            setFilter(f.id);
            setPage(1);
          }}
          className="rounded-full px-3 py-1 text-[12px] font-medium transition-colors"
          style={{
            background: active ? "var(--color-text)" : "transparent",
            color: active ? "var(--color-background, #fff)" : "var(--color-text-muted)",
            border: active ? "1px solid var(--color-text)" : "1px solid var(--color-border)",
          }}
        >
          {f.label}
        </button>
      );
    });
  }, [filter]);

  return (
    <>
      <CrmTableShell<PersonRow>
        title="People"
        count={total}
        columns={columns}
        data={people}
        loading={loading}
        getRowId={(row) => row.id}
        onRowClick={(row) => onOpenPerson?.(row.id)}
        globalFilter={search}
        onGlobalFilterChange={(v) => {
          setSearch(v);
          setPage(1);
        }}
        fields={[...PEOPLE_FIELDS]}
        filters={filters}
        onFiltersChange={(f) => {
          setFilters(f);
          setPage(1);
        }}
        quickFilters={quickFilters}
        serverPagination={{
          totalCount: total,
          page,
          pageSize,
          onPageChange: setPage,
          onPageSizeChange: (s) => {
            setPageSize(s);
            setPage(1);
          },
        }}
      />
      {error && (
        <div
          className="absolute bottom-3 right-3 rounded-lg border px-3 py-2 text-[12px] shadow-md"
          style={{
            background: "var(--color-surface)",
            borderColor: "var(--color-border)",
            color: "var(--color-text-muted)",
          }}
        >
          {error}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

function parseFromSearchParams(searchParams: URLSearchParams | { toString: () => string }): {
  filter: Filter;
  search: string;
  filters: FilterGroup;
  sort: SortRule[];
  page: number;
  pageSize: number;
} {
  const sp = searchParams instanceof URLSearchParams
    ? searchParams
    : new URLSearchParams(searchParams.toString());
  const filterRaw = sp.get("filter");
  const filter: Filter =
    filterRaw === "all" || filterRaw === "going_cold" || filterRaw === "recent"
      ? filterRaw
      : "strongest";
  const search = sp.get("q") ?? "";
  const filtersRaw = sp.get("filters");
  let filters: FilterGroup = { id: "root", conjunction: "and", rules: [] };
  if (filtersRaw) {
    try {
      const decoded = safeAtob(filtersRaw);
      if (decoded) {filters = JSON.parse(decoded) as FilterGroup;}
    } catch {
      /* ignore */
    }
  }
  const sortRaw = sp.get("sort");
  let sort: SortRule[] = [];
  if (sortRaw) {
    try {
      const decoded = safeAtob(sortRaw);
      if (decoded) {sort = JSON.parse(decoded) as SortRule[];}
    } catch {
      /* ignore */
    }
  }
  const page = Math.max(1, parseInt(sp.get("page") ?? "1", 10) || 1);
  const pageSize = Math.max(10, parseInt(sp.get("pageSize") ?? String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE);
  return { filter, search, filters, sort, page, pageSize };
}

function setOrDelete(params: URLSearchParams, key: string, value: string | null): void {
  if (value === null || value === "") {params.delete(key);}
  else {params.set(key, value);}
}

function safeBtoa(input: string): string {
  if (typeof window !== "undefined" && typeof window.btoa === "function") {
    return window.btoa(input);
  }
  return Buffer.from(input, "utf-8").toString("base64");
}

function safeAtob(input: string): string {
  try {
    if (typeof window !== "undefined" && typeof window.atob === "function") {
      return window.atob(input);
    }
    return Buffer.from(input, "base64").toString("utf-8");
  } catch {
    return "";
  }
}
