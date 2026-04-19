"use client";

import { type ReactNode } from "react";

type RightPanelProps = {
	children: ReactNode;
};

/**
 * Right-side workspace panel container. Hosts the togglable Files sidebar plus
 * the unified tab strip + active content area (files, CRM pages, entry detail,
 * cloud, cron, etc.). The tab strip and Files toggle live in workspace-content
 * so the same layout can be reused for the mobile drawer.
 */
export function RightPanel({ children }: RightPanelProps) {
	return (
		<div className="flex h-full min-h-0 flex-col overflow-hidden">
			{children}
		</div>
	);
}
