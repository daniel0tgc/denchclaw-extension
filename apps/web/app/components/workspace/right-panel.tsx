"use client";

import { type ReactNode } from "react";
import { type Tab, HOME_TAB_ID } from "@/lib/tab-state";

type RightPanelProps = {
	/** Content tabs shown in the right panel's tab strip (opened files, CRM, cloud, etc.). */
	tabs: Tab[];
	activeTabId: string | null;
	onActivate: (tabId: string) => void;
	onClose: (tabId: string) => void;
	onCloseOthers: (tabId: string) => void;
	onCloseToRight: (tabId: string) => void;
	onCloseAll: () => void;
	onReorder: (tabId: string, from: number, to: number) => void;
	onTogglePin: (tabId: string) => void;
	onMakePermanent?: (tabId: string) => void;
	/** Toggle the panel's visibility. */
	onCollapse?: () => void;
	/** Whether the permanent Files tab is the current surface. */
	filesTabActive?: boolean;
	/** Activate the permanent Files tab. */
	onActivateFilesTab?: () => void;
	children: ReactNode;
};

function tabDisplayTitle(tab: Tab): string {
	if (!tab.title) return "Untitled";
	return tab.title.length > 24 ? tab.title.slice(0, 22) + "…" : tab.title;
}

/**
 * Right-side workspace panel. Hosts Files (tree + preview), CRM pages, entry details,
 * cloud settings, etc. Center is always the chat panel.
 *
 * v3 design: pill-style tabs at the top. "Files" is always the first (permanent) tab.
 * Opening a file / CRM / cloud page adds a new pill next to Files.
 */
export function RightPanel({
	tabs,
	activeTabId,
	onActivate,
	onClose,
	onCollapse,
	filesTabActive,
	onActivateFilesTab,
	children,
}: RightPanelProps) {
	const visibleTabs = tabs.filter((t) => t.id !== HOME_TAB_ID);

	return (
		<div className="flex h-full min-h-0 flex-col overflow-hidden">
			{/* Pill tab strip */}
			<div
				className="flex items-center gap-1 px-3 h-11 shrink-0 border-b overflow-x-auto"
				style={{ borderColor: "var(--color-border)", background: "var(--color-bg)" }}
			>
				<button
					type="button"
					onClick={onActivateFilesTab}
					className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] font-medium transition-colors cursor-pointer shrink-0"
					style={{
						color: filesTabActive ? "var(--color-text)" : "var(--color-text-muted)",
						background: filesTabActive ? "var(--color-surface-hover)" : "transparent",
					}}
					title="Files"
				>
					<svg
						width="13"
						height="13"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
						aria-hidden
					>
						<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
					</svg>
					Files
				</button>

				{visibleTabs.map((tab) => {
					const isActive = tab.id === activeTabId && !filesTabActive;
					return (
						<div
							key={tab.id}
							className="flex items-center rounded-md shrink-0"
							style={{
								background: isActive ? "var(--color-surface-hover)" : "transparent",
							}}
						>
							<button
								type="button"
								onClick={() => onActivate(tab.id)}
								className="pl-2.5 pr-1 py-1 text-[12px] font-medium transition-colors cursor-pointer"
								style={{
									color: isActive ? "var(--color-text)" : "var(--color-text-muted)",
									fontStyle: tab.preview ? "italic" : "normal",
								}}
								title={tab.title}
							>
								{tabDisplayTitle(tab)}
							</button>
							<button
								type="button"
								onClick={(e) => {
									e.stopPropagation();
									onClose(tab.id);
								}}
								className="p-0.5 rounded-md mr-0.5 cursor-pointer"
								style={{ color: "var(--color-text-muted)" }}
								title="Close tab"
								onMouseEnter={(e) => {
									(e.currentTarget as HTMLElement).style.background = "var(--color-border)";
								}}
								onMouseLeave={(e) => {
									(e.currentTarget as HTMLElement).style.background = "transparent";
								}}
							>
								<svg
									width="12"
									height="12"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<path d="M18 6 6 18" />
									<path d="m6 6 12 12" />
								</svg>
							</button>
						</div>
					);
				})}

				<div className="flex-1" />

				{onCollapse && (
					<button
						type="button"
						onClick={onCollapse}
						className="p-1.5 rounded-md cursor-pointer shrink-0"
						style={{ color: "var(--color-text-muted)" }}
						title="Hide right panel (⌘⇧B)"
						onMouseEnter={(e) => {
							(e.currentTarget as HTMLElement).style.background = "var(--color-surface-hover)";
						}}
						onMouseLeave={(e) => {
							(e.currentTarget as HTMLElement).style.background = "transparent";
						}}
					>
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<rect width="18" height="18" x="3" y="3" rx="2" />
							<path d="M15 3v18" />
						</svg>
					</button>
				)}
			</div>
			<div className="flex-1 min-h-0 overflow-hidden">{children}</div>
		</div>
	);
}
