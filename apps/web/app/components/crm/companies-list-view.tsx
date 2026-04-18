"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CrmTableShell } from "./crm-table-shell";
import {
  buildCompaniesColumns,
  COMPANIES_FIELDS,
  type CompanyRow,
} from "./companies-columns";
import type { FilterGroup, SortRule } from "@/lib/object-filters";

const DEFAULT_PAGE_SIZE = 100;

export function CompaniesListView({
  onOpenCompany,
}: {
  onOpenCompany?: (id: string) => void;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const initial = useMemo(() => parseFromSearchParams(searchParams), []);  // eslint-disable-line react-hooks/exhaustive-deps

  const [search, setSearch] = useState(initial.search);
  const [filters, setFilters] = useState<FilterGroup>(initial.filters);
  // See note in people-list-view: sort is round-trippable but
  // header-click sorting isn't wired through DataTable yet.
  const [sort, _setSort] = useState<SortRule[]>(initial.sort);
  const [page, setPage] = useState<number>(initial.page);
  const [pageSize, setPageSize] = useState<number>(initial.pageSize);

  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const columns = useMemo(buildCompaniesColumns, []);

  // ─── URL sync (write) ──────────────────────────────────────────────────
  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("crm", "companies");
    setOrDelete(params, "q", search.trim() || null);
    setOrDelete(
      params,
      "filters",
      filters.rules.length > 0 ? safeBtoa(JSON.stringify(filters)) : null,
    );
    setOrDelete(params, "sort", sort.length > 0 ? safeBtoa(JSON.stringify(sort)) : null);
    setOrDelete(params, "page", page > 1 ? String(page) : null);
    setOrDelete(
      params,
      "pageSize",
      pageSize !== DEFAULT_PAGE_SIZE ? String(pageSize) : null,
    );
    const next = `/?${params.toString()}`;
    if (next !== `${window.location.pathname}${window.location.search}`) {
      router.replace(next, { scroll: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional one-way write
  }, [search, filters, sort, page, pageSize, router]);

  // ─── Fetch ─────────────────────────────────────────────────────────────
  const load = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (search.trim()) {params.set("q", search.trim());}
        params.set("page", String(page));
        params.set("pageSize", String(pageSize));
        if (filters.rules.length > 0) {
          params.set("filters", safeBtoa(JSON.stringify(filters)));
        }
        if (sort.length > 0) {
          params.set("sort", safeBtoa(JSON.stringify(sort)));
        }
        const res = await fetch(`/api/crm/companies?${params.toString()}`, {
          cache: "no-store",
          signal,
        });
        if (!res.ok) {throw new Error(`HTTP ${res.status}`);}
        const body = (await res.json()) as { companies: CompanyRow[]; total: number };
        setCompanies(body.companies);
        setTotal(body.total);
      } catch (err) {
        if ((err as Error).name === "AbortError") {return;}
        setError(err instanceof Error ? err.message : "Failed to load companies.");
      } finally {
        setLoading(false);
      }
    },
    [search, filters, sort, page, pageSize],
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

  return (
    <>
      <CrmTableShell<CompanyRow>
        title="Companies"
        count={total}
        columns={columns}
        data={companies}
        loading={loading}
        getRowId={(row) => row.id}
        onRowClick={(row) => onOpenCompany?.(row.id)}
        globalFilter={search}
        onGlobalFilterChange={(v) => {
          setSearch(v);
          setPage(1);
        }}
        fields={[...COMPANIES_FIELDS]}
        filters={filters}
        onFiltersChange={(f) => {
          setFilters(f);
          setPage(1);
        }}
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
  search: string;
  filters: FilterGroup;
  sort: SortRule[];
  page: number;
  pageSize: number;
} {
  const sp = searchParams instanceof URLSearchParams
    ? searchParams
    : new URLSearchParams(searchParams.toString());
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
  const pageSize = Math.max(
    10,
    parseInt(sp.get("pageSize") ?? String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE,
  );
  return { search, filters, sort, page, pageSize };
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
