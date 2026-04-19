"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DynamicIcon, type IconName, iconNames } from "lucide-react/dynamic";
import { CrmObjectIcon } from "./crm-object-icon";

const RECENT_KEY = "denchclaw:icon-picker:recent";
const RECENT_CAP = 18;
const SEARCH_RESULT_CAP = 200;

// Curated CRM-flavored Lucide picks, shown when the search box is empty and
// the user has no recents yet. Keep this list intentional and short — the
// search box is the escape hatch for the full ~1.9k icon catalog.
const POPULAR_ICONS: readonly string[] = [
	"target",
	"user",
	"users",
	"building",
	"building-2",
	"mail",
	"calendar",
	"phone",
	"briefcase",
	"handshake",
	"rocket",
	"star",
	"heart",
	"flag",
	"bookmark",
	"tag",
	"folder",
	"file-text",
	"message-square",
	"send",
	"zap",
	"sparkles",
	"check-square",
	"shield",
	"key",
	"link",
	"globe",
	"map-pin",
	"dollar-sign",
	"trending-up",
];

// Pre-validate POPULAR_ICONS at module load — typos surface immediately.
const POPULAR_VALID: string[] = POPULAR_ICONS.filter((n) => iconNames.includes(n as IconName));

function loadRecent(): string[] {
	if (typeof window === "undefined") return [];
	try {
		const raw = window.localStorage.getItem(RECENT_KEY);
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((x): x is string => typeof x === "string" && iconNames.includes(x as IconName)).slice(0, RECENT_CAP);
	} catch {
		return [];
	}
}

function saveRecent(name: string) {
	if (typeof window === "undefined") return;
	try {
		const current = loadRecent();
		const next = [name, ...current.filter((x) => x !== name)].slice(0, RECENT_CAP);
		window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
	} catch {
		// localStorage may be disabled — non-fatal.
	}
}

type IconPickerProps = {
	/** Current icon name (kebab-case Lucide name) or null/undefined for "no icon". */
	value: string | null | undefined;
	/** Called with the chosen icon name (or null when cleared). */
	onChange: (next: string | null) => void;
	/** Optional title for the trigger button. */
	title?: string;
};

export function IconPicker({ value, onChange, title }: IconPickerProps) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [recent, setRecent] = useState<string[]>([]);
	const popoverRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!open) return;
		setRecent(loadRecent());
		setQuery("");
		// Defer focus so the input is mounted before we grab it.
		const id = window.setTimeout(() => inputRef.current?.focus(), 10);
		return () => window.clearTimeout(id);
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const handler = (e: MouseEvent) => {
			if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
				setOpen(false);
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setOpen(false);
			}
		};
		document.addEventListener("keydown", handler);
		return () => document.removeEventListener("keydown", handler);
	}, [open]);

	const trimmedQuery = query.trim().toLowerCase();
	const searchResults = useMemo<string[]>(() => {
		if (!trimmedQuery) return [];
		const out: string[] = [];
		for (const n of iconNames) {
			if (n.includes(trimmedQuery)) {
				out.push(n);
				if (out.length >= SEARCH_RESULT_CAP) break;
			}
		}
		return out;
	}, [trimmedQuery]);

	const handleSelect = useCallback((name: string) => {
		onChange(name);
		saveRecent(name);
		setOpen(false);
	}, [onChange]);

	const handleClear = useCallback(() => {
		onChange(null);
		setOpen(false);
	}, [onChange]);

	return (
		<div className="relative" ref={popoverRef}>
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="flex items-center justify-center w-7 h-7 rounded-md transition-colors cursor-pointer"
				style={{
					color: "var(--color-text-muted)",
					background: open ? "var(--color-surface-hover)" : "transparent",
				}}
				onMouseEnter={(e) => {
					(e.currentTarget as HTMLElement).style.background = "var(--color-surface-hover)";
				}}
				onMouseLeave={(e) => {
					if (open) return;
					(e.currentTarget as HTMLElement).style.background = "transparent";
				}}
				title={title ?? "Change icon"}
				aria-label="Change icon"
				aria-expanded={open}
			>
				<CrmObjectIcon name={value ?? null} size={16} />
			</button>

			{open && (
				<div
					className="absolute left-0 top-full mt-1 z-50 rounded-lg border shadow-lg flex flex-col"
					style={{
						borderColor: "var(--color-border)",
						background: "var(--color-surface)",
						boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
						width: 320,
						maxWidth: "calc(100vw - 2rem)",
					}}
				>
					<div className="p-2 border-b" style={{ borderColor: "var(--color-border)" }}>
						<input
							ref={inputRef}
							type="text"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Search icons…"
							className="w-full px-2 py-1.5 rounded-md text-[12px] outline-none border"
							style={{
								color: "var(--color-text)",
								background: "var(--color-bg)",
								borderColor: "var(--color-border)",
							}}
						/>
					</div>

					<div className="overflow-y-auto" style={{ maxHeight: 320 }}>
						{trimmedQuery ? (
							<IconGrid icons={searchResults} value={value ?? null} onSelect={handleSelect} emptyText="No icons found" />
						) : (
							<>
								{recent.length > 0 && (
									<Section label="Recent">
										<IconGrid icons={recent} value={value ?? null} onSelect={handleSelect} />
									</Section>
								)}
								<Section label="Popular">
									<IconGrid icons={POPULAR_VALID} value={value ?? null} onSelect={handleSelect} />
								</Section>
							</>
						)}
					</div>

					<div
						className="px-3 py-2 border-t flex items-center justify-between"
						style={{ borderColor: "var(--color-border)" }}
					>
						<button
							type="button"
							onClick={handleClear}
							className="text-[11px] transition-colors cursor-pointer"
							style={{ color: "var(--color-text-muted)" }}
							onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--color-text)"; }}
							onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--color-text-muted)"; }}
						>
							Clear icon
						</button>
						<span className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>
							lucide icons
						</span>
					</div>
				</div>
			)}
		</div>
	);
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="px-2 pt-2 pb-1">
			<div
				className="px-1 pb-1 text-[9px] lowercase"
				style={{ color: "var(--color-text-muted)", letterSpacing: "0.05em" }}
			>
				{label}
			</div>
			{children}
		</div>
	);
}

function IconGrid({
	icons,
	value,
	onSelect,
	emptyText,
}: {
	icons: string[];
	value: string | null;
	onSelect: (name: string) => void;
	emptyText?: string;
}) {
	if (icons.length === 0) {
		return (
			<div className="py-6 text-center text-[11px]" style={{ color: "var(--color-text-muted)" }}>
				{emptyText ?? "No icons"}
			</div>
		);
	}
	return (
		<div
			className="grid gap-0.5"
			style={{ gridTemplateColumns: "repeat(auto-fill, 32px)" }}
		>
			{icons.map((name) => {
				const active = name === value;
				return (
					<button
						key={name}
						type="button"
						onClick={() => onSelect(name)}
						className="w-8 h-8 rounded-md flex items-center justify-center transition-colors cursor-pointer"
						style={{
							color: "var(--color-text)",
							background: active ? "var(--color-chat-sidebar-active-bg)" : "transparent",
						}}
						onMouseEnter={(e) => {
							if (active) return;
							(e.currentTarget as HTMLElement).style.background = "var(--color-surface-hover)";
						}}
						onMouseLeave={(e) => {
							if (active) return;
							(e.currentTarget as HTMLElement).style.background = "transparent";
						}}
						title={name}
						aria-label={name}
					>
						<DynamicIcon name={name as IconName} size={16} />
					</button>
				);
			})}
		</div>
	);
}
