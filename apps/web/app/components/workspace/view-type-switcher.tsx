"use client";

import { useState, useRef, useEffect, type ReactElement } from "react";
import { type ViewType, VIEW_TYPES } from "@/lib/object-filters";

// ---------------------------------------------------------------------------
// Icons for each view type
// ---------------------------------------------------------------------------

function TableIcon() {
	return (
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="M12 3v18" /><path d="M3 12h18" /><rect width="18" height="18" x="3" y="3" rx="2" />
		</svg>
	);
}

function KanbanIcon() {
	return (
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<rect width="6" height="14" x="3" y="5" rx="1" /><rect width="6" height="10" x="9" y="9" rx="1" /><rect width="6" height="16" x="15" y="3" rx="1" />
		</svg>
	);
}

function CalendarIcon() {
	return (
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<rect width="18" height="18" x="3" y="4" rx="2" /><path d="M16 2v4" /><path d="M8 2v4" /><path d="M3 10h18" />
		</svg>
	);
}

function TimelineIcon() {
	return (
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="M3 6h7" /><path d="M6 12h10" /><path d="M5 18h5" /><path d="M14 6h7" /><path d="M18 12h3" /><path d="M12 18h9" />
		</svg>
	);
}

function GalleryIcon() {
	return (
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<rect width="7" height="7" x="3" y="3" rx="1" /><rect width="7" height="7" x="14" y="3" rx="1" />
			<rect width="7" height="7" x="3" y="14" rx="1" /><rect width="7" height="7" x="14" y="14" rx="1" />
		</svg>
	);
}

function ListIcon() {
	return (
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /><path d="M3 6h.01" /><path d="M3 12h.01" /><path d="M3 18h.01" />
		</svg>
	);
}

function ChevronDownIcon() {
	return (
		<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="m6 9 6 6 6-6" />
		</svg>
	);
}

const VIEW_TYPE_META: Record<ViewType, { icon: () => ReactElement; label: string }> = {
	table: { icon: TableIcon, label: "Table" },
	kanban: { icon: KanbanIcon, label: "Board" },
	calendar: { icon: CalendarIcon, label: "Calendar" },
	timeline: { icon: TimelineIcon, label: "Timeline" },
	gallery: { icon: GalleryIcon, label: "Gallery" },
	list: { icon: ListIcon, label: "List" },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type ViewTypeSwitcherProps = {
	value: ViewType;
	onChange: (type: ViewType) => void;
	collapsed?: boolean;
};

export function ViewTypeSwitcher({ value, onChange, collapsed = false }: ViewTypeSwitcherProps) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const handler = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) {
				setOpen(false);
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [open]);

	if (collapsed) {
		const activeMeta = VIEW_TYPE_META[value];
		const ActiveIcon = activeMeta.icon;
		return (
			<div ref={ref} className="relative inline-block flex-shrink-0">
				<button
					type="button"
					onClick={() => setOpen((v) => !v)}
					className="flex items-center gap-1.5 px-2.5 py-1 text-[12px] rounded-md transition-colors cursor-pointer"
					style={{
						background: "var(--color-surface-hover)",
						color: "var(--color-text)",
						fontWeight: 500,
					}}
				>
					<ActiveIcon />
					<span>{activeMeta.label}</span>
					<ChevronDownIcon />
				</button>
				{open && (
					<div
						className="absolute z-50 mt-1 left-0 rounded-lg shadow-lg border py-1 min-w-[140px]"
						style={{
							background: "var(--color-surface)",
							borderColor: "var(--color-border)",
						}}
					>
						{VIEW_TYPES.map((vt) => {
							const meta = VIEW_TYPE_META[vt];
							const Icon = meta.icon;
							const isActive = vt === value;
							return (
								<button
									key={vt}
									type="button"
									onClick={() => { onChange(vt); setOpen(false); }}
									className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors cursor-pointer text-left"
									style={{
										background: isActive ? "var(--color-accent-light, rgba(99,102,241,0.1))" : "transparent",
										color: isActive ? "var(--color-accent)" : "var(--color-text)",
										fontWeight: isActive ? 500 : 400,
									}}
								>
									<Icon />
									{meta.label}
								</button>
							);
						})}
					</div>
				)}
			</div>
		);
	}

	return (
		<div className="flex items-center gap-1 flex-shrink-0">
			{VIEW_TYPES.map((vt) => {
				const meta = VIEW_TYPE_META[vt];
				const Icon = meta.icon;
				const isActive = vt === value;
				return (
					<button
						key={vt}
						type="button"
						onClick={() => onChange(vt)}
						className="flex items-center gap-1.5 px-2.5 py-1 text-[12px] rounded-md transition-colors cursor-pointer"
						style={{
							background: isActive ? "var(--color-surface-hover)" : "transparent",
							color: isActive ? "var(--color-text)" : "var(--color-text-muted)",
							fontWeight: isActive ? 500 : 400,
						}}
						title={meta.label}
					>
						<Icon />
						<span className="hidden sm:inline">{meta.label}</span>
					</button>
				);
			})}
		</div>
	);
}
