/**
 * Per-table view state — search, filters, sort, view selection, column
 * visibility, page size, etc. — keyed by object name and persisted in
 * localStorage.
 *
 * Why this exists: previously these params lived in the URL as a single
 * global slot. When the user switched tables, the URL preserved them
 * (`workspace-content.tsx`'s shell-level URL effect intentionally carried
 * "object-view params" across path changes), so the new table inherited the
 * previous table's filter / search. View state is fundamentally a property
 * of *a table*, not *the URL*: each table should remember its own view, and
 * coming back to a table should restore exactly what you left it on.
 *
 * Trade-off: we lose `?search=foo&path=A` style shareable URLs (filters
 * become a personal, per-device preference, not a piece of shared state).
 * That matches user mental model — filters are "how I'm looking at this
 * table right now", not "what URL describes this view to others". For
 * one-off deep links we still consult the URL on first mount when
 * localStorage has no entry for that table (`hydrateFromUrl` in the
 * caller), so a freshly-followed `?search=…` link still works once.
 */

import type { FilterGroup, SortRule, ViewType } from "./object-filters";

const STORAGE_KEY = "dench:table-view-state:v1";

export type TableViewState = {
	view?: string;
	viewType?: ViewType;
	filters?: FilterGroup;
	search?: string;
	sort?: SortRule[];
	page?: number;
	pageSize?: number;
	cols?: string[];
};

type Bag = Record<string, TableViewState>;

function readBag(): Bag {
	if (typeof window === "undefined") return {};
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw);
		return typeof parsed === "object" && parsed != null ? (parsed as Bag) : {};
	} catch {
		return {};
	}
}

function writeBag(bag: Bag): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(bag));
	} catch {
		// Quota / disabled storage — silently no-op; in-memory state still works.
	}
}

/** True if `s` has no meaningful view customizations (so we can skip storing). */
function isEmptyState(s: TableViewState): boolean {
	return (
		!s.view &&
		!s.viewType &&
		!(s.filters && s.filters.rules.length > 0) &&
		!(s.search && s.search.length > 0) &&
		!(s.sort && s.sort.length > 0) &&
		!s.page &&
		!s.pageSize &&
		!(s.cols && s.cols.length > 0)
	);
}

export function loadTableViewState(objectName: string): TableViewState {
	if (!objectName) return {};
	return readBag()[objectName] ?? {};
}

export function saveTableViewState(
	objectName: string,
	state: TableViewState,
): void {
	if (!objectName) return;
	const bag = readBag();
	if (isEmptyState(state)) {
		if (objectName in bag) {
			delete bag[objectName];
			writeBag(bag);
		}
		return;
	}
	bag[objectName] = state;
	writeBag(bag);
}

/**
 * Strip view-state query params from a URL string. Used after hydrating from
 * a deep link so the URL stops being a (now-stale) source of truth for view
 * state — subsequent navigations / table switches won't carry inherited
 * filters from the URL.
 */
export const TABLE_VIEW_URL_KEYS = [
	"viewType",
	"view",
	"filters",
	"search",
	"sort",
	"page",
	"pageSize",
	"cols",
] as const;
