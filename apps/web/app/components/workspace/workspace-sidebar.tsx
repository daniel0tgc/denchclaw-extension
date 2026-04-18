"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import {
	Combobox,
	ComboboxInput,
	ComboboxContent,
	ComboboxList,
	ComboboxItem,
} from "../ui/combobox";
import {
	IconFolderFilled,
	IconFileFilled,
	IconDatabaseFilled,
} from "@tabler/icons-react";
import { GoTools } from "react-icons/go";
import { RiApps2AiLine } from "react-icons/ri";
import { useTheme } from "next-themes";
import { type TreeNode } from "./file-manager-tree";
import { ProfileSwitcher } from "./profile-switcher";
import { CreateWorkspaceDialog } from "./create-workspace-dialog";
import { ChatSessionsSidebar } from "./chat-sessions-sidebar";
import type { WebSession, SidebarSubagentInfo, SidebarGatewaySession, SidebarChannelStatus } from "./chat-sessions-sidebar";
import type { SearchIndexItem } from "@/lib/search-index";

/** Shape returned by /api/workspace/suggest-files */
export type SuggestItem = {
	name: string;
	path: string;
	type: "folder" | "file" | "document" | "database";
};

function indexItemToSuggestItem(item: SearchIndexItem): SuggestItem {
	const fullPath = item.path ?? item.id;
	const fileName = fullPath.split("/").pop() ?? item.label;
	return {
		name: item.kind === "object" ? item.label : fileName,
		path: fullPath,
		type: (item.nodeType ?? (item.kind === "object" ? "folder" : "file")) as SuggestItem["type"],
	};
}

type WorkspaceSidebarProps = {
	// NOTE: v3 three-column refactor — file tree lives in the right panel now.
	// `tree`, `activePath`, `onSelect`, etc. are accepted for API compatibility but unused here.
	tree?: TreeNode[];
	activePath?: string | null;
	onSelect?: (node: TreeNode) => void;
	onRefresh?: () => void;
	orgName?: string;
	loading?: boolean;
	browseDir?: string | null;
	parentDir?: string | null;
	onNavigateUp?: () => void;
	onGoHome?: () => void;
	onFileSearchSelect?: (item: SuggestItem) => void;
	workspaceRoot?: string | null;
	onGoToChat?: () => void;
	onExternalDrop?: (node: TreeNode) => void;
	/** When true, renders as a mobile overlay drawer instead of a static sidebar. */
	mobile?: boolean;
	/** Close the mobile drawer. */
	onClose?: () => void;
	/** Fixed width in px when not mobile (overrides default 260). */
	width?: number;
	showHidden?: boolean;
	onToggleHidden?: () => void;
	/** Called when the user clicks the collapse/hide sidebar button. */
	onCollapse?: () => void;
  /** Active workspace hint used by the switcher. */
  activeWorkspace?: string | null;
  /** Called after workspace switches or workspace creation so parent can refresh state. */
  onWorkspaceChanged?: () => void;
  /** Chat sessions embedded in the sidebar's flex-1 middle area (v3). */
  chatSessions?: WebSession[];
  activeChatSessionId?: string | null;
  activeChatSessionTitle?: string;
  chatStreamingSessionIds?: Set<string>;
  chatSubagents?: SidebarSubagentInfo[];
  chatActiveSubagentKey?: string | null;
  chatSessionsLoading?: boolean;
  onSelectChatSession?: (sessionId: string) => void;
  onNewChatSession?: () => void;
  onSelectChatSubagent?: (sessionKey: string) => void;
  onDeleteChatSession?: (sessionId: string) => void;
  onRenameChatSession?: (sessionId: string, newTitle: string) => void;
  onStopChatSession?: (sessionId: string) => void;
  onStopChatSubagent?: (sessionKey: string) => void;
  chatGatewaySessions?: SidebarGatewaySession[];
  chatChannelStatuses?: SidebarChannelStatus[];
  chatActiveGatewaySessionKey?: string | null;
  onSelectGatewayChatSession?: (sessionKey: string, sessionId: string) => void;
  chatFileScopedSessions?: WebSession[];
  chatHeartbeatInfo?: { intervalMs: number; nextDueEstimateMs: number | null } | null;
  /** Navigate to a sidebar section (cloud, integrations, skills, cron). */
  onNavigate?: (
    target:
      | "cloud"
      | "integrations"
      | "skills"
      | "cron"
      | "crm-people"
      | "crm-companies"
      | "crm-inbox"
      | "crm-calendar",
  ) => void;
  /** Currently-active CRM nav item, used to highlight the row. */
  activeCrmTarget?: "people" | "companies" | "inbox" | "calendar" | null;
  /** Client-side search function from useSearchIndex for instant results. */
  searchFn?: (query: string, limit?: number) => SearchIndexItem[];
};

function ThemeToggle() {
	const { resolvedTheme, setTheme } = useTheme();
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);
	if (!mounted) return <div className="w-[28px] h-[28px]" />;
	const isDark = resolvedTheme === "dark";
	return (
		<button
			type="button"
			onClick={() => setTheme(isDark ? "light" : "dark")}
			className="p-1.5 rounded-lg"
			style={{ color: "var(--color-text-muted)" }}
			title={isDark ? "Switch to light mode" : "Switch to dark mode"}
		>
			{isDark ? (
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
					<circle cx="12" cy="12" r="4" />
					<path d="M12 2v2" /><path d="M12 20v2" />
					<path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" />
					<path d="M2 12h2" /><path d="M20 12h2" />
					<path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" />
				</svg>
			) : (
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
					<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
				</svg>
			)}
		</button>
	);
}

function SearchIcon() {
	return (
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
			<circle cx="11" cy="11" r="8" />
			<path d="m21 21-4.3-4.3" />
		</svg>
	);
}

function SuggestTypeIcon({ type }: { type: string }) {
	switch (type) {
		case "folder": return <IconFolderFilled size={16} style={{ flexShrink: 0, color: "#60a5fa" }} />;
		case "document": return <IconFileFilled size={16} style={{ flexShrink: 0, opacity: 0.7 }} />;
		case "database": return <IconDatabaseFilled size={16} style={{ flexShrink: 0 }} />;
		default: return <IconFileFilled size={16} style={{ flexShrink: 0, opacity: 0.7 }} />;
	}
}

/* ─── File search (base-ui Combobox) ─── */

export function FileSearch({ onSelect, searchFn }: { onSelect: (item: SuggestItem) => void; searchFn?: (query: string, limit?: number) => SearchIndexItem[] }) {
	const [results, setResults] = useState<SuggestItem[]>([]);
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const justSelectedRef = useRef(false);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const anchorRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		return () => { if (timerRef.current) clearTimeout(timerRef.current); };
	}, []);

	const handleInputValueChange = useCallback((inputValue: string) => {
		if (justSelectedRef.current) {
			justSelectedRef.current = false;
			return;
		}
		setQuery(inputValue);
		if (!inputValue.trim()) {
			setResults([]);
			setOpen(false);
			return;
		}
		if (searchFn) {
			const hits = searchFn(inputValue.trim(), 20);
			setResults(hits.map(indexItemToSuggestItem));
			setOpen(true);
		} else {
			if (timerRef.current) clearTimeout(timerRef.current);
			timerRef.current = setTimeout(async () => {
				try {
					const res = await fetch(`/api/workspace/suggest-files?q=${encodeURIComponent(inputValue.trim())}`);
					const data = await res.json();
					setResults(data.items ?? []);
					setOpen(true);
				} catch {
					setResults([]);
				}
			}, 150);
		}
	}, [searchFn]);

	return (
		<Combobox
			value={null}
			open={open}
			onOpenChange={(isOpen) => {
				if (!isOpen) setOpen(false);
			}}
			onValueChange={(val) => {
				if (val) {
					justSelectedRef.current = true;
					onSelect(val as SuggestItem);
					setOpen(false);
					setQuery("");
					setResults([]);
				}
			}}
			onInputValueChange={handleInputValueChange}
			filter={null}
			itemToStringLabel={() => ""}
		>
			<div ref={anchorRef} className="relative">
				<span
					className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none z-10"
					style={{ color: "var(--color-text-muted)" }}
				>
					<SearchIcon />
				</span>
				<ComboboxInput
					placeholder="Search"
					className="w-full pl-9 pr-10 py-1.5 rounded-xl text-sm outline-none transition-colors"
					style={{
						background: "var(--color-surface-hover)",
						color: "var(--color-text)",
					}}
				/>
			</div>
			<ComboboxContent anchor={anchorRef}>
				<ComboboxList>
					{results.map((item) => (
						<ComboboxItem key={item.path} value={item}>
							<span className="flex-shrink-0" style={{ color: "var(--color-text-muted)", opacity: 0.55 }}>
								<SuggestTypeIcon type={item.type} />
							</span>
							<div className="min-w-0 flex-1">
								<div className="truncate font-medium">{item.name}</div>
								<div className="truncate text-xs" style={{ color: "var(--color-text-muted)" }}>
									{item.path.split("/").slice(0, -1).join("/")}
								</div>
							</div>
						</ComboboxItem>
					))}
				</ComboboxList>
				{query.trim() && results.length === 0 && (
					<div className="py-3 text-center text-sm" style={{ color: "var(--color-text-muted)" }}>
						No files found
					</div>
				)}
			</ComboboxContent>
		</Combobox>
	);
}

export function WorkspaceSidebar({
	orgName,
	onFileSearchSelect,
	mobile,
	onClose,
	showHidden,
	onToggleHidden,
	width: widthProp,
	onCollapse,
  activeWorkspace,
  onWorkspaceChanged,
  onNavigate,
  activeCrmTarget = null,
  searchFn,
  chatSessions,
  activeChatSessionId,
  activeChatSessionTitle,
  chatStreamingSessionIds,
  chatSubagents,
  chatActiveSubagentKey,
  chatSessionsLoading,
  onSelectChatSession,
  onNewChatSession,
  onSelectChatSubagent,
  onDeleteChatSession,
  onRenameChatSession,
  onStopChatSession,
  onStopChatSubagent,
  chatGatewaySessions,
  chatChannelStatuses,
  chatActiveGatewaySessionKey,
  onSelectGatewayChatSession,
  chatFileScopedSessions,
  chatHeartbeatInfo,
}: WorkspaceSidebarProps) {
	const width = mobile ? "280px" : (widthProp ?? 260);
	const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);

	const sidebar = (
		<aside
			className={`flex flex-col h-screen shrink-0 ${mobile ? "drawer-left" : "border-r"}`}
			style={{
				width: typeof width === "number" ? `${width}px` : width,
				minWidth: typeof width === "number" ? `${width}px` : width,
				background: "var(--color-bg)",
				borderColor: "var(--color-border)",
			}}
		>
			{/* Header — workspace switcher always visible; browse-mode controls moved to the right panel's Files view */}
			<div
				className="flex items-center gap-2 px-3 h-[52px] shrink-0"
			>
				<div className="flex-1 min-w-0">
					<ProfileSwitcher
						activeWorkspaceHint={activeWorkspace ?? null}
						onWorkspaceSwitch={() => { onWorkspaceChanged?.(); }}
						onWorkspaceDelete={() => { onWorkspaceChanged?.(); }}
						onCreateWorkspace={() => { setCreateWorkspaceOpen(true); }}
						trigger={({ onClick, activeWorkspace: workspaceName, switching }) => (
							<button
								type="button"
								onClick={onClick}
								disabled={switching}
								className="group/ws text-[13px] flex items-center gap-2 truncate w-full transition-colors font-semibold rounded-xl px-2 py-1.5"
								style={{ color: "var(--color-text)" }}
								onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--color-surface-hover)"; }}
								onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
								title="Switch workspace"
							>
								<span className="truncate">{orgName || "Workspace"}</span>
								<span className="flex-1" />
								<span className="px-2 py-0.5 rounded-lg text-[10px] leading-tight shrink-0 bg-stone-200 text-stone-600 dark:bg-stone-700 dark:text-stone-300">
									{workspaceName || "-"}
								</span>
								<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" style={{ color: "var(--color-text-muted)" }}>
									<path d="m6 9 6 6 6-6" />
								</svg>
							</button>
						)}
					/>
				</div>
				{onCollapse && (
					<button
						type="button"
						onClick={onCollapse}
						className="p-1.5 rounded-lg shrink-0 transition-colors"
						style={{ color: "var(--color-text-muted)" }}
						onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--color-surface-hover)"; }}
						onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
						title="Hide sidebar (⌘B)"
					>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<rect width="18" height="18" x="3" y="3" rx="2" />
							<path d="M9 3v18" />
						</svg>
					</button>
				)}
			</div>

		{onNavigate && (
			<div className="px-2 pt-2 pb-1 space-y-0.5">
				<div
					className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em]"
					style={{ color: "var(--color-text-muted)" }}
				>
					CRM
				</div>
				{(
					[
						{ id: "crm-people" as const, label: "People", target: "people" as const, icon: (
							<svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
								<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
								<circle cx="9" cy="7" r="4" />
								<path d="M22 21v-2a4 4 0 0 0-3-3.87" />
								<path d="M16 3.13a4 4 0 0 1 0 7.75" />
							</svg>
						) },
						{ id: "crm-companies" as const, label: "Companies", target: "companies" as const, icon: (
							<svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
								<path d="M3 21h18" />
								<path d="M5 21V7l8-4v18" />
								<path d="M19 21V11l-6-4" />
								<path d="M9 9h0" />
								<path d="M9 13h0" />
								<path d="M9 17h0" />
							</svg>
						) },
						{ id: "crm-inbox" as const, label: "Inbox", target: "inbox" as const, icon: (
							<svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
								<polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
								<path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z" />
							</svg>
						) },
						{ id: "crm-calendar" as const, label: "Calendar", target: "calendar" as const, icon: (
							<svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
								<rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
								<line x1="16" y1="2" x2="16" y2="6" />
								<line x1="8" y1="2" x2="8" y2="6" />
								<line x1="3" y1="10" x2="21" y2="10" />
							</svg>
						) },
					]
				).map((item) => {
					const active = activeCrmTarget === item.target;
					return (
						<button
							key={item.id}
							type="button"
							onClick={() => onNavigate(item.id)}
							className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-xl text-sm font-medium transition-colors"
							style={{
								color: active ? "var(--color-text)" : "var(--color-text-muted)",
								background: active ? "var(--color-surface-hover)" : "transparent",
							}}
							onMouseEnter={(e) => {
								if (active) return;
								(e.currentTarget as HTMLElement).style.background = "var(--color-surface-hover)";
								(e.currentTarget as HTMLElement).style.color = "var(--color-text)";
							}}
							onMouseLeave={(e) => {
								if (active) return;
								(e.currentTarget as HTMLElement).style.background = "transparent";
								(e.currentTarget as HTMLElement).style.color = "var(--color-text-muted)";
							}}
						>
							<span className="shrink-0">{item.icon}</span>
							{item.label}
						</button>
					);
				})}
			</div>
		)}

			{/* v3: chat history takes the flex-1 middle section.
			    File tree lives in the right panel now. */}
			<div className="flex-1 min-h-0 flex flex-col overflow-hidden">
				{onSelectChatSession ? (
					<ChatSessionsSidebar
						sessions={chatSessions ?? []}
						activeSessionId={activeChatSessionId ?? null}
						activeSessionTitle={activeChatSessionTitle}
						streamingSessionIds={chatStreamingSessionIds ?? new Set()}
						subagents={chatSubagents ?? []}
						activeSubagentKey={chatActiveSubagentKey ?? null}
						loading={chatSessionsLoading ?? false}
						onSelectSession={onSelectChatSession}
						onNewSession={onNewChatSession ?? (() => {})}
						onSelectSubagent={onSelectChatSubagent ?? (() => {})}
						onDeleteSession={onDeleteChatSession}
						onRenameSession={onRenameChatSession}
						onStopSession={onStopChatSession}
						onStopSubagent={onStopChatSubagent}
						gatewaySessions={chatGatewaySessions ?? []}
						channelStatuses={chatChannelStatuses ?? []}
						activeGatewaySessionKey={chatActiveGatewaySessionKey ?? null}
						onSelectGatewaySession={onSelectGatewayChatSession}
						fileScopedSessions={chatFileScopedSessions ?? []}
						heartbeatInfo={chatHeartbeatInfo ?? null}
						embedded
					/>
				) : null}
			</div>

		{onNavigate && (
			<div className="px-2 py-1.5 space-y-0.5">
				{([
					{ id: "cloud" as const, label: "Cloud", icon: (
						<svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
							<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
						</svg>
					)},
					{ id: "integrations" as const, label: "Integrations", icon: (
						<RiApps2AiLine className="h-4 w-4 shrink-0" aria-hidden />
					)},
					{ id: "skills" as const, label: "Skills", icon: (
						<GoTools className="h-4 w-4 shrink-0" aria-hidden />
					)},
					{ id: "cron" as const, label: "Cron", icon: (
						<svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
							<circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
						</svg>
					)},
				]).map((item) => (
					<button
						key={item.id}
						type="button"
						onClick={() => onNavigate(item.id)}
						className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-xl text-sm font-medium transition-colors"
						style={{ color: "var(--color-text-muted)" }}
						onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--color-surface-hover)"; (e.currentTarget as HTMLElement).style.color = "var(--color-text)"; }}
						onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; (e.currentTarget as HTMLElement).style.color = "var(--color-text-muted)"; }}
					>
						<span className="shrink-0">{item.icon}</span>
						{item.label}
					</button>
				))}
			</div>
		)}

		<div
			className="px-3 py-2.5 border-t flex items-center justify-between"
			style={{ borderColor: "var(--color-border)" }}
		>
			<a
				href="https://dench.com"
				target="_blank"
				rel="noopener noreferrer"
				className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm"
				style={{ color: "var(--color-text-muted)" }}
			>
				dench.com{process.env.NEXT_PUBLIC_DENCHCLAW_VERSION ? ` (v${process.env.NEXT_PUBLIC_DENCHCLAW_VERSION})` : ""}
			</a>
			<div className="flex items-center gap-0.5">
				{onToggleHidden && (
					<button
						type="button"
						onClick={onToggleHidden}
						className="p-1.5 rounded-lg transition-colors"
						style={{ color: showHidden ? "var(--color-accent)" : "var(--color-text-muted)" }}
						title={showHidden ? "Hide dotfiles" : "Show dotfiles"}
					>
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							{showHidden ? (
								<>
									<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
									<circle cx="12" cy="12" r="3" />
								</>
							) : (
								<>
									<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
									<path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
									<path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
									<path d="m2 2 20 20" />
								</>
							)}
						</svg>
					</button>
				)}
				<ThemeToggle />
			</div>
		</div>

		</aside>
	);

	if (!mobile) {
		return (
			<>
				{sidebar}
				<CreateWorkspaceDialog
					isOpen={createWorkspaceOpen}
					onClose={() => setCreateWorkspaceOpen(false)}
					onCreated={() => {
						onWorkspaceChanged?.();
					}}
				/>
			</>
		);
	}

	return (
		<>
			<div className="drawer-backdrop" onClick={() => void onClose?.()}>
				{/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
				<div onClick={(e) => e.stopPropagation()} className="fixed inset-y-0 left-0 z-50">
					{sidebar}
				</div>
			</div>
			<CreateWorkspaceDialog
				isOpen={createWorkspaceOpen}
				onClose={() => setCreateWorkspaceOpen(false)}
				onCreated={() => {
					onWorkspaceChanged?.();
				}}
			/>
		</>
	);
}
